import Foundation

/// A worker's signed instruction to the pool contract: pay this Mac's earnings
/// to the owner's wallet. Anyone may submit it (`AntseedWorkerPool.setPayout`);
/// the owner does, from the ANTS dashboard (Rewards → Link a Mac).
struct PayoutAuthorization: Codable {
    let chainId: UInt64
    let pool: String
    let worker: String
    let payout: String
    let deadline: UInt64
    let signature: String

    /// keccak256(abi.encode(keccak256("antseed-worker-payout/v1"), chainid, pool, worker, payout, nonce, deadline))
    static func digest(chainId: UInt64, pool: String, worker: String, payout: String, nonce: UInt64, deadline: UInt64) -> [UInt8] {
        func uint(_ value: UInt64) -> [UInt8] { [UInt8](repeating: 0, count: 24) + withUnsafeBytes(of: value.bigEndian) { Array($0) } }
        func address(_ hex: String) -> [UInt8] { [UInt8](repeating: 0, count: 12) + ((try? [UInt8](Data(hexString: hex))) ?? []) }
        let typeHash = keccak256(Array("antseed-worker-payout/v1".utf8))
        return keccak256(typeHash + uint(chainId) + address(pool) + address(worker) + address(payout) + uint(nonce) + uint(deadline))
    }

    /// Compact text form the owner pastes in the ANTS dashboard: `antseed-link:<base64url JSON>`.
    var code: String {
        let json = (try? JSONEncoder().encode(self)) ?? Data()
        let payload = json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return "antseed-link:" + payload
    }
}
