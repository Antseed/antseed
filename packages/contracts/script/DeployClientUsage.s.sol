// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedClientUsage } from "../emissions/AntseedClientUsage.sol";

/**
 * @title DeployClientUsage
 * @notice Deploys the per-client recognized-usage ledger fed by AntseedStats.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   USAGE_ACCOUNTING
 *   IDENTITY_REGISTRY      — ERC-8004 IdentityRegistry (clients register there)
 *   ANTSEED_STATS          — the AntseedStatsV2 deployment that forwards settlements
 *
 * Afterwards (owner of AntseedStatsV2):
 *   cast send $ANTSEED_STATS "setClientUsage(address)" <clientUsage>
 */
contract DeployClientUsage is Script {
    function run() external returns (AntseedClientUsage ledger) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usageAccounting = vm.envAddress("USAGE_ACCOUNTING");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");
        address stats = vm.envAddress("ANTSEED_STATS");

        vm.startBroadcast(deployerPrivateKey);
        ledger = new AntseedClientUsage(usageAccounting, identityRegistry, stats);
        vm.stopBroadcast();

        console.log("AntseedClientUsage:", address(ledger));
        console.log("Next: AntseedStatsV2.setClientUsage(ledger); register client agents in the ERC-8004 IdentityRegistry.");
    }
}
