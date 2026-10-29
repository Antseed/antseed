pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { IAntseedRegistry } from "../../../interfaces/IAntseedRegistry.sol";
import { AntseedPointsPolicyRegistry } from "../../../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedKbfVerificationPointsPolicy } from "../../../policies/AntseedKbfVerificationPointsPolicy.sol";
import { AntseedKbfVerification } from "../../../verification/AntseedKbfVerification.sol";

interface IM003UsageAccounting {
    function sellerPools() external view returns (address);
    function pointsPolicy() external view returns (address);
    function emissionsGate() external view returns (address);
}

contract M003DeployVerificationRegistry is Script {
    struct Config {
        uint256 chainId;
        address registry;
        address identityRegistry;
        address sellerPools;
        address usageAccounting;
        address pointsPolicyRegistry;
        address owner;
        uint256 deploymentNonce;
        uint256 bonusBps;
        address[] auditors;
    }

    function run() external returns (AntseedKbfVerification, AntseedKbfVerificationPointsPolicy) {
        return runWith(
            Config({
                chainId: vm.envUint("EXPECTED_CHAIN_ID"),
                registry: vm.envAddress("ANTSEED_REGISTRY"),
                identityRegistry: vm.envAddress("EXPECTED_IDENTITY_REGISTRY"),
                sellerPools: vm.envAddress("SELLER_POOLS"),
                usageAccounting: vm.envAddress("USAGE_ACCOUNTING"),
                pointsPolicyRegistry: vm.envAddress("POINTS_POLICY_REGISTRY"),
                owner: vm.envAddress("VERIFICATION_OWNER"),
                deploymentNonce: vm.envUint("VERIFICATION_DEPLOYMENT_NONCE"),
                bonusBps: vm.envUint("VERIFICATION_BONUS_BPS"),
                auditors: vm.envOr("VERIFICATION_AUDITORS", ",", new address[](0))
            })
        );
    }

    function runWith(Config memory config)
        public
        returns (AntseedKbfVerification verification, AntseedKbfVerificationPointsPolicy policy)
    {
        _validate(config);
        address predictedVerification = vm.computeCreateAddress(config.owner, config.deploymentNonce);
        address predictedPolicy = vm.computeCreateAddress(config.owner, config.deploymentNonce + 1);
        verification = AntseedKbfVerification(predictedVerification);
        policy = AntseedKbfVerificationPointsPolicy(predictedPolicy);
        AntseedPointsPolicyRegistry pointsPolicyRegistry = AntseedPointsPolicyRegistry(config.pointsPolicyRegistry);

        vm.startBroadcast(config.owner);
        if (predictedVerification.code.length == 0) {
            require(vm.getNonce(config.owner) == config.deploymentNonce, "M003: deployment nonce changed");
            verification = new AntseedKbfVerification(config.registry, config.sellerPools);
            require(address(verification) == predictedVerification, "M003: unexpected deployment address");
        }
        if (predictedPolicy.code.length == 0) {
            require(vm.getNonce(config.owner) == config.deploymentNonce + 1, "M003: policy nonce changed");
            policy = new AntseedKbfVerificationPointsPolicy(
                address(verification), config.usageAccounting, config.bonusBps, config.owner
            );
            require(address(policy) == predictedPolicy, "M003: unexpected policy address");
        }
        require(address(verification.registry()) == config.registry, "M003: wrong registry");
        require(address(verification.sellerPools()) == config.sellerPools, "M003: wrong seller pools");
        require(
            address(verification.emissionsGate()) == IM003UsageAccounting(config.usageAccounting).emissionsGate(),
            "M003: wrong emissions gate"
        );
        require(verification.owner() == config.owner, "M003: wrong owner");
        require(verification.pendingOwner() == address(0), "M003: pending ownership transfer");
        require(address(policy.verification()) == address(verification), "M003: wrong policy verification");
        require(address(policy.usageAccounting()) == config.usageAccounting, "M003: wrong policy usage accounting");
        require(policy.owner() == config.owner, "M003: wrong policy owner");
        require(policy.pendingOwner() == address(0), "M003: pending policy ownership transfer");
        for (uint256 index; index < config.auditors.length; index++) {
            address auditor = config.auditors[index];
            if (!verification.approvedAuditors(auditor)) verification.setAuditor(auditor, true);
            require(verification.approvedAuditors(auditor), "M003: auditor not approved");
        }
        if (!pointsPolicyRegistry.isPolicyRegistered(address(policy))) {
            pointsPolicyRegistry.registerPolicy(address(policy));
        }
        require(pointsPolicyRegistry.isPolicyRegistered(address(policy)), "M003: policy not registered");
        vm.stopBroadcast();
    }

    function _validate(Config memory config) private view {
        require(block.chainid == config.chainId, "M003: wrong chain");
        require(config.registry.code.length > 0, "M003: missing registry");
        require(config.identityRegistry.code.length > 0, "M003: missing identity registry");
        require(
            IAntseedRegistry(config.registry).identityRegistry() == config.identityRegistry,
            "M003: wrong identity registry"
        );
        require(config.sellerPools.code.length > 0, "M003: missing seller pools");
        require(config.usageAccounting.code.length > 0, "M003: missing usage accounting");
        require(
            IM003UsageAccounting(config.usageAccounting).sellerPools() == config.sellerPools,
            "M003: wrong usage accounting seller pools"
        );
        require(
            IAntseedRegistry(config.registry).emissions() == config.usageAccounting,
            "M003: registry emissions is not usage accounting"
        );
        require(
            IM003UsageAccounting(config.usageAccounting).emissionsGate().code.length > 0,
            "M003: missing emissions gate"
        );
        require(config.pointsPolicyRegistry.code.length > 0, "M003: missing points policy registry");
        require(
            IM003UsageAccounting(config.usageAccounting).pointsPolicy() == config.pointsPolicyRegistry,
            "M003: wrong points policy registry"
        );
        require(
            AntseedPointsPolicyRegistry(config.pointsPolicyRegistry).owner() == config.owner,
            "M003: owner does not own points policy registry"
        );
        require(config.owner != address(0), "M003: missing owner");
        require(config.bonusBps <= 5_000, "M003: bonus above cap");
        for (uint256 index; index < config.auditors.length; index++) {
            require(config.auditors[index] != address(0), "M003: zero auditor");
        }
    }
}
