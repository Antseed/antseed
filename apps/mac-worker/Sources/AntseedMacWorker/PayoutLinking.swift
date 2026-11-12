import AppKit
import Foundation

/// The owner's payout wallet: what the pool contract records for this Mac, and
/// the signed link the owner submits from that wallet in the ANTS dashboard
/// (Rewards → Link a Mac), where rewards are also claimed.
@MainActor
final class WorkerPayoutController: ObservableObject {
    /// The owner's wallet this Mac's earnings are paid to, as the pool contract records it.
    @Published private(set) var payout: String?
    /// A signed link the owner has not submitted yet. Kept until the contract
    /// records it or it expires, so its code can be copied again after a restart.
    @Published private(set) var pendingLink: PayoutAuthorization?
    @Published private(set) var linkError: String?
    /// The payout authorization was just copied for the owner to paste.
    @Published private(set) var linkCopied = false

    private static let pendingLinkFile = "payout-link.json"
    private let config: WorkerConfig
    private let keys: WorkerKeys
    private let log: (String) -> Void
    /// `--link-payout` signs once per launch, not on every reconnect.
    private var linkRequested = false

    init(config: WorkerConfig, keys: WorkerKeys, log: @escaping (String) -> Void) {
        self.config = config
        self.keys = keys
        self.log = log
        self.pendingLink = (try? Data(contentsOf: config.dataDirectory.appendingPathComponent(Self.pendingLinkFile)))
            .flatMap { try? JSONDecoder().decode(PayoutAuthorization.self, from: $0) }
    }

    private var address: String { keys.ethereum.address }

    /// Joined `pool`: read its payout record, and sign `--link-payout`'s link once per launch.
    func joined(pool: String?) {
        refresh(pool: pool)
        if let wallet = config.linkPayoutTo, !linkRequested {
            linkRequested = true
            Task { await link(to: wallet, pool: pool) }
        }
    }

    /// Read the payout wallet from the pool contract, and drop a pending link
    /// once the contract records it or its deadline passes.
    func refresh(pool: String?) {
        guard !config.rpcURLs.isEmpty, let pool else { return }
        Task {
            do {
                payout = try await Chain(rpcURLs: config.rpcURLs, timeout: 10).payoutOf(worker: address, pool: pool)
            } catch {
                return
            }
            if let link = pendingLink,
               link.payout.lowercased() == payout?.lowercased() || link.deadline <= UInt64(Date().timeIntervalSince1970) {
                setPendingLink(nil)
            }
        }
    }

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
        linkCopied = true
    }

    /// Sign the instruction for the pool contract to pay this Mac's earnings to
    /// `wallet`, and copy it. Returns whether a new link was signed; on failure
    /// `linkError` says why.
    @discardableResult
    func link(to wallet: String, pool: String?) async -> Bool {
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
            copyLinkCode()
            log("payout authorization for \(wallet) copied; paste it in the ANTS dashboard (Rewards → Link a Mac)")
            if config.linkPayoutTo != nil { log("link code \(link.code)") }
            return true
        } catch {
            linkError = error.localizedDescription
            return false
        }
    }
}
