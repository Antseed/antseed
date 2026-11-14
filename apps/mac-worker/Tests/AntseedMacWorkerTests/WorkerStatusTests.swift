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

    /// A saved model that fails to load at launch still joins the pool: its welcome lists the
    /// models to switch to, and the status keeps saying why the chosen one failed.
    func testAWelcomeAfterAFailedLoadKeepsTheErrorAndAWelcomeBeforeAChoicePicks() {
        let choice = ModelChoice(service: "qwen", model: "mlx-community/Qwen@" + String(repeating: "a", count: 40))
        XCTAssertEqual(WorkerStatus.welcomed(choice: choice, loaded: false, loadError: "Model failed to load: out of memory",
                                             sharing: true, rejected: [], current: .connecting),
                       .failed("Model failed to load: out of memory"))
        XCTAssertEqual(WorkerStatus.welcomed(choice: nil, loaded: false, loadError: nil, sharing: true, rejected: [], current: .connecting), .choosingModel)
        XCTAssertEqual(WorkerStatus.welcomed(choice: choice, loaded: true, loadError: nil, sharing: true, rejected: [], current: .connecting), .serving)
        // Still downloading: its progress stays.
        XCTAssertEqual(WorkerStatus.welcomed(choice: choice, loaded: false, loadError: nil, sharing: true, rejected: [], current: .loadingModel(0.4)), .loadingModel(0.4))
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
