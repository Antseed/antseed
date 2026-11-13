import Foundation

/// Minimal JSON-RPC reads: checking that a request's channel belongs to a
/// buyer of this pool, the chain id the payout authorization is bound to, and
/// the pool's payout records.
struct Chain {
    /// Tried in order: a call that fails on one (unreachable, timed out, rate
    /// limited, an error answer) is sent to the next, so one endpoint failing
    /// doesn't refuse every request.
    let rpcURLs: [URL]
    /// Deadline for each endpoint's answer; nil keeps URLSession's default.
    var timeout: TimeInterval? = nil
    var session: URLSession = .shared

    enum Failure: Error, LocalizedError {
        case rpc(String)
        var errorDescription: String? {
            if case .rpc(let message) = self { return message }
            return nil
        }
    }

    static func selector(_ signature: String) -> Data {
        Data(keccak256(Array(signature.utf8)).prefix(4))
    }

    func call(_ method: String, _ params: [Any]) async throws -> Any {
        let body = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": method, "params": params])
        var lastError: Error = Failure.rpc("No RPC endpoint")
        for url in rpcURLs {
            try Task.checkCancellation()
            do {
                return try await call(url, body)
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    private func call(_ url: URL, _ body: Data) async throws -> Any {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        if let status = (response as? HTTPURLResponse)?.statusCode, !(200..<300).contains(status) {
            throw Failure.rpc("RPC answered HTTP \(status)")
        }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.rpc("Malformed RPC answer") }
        if let error = object["error"] as? [String: Any] { throw Failure.rpc(error["message"] as? String ?? "RPC error") }
        guard let result = object["result"] else { throw Failure.rpc("Malformed RPC answer") }
        return result
    }

    func ethCall(to: String, data: Data) async throws -> Data {
        let result = try await call("eth_call", [["to": to, "data": data.prefixedHex], "latest"])
        return try Data(hexString: result as? String ?? "0x")
    }

    /// Whether a contract is deployed at `address`.
    func hasCode(_ address: String) async throws -> Bool {
        let code = try await call("eth_getCode", [address, "latest"])
        let bytes = try Data(hexString: code as? String ?? "0x")
        return !bytes.isEmpty
    }

    func chainId() async throws -> UInt64 {
        let hex = (try await call("eth_chainId", []) as? String ?? "0x0").dropFirst(2)
        return UInt64(hex, radix: 16) ?? 0
    }

    /// Whether `channel`, read from the trusted Channels contract `channels`,
    /// is an Active channel of `buyer` with the pool seller. nil = not visible
    /// yet. A Settled or TimedOut channel keeps its buyer and seller on-chain,
    /// so the status word must be checked too. `channels` never comes from
    /// the pool: a pool could otherwise name a contract of its own that
    /// vouches for any channel.
    func channelBelongs(channel: String, buyer: String, pool: String, channels: String) async throws -> Bool? {
        try await channelState(channel: channel, buyer: buyer, pool: pool, channels: channels).belongs
    }

    /// `channelBelongs`, with the channel's reserve (what the buyer's payments on it can redeem) and
    /// whether it was this buyer's channel with the pool but is closed, so it never pays for more.
    func channelState(channel: String, buyer: String, pool: String, channels: String) async throws -> (belongs: Bool?, deposit: UInt64, closed: Bool) {
        let id = try Data(hexString: channel)
        guard id.count == 32 else { throw Failure.rpc("A channel id is 32 bytes") }
        let result = try await ethCall(to: channels, data: Self.selector("channels(bytes32)") + id)
        let deposit = result.count >= 96 ? WorkerPayment.saturating([UInt8](result[64..<96])) : 0
        let verdict = Self.channelVerdict(result, buyer: buyer, pool: pool)
        return (verdict, deposit, verdict == false && Self.channelVerdict(result, buyer: buyer, pool: pool, anyStatus: true) == true)
    }

    /// What the pool contract settled on `channel`, and how much of the buyer's attribution to `worker`
    /// there it paid: one call (`workerCredit`), so both come from the same block.
    /// nil when no contract is deployed at `pool`: a seller paying its workers
    /// from its own address, with no credit on-chain to read.
    func poolCredit(channel: String, worker: String, pool: String) async throws -> (settled: UInt64, credited: UInt64)? {
        let id = try Data(hexString: channel)
        guard id.count == 32 else { throw Failure.rpc("A channel id is 32 bytes") }
        let words = [UInt8](try await ethCall(to: pool, data: Self.selector("workerCredit(bytes32,address)") + id + Self.addressWord(worker)))
        if words.isEmpty {
            let deployed = try await hasCode(pool)
            if !deployed { return nil }
        }
        guard words.count == 64 else { throw Failure.rpc("Malformed workerCredit answer") }
        return (WorkerPayment.saturating(Array(words[0..<32])), WorkerPayment.saturating(Array(words[32..<64])))
    }

    /// The payout wallet the pool records for `worker`; nil when none. Throws on a malformed answer.
    func payoutOf(worker: String, pool: String) async throws -> String? {
        let word = try await ethCall(to: pool, data: Self.selector("payoutOf(address)") + Self.addressWord(worker))
        guard word.count == 32 else { throw Failure.rpc("Malformed payoutOf answer") }
        let address = word.suffix(20)
        return address.allSatisfy { $0 == 0 } ? nil : Data(address).prefixedHex
    }

    /// The nonce the next payout authorization for `worker` must carry.
    func payoutNonce(worker: String, pool: String) async throws -> UInt64 {
        let word = try await ethCall(to: pool, data: Self.selector("payoutNonce(address)") + Self.addressWord(worker))
        return word.suffix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    }

    private static func addressWord(_ address: String) throws -> Data {
        Data(repeating: 0, count: 12) + (try Data(hexString: address))
    }

    /// AntseedChannels.ChannelStatus.Active.
    static let activeStatus: UInt8 = 1

    /// Decodes the `channels(bytes32)` getter: buyer, seller, deposit, settled,
    /// metadataHash, deadline, settledAt, closeRequestedAt, status (9 words).
    static func channelVerdict(_ result: Data, buyer: String, pool: String, anyStatus: Bool = false) -> Bool? {
        let bytes = [UInt8](result)
        guard bytes.count >= 9 * 32 else { return nil }
        let onChainBuyer = Data(bytes[12..<32]).prefixedHex
        let onChainSeller = Data(bytes[44..<64]).prefixedHex
        if onChainBuyer == "0x" + String(repeating: "0", count: 40) { return nil }
        let status = bytes[8 * 32 + 31]
        let statusHigh = bytes[(8 * 32)..<(8 * 32 + 31)]
        return onChainBuyer.lowercased() == buyer.lowercased()
            && onChainSeller.lowercased() == pool.lowercased()
            && (anyStatus || (statusHigh.allSatisfy { $0 == 0 } && status == activeStatus))
    }
}

/// The AntseedChannels deployments this app trusts, by EVM chain id
/// (GeneratedContractAddresses, from the deployment records). Other chains,
/// such as a local test chain, need `--channels`.
enum TrustedChannels {
    static var deployments: [UInt64: String] { GeneratedContractAddresses.channels }

    /// The Channels contract to check channels on: `--channels` when given, else the chain's deployment.
    static func address(chainId: UInt64, override: String?) -> String? {
        override ?? deployments[chainId]
    }
}
