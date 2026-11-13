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
}
