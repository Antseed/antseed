import Foundation
import Network
import Security

/// The owner's own endpoint to the model this Mac runs: OpenAI- and Anthropic-style HTTP on
/// 127.0.0.1, for apps and tools on this Mac. Off until the owner turns it on in the panel.
///
/// It is the owner's, not the pool's: requests go to the engine as they are (no pool, no
/// payment, no encryption), never leave the Mac, and only callers with its key get in. It
/// listens on loopback only and checks the Host header (no DNS rebinding); it sends no CORS
/// headers, so a web page can't read its answers. While the owner's request runs, the pool's
/// go to other Macs (RequestGate.localActive).
struct LocalAPISettings: Codable, Equatable {
    static let fileName = "local-api.json"
    static let defaultPort: UInt16 = 11435

    var enabled = false
    var port = LocalAPISettings.defaultPort
    /// The key callers send as `Authorization: Bearer …` or `x-api-key`.
    var key: String

    /// The saved settings, else new ones (off, with a fresh key).
    static func load(in directory: URL) -> LocalAPISettings {
        let url = directory.appendingPathComponent(fileName)
        if let data = try? Data(contentsOf: url), let saved = try? JSONDecoder().decode(LocalAPISettings.self, from: data), !saved.key.isEmpty {
            return saved
        }
        return LocalAPISettings(key: newKey())
    }

    /// Owner-only, like the app's other files: the key lets any process on this Mac use the model.
    func save(in directory: URL) throws {
        let url = directory.appendingPathComponent(Self.fileName)
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    static func newKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return "sk-colony-" + Data(bytes).hex
    }

    var baseURL: String { "http://127.0.0.1:\(port)/v1" }
}

@MainActor
final class LocalAPIServer {
    /// Bodies up to this size: a whole 8K-token conversation fits many times over.
    nonisolated static let maxRequestBytes = 8 << 20

    /// The routes passed to the engine. Its other routes (loading models, memory, learning) change
    /// what the pool's buyers are served, so they stay closed.
    nonisolated static let forwardedPaths: Set<String> = [
        "/v1/chat/completions", "/v1/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens",
    ]

    enum Route: Equatable {
        /// The model list, answered here under the service name.
        case models
        /// Passed to the engine, with the body's model set to the one it serves.
        case forward(path: String, body: Data)
        case reject(status: Int, message: String)
    }

    /// What to do with `request`: nil-free, so every request gets an answer.
    nonisolated static func route(_ request: PayServer.Request, port: UInt16, key: String) -> Route {
        let host = request.headers["host"] ?? ""
        guard host == "127.0.0.1:\(port)" || host == "localhost:\(port)" else { return .reject(status: 403, message: "Forbidden") }
        let bearer = request.headers["authorization"].flatMap { $0.hasPrefix("Bearer ") ? String($0.dropFirst(7)) : nil }
        guard constantTimeEqual(bearer ?? request.headers["x-api-key"] ?? "", key) else {
            return .reject(status: 401, message: "Use the key shown in Antseed Colony")
        }
        if request.path == "/v1/models" {
            return request.method == "GET" ? .models : .reject(status: 405, message: "Method not allowed")
        }
        guard forwardedPaths.contains(request.path) else { return .reject(status: 404, message: "Not found") }
        guard request.method == "POST" else { return .reject(status: 405, message: "Method not allowed") }
        guard var body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any] else {
            return .reject(status: 400, message: "The body must be a JSON object")
        }
        // One model runs: whatever name the caller used, it means that one.
        body["model"] = LocalModel.servedName
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return .reject(status: 400, message: "Bad request") }
        return .forward(path: request.path, body: data)
    }

    nonisolated static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        guard x.count == y.count else { return false }
        return zip(x, y).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    /// The engine to forward to, and the service name its model is sold under (nil: no model loaded).
    struct Target {
        let socket: EngineSocket
        let service: String
    }

    private let settings: () -> LocalAPISettings
    private let target: () async throws -> Target?
    private let onStart: () -> Void
    private let onEnd: () -> Void
    private var listener: NWListener?
    private(set) var port: UInt16?

    init(settings: @escaping () -> LocalAPISettings, target: @escaping () async throws -> Target?,
         onStart: @escaping () -> Void, onEnd: @escaping () -> Void) {
        self.settings = settings
        self.target = target
        self.onStart = onStart
        self.onEnd = onEnd
    }

    /// Listen on 127.0.0.1:`port`; throws why it can't (the port is taken).
    func start(port: UInt16) async throws {
        if self.port == port, listener != nil { return }
        stop()
        guard let endpointPort = NWEndpoint.Port(rawValue: port) else { throw LocalAPIError.failed("Invalid port \(port)") }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: endpointPort)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in self?.accept(connection) }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            var resumed = false
            listener.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    resumed = true
                    continuation.resume()
                case .failed(let error), .waiting(let error):
                    resumed = true
                    listener.cancel()
                    continuation.resume(throwing: LocalAPIError.failed("Port \(port) is not available (\(error.localizedDescription))"))
                default:
                    break
                }
            }
            listener.start(queue: .main)
        }
        self.listener = listener
        self.port = port
    }

    func stop() {
        listener?.cancel()
        listener = nil
        port = nil
    }

    enum LocalAPIError: Error, LocalizedError {
        case failed(String)
        var errorDescription: String? { if case .failed(let reason) = self { reason } else { nil } }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            Task { @MainActor in
                guard let self, let port = self.port else { connection.cancel(); return }
                var buffer = buffer
                if let data { buffer.append(data) }
                if buffer.count > Self.maxRequestBytes + 65_536 { return self.reply(413, "Request too large", on: connection) }
                switch PayServer.parse(buffer, maxBytes: Self.maxRequestBytes) {
                case .request(let request): return await self.answer(request, port: port, on: connection)
                case .malformed: return self.reply(400, "Bad request", on: connection)
                case .incomplete: break
                }
                if done || error != nil { return connection.cancel() }
                self.receive(on: connection, buffer: buffer)
            }
        }
    }

    private func answer(_ request: PayServer.Request, port: UInt16, on connection: NWConnection) async {
        switch Self.route(request, port: port, key: settings().key) {
        case .reject(let status, let message):
            reply(status, message, on: connection)
        case .models:
            guard let target = try? await target() else { return reply(503, "No model is loaded yet", on: connection) }
            let list: [String: Any] = ["object": "list", "data": [["id": target.service, "object": "model", "owned_by": "antseed-colony"]]]
            send(status: 200, contentType: "application/json", body: (try? JSONSerialization.data(withJSONObject: list)) ?? Data(), on: connection)
        case .forward(let path, let body):
            await forward(path: path, body: body, on: connection)
        }
    }

    /// Pass the request to the engine and stream its reply back as it comes (chunked), so a
    /// streamed answer arrives token by token. A caller that hangs up cancels it in the engine.
    private func forward(path: String, body: Data, on connection: NWConnection) async {
        onStart()
        defer { onEnd() }
        let engineTarget: Target
        do {
            guard let found = try await target() else { return reply(503, "No model is loaded yet", on: connection) }
            engineTarget = found
        } catch {
            return reply(503, "The model is not running: \(error.localizedDescription)", on: connection)
        }
        let started = Started()
        let work = Task { @MainActor in
            let engine = try await engineTarget.socket.send("POST", path, body: body)
            defer { engine.close() }
            started.value = true
            try await Self.write(Data(Self.head(status: engine.status, contentType: engine.contentType ?? "application/json", chunked: true).utf8), to: connection)
            while let piece = try await engine.nextChunk() {
                try Task.checkCancellation()
                guard !piece.isEmpty else { continue }
                try await Self.write(Data(String(piece.count, radix: 16).utf8) + Data("\r\n".utf8) + piece + Data("\r\n".utf8), to: connection)
            }
            try await Self.write(Data("0\r\n\r\n".utf8), to: connection)
        }
        // The caller hung up: stop generating for it. A whole (not streamed) answer writes nothing
        // until it is done, so the end of the caller's side is watched for too.
        connection.stateUpdateHandler = { state in
            switch state {
            case .failed, .cancelled: work.cancel()
            default: break
            }
        }
        Self.watchHangUp(connection) { work.cancel() }
        do {
            try await work.value
            connection.cancel()
        } catch {
            // Nothing sent yet: say why; otherwise the cut-off reply is all there is.
            if started.value { connection.cancel() } else { reply(502, "The model could not answer: \(error.localizedDescription)", on: connection) }
        }
    }

    /// Calls `hungUp` once the caller closes its side (or the connection fails); bytes it sends after
    /// its request are ignored.
    private nonisolated static func watchHangUp(_ connection: NWConnection, _ hungUp: @escaping @Sendable () -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { _, _, done, error in
            if done || error != nil { hungUp() } else { watchHangUp(connection, hungUp) }
        }
    }

    /// Whether a forwarded reply's head went out (after which no error reply can follow).
    @MainActor private final class Started { var value = false }

    nonisolated static func head(status: Int, contentType: String, length: Int? = nil, chunked: Bool = false) -> String {
        var lines = [
            "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")",
            "Content-Type: \(contentType)",
            "Cache-Control: no-store",
            "X-Content-Type-Options: nosniff",
            "Connection: close",
        ]
        if let length { lines.append("Content-Length: \(length)") }
        if chunked { lines.append("Transfer-Encoding: chunked") }
        return lines.joined(separator: "\r\n") + "\r\n\r\n"
    }

    /// An OpenAI-style error, then close.
    private func reply(_ status: Int, _ message: String, on connection: NWConnection) {
        let error: [String: Any] = ["error": ["message": message, "type": status == 401 ? "authentication_error" : "invalid_request_error"]]
        send(status: status, contentType: "application/json", body: (try? JSONSerialization.data(withJSONObject: error)) ?? Data(), on: connection)
    }

    private func send(status: Int, contentType: String, body: Data, on connection: NWConnection) {
        let head = Data(Self.head(status: status, contentType: contentType, length: body.count).utf8)
        connection.send(content: head + body, completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func write(_ data: Data, to connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }
}
