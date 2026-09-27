// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedStatsV2 } from "../stats/AntseedStatsV2.sol";

/**
 * @title DeployStatsV2
 * @notice Deploys the attribution-aware stats sink.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTSEED_CHANNELS
 *   ANTSEED_FREE_USAGE
 *
 * Afterwards:
 *   AntseedRegistry.setStats(statsV2)            — Channels and FreeUsage resolve it live
 *   DeployReferrals / DeployClientUsage with ANTSEED_STATS=<statsV2>
 *   statsV2.setReferrals(...), statsV2.setClientUsage(...)
 *   chain-config statsContractAddress / statsDeployBlock; network-stats indexer
 *
 * Channels open across the cutover report their cumulative totals once as a
 * first delta in the new contract.
 */
contract DeployStatsV2 is Script {
    function run() external returns (AntseedStatsV2 stats) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address channels = vm.envAddress("ANTSEED_CHANNELS");
        address freeUsage = vm.envAddress("ANTSEED_FREE_USAGE");

        vm.startBroadcast(deployerPrivateKey);
        stats = new AntseedStatsV2();
        stats.setWriter(channels, true);
        stats.setWriter(freeUsage, true);
        vm.stopBroadcast();

        console.log("AntseedStatsV2:", address(stats));
        console.log("Next: AntseedRegistry.setStats(statsV2), then deploy Referrals and ClientUsage against it.");
    }
}
