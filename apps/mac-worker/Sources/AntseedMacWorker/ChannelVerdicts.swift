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

    /// true = verified, false = refused, nil = not on-chain within the wait,
    /// or the waiting request was cancelled (it returns at once; the shared
    /// lookup carries on for the others).
    func verdict(channel: String, buyer: String) async -> Bool? {
        let channel = channel.lowercased(), buyer = buyer.lowercased()
        // A channel proven to be another buyer's never serves this one.
        if let owner = owners[channel] { return owner == buyer }
        let key = "\(channel)|\(buyer)"
        if refused.contains(key) { return false }
        if Task.isCancelled { return nil }
        let task = pending[key] ?? {
            let task = Task { () -> Bool? in
                let result = await self.look(channel: channel, buyer: buyer)
                self.pending[key] = nil
                return result
            }
            pending[key] = task
            return task
        }()
        return await Self.value(of: task)
    }

    /// The task's value, or nil as soon as the caller is cancelled.
    private static func value(of task: Task<Bool?, Never>) async -> Bool? {
        let once = ResumeOnce()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                once.set(continuation)
                Task { once.resume(await task.value) }
            }
        } onCancel: {
            once.resume(nil)
        }
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

/// Resumes a continuation exactly once, from whichever side gets there first.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool?, Never>?
    private var result: Bool??

    func set(_ continuation: CheckedContinuation<Bool?, Never>) {
        lock.lock()
        if let result {
            lock.unlock()
            continuation.resume(returning: result)
            return
        }
        self.continuation = continuation
        lock.unlock()
    }

    func resume(_ value: Bool?) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = .some(value)
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }
}
