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
    struct Request {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

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
    private let api: (Request) async -> Response
    private var listener: NWListener?
    private(set) var port: UInt16?

    /// `api` answers every `/api/…` request that passed the token check.
    init(api: @escaping (Request) async -> Response) {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        token = Data(bytes).hex
        root = Self.pageDirectory()
        self.api = api
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

    private func start() async throws -> UInt16 {
        if let port { return port }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
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
                    continuation.resume(throwing: PayServerError.failed(error.localizedDescription))
                default:
                    break
                }
            }
            listener.start(queue: .main)
        }
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
                if buffer.count > 1_048_576 { return self.send(.error(413, "Request too large"), on: connection) }
                if let request = Self.parse(buffer) {
                    return self.send(await self.respond(to: request), on: connection)
                }
                if done || error != nil { return connection.cancel() }
                self.receive(on: connection, buffer: buffer)
            }
        }
    }

    /// An HTTP/1.1 request once its headers and body have arrived; nil while incomplete.
    nonisolated static func parse(_ buffer: Data) -> Request? {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let start = lines.removeFirst().split(separator: " ")
        guard start.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let body = buffer[end.upperBound...]
        guard body.count >= length else { return nil }
        let target = String(start[1])
        let path = target.split(separator: "?", maxSplits: 1).first.map(String.init) ?? target
        return Request(method: String(start[0]), path: path, headers: headers, body: Data(body.prefix(length)))
    }

    private func respond(to request: Request) async -> Response {
        guard let port, request.headers["host"] == "127.0.0.1:\(port)" else { return .error(403, "Forbidden") }
        if request.path.hasPrefix("/api/") {
            guard request.headers["authorization"] == "Bearer \(token)" else { return .error(401, "Reopen this page from Antseed Colony") }
            return await api(request)
        }
        guard request.method == "GET" else { return .error(405, "Method not allowed") }
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
        let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large"][response.status] ?? "Error"
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
