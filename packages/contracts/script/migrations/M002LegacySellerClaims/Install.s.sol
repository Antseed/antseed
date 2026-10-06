// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedLegacySellerClaimPolicy } from "../../../policies/AntseedLegacySellerClaimPolicy.sol";

interface IAntseedRegistryView {
    function emissions() external view returns (address);
    function antsToken() external view returns (address);
}

interface IANTSTokenWhitelist {
    function owner() external view returns (address);
    function transfersEnabled() external view returns (bool);
    function transferWhitelist(address account) external view returns (bool);
    function setTransferWhitelist(address account, bool allowed) external;
}

interface ILegacyEmissionsV2View {
    function legacyEmissions() external view returns (address);
    function sellerRewardsPool() external view returns (address);
    function MIGRATION_EPOCH() external view returns (uint256);
}

interface ISellerRewardsPoolAdmin {
    function owner() external view returns (address);
    function sellerClaimPolicy() external view returns (address);
    function totalLockedRewards() external view returns (uint256);
    function setSellerClaimPolicy(address policy) external;
}

interface IUsageAccountingView {
    function emissionsGate() external view returns (address);
}

interface IEmissionsGateView {
    function effectiveEpoch() external view returns (uint256);
}

/**
 * @title M002InstallLegacySellerClaims
 * @notice Unfreezes the deployed AntseedSellerRewardsPool so legacy sellers
 *         can claim the released share of their locked ANTS.
 *
 *         Two things block `pool.claim()` today:
 *           1. the pool has no `sellerClaimPolicy` (claim reverts
 *              NoSellerClaimPolicy);
 *           2. ANTS transfers are disabled and the pool — the transfer
 *              *sender* — was never whitelisted (claim reverts
 *              TransfersNotEnabled).
 *
 *         This script fixes both, each with the key that owns it:
 *           - TOKEN OWNER (`DEPLOYER`): `ANTSToken.setTransferWhitelist(pool, true)`
 *             unless transfers are already enabled or the pool is whitelisted.
 *           - POOL OWNER (`SELLER_REWARDS_POOL_OWNER`): deploys
 *             AntseedLegacySellerClaimPolicy and installs it on the pool.
 *
 *         Run only after M001 has activated (`registry.emissions()` is
 *         AntseedUsageAccounting). From that point on the last epoch that
 *         legacy V2 could lock into the pool is fixed at
 *         `gate.effectiveEpoch() - 1`, which the policy needs as an immutable
 *         scan bound.
 *
 *         The policy is stateless: it re-derives every seller's cumulative
 *         locked amount from EmissionsV2/V1 state, releases `RELEASE_BPS` of
 *         it immediately and returns zero for sellers the
 *         wash-trading registry has proven to be wash traders.
 *
 *         Idempotent: every step checks chain state and skips what already
 *         landed; a rerun with both in place exits with nothing to do.
 *
 * Signers: this script never reads a private key. Each broadcast names the
 * address it acts as; Foundry resolves the wallet from the command line.
 *
 * Required env:
 *   DEPLOYER                     ANTSToken owner address (whitelists the pool).
 *   SELLER_REWARDS_POOL_OWNER    Owner address of the deployed
 *                                AntseedSellerRewardsPool.
 *   ANTSEED_REGISTRY             Legacy AntseedRegistry address.
 *   EXPECTED_ANTS_TOKEN          Deployed ANTSToken.
 *   LEGACY_EMISSIONS_V2          Deployed legacy AntseedEmissionsV2 (the
 *                                contract that locked rewards into the pool).
 *   USAGE_ACCOUNTING             AntseedUsageAccounting from M001 (reads the
 *                                gate's effective epoch).
 *   WASH_TRADING_REGISTRY        Deployed AntseedWashTradingRegistry. The CLI
 *                                defaults it to the activated M001 ledger's
 *                                washTradingRegistry address.
 *
 * Optional env:
 *   LAST_LOCKED_EPOCH            If set, must equal `effectiveEpoch - 1`.
 *   RELEASE_BPS                  Share of cumulative locked rewards released.
 *                                Default 1000 (10%).
 *
 * Usage (prefer `pnpm contracts:deploy -- M002 ...`):
 *   cd packages/contracts
 *   source .env
 *   forge script script/migrations/M002LegacySellerClaims/Install.s.sol:M002InstallLegacySellerClaims \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --account antseed-owner --account pool-owner \
 *     --broadcast \
 *     --via-ir
 */
contract M002InstallLegacySellerClaims is Script {
    uint256 public constant DEFAULT_RELEASE_BPS = 1000;

    struct Config {
        address tokenOwner;
        address poolOwner;
        address registry;
        address antsToken;
        address legacyEmissionsV2;
        address usageAccounting;
        address washTradingRegistry;
        uint256 lastEpochOverride; // 0 = derive from gate.effectiveEpoch() - 1
        uint256 releaseBps;
    }

    function run() external returns (address) {
        return runWith(
            Config({
                tokenOwner: vm.envAddress("DEPLOYER"),
                poolOwner: vm.envAddress("SELLER_REWARDS_POOL_OWNER"),
                registry: vm.envAddress("ANTSEED_REGISTRY"),
                antsToken: vm.envAddress("EXPECTED_ANTS_TOKEN"),
                legacyEmissionsV2: vm.envAddress("LEGACY_EMISSIONS_V2"),
                usageAccounting: vm.envAddress("USAGE_ACCOUNTING"),
                washTradingRegistry: vm.envAddress("WASH_TRADING_REGISTRY"),
                lastEpochOverride: vm.envOr("LAST_LOCKED_EPOCH", uint256(0)),
                releaseBps: vm.envOr("RELEASE_BPS", DEFAULT_RELEASE_BPS)
            })
        );
    }

    function runWith(Config memory cfg) public returns (address) {
        IAntseedRegistryView registry = IAntseedRegistryView(cfg.registry);
        IANTSTokenWhitelist token = IANTSTokenWhitelist(cfg.antsToken);
        ILegacyEmissionsV2View v2 = ILegacyEmissionsV2View(cfg.legacyEmissionsV2);

        // ── Starting-state guards (all view; nothing is sent if any fails) ──
        require(registry.antsToken() == address(token), "EXPECTED_ANTS_TOKEN is not the registry's ANTS token");
        require(
            registry.emissions() == cfg.usageAccounting,
            "M001 has not activated: registry.emissions() is not UsageAccounting"
        );
        require(registry.emissions() != address(v2), "registry.emissions() still resolves to legacy EmissionsV2");

        address v1 = v2.legacyEmissions();
        require(v1 != address(0), "LEGACY_EMISSIONS_V2 has no legacyEmissions()");
        ISellerRewardsPoolAdmin pool = ISellerRewardsPoolAdmin(v2.sellerRewardsPool());
        require(address(pool) != address(0), "legacy EmissionsV2 has no seller rewards pool");
        require(pool.owner() == cfg.poolOwner, "SELLER_REWARDS_POOL_OWNER is not the pool owner");

        uint256 effectiveEpoch =
            IEmissionsGateView(IUsageAccountingView(cfg.usageAccounting).emissionsGate()).effectiveEpoch();
        require(effectiveEpoch > 0, "gate effective epoch must be positive");
        uint256 lastEpoch = cfg.lastEpochOverride == 0 ? effectiveEpoch - 1 : cfg.lastEpochOverride;
        require(lastEpoch >= v2.MIGRATION_EPOCH(), "last locked epoch precedes the V2 migration epoch");
        require(lastEpoch < effectiveEpoch, "LAST_LOCKED_EPOCH must precede the gate's effective epoch");
        require(lastEpoch == effectiveEpoch - 1, "LAST_LOCKED_EPOCH must equal the gate's effective epoch minus one");

        require(cfg.washTradingRegistry != address(0), "WASH_TRADING_REGISTRY not set");
        require(cfg.washTradingRegistry.code.length != 0, "WASH_TRADING_REGISTRY has no code");

        bool needsWhitelist = !token.transfersEnabled() && !token.transferWhitelist(address(pool));
        address existingPolicy = pool.sellerClaimPolicy();

        console.log("=== AntSeed Legacy Seller Claims (M002) ===");
        console.log("SellerRewardsPool:      ", address(pool));
        console.log("Pool total locked:      ", pool.totalLockedRewards());
        console.log("Pool whitelisted:       ", !needsWhitelist);
        console.log("Legacy EmissionsV2:     ", address(v2));
        console.log("Legacy EmissionsV1:     ", v1);
        console.log("Migration epoch:        ", v2.MIGRATION_EPOCH());
        console.log("Last locked epoch:      ", lastEpoch);
        console.log("Release bps:            ", cfg.releaseBps);
        console.log("Wash-trading registry:  ", cfg.washTradingRegistry);

        if (!needsWhitelist && existingPolicy != address(0)) {
            console.log("");
            console.log("Nothing to do: pool is whitelisted and already has a claim policy:", existingPolicy);
            return existingPolicy;
        }

        // ── Step 1 (token owner): let the pool send ANTS ──
        if (needsWhitelist) {
            require(token.owner() == cfg.tokenOwner, "DEPLOYER is not the ANTSToken owner");
            vm.startBroadcast(cfg.tokenOwner);
            token.setTransferWhitelist(address(pool), true);
            vm.stopBroadcast();
            console.log("");
            console.log("Whitelisted SellerRewardsPool on ANTSToken.");
        }

        // ── Step 2 (pool owner): deploy + install the claim policy ──
        address policyAddress = existingPolicy;
        if (existingPolicy == address(0)) {
            vm.startBroadcast(cfg.poolOwner);
            AntseedLegacySellerClaimPolicy policy =
                new AntseedLegacySellerClaimPolicy(address(v2), lastEpoch, cfg.releaseBps, cfg.washTradingRegistry);
            pool.setSellerClaimPolicy(address(policy));
            vm.stopBroadcast();
            policyAddress = address(policy);
            require(address(policy.v1()) == v1, "post-check failed: policy v1 mismatch");
        } else {
            console.log("");
            console.log("Pool already has a claim policy; keeping it:", existingPolicy);
        }

        require(pool.sellerClaimPolicy() == policyAddress, "post-check failed: claim policy not set");
        require(
            token.transfersEnabled() || token.transferWhitelist(address(pool)),
            "post-check failed: pool cannot transfer ANTS"
        );

        console.log("");
        console.log("=== M002 complete ===");
        console.log("LegacySellerClaimPolicy:", policyAddress);
        return policyAddress;
    }
}
