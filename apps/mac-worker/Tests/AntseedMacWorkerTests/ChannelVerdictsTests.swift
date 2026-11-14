import XCTest
@testable import AntseedMacWorker

@MainActor
final class ChannelVerdictsTests: XCTestCase {
    private let channel = "0x" + String(repeating: "ab", count: 32)
    private let buyer = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
    private let intruder = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc"

    func testChannelNotOnChainIsNeverVerified() async {
        var lookups = 0
        let verdicts = ChannelVerdicts(wait: 0.05, pollInterval: 0.02) { _, _ in lookups += 1; return nil }
        for _ in 0..<3 {
            let verdict = await verdicts.verdict(channel: channel, buyer: buyer)
            XCTAssertNil(verdict)
        }
        // Each request looks again: it may have appeared since.
        XCTAssertGreaterThanOrEqual(lookups, 3)
    }

    func testRefusedFromTheFirstRequestAndCached() async {
        var lookups = 0
        let verdicts = ChannelVerdicts { _, _ in lookups += 1; return false }
        let first = await verdicts.verdict(channel: channel, buyer: buyer)
        let second = await verdicts.verdict(channel: channel, buyer: buyer)
        XCTAssertEqual(first, false)
        XCTAssertEqual(second, false)
        XCTAssertEqual(lookups, 1)
    }

    func testVerifiedChannelServesOnlyItsBuyer() async {
        var lookups: [String] = []
        let verdicts = ChannelVerdicts { _, from in lookups.append(from); return from == self.buyer }
        let first = await verdicts.verdict(channel: channel, buyer: buyer.uppercased().replacingOccurrences(of: "0X", with: "0x"))
        let other = await verdicts.verdict(channel: channel, buyer: intruder)
        XCTAssertEqual(first, true)
        XCTAssertEqual(other, false)
        XCTAssertEqual(lookups, [buyer])
    }

    func testFailingLookupEndsWithinTheWait() async {
        struct Down: Error {}
        let failing = ChannelVerdicts(wait: 0.05, pollInterval: 0.02) { _, _ in throw Down() }
        let verdict = await failing.verdict(channel: channel, buyer: buyer)
        XCTAssertNil(verdict)
    }

    func testFreshReserveIsWaitedForWithOneSharedLookup() async {
        var lookups = 0
        let verdicts = ChannelVerdicts(wait: 2, pollInterval: 0.05) { _, _ in lookups += 1; return lookups < 2 ? nil : true }
        async let a = verdicts.verdict(channel: channel, buyer: buyer)
        async let b = verdicts.verdict(channel: channel, buyer: buyer)
        let results = await [a, b]
        XCTAssertEqual(results, [true, true])
        XCTAssertEqual(lookups, 2)
    }

    func testEveryRequestRereadsAVerifiedChannelAndAClosedOneStopsAtOnce() async {
        var active = true
        var lookups = 0
        let verdicts = ChannelVerdicts { _, _ in lookups += 1; return active }
        let first = await verdicts.verdict(channel: channel, buyer: buyer)
        let second = await verdicts.verdict(channel: channel, buyer: buyer)
        XCTAssertEqual([first, second], [true, true])
        XCTAssertEqual(lookups, 2)
        active = false // the buyer closes the channel
        let closed = await verdicts.verdict(channel: channel, buyer: buyer)
        XCTAssertEqual(closed, false)
        XCTAssertEqual(lookups, 3)
        // Closed for good: refused without another read.
        let later = await verdicts.verdict(channel: channel, buyer: buyer)
        XCTAssertEqual(later, false)
        XCTAssertEqual(lookups, 3)
    }

    func testConcurrentRequestsShareOneRead() async {
        var lookups = 0
        let verdicts = ChannelVerdicts { _, _ in
            lookups += 1
            try await Task.sleep(nanoseconds: 50_000_000)
            return true
        }
        async let a = verdicts.verdict(channel: channel, buyer: buyer)
        async let b = verdicts.verdict(channel: channel, buyer: buyer)
        async let c = verdicts.verdict(channel: channel, buyer: buyer)
        let results = await [a, b, c]
        XCTAssertEqual(results, [true, true, true])
        XCTAssertEqual(lookups, 1)
        // Another buyer is refused without a read.
        let other = await verdicts.verdict(channel: channel, buyer: intruder)
        XCTAssertEqual(other, false)
        XCTAssertEqual(lookups, 1)
    }

    func testVerificationIsReportedOnce() async {
        var reports = 0
        let verdicts = ChannelVerdicts { _, _ in true }
        verdicts.onVerdict = { _, _, _ in reports += 1 }
        for _ in 0..<3 { _ = await verdicts.verdict(channel: channel, buyer: buyer) }
        XCTAssertEqual(reports, 1)
    }
}

/// The `channels(bytes32)` getter as AntseedChannels returns it.
final class ChannelRecordTests: XCTestCase {
    private let buyer = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"
    private let pool = "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0"

    private func record(buyer: String, seller: String, status: UInt8) -> Data {
        func address(_ hex: String) -> [UInt8] { [UInt8](repeating: 0, count: 12) + [UInt8](try! Data(hexString: hex)) }
        var words = address(buyer) + address(seller)
        words += [UInt8](repeating: 0, count: 6 * 32) // deposit … closeRequestedAt
        words += [UInt8](repeating: 0, count: 31) + [status]
        return Data(words)
    }

    func testOnlyAnActiveChannelOfTheBuyerAndPoolVerifies() {
        XCTAssertEqual(Chain.channelVerdict(record(buyer: buyer, seller: pool, status: 1), buyer: buyer.uppercased().replacingOccurrences(of: "0X", with: "0x"), pool: pool), true)
        XCTAssertEqual(Chain.channelVerdict(record(buyer: buyer, seller: buyer, status: 1), buyer: buyer, pool: pool), false)
    }

    func testClosedChannelIsRefusedOnTheFirstLookup() {
        // Settled (2) and TimedOut (3) keep buyer and seller on-chain.
        XCTAssertEqual(Chain.channelVerdict(record(buyer: buyer, seller: pool, status: 2), buyer: buyer, pool: pool), false)
        // Closed, but this buyer's channel with the pool: its account can be retired.
        XCTAssertEqual(Chain.channelVerdict(record(buyer: buyer, seller: pool, status: 2), buyer: buyer, pool: pool, anyStatus: true), true)
        XCTAssertEqual(Chain.channelVerdict(record(buyer: buyer, seller: buyer, status: 2), buyer: buyer, pool: pool, anyStatus: true), false)
        XCTAssertEqual(Chain.channelVerdict(record(buyer: buyer, seller: pool, status: 3), buyer: buyer, pool: pool), false)
    }

    func testMissingChannelIsUnknown() {
        XCTAssertNil(Chain.channelVerdict(record(buyer: "0x" + String(repeating: "0", count: 40), seller: "0x" + String(repeating: "0", count: 40), status: 0), buyer: buyer, pool: pool))
        XCTAssertNil(Chain.channelVerdict(Data(count: 64), buyer: buyer, pool: pool))
    }
}
