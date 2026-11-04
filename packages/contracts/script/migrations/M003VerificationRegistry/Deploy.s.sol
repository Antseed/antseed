// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { IAntseedRegistry } from "../../../interfaces/IAntseedRegistry.sol";
import { IAntseedVerificationResults } from "../../../interfaces/IAntseedVerificationResults.sol";
import { AntseedVerificationPointsPolicy } from "../../../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedKbfAudits } from "../../../verification/AntseedKbfAudits.sol";
import { AntseedVerificationResults } from "../../../verification/AntseedVerificationResults.sol";

interface IM003UsageAccounting {
    function sellerPools() external view returns (address);
    function pointsPolicy() external view returns (address);
    function emissionsGate() external view returns (address);
}

/// @notice M003: deploys the verification contracts. From `VERIFICATION_OWNER` at
///         `VERIFICATION_DEPLOYMENT_NONCE`, in order:
///         N   `AntseedVerificationResults(emissionsGate)`
///         N+1 `AntseedKbfAudits(results, sellerPools, identityRegistry)`
///         N+2 `AntseedVerificationPointsPolicy(results, usageAccounting, bonusBps, owner)`
///         then wires KBF as an audit on the results layer (`setAudit`, `setAuditShareBps` 10,000).
///         Re-runnable: deploys whose predicted address has code, and wiring already in place, are
///         skipped. Everything the verification owner cannot do itself (the emissions gate's minter
///         controller, the points policy registry) and the auditor approvals stay manual; see README.
///         Replaces M003's earlier single-contract deployment (`AntseedKbfVerification`).
contract M003DeployVerificationRegistry is Script {
    uint16 public constant KBF_SHARE_BPS = 10_000;

    struct Config {
        uint256 chainId;
        address registry;
        address identityRegistry;
        address sellerPools;
        address usageAccounting;
        address pointsPolicyRegistry;
        address owner;
        uint256 deploymentNonce;
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
                chainId: vm.envUint("EXPECTED_CHAIN_ID"),
                registry: vm.envAddress("ANTSEED_REGISTRY"),
                identityRegistry: vm.envAddress("EXPECTED_IDENTITY_REGISTRY"),
                sellerPools: vm.envAddress("SELLER_POOLS"),
                usageAccounting: vm.envAddress("USAGE_ACCOUNTING"),
                pointsPolicyRegistry: vm.envAddress("POINTS_POLICY_REGISTRY"),
                owner: vm.envAddress("VERIFICATION_OWNER"),
                deploymentNonce: vm.envUint("VERIFICATION_DEPLOYMENT_NONCE"),
                bonusBps: vm.envOr("VERIFICATION_BONUS_BPS", uint256(0))
            })
        );
    }

    /// @notice The three CREATE addresses M003 deploys to, in deployment order.
    function predict(Config memory config) public pure returns (address, address, address) {
        return (
            vm.computeCreateAddress(config.owner, config.deploymentNonce),
            vm.computeCreateAddress(config.owner, config.deploymentNonce + 1),
            vm.computeCreateAddress(config.owner, config.deploymentNonce + 2)
        );
    }

    function runWith(Config memory config) public returns (Deployment memory deployment) {
        _validate(config);
        (address predictedResults, address predictedKbf, address predictedPolicy) = predict(config);
        deployment = Deployment({
            results: AntseedVerificationResults(predictedResults),
            kbf: AntseedKbfAudits(predictedKbf),
            policy: AntseedVerificationPointsPolicy(predictedPolicy)
        });

        vm.startBroadcast(config.owner);
        if (predictedResults.code.length == 0) {
            require(vm.getNonce(config.owner) == config.deploymentNonce, "M003: deployment nonce changed");
            deployment.results =
                new AntseedVerificationResults(IM003UsageAccounting(config.usageAccounting).emissionsGate());
            require(address(deployment.results) == predictedResults, "M003: unexpected results address");
        }
        if (predictedKbf.code.length == 0) {
            require(vm.getNonce(config.owner) == config.deploymentNonce + 1, "M003: KBF nonce changed");
            deployment.kbf = new AntseedKbfAudits(predictedResults, config.sellerPools, config.identityRegistry);
            require(address(deployment.kbf) == predictedKbf, "M003: unexpected KBF address");
        }
        if (predictedPolicy.code.length == 0) {
            require(vm.getNonce(config.owner) == config.deploymentNonce + 2, "M003: policy nonce changed");
            deployment.policy = new AntseedVerificationPointsPolicy(
                predictedResults, config.usageAccounting, config.bonusBps, config.owner
            );
            require(address(deployment.policy) == predictedPolicy, "M003: unexpected policy address");
        }
        // Wiring the verification owner can do itself: the KBF audit writes verdicts and gets the
        // whole verification bucket until another audit is added.
        if (!deployment.results.isAudit(predictedKbf)) deployment.results.setAudit(predictedKbf, true);
        if (deployment.results.auditShareBps(predictedKbf) != KBF_SHARE_BPS) {
            deployment.results.setAuditShareBps(predictedKbf, KBF_SHARE_BPS);
        }
        vm.stopBroadcast();

        _check(config, deployment);
    }

    function _check(Config memory config, Deployment memory deployment) private view {
        AntseedVerificationResults results = deployment.results;
        AntseedKbfAudits kbf = deployment.kbf;
        AntseedVerificationPointsPolicy policy = deployment.policy;

        require(
            address(results.emissionsGate()) == IM003UsageAccounting(config.usageAccounting).emissionsGate(),
            "M003: wrong emissions gate"
        );
        require(results.owner() == config.owner, "M003: wrong results owner");
        require(results.pendingOwner() == address(0), "M003: pending results ownership transfer");
        require(results.isAudit(address(kbf)), "M003: KBF is not an audit");
        require(results.auditShareBps(address(kbf)) == KBF_SHARE_BPS, "M003: wrong KBF share");
        require(results.rewardsStartEpoch(address(kbf)) == results.REWARDS_OFF(), "M003: KBF rewards enabled");

        require(address(kbf.results()) == address(results), "M003: wrong KBF results");
        require(address(kbf.sellerPools()) == config.sellerPools, "M003: wrong seller pools");
        require(address(kbf.identityRegistry()) == config.identityRegistry, "M003: wrong KBF identity registry");
        require(kbf.validityEpochs() == 2, "M003: wrong KBF validity");
        require(kbf.owner() == config.owner, "M003: wrong KBF owner");
        require(kbf.pendingOwner() == address(0), "M003: pending KBF ownership transfer");
        // Confirmations: a DIFF is recorded only once a second auditor reports it; SAME and
        // UNDETERMINED are recorded on one report.
        require(kbf.requiredReports(IAntseedVerificationResults.Verdict.SAME) == 1, "M003: wrong SAME reports");
        require(kbf.requiredReports(IAntseedVerificationResults.Verdict.DIFF) == 2, "M003: wrong DIFF reports");
        require(
            kbf.requiredReports(IAntseedVerificationResults.Verdict.UNDETERMINED) == 1,
            "M003: wrong UNDETERMINED reports"
        );

        require(address(policy.results()) == address(results), "M003: wrong policy results");
        require(address(policy.usageAccounting()) == config.usageAccounting, "M003: wrong policy usage accounting");
        require(policy.owner() == config.owner, "M003: wrong policy owner");
        require(policy.pendingOwner() == address(0), "M003: pending policy ownership transfer");
    }

    function _validate(Config memory config) private view {
        require(block.chainid == config.chainId, "M003: wrong chain");
        require(config.registry.code.length > 0, "M003: missing registry");
        require(config.identityRegistry.code.length > 0, "M003: missing identity registry");
        require(
            IAntseedRegistry(config.registry).identityRegistry() == config.identityRegistry,
            "M003: wrong identity registry"
        );
        require(config.sellerPools.code.length > 0, "M003: missing seller pools");
        require(config.usageAccounting.code.length > 0, "M003: missing usage accounting");
        require(
            IM003UsageAccounting(config.usageAccounting).sellerPools() == config.sellerPools,
            "M003: wrong usage accounting seller pools"
        );
        require(
            IAntseedRegistry(config.registry).emissions() == config.usageAccounting,
            "M003: registry emissions is not usage accounting"
        );
        require(
            IM003UsageAccounting(config.usageAccounting).emissionsGate().code.length > 0, "M003: missing emissions gate"
        );
        require(config.pointsPolicyRegistry.code.length > 0, "M003: missing points policy registry");
        require(
            IM003UsageAccounting(config.usageAccounting).pointsPolicy() == config.pointsPolicyRegistry,
            "M003: wrong points policy registry"
        );
        require(config.owner != address(0), "M003: missing owner");
        require(config.bonusBps <= 5_000, "M003: bonus above cap");
    }
}
