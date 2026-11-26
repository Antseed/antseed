import Foundation

/// When the pool connection last showed signs of life (a message or a pong),
/// and whether it has been silent long enough to count as dead. Matches the
/// reference worker's `poolSilenceMs` (45 s).
struct PoolLiveness {
    static let pingInterval: TimeInterval = 15
    static let silenceLimit: TimeInterval = 45

    private(set) var lastHeard: Date

    init(now: Date = Date()) {
        lastHeard = now
    }

    mutating func heard(at now: Date = Date()) {
        lastHeard = now
    }

    func isSilent(now: Date = Date()) -> Bool {
        now.timeIntervalSince(lastHeard) >= Self.silenceLimit
    }
}
