// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { AntseedSellerUnlockPolicy } from "../policies/AntseedSellerUnlockPolicy.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { ISetRegistry } from "../interfaces/IAntseedWiring.sol";

interface IAntseedRegistryAdmin is IAntseedRegistry {
    function setEmissions(address emissions) external;
}

interface IANTSTokenAdmin {
    function setTransferWhitelist(address account, bool allowed) external;
}

/**
 * @title UpgradeEmissionsV2BaseMainnet
 * @notice Deploys AntseedEmissionsV2 + seller rewards pool while keeping the
 *         deployed registry, token, channels, deposits, staking, and stats in place.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY   Owner/broadcaster key.
 *   ANTSEED_REGISTRY       Deployed AntseedRegistry address.
 *
 * Optional env:
 *   SELLER_UNLOCK_POLICY   Existing unlock policy. If unset, this script deploys one.
 *   DIEM_PROXY_SELLER      Optional seller/proxy address to make immediately claimable.
 *   WHITELIST_REWARDS_POOL Defaults to false. Enable later when seller claims should be transferable.
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/UpgradeEmissionsV2BaseMainnet.s.sol \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract UpgradeEmissionsV2BaseMainnet is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");

        IAntseedRegistryAdmin registry = IAntseedRegistryAdmin(registryAddress);
        address oldEmissions = registry.emissions();
        require(oldEmissions != address(0), "old emissions not set");

        vm.startBroadcast(deployerPrivateKey);

        console.log("=== AntSeed Emissions V2 Upgrade ===");
        console.log("Deployer:             ", deployer);
        console.log("Registry:             ", registryAddress);
        console.log("Old Emissions:        ", oldEmissions);
        console.log("ANTS Token:           ", registry.antsToken());
        console.log("");

        AntseedSellerRewardsPool rewardsPool = new AntseedSellerRewardsPool(registryAddress);
        console.log("SellerRewardsPool:    ", address(rewardsPool));

        bool whitelistRewardsPool = vm.envOr("WHITELIST_REWARDS_POOL", false);
        if (whitelistRewardsPool) {
            IANTSTokenAdmin(registry.antsToken()).setTransferWhitelist(address(rewardsPool), true);
            console.log("Rewards pool whitelisted for ANTS transfers");
        }

        address policyAddress = vm.envOr("SELLER_UNLOCK_POLICY", address(0));
        if (policyAddress == address(0)) {
            AntseedSellerUnlockPolicy policy = new AntseedSellerUnlockPolicy();
            policyAddress = address(policy);
            console.log("SellerUnlockPolicy:   ", policyAddress);

            address diemProxySeller = vm.envOr("DIEM_PROXY_SELLER", address(0));
            if (diemProxySeller != address(0)) {
                policy.setSellerEligibility(diemProxySeller, true);
                console.log("Diem proxy seller:    ", diemProxySeller);
            }
        } else {
            console.log("SellerUnlockPolicy:   ", policyAddress);
        }

        AntseedEmissionsV2 emissionsV2 = new AntseedEmissionsV2(registryAddress, oldEmissions, address(rewardsPool));
        console.log("EmissionsV2:          ", address(emissionsV2));
        console.log("Migration epoch:      ", emissionsV2.MIGRATION_EPOCH());
        console.log("Current epoch:        ", emissionsV2.currentEpoch());

        emissionsV2.setSellerUnlockPolicy(policyAddress);

        console.log("Buyer cap pct:        ", emissionsV2.MAX_BUYER_SHARE_PCT());

        // Optional explicit registry writes for uniform operational checks.
        ISetRegistry(address(emissionsV2)).setRegistry(registryAddress);
        ISetRegistry(address(rewardsPool)).setRegistry(registryAddress);

        // Final cutover: ANTSToken.mint will now accept EmissionsV2 and reject V1.
        registry.setEmissions(address(emissionsV2));

        vm.stopBroadcast();

        console.log("");
        console.log("=== Emissions V2 upgrade complete ===");
        console.log("Update chain config emissions address to:", address(emissionsV2));
        console.log("Seller rewards pool:                 ", address(rewardsPool));
        console.log("Seller unlock policy:                ", policyAddress);
    }
}
