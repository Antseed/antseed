// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedAttributionUsage } from "../emissions/AntseedAttributionUsage.sol";

/**
 * @title DeployAttributionUsage
 * @notice Deploys the per-client / per-referrer / per-referee recognized-usage ledger fed by AntseedStatsV2.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   USAGE_ACCOUNTING
 *   IDENTITY_REGISTRY      — ERC-8004 IdentityRegistry (clients register there)
 *   ANTSEED_DEPOSITS       — operator lookup for the self-referral guard
 *   ANTSEED_STATS          — the AntseedStatsV2 deployment that forwards settlements
 *
 * Afterwards (owner of AntseedStatsV2):
 *   cast send $ANTSEED_STATS "setAttributionUsage(address)" <ledger>
 *   ledger.setReferrals(<AntseedReferrals>) once Referrals is deployed against it
 */
contract DeployAttributionUsage is Script {
    function run() external returns (AntseedAttributionUsage ledger) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usageAccounting = vm.envAddress("USAGE_ACCOUNTING");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");
        address deposits = vm.envAddress("ANTSEED_DEPOSITS");
        address stats = vm.envAddress("ANTSEED_STATS");

        vm.startBroadcast(deployerPrivateKey);
        ledger = new AntseedAttributionUsage(usageAccounting, identityRegistry, deposits, stats);
        vm.stopBroadcast();

        console.log("AntseedAttributionUsage:", address(ledger));
        console.log("Next: AntseedStatsV2.setAttributionUsage(ledger); deploy Referrals against it and call ledger.setReferrals; register client agents in the ERC-8004 IdentityRegistry.");
    }
}
