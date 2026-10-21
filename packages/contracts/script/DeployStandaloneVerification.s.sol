// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { AntseedVerification } from "../verification/AntseedVerification.sol";

/// @title DeployStandaloneVerification
/// @notice Deploys the verification registry without installing a points policy or enabling rewards.
///
/// This is intentionally separate from M003. It only reads the existing registry and seller-pools
/// addresses, then deploys one independently owned AntseedVerification contract. It does not call
/// any policy registry, usage-accounting setter, emissions-gate setter, or rewards setter.
///
/// Required environment:
///   EXPECTED_CHAIN_ID       Target chain ID.
///   ANTSEED_REGISTRY        Existing compatible AntseedRegistry address.
///   SELLER_POOLS             Existing compatible AntseedSellerPools address.
///   STANDALONE_OWNER         New wallet that will own the verification contract.
///
/// Optional environment:
///   VERIFICATION_AUDITORS    Comma-separated auditor addresses to approve at deployment.
///
/// The owner address is supplied to startBroadcast, but this script never reads a private key.
/// Use a new keystore, hardware wallet, or an explicitly supplied Foundry signer when broadcasting.
///
/// Example dry run:
///   forge script script/DeployStandaloneVerification.s.sol \
///     --rpc-url "$RPC_URL" --sender "$STANDALONE_OWNER" --via-ir
///
/// Example broadcast (with a new signer, not the AntSeed production deployer):
///   forge script script/DeployStandaloneVerification.s.sol \
///     --rpc-url "$RPC_URL" --sender "$STANDALONE_OWNER" \
///     --account standalone-owner --broadcast --via-ir
contract DeployStandaloneVerification is Script {
    struct Config {
        uint256 expectedChainId;
        address registry;
        address sellerPools;
        address owner;
        address[] auditors;
    }

    function run() external returns (AntseedVerification verification) {
        return runWith(
            Config({
                expectedChainId: vm.envUint("EXPECTED_CHAIN_ID"),
                registry: vm.envAddress("ANTSEED_REGISTRY"),
                sellerPools: vm.envAddress("SELLER_POOLS"),
                owner: vm.envAddress("STANDALONE_OWNER"),
                auditors: vm.envOr("VERIFICATION_AUDITORS", ",", new address[](0))
            })
        );
    }

    function runWith(Config memory config) public returns (AntseedVerification verification) {
        _validate(config);

        address emissions = IAntseedRegistry(config.registry).emissions();
        address identityRegistry = IAntseedRegistry(config.registry).identityRegistry();

        vm.startBroadcast(config.owner);
        verification = new AntseedVerification(config.registry, config.sellerPools);
        for (uint256 index; index < config.auditors.length; index++) {
            address auditor = config.auditors[index];
            verification.setAuditor(auditor, true);
        }
        vm.stopBroadcast();

        // These postconditions make an accidental policy/rewards coupling fail loudly in a dry run.
        require(verification.owner() == config.owner, "standalone: wrong owner");
        require(address(verification.registry()) == config.registry, "standalone: wrong registry");
        require(address(verification.sellerPools()) == config.sellerPools, "standalone: wrong seller pools");
        require(verification.rewardsStartEpoch() == type(uint256).max, "standalone: rewards enabled");
        require(IAntseedRegistry(config.registry).emissions() == emissions, "standalone: registry changed");
        require(
            IAntseedRegistry(config.registry).identityRegistry() == identityRegistry, "standalone: registry changed"
        );

        console.log("=== Standalone verification deployment complete ===");
        console.log("Owner:                 ", config.owner);
        console.log("AntseedRegistry:       ", config.registry);
        console.log("SellerPools:           ", config.sellerPools);
        console.log("Emissions source:      ", emissions);
        console.log("Verification:          ", address(verification));
        console.log("Rewards start epoch:   ", verification.rewardsStartEpoch());
        console.log("Policy:                not deployed or registered");
    }

    function _validate(Config memory config) private view {
        require(block.chainid == config.expectedChainId, "standalone: wrong chain");
        require(config.owner != address(0), "standalone: missing owner");
        require(config.registry.code.length != 0, "standalone: missing registry");
        require(config.sellerPools.code.length != 0, "standalone: missing seller pools");

        address emissions = IAntseedRegistry(config.registry).emissions();
        require(emissions.code.length != 0, "standalone: missing emissions source");
        require(
            IAntseedRegistry(config.registry).identityRegistry() != address(0), "standalone: missing identity registry"
        );

        for (uint256 index; index < config.auditors.length; index++) {
            require(config.auditors[index] != address(0), "standalone: zero auditor");
        }
    }
}
