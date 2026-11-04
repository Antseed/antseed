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
}
