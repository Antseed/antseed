import XCTest
@testable import AntseedMacWorker

final class WorkerStatusTests: XCTestCase {
    func testAPoolThatRefusesTheOfferedServiceIsAFailureNotSharing() {
        let refused = WorkerStatus.joined(sharing: true, service: "qwen", rejected: ["qwen"])
        guard case .failed(let message) = refused else { return XCTFail("expected a failure, got \(refused)") }
        XCTAssertTrue(message.contains("qwen"))
        XCTAssertEqual(WorkerStatus.joined(sharing: true, service: "qwen", rejected: []), .serving)
        XCTAssertEqual(WorkerStatus.joined(sharing: true, service: "qwen", rejected: ["other"]), .serving)
        // Offering nothing on purpose stays paused.
        XCTAssertEqual(WorkerStatus.joined(sharing: false, service: "qwen", rejected: []), .paused)
    }
}
