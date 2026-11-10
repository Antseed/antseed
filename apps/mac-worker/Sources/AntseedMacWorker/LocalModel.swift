import CryptoKit
import Darwin
import Foundation
import Security

/// The model this Mac serves, running on the bundled TensorFold engine: a
/// separate process on a private loopback port, behind a key made fresh for each launch.
actor LocalModel {
    /// Prompt plus reply tokens the engine is started with.
    static let contextTokens = 8192
    private static let servedName = "local-model"

    /// `repo@revision`, pinned (`WorkerConfig.isPinned`).
    let modelId: String
    /// The pinned snapshot the engine serves, once loaded.
    private var snapshot: URL?
    let engine: URL
    let directory: URL
    private var server: Process?
    private var baseURL: URL?
    private var apiKey = ""
    private let session: URLSession

    struct Result {
        let text: String
        /// Whole tool calls, as `message.tool_calls` (empty when the reply called none).
        let toolCalls: [[String: Any]]
        /// The engine's: "stop", "length", "tool_calls", …
        let finishReason: String
        let promptTokens: Int
        let completionTokens: Int
        let tokensPerSecond: Double
    }

    /// What the engine generated next.
    enum Output {
        case text(String)
        /// `delta.tool_calls` as the engine streamed them.
        case toolCalls([[String: Any]])
    }

    enum EngineError: Error, LocalizedError {
        case missing(URL)
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .missing(let url): "TensorFold engine not found at \(url.path)"
            case .failed(let reason): reason
            }
        }
    }

    init(modelId: String, engine: URL, directory: URL) {
        self.modelId = modelId
        self.engine = engine
        self.directory = directory
        let configuration = URLSessionConfiguration.ephemeral
        // Decrypted prompts go straight to the engine, never through a system proxy.
        configuration.connectionProxyDictionary = [:]
        configuration.timeoutIntervalForRequest = 300
        session = URLSession(configuration: configuration)
    }

    /// The checkpoint a worker attests it serves: `repo@revision` and the digest of its files.
    struct Checkpoint: Sendable {
        let model: String
        let sha256: String
    }

    /// Download (first run), hash the pinned snapshot's files and start the engine on that snapshot.
    func load(progress: @escaping @Sendable (Double) -> Void) async throws -> Checkpoint {
        guard FileManager.default.isExecutableFile(atPath: engine.path) else { throw EngineError.missing(engine) }
        Self.stopEngine(in: directory, engine: engine)
        let snapshot = Self.snapshotDirectory(modelId)
        if (try? String(contentsOf: pulledMarker, encoding: .utf8)) != modelId || !FileManager.default.fileExists(atPath: snapshot.path) {
            try await pull(progress: progress)
            try modelId.write(to: pulledMarker, atomically: true, encoding: .utf8)
        }
        guard FileManager.default.fileExists(atPath: snapshot.appendingPathComponent("config.json").path) else {
            throw EngineError.failed("The pinned revision is not in the model cache (\(snapshot.path))")
        }
        let digest = try Self.filesDigest(of: snapshot)
        self.snapshot = snapshot
        try await startServer()
        return Checkpoint(model: modelId, sha256: digest)
    }

    /// The Hugging Face cache directory the engine pulls into: HF_HUB_CACHE, else HF_HOME/hub, else ~/.cache/huggingface/hub.
    static func hubCache(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> URL {
        if let cache = environment["HF_HUB_CACHE"], !cache.isEmpty { return URL(fileURLWithPath: cache) }
        if let home = environment["HF_HOME"], !home.isEmpty { return URL(fileURLWithPath: home).appendingPathComponent("hub") }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/huggingface/hub")
    }

    /// The cache's snapshot of `repo@revision`: served by path, so the engine loads that revision
    /// even if the cache's `refs/main` later names another.
    static func snapshotDirectory(_ modelId: String, hub: URL = hubCache()) -> URL {
        let parts = modelId.split(separator: "@", maxSplits: 1).map(String.init)
        let repository = "models--" + parts[0].replacingOccurrences(of: "/", with: "--")
        return hub.appendingPathComponent(repository).appendingPathComponent("snapshots").appendingPathComponent(parts.count == 2 ? parts[1].lowercased() : "")
    }

    /// SHA-256 over the lines `shasum -a 256` prints for every file in `directory`
    /// (symlinks followed), as `./path`, sorted bytewise: `modelFilesDigest` in
    /// @antseed/node/worker-e2e, so an operator can compute the value to pin.
    static func filesDigest(of directory: URL) throws -> String {
        let root = directory.resolvingSymlinksInPath()
        guard let walker = FileManager.default.enumerator(atPath: root.path) else { throw EngineError.failed("Could not read \(root.path)") }
        var paths: [String] = []
        while let relative = walker.nextObject() as? String {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: root.appendingPathComponent(relative).path, isDirectory: &isDirectory), !isDirectory.boolValue else { continue }
            paths.append(relative)
        }
        let listing = try paths
            .sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
            .map { "\(try fileSHA256(root.appendingPathComponent($0)))  ./\($0)\n" }
            .joined()
        return SHA256.hash(data: Data(listing.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func fileSHA256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Run a chat completion on `chat` (from `EngineChat.fields`), calling
    /// `onOutput` for each piece of generated text or tool-call delta.
    func generate(
        chat: [String: Any],
        maxTokens: Int,
        maxPromptTokens: Int? = nil,
        temperature: Float,
        onOutput: @escaping @Sendable (Output) async -> Void
    ) async throws -> Result {
        if server?.isRunning != true { try await startServer() }

        // Checked after tokenizing and before prefill, the costly part.
        let promptTokens = try await countTokens(chat)
        if let maxPromptTokens, promptTokens > maxPromptTokens {
            throw EngineError.failed("Prompt too long (\(promptTokens) tokens, at most \(maxPromptTokens))")
        }
        let room = Self.contextTokens - promptTokens
        guard room > 0 else { throw EngineError.failed("Prompt too long (\(promptTokens) tokens, at most \(Self.contextTokens - 1))") }
        try Task.checkCancellation()

        var body = chat
        body["model"] = Self.servedName
        body["max_tokens"] = min(maxTokens, room)
        body["temperature"] = temperature
        body["stream"] = true
        body["stream_options"] = ["include_usage": true]
        let (bytes, response) = try await session.bytes(for: try request("/v1/chat/completions", body: body))
        try Self.requireOK(response)

        var text = ""
        var toolCalls = EngineChat.ToolCalls()
        var finishReason: String?
        var usage: (prompt: Int, completion: Int)?
        var tokensPerSecond = 0.0
        // Disconnecting (a cancelled task ends this loop) cancels the request in the engine.
        for try await line in bytes.lines {
            try Task.checkCancellation()
            guard let event = EngineChat.parseEvent(line) else { continue }
            if let piece = event.content, !piece.isEmpty {
                text += piece
                await onOutput(.text(piece))
            }
            if let deltas = event.toolCalls {
                toolCalls.add(deltas)
                await onOutput(.toolCalls(deltas))
            }
            if let reason = event.finishReason { finishReason = reason }
            if let rate = event.tokensPerSecond { tokensPerSecond = rate }
            if let reported = event.usage { usage = reported }
        }
        // The buyer pays on these numbers: a stream that ends without them failed.
        guard let usage else { throw EngineError.failed("The engine ended the reply early") }
        let calls = toolCalls.message
        return Result(text: text, toolCalls: calls, finishReason: finishReason ?? (calls.isEmpty ? "stop" : "tool_calls"),
                      promptTokens: usage.prompt, completionTokens: usage.completion, tokensPerSecond: tokensPerSecond)
    }

    /// Stop the engine process (server or model download) this data directory
    /// last started, if it is still that engine. Synchronous so it can run while
    /// the app quits, and at launch to clear one left behind by a crash.
    nonisolated static func stopEngine(in directory: URL, engine: URL) {
        let file = directory.appendingPathComponent(pidFile)
        defer { try? FileManager.default.removeItem(at: file) }
        guard let text = try? String(contentsOf: file, encoding: .utf8), let pid = pid_t(text), pid > 0 else { return }
        var path = [CChar](repeating: 0, count: 4096)
        guard proc_pidpath(pid, &path, UInt32(path.count)) > 0,
              URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path == engine.resolvingSymlinksInPath().path
        else { return }
        kill(pid, SIGTERM)
    }

    /// Fraction done from a `tensorfold pull` line such as `0.35 of 1.60 GiB, 35.2 MiB/s`.
    static func pullFraction(_ line: String) -> Double? {
        let words = line.split(whereSeparator: \.isWhitespace)
        guard words.count >= 4, words[1] == "of", words[3].hasPrefix("GiB"),
              let done = Double(words[0]), let total = Double(words[2]), total > 0 else { return nil }
        return min(done / total, 1)
    }

    // MARK: engine process

    private static let pidFile = "engine.pid"
    private var pulledMarker: URL { directory.appendingPathComponent("engine-model") }
    private var logFile: URL { directory.appendingPathComponent("engine.log") }

    private func pull(progress: @escaping @Sendable (Double) -> Void) async throws {
        let process = Process()
        process.executableURL = engine
        process.arguments = ["pull", modelId]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        // Recorded like the server's, so quitting mid-download stops it too.
        let pidURL = directory.appendingPathComponent(Self.pidFile)
        try String(process.processIdentifier).write(to: pidURL, atomically: true, encoding: .utf8)
        defer {
            if process.isRunning { process.terminate() }
            try? FileManager.default.removeItem(at: pidURL)
        }
        var last = ""
        for try await line in pipe.fileHandleForReading.bytes.lines {
            last = line
            if let fraction = Self.pullFraction(line) { progress(fraction) }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw EngineError.failed("Model download failed: \(last)") }
    }

    private func startServer() async throws {
        guard let snapshot else { throw EngineError.failed("Model not loaded") }
        server?.terminate()
        Self.stopEngine(in: directory, engine: engine)
        let port = try Self.freeLoopbackPort()
        apiKey = try Self.randomKey()
        let keyFile = directory.appendingPathComponent("engine.key")
        try? FileManager.default.removeItem(at: keyFile)
        guard FileManager.default.createFile(atPath: keyFile.path, contents: Data(apiKey.utf8), attributes: [.posixPermissions: 0o600]) else {
            throw EngineError.failed("Could not write the engine key")
        }
        FileManager.default.createFile(atPath: logFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let log = try FileHandle(forWritingTo: logFile)

        let process = Process()
        process.executableURL = engine
        process.currentDirectoryURL = directory
        process.arguments = [
            "serve", snapshot.path,
            "--host", "127.0.0.1",
            "--port", String(port),
            "--api-key-file", keyFile.path,
            "--name", Self.servedName,
            "--context", String(Self.contextTokens),
            "--no-thinking",
            "--parallel", String(RequestGate.maxConcurrency),
            // Nothing from one buyer's prompt is kept for the next request.
            "--prompt-cache-gib", "0",
        ]
        process.standardOutput = log
        process.standardError = log
        try process.run()
        server = process
        try String(process.processIdentifier).write(to: directory.appendingPathComponent(Self.pidFile), atomically: true, encoding: .utf8)
        baseURL = URL(string: "http://127.0.0.1:\(port)")

        for _ in 0..<600 {
            guard process.isRunning else { break }
            var probe = URLRequest(url: baseURL!.appendingPathComponent("v1/models"))
            probe.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            probe.timeoutInterval = 2
            if let (_, response) = try? await session.data(for: probe), (response as? HTTPURLResponse)?.statusCode == 200 { return }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        process.terminate()
        throw EngineError.failed("The engine did not start (see \(logFile.path))")
    }

    private func countTokens(_ chat: [String: Any]) async throws -> Int {
        // The tools render into the prompt too.
        var body: [String: Any] = ["model": Self.servedName, "messages": chat["messages"] ?? [Any]()]
        if let tools = chat["tools"] { body["tools"] = tools }
        let (data, response) = try await session.data(for: try request("/v1/tokenize", body: body))
        try Self.requireOK(response)
        guard let count = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["count"] as? Int else {
            throw EngineError.failed("The engine did not count the prompt")
        }
        return count
    }

    private func request(_ path: String, body: [String: Any]) throws -> URLRequest {
        guard let baseURL else { throw EngineError.failed("Model not loaded") }
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    /// The engine's error body may quote the prompt and this error reaches the
    /// pool, so only the status is passed on.
    private static func requireOK(_ response: URLResponse) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw EngineError.failed("The engine refused the request (HTTP \(status))") }
    }

    private static func freeLoopbackPort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw EngineError.failed("Could not find a free port") }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let found = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { generic in
                bind(fd, generic, length) == 0 && getsockname(fd, generic, &length) == 0
            }
        }
        guard found else { throw EngineError.failed("Could not find a free port") }
        return Int(in_port_t(bigEndian: address.sin_port))
    }

    private static func randomKey() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw EngineError.failed("Could not generate the engine key")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
