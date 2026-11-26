import XCTest
@testable import AntseedMacWorker

final class PoolAddressTests: XCTestCase {
    func testAcceptsSecurePoolsAndLocalPlainOnes() {
        XCTAssertEqual(PoolAddress.parse("wss://pool.example.com:8790")?.absoluteString, "wss://pool.example.com:8790")
        XCTAssertEqual(PoolAddress.parse("  pool.example.com:8790 \n")?.absoluteString, "wss://pool.example.com:8790")
        XCTAssertEqual(PoolAddress.parse("ws://127.0.0.1:8790")?.absoluteString, "ws://127.0.0.1:8790")
        XCTAssertEqual(PoolAddress.parse("ws://localhost:8790")?.absoluteString, "ws://localhost:8790")
    }

    func testRefusesPlainRemotePoolsAndOtherSchemes() {
        XCTAssertNil(PoolAddress.parse("ws://pool.example.com:8790"))
        XCTAssertNil(PoolAddress.parse("https://pool.example.com"))
        XCTAssertNil(PoolAddress.parse(""))
        XCTAssertNil(PoolAddress.parse("wss://"))
    }

    func testKeepsTheEnteredPoolAcrossLaunches() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertNil(PoolAddress.saved(in: directory))
        try PoolAddress.save(URL(string: "wss://pool.example.com:8790")!, in: directory)
        XCTAssertEqual(PoolAddress.saved(in: directory)?.absoluteString, "wss://pool.example.com:8790")
        XCTAssertEqual(WorkerConfig.fromCommandLine(["app", "--data-dir", directory.path]).poolURL?.absoluteString, "wss://pool.example.com:8790")
        XCTAssertEqual(WorkerConfig.fromCommandLine(["app", "--data-dir", directory.path, "--pool", "ws://127.0.0.1:9000"]).poolURL?.absoluteString, "ws://127.0.0.1:9000")
    }
}
