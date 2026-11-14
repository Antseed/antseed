// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";
import { whitelistRewardController } from "./WhitelistRewardController.sol";

/**
 * @title DeployClientRewards
 * @notice Deploys the contract that credits recognized usage to clients and
 *         pays them through the emissions gate.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   EMISSIONS_GATE
 *   USAGE_ACCOUNTING
 *   SELLER_POOLS           — AntseedSellerPools, for staking a reward instead of claiming it
 *   IDENTITY_REGISTRY      — ERC-8004 IdentityRegistry (clients register there)
 *
 * DeployChannelsMiddleware then authorizes the middleware as its recorder.
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
        address sellerPools = vm.envAddress("SELLER_POOLS");

        vm.startBroadcast(deployerPrivateKey);
        rewards = new AntseedClientRewards(gate, usageAccounting, identityRegistry, address(0));
        rewards.setSellerPools(sellerPools);
        whitelistRewardController(sellerPools, address(rewards), vm.addr(deployerPrivateKey));
        vm.stopBroadcast();

        console.log("AntseedClientRewards:", address(rewards));
        console.log("Next: DeployChannelsMiddleware, then RegisterAttributionMinters.");
    }
}
