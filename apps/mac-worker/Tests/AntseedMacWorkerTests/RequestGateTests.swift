import XCTest
@testable import AntseedMacWorker

@MainActor
final class RequestGateTests: XCTestCase {
    private let channel = "0x" + String(repeating: "ab", count: 32)
    private let zeroChannel = "0x" + String(repeating: "0", count: 64)
    private let buyer = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"

    func testRunsNoMoreRequestsThanAnnounced() {
        let gate = RequestGate(maxConcurrency: 1)
        XCTAssertNil(gate.reserve("a"))
        XCTAssertNotNil(gate.reserve("b"), "a second request while one runs is refused")
        XCTAssertNotNil(gate.reserve("a"), "a duplicate id is refused")
        gate.release("a")
        XCTAssertNil(gate.reserve("b"))
    }

    func testPendingChannelCheckHoldsItsSlot() async {
        let gate = RequestGate(maxConcurrency: 1)
        XCTAssertNil(gate.reserve("slow"))
        let started = expectation(description: "verification started")
        let release = AsyncGate()
        let admission = Task {
            await gate.admit(buyer: buyer, channel: channel, bodyBytes: 100, requestedMaxTokens: 512, check: .verify {
                started.fulfill()
                await release.wait()
                return true
            })
        }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertNotNil(gate.reserve("next"), "a request waiting on its channel counts toward the limit")
        await release.open()
        let result = await admission.value
        XCTAssertEqual(result, .full)
    }

    func testCancelledDuringVerificationNeverStarts() async {
        let gate = RequestGate()
        let verdicts = ChannelVerdicts(wait: 5, pollInterval: 0.05) { _, _ in nil } // never on-chain
        let started = Date()
        let admission = Task {
            await gate.admit(buyer: buyer, channel: channel, bodyBytes: 100, requestedMaxTokens: 512, check: .verify {
                await verdicts.verdict(channel: self.channel, buyer: self.buyer)
            })
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
        admission.cancel()
        let result = await admission.value
        XCTAssertEqual(result, .cancelled)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "cancellation returns without waiting out the lookup")
    }

    func testVerdictsMapToAdmissions() async {
        let gate = RequestGate()
        let refused = await gate.admit(buyer: buyer, channel: channel, bodyBytes: 100, requestedMaxTokens: 512, check: .verify { false })
        let unknown = await gate.admit(buyer: buyer, channel: channel, bodyBytes: 100, requestedMaxTokens: 512, check: .verify { nil })
        let untrusted = await gate.admit(buyer: buyer, channel: channel, bodyBytes: 100, requestedMaxTokens: 512, check: .unavailable("No trusted Channels contract"))
        let noRPC = await gate.admit(buyer: buyer, channel: channel, bodyBytes: 100, requestedMaxTokens: 512, check: .unavailable("No RPC"))
        XCTAssertEqual(refused, .refused("Request channel does not belong to a buyer of this pool"))
        XCTAssertEqual(unknown, .refused("Request channel is not on-chain yet; retry shortly"))
        XCTAssertEqual(untrusted, .refused("No trusted Channels contract"))
        XCTAssertEqual(noRPC, .refused("No RPC"), "a signed binding without on-chain proof never gets full inference")
    }

    func testPoolChecksAreSmallAndRateLimited() async {
        let gate = RequestGate(checksPerHour: 2)
        let large = await gate.admit(buyer: nil, channel: nil, bodyBytes: RequestGate.checkBodyBytes + 1, requestedMaxTokens: 512, check: .unavailable("No RPC"))
        XCTAssertEqual(large, .refused("Check request too large"), "a large unsigned prompt never reaches the model")
        let zero = await gate.admit(buyer: buyer, channel: zeroChannel, bodyBytes: 10 * 1024 * 1024, requestedMaxTokens: 512, check: .unavailable("No RPC"))
        XCTAssertEqual(zero, .refused("Check request too large"), "the zero channel is a pool check too")
        let first = await gate.admit(buyer: nil, channel: nil, bodyBytes: 200, requestedMaxTokens: 512, check: .unavailable("No RPC"))
        let second = await gate.admit(buyer: nil, channel: nil, bodyBytes: 200, requestedMaxTokens: 4, check: .unavailable("No RPC"))
        let third = await gate.admit(buyer: nil, channel: nil, bodyBytes: 200, requestedMaxTokens: 4, check: .unavailable("No RPC"))
        XCTAssertEqual(first, .check(maxTokens: RequestGate.checkMaxTokens))
        XCTAssertEqual(second, .check(maxTokens: 4))
        XCTAssertEqual(third, .refused("Check rate limit exceeded"))
    }

    func testPoolCheckBudgetIsAlwaysPositive() async {
        let gate = RequestGate(checksPerHour: 10)
        for requested in [-5, 0, 1] {
            let admission = await gate.admit(buyer: nil, channel: nil, bodyBytes: 200, requestedMaxTokens: requested, check: .unavailable("No RPC"))
            XCTAssertEqual(admission, .check(maxTokens: 1), "max_tokens \(requested) runs one token, never a negative budget")
        }
        let huge = await gate.admit(buyer: nil, channel: nil, bodyBytes: 200, requestedMaxTokens: Int.max, check: .unavailable("No RPC"))
        XCTAssertEqual(huge, .check(maxTokens: RequestGate.checkMaxTokens))
    }

    func testServesABuyerRequestOnceBeforeItExpires() {
        let gate = RequestGate()
        let now = Date(timeIntervalSince1970: 1_000_000)
        let binding = Data(repeating: 0xab, count: 32)
        XCTAssertNil(gate.claimOnce(binding: binding, expires: now.addingTimeInterval(600), now: now))
        XCTAssertEqual(gate.claimOnce(binding: binding, expires: now.addingTimeInterval(600), now: now), "Request was already served")
        XCTAssertEqual(gate.claimOnce(binding: Data(repeating: 1, count: 32), expires: now.addingTimeInterval(-1), now: now), "Request has expired")
        XCTAssertEqual(gate.claimOnce(binding: Data(repeating: 2, count: 32), expires: now.addingTimeInterval(86_400), now: now), "Request expiry is too far ahead")
    }

    func testPoolSilenceTriggersReconnect() {
        let start = Date(timeIntervalSince1970: 1_000)
        var liveness = PoolLiveness(now: start)
        XCTAssertFalse(liveness.isSilent(now: start.addingTimeInterval(44)))
        XCTAssertTrue(liveness.isSilent(now: start.addingTimeInterval(45)), "45 s without a message or pong is a dead connection")
        liveness.heard(at: start.addingTimeInterval(40))
        XCTAssertFalse(liveness.isSilent(now: start.addingTimeInterval(80)), "a pong or message restarts the deadline")
        XCTAssertTrue(liveness.isSilent(now: start.addingTimeInterval(85)))
    }

    func testTrustedChannelsNeverComeFromThePool() {
        XCTAssertEqual(TrustedChannels.address(chainId: 8453, override: nil), "0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d")
        XCTAssertEqual(TrustedChannels.address(chainId: 84532, override: nil), "0x3b0b94AC27C042CAC17103A897Fb5cEb7D8b4cf7")
        XCTAssertNil(TrustedChannels.address(chainId: 31337, override: nil), "a local chain needs --channels")
        XCTAssertEqual(TrustedChannels.address(chainId: 31337, override: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853"), "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853")
    }

    func testChannelsAreCheckedByDefault() {
        // No --rpc still means a verifying worker: Base mainnet's public RPC.
        XCTAssertEqual(WorkerConfig.fromCommandLine(["app"]).rpcURL?.absoluteString, GeneratedContractAddresses.defaultRPC)
        XCTAssertEqual(WorkerConfig.fromCommandLine(["app", "--rpc", "http://127.0.0.1:8545"]).rpcURL?.absoluteString, "http://127.0.0.1:8545")
    }
}

/// Opens once; waiters before and after continue.
actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
}

final class LocalModelParsingTests: XCTestCase {
    func testPullFractionReadsProgressLinesOnly() {
        XCTAssertEqual(LocalModel.pullFraction("  0.80 of 1.60 GiB, 35.2 MiB/s"), 0.5)
        XCTAssertNil(LocalModel.pullFraction("  config.json: 0.00 MiB"))
        XCTAssertNil(LocalModel.pullFraction("stored repo at /path"))
    }

    func testParseEventReadsContentRateAndUsage() throws {
        let chunk = try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}"#))
        XCTAssertEqual(chunk.content, "Hi")
        let finish = try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[{"delta":{},"finish_reason":"stop"}],"tensorfold":{"tokens_per_second":140.5}}"#))
        XCTAssertEqual(finish.tokensPerSecond, 140.5)
        XCTAssertEqual(finish.finishReason, "stop")
        let usage = try XCTUnwrap(EngineChat.parseEvent(#"data: {"choices":[],"usage":{"prompt_tokens":26,"completion_tokens":10}}"#)?.usage)
        XCTAssertEqual(usage.prompt, 26)
        XCTAssertEqual(usage.completion, 10)
        XCTAssertNil(EngineChat.parseEvent("data: [DONE]"))
        XCTAssertNil(EngineChat.parseEvent(""))
    }
}

final class LocalModelLifecycleTests: XCTestCase {
    /// Quitting mid-download stops the download, not only a started server.
    func testStopEngineStopsAModelDownload() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        // A stand-in engine whose `pull` never finishes: `yes pull MODEL` runs until stopped.
        let engine = directory.appendingPathComponent("engine")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/yes"), to: engine)
        let model = LocalModel(modelId: "test/model", engine: engine, directory: directory)
        let loading = Task { try await model.load { _ in } }

        let pidFile = directory.appendingPathComponent("engine.pid")
        var pid: pid_t = 0
        for _ in 0..<100 where pid == 0 {
            pid = (try? String(contentsOf: pidFile, encoding: .utf8)).flatMap { pid_t($0) } ?? 0
            if pid == 0 { try await Task.sleep(nanoseconds: 50_000_000) }
        }
        XCTAssertGreaterThan(pid, 0, "the download's PID is recorded")

        LocalModel.stopEngine(in: directory, engine: engine)
        do {
            try await loading.value
            XCTFail("a stopped download does not finish loading")
        } catch {}
        XCTAssertNotEqual(kill(pid, 0), 0, "the download process is gone")
    }
}
