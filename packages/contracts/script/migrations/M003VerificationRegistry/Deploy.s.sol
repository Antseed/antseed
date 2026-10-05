pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { IAntseedRegistry } from "../../../interfaces/IAntseedRegistry.sol";
import { AntseedVerification } from "../../../verification/AntseedVerification.sol";

contract M003DeployVerificationRegistry is Script {
    struct Config {
        uint256 chainId;
        address registry;
        address identityRegistry;
        address owner;
        uint256 deploymentNonce;
        address[] verifiers;
    }

    function run() external returns (AntseedVerification) {
        return runWith(
            Config({
                chainId: vm.envUint("EXPECTED_CHAIN_ID"),
                registry: vm.envAddress("ANTSEED_REGISTRY"),
                identityRegistry: vm.envAddress("EXPECTED_IDENTITY_REGISTRY"),
                owner: vm.envAddress("VERIFICATION_OWNER"),
                deploymentNonce: vm.envUint("VERIFICATION_DEPLOYMENT_NONCE"),
                verifiers: vm.envOr("VERIFICATION_VERIFIERS", ",", new address[](0))
            })
        );
    }

    function runWith(Config memory config) public returns (AntseedVerification verification) {
        require(block.chainid == config.chainId, "M003: wrong chain");
        require(config.registry.code.length > 0, "M003: missing registry");
        require(config.identityRegistry.code.length > 0, "M003: missing identity registry");
        require(
            IAntseedRegistry(config.registry).identityRegistry() == config.identityRegistry,
            "M003: wrong identity registry"
        );
        require(config.owner != address(0), "M003: missing owner");
        for (uint256 index; index < config.verifiers.length; index++) {
            require(config.verifiers[index] != address(0), "M003: zero verifier");
        }

        address predicted = vm.computeCreateAddress(config.owner, config.deploymentNonce);
        verification = AntseedVerification(predicted);
        vm.startBroadcast(config.owner);
        if (predicted.code.length == 0) {
            require(vm.getNonce(config.owner) == config.deploymentNonce, "M003: deployment nonce changed");
            verification = new AntseedVerification(config.registry);
            require(address(verification) == predicted, "M003: unexpected deployment address");
        }
        require(address(verification.registry()) == config.registry, "M003: wrong registry");
        require(verification.owner() == config.owner, "M003: wrong owner");
        require(verification.pendingOwner() == address(0), "M003: pending ownership transfer");
        for (uint256 index; index < config.verifiers.length; index++) {
            address verifier = config.verifiers[index];
            if (!verification.approvedVerifiers(verifier)) verification.setVerifier(verifier, true);
            require(verification.approvedVerifiers(verifier), "M003: verifier not approved");
        }
        vm.stopBroadcast();
    }
}
