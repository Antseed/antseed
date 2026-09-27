// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";

/**
 * @title DeployReferrals
 * @notice Deploys the emission-funded referral rewards controller.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   EMISSIONS_GATE
 *   USAGE_ACCOUNTING
 *   USAGE_REWARDS
 *   ANTSEED_DEPOSITS
 *   ANTSEED_STATS          — the AntseedStatsV2 deployment that forwards bindings
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployReferrals.s.sol --rpc-url $BASE_MAINNET_RPC_URL --broadcast --verify --via-ir
 *
 * Afterwards (owner of AntseedStatsV2):
 *   cast send $ANTSEED_STATS "setReferrals(address)" <referrals>
 * then set payments.crypto.referralsAddress in chain config. The controller
 * pays nothing until governance registers it as a gate minter
 * (`AntseedEmissionsGate.setMinter`) with its own minter id and share.
 */
contract DeployReferrals is Script {
    function run() external returns (AntseedReferrals referrals) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address gate = vm.envAddress("EMISSIONS_GATE");
        address usageAccounting = vm.envAddress("USAGE_ACCOUNTING");
        address usageRewards = vm.envAddress("USAGE_REWARDS");
        address deposits = vm.envAddress("ANTSEED_DEPOSITS");
        address stats = vm.envAddress("ANTSEED_STATS");

        vm.startBroadcast(deployerPrivateKey);
        referrals = new AntseedReferrals(gate, usageAccounting, usageRewards, deposits, stats);
        vm.stopBroadcast();

        console.log("AntseedReferrals:", address(referrals));
        console.log("Referral rate (bps):", referrals.REFERRAL_RATE_BPS());
        console.log("Next: AntseedStatsV2.setReferrals(referrals), register as a gate minter, set payments.crypto.referralsAddress.");
    }
}
