import Foundation

/// What the worker lets a decrypted request do (docs/protocol/colony-pool.md, "Workers").
enum Admission: Equatable {
    /// A buyer's request on a verified channel (or signature-checked, without an RPC).
    case full
    /// The pool's own check: small input, at most this many output tokens.
    case check(maxTokens: Int)
    case refused(String)
    /// Cancelled (by the pool, a disconnect or quitting) while it waited.
    case cancelled
}

/// How a buyer's channel binding is checked.
enum ChannelCheck {
    /// No RPC: the buyer's signature is all that is checked.
    case signatureOnly
    /// An RPC but no trusted Channels contract for its chain: full requests are refused.
    case unavailable(String)
    /// true = verified, false = refused, nil = not on-chain yet (or cancelled).
    case verify(() async -> Bool?)
}

/// Admission for the pool's requests: how many run at once, and what each may do.
@MainActor
final class RequestGate {
    /// Requests served at once (announced to the pool as `maxConcurrency`).
    static let maxConcurrency = 1
    /// Pool checks: decrypted body and prompt bounds, output tokens, and rate.
    static let checkBodyBytes = 8 * 1024
    static let checkPromptTokens = 2048
    static let checkMaxTokens = 16
    static let checksPerHour = 240

    let maxConcurrency: Int
    let checksPerHour: Int
    private(set) var active: Set<String> = []
    private var checkTimes: [Date] = []

    init(maxConcurrency: Int = RequestGate.maxConcurrency, checksPerHour: Int = RequestGate.checksPerHour) {
        self.maxConcurrency = maxConcurrency
        self.checksPerHour = checksPerHour
    }

    /// Take a slot for `id` before any asynchronous work; nil when taken, else why not.
    /// Requests waiting on a channel check hold their slot.
    func reserve(_ id: String) -> String? {
        if active.contains(id) { return "Duplicate request id" }
        guard active.count < maxConcurrency else { return "Worker busy: \(maxConcurrency) request(s) at a time" }
        active.insert(id)
        return nil
    }

    func release(_ id: String) {
        active.remove(id)
    }

    /// Decide what a decrypted request may do. `buyer`/`channel` are its signed
    /// binding (nil or the zero channel: a pool check of `bodyBytes`).
    func admit(buyer: String?, channel: String?, bodyBytes: Int, requestedMaxTokens: Int, check: ChannelCheck, now: Date = Date()) async -> Admission {
        guard buyer != nil, let channel, !channel.allSatisfy({ $0 == "0" || $0 == "x" }) else {
            guard bodyBytes <= Self.checkBodyBytes else { return .refused("Check request too large") }
            checkTimes = checkTimes.filter { now.timeIntervalSince($0) < 3600 }
            guard checkTimes.count < checksPerHour else { return .refused("Check rate limit exceeded") }
            checkTimes.append(now)
            return .check(maxTokens: max(1, min(requestedMaxTokens, Self.checkMaxTokens)))
        }
        switch check {
        case .signatureOnly:
            return .full
        case .unavailable(let reason):
            return .refused(reason)
        case .verify(let verdict):
            let result = await verdict()
            if Task.isCancelled { return .cancelled }
            switch result {
            case true?: return .full
            case false?: return .refused("Request channel does not belong to a buyer of this pool")
            case nil: return .refused("Request channel is not on-chain yet; retry shortly")
            }
        }
    }
}
