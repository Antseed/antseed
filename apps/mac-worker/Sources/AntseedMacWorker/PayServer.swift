import Foundation
import Network
import Security

/// Serves the Antseed payments page (apps/payments web build, bundled in
/// Contents/Resources/pay) on 127.0.0.1, for the two steps that need the
/// owner's own wallet: linking it to this Mac and claiming. The page opens in
/// the owner's browser, where wallet extensions and WalletConnect work; the
/// app answers its API.
///
/// Only this app's page can call the API: it listens on loopback only, checks
/// the Host header (no DNS rebinding), and requires a per-launch token the page
/// gets in the URL the app opens and sends as a bearer token, which no other
/// site can read or forge (browsers don't let pages set it cross-origin).
@MainActor
final class PayServer {
    struct Response {
        var status: Int
        var contentType: String
        var body: Data

        static func json(_ status: Int, _ object: Any) -> Response {
            let body = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
            return Response(status: status, contentType: "application/json", body: body)
        }

        static func error(_ status: Int, _ message: String) -> Response { json(status, ["error": message]) }
    }

    let token: String
    private let root: URL?
    private let api: (HTTPRequest) async -> Response
    /// Answers `/engine/…` (the engine's dashboard and the stats it polls), or nil when no engine runs.
    private let engine: (String) async -> Response?
    private var listener: NWListener?
    private var starting: Task<UInt16, Error>?
    private(set) var port: UInt16?

    /// `api` answers every `/api/…` request that passed the token check.
    init(api: @escaping (HTTPRequest) async -> Response, engine: @escaping (String) async -> Response? = { _ in nil }) {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = Data(bytes).hex
        root = Self.pageDirectory()
        self.api = api
        self.engine = engine
    }

    /// The bundled page, or the payments web build in the source tree during development.
    static func pageDirectory() -> URL? {
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("pay", isDirectory: true)
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("payments/dist/web", isDirectory: true)
        return [bundled, source].compactMap { $0 }.first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("index.html").path) }
    }

    /// The page for `action` (`colony-link`, `colony-claim`), starting the server on first use.
    func url(for action: String) async throws -> URL {
        guard root != nil else { throw PayServerError.missingPage }
        let port = try await start()
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = Int(port)
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "page", value: "pay"), URLQueryItem(name: "action", value: action), URLQueryItem(name: "token", value: token)]
        return components.url!
    }

    /// The engine's live dashboard (rates, memory, queue; never a prompt), starting the server on first use.
    func dashboardURL() async throws -> URL {
        URL(string: "http://127.0.0.1:\(try await start())\(Self.dashboardPath)")!
    }

    /// The dashboard polls the path beside its own (`/engine/stats`).
    nonisolated static let dashboardPath = "/engine/dashboard"
    nonisolated static let enginePaths: Set<String> = [dashboardPath, "/engine/stats"]

    enum PayServerError: Error, LocalizedError {
        case missingPage
        case failed(String)
        var errorDescription: String? {
            switch self {
            case .missingPage: "This build has no rewards page"
            case .failed(let reason): "The rewards page could not start: \(reason)"
            }
        }
    }

    /// The port the server listens on, starting it on first use. Callers during the start share it,
    /// so every URL handed out names the one listener; a failed start can be tried again.
    private func start() async throws -> UInt16 {
        if let port { return port }
        if let starting { return try await starting.value }
        let task = Task { @MainActor in
            defer { self.starting = nil }
            return try await self.listen()
        }
        starting = task
        return try await task.value
    }

    private func listen() async throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in self?.accept(connection) }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            listener.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready:
                    resumed = true
                    continuation.resume(returning: listener.port?.rawValue ?? 0)
                case .failed(let error):
                    resumed = true
                    listener.cancel()
                    continuation.resume(throwing: PayServerError.failed(error.localizedDescription))
                default:
                    break
                }
            }
            listener.start(queue: .main)
        }
        self.listener = listener
        self.port = port
        return port
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, done, error in
            Task { @MainActor in
                guard let self else { connection.cancel(); return }
                var buffer = buffer
                if let data { buffer.append(data) }
                if buffer.count > Self.maxRequestBytes { return self.send(.error(413, "Request too large"), on: connection) }
                switch HTTPRequest.parse(buffer, maxBytes: Self.maxRequestBytes) {
                case .request(let request): return self.send(await self.respond(to: request), on: connection)
                case .malformed: return self.send(.error(400, "Bad request"), on: connection)
                case .incomplete: break
                }
                if done || error != nil { return connection.cancel() }
                self.receive(on: connection, buffer: buffer)
            }
        }
    }

    nonisolated static let maxRequestBytes = 1_048_576

    private func respond(to request: HTTPRequest) async -> Response {
        guard let port, request.headers["host"] == "127.0.0.1:\(port)" else { return .error(403, "Forbidden") }
        if request.path.hasPrefix("/api/") {
            guard request.headers["authorization"] == "Bearer \(token)" else { return .error(401, "Reopen this page from Antseed Colony") }
            return await api(request)
        }
        guard request.method == "GET" else { return .error(405, "Method not allowed") }
        if Self.enginePaths.contains(request.path) {
            return await engine(String(request.path.dropFirst("/engine".count))) ?? .error(503, "No model is running yet")
        }
        return file(request.path)
    }

    /// A file of the page; anything outside it, or not found, is the page's index (it routes by its query).
    private func file(_ path: String) -> Response {
        guard let root else { return .error(404, "Not found") }
        let relative = path == "/" ? "index.html" : String(path.dropFirst())
        let safe = !relative.contains("..") && relative.allSatisfy { $0.isLetter || $0.isNumber || "._-/".contains($0) }
        let url = safe ? root.appendingPathComponent(relative) : root.appendingPathComponent("index.html")
        guard let data = try? Data(contentsOf: url) else {
            return relative.hasPrefix("assets/") || relative == "index.html" ? .error(404, "Not found") : file("/")
        }
        return Response(status: 200, contentType: Self.contentType(url.pathExtension), body: data)
    }

    nonisolated static func contentType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        case "ico": "image/x-icon"
        case "wasm": "application/wasm"
        default: "application/octet-stream"
        }
    }

    private func send(_ response: Response, on connection: NWConnection) {
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large", 503: "Service Unavailable"][response.status] ?? "Error"
        let head = [
            "HTTP/1.1 \(response.status) \(reason)",
            "Content-Type: \(response.contentType)",
            "Content-Length: \(response.body.count)",
            "Cache-Control: no-store",
            "X-Content-Type-Options: nosniff",
            "X-Frame-Options: DENY",
            // The token is in the page's URL: never send it on in a Referer.
            "Referrer-Policy: no-referrer",
            "Connection: close",
            "", "",
        ].joined(separator: "\r\n")
        connection.send(content: Data(head.utf8) + response.body, completion: .contentProcessed { _ in connection.cancel() })
    }
}
