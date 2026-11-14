// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";
import { AntseedChannelsMiddleware } from "../payments/AntseedChannelsMiddleware.sol";
import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";

/**
 * @title DeployChannelsMiddleware
 * @notice Deploys the middleware, authorizes it on AntseedClientRewards and
 *         AntseedReferrals, and offers both controllers to the protocol owner,
 *         which accepts them in script/ActivateChannelsMiddleware.s.sol. Nothing
 *         routes through the middleware until that script runs.
 *
 * Run by the owner of both controllers, after DeployClientRewards and DeployReferrals.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   ANTSEED_REGISTRY         — the main AntseedRegistry
 *   USAGE_ACCOUNTING
 *   ANTSEED_CLIENT_REWARDS
 *   ANTSEED_REFERRALS
 *   ANTSEED_CHANNELS
 *   ANTSEED_FREE_USAGE
 *   PROTOCOL_OWNER           — owner of Stats, Channels and accounting
 */
contract DeployChannelsMiddleware is Script {
    function run() external returns (AntseedChannelsMiddleware middleware) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address clientRewards = vm.envAddress("ANTSEED_CLIENT_REWARDS");
        address referrals = vm.envAddress("ANTSEED_REFERRALS");
        address protocolOwner = vm.envAddress("PROTOCOL_OWNER");

        vm.startBroadcast(deployerPrivateKey);
        middleware = new AntseedChannelsMiddleware(
            vm.envAddress("ANTSEED_REGISTRY"),
            vm.envAddress("USAGE_ACCOUNTING"),
            clientRewards,
            referrals,
            vm.envAddress("ANTSEED_CHANNELS"),
            vm.envAddress("ANTSEED_FREE_USAGE")
        );
        AntseedClientRewards(clientRewards).setRecorder(address(middleware));
        AntseedReferrals(referrals).setBinder(address(middleware));
        AntseedClientRewards(clientRewards).transferOwnership(protocolOwner);
        AntseedReferrals(referrals).transferOwnership(protocolOwner);
        vm.stopBroadcast();

        console.log("AntseedChannelsMiddleware:", address(middleware));
        console.log("Next: RegisterAttributionMinters, then ActivateChannelsMiddleware.");
    }
}
