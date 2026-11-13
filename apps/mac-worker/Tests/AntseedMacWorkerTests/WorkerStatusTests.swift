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

    func testPanelShowsCentsOnceThereAreSomeAndFourDecimalsBelow() {
        XCTAssertEqual(usdShort(0), "$0.00")
        XCTAssertEqual(usdShort(9_527), "$0.0095")
        XCTAssertEqual(usdShort(1_234_567), "$1.23")
    }

    func testTheAntsMoodFollowsTheStatus() {
        XCTAssertEqual(Mascot.mood(.serving), "happy")
        XCTAssertEqual(Mascot.mood(.loadingModel(0.5)), "think")
        XCTAssertEqual(Mascot.mood(.choosingModel), "idle")
        XCTAssertEqual(Mascot.mood(.failed("x")), "oops")
    }
}
