import XCTest
@testable import AntseedMacWorker

final class PayServerTests: XCTestCase {
    private func parse(_ raw: String) -> PayServer.Parsed { PayServer.parse(Data(raw.utf8)) }

    func testParsesACompleteRequestAndDropsTheQuery() {
        guard case .request(let request) = parse("POST /api/colony/link?x=1 HTTP/1.1\r\nHost: 127.0.0.1:9\r\nContent-Length: 2\r\n\r\n{}") else {
            return XCTFail("expected a request")
        }
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/api/colony/link")
        XCTAssertEqual(request.headers["host"], "127.0.0.1:9")
        XCTAssertEqual(request.body, Data("{}".utf8))
    }

    func testWaitsForTheHeadersAndTheDeclaredBody() {
        XCTAssertEqual(parse("GET / HTTP/1.1\r\nHost: a"), .incomplete)
        XCTAssertEqual(parse("POST / HTTP/1.1\r\nContent-Length: 5\r\n\r\n{}"), .incomplete)
    }

    func testRejectsNegativeOverflowingAndInvalidLengths() {
        for length in ["-1", "-9223372036854775808", "99999999999999999999999", "12abc", "+3", "", " ", "\(PayServer.maxRequestBytes + 1)"] {
            XCTAssertEqual(parse("POST / HTTP/1.1\r\nContent-Length: \(length)\r\n\r\n{}"), .malformed, "Content-Length: \(length)")
        }
    }

    func testRejectsAMalformedRequestLine() {
        XCTAssertEqual(parse("GARBAGE\r\n\r\n"), .malformed)
    }

    @MainActor
    func testOpensDuringTheFirstStartShareOneListener() async throws {
        let server = PayServer(api: { _ in .error(404, "Not found") }, engine: { path in
            PayServer.Response(status: 200, contentType: "text/plain", body: Data(path.utf8))
        })
        async let first = server.dashboardURL()
        async let second = server.dashboardURL()
        let urls = try await [first, second]
        XCTAssertEqual(urls[0].port, urls[1].port)
        XCTAssertEqual(urls[0].port.map(UInt16.init), server.port)
        for url in urls {
            let (body, response) = try await URLSession.shared.data(from: url)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            XCTAssertEqual(String(decoding: body, as: UTF8.self), "/dashboard")
        }
    }
}
