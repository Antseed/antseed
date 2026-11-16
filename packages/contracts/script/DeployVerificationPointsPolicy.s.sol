// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IAntseedVerificationResults } from "../interfaces/IAntseedVerificationResults.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import {
    AntseedVerificationPointsPolicy,
    IAntseedSellerPoolsSource
} from "../policies/AntseedVerificationPointsPolicy.sol";

/// @title DeployVerificationPointsPolicy
/// @notice Deploys only `AntseedVerificationPointsPolicy` against the live results layer, for a policy
///         change that leaves the results layer and the KBF audit in place. M003 deploys all three
///         together, so it can't do this. The script registers nothing and sets no penalty: the new
///         policy changes no points until the registry owner registers it.
///
/// Required environment:
///   EXPECTED_CHAIN_ID       Target chain ID.
///   VERIFICATION_RESULTS    Live `AntseedVerificationResults`.
///   KBF_AUDITS              Live `AntseedKbfAudits`; must be an approved audit on the results layer.
///   USAGE_ACCOUNTING        Live usage accounting, read by the policy for `sellerPools()`.
///   POINTS_POLICY_REGISTRY  Live `AntseedPointsPolicyRegistry`, checked and never written.
///   POLICY_OWNER            Owner of the new policy.
///
/// Optional environment:
///   VERIFICATION_BONUS_BPS  Bonus per verified service (0 to 5000, default 0).
///
/// Example dry run (add --broadcast --verify --account <name> to send):
///   forge script script/DeployVerificationPointsPolicy.s.sol --rpc-url "$RPC_URL" --sender "$POLICY_OWNER"
contract DeployVerificationPointsPolicy is Script {
    struct Config {
        uint256 expectedChainId;
        address results;
        address kbfAudits;
        address usageAccounting;
        address pointsPolicyRegistry;
        address owner;
        uint256 bonusBps;
    }

    error WrongChain(uint256 expected, uint256 actual);
    error InvalidOwner();
    error NoCode(address target);
    error KbfNotAnAudit(address kbfAudits);
    error NoSellerPools(address usageAccounting);
    error DeployedPolicyMismatch();

    function run() external returns (AntseedVerificationPointsPolicy) {
        return runWith(
            Config({
                expectedChainId: vm.envUint("EXPECTED_CHAIN_ID"),
                results: vm.envAddress("VERIFICATION_RESULTS"),
                kbfAudits: vm.envAddress("KBF_AUDITS"),
                usageAccounting: vm.envAddress("USAGE_ACCOUNTING"),
                pointsPolicyRegistry: vm.envAddress("POINTS_POLICY_REGISTRY"),
                owner: vm.envAddress("POLICY_OWNER"),
                bonusBps: vm.envOr("VERIFICATION_BONUS_BPS", uint256(0))
            })
        );
    }

    function runWith(Config memory config) public returns (AntseedVerificationPointsPolicy policy) {
        _check(config);

        vm.startBroadcast(config.owner);
        policy = new AntseedVerificationPointsPolicy(
            config.results, config.usageAccounting, config.bonusBps, config.owner
        );
        vm.stopBroadcast();

        if (
            policy.owner() != config.owner || policy.pendingOwner() != address(0)
                || address(policy.results()) != config.results
                || address(policy.usageAccounting()) != config.usageAccounting || policy.bonusBps() != config.bonusBps
                || policy.penaltyBps() != 0
                || AntseedPointsPolicyRegistry(config.pointsPolicyRegistry).isPolicyRegistered(address(policy))
        ) revert DeployedPolicyMismatch();

        console.log("AntseedVerificationPointsPolicy:", address(policy));
    }

    function _check(Config memory config) private view {
        if (block.chainid != config.expectedChainId) revert WrongChain(config.expectedChainId, block.chainid);
        if (config.owner == address(0)) revert InvalidOwner();
        address[4] memory targets =
            [config.results, config.kbfAudits, config.usageAccounting, config.pointsPolicyRegistry];
        for (uint256 index = 0; index < targets.length; ++index) {
            if (targets[index].code.length == 0) revert NoCode(targets[index]);
        }
        if (!IAntseedVerificationResults(config.results).isAudit(config.kbfAudits)) {
            revert KbfNotAnAudit(config.kbfAudits);
        }
        if (address(IAntseedSellerPoolsSource(config.usageAccounting).sellerPools()) == address(0)) {
            revert NoSellerPools(config.usageAccounting);
        }
    }
}
