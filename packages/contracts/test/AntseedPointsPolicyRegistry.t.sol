// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { IAntseedPointsModifier } from "../interfaces/IAntseedPointsModifier.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";

contract MockPointsModifier is IAntseedPointsModifier {
    uint256 internal immutable _sellerMultiplierBps;
    uint256 internal immutable _buyerMultiplierBps;
    bool internal immutable _reverts;

    constructor(uint256 sellerMultiplierBps, uint256 buyerMultiplierBps, bool reverts_) {
        _sellerMultiplierBps = sellerMultiplierBps;
        _buyerMultiplierBps = buyerMultiplierBps;
        _reverts = reverts_;
    }

    function points(bytes32, address, address, uint256 sellerPoints, uint256 buyerPoints)
        external
        view
        returns (uint256, uint256)
    {
        if (_reverts) revert("policy failure");
        return (sellerPoints * _sellerMultiplierBps / 10_000, buyerPoints * _buyerMultiplierBps / 10_000);
    }
}

contract AddingPointsModifier is IAntseedPointsModifier {
    function points(bytes32, address, address, uint256 sellerPoints, uint256 buyerPoints)
        external
        pure
        returns (uint256, uint256)
    {
        return (sellerPoints + 100, buyerPoints + 200);
    }
}

contract ContextCheckingPointsModifier is IAntseedPointsModifier {
    function points(bytes32 channelId, address buyer, address seller, uint256 sellerPoints, uint256 buyerPoints)
        external
        pure
        returns (uint256, uint256)
    {
        require(channelId == bytes32(uint256(7)) && buyer == address(0xB0B) && seller == address(0xA11CE));
        require(sellerPoints == 500 && buyerPoints == 2_000);
        return (sellerPoints, buyerPoints);
    }
}

contract InvalidPointsModifier { }

contract PointsPolicyRegistryTest is Test {
    bytes32 internal constant CHANNEL_ID = bytes32(uint256(7));
    address internal constant BUYER = address(0xB0B);
    address internal constant SELLER = address(0xA11CE);
    AntseedPointsPolicyRegistry internal registry;

    function setUp() public {
        registry = new AntseedPointsPolicyRegistry(address(this));
    }

    function test_emptyRegistryPassesRawPointsThrough() public view {
        _assertPoints(1_000, 1_000);
    }

    function test_policiesReceivePreviousOutputAndOriginalContext() public {
        registry.registerPolicy(address(new MockPointsModifier(5_000, 20_000, false)));
        registry.registerPolicy(address(new ContextCheckingPointsModifier()));
        _assertPoints(500, 2_000);
    }

    function test_adjustmentsCompoundWithoutCategoryMergingOrCaps() public {
        registry.registerPolicy(address(new MockPointsModifier(30_000, 100, false)));
        registry.registerPolicy(address(new MockPointsModifier(40_000, 5_000, false)));
        _assertPoints(12_000, 5);
    }

    function test_policiesRunInRegistrationOrder() public {
        MockPointsModifier scaling = new MockPointsModifier(20_000, 20_000, false);
        AddingPointsModifier adding = new AddingPointsModifier();
        registry.registerPolicy(address(scaling));
        registry.registerPolicy(address(adding));
        _assertPoints(2_100, 2_200);

        registry.removePolicy(address(scaling));
        registry.registerPolicy(address(scaling));
        _assertPoints(2_200, 2_400);
    }

    function test_zeroRawPointsSkipsAllPolicies() public {
        registry.registerPolicy(address(new MockPointsModifier(10_000, 10_000, true)));
        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 0);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 0);
    }

    function test_zeroResultReturnsBeforeRevertingPolicy() public {
        registry.registerPolicy(address(new MockPointsModifier(0, 0, false)));
        registry.registerPolicy(address(new MockPointsModifier(10_000, 10_000, true)));
        _assertPoints(0, 0);
    }

    function test_zeroResultCannotBeRevivedByLaterPolicy() public {
        registry.registerPolicy(address(new MockPointsModifier(0, 0, false)));
        registry.registerPolicy(address(new AddingPointsModifier()));
        _assertPoints(0, 0);
    }

    function test_zeroedSellerStaysZeroWhileBuyerContinues() public {
        registry.registerPolicy(address(new MockPointsModifier(0, 10_000, false)));
        registry.registerPolicy(address(new AddingPointsModifier()));
        _assertPoints(0, 1_200);
    }

    function test_zeroedBuyerStaysZeroWhileSellerContinues() public {
        registry.registerPolicy(address(new MockPointsModifier(10_000, 0, false)));
        registry.registerPolicy(address(new AddingPointsModifier()));
        _assertPoints(1_100, 0);
    }

    function test_separateSideVetoesStopRemainingPolicies() public {
        registry.registerPolicy(address(new MockPointsModifier(0, 10_000, false)));
        registry.registerPolicy(address(new MockPointsModifier(10_000, 0, false)));
        registry.registerPolicy(address(new MockPointsModifier(10_000, 10_000, true)));
        _assertPoints(0, 0);
    }

    function test_registrationRemovalPreservesOrderAndIndexes() public {
        MockPointsModifier first = new MockPointsModifier(10_000, 10_000, false);
        MockPointsModifier second = new MockPointsModifier(20_000, 20_000, false);
        MockPointsModifier third = new MockPointsModifier(30_000, 30_000, false);
        registry.registerPolicy(address(first));
        registry.registerPolicy(address(second));
        registry.registerPolicy(address(third));
        assertEq(registry.policyAt(1), address(second));

        registry.removePolicy(address(second));
        assertEq(registry.policyCount(), 2);
        assertEq(registry.policyAt(0), address(first));
        assertEq(registry.policyAt(1), address(third));
        assertFalse(registry.isPolicyRegistered(address(second)));
        registry.removePolicy(address(third));
        registry.removePolicy(address(first));
        assertEq(registry.policyCount(), 0);
        registry.registerPolicy(address(second));
        assertEq(registry.policyAt(0), address(second));
        assertTrue(registry.isPolicyRegistered(address(second)));
    }

    function test_registrationRejectsInvalidAndDuplicateAddresses() public {
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(0));
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(0xBEEF));
        vm.expectRevert(AntseedPointsPolicyRegistry.InvalidPolicy.selector);
        registry.registerPolicy(address(registry));

        MockPointsModifier policy = new MockPointsModifier(10_000, 10_000, false);
        registry.registerPolicy(address(policy));
        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyAlreadyRegistered.selector, address(policy))
        );
        registry.registerPolicy(address(policy));
    }

    function test_removingUnknownPolicyReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(AntseedPointsPolicyRegistry.PolicyNotRegistered.selector, address(0xBEEF))
        );
        registry.removePolicy(address(0xBEEF));
    }

    function test_registrationEnforcesPolicyLimit() public {
        for (uint256 index = 0; index < registry.MAX_POLICIES(); ++index) {
            registry.registerPolicy(address(new MockPointsModifier(10_000, 10_000, false)));
        }
        MockPointsModifier overflowPolicy = new MockPointsModifier(10_000, 10_000, false);
        vm.expectRevert(AntseedPointsPolicyRegistry.TooManyPolicies.selector);
        registry.registerPolicy(address(overflowPolicy));
    }

    function test_onlyOwnerCanRegisterOrRemovePolicies() public {
        MockPointsModifier policy = new MockPointsModifier(10_000, 10_000, false);
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", BUYER));
        registry.registerPolicy(address(policy));
        registry.registerPolicy(address(policy));
        vm.prank(BUYER);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", BUYER));
        registry.removePolicy(address(policy));
    }

    function test_policyFailureBubbles() public {
        registry.registerPolicy(address(new MockPointsModifier(10_000, 10_000, true)));
        vm.expectRevert("policy failure");
        registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
    }

    function test_missingPointsEntryPointRevertsEvaluation() public {
        registry.registerPolicy(address(new InvalidPointsModifier()));
        vm.expectRevert();
        registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
    }

    function testFuzz_zeroResultSkipsLaterPolicy(uint128 rawPoints) public {
        registry.registerPolicy(address(new MockPointsModifier(0, 0, false)));
        registry.registerPolicy(address(new MockPointsModifier(10_000, 10_000, true)));
        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, rawPoints);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 0);
    }

    function _assertPoints(uint256 expectedSeller, uint256 expectedBuyer) internal view {
        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(CHANNEL_ID, BUYER, SELLER, 1_000);
        assertEq(sellerPoints, expectedSeller);
        assertEq(buyerPoints, expectedBuyer);
    }
}
