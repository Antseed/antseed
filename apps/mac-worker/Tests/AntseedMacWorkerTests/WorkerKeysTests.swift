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

    /// File-only: a test stays in its temporary directory and never reaches the app's keychain.
    private func load() throws -> WorkerKeys { try WorkerKeys.loadOrCreate(in: directory, keychain: false) }

    private func assertRefusedAndUntouched(_ contents: Data, file: StaticString = #filePath, line: UInt = #line) throws {
        let url = directory.appendingPathComponent("keys.json")
        try contents.write(to: url)
        XCTAssertThrowsError(try load(), file: file, line: line) { error in
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
        XCTAssertThrowsError(try load())
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        XCTAssertEqual(try Data(contentsOf: url), contents)
    }

    func testFirstLaunchCreatesAndKeepsTheIdentity() throws {
        let first = try load()
        let again = try load()
        XCTAssertEqual(first.ethereum.address, again.ethereum.address)
        XCTAssertEqual(first.encryptionKeyHex, again.encryptionKeyHex)
        XCTAssertEqual(first.attestationKeyHex, again.attestationKeyHex)
        // Every key is in the file, so none went to the keychain.
        XCTAssertFalse(first.appBound)
        let stored = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("keys.json"))) as? [String: String])
        XCTAssertEqual(stored.keys.filter { $0.hasSuffix("-encryption") || $0.hasSuffix("-attestation") }.count, 2)
    }
}
