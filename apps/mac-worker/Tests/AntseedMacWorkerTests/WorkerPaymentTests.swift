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
    func testAnswersThatCostNothingNeedAPaymentThatGrewAfterThem() {
        let ledger = WorkerPaymentLedger()
        for _ in 0..<WorkerPayment.maxUnpaidAnswers {
            XCTAssertNil(ledger.admit(channel: channel, attributed: 0))
            ledger.served(channel: channel, cost: 0)
        }
        XCTAssertNotNil(ledger.admit(channel: channel, attributed: 0))
        XCTAssertNil(ledger.admit(channel: channel, attributed: 1))
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
}
