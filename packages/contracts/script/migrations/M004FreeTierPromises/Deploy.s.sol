// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { IAntseedRegistry } from "../../../interfaces/IAntseedRegistry.sol";
import { AntseedFreeTierTerms } from "../../../sellers/AntseedFreeTierTerms.sol";

interface IM004UsageAccounting {
    function emissionsGate() external view returns (address);
}

interface IM004SellerRegistry {
    function identityRegistry() external view returns (address);
}

/// @notice M004: deploys the staked free-tier promise board, `AntseedFreeTierTerms(registry, emissionsGate,
///         identityRegistry)`, from `FREE_TIER_DEPLOYER` at `FREE_TIER_DEPLOYMENT_NONCE`. The board has no
///         owner and nothing is wired to it. It reads the seller registry through `registry.staking()`, the
///         epoch from the emissions gate (usage accounting's `emissionsGate()`), and agent owners from the
///         identity registry, which must be the one the registry and its seller registry use.
///         Re-runnable: a board already at the predicted address is checked, not deployed again.
contract M004DeployFreeTierPromises is Script {
    struct Config {
        uint256 chainId;
        address registry;
        address identityRegistry;
        address usageAccounting;
        address emissionsGate;
        address deployer;
        uint256 deploymentNonce;
    }

    function run() external returns (AntseedFreeTierTerms) {
        return runWith(
            Config({
                chainId: vm.envUint("EXPECTED_CHAIN_ID"),
                registry: vm.envAddress("ANTSEED_REGISTRY"),
                identityRegistry: vm.envAddress("EXPECTED_IDENTITY_REGISTRY"),
                usageAccounting: vm.envAddress("USAGE_ACCOUNTING"),
                emissionsGate: vm.envAddress("EMISSIONS_GATE"),
                deployer: vm.envAddress("FREE_TIER_DEPLOYER"),
                deploymentNonce: vm.envUint("FREE_TIER_DEPLOYMENT_NONCE")
            })
        );
    }

    function predict(Config memory config) public pure returns (address) {
        return vm.computeCreateAddress(config.deployer, config.deploymentNonce);
    }

    function runWith(Config memory config) public returns (AntseedFreeTierTerms board) {
        _validate(config);
        address predicted = predict(config);
        board = AntseedFreeTierTerms(predicted);
        if (predicted.code.length == 0) {
            vm.startBroadcast(config.deployer);
            require(vm.getNonce(config.deployer) == config.deploymentNonce, "M004: deployment nonce changed");
            board = new AntseedFreeTierTerms(config.registry, config.emissionsGate, config.identityRegistry);
            vm.stopBroadcast();
            require(address(board) == predicted, "M004: unexpected board address");
        }
        require(address(board.registry()) == config.registry, "M004: wrong board registry");
        require(address(board.gate()) == config.emissionsGate, "M004: wrong board gate");
        require(address(board.identity()) == config.identityRegistry, "M004: wrong board identity registry");
    }

    function _validate(Config memory config) private view {
        require(block.chainid == config.chainId, "M004: wrong chain");
        require(config.registry.code.length > 0, "M004: missing registry");
        require(config.identityRegistry.code.length > 0, "M004: missing identity registry");
        require(
            IAntseedRegistry(config.registry).identityRegistry() == config.identityRegistry,
            "M004: wrong identity registry"
        );
        address sellerRegistry = IAntseedRegistry(config.registry).staking();
        require(sellerRegistry.code.length > 0, "M004: missing seller registry");
        require(
            IM004SellerRegistry(sellerRegistry).identityRegistry() == config.identityRegistry,
            "M004: seller registry uses another identity registry"
        );
        require(
            IAntseedRegistry(config.registry).emissions() == config.usageAccounting,
            "M004: registry emissions is not usage accounting"
        );
        require(config.emissionsGate.code.length > 0, "M004: missing emissions gate");
        require(
            IM004UsageAccounting(config.usageAccounting).emissionsGate() == config.emissionsGate,
            "M004: wrong emissions gate"
        );
        require(config.deployer != address(0), "M004: missing deployer");
    }
}
