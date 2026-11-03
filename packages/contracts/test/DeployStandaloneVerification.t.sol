// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedKbfVerification } from "../verification/AntseedKbfVerification.sol";
import { DeployStandaloneVerification } from "../script/DeployStandaloneVerification.s.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { MockVerificationEmissionsGate } from "./mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "./mocks/MockVerificationSellerPools.sol";

contract DeployStandaloneVerificationTest is Test {
    AntseedRegistry private registry;
    MockERC8004Registry private identity;
    MockVerificationEmissionsGate private emissions;
    MockVerificationSellerPools private sellerPools;
    DeployStandaloneVerification private script;

    address private owner = address(0xA11CE);
    address private auditor = address(0xB0B);

    function setUp() public {
        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        emissions = new MockVerificationEmissionsGate();
        sellerPools = new MockVerificationSellerPools();
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(emissions));
        script = new DeployStandaloneVerification();
        vm.deal(owner, 1 ether);
    }

    function _config() private view returns (DeployStandaloneVerification.Config memory config) {
        address[] memory auditors = new address[](1);
        auditors[0] = auditor;
        config = DeployStandaloneVerification.Config({
            expectedChainId: block.chainid,
            registry: address(registry),
            sellerPools: address(sellerPools),
            owner: owner,
            auditors: auditors
        });
    }

    function test_deploysOnlyVerificationWithRewardsOff() public {
        address originalEmissions = registry.emissions();
        address originalIdentity = registry.identityRegistry();
        uint64 originalOwnerNonce = vm.getNonce(owner);

        AntseedKbfVerification verification = script.runWith(_config());

        assertEq(verification.owner(), owner);
        assertEq(address(verification.registry()), address(registry));
        assertEq(address(verification.sellerPools()), address(sellerPools));
        assertEq(address(verification.emissionsGate()), address(emissions));
        assertEq(verification.rewardsStartEpoch(), type(uint256).max);
        assertTrue(verification.approvedAuditors(auditor));
        assertEq(registry.emissions(), originalEmissions);
        assertEq(registry.identityRegistry(), originalIdentity);
        assertEq(vm.getNonce(owner), originalOwnerNonce + 1 + _config().auditors.length);
    }

    function test_rejectsWrongChainBeforeDeployment() public {
        DeployStandaloneVerification.Config memory config = _config();
        config.expectedChainId++;

        vm.expectRevert("standalone: wrong chain");
        script.runWith(config);
        assertEq(vm.getNonce(owner), 0);
    }

    function test_rejectsZeroAuditorBeforeDeployment() public {
        DeployStandaloneVerification.Config memory config = _config();
        config.auditors[0] = address(0);

        vm.expectRevert("standalone: zero auditor");
        script.runWith(config);
        assertEq(vm.getNonce(owner), 0);
    }
}
