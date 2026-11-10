import Foundation

/// Payment for this worker's earlier answers on a channel, checked before it
/// serves the next one there (docs/protocol/colony-pool.md, "Paid before
/// served"); the same rules as `worker-payment.ts` in @antseed/node.
///
/// A buyer's request carries its latest SpendingAuth on the channel (`pay`).
/// The worker checks that the channel's buyer signed it for the trusted
/// Channels contract, that the on-chain reserve covers it, and that what it
/// attributes to this worker pays for the worker's earlier answers there at the
/// prices the pool declared. Amounts are USDC base units; past UInt64 they
/// saturate, which no real reserve reaches.
enum WorkerPayment {
    /// Answers on one channel served before they are paid, the one being admitted included.
    static let maxUnpaidAnswers = 2

    struct Proof {
        /// uint256, big-endian.
        let cumulativeAmount: [UInt8]
        let metadata: Data
        let signature: Data
    }

    /// A service's token prices, USD per million, as the pool's welcome declares them.
    struct Price: Equatable {
        let input: Double
        let output: Double
        let cachedInput: Double?

        init(input: Double, output: Double, cachedInput: Double? = nil) {
            self.input = input
            self.output = output
            self.cachedInput = cachedInput
        }

        init?(_ value: Any?) {
            guard let fields = value as? [String: Any],
                  let input = (fields["inputUsdPerMillion"] as? NSNumber)?.doubleValue,
                  let output = (fields["outputUsdPerMillion"] as? NSNumber)?.doubleValue,
                  input.isFinite, output.isFinite, input >= 0, output >= 0 else { return nil }
            let cached = (fields["cachedInputUsdPerMillion"] as? NSNumber)?.doubleValue
            if let cached, !cached.isFinite || cached < 0 { return nil }
            self.init(input: input, output: output, cachedInput: cached)
        }
    }

    enum Failure: Error, LocalizedError {
        case notTheBuyer, beyondReserve
        var errorDescription: String? {
            switch self {
            case .notTheBuyer: "The payment is not signed by the channel's buyer"
            case .beyondReserve: "The payment exceeds the channel's reserve"
            }
        }
    }

    /// The envelope's `pay`, or nil when it is absent or malformed.
    static func parse(_ value: Any?) -> Proof? {
        guard let fields = value as? [String: Any],
              let amount = fields["cumulativeAmount"] as? String, let cumulative = uint256(decimal: amount),
              let metadataHex = fields["metadata"] as? String, metadataHex.hasPrefix("0x"), let metadata = try? Data(hexString: metadataHex),
              let signatureHex = fields["signature"] as? String, let signature = try? Data(hexString: signatureHex), signature.count == 65
        else { return nil }
        return Proof(cumulativeAmount: cumulative, metadata: metadata, signature: signature)
    }

    /// What `proof` attributes to `worker` on `channel`, once it is `buyer`'s
    /// SpendingAuth for that channel on the Channels contract `channels` of
    /// chain `chainId`, and within `deposit` (the channel's on-chain reserve).
    static func attributed(_ proof: Proof, channel: String, buyer: String, worker: String, deposit: UInt64, chainId: UInt64, channels: String) throws -> UInt64 {
        let digest = try spendingAuthDigest(channel: Data(hexString: channel), cumulativeAmount: proof.cumulativeAmount,
                                            metadata: proof.metadata, chainId: chainId, channels: Data(hexString: channels))
        guard let signer = try? recoverAddress(digest: digest, signature: proof.signature),
              signer.lowercased() == buyer.lowercased() else { throw Failure.notTheBuyer }
        guard saturating(proof.cumulativeAmount) <= deposit else { throw Failure.beyondReserve }
        return attributedAmount(metadata: proof.metadata, worker: worker) ?? 0
    }

    /// The EIP-712 digest AntseedChannels verifies a SpendingAuth against.
    static func spendingAuthDigest(channel: Data, cumulativeAmount: [UInt8], metadata: Data, chainId: UInt64, channels: Data) -> [UInt8] {
        let domainType = keccak256(Array("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)".utf8))
        let domain = keccak256(domainType + keccak256(Array("AntseedChannels".utf8)) + keccak256(Array("1".utf8))
            + word(chainId) + [UInt8](repeating: 0, count: 12) + Array(channels))
        let authType = keccak256(Array("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)".utf8))
        let auth = keccak256(authType + Array(channel) + cumulativeAmount + keccak256(metadata))
        return keccak256([0x19, 0x01] + domain + auth)
    }

    /// `worker`'s cumulative amount in the metadata's worker-attribution tail,
    /// read by the rules AntseedColonyPool applies: nil for a malformed tail,
    /// and for a worker it doesn't name.
    static func attributedAmount(metadata: Data, worker: String) -> UInt64? {
        let bytes = [UInt8](metadata)
        let headBytes = 256, trailerBytes = 33, entryBytes = 36
        guard bytes.count >= headBytes + trailerBytes,
              Array(bytes.suffix(32)) == keccak256(Array("antseed:worker-attribution:v1".utf8)) else { return nil }
        let count = Int(bytes[bytes.count - trailerBytes])
        guard (1...8).contains(count), bytes.count >= headBytes + trailerBytes + count * entryBytes else { return nil }
        let start = bytes.count - trailerBytes - count * entryBytes
        guard let wanted = try? [UInt8](Data(hexString: worker)), wanted.count == 20 else { return nil }
        var previous = [UInt8](repeating: 0, count: 20)
        var found: UInt64?
        for i in 0..<count {
            let offset = start + i * entryBytes
            let address = Array(bytes[offset..<(offset + 20)])
            // Strictly ascending, never zero: anything else is not a tail at all.
            guard previous.lexicographicallyPrecedes(address) else { return nil }
            previous = address
            if address == wanted { found = saturating(Array(bytes[(offset + 20)..<(offset + entryBytes)])) }
        }
        return found
    }

    /// USDC base units an answer costs at `price`: the buyer's own formula (computeCostUsdc).
    static func cost(promptTokens: Int, cachedTokens: Int = 0, completionTokens: Int, price: Price) -> UInt64 {
        let fresh = Double(max(0, promptTokens - cachedTokens))
        let usd = (fresh * price.input + Double(cachedTokens) * (price.cachedInput ?? price.input) + Double(completionTokens) * price.output) / 1_000_000
        let units = (usd * 1_000_000).rounded(.toNearestOrAwayFromZero)
        return units > 0 ? (units >= Double(UInt64.max) ? .max : UInt64(units)) : 0
    }

    /// A decimal string as a big-endian uint256; nil when it isn't one.
    static func uint256(decimal: String) -> [UInt8]? {
        guard !decimal.isEmpty, decimal.count <= 78, decimal.allSatisfy(\.isASCII), decimal.allSatisfy(\.isNumber) else { return nil }
        var value = [UInt8](repeating: 0, count: 32)
        for digit in decimal.utf8 {
            var carry = Int(digit - 48)
            for i in stride(from: 31, through: 0, by: -1) {
                let next = Int(value[i]) * 10 + carry
                value[i] = UInt8(next & 0xff)
                carry = next >> 8
            }
            if carry != 0 { return nil }
        }
        return value
    }

    /// A big-endian unsigned integer as UInt64, saturating.
    static func saturating(_ bigEndian: [UInt8]) -> UInt64 {
        let significant = bigEndian.drop { $0 == 0 }
        guard significant.count <= 8 else { return .max }
        return significant.reduce(0) { ($0 << 8) | UInt64($1) }
    }

    private static func word(_ value: UInt64) -> [UInt8] {
        [UInt8](repeating: 0, count: 24) + (0..<8).reversed().map { UInt8(truncatingIfNeeded: value >> ($0 * 8)) }
    }
}

/// What each channel owes this worker for its answers, and has paid. `admit`
/// before serving, then `served` with the answer's cost, or `released` when no
/// answer reached the buyer. In memory: a restarted app starts every channel afresh.
@MainActor
final class WorkerPaymentLedger {
    private struct Account {
        /// The most a buyer-signed payment attributed to this worker (a lower, older one never lowers it).
        var paid: UInt64 = 0
        /// Costs of answers served, oldest first, not yet covered by `paid`.
        var owed: [UInt64] = []
        /// Cost of every answer served before `owed`.
        var settledCost: UInt64 = 0
        /// Requests admitted and still running.
        var running = 0
    }

    private static let maxChannels = 10_000
    private var accounts: [String: Account] = [:]
    private var order: [String] = []

    /// nil when a request on `channel`, whose payment attributes `attributed` to
    /// this worker, may be served; else why not.
    func admit(channel: String, attributed: UInt64) -> String? {
        let key = channel.lowercased()
        if accounts[key] == nil {
            if accounts.count >= Self.maxChannels, let oldest = order.first {
                order.removeFirst()
                accounts.removeValue(forKey: oldest)
            }
            accounts[key] = Account()
            order.append(key)
        }
        var account = accounts[key]!
        account.paid = max(account.paid, attributed)
        // Answers paid for leave `owed`, oldest first.
        while let first = account.owed.first {
            let (settled, overflow) = account.settledCost.addingReportingOverflow(first)
            guard !overflow, settled <= account.paid else { break }
            account.settledCost = settled
            account.owed.removeFirst()
        }
        guard account.owed.count + account.running + 1 <= WorkerPayment.maxUnpaidAnswers else {
            accounts[key] = account
            return "Payment for this worker's earlier answers on this channel has not arrived (\(account.owed.count) unpaid); retry once it is signed"
        }
        account.running += 1
        accounts[key] = account
        return nil
    }

    /// The admitted request on `channel` delivered an answer costing `cost`.
    func served(channel: String, cost: UInt64) {
        let key = channel.lowercased()
        guard var account = accounts[key] else { return }
        account.running = max(0, account.running - 1)
        account.owed.append(cost)
        accounts[key] = account
    }

    /// The admitted request on `channel` ended without an answer to pay for.
    func released(channel: String) {
        let key = channel.lowercased()
        guard var account = accounts[key] else { return }
        account.running = max(0, account.running - 1)
        accounts[key] = account
    }
}
