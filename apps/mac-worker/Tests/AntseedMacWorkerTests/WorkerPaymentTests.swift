import XCTest
@testable import AntseedMacWorker

/// Vectors from @antseed/node (`signTestWorkerPayment`, `computeCostUsdc`): the Mac
/// app must verify and price buyers' payments exactly as the TypeScript worker does.
final class WorkerPaymentTests: XCTestCase {
    private let buyer = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"
    private let worker = "0x1000000000000000000000000000000000000001"
    private let channel = "0x" + String(repeating: "ab", count: 32)
    private let channels = "0x3000000000000000000000000000000000000003"
    private let metadata = "0x" + String(repeating: "00", count: 256)
        + "10000000000000000000000000000000000000010000000000000000000000000001e24001"
        + "8648a71dd010296ef21e85b13e8b14728f74bae957239f6c65e28db02dfe64e0"
    private let signature = "0x8f5b609de6b15d394f895052309c18398c3e293d887924f8bbaa6bb5925e086463b2cd802ea891c54389449b5fbc6ffcb68369de289e67324f5a3419f8f8195e1c"

    private var proof: WorkerPayment.Proof {
        WorkerPayment.parse(["cumulativeAmount": "123456", "metadata": metadata, "signature": signature])!
    }

    func testVerifiesABuyersSpendingAuthAndReadsThisWorkersAmount() throws {
        let digest = WorkerPayment.spendingAuthDigest(channel: try Data(hexString: channel), cumulativeAmount: proof.cumulativeAmount,
                                                      metadata: proof.metadata, chainId: 8453, channels: try Data(hexString: channels))
        XCTAssertEqual(Data(digest).prefixedHex, "0x3d775e335cb7f3207eea466721d0e5ac73da0b383768ead8119b71de2bbeaa65")
        XCTAssertEqual(try WorkerPayment.attributed(proof, channel: channel, buyer: buyer, worker: worker, deposit: 1_000_000, chainId: 8453, channels: channels), 123_456)
        // Attributed only to another worker: nothing for this one.
        XCTAssertEqual(try WorkerPayment.attributed(proof, channel: channel, buyer: buyer, worker: "0x2000000000000000000000000000000000000002", deposit: 1_000_000, chainId: 8453, channels: channels), 0)
    }

    func testRefusesAPaymentFromAnotherSignerContractOrChainAndOneBeyondTheReserve() {
        let other = "0x2000000000000000000000000000000000000002"
        XCTAssertThrowsError(try WorkerPayment.attributed(proof, channel: channel, buyer: other, worker: worker, deposit: 1_000_000, chainId: 8453, channels: channels))
        XCTAssertThrowsError(try WorkerPayment.attributed(proof, channel: channel, buyer: buyer, worker: worker, deposit: 1_000_000, chainId: 8453, channels: other))
        XCTAssertThrowsError(try WorkerPayment.attributed(proof, channel: channel, buyer: buyer, worker: worker, deposit: 1_000_000, chainId: 1, channels: channels))
        XCTAssertThrowsError(try WorkerPayment.attributed(proof, channel: "0x" + String(repeating: "cd", count: 32), buyer: buyer, worker: worker, deposit: 1_000_000, chainId: 8453, channels: channels))
        XCTAssertThrowsError(try WorkerPayment.attributed(proof, channel: channel, buyer: buyer, worker: worker, deposit: 123_455, chainId: 8453, channels: channels))
    }

    /// A signed vector: `tail` after the 256-byte zero head, authorizing `cumulative`.
    private func signed(_ cumulative: String, tail: String, signature: String) -> WorkerPayment.Proof {
        WorkerPayment.parse(["cumulativeAmount": cumulative, "metadata": "0x" + String(repeating: "00", count: 256) + tail, "signature": signature])!
    }

    func testRefusesAttributionThePaymentDoesNotFund() throws {
        let check = { (proof: WorkerPayment.Proof) in
            try WorkerPayment.attributed(proof, channel: self.channel, buyer: self.buyer, worker: self.worker, deposit: 1_000_000, chainId: 8453, channels: self.channels)
        }
        // 1,000,000 attributed on an authorization of 1.
        XCTAssertThrowsError(try check(signed("1",
            tail: "1000000000000000000000000000000000000001000000000000000000000000000f4240018648a71dd010296ef21e85b13e8b14728f74bae957239f6c65e28db02dfe64e0",
            signature: "0x795d065f963f99bf55e2a24e2911b8fb5df1418d41e636ed8efd6505f395e64a26660e679225f216273c0aa44e8a7dc05a5705bef6e0b0262ab1d8bceb4613f81c")))
        // 30,000 to each of two workers on an authorization of 50,000.
        XCTAssertThrowsError(try check(signed("50000",
            tail: "100000000000000000000000000000000000000100000000000000000000000000007530200000000000000000000000000000000000000200000000000000000000000000007530028648a71dd010296ef21e85b13e8b14728f74bae957239f6c65e28db02dfe64e0",
            signature: "0x4be5c9ae3e22afd585ee71a3a78a77ba8b27dd407d14f4ec1dfd7dd1d758af39536d407243917d0f1bfd7dad378aecf19979cdda30dd8c576f09f08d5741e8cd1b")))
        // 30,000 and 20,000: exactly what it authorizes.
        XCTAssertEqual(try check(signed("50000",
            tail: "100000000000000000000000000000000000000100000000000000000000000000007530200000000000000000000000000000000000000200000000000000000000000000004e20028648a71dd010296ef21e85b13e8b14728f74bae957239f6c65e28db02dfe64e0",
            signature: "0xb3cf4dc88cf5c77e22f9aa533bab06637c99b10112fbfc130e64f3282b619adb3ba34027f6572ca3535336bb4aa84e6e7f760249696e4867c34a9082c2c945a41b")), 30_000)
    }

    func testServesOnlyPricesThatChargeSomething() {
        XCTAssertFalse(WorkerPayment.Price(input: 0, output: 0, cachedInput: 0).isChargeable)
        XCTAssertTrue(WorkerPayment.Price(input: 0, output: 0.6).isChargeable)
    }

    @MainActor
    func testAnswersWhosePriceRoundsToZeroAreOwedNothing() {
        let ledger = WorkerPaymentLedger()
        // Many such answers, and the buyer's payment never grows: none is owed.
        for _ in 0..<(WorkerPayment.maxUnpaidAnswers * 3) {
            XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
            ledger.served(channel: channel, cost: 0)
        }
        // Priced answers after them are owed as usual.
        for _ in 0..<WorkerPayment.maxUnpaidAnswers {
            XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
            ledger.served(channel: channel, cost: 9_000)
        }
        XCTAssertNotNil(ledger.admit(channel: channel, attributed: 0))
    }

    /// An envelope addressed to `worker`, its binding to `channel` signed by `buyer`.
    private func envelope(channel: [UInt8], buyer: EthereumKey, worker: String) throws -> Data {
        let ct = Data(repeating: 7, count: 32)
        let exp = UInt64(Date().timeIntervalSince1970) + 600
        let expBytes = (0..<8).reversed().map { UInt8(truncatingIfNeeded: exp >> ($0 * 8)) }
        let binding = keccak256(Array(WorkerE2E.info.utf8) + [UInt8](try Data(hexString: worker)) + channel + expBytes + keccak256(ct))
        let signature = try buyer.sign(digest: personalMessageDigest(binding))
        return try JSONSerialization.data(withJSONObject: ["model": "m", "antseed_e2e": [
            "v": WorkerE2E.version, "ct": ct.base64EncodedString(),
            "recipients": [["worker": worker, "epk": Data(repeating: 4, count: 65).base64EncodedString(), "wk": Data(repeating: 1, count: 48).base64EncodedString()]],
            "buyer": buyer.address, "channel": Data(channel).prefixedHex.uppercased().replacingOccurrences(of: "0X", with: "0x"),
            "exp": Int(exp), "sig": signature.prefixedHex,
        ] as [String: Any]])
    }

    func testBindsOnlyA32ByteChannelSoOneChannelNeverHasTwoAccounts() throws {
        let (buyer, _) = try EthereumKey.generate()
        let id = [UInt8](repeating: 0xab, count: 32)
        let bound = try WorkerE2E.inspectRequest(try envelope(channel: id, buyer: buyer, worker: worker), workerAddress: worker)
        // Upper-case hex names the same channel: one canonical, lower-case key.
        XCTAssertEqual(bound.channel, channel)
        XCTAssertNotNil(bound.binding)
        // The same channel with a byte appended, signed by the buyer: the chain would read the first 32 bytes.
        let longer = try WorkerE2E.inspectRequest(try envelope(channel: id + [0], buyer: buyer, worker: worker), workerAddress: worker)
        XCTAssertNil(longer.channel)
        XCTAssertNil(longer.binding)
    }

    func testIgnoresMalformedPayments() {
        XCTAssertNil(WorkerPayment.parse(nil))
        XCTAssertNil(WorkerPayment.parse(["cumulativeAmount": "-1", "metadata": metadata, "signature": signature]))
        XCTAssertNil(WorkerPayment.parse(["cumulativeAmount": "1", "metadata": metadata, "signature": "0x12"]))
        // A tail that isn't strictly ascending is no tail.
        let swapped = "0x" + String(repeating: "00", count: 256)
            + "2000000000000000000000000000000000000002" + "00000000000000000000000000000001"
            + "1000000000000000000000000000000000000001" + "00000000000000000000000000000001" + "02"
            + "8648a71dd010296ef21e85b13e8b14728f74bae957239f6c65e28db02dfe64e0"
        XCTAssertNil(WorkerPayment.attributedAmount(metadata: try! Data(hexString: swapped), worker: worker))
    }

    func testPricesAnAnswerExactlyAsTheBuyerDoes() {
        XCTAssertEqual(WorkerPayment.cost(promptTokens: 1234, cachedTokens: 200, completionTokens: 567,
                                          price: .init(input: 0.15, output: 0.6, cachedInput: 0.075)), 510)
        XCTAssertEqual(WorkerPayment.cost(promptTokens: 5, completionTokens: 1, price: .init(input: 20, output: 80)), 180)
        XCTAssertEqual(WorkerPayment.cost(promptTokens: 8000, completionTokens: 190, price: .init(input: 0.3, output: 1.2)), 2628)
        XCTAssertEqual(WorkerPayment.Price(["inputUsdPerMillion": 20, "outputUsdPerMillion": 80]), .init(input: 20, output: 80))
        XCTAssertNil(WorkerPayment.Price(["inputUsdPerMillion": -1, "outputUsdPerMillion": 80]))
    }

    @MainActor
    func testABuyerThatNeverPaysGetsOnlyTwoAnswersOnAChannelUntilItPays() {
        let ledger = WorkerPaymentLedger()
        for _ in 0..<WorkerPayment.maxUnpaidAnswers {
            XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
            ledger.served(channel: channel, cost: 9_000)
        }
        XCTAssertNotNil(ledger.admit(channel: channel, attributed: 0), "fresh bindings without payment get no more work")
        // Paying for the first answer frees one slot, not more.
        XCTAssertNil(ledger.admit(channel: channel, attributed: 9_000))
        ledger.served(channel: channel, cost: 9_000)
        XCTAssertNotNil(ledger.admit(channel: channel, attributed: 9_000))
        // An older, lower payment replayed later never undoes one already seen.
        XCTAssertNil(ledger.admit(channel: channel, attributed: 27_000))
        ledger.released(channel: channel)
        XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
        // Running requests count too: two at once, not a third.
        XCTAssertNil(ledger.admit(channel: channel, attributed: 27_000))
        XCTAssertNotNil(ledger.admit(channel: channel, attributed: 27_000))
        // Other channels are accounted apart.
        XCTAssertNil(ledger.admit(channel: "0x" + String(repeating: "cd", count: 32), attributed: 0))
    }

    @MainActor
    func testResumesFromItsFileSoARestartNeverLetsAnOldPaymentPayForNewAnswers() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("payments-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let ledger = WorkerPaymentLedger(file: file)
        // Paid 900,000 for 100 answers of 9,000.
        for i in 0..<100 {
            XCTAssertNil(ledger.admit(channel: channel, attributed: UInt64(i) * 9_000, cumulative: UInt64(i) * 9_000))
            ledger.served(channel: channel, cost: 9_000)
        }
        XCTAssertNil(ledger.admit(channel: channel, attributed: 900_000, cumulative: 900_000))
        ledger.served(channel: channel, cost: 9_000)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let restarted = WorkerPaymentLedger(file: file)
        // The same proof again: the answer just served is still owed, so one more and no further.
        XCTAssertNil(restarted.admit(channel: channel, attributed: 900_000, cumulative: 900_000))
        restarted.served(channel: channel, cost: 9_000)
        XCTAssertNotNil(restarted.admit(channel: channel, attributed: 900_000, cumulative: 900_000))
    }

    @MainActor
    func testWhatAForgottenChannelsPaymentAlreadyAttributesPaysOnlyForEarlierAnswers() {
        let ledger = WorkerPaymentLedger()
        for _ in 0..<WorkerPayment.maxUnpaidAnswers {
            XCTAssertNil(ledger.admit(channel: channel, attributed: 900_000, cumulative: 900_000))
            ledger.served(channel: channel, cost: 9_000)
        }
        XCTAssertNotNil(ledger.admit(channel: channel, attributed: 900_000, cumulative: 900_000))
        XCTAssertNil(ledger.admit(channel: channel, attributed: 918_000, cumulative: 918_000))
    }

    @MainActor
    func testRefusesABuyerOnceTheChannelSettledPastAPaymentThatCreditedThisWorkerLess() {
        let ledger = WorkerPaymentLedger()
        XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
        ledger.served(channel: channel, cost: 9_000)
        XCTAssertNil(ledger.admit(channel: channel, attributed: 9_000, cumulative: 10_000))
        // Not settled that far yet: nothing to judge.
        XCTAssertFalse(ledger.reconcile(channel: channel, buyer: buyer, settled: 5_000, credited: 0))
        // Settled past it and credited in full: done with that payment.
        XCTAssertFalse(ledger.reconcile(channel: channel, buyer: buyer, settled: 10_000, credited: 9_000))
        ledger.served(channel: channel, cost: 9_000)
        XCTAssertNil(ledger.admit(channel: channel, attributed: 18_000, cumulative: 20_000))
        // Settled past it with an auth that credits this worker nothing more.
        XCTAssertTrue(ledger.reconcile(channel: channel, buyer: buyer, settled: 20_000, credited: 9_000))
        XCTAssertTrue(ledger.refuses(buyer: buyer.lowercased()))
    }

    @MainActor
    func testNeverQueuesAnAnswerThatCostsNothingEvenBehindAnUnpaidOne() {
        let ledger = WorkerPaymentLedger()
        XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
        ledger.served(channel: channel, cost: 9_000)
        XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
        ledger.served(channel: channel, cost: 0)
        XCTAssertNil(ledger.admit(channel: channel, attributed: 0), "one answer unpaid, so one more may run")
    }

    @MainActor
    func testForgetsAClosedChannel() {
        let ledger = WorkerPaymentLedger()
        for _ in 0..<WorkerPayment.maxUnpaidAnswers {
            XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
            ledger.served(channel: channel, cost: 9_000)
        }
        ledger.forget(channel: channel)
        XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
    }

    @MainActor
    func testMakesRoomPastItsChannelLimitByForgettingAnIdleChannel() {
        let ledger = WorkerPaymentLedger()
        let channelAt = { (i: Int) in "0x" + String(repeating: "0", count: 64 - String(i, radix: 16).count) + String(i, radix: 16) }
        for i in 0..<10_000 {
            XCTAssertNil(ledger.admit(channel: channelAt(i), attributed: 0))
            ledger.served(channel: channelAt(i), cost: 9_000)
        }
        XCTAssertNil(ledger.admit(channel: channelAt(10_000), attributed: 0))
    }
}
