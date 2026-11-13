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
}
