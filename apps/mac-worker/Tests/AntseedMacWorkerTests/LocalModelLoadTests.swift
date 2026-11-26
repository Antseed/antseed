import Darwin
import XCTest
@testable import AntseedMacWorker

final class LocalModelLoadTests: XCTestCase {
    /// A model picked while another downloads cancels that load: its download must stop, and it
    /// must never go on to start an engine (which would stop the one the newer pick started).
    func testACancelledLoadStopsItsDownloadAndNeverStartsTheEngine() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let served = directory.appendingPathComponent("served")
        let engine = directory.appendingPathComponent("tensorfold")
        let script = """
        #!/bin/sh
        if [ "$1" = pull ]; then echo "0.10 of 1.00 GiB, 1.0 MiB/s"; exec sleep 30; fi
        touch "\(served.path)"
        exec sleep 30
        """
        try script.write(to: engine, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)

        let model = LocalModel(modelId: "antseed-test/never-cached@" + UUID().uuidString.lowercased(), engine: engine, directory: directory)
        let downloading = expectation(description: "the download started")
        downloading.assertForOverFulfill = false
        let load = Task { try await model.load { _ in downloading.fulfill() } }
        await fulfillment(of: [downloading], timeout: 10)
        let pidFile = directory.appendingPathComponent("engine.pid")
        let pid = try XCTUnwrap(pid_t(try String(contentsOf: pidFile, encoding: .utf8)))

        load.cancel()
        do {
            _ = try await load.value
            XCTFail("a cancelled load must not finish")
        } catch {}

        XCTAssertFalse(FileManager.default.fileExists(atPath: pidFile.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: served.path), "a cancelled load never starts the engine")
        var stopped = false
        for _ in 0..<30 where !stopped {
            stopped = kill(pid, 0) != 0
            if !stopped { try await Task.sleep(nanoseconds: 100_000_000) }
        }
        XCTAssertTrue(stopped, "the download is stopped")
    }

    /// The engine gets a fixed environment and no core dumps, whatever the app was started with:
    /// `TENSORFOLD_REQUEST_LOG` would have it write every decrypted prompt to a file.
    func testTheEngineGetsAFixedEnvironmentAndNoCoreDumps() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let seen = directory.appendingPathComponent("seen")
        let engine = directory.appendingPathComponent("tensorfold")
        try "#!/bin/sh\nenv > \"\(seen.path)\"\necho \"core=$(ulimit -c)\" >> \"\(seen.path)\"\nexit 1\n".write(to: engine, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)
        setenv("TENSORFOLD_REQUEST_LOG", directory.appendingPathComponent("prompts.log").path, 1)
        defer { unsetenv("TENSORFOLD_REQUEST_LOG") }

        let model = LocalModel(modelId: "antseed-test/never-cached@" + UUID().uuidString.lowercased(), engine: engine, directory: directory, engineRequirement: nil)
        do {
            _ = try await model.load { _ in }
            XCTFail("the fake download fails")
        } catch {}
        let lines = try String(contentsOf: seen, encoding: .utf8).split(separator: "\n").map(String.init)
        XCTAssertFalse(lines.contains { $0.hasPrefix("TENSORFOLD_REQUEST_LOG=") })
        XCTAssertTrue(lines.contains("HOME=\(EngineCode.accountHome())"))
        XCTAssertTrue(lines.contains { $0.hasPrefix("HF_HUB_CACHE=") })
        XCTAssertTrue(lines.contains("core=0"))
    }

    func testRefusesToRunAnEngineFileThatIsNotThisTeams() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let ran = directory.appendingPathComponent("ran")
        let engine = directory.appendingPathComponent("tensorfold")
        try "#!/bin/sh\ntouch \"\(ran.path)\"\nexit 1\n".write(to: engine, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)

        let model = LocalModel(modelId: "antseed-test/never-cached@" + UUID().uuidString.lowercased(), engine: engine, directory: directory,
                               engineRequirement: EngineCode.requirement(teamId: "ABCDE12345"))
        do {
            _ = try await model.load { _ in }
            XCTFail("expected a refusal")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("is not the one this app ships"), error.localizedDescription)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: ran.path), "the engine never ran")
    }

    /// Agents compact their history when an error reads as a context overflow; OpenAI's wording is
    /// the one they all match.
    func testAPromptThatDoesNotFitReadsAsAContextOverflow() {
        let error = LocalModel.EngineError.promptTooLong(tokens: 40_000, limit: LocalModel.contextTokens - 1)
        XCTAssertEqual(error.localizedDescription, "This model's maximum context length is 32767 tokens. However, your messages resulted in 40000 tokens.")
    }
}
