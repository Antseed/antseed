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

    /// Whether `channel` belongs to `buyer` and to the pool seller. nil = not visible yet.
    func channelBelongs(channel: String, buyer: String, pool: String) async throws -> Bool? {
        let channelsWord = try await ethCall(to: pool, data: Self.selector("channelsAddress()"))
        let channels = Data(channelsWord.suffix(20)).prefixedHex
        let result = try await ethCall(to: channels, data: Self.selector("channels(bytes32)") + (try Data(hexString: channel)))
        guard result.count >= 64 else { return nil }
        let onChainBuyer = Data(result[12..<32]).prefixedHex
        let onChainSeller = Data(result[44..<64]).prefixedHex
        if onChainBuyer == "0x" + String(repeating: "0", count: 40) { return nil }
        return onChainBuyer.lowercased() == buyer.lowercased() && onChainSeller.lowercased() == pool.lowercased()
    }
}
