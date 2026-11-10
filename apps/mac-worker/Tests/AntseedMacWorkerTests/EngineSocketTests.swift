import Darwin
import XCTest
@testable import AntseedMacWorker

final class EngineSocketTests: XCTestCase {
    /// A one-connection server on a Unix socket: records the request it receives
    /// and answers with `reply`.
    private final class FakeEngine: @unchecked Sendable {
        let path: String
        private let listener: Int32
        private(set) var request = ""
        private let done = DispatchSemaphore(value: 0)

        init(reply: String) throws {
            path = try LocalModel.newSocketPath()
            listener = socket(AF_UNIX, SOCK_STREAM, 0)
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            let bytes = Array(path.utf8)
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard bound == 0, listen(listener, 1) == 0 else { throw NSError(domain: "FakeEngine", code: Int(errno)) }
            Thread.detachNewThread { [self] in
                let fd = Darwin.accept(listener, nil, nil)
                guard fd >= 0 else { done.signal(); return }
                var on: Int32 = 1
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
                var received: [UInt8] = []
                var chunk = [UInt8](repeating: 0, count: 4096)
                while true {
                    let text = String(decoding: received, as: UTF8.self)
                    if let end = text.range(of: "\r\n\r\n") {
                        let length = text.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
                            .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                        if text[end.upperBound...].utf8.count >= length { break }
                    }
                    let n = Darwin.read(fd, &chunk, chunk.count)
                    if n <= 0 { break }
                    received.append(contentsOf: chunk[..<n])
                }
                request = String(decoding: received, as: UTF8.self)
                _ = Array(reply.utf8).withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
                Darwin.close(fd)
                done.signal()
            }
        }

        private var finished = false

        func finish() {
            guard !finished else { return }
            finished = true
            _ = done.wait(timeout: .now() + 5)
            Darwin.close(listener)
            unlink(path)
        }
    }

    func testStreamsAChunkedReplyAsLinesAndSendsTheKey() async throws {
        let events = "data: {\"a\":1}\n\ndata: [DONE]\n\n"
        let split = events.index(events.startIndex, offsetBy: 9)
        let first = String(events[..<split]), second = String(events[split...])
        let engine = try FakeEngine(reply: "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n"
            + "\(String(first.utf8.count, radix: 16))\r\n\(first)\r\n\(String(second.utf8.count, radix: 16))\r\n\(second)\r\n0\r\n\r\n")
        defer { engine.finish() }
        let socket = EngineSocket(path: engine.path, enginePID: getpid(), apiKey: "k1")
        let reply = try await socket.send("POST", "/v1/chat/completions", body: Data(#"{"x":1}"#.utf8))
        XCTAssertEqual(reply.status, 200)
        var lines: [String] = []
        while let line = try await reply.nextLine() { lines.append(line) }
        XCTAssertEqual(lines, [#"data: {"a":1}"#, "", "data: [DONE]", ""])
        engine.finish()
        XCTAssertTrue(engine.request.hasPrefix("POST /v1/chat/completions HTTP/1.1\r\n"))
        XCTAssertTrue(engine.request.contains("Authorization: Bearer k1\r\n"))
        XCTAssertTrue(engine.request.hasSuffix("\r\n\r\n{\"x\":1}"))
    }

    func testReadsALengthDelimitedBodyAndAnErrorStatus() async throws {
        let engine = try FakeEngine(reply: "HTTP/1.1 400 Bad Request\r\nContent-Length: 11\r\n\r\n{\"count\":3}")
        defer { engine.finish() }
        let reply = try await EngineSocket(path: engine.path, enginePID: getpid(), apiKey: "k").send("POST", "/v1/tokenize", body: Data("{}".utf8))
        XCTAssertEqual(reply.status, 400)
        let body = try await reply.data()
        XCTAssertEqual(String(decoding: body, as: UTF8.self), #"{"count":3}"#)
    }

    func testRefusesASocketThatAnotherProcessListensOn() async throws {
        let engine = try FakeEngine(reply: "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
        defer { engine.finish() }
        do {
            _ = try await EngineSocket(path: engine.path, enginePID: getpid() + 1, apiKey: "k").send("GET", "/v1/models")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Another process is listening on the engine's socket")
        }
        engine.finish()
        XCTAssertEqual(engine.request, "", "nothing, the key included, is sent to another process")
    }

    func testSocketPathsAreNewAndFitASocketAddress() throws {
        let a = try LocalModel.newSocketPath(), b = try LocalModel.newSocketPath()
        XCTAssertNotEqual(a, b)
        XCTAssertLessThan(a.utf8.count, 104)
        XCTAssertTrue(a.hasSuffix(".sock"))
    }
}
