import Foundation

/// Which channels the worker serves full requests on (docs/protocol/colony-pool.md,
/// "Workers"). A binding's channel is verified (the chain shows it is that
/// buyer's channel with this pool), refused (the chain shows otherwise) or
/// unknown (not on-chain within `wait`). Only a verified channel gets full
/// requests, so a pool cannot buy real work by signing bindings to channels
/// that do not exist. Both verdicts are cached; one lookup is shared by the
/// requests waiting on it, and an unknown channel is looked up again by the
/// next request (a fresh reserve can lag the RPC).
@MainActor
final class ChannelVerdicts {
    /// Whether `channel` belongs to `buyer` and the pool; nil = not on-chain (yet).
    typealias Lookup = @MainActor (_ channel: String, _ buyer: String) async throws -> Bool?

    private let lookup: Lookup
    private let wait: TimeInterval
    private let pollInterval: TimeInterval
    /// Verified: channel → the buyer the chain says owns it.
    private var owners: [String: String] = [:]
    /// Refused: "channel|buyer" pairs the chain says don't match.
    private var refused: Set<String> = []
    private var pending: [String: Task<Bool?, Never>] = [:]
    /// Called once per verdict the chain gives (channel, buyer, verified).
    var onVerdict: ((String, String, Bool) -> Void)?

    private static let maxCached = 10_000

    init(wait: TimeInterval = 5, pollInterval: TimeInterval = 1, lookup: @escaping Lookup) {
        self.wait = wait
        self.pollInterval = pollInterval
        self.lookup = lookup
    }

    /// true = verified, false = refused, nil = not on-chain within the wait.
    func verdict(channel: String, buyer: String) async -> Bool? {
        let channel = channel.lowercased(), buyer = buyer.lowercased()
        // A channel proven to be another buyer's never serves this one.
        if let owner = owners[channel] { return owner == buyer }
        let key = "\(channel)|\(buyer)"
        if refused.contains(key) { return false }
        if let task = pending[key] { return await task.value }
        let task = Task { await self.look(channel: channel, buyer: buyer) }
        pending[key] = task
        let result = await task.value
        pending[key] = nil
        return result
    }

    private func look(channel: String, buyer: String) async -> Bool? {
        let deadline = Date().addingTimeInterval(wait)
        while true {
            switch try? await lookup(channel, buyer) {
            case true?:
                if owners.count >= Self.maxCached { owners.removeAll() }
                owners[channel] = buyer
                onVerdict?(channel, buyer, true)
                return true
            case false?:
                if refused.count >= Self.maxCached { refused.removeAll() }
                refused.insert("\(channel)|\(buyer)")
                onVerdict?(channel, buyer, false)
                return false
            default:
                if Date().addingTimeInterval(pollInterval) >= deadline { return nil }
                try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
            }
        }
    }
}
