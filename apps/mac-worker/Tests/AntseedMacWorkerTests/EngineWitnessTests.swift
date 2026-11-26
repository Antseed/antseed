@testable import AntseedMacWorker
import XCTest

final class EngineWitnessTests: XCTestCase {
    private let digest = String(repeating: "ab", count: 32)

    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    func testReadsAKnownSnapshot() throws {
        let json = #"{"schema":1,"state":"known","witness":"\#(digest)","content":"\#(digest)","instance":"00","epoch":1,"path":"qwen3_5-2b/metal/tp1/mlx-q4g64/text","components":{"engine":"\#(String(repeating: "01", count: 32))","binary":"\#(String(repeating: "02", count: 32))","text":"\#(String(repeating: "03", count: 32))","preparation":"\#(digest)","environment":"\#(digest)"}}"#
        let snapshot = try XCTUnwrap(EngineWitness.snapshot(try object(json)))
        XCTAssertEqual(snapshot.known, EngineWitness.Known(witness: digest, path: "qwen3_5-2b/metal/tp1/mlx-q4g64/text", engine: String(repeating: "01", count: 32),
                                                           binary: String(repeating: "02", count: 32), text: String(repeating: "03", count: 32)))
        XCTAssertFalse(snapshot.settling)
    }

    func testReadsUnknownReasons() throws {
        let pending = try XCTUnwrap(EngineWitness.snapshot(try object(#"{"schema":1,"state":"unknown","reason":"pending","instance":"00","epoch":1}"#)))
        XCTAssertTrue(pending.settling)
        XCTAssertNil(pending.known)
        let changed = try XCTUnwrap(EngineWitness.snapshot(try object(#"{"schema":1,"state":"unknown","reason":"files_changed","instance":"00","epoch":1}"#)))
        XCTAssertTrue(changed.filesChanged)
        XCTAssertFalse(changed.settling)
        let excluded = try XCTUnwrap(EngineWitness.snapshot(try object(#"{"schema":1,"state":"unknown","reason":"feature_excluded","feature":"--recall"}"#)))
        XCTAssertEqual(excluded, .unknown(reason: "feature_excluded", feature: "--recall"))
        XCTAssertEqual(excluded.summary, "no execution witness (feature_excluded --recall)")
    }

    func testRefusesMalformedSnapshots() throws {
        // Another schema, an uppercase or short digest, a path with the attestation's separators.
        for json in [
            #"{"schema":2,"state":"unknown","reason":"pending"}"#,
            #"{"schema":1,"state":"known","witness":"\#(digest.uppercased())","path":"p","components":{"engine":"\#(digest)","binary":"\#(digest)","text":"\#(digest)"}}"#,
            #"{"schema":1,"state":"known","witness":"ab","path":"p","components":{"engine":"\#(digest)","binary":"\#(digest)","text":"\#(digest)"}}"#,
            #"{"schema":1,"state":"known","witness":"\#(digest)","path":"a#b","components":{"engine":"\#(digest)","binary":"\#(digest)","text":"\#(digest)"}}"#,
            #"{"schema":1,"state":"known","witness":"\#(digest)","path":"p","components":{"engine":"\#(digest)","binary":"\#(digest)"}}"#,
        ] {
            XCTAssertNil(EngineWitness.snapshot(try object(json)), json)
        }
    }

    func testReadsTheReplyBindingOnTheFinishChunk() throws {
        let line = #"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"execution_witness":{"schema":1,"state":"known","binding":"\#(String(repeating: "cd", count: 32))","witness":"\#(digest)","path":"p","instance":"00","epoch":1}}"#
        let event = try XCTUnwrap(EngineChat.parseEvent(line))
        XCTAssertEqual(event.witness, EngineWitness.Binding(known: true, witness: digest, binding: String(repeating: "cd", count: 32), reason: nil))
        let unknown = try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"execution_witness":{"schema":1,"state":"unknown","reason":"witness_changed"}}"#))
        XCTAssertEqual(unknown.witness, EngineWitness.Binding(known: false, witness: nil, binding: nil, reason: "witness_changed"))
        XCTAssertNil(try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}"#)).witness)
    }
}
