import XCTest
@testable import AntseedMacWorker

final class ModelChoiceTests: XCTestCase {
    private let commit = String(repeating: "a", count: 40)

    func testOffersOnlyPinsToAFullCommitAndDropsTheDigest() {
        let offers = ModelChoice.offers(from: [
            "qwen3.5-9b": "mlx-community/Qwen3.5-9B-MLX-4bit@\(commit)#\(String(repeating: "b", count: 64))",
            "qwen3.5-2b": "mlx-community/Qwen3.5-2B-MLX-4bit@\(commit)",
            "branch": "mlx-community/Some-Model@main",
        ])
        XCTAssertEqual(offers, [
            ModelChoice(service: "qwen3.5-2b", model: "mlx-community/Qwen3.5-2B-MLX-4bit@\(commit)"),
            ModelChoice(service: "qwen3.5-9b", model: "mlx-community/Qwen3.5-9B-MLX-4bit@\(commit)"),
        ])
        XCTAssertEqual(offers.first?.displayName, "Qwen3.5-2B-MLX-4bit")
    }

    func testKeepsTheChoiceAcrossLaunchesAndTheCommandLineOverridesIt() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertNil(WorkerConfig.fromCommandLine(["app", "--data-dir", directory.path]).choice)
        let picked = ModelChoice(service: "qwen3.5-9b", model: "mlx-community/Qwen3.5-9B-MLX-4bit@\(commit)")
        try picked.save(in: directory)
        XCTAssertEqual(WorkerConfig.fromCommandLine(["app", "--data-dir", directory.path]).choice, picked)
        let override = WorkerConfig.fromCommandLine(["app", "--data-dir", directory.path, "--model", "org/repo@\(commit)"]).choice
        XCTAssertEqual(override, ModelChoice(service: ModelChoice.fallback.service, model: "org/repo@\(commit)"))
    }

    func testFitsWhenTheWeightsTakeAtMostHalfTheMemory() {
        XCTAssertTrue(ModelSize.fits(8 << 30, memory: 16 << 30))
        XCTAssertFalse(ModelSize.fits(9 << 30, memory: 16 << 30))
    }
}
