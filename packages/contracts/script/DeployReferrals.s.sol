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
 *   ANTSEED_DEPOSITS
 *   ATTRIBUTION_USAGE      — AntseedAttributionUsage ledger (referrer points)
 *   ANTSEED_STATS          — the AntseedStatsV2 deployment that forwards bindings
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployReferrals.s.sol --rpc-url $BASE_MAINNET_RPC_URL --broadcast --verify --via-ir
 *
 * Afterwards:
 *   cast send $ANTSEED_STATS "setReferrals(address)" <referrals>       (Stats owner)
 *   cast send $ATTRIBUTION_USAGE "setReferrals(address)" <referrals>   (ledger owner)
 * then set payments.crypto.referralsAddress in chain config. The controller
 * pays nothing until governance registers it as a gate minter
 * (`AntseedEmissionsGate.setMinter`) with its own minter id and share.
 */
contract DeployReferrals is Script {
    function run() external returns (AntseedReferrals referrals) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address gate = vm.envAddress("EMISSIONS_GATE");
        address usageAccounting = vm.envAddress("USAGE_ACCOUNTING");
        address deposits = vm.envAddress("ANTSEED_DEPOSITS");
        address attributionUsage = vm.envAddress("ATTRIBUTION_USAGE");
        address stats = vm.envAddress("ANTSEED_STATS");

        vm.startBroadcast(deployerPrivateKey);
        referrals = new AntseedReferrals(gate, usageAccounting, deposits, attributionUsage, stats);
        vm.stopBroadcast();

        console.log("AntseedReferrals:", address(referrals));
        console.log("Next: StatsV2.setReferrals + ledger.setReferrals, register as a gate minter, set payments.crypto.referralsAddress.");
    }
}
