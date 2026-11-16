// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedKbfAudits } from "../verification/AntseedKbfAudits.sol";
import { AntseedVerificationResults } from "../verification/AntseedVerificationResults.sol";

interface IStandaloneUsageAccounting {
    function sellerPools() external view returns (address);
}

interface IStandaloneEmissionsGateSource {
    function emissionsGate() external view returns (address);
}

/// @title DeployStandaloneVerificationSplit
/// @notice Deploys the split verification contracts (results layer, KBF audit
///         audit, points policy) without registering the policy or enabling rewards.
///
/// Separate from M003. It only reads the existing registry, seller-pools and usage-accounting
/// addresses, deploys three independently owned contracts, wires KBF as an audit on the results layer
/// (`setAudit`, a 10,000 bps share) and optionally approves auditors on the KBF contract. It never calls
/// a points policy registry, usage-accounting setter, emissions-gate setter, or rewards setter, so
/// verdicts change no points and audits earn no credits.
///
/// Required environment:
///   EXPECTED_CHAIN_ID       Target chain ID.
///   ANTSEED_REGISTRY        Existing compatible AntseedRegistry address.
///   SELLER_POOLS            Existing compatible AntseedSellerPools address.
///   USAGE_ACCOUNTING        Contract exposing `sellerPools()`, read by the points policy.
///   STANDALONE_OWNER        New wallet that will own all three contracts.
///
/// Optional environment:
///   VERIFICATION_AUDITORS   Comma-separated auditor addresses to approve on the KBF contract.
///   VERIFICATION_BONUS_BPS  Points policy bonus per verified service (0 to 5000, default 0).
///
/// The owner address is supplied to startBroadcast, but this script never reads a private key.
///
/// Example dry run:
///   forge script script/DeployStandaloneVerificationSplit.s.sol \
///     --rpc-url "$RPC_URL" --sender "$STANDALONE_OWNER" --via-ir
///
/// Example broadcast (with a new signer, not the AntSeed production deployer):
///   forge script script/DeployStandaloneVerificationSplit.s.sol \
///     --rpc-url "$RPC_URL" --sender "$STANDALONE_OWNER" \
///     --account standalone-owner --broadcast --via-ir
contract DeployStandaloneVerificationSplit is Script {
    struct Config {
        uint256 expectedChainId;
        address registry;
        address sellerPools;
        address usageAccounting;
        address owner;
        address[] auditors;
        uint256 bonusBps;
    }

    struct Deployment {
        AntseedVerificationResults results;
        AntseedKbfAudits kbf;
        AntseedVerificationPointsPolicy policy;
    }

    function run() external returns (Deployment memory) {
        return runWith(
            Config({
                expectedChainId: vm.envUint("EXPECTED_CHAIN_ID"),
                registry: vm.envAddress("ANTSEED_REGISTRY"),
                sellerPools: vm.envAddress("SELLER_POOLS"),
                usageAccounting: vm.envAddress("USAGE_ACCOUNTING"),
                owner: vm.envAddress("STANDALONE_OWNER"),
                auditors: vm.envOr("VERIFICATION_AUDITORS", ",", new address[](0)),
                bonusBps: vm.envOr("VERIFICATION_BONUS_BPS", uint256(0))
            })
        );
    }

    function runWith(Config memory config) public returns (Deployment memory deployment) {
        _validate(config);

        address emissions = IAntseedRegistry(config.registry).emissions();
        address identityRegistry = IAntseedRegistry(config.registry).identityRegistry();
        address gate = _emissionsGate(emissions);

        vm.startBroadcast(config.owner);
        deployment.results = new AntseedVerificationResults(gate);
        deployment.kbf = new AntseedKbfAudits(address(deployment.results), config.sellerPools, identityRegistry);
        deployment.policy = new AntseedVerificationPointsPolicy(
            address(deployment.results), config.usageAccounting, config.bonusBps, config.owner
        );
        deployment.results.setAudit(address(deployment.kbf), true);
        deployment.results.setAuditShareBps(address(deployment.kbf), 10_000);
        for (uint256 index; index < config.auditors.length; index++) {
            deployment.kbf.setAuditor(config.auditors[index], true);
        }
        vm.stopBroadcast();

        // These postconditions make an accidental policy/rewards coupling fail loudly in a dry run.
        AntseedVerificationResults results = deployment.results;
        require(results.owner() == config.owner, "standalone: wrong owner");
        require(deployment.kbf.owner() == config.owner, "standalone: wrong owner");
        require(deployment.policy.owner() == config.owner, "standalone: wrong owner");
        require(address(results.emissionsGate()) == gate, "standalone: wrong emissions gate");
        require(address(deployment.kbf.identityRegistry()) == identityRegistry, "standalone: wrong identity registry");
        require(address(deployment.kbf.sellerPools()) == config.sellerPools, "standalone: wrong seller pools");
        require(
            results.rewardsStartEpoch(address(deployment.kbf)) == results.REWARDS_OFF(), "standalone: rewards enabled"
        );
        require(results.isAudit(address(deployment.kbf)), "standalone: KBF is not an audit");
        require(address(deployment.kbf.results()) == address(results), "standalone: wrong KBF results");
        require(IAntseedRegistry(config.registry).emissions() == emissions, "standalone: registry changed");
        require(
            IAntseedRegistry(config.registry).identityRegistry() == identityRegistry, "standalone: registry changed"
        );

        console.log("=== Standalone verification split deployment complete ===");
        console.log("Owner:                 ", config.owner);
        console.log("AntseedRegistry:       ", config.registry);
        console.log("SellerPools:           ", config.sellerPools);
        console.log("Emissions gate:        ", gate);
        console.log("VerificationResults:   ", address(results));
        console.log("KbfAudits:             ", address(deployment.kbf));
        console.log("VerificationPolicy:    ", address(deployment.policy));
        console.log("Rewards start epoch:   ", results.rewardsStartEpoch(address(deployment.kbf)));
        console.log("Policy:                deployed, not registered");
    }

    function _validate(Config memory config) private view {
        require(block.chainid == config.expectedChainId, "standalone: wrong chain");
        require(config.owner != address(0), "standalone: missing owner");
        require(config.registry.code.length != 0, "standalone: missing registry");
        require(config.sellerPools.code.length != 0, "standalone: missing seller pools");
        require(config.usageAccounting.code.length != 0, "standalone: missing usage accounting");
        // The points policy reads seller pools through usage accounting; KBF's staking check reads
        // SELLER_POOLS. Both must be the same contract.
        require(
            IStandaloneUsageAccounting(config.usageAccounting).sellerPools() == config.sellerPools,
            "standalone: usage accounting uses other seller pools"
        );
        require(config.bonusBps <= 5_000, "standalone: bonus above cap");

        address emissions = IAntseedRegistry(config.registry).emissions();
        require(emissions.code.length != 0, "standalone: missing emissions");
        require(
            IAntseedRegistry(config.registry).identityRegistry() != address(0), "standalone: missing identity registry"
        );

        for (uint256 index; index < config.auditors.length; index++) {
            require(config.auditors[index] != address(0), "standalone: zero auditor");
        }
    }

    /// @dev After M001 the registry's emissions entry is usage accounting, which exposes the gate;
    ///      otherwise the entry is the gate itself.
    function _emissionsGate(address emissions) private view returns (address gate) {
        gate = emissions;
        try IStandaloneEmissionsGateSource(emissions).emissionsGate() returns (address source) {
            if (source.code.length != 0) gate = source;
        } catch { }
    }
}
