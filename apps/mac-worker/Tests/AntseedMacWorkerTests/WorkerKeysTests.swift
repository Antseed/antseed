import XCTest
@testable import AntseedMacWorker

final class WorkerKeysTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("antseed-keys-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        let file = directory.appendingPathComponent("keys.json")
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try? FileManager.default.removeItem(at: directory)
    }

    private func assertRefusedAndUntouched(_ contents: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        let url = directory.appendingPathComponent("keys.json")
        try contents.write(to: url)
        XCTAssertThrowsError(try WorkerKeys.loadOrCreate(in: directory), file: file, line: line) { error in
            XCTAssertTrue(error.localizedDescription.contains("left untouched"), file: file, line: line)
        }
        XCTAssertEqual(try Data(contentsOf: url), contents, "the damaged file is preserved", file: file, line: line)
    }

    func testMalformedKeyFileIsNotOverwritten() throws {
        try assertRefusedAndUntouched(Data("{\"ethereum\": \"0x12".utf8))
        try assertRefusedAndUntouched(Data("[1, 2, 3]".utf8))
        try assertRefusedAndUntouched(Data("{\"se-encryption\": \"AAAA\"}".utf8)) // no address key
        try assertRefusedAndUntouched(Data("{\"ethereum\": \"zz\"}".utf8))
    }

    func testUnreadableKeyFileIsNotOverwritten() throws {
        let url = directory.appendingPathComponent("keys.json")
        let contents = Data("{\"ethereum\": \"\(String(repeating: "11", count: 32))\"}".utf8)
        try contents.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: url.path)
        XCTAssertThrowsError(try WorkerKeys.loadOrCreate(in: directory))
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        XCTAssertEqual(try Data(contentsOf: url), contents)
    }

    func testFirstLaunchCreatesAndKeepsTheIdentity() throws {
        let first = try WorkerKeys.loadOrCreate(in: directory)
        let again = try WorkerKeys.loadOrCreate(in: directory)
        XCTAssertEqual(first.ethereum.address, again.ethereum.address)
    }
}
