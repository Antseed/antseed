// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedPointsPolicyRegistry } from "../../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../../policies/AntseedWashTradingPointsPolicy.sol";

contract M001RecognizedUsageTest is Test {
    AntseedRegistry internal registry;

    address internal constant LEGACY_EMISSIONS = address(0x1001);
    address internal constant LEGACY_STAKING = address(0x1002);
    address internal constant USAGE_ACCOUNTING = address(0x2001);
    address internal constant SELLER_REGISTRY = address(0x2002);
    address internal constant VERIFICATION_WALLET = address(0x3001);
    bytes32 internal constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");

    function setUp() public {
        registry = new AntseedRegistry();
        registry.setEmissions(LEGACY_EMISSIONS);
        registry.setStaking(LEGACY_STAKING);
    }

    function test_cutoverStartingStateAcceptsLegacyAndCompletedPointers() public {
        _assertExpectedStartingState();

        registry.setEmissions(USAGE_ACCOUNTING);
        _assertExpectedStartingState();

        registry.setStaking(SELLER_REGISTRY);
        _assertExpectedStartingState();
    }

    function test_cutoverStartingStateRejectsUnknownEmissions() public {
        registry.setEmissions(address(0xDEAD));
        vm.expectRevert("unexpected emissions starting state");
        this.assertExpectedStartingState();
    }

    function test_cutoverStartingStateRejectsUnknownStaking() public {
        registry.setStaking(address(0xBEEF));
        vm.expectRevert("unexpected staking starting state");
        this.assertExpectedStartingState();
    }

    function test_m001LeavesVerificationConfigurationWithDeployer() public {
        AntseedEmissionsGate gate = new AntseedEmissionsGate(address(0x4001), address(0x4002), 15_000, 15_000);
        AntseedPointsPolicyRegistry pointsPolicyRegistry = new AntseedPointsPolicyRegistry(address(this));
        AntseedWashTradingPointsPolicy washPolicy = new AntseedWashTradingPointsPolicy(address(0x5001));
        pointsPolicyRegistry.registerPolicy(address(washPolicy));

        gate.setMinter(VERIFICATION_MINTER_ID, VERIFICATION_WALLET, 10_000, true);
        (address controller, uint32 shareBps, bool editable) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controller, VERIFICATION_WALLET);
        assertEq(shareBps, 10_000);
        assertTrue(editable);
        assertEq(pointsPolicyRegistry.policyCount(), 1);
        assertTrue(pointsPolicyRegistry.isPolicyRegistered(address(washPolicy)));
        assertEq(gate.owner(), address(this));
        assertEq(gate.pendingOwner(), address(0));
        assertEq(pointsPolicyRegistry.owner(), address(this));
        assertEq(pointsPolicyRegistry.pendingOwner(), address(0));
    }

    function assertExpectedStartingState() external view {
        _assertExpectedStartingState();
    }

    function _assertExpectedStartingState() internal view {
        address emissions = registry.emissions();
        require(emissions == LEGACY_EMISSIONS || emissions == USAGE_ACCOUNTING, "unexpected emissions starting state");

        address staking = registry.staking();
        require(staking == LEGACY_STAKING || staking == SELLER_REGISTRY, "unexpected staking starting state");
    }
}
