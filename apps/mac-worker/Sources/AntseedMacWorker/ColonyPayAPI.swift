import Foundation

/// The API of the Antseed payments page this app serves (PayServer): the chain to connect the
/// owner's wallet on, this Mac's pool and payout state, signing a link for the connected wallet,
/// and the page's "done", which refreshes the panel. Connection state is read live through the
/// injected accessors, so each request sees the pool the app is on at that moment.
@MainActor
final class ColonyPayAPI {
    private let config: WorkerConfig
    private let payouts: WorkerPayoutController
    private let workerAddress: String
    private let pool: () -> String?
    private let chainId: () -> UInt64?
    private let channels: () -> String?

    init(
        config: WorkerConfig,
        payouts: WorkerPayoutController,
        workerAddress: String,
        pool: @escaping () -> String?,
        chainId: @escaping () -> UInt64?,
        channels: @escaping () -> String?
    ) {
        self.config = config
        self.payouts = payouts
        self.workerAddress = workerAddress
        self.pool = pool
        self.chainId = chainId
        self.channels = channels
    }

    func handle(_ request: PayServer.Request) async -> PayServer.Response {
        switch (request.method, request.path) {
        case ("GET", "/api/config"):
            return .json(200, await payConfig())
        case ("GET", "/api/colony"):
            await payouts.refreshNow(pool: pool())
            return .json(200, colonyState())
        case ("POST", "/api/colony/link"):
            guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                  let wallet = body["payout"] as? String else { return .error(400, "Missing payout") }
            guard await payouts.link(to: wallet, pool: pool(), copy: false), let link = payouts.pendingLink,
                  let json = try? JSONEncoder().encode(link), let object = try? JSONSerialization.jsonObject(with: json) else {
                return .error(400, payouts.linkError ?? "Could not sign the link")
            }
            return .json(200, object)
        case ("POST", "/api/pay/completed"):
            payouts.refresh(pool: pool())
            return .json(200, ["ok": true])
        default:
            return .error(404, "Not found")
        }
    }

    /// The payments page's network settings (its PaymentConfig): only the chain and RPC matter for these steps.
    private func payConfig() async -> [String: Any] {
        var id = chainId()
        if id == nil { id = try? await Chain(rpcURLs: config.rpcURLs, timeout: 5).chainId() }
        let evmChainId = id ?? 8453
        let names: [UInt64: String] = [8453: "base-mainnet", 84532: "base-sepolia", 31337: "base-local"]
        let none = NSNull()
        return [
            "chainId": names[evmChainId] ?? "chain-\(evmChainId)", "evmChainId": evmChainId, "rpcUrl": config.rpcURLs.first?.absoluteString ?? "",
            "depositsContractAddress": "", "channelsContractAddress": channels() ?? "", "usdcContractAddress": "",
            "emissionsContractAddress": none, "legacyEmissionsContractAddress": none, "usageAccountingAddress": none,
            "usageRewardsAddress": none, "recognizedUsageEffectiveEpoch": none, "antsTokenAddress": none,
            "networkStatsUrl": none, "evmAddress": none,
        ]
    }

    private func colonyState() -> [String: Any] {
        let claim: Any = payouts.rewards.map {
            [
                "usdc": ColonyRewards.integerString($0.usdc), "ants": ColonyRewards.integerString($0.ants),
                "antsEpochs": $0.antsEpochs, "unpulledEpochs": $0.unpulledEpochs, "workerAntsEpochs": $0.workerAntsEpochs,
                "antsTransferable": $0.antsTransferable,
            ] as [String: Any]
        } ?? NSNull()
        return ["pool": pool() ?? NSNull(), "worker": workerAddress, "payout": payouts.payout ?? NSNull(), "claim": claim]
    }
}
