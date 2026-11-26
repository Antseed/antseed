import CryptoKit
import XCTest
@testable import AntseedMacWorker

final class ModelFolderTests: XCTestCase {
    private var root: URL!
    private let commit = String(repeating: "a", count: 40)
    private lazy var offer = ModelChoice(service: "small", model: "org/Small@\(commit)")

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: root) }

    private func write(_ text: String, to path: String) throws {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }

    private func large(_ path: String, _ text: String) -> ModelFolder.PinnedFile {
        .init(path: path, size: UInt64(text.utf8.count), blob: Data(SHA256.hash(data: Data(text.utf8))).hex)
    }

    func testReadsTheFilesAndDropsPathsAndHashesThatAreNot() {
        let sha = String(repeating: "B", count: 64)
        let lfs: [String: Any] = ["sha256": sha, "size": 5]
        let files = ModelFolder.files(in: ["siblings": [
            ["rfilename": "config.json", "size": 10, "blobId": "../../config"],
            ["rfilename": "model.safetensors", "lfs": lfs],
            ["rfilename": "../escape", "lfs": lfs],
            ["rfilename": "/etc/passwd", "lfs": lfs],
            ["rfilename": "bad.safetensors", "lfs": ["sha256": "../../x", "size": 5]],
        ]])
        XCTAssertEqual(files, [.init(path: "model.safetensors", size: 5, blob: sha.lowercased())])
    }

    func testMatchesOnlyTheExactWeightsAndCopiesThemIntoTheCache() throws {
        try write("weights", to: "mine/model.safetensors")
        try write("another tokenizer", to: "mine/tokenizer.json")
        let folder = root.appendingPathComponent("mine"), hub = root.appendingPathComponent("hub")
        let right = [large("model.safetensors", "weights"), large("tokenizer.json", "the tokenizer....")]
        // The same size, other content: another quantization or revision.
        let wrong = ModelChoice(service: "other", model: "org/Other@\(commit)")
        let match = try XCTUnwrap(ModelFolder.match(folder, offers: [(wrong, [large("model.safetensors", "WEIGHTS")]), (offer, right)]))
        XCTAssertEqual(match.offer, offer)
        XCTAssertEqual(match.files, [right[0]], "a tokenizer that differs is downloaded, not taken")
        XCTAssertNil(try ModelFolder.match(folder, offers: [(wrong, [large("model.safetensors", "WEIGHTS")])]))
        XCTAssertNil(try ModelFolder.match(folder, offers: [(offer, right + [large("model-2.safetensors", "more")])]), "every shard is needed")

        try ModelFolder.add(match.files, from: folder, as: offer.model, hub: hub)
        let blobs = hub.appendingPathComponent("models--org--Small/blobs")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: blobs.path), [right[0].blob])
        // A copy: the owner editing their file later never changes what the Mac serves.
        try write("changed", to: "mine/model.safetensors")
        XCTAssertEqual(try String(contentsOf: blobs.appendingPathComponent(right[0].blob), encoding: .utf8), "weights")
    }

    func testAFileThatChangedSinceItMatchedNeverEntersTheCache() throws {
        try write("weights", to: "mine/model.safetensors")
        let file = large("model.safetensors", "weights"), hub = root.appendingPathComponent("hub")
        try write("tampers", to: "mine/model.safetensors")
        XCTAssertThrowsError(try ModelFolder.add([file], from: root.appendingPathComponent("mine"), as: offer.model, hub: hub))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: hub.appendingPathComponent("models--org--Small/blobs").path), [])
    }

    func testASmallFileMatchesByItsGitBlobID() throws {
        // `printf hello | git hash-object --stdin`
        let file = ModelFolder.PinnedFile(path: "config.json", size: 5, blob: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0")
        XCTAssertEqual(ModelFolder.files(in: ["siblings": [["rfilename": "config.json", "size": 5, "blobId": file.blob]]]), [file])
        try write("hello", to: "config.json")
        XCTAssertTrue(try file.matches(root.appendingPathComponent("config.json")))
        try write("jello", to: "config.json")
        XCTAssertFalse(try file.matches(root.appendingPathComponent("config.json")))
    }

    func testIsCachedOnlyWhenEveryShardIsThere() throws {
        let snapshot = "hub/models--org--Small/snapshots/\(commit)"
        let hub = root.appendingPathComponent("hub")
        XCTAssertFalse(ModelFolder.isCached(offer.model, hub: hub))
        try write("{}", to: "\(snapshot)/config.json")
        try write("one", to: "\(snapshot)/model-1.safetensors")
        try write(#"{"weight_map":{"a":"model-1.safetensors","b":"model-2.safetensors"}}"#, to: "\(snapshot)/model.safetensors.index.json")
        XCTAssertFalse(ModelFolder.isCached(offer.model, hub: hub))
        // A link to a blob that is gone is not a file.
        let shard = root.appendingPathComponent("\(snapshot)/model-2.safetensors")
        try FileManager.default.createSymbolicLink(atPath: shard.path, withDestinationPath: "../../blobs/gone")
        XCTAssertFalse(ModelFolder.isCached(offer.model, hub: hub))
        try FileManager.default.removeItem(at: shard)
        try write("two", to: "\(snapshot)/model-2.safetensors")
        XCTAssertTrue(ModelFolder.isCached(offer.model, hub: hub))
    }
}
