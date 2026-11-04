import Foundation

/// Minimal JSON-RPC reads: checking that a request's channel belongs to a
/// buyer of this pool, and the chain id the payout authorization is bound to.
struct Chain {
    let rpcURL: URL
    /// Per-request deadline; nil keeps URLSession's default.
    var timeout: TimeInterval? = nil

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
        var request = URLRequest(url: rpcURL)
        request.httpMethod = "POST"
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": 1, "method": method, "params": params])
        let (data, _) = try await URLSession.shared.data(for: request)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        if let error = object["error"] as? [String: Any] { throw Failure.rpc(error["message"] as? String ?? "RPC error") }
        return object["result"] ?? NSNull()
    }

    func ethCall(to: String, data: Data) async throws -> Data {
        let result = try await call("eth_call", [["to": to, "data": data.prefixedHex], "latest"])
        return try Data(hexString: result as? String ?? "0x")
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
        let result = try await ethCall(to: channels, data: Self.selector("channels(bytes32)") + (try Data(hexString: channel)))
        return Self.channelVerdict(result, buyer: buyer, pool: pool)
    }

    /// AntseedChannels.ChannelStatus.Active.
    static let activeStatus: UInt8 = 1

    /// Decodes the `channels(bytes32)` getter: buyer, seller, deposit, settled,
    /// metadataHash, deadline, settledAt, closeRequestedAt, status (9 words).
    static func channelVerdict(_ result: Data, buyer: String, pool: String) -> Bool? {
        let bytes = [UInt8](result)
        guard bytes.count >= 9 * 32 else { return nil }
        let onChainBuyer = Data(bytes[12..<32]).prefixedHex
        let onChainSeller = Data(bytes[44..<64]).prefixedHex
        if onChainBuyer == "0x" + String(repeating: "0", count: 40) { return nil }
        let status = bytes[8 * 32 + 31]
        let statusHigh = bytes[(8 * 32)..<(8 * 32 + 31)]
        return onChainBuyer.lowercased() == buyer.lowercased()
            && onChainSeller.lowercased() == pool.lowercased()
            && statusHigh.allSatisfy { $0 == 0 } && status == activeStatus
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
