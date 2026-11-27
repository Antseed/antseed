import CryptoKit
import Darwin
import Foundation
import Security

/// The model this Mac serves, running on the bundled TensorFold engine: a
/// separate process on an owner-only Unix socket (never a network port), behind
/// a key made fresh for each launch.
actor LocalModel {
    /// Prompt plus reply tokens the engine is started with.
    static let contextTokens = 32_768
    /// The name the engine serves the model under.
    static let servedName = "local-model"

    /// `repo@revision`, pinned (`WorkerConfig.isPinned`).
    let modelId: String
    /// The pinned snapshot the engine serves, once loaded.
    private var snapshot: URL?
    let engine: URL
    let directory: URL
    private var server: Process?
    private var socket: EngineSocket?
    /// The running engine's execution witness, as last read.
    private var witness: EngineWitness.Snapshot?

    struct Result {
        let text: String
        /// Whole tool calls, as `message.tool_calls` (empty when the reply called none).
        let toolCalls: [[String: Any]]
        /// The engine's: "stop", "length", "tool_calls", …
        let finishReason: String
        let promptTokens: Int
        let completionTokens: Int
        let tokensPerSecond: Double
        /// The reply's binding to the engine's witness, when the engine had a known one to bind it to.
        var binding: EngineWitness.Binding? = nil
        /// The engine's witness once the reply ended: read again when the reply wasn't bound to the one before.
        var witness: EngineWitness.Snapshot? = nil
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
        /// The buyer's prompt doesn't fit, which is no fault of the engine. Worded as OpenAI words
        /// it, so agents that compact their history on a context overflow recognize it.
        case promptTooLong(tokens: Int, limit: Int)

        var errorDescription: String? {
            switch self {
            case .missing(let url): "TensorFold engine not found at \(url.path)"
            case .failed(let reason): reason
            case .promptTooLong(let tokens, let limit):
                "This model's maximum context length is \(limit) tokens. However, your messages resulted in \(tokens) tokens."
            }
        }
    }

    /// On a signed build, what the engine's code signature must meet (`EngineCode`); nil on a development build.
    private let engineRequirement: String?

    init(modelId: String, engine: URL, directory: URL, engineRequirement: String? = EngineCode.requirement(teamId: Protection.codeIdentity().teamId)) {
        self.modelId = modelId
        self.engine = engine
        self.directory = directory
        self.engineRequirement = engineRequirement
    }

    /// An engine process with a fixed environment, after checking the engine's file.
    private func engineProcess(_ arguments: [String], offline: Bool) throws -> Process {
        try EngineCode.verifyFile(engine, requirement: engineRequirement)
        EngineCode.disableCoreDumps()
        let process = Process()
        process.executableURL = engine
        process.arguments = arguments
        process.environment = EngineCode.environment(hubCache: Self.hubCache(), offline: offline)
        return process
    }

    /// The checkpoint a worker attests it serves: `repo@revision`, the digest of its files and the
    /// engine's execution witness of what it loaded.
    struct Checkpoint: Sendable {
        let model: String
        let sha256: String
        var witness: EngineWitness.Snapshot?
        /// SHA-256 of the engine executable that serves it, attested for every model (witness or not).
        var engine: String? = nil

        /// The witness to attest: only one naming the engine binary this app hashed, since the witness
        /// and `engine` must describe the same executable.
        var attestableWitness: EngineWitness.Known? {
            guard let known = witness?.known else { return nil }
            return engine == nil || known.binary == engine ? known : nil
        }
    }

    /// The engine executable's SHA-256, hashed once per launch after its code signature check.
    private var engineDigest: String?

    /// The stamps of the files the last successful load hashed and attested; nil until one succeeds.
    private var attestedStamps: [String: FileStamp]?

    /// Download (first run), hash the pinned snapshot's files and start the engine on that snapshot.
    /// Cancelling it stops its download or engine and never starts one afterwards, so a superseded
    /// load can't stop the engine a newer one started.
    func load(progress: @escaping @Sendable (Double) -> Void) async throws -> Checkpoint {
        guard FileManager.default.isExecutableFile(atPath: engine.path) else { throw EngineError.missing(engine) }
        try Task.checkCancellation()
        Self.stopEngine(in: directory, engine: engine)
        let snapshot = Self.snapshotDirectory(modelId)
        if (try? String(contentsOf: pulledMarker, encoding: .utf8)) != modelId || !FileManager.default.fileExists(atPath: snapshot.path) {
            try await pull(progress: progress)
            try Task.checkCancellation()
            try modelId.write(to: pulledMarker, atomically: true, encoding: .utf8)
        }
        guard FileManager.default.fileExists(atPath: snapshot.appendingPathComponent("config.json").path) else {
            throw EngineError.failed("The pinned revision is not in the model cache (\(snapshot.path))")
        }
        attestedStamps = nil
        let engineSHA = try hashEngine()
        let (digest, stamps) = try Self.filesDigestAndStamps(of: snapshot)
        self.snapshot = snapshot
        try Task.checkCancellation()
        let witness = try await startEngine()
        // The attested digest must be of the files the engine read: any change between the hash and
        // the engine being ready fails the load, for every model, witnessed or not.
        if witness?.filesChanged == true || !Self.unchanged(stamps, in: snapshot) {
            stop()
            throw EngineError.failed("The model's files changed while the engine loaded them")
        }
        if let known = witness?.known, known.binary != engineSHA {
            stop()
            throw EngineError.failed("The engine's witness names another executable than the one this app runs")
        }
        attestedStamps = stamps
        return Checkpoint(model: modelId, sha256: digest, witness: witness, engine: engineSHA)
    }

    /// Start the engine again after it stopped, on the files the load attested: refused when any of
    /// them changed since, before and after it starts, so a restarted engine never serves other
    /// files under the attested digest.
    private func restartEngine() async throws {
        guard let stamps = attestedStamps, let snapshot else { throw EngineError.failed("Model not loaded") }
        guard Self.unchanged(stamps, in: snapshot) else {
            attestedStamps = nil
            throw EngineError.failed("The model's files changed since they were attested; load the model again")
        }
        let witness = try await startEngine()
        if witness?.filesChanged == true || !Self.unchanged(stamps, in: snapshot) {
            stop()
            attestedStamps = nil
            throw EngineError.failed("The model's files changed while the engine loaded them")
        }
    }

    /// The engine's SHA-256, after checking its code signature: once per launch, since the file is in the signed app.
    private func hashEngine() throws -> String {
        if let engineDigest { return engineDigest }
        try EngineCode.verifyFile(engine, requirement: engineRequirement)
        let digest = try Self.fileSHA256(engine)
        engineDigest = digest
        return digest
    }

    /// Stop the engine this instance started, if it still runs; one another instance started is left alone.
    func stop() {
        guard let server else { return }
        self.server = nil
        if server.isRunning { server.terminate() }
        Self.removePIDFile(in: directory, ifItIs: server.processIdentifier)
        if let old = socket?.path { unlink(old) }
        socket = nil
    }

    private static func removePIDFile(in directory: URL, ifItIs pid: pid_t) {
        let file = directory.appendingPathComponent(pidFile)
        guard let text = try? String(contentsOf: file, encoding: .utf8), pid_t(text) == pid else { return }
        try? FileManager.default.removeItem(at: file)
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
        try filesDigestAndStamps(of: directory).digest
    }

    /// What identifies a file's content without reading it: taken (symlinks followed) before each
    /// file is hashed, so a change during or after the hash shows as a different stamp.
    struct FileStamp: Equatable, Sendable {
        let size: Int64
        let modified: timespec
        let changed: timespec
        let inode: UInt64
        let device: Int32

        init?(_ url: URL) {
            var info = stat()
            guard stat(url.path, &info) == 0 else { return nil }
            size = info.st_size
            modified = info.st_mtimespec
            changed = info.st_ctimespec
            inode = info.st_ino
            device = info.st_dev
        }

        static func == (a: FileStamp, b: FileStamp) -> Bool {
            a.size == b.size && a.inode == b.inode && a.device == b.device
                && a.modified.tv_sec == b.modified.tv_sec && a.modified.tv_nsec == b.modified.tv_nsec
                && a.changed.tv_sec == b.changed.tv_sec && a.changed.tv_nsec == b.changed.tv_nsec
        }
    }

    /// `filesDigest`, with the stamp of every file it hashed, keyed by its path in the snapshot.
    static func filesDigestAndStamps(of directory: URL) throws -> (digest: String, stamps: [String: FileStamp]) {
        let root = directory.resolvingSymlinksInPath()
        var stamps: [String: FileStamp] = [:]
        let listing = try files(in: root)
            .sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
            .map { relative -> String in
                let url = root.appendingPathComponent(relative)
                guard let stamp = FileStamp(url) else { throw EngineError.failed("Could not read \(url.path)") }
                stamps[relative] = stamp
                return "\(try fileSHA256(url))  ./\(relative)\n"
            }
            .joined()
        return (Data(SHA256.hash(data: Data(listing.utf8))).hex, stamps)
    }

    /// Whether `directory` still holds exactly the files `stamps` recorded, each with the same stamp.
    static func unchanged(_ stamps: [String: FileStamp], in directory: URL) -> Bool {
        let root = directory.resolvingSymlinksInPath()
        guard let current = try? files(in: root), Set(current) == Set(stamps.keys) else { return false }
        return stamps.allSatisfy { FileStamp(root.appendingPathComponent($0.key)) == $0.value }
    }

    /// Every file under `root`, symlinks followed, as paths relative to it.
    private static func files(in root: URL) throws -> [String] {
        guard let walker = FileManager.default.enumerator(atPath: root.path) else { throw EngineError.failed("Could not read \(root.path)") }
        var paths: [String] = []
        while let relative = walker.nextObject() as? String {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: root.appendingPathComponent(relative).path, isDirectory: &isDirectory), !isDirectory.boolValue else { continue }
            paths.append(relative)
        }
        return paths
    }

    static func fileSHA256(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return Data(hasher.finalize()).hex
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
        if server?.isRunning != true { try await restartEngine() }

        // Checked after tokenizing and before prefill, the costly part.
        let promptTokens = try await countTokens(chat)
        if let maxPromptTokens, promptTokens > maxPromptTokens {
            throw EngineError.promptTooLong(tokens: promptTokens, limit: maxPromptTokens)
        }
        let room = Self.contextTokens - promptTokens
        guard room > 0 else { throw EngineError.promptTooLong(tokens: promptTokens, limit: Self.contextTokens - 1) }
        try Task.checkCancellation()

        var body = chat
        body["model"] = Self.servedName
        body["max_tokens"] = min(maxTokens, room)
        body["temperature"] = temperature
        body["stream"] = true
        body["stream_options"] = ["include_usage": true]
        // Bind the reply to the engine's witness, which the engine answers only once it has the flag.
        let bound = witness?.known
        if bound != nil { body["execution_witness"] = true }
        let reply = try await request("/v1/chat/completions", body: body)
        defer { reply.close() }
        try Self.requireOK(reply.status)

        var text = ""
        var toolCalls = EngineChat.ToolCalls()
        var finishReason: String?
        var usage: (prompt: Int, completion: Int)?
        var tokensPerSecond = 0.0
        var binding: EngineWitness.Binding?
        // Disconnecting (a cancelled task ends this loop) cancels the request in the engine.
        while let line = try await reply.nextLine() {
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
            if let bound = event.witness { binding = bound }
        }
        // The buyer pays on these numbers: a stream that ends without them failed.
        guard let usage else { throw EngineError.failed("The engine ended the reply early") }
        // Not bound to the witness it was asked against: the engine restarted, reloaded or saw its files change.
        if let bound, binding?.known != true || binding?.witness != bound.witness { witness = await readWitness() }
        let calls = toolCalls.message
        return Result(text: text, toolCalls: calls, finishReason: finishReason ?? (calls.isEmpty ? "stop" : "tool_calls"),
                      promptTokens: usage.prompt, completionTokens: usage.completion, tokensPerSecond: tokensPerSecond,
                      binding: binding, witness: witness)
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
        let process = try engineProcess(["pull", modelId], offline: false)
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        // Recorded like the server's, so quitting mid-download stops it too.
        let pid = process.processIdentifier
        try String(pid).write(to: directory.appendingPathComponent(Self.pidFile), atomically: true, encoding: .utf8)
        defer {
            if process.isRunning { process.terminate() }
            Self.removePIDFile(in: directory, ifItIs: pid)
        }
        var last = ""
        // Cancelled (another model was picked): stop the download, which ends its output.
        try await withTaskCancellationHandler {
            for try await line in pipe.fileHandleForReading.bytes.lines {
                last = line
                if let fraction = Self.pullFraction(line) { progress(fraction) }
            }
        } onCancel: {
            kill(pid, SIGTERM)
        }
        try Task.checkCancellation()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw EngineError.failed("Model download failed: \(last)") }
    }

    /// How long a start waits for the engine to finish hashing the weights it loaded.
    static let witnessWait: TimeInterval = 600

    /// Start the engine and wait until its witness settles, so the next attestation names what it loaded.
    @discardableResult
    private func startEngine() async throws -> EngineWitness.Snapshot? {
        try await startServer()
        let deadline = Date().addingTimeInterval(Self.witnessWait)
        while true {
            witness = await readWitness()
            if witness?.settling != true || Date() > deadline { return witness }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    /// The engine's witness now; nil when it didn't answer one.
    private func readWitness() async -> EngineWitness.Snapshot? {
        guard server?.isRunning == true, var socket else { return nil }
        socket.timeout = 5
        guard let reply = try? await socket.send("GET", "/v1/execution/witness") else { return nil }
        defer { reply.close() }
        guard reply.status == 200, let data = try? await reply.data(limit: 1 << 16),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return EngineWitness.snapshot(object)
    }

    private func startServer() async throws {
        guard let snapshot else { throw EngineError.failed("Model not loaded") }
        witness = nil
        server?.terminate()
        Self.stopEngine(in: directory, engine: engine)
        if let old = socket?.path { unlink(old) }
        socket = nil
        let socketPath = try Self.newSocketPath()
        let apiKey = try Self.randomKey()
        let keyFile = directory.appendingPathComponent("engine.key")
        try? FileManager.default.removeItem(at: keyFile)
        guard FileManager.default.createFile(atPath: keyFile.path, contents: Data(apiKey.utf8), attributes: [.posixPermissions: 0o600]) else {
            throw EngineError.failed("Could not write the engine key")
        }
        FileManager.default.createFile(atPath: logFile.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let log = try FileHandle(forWritingTo: logFile)

        let process = try engineProcess([
            "serve", snapshot.path,
            // Owner-only, and no TCP port at all: decrypted prompts never cross a network interface.
            "--unix-socket", socketPath,
            "--api-key-file", keyFile.path,
            "--name", Self.servedName,
            "--context", String(Self.contextTokens),
            "--no-thinking",
            "--parallel", String(RequestGate.maxConcurrency),
            // Nothing from one buyer's prompt is kept for the next request.
            "--prompt-cache-gib", "0",
            // Its live page of rates and memory (no prompts), which the app opens through its local server.
            "--dashboard",
            "--no-update-check",
            // Hashes every weight byte once serving and binds each reply to it (`EngineWitness`).
            "--execution-witness",
        ], offline: true)
        process.currentDirectoryURL = directory
        process.standardOutput = log
        process.standardError = log
        try process.run()
        server = process
        try String(process.processIdentifier).write(to: directory.appendingPathComponent(Self.pidFile), atomically: true, encoding: .utf8)
        let candidate = EngineSocket(path: socketPath, enginePID: process.processIdentifier, apiKey: apiKey, requirement: engineRequirement)

        do {
            for _ in 0..<600 {
                guard process.isRunning else { break }
                var probe = candidate
                probe.timeout = 2
                if let reply = try? await probe.send("GET", "/v1/models") {
                    reply.close()
                    if reply.status == 200 {
                        socket = candidate
                        return
                    }
                }
                // Throws once cancelled: the engine this load started is stopped below.
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            throw EngineError.failed("The engine did not start (see \(logFile.path))")
        } catch {
            stop()
            throw error
        }
    }

    /// The running engine's socket, starting the engine again if it stopped: for the owner's own
    /// requests (LocalAPI) and the dashboard, which go to the engine as they are.
    func engineSocket() async throws -> EngineSocket {
        if server?.isRunning != true { try await restartEngine() }
        guard let socket else { throw EngineError.failed("Model not loaded") }
        return socket
    }

    /// The engine's live numbers, or nil when it isn't running or didn't answer.
    func stats() async -> EngineStats? {
        guard server?.isRunning == true, var socket else { return nil }
        socket.timeout = 2
        guard let reply = try? await socket.send("GET", "/stats") else { return nil }
        defer { reply.close() }
        guard reply.status == 200, let data = try? await reply.data(limit: 1 << 20) else { return nil }
        return EngineStats(json: data)
    }

    private func countTokens(_ chat: [String: Any]) async throws -> Int {
        // The tools render into the prompt too.
        var body: [String: Any] = ["model": Self.servedName, "messages": chat["messages"] ?? [Any]()]
        if let tools = chat["tools"] { body["tools"] = tools }
        let reply = try await request("/v1/tokenize", body: body)
        defer { reply.close() }
        try Self.requireOK(reply.status)
        guard let count = (try JSONSerialization.jsonObject(with: try await reply.data()) as? [String: Any])?["count"] as? Int else {
            throw EngineError.failed("The engine did not count the prompt")
        }
        return count
    }

    private func request(_ path: String, body: [String: Any]) async throws -> EngineSocket.Reply {
        guard let socket else { throw EngineError.failed("Model not loaded") }
        return try await socket.send("POST", path, body: try JSONSerialization.data(withJSONObject: body))
    }

    /// The engine's error body may quote the prompt and this error reaches the
    /// pool, so only the status is passed on.
    private static func requireOK(_ status: Int) throws {
        guard status == 200 else { throw EngineError.failed("The engine refused the request (HTTP \(status))") }
    }

    /// A new socket path in this user's temporary directory, which only this user
    /// can enter and whose path fits a socket address (104 bytes), unlike a long data directory.
    static func newSocketPath() throws -> String {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, buffer.count) > 0 else {
            throw EngineError.failed("Could not find this user's temporary directory")
        }
        let directory = URL(fileURLWithPath: String(cString: buffer), isDirectory: true).resolvingSymlinksInPath()
        return directory.appendingPathComponent("antseed-engine-\(try randomKey().prefix(12)).sock").path
    }

    private static func randomKey() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw EngineError.failed("Could not generate the engine key")
        }
        return Data(bytes).hex
    }
}
