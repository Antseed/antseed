// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";

/**
 * @title DeployClientRewards
 * @notice Deploys the contract that credits recognized usage to clients and
 *         pays them through the emissions gate.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   EMISSIONS_GATE
 *   USAGE_ACCOUNTING
 *   IDENTITY_REGISTRY      — ERC-8004 IdentityRegistry (clients register there)
 *   ANTSEED_STATS          — the AntseedStatsV2 deployment that forwards settlements
 *
 * Afterwards (owner of AntseedStatsV2):
 *   cast send $ANTSEED_STATS "setClientRewards(address)" <rewards>
 *
 * The controller pays nothing until the gate owner registers it as a gate
 * minter with script/RegisterAttributionMinters.s.sol (client rewards 4%).
 */
contract DeployClientRewards is Script {
    function run() external returns (AntseedClientRewards rewards) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address gate = vm.envAddress("EMISSIONS_GATE");
        address usageAccounting = vm.envAddress("USAGE_ACCOUNTING");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");
        address stats = vm.envAddress("ANTSEED_STATS");

        vm.startBroadcast(deployerPrivateKey);
        rewards = new AntseedClientRewards(gate, usageAccounting, identityRegistry, stats);
        vm.stopBroadcast();

        console.log("AntseedClientRewards:", address(rewards));
        console.log("Next: StatsV2.setClientRewards, register as a gate minter; clients claim per epoch via claim(agentId, epoch).");
    }
}
