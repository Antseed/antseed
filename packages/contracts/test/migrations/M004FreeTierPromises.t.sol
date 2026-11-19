// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { M004DeployFreeTierPromises } from "../../script/migrations/M004FreeTierPromises/Deploy.s.sol";
import { AntseedFreeTierTerms } from "../../sellers/AntseedFreeTierTerms.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { FreeTierGateMock } from "../freeTier/FreeTierFixtures.sol";

contract M004UsageAccounting {
    address public emissionsGate;

    constructor(address emissionsGate_) {
        emissionsGate = emissionsGate_;
    }
}

contract M004SellerRegistry {
    address public identityRegistry;

    constructor(address identity) {
        identityRegistry = identity;
    }

    function getAgentId(address) external pure returns (uint256) {
        return 0;
    }
}

contract M004FreeTierPromisesTest is Test {
    M004DeployFreeTierPromises private script;
    AntseedRegistry private registry;
    MockERC8004Registry private identity;
    FreeTierGateMock private gate;
    M004UsageAccounting private accounting;
    address private deployer = address(0xA11CE);

    function setUp() public {
        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        gate = new FreeTierGateMock();
        accounting = new M004UsageAccounting(address(gate));
        registry.setIdentityRegistry(address(identity));
        registry.setStaking(address(new M004SellerRegistry(address(identity))));
        registry.setEmissions(address(accounting));
        script = new M004DeployFreeTierPromises();
        vm.deal(deployer, 10 ether);
    }

    function config() private view returns (M004DeployFreeTierPromises.Config memory) {
        return M004DeployFreeTierPromises.Config({
            chainId: block.chainid,
            registry: address(registry),
            identityRegistry: address(identity),
            usageAccounting: address(accounting),
            emissionsGate: address(gate),
            deployer: deployer,
            deploymentNonce: vm.getNonce(deployer)
        });
    }

    function test_deploysAtThePredictedAddressAndRepeatsAsANoOp() public {
        M004DeployFreeTierPromises.Config memory settings = config();
        AntseedFreeTierTerms board = script.runWith(settings);
        assertEq(address(board), vm.computeCreateAddress(deployer, settings.deploymentNonce));
        assertEq(address(board.registry()), address(registry));
        assertEq(address(board.gate()), address(gate));
        assertEq(address(board.identity()), address(identity));

        uint64 nonce = vm.getNonce(deployer);
        vm.recordLogs();
        AntseedFreeTierTerms again = script.runWith(settings);
        assertEq(vm.getRecordedLogs().length, 0, "nothing is sent again");
        assertEq(vm.getNonce(deployer), nonce);
        assertEq(address(again), address(board));
    }

    function test_runReadsTheEnvironment() public {
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("ANTSEED_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("EXPECTED_IDENTITY_REGISTRY", vm.toString(address(identity)));
        vm.setEnv("USAGE_ACCOUNTING", vm.toString(address(accounting)));
        vm.setEnv("EMISSIONS_GATE", vm.toString(address(gate)));
        vm.setEnv("FREE_TIER_DEPLOYER", vm.toString(deployer));
        vm.setEnv("FREE_TIER_DEPLOYMENT_NONCE", vm.toString(vm.getNonce(deployer)));
        assertEq(address(script.run().gate()), address(gate));
    }

    function test_rejectsAMismatchedStack() public {
        M004DeployFreeTierPromises.Config memory settings = config();
        settings.chainId = block.chainid + 1;
        vm.expectRevert(bytes("M004: wrong chain"));
        script.runWith(settings);

        settings = config();
        settings.identityRegistry = address(new MockERC8004Registry());
        vm.expectRevert(bytes("M004: wrong identity registry"));
        script.runWith(settings);

        settings = config();
        settings.emissionsGate = address(new FreeTierGateMock());
        vm.expectRevert(bytes("M004: wrong emissions gate"));
        script.runWith(settings);

        settings = config();
        settings.usageAccounting = address(new M004UsageAccounting(address(gate)));
        vm.expectRevert(bytes("M004: registry emissions is not usage accounting"));
        script.runWith(settings);

        // A seller registry tied to another agent NFT contract than the board's.
        registry.setStaking(address(new M004SellerRegistry(address(new MockERC8004Registry()))));
        vm.expectRevert(bytes("M004: seller registry uses another identity registry"));
        script.runWith(config());
    }

    function test_stopsWhenTheNonceWasUsed() public {
        M004DeployFreeTierPromises.Config memory settings = config();
        vm.setNonce(deployer, uint64(settings.deploymentNonce + 1));
        vm.expectRevert(bytes("M004: deployment nonce changed"));
        script.runWith(settings);
    }
}
