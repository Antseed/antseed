import XCTest
@testable import AntseedMacWorker

final class PayServerTests: XCTestCase {
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
