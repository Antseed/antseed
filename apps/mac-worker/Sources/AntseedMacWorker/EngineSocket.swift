import Darwin
import Foundation

/// HTTP/1.1 to the engine over its Unix socket, which URLSession can't reach.
/// Each request opens its own connection and closes it after the reply, so
/// closing it mid-reply (a cancelled task does) cancels the request in the engine.
struct EngineSocket: Sendable {
    let path: String
    /// The engine's process. A connection whose other end is any other process,
    /// such as one that took the socket's path, is closed before anything is sent.
    let enginePID: pid_t
    let apiKey: String
    /// Longest wait for the engine to accept or send anything.
    var timeout: Int = 300

    enum SocketError: Error, LocalizedError {
        case failed(String)
        var errorDescription: String? { if case .failed(let reason) = self { reason } else { nil } }
    }

    func send(_ method: String, _ target: String, body: Data? = nil) async throws -> Reply {
        let connection = try Connection(path: path, timeout: timeout)
        do {
            guard connection.peerPID() == enginePID else {
                throw SocketError.failed("Another process is listening on the engine's socket")
            }
            var head = "\(method) \(target) HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer \(apiKey)\r\nConnection: close\r\n"
            if let body { head += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\n" }
            head += "\r\n"
            try connection.write(Data(head.utf8) + (body ?? Data()))
            let reply = Reply(connection)
            try await reply.readHead()
            return reply
        } catch {
            connection.close()
            throw error
        }
    }

    /// One reply: its status, then its body as data or as lines.
    final class Reply {
        private(set) var status = 0
        private let connection: Connection
        private var buffer: [UInt8] = []
        private var start = 0
        private var chunked = false
        /// Body bytes left: of the current chunk when chunked, else of a Content-Length body.
        private var left: Int?
        private var inChunk = false
        private var finished = false
        private var line: [UInt8] = []
        private static let maxLine = 8 << 20

        fileprivate init(_ connection: Connection) { self.connection = connection }
        deinit { connection.close() }

        func close() { connection.close() }

        /// The whole body, up to `limit` bytes.
        func data(limit: Int = 4 << 20) async throws -> Data {
            var data = Data()
            while let piece = try await nextBody() {
                data.append(contentsOf: piece)
                guard data.count <= limit else { throw SocketError.failed("The engine's reply is too long") }
            }
            return data
        }

        /// The body's next line, without its line ending; nil at its end.
        func nextLine() async throws -> String? {
            while true {
                if let newline = line.firstIndex(of: 10) {
                    var bytes = line[..<newline]
                    if bytes.last == 13 { bytes = bytes.dropLast() }
                    let text = String(decoding: bytes, as: UTF8.self)
                    line.removeSubrange(...newline)
                    return text
                }
                guard line.count <= Self.maxLine else { throw SocketError.failed("The engine sent a line that is too long") }
                guard let piece = try await nextBody() else {
                    defer { line.removeAll() }
                    return line.isEmpty ? nil : String(decoding: line, as: UTF8.self)
                }
                line.append(contentsOf: piece)
            }
        }

        fileprivate func readHead() async throws {
            guard let statusLine = try await rawLine() else { throw SocketError.failed("The engine closed the connection") }
            let parts = statusLine.split(separator: " ", maxSplits: 2)
            guard parts.count >= 2, parts[0].hasPrefix("HTTP/1."), let code = Int(parts[1]) else {
                throw SocketError.failed("The engine sent a malformed reply")
            }
            status = code
            while let header = try await rawLine(), !header.isEmpty {
                guard let colon = header.firstIndex(of: ":") else { continue }
                let name = header[..<colon].lowercased()
                let value = header[header.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                if name == "transfer-encoding" { chunked = value.lowercased().contains("chunked") }
                if name == "content-length" { left = Int(value) }
            }
            if chunked { left = 0 }
        }

        /// The body's next bytes, after removing chunked framing; nil at its end.
        private func nextBody() async throws -> ArraySlice<UInt8>? {
            if finished { return nil }
            if chunked {
                if left == 0 {
                    if inChunk {
                        guard try await rawLine() == "" else { throw SocketError.failed("The engine sent a malformed chunk") }
                    }
                    guard let sizeLine = try await rawLine(),
                          let size = Int(sizeLine.split(separator: ";").first?.trimmingCharacters(in: .whitespaces) ?? "", radix: 16), size >= 0
                    else { throw SocketError.failed("The engine sent a malformed chunk") }
                    if size == 0 { finished = true; return nil }
                    left = size
                    inChunk = true
                }
                guard let piece = try await take(left ?? 0) else { throw SocketError.failed("The engine ended the reply early") }
                left = (left ?? 0) - piece.count
                return piece
            }
            if let remaining = left {
                if remaining == 0 { finished = true; return nil }
                guard let piece = try await take(remaining) else { throw SocketError.failed("The engine ended the reply early") }
                left = remaining - piece.count
                return piece
            }
            guard let piece = try await take(Int.max) else { finished = true; return nil }
            return piece
        }

        /// Up to `count` buffered bytes, reading more when none are; nil when the connection ended.
        private func take(_ count: Int) async throws -> ArraySlice<UInt8>? {
            if start == buffer.count, try await !fill() { return nil }
            let end = start + min(count, buffer.count - start)
            defer { start = end }
            return buffer[start..<end]
        }

        /// A line of the head or chunk framing, without CRLF; nil when the connection ended.
        private func rawLine() async throws -> String? {
            while true {
                if let newline = buffer[start...].firstIndex(of: 10) {
                    var end = newline
                    if end > start, buffer[end - 1] == 13 { end -= 1 }
                    let text = String(decoding: buffer[start..<end], as: UTF8.self)
                    start = newline + 1
                    return text
                }
                guard buffer.count - start <= 64 << 10 else { throw SocketError.failed("The engine sent a malformed reply") }
                guard try await fill() else { return nil }
            }
        }

        /// Read more from the connection; false when it ended.
        private func fill() async throws -> Bool {
            if start > 0 {
                buffer.removeSubrange(..<start)
                start = 0
            }
            let more = try await connection.read(max: 64 << 10)
            if more.isEmpty { return false }
            buffer.append(contentsOf: more)
            return true
        }
    }

    final class Connection: @unchecked Sendable {
        private let lock = NSLock()
        private var fd: Int32

        init(path: String, timeout: Int) throws {
            fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw SocketError.failed("Could not open a socket to the engine") }
            var on: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            var limit = timeval(tv_sec: timeout, tv_usec: 0)
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &limit, socklen_t(MemoryLayout<timeval>.size))
            var address = sockaddr_un()
            let bytes = Array(path.utf8)
            // Failures close through close(), which forgets the descriptor: deinit, which runs when
            // the initializer throws, must not close a number the system may have reused meanwhile.
            guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
                close()
                throw SocketError.failed("The engine's socket path is too long")
            }
            address.sun_family = sa_family_t(AF_UNIX)
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
            let connected = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard connected == 0 else {
                close()
                throw SocketError.failed("Could not connect to the engine")
            }
        }

        deinit { close() }

        /// The process on the other end, as the kernel reports it.
        func peerPID() -> pid_t? {
            var pid: pid_t = 0
            var length = socklen_t(MemoryLayout<pid_t>.size)
            return getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0 ? pid : nil
        }

        func write(_ data: Data) throws {
            try data.withUnsafeBytes { raw in
                var sent = 0
                while sent < raw.count {
                    let n = Darwin.write(fd, raw.baseAddress! + sent, raw.count - sent)
                    if n < 0 && errno == EINTR { continue }
                    guard n > 0 else { throw SocketError.failed("Could not send the request to the engine") }
                    sent += n
                }
            }
        }

        /// The next bytes, empty once the engine closed the connection. A cancelled
        /// task shuts the connection, which ends the wait.
        func read(max: Int) async throws -> [UInt8] {
            let fd = lock.withLock { self.fd }
            guard fd >= 0 else { return [] }
            return try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    DispatchQueue.global().async {
                        var bytes = [UInt8](repeating: 0, count: max)
                        while true {
                            let n = Darwin.read(fd, &bytes, max)
                            if n >= 0 { return continuation.resume(returning: Array(bytes[..<n])) }
                            if errno == EINTR { continue }
                            let timedOut = errno == EAGAIN
                            return continuation.resume(throwing: SocketError.failed(timedOut ? "The engine stopped responding" : "Lost the connection to the engine"))
                        }
                    }
                }
            } onCancel: {
                self.shutdown()
            }
        }

        func shutdown() {
            lock.withLock { if fd >= 0 { _ = Darwin.shutdown(fd, SHUT_RDWR) } }
        }

        func close() {
            lock.withLock {
                if fd >= 0 { Darwin.close(fd) }
                fd = -1
            }
        }
    }
}
