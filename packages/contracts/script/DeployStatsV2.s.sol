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
 * Afterwards, in this order:
 *   1. DeployAttributionUsage / DeployReferrals / DeployClientRewards with
 *      ANTSEED_STATS=<statsV2>, then statsV2.setAttributionUsage(...) and
 *      statsV2.setReferrals(...). Wire the sinks BEFORE re-pointing the
 *      registry: settlements Stats forwards while a sink is still unset are
 *      never attributed.
 *   2. Record `contracts.stats` = statsV2 (with its deploymentBlock) in
 *      deployments/<network>/current.json and regenerate chain config, so
 *      statsContractAddress / statsDeployBlock move together.
 *   3. AntseedRegistry.setStats(statsV2) — Channels and FreeUsage resolve it live.
 *
 * Channels open across the cutover report their cumulative totals once as a
 * first delta in the new contract. The network-stats indexer nets that
 * re-report against what it already indexed for the channel (no DB reset);
 * any other consumer summing MetadataRecorded deltas must do the same.
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
        console.log("Next: AntseedRegistry.setStats(statsV2), then deploy AttributionUsage, Referrals and ClientRewards against it.");
    }
}
