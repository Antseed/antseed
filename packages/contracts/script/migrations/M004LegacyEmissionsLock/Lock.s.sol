// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedLegacyEmissionsRegistry } from "../../../emissions/AntseedLegacyEmissionsRegistry.sol";

interface IRegistryAnswers {
    function channels() external view returns (address);
    function antsToken() external view returns (address);
    function deposits() external view returns (address);
    function emissions() external view returns (address);
}

interface ILegacyEmissionsEscrowView {
    function legacyEmissions() external view returns (address);
    function deposits() external view returns (address);
    function antsToken() external view returns (address);
}

interface IOwnedRenounce {
    function owner() external view returns (address);
    function renounceOwnership() external;
}

interface ILegacyEmissionsV2Admin is IOwnedRenounce {
    function legacyEmissions() external view returns (address);
    function registry() external view returns (address);
    function paused() external view returns (bool);
    function sellerRewardsPool() external view returns (address);
    function sellerUnlockPolicy() external view returns (address);
    function setRegistry(address registry) external;
}

interface ISellerRewardsPoolView is IOwnedRenounce {
    function registry() external view returns (address);
    function sellerClaimPolicy() external view returns (address);
}

/**
 * @title M004LockLegacyEmissions
 * @notice Makes the legacy seller rewards final: EmissionsV2 can never earn
 *         new points again, and nobody can change who may claim what.
 *
 *         1. Deploys AntseedLegacyEmissionsRegistry (ownerless: `channels()`
 *            is zero, `antsToken()` is the escrow, `deposits()` the live
 *            Deposits) and points EmissionsV2 at it. Every accrual reverts
 *            from then on; claims for earned epochs still pay from the escrow.
 *         2. Renounces, in order: AntseedSellerUnlockPolicy (the direct-payout
 *            list), AntseedSellerRewardsPool (its registry facade and M002
 *            claim policy), AntseedEmissionsV2 (its registry, pool, policies,
 *            shares and pause switch), the paused legacy AntseedEmissions V1
 *            (whose claimed flags V2 reads for its first epochs) and
 *            AntseedLegacyEmissionsEscrow (its `sweep`). What the escrow
 *            holds is then either claimable through V2 or locked forever.
 *
 *         ANTSToken, Channels and the main registry are out of scope and keep
 *         their owners.
 *
 *         Every step checks chain state and skips what already landed; a rerun
 *         with everything in place sends nothing.
 *
 * Signers: this script never reads a private key. `LEGACY_OWNER` is the
 * address that owns all five contracts; Foundry resolves its wallet.
 *
 * Required env:
 *   LEGACY_OWNER             Owner of EmissionsV2, EmissionsV1, the escrow,
 *                            the rewards pool and the unlock policy.
 *   LEGACY_EMISSIONS_V2      Deployed AntseedEmissionsV2.
 *   LEGACY_EMISSIONS_ESCROW  Deployed AntseedLegacyEmissionsEscrow (V2's
 *                            registry today).
 *   EXPECTED_ANTS_TOKEN      Deployed ANTSToken.
 *   EXPECTED_DEPOSITS        Live AntseedDeposits.
 *
 * Usage (prefer `pnpm contracts:deploy -- M004 ...`):
 *   cd packages/contracts
 *   forge script script/migrations/M004LegacyEmissionsLock/Lock.s.sol:M004LockLegacyEmissions \
 *     --rpc-url $BASE_MAINNET_RPC_URL --account antseed-owner --broadcast --via-ir
 */
contract M004LockLegacyEmissions is Script {
    struct Config {
        address owner;
        address v2;
        address escrow;
        address antsToken;
        address deposits;
    }

    function run() external returns (address) {
        return runWith(
            Config({
                owner: vm.envAddress("LEGACY_OWNER"),
                v2: vm.envAddress("LEGACY_EMISSIONS_V2"),
                escrow: vm.envAddress("LEGACY_EMISSIONS_ESCROW"),
                antsToken: vm.envAddress("EXPECTED_ANTS_TOKEN"),
                deposits: vm.envAddress("EXPECTED_DEPOSITS")
            })
        );
    }

    function runWith(Config memory cfg) public returns (address pinned) {
        ILegacyEmissionsV2Admin v2 = ILegacyEmissionsV2Admin(cfg.v2);
        ILegacyEmissionsEscrowView escrow = ILegacyEmissionsEscrowView(cfg.escrow);
        ISellerRewardsPoolView pool = ISellerRewardsPoolView(v2.sellerRewardsPool());
        IOwnedRenounce unlockPolicy = IOwnedRenounce(v2.sellerUnlockPolicy());
        IOwnedRenounce v1 = IOwnedRenounce(v2.legacyEmissions());
        IOwnedRenounce escrowOwned = IOwnedRenounce(cfg.escrow);

        // ── Starting-state guards (all view; nothing is sent if any fails) ──
        require(!v2.paused(), "EmissionsV2 is paused: renouncing would freeze every claim");
        require(escrow.legacyEmissions() == cfg.v2, "escrow does not pay LEGACY_EMISSIONS_V2");
        require(escrow.antsToken() == cfg.escrow, "escrow is not its own antsToken facade");
        require(escrow.deposits() == cfg.deposits, "EXPECTED_DEPOSITS is not the live Deposits");
        require(address(pool) != address(0), "EmissionsV2 has no seller rewards pool");
        require(address(unlockPolicy) != address(0), "EmissionsV2 has no seller unlock policy");
        require(pool.sellerClaimPolicy() != address(0), "rewards pool has no claim policy (run M002 first)");
        IRegistryAnswers poolRegistry = IRegistryAnswers(pool.registry());
        require(poolRegistry.emissions() == cfg.v2, "rewards pool registry does not authorize EmissionsV2");
        require(poolRegistry.antsToken() == cfg.antsToken, "rewards pool registry does not pay ANTS");

        address current = v2.registry();
        bool needsPin = current == cfg.escrow;
        if (!needsPin) _requirePinned(current, cfg);
        _requireOwnerOrRenounced(v2, cfg.owner, "EmissionsV2");
        _requireOwnerOrRenounced(pool, cfg.owner, "SellerRewardsPool");
        _requireOwnerOrRenounced(unlockPolicy, cfg.owner, "SellerUnlockPolicy");
        _requireOwnerOrRenounced(v1, cfg.owner, "EmissionsV1");
        _requireOwnerOrRenounced(escrowOwned, cfg.owner, "LegacyEmissionsEscrow");

        console.log("=== AntSeed Legacy Emissions Lock (M004) ===");
        console.log("EmissionsV2:           ", cfg.v2);
        console.log("EmissionsV2 registry:  ", current);
        console.log("SellerRewardsPool:     ", address(pool));
        console.log("SellerUnlockPolicy:    ", address(unlockPolicy));
        console.log("EmissionsV1:           ", address(v1));
        console.log("Escrow:                ", cfg.escrow);
        console.log("Deposits:              ", cfg.deposits);

        vm.startBroadcast(cfg.owner);
        // ── Step 1: pin EmissionsV2 to the ownerless registry ──
        if (needsPin) {
            pinned = address(new AntseedLegacyEmissionsRegistry(cfg.escrow, cfg.deposits));
            v2.setRegistry(pinned);
        } else {
            pinned = current;
        }
        // ── Step 2: renounce, dependencies first ──
        if (unlockPolicy.owner() != address(0)) unlockPolicy.renounceOwnership();
        if (pool.owner() != address(0)) pool.renounceOwnership();
        if (v2.owner() != address(0)) v2.renounceOwnership();
        if (v1.owner() != address(0)) v1.renounceOwnership();
        if (escrowOwned.owner() != address(0)) escrowOwned.renounceOwnership();
        vm.stopBroadcast();

        // ── Post-checks ──
        _requirePinned(v2.registry(), cfg);
        require(v2.owner() == address(0), "post-check failed: EmissionsV2 still owned");
        require(pool.owner() == address(0), "post-check failed: SellerRewardsPool still owned");
        require(unlockPolicy.owner() == address(0), "post-check failed: SellerUnlockPolicy still owned");
        require(v1.owner() == address(0), "post-check failed: EmissionsV1 still owned");
        require(escrowOwned.owner() == address(0), "post-check failed: LegacyEmissionsEscrow still owned");

        console.log("");
        console.log("=== M004 complete ===");
        console.log("LegacyEmissionsRegistry:", pinned);
    }

    function _requirePinned(address registry, Config memory cfg) private view {
        IRegistryAnswers answers = IRegistryAnswers(registry);
        require(answers.channels() == address(0), "EmissionsV2 registry still answers a Channels address");
        require(answers.antsToken() == cfg.escrow, "EmissionsV2 registry does not pay from the escrow");
        require(answers.deposits() == cfg.deposits, "EmissionsV2 registry does not answer the live Deposits");
    }

    function _requireOwnerOrRenounced(IOwnedRenounce owned, address expected, string memory name) private view {
        address current = owned.owner();
        require(
            current == expected || current == address(0), string.concat(name, " is not owned by LEGACY_OWNER")
        );
    }
}
