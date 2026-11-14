import AppKit
import Foundation

/// The owner's payout wallet: what the pool contract records for this Mac, the
/// signed link that wallet submits (from the rewards page this app opens, or
/// the ANTS dashboard's Rewards → Link a Mac), and what the pool owes it.
@MainActor
final class WorkerPayoutController: ObservableObject {
    /// The owner's wallet this Mac's earnings are paid to, as the pool contract records it.
    @Published private(set) var payout: String?
    /// A signed link the owner has not submitted yet. Kept until the contract
    /// records it or it expires, so its code can be copied again after a restart.
    @Published private(set) var pendingLink: PayoutAuthorization?
    @Published private(set) var linkError: String?
    /// What the pool owes the payout wallet (this Mac's key until one is linked), with the ANTS the
    /// linked key still holds itself (epochs older than linking moves); nil until read.
    @Published private(set) var rewards: ColonyRewards?
    /// Why the last rewards read failed, if it did.
    @Published private(set) var rewardsError: String?

    private static let pendingLinkFile = "payout-link.json"
    private let config: WorkerConfig
    private let keys: WorkerKeys
    private let log: (String) -> Void
    /// `--link-payout` signs once per launch, not on every reconnect.
    private var linkRequested = false
    /// The pool contract the published state is for: reads that finish after a switch are dropped.
    private var pool: String?

    init(config: WorkerConfig, keys: WorkerKeys, log: @escaping (String) -> Void) {
        self.config = config
        self.keys = keys
        self.log = log
        self.pendingLink = (try? Data(contentsOf: config.dataDirectory.appendingPathComponent(Self.pendingLinkFile)))
            .flatMap { try? JSONDecoder().decode(PayoutAuthorization.self, from: $0) }
    }

    private var address: String { keys.ethereum.address }

    /// Joined `pool`: read its payout record, and sign `--link-payout`'s link once per launch.
    /// Another pool's payout, rewards and unsubmitted link are not this one's: they go.
    func joined(pool: String?) {
        if pool?.lowercased() != self.pool?.lowercased() {
            self.pool = pool
            payout = nil
            rewards = nil
            rewardsError = nil
            linkError = nil
        }
        if let link = pendingLink, link.pool.lowercased() != pool?.lowercased() { setPendingLink(nil) }
        refresh(pool: pool)
        if let wallet = config.linkPayoutTo, !linkRequested {
            linkRequested = true
            Task { await link(to: wallet, pool: pool) }
        }
    }

    /// Read the payout wallet from the pool contract, and drop a pending link
    /// once the contract records it or its deadline passes.
    func refresh(pool: String?) {
        Task { await refreshNow(pool: pool) }
    }

    /// `refresh`, finished before it returns: the rewards page reads the result right after.
    func refreshNow(pool: String?) async {
        guard !config.rpcURLs.isEmpty, let pool, isCurrent(pool) else { return }
        let read: String?
        do {
            read = try await Chain(rpcURLs: config.rpcURLs, timeout: 10).payoutOf(worker: address, pool: pool)
        } catch {
            return
        }
        guard isCurrent(pool) else { return }
        payout = read
        if let link = pendingLink,
           link.pool.lowercased() != pool.lowercased() || link.payout.lowercased() == payout?.lowercased()
            || link.deadline <= UInt64(Date().timeIntervalSince1970) {
            setPendingLink(nil)
        }
        await refreshRewards(pool: pool)
    }

    /// Read what the pool owes the payout wallet (this Mac's key until one is linked).
    func refreshRewards(pool: String?) async {
        guard !config.rpcURLs.isEmpty, let pool, isCurrent(pool) else { return }
        let chain = Chain(rpcURLs: config.rpcURLs, timeout: 10)
        let linked = payout.flatMap { $0.lowercased() == address.lowercased() ? nil : $0 }
        do {
            let context = try await chain.rewardsContext(pool: pool)
            var read = try await chain.colonyRewards(pool: pool, account: linked ?? address, context: context)
            // Linking moves only recent epochs' ANTS: older ones stay with this key, still this owner's to claim.
            if linked != nil { read = read.adding(worker: try await chain.colonyRewards(pool: pool, account: address, context: context)) }
            guard isCurrent(pool) else { return }
            rewards = read
            rewardsError = nil
        } catch {
            guard isCurrent(pool) else { return }
            rewardsError = "Could not read rewards: \(error.localizedDescription)"
        }
    }

    /// Whether `pool` is still the one joined (any pool counts before the first join).
    private func isCurrent(_ pool: String) -> Bool { self.pool == nil || self.pool?.lowercased() == pool.lowercased() }

    private func setPendingLink(_ link: PayoutAuthorization?) {
        pendingLink = link
        let file = config.dataDirectory.appendingPathComponent(Self.pendingLinkFile)
        if let link, let json = try? JSONEncoder().encode(link) {
            try? json.write(to: file, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: file)
        }
    }

    /// Copy the pending link's code again.
    func copyLinkCode() {
        guard let link = pendingLink else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(link.code, forType: .string)
    }

    /// Sign the instruction for the pool contract to pay this Mac's earnings to
    /// `wallet`, and copy it. Returns whether a new link was signed; on failure
    /// `linkError` says why.
    @discardableResult
    func link(to wallet: String, pool: String?, copy: Bool = true) async -> Bool {
        let wallet = wallet.trimmingCharacters(in: .whitespacesAndNewlines)
        guard wallet.count == 42, wallet.hasPrefix("0x"), (try? Data(hexString: wallet)) != nil else {
            linkError = "Enter a wallet address (0x…)"
            return false
        }
        guard !config.rpcURLs.isEmpty, let pool else {
            linkError = "Join a pool first"
            return false
        }
        linkError = nil
        do {
            let chain = Chain(rpcURLs: config.rpcURLs, timeout: 10)
            let chainId = try await chain.chainId()
            let nonce = try await chain.payoutNonce(worker: address, pool: pool)
            let deadline = UInt64(Date().timeIntervalSince1970) + 7 * 24 * 3600
            let digest = PayoutAuthorization.digest(chainId: chainId, pool: pool, worker: address, payout: wallet, nonce: nonce, deadline: deadline)
            let signature = try keys.ethereum.sign(digest: personalMessageDigest(digest))
            let link = PayoutAuthorization(chainId: chainId, pool: pool, worker: address, payout: wallet, deadline: deadline, signature: signature.prefixedHex)
            setPendingLink(link)
            if copy {
                copyLinkCode()
                log("payout authorization for \(wallet) copied; paste it in the ANTS dashboard (Rewards → Link a Mac)")
            } else {
                log("payout authorization for \(wallet) signed for the rewards page")
            }
            if config.linkPayoutTo != nil { log("link code \(link.code)") }
            return true
        } catch {
            linkError = error.localizedDescription
            return false
        }
    }
}
