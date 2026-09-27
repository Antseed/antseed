// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";

/**
 * @title DeployClientRewards
 * @notice Deploys the emissions-gate controller that pays clients by recognized usage.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   EMISSIONS_GATE
 *   CLIENT_USAGE           — AntseedClientUsage ledger
 *   IDENTITY_REGISTRY      — ERC-8004 IdentityRegistry
 *
 * The controller pays nothing until governance registers it as a gate minter
 * (`AntseedEmissionsGate.setMinter`) with its own minter id and share.
 */
contract DeployClientRewards is Script {
    function run() external returns (AntseedClientRewards rewards) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address gate = vm.envAddress("EMISSIONS_GATE");
        address clientUsage = vm.envAddress("CLIENT_USAGE");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");

        vm.startBroadcast(deployerPrivateKey);
        rewards = new AntseedClientRewards(gate, clientUsage, identityRegistry);
        vm.stopBroadcast();

        console.log("AntseedClientRewards:", address(rewards));
        console.log("Next: register as a gate minter; clients claim per epoch via claim(agentId, epoch).");
    }
}
