import XCTest
@testable import AntseedMacWorker

/// Answers every `eth_call` (single or batched) by its function: `answers` maps a selector's hex
/// to the result for the call's arguments (hex, no prefix); a function not listed reads as zero.
private final class StubPoolRPC: URLProtocol {
    nonisolated(unsafe) static var answers: [String: (String) -> String] = [:]
    /// Every call is answered with an error, as an RPC that is down does.
    nonisolated(unsafe) static var failing = false

    static func on(_ signature: String, _ answer: @escaping (String) -> String) {
        answers[Chain.selector(signature).hex] = answer
    }

    static func word(_ value: UInt64) -> String { Data(abiWord(value)).hex }
    static func word(address: String) -> String { String(repeating: "0", count: 24) + String(address.dropFirst(2)) }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let json = try? JSONSerialization.jsonObject(with: Self.body(of: request))
        var answer: Any = ["jsonrpc": "2.0", "id": 1, "error": ["code": -32600, "message": "bad request"]]
        if let batch = json as? [[String: Any]] {
            answer = batch.map(Self.answer)
        } else if let call = json as? [String: Any] {
            answer = Self.answer(call)
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: (try? JSONSerialization.data(withJSONObject: answer)) ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func answer(_ call: [String: Any]) -> [String: Any] {
        let data = ((call["params"] as? [Any])?.first as? [String: Any])?["data"] as? String ?? "0x"
        if failing { return ["jsonrpc": "2.0", "id": call["id"] ?? 1, "error": ["code": -32000, "message": "down"]] }
        let calldata = String(data.dropFirst(2))
        let result = answers[String(calldata.prefix(8))]?(String(calldata.dropFirst(8))) ?? word(0)
        return ["jsonrpc": "2.0", "id": call["id"] ?? 1, "result": "0x" + result]
    }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

final class RewardsTests: XCTestCase {
    private let pool = "0x2000000000000000000000000000000000000002"
    private let wallet = "0x3000000000000000000000000000000000000003"
    private let worker = "0x4000000000000000000000000000000000000004"
    private let other = "0x5000000000000000000000000000000000000005"

    private let rpc = URL(string: "https://pool.test/")!

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubPoolRPC.self]
        return URLSession(configuration: configuration)
    }

    private func chain() -> Chain { Chain(rpcURLs: [rpc], timeout: 2, session: session()) }

    /// The epoch a call names in its last argument word.
    private static func epoch(_ arguments: String) -> UInt64 { UInt64(arguments.suffix(16), radix: 16) ?? .max }

    /// A pool three epochs in that can send ANTS, where nobody has weight or USDC, and `other` takes
    /// the 10% operator fee and the remainder.
    override func setUp() {
        let other = other
        StubPoolRPC.answers = [:]
        StubPoolRPC.failing = false
        StubPoolRPC.on("currentEpoch()") { _ in StubPoolRPC.word(3) }
        StubPoolRPC.on("antsTransferable()") { _ in StubPoolRPC.word(1) }
        StubPoolRPC.on("operatorFeeBps()") { _ in StubPoolRPC.word(1_000) }
        StubPoolRPC.on("operatorFeeRecipient()") { _ in StubPoolRPC.word(address: other) }
        StubPoolRPC.on("remainderRecipient()") { _ in StubPoolRPC.word(address: other) }
    }

    /// The emissions contract holds a seller reward (and no buyer reward) for the pool in `epochs`.
    private func rewarded(_ epochs: Set<UInt64>) {
        StubPoolRPC.on("pendingEmissions(address,uint256[])") { arguments in
            StubPoolRPC.word(epochs.contains(RewardsTests.epoch(arguments)) ? 7 : 0) + StubPoolRPC.word(0)
        }
    }

    func testCountsAndPullsWhatThePoolOwesAnOperatorFeeWalletWithNoWeight() async throws {
        let wallet = wallet
        StubPoolRPC.on("operatorFeeRecipient()") { _ in StubPoolRPC.word(address: wallet) }
        // The wallet's fee of pulls so far; the worker key is owed its own, which only it can claim.
        StubPoolRPC.on("antsOwed(address)") { arguments in StubPoolRPC.word(arguments.hasSuffix(String(wallet.dropFirst(2))) ? 5 : 9) }
        rewarded([1])

        let rewards = try await chain().colonyRewards(pool: pool, account: wallet)
        XCTAssertEqual(rewards.usdc, 0)
        XCTAssertEqual(rewards.outrightAnts, 5)
        XCTAssertEqual(rewards.ants, 5, "the outright balance is claimable ANTS")
        XCTAssertEqual(rewards.antsEpochs, [])
        XCTAssertEqual(rewards.unpulledEpochs, [1], "a pull of the rewarded epoch pays the fee")
        XCTAssertFalse(rewards.isEmpty)

        let key = try await chain().colonyRewards(pool: pool, account: worker)
        XCTAssertEqual(key.outrightAnts, 9)
        XCTAssertEqual(key.unpulledEpochs, [], "a pull credits the key nothing")
        let merged = rewards.adding(worker: key)
        XCTAssertEqual(merged.ants, 5)
        XCTAssertEqual(merged.outrightAnts, 5)
    }

    func testTheRemainderRecipientPullsOnlyTheEpochsNobodyEarnedIn() async throws {
        let wallet = wallet
        StubPoolRPC.on("remainderRecipient()") { _ in StubPoolRPC.word(address: wallet) }
        rewarded([0, 2])
        StubPoolRPC.on("epochTotalWeight(uint256)") { arguments in StubPoolRPC.word(RewardsTests.epoch(arguments) == 0 ? 10 : 0) }

        let rewards = try await chain().colonyRewards(pool: pool, account: wallet)
        XCTAssertEqual(rewards.unpulledEpochs, [2])
        XCTAssertEqual(rewards.ants, 0)
    }

    /// The rewards page pulls the pool's ANTS and reads the claim again: a read that failed must
    /// say so, or the page takes the earlier claim for what is left and reports the claim done.
    @MainActor
    func testTheRewardsPageIsToldWhenTheClaimCouldNotBeReadAgain() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var config = WorkerConfig()
        config.rpcURLs = [rpc]
        config.dataDirectory = directory
        let keys = try WorkerKeys.loadOrCreate(in: directory, keychain: false)
        let pool = pool
        let payouts = WorkerPayoutController(config: config, keys: keys, log: { _ in }, session: session())
        let api = ColonyPayAPI(config: config, payouts: payouts, workerAddress: keys.ethereum.address, pool: { pool }, chainId: { 31337 }, channels: { nil })
        let read = PayServer.Request(method: "GET", path: "/api/colony", headers: [:], body: Data())
        func state() async throws -> [String: Any] {
            let body = await api.handle(read).body
            return try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        }
        rewarded([1])
        StubPoolRPC.on("antsOwed(address)") { _ in StubPoolRPC.word(5) }

        let first = try await state()
        XCTAssertEqual(first["claimFresh"] as? Bool, true)
        XCTAssertEqual((first["claim"] as? [String: Any])?["outrightAnts"] as? String, "5")

        StubPoolRPC.failing = true
        let second = try await state()
        XCTAssertEqual(second["claimFresh"] as? Bool, false)
        XCTAssertEqual((second["claim"] as? [String: Any])?["outrightAnts"] as? String, "5", "the last read is still shown")

        StubPoolRPC.failing = false
        let third = try await state()
        XCTAssertEqual(third["claimFresh"] as? Bool, true)
    }

    func testAFeeRecipientOfAPoolWithNoFeePullsNothing() async throws {
        let wallet = wallet
        StubPoolRPC.on("operatorFeeBps()") { _ in StubPoolRPC.word(0) }
        StubPoolRPC.on("operatorFeeRecipient()") { _ in StubPoolRPC.word(address: wallet) }
        rewarded([1])

        let rewards = try await chain().colonyRewards(pool: pool, account: wallet)
        XCTAssertEqual(rewards.unpulledEpochs, [])
        XCTAssertTrue(rewards.isEmpty)
    }
}
