// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";

/**
 * @title DeployReferrals
 * @notice Deploys the two-sided referral program (bindings, activity-based invites,
 *         emission-funded referrer and referee rewards).
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   EMISSIONS_GATE
 *   USAGE_ACCOUNTING
 *   SELLER_POOLS           — AntseedSellerPools, for staking a reward instead of claiming it
 *   ANTSEED_DEPOSITS
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/DeployReferrals.s.sol --rpc-url $BASE_MAINNET_RPC_URL --broadcast --verify --via-ir
 *
 * DeployChannelsMiddleware then authorizes the middleware as its binder. Record it as `contracts.referrals` in deployments/<network>/current.json
 * so `scripts/generate-contract-chain-config.mjs` emits `referralsAddress` for
 * every client; `payments.crypto.referralsAddress` in config.json overrides it
 * per install (CLI and Desktop both read that key). The controller pays
 * nothing until the gate owner registers it as a gate minter with
 * script/RegisterAttributionMinters.s.sol (referrals 2%).
 */
contract DeployReferrals is Script {
    function run() external returns (AntseedReferrals referrals) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address gate = vm.envAddress("EMISSIONS_GATE");
        address usageAccounting = vm.envAddress("USAGE_ACCOUNTING");
        address deposits = vm.envAddress("ANTSEED_DEPOSITS");

        vm.startBroadcast(deployerPrivateKey);
        referrals = new AntseedReferrals(gate, usageAccounting, deposits, address(0));
        referrals.setSellerPools(vm.envAddress("SELLER_POOLS"));
        vm.stopBroadcast();

        console.log("AntseedReferrals:", address(referrals));
        console.log("Next: DeployChannelsMiddleware, then RegisterAttributionMinters, then set payments.crypto.referralsAddress.");
    }
}
