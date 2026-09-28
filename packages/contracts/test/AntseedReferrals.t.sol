// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";
import { AntseedEpochShareRewards } from "../emissions/AntseedEpochShareRewards.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";

contract ReferralUsageAccountingMock {
    uint256 public currentEpoch = 10;
    mapping(address => uint256) public usage;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }

    function setUsage(address buyer, uint256 points) external {
        usage[buyer] = points;
    }

    function buyerUsageTotal(address buyer) external view returns (uint256 points, uint256 weightedPoints) {
        points = usage[buyer];
        weightedPoints = points;
    }
}

contract ReferralDepositsMock {
    mapping(address => address) public operator;

    function setOperator(address buyer, address value) external {
        operator[buyer] = value;
    }

    function getOperator(address buyer) external view returns (address) {
        return operator[buyer];
    }
}

contract ReferrerLedgerMock {
    mapping(uint256 => mapping(address => uint256)) public referrerEpochPoints;
    mapping(uint256 => uint256) public totalReferrerPointsByEpoch;

    function credit(uint256 epoch, address referrer, uint256 points) external {
        referrerEpochPoints[epoch][referrer] += points;
        totalReferrerPointsByEpoch[epoch] += points;
    }
}

contract AntseedReferralsTest is Test {
    address private buyer = address(0xB0B);
    address private referrer = address(0xA11CE);
    address private otherReferrer = address(0xA11CF);
    address private binder = address(0x57A75);
    address private stranger = address(0xBEEF);

    EmissionsGateMock private gate;
    ReferralUsageAccountingMock private accounting;
    ReferralDepositsMock private deposits;
    ReferrerLedgerMock private ledger;
    AntseedReferrals private referrals;

    function setUp() public {
        gate = new EmissionsGateMock();
        accounting = new ReferralUsageAccountingMock();
        deposits = new ReferralDepositsMock();
        ledger = new ReferrerLedgerMock();
        referrals = new AntseedReferrals(address(gate), address(accounting), address(deposits), address(ledger), binder);
    }

    function test_loneReferrerTakesTheWholeBucketAndOthersDiluteIt() public {
        ledger.credit(10, referrer, 30);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(12); // finalized plus one grace epoch
        assertEq(referrals.pendingReward(referrer, 10), 100 ether);

        ledger.credit(11, referrer, 30);
        ledger.credit(11, otherReferrer, 10);
        gate.setBudget(address(referrals), 11, 100 ether);
        gate.setCurrentEpoch(13);
        assertEq(referrals.pendingReward(referrer, 11), 75 ether);
        assertEq(referrals.pendingReward(otherReferrer, 11), 25 ether);

        uint256[] memory epochs = new uint256[](2);
        epochs[0] = 10;
        epochs[1] = 11;
        referrals.claimEpochs(referrer, epochs);
        assertEq(gate.balanceOf(referrer), 175 ether);
        assertTrue(referrals.claimed(referrer, 10));

        // Late ledger credits never change a frozen denominator.
        ledger.credit(11, otherReferrer, 1000);
        referrals.claim(otherReferrer, 11);
        assertEq(gate.balanceOf(otherReferrer), 25 ether);

        vm.expectRevert(AntseedEpochShareRewards.AlreadyClaimed.selector);
        referrals.claim(referrer, 10);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claimEpochs(referrer, epochs);
    }

    function test_epochsNeedAGraceEpochAndABucket() public {
        ledger.credit(10, referrer, 1);
        gate.setCurrentEpoch(11);
        assertFalse(referrals.isClaimable(10));
        vm.expectRevert(AntseedEpochShareRewards.EpochNotClaimable.selector);
        referrals.claim(referrer, 10);

        gate.setCurrentEpoch(12);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claim(referrer, 10); // controller not registered as a minter: budget 0

        gate.setBudget(address(referrals), 10, 5 ether);
        referrals.claim(referrer, 10);
        assertEq(gate.balanceOf(referrer), 5 ether);
    }

    function test_epochWithoutPointsIsSweptToBurnAndReserve() public {
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);
        vm.expectRevert(AntseedEpochShareRewards.EpochNotClaimable.selector);
        referrals.settleEpochRemainder(10);

        gate.setCurrentEpoch(12);
        (uint256 burned, uint256 reserved) = referrals.settleEpochRemainder(10);
        assertEq(burned, 30 ether);
        assertEq(reserved, 70 ether);
        assertEq(gate.balanceOf(gate.DEAD_ADDRESS()), 30 ether);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 70 ether);
        assertTrue(referrals.epochFrozen(10));
        assertEq(referrals.frozenTotalPoints(10), 0);
        vm.expectRevert(AntseedEpochShareRewards.AlreadyClaimed.selector);
        referrals.settleEpochRemainder(10);

        // A late credit cannot resurrect the swept epoch: its total is frozen at zero.
        ledger.credit(10, referrer, 5);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claim(referrer, 10);

        // Epochs with claimants keep their bucket for them.
        ledger.credit(11, referrer, 1);
        gate.setBudget(address(referrals), 11, 100 ether);
        gate.setCurrentEpoch(13);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.settleEpochRemainder(11);
        referrals.claim(referrer, 11);
        assertEq(gate.balanceOf(referrer), 100 ether);
    }

    function test_onlyBinderCanBind() public {
        vm.prank(stranger);
        vm.expectRevert(AntseedReferrals.NotBinder.selector);
        referrals.bindReferral(buyer, referrer);

        referrals.setBinder(address(0));
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.NotBinder.selector);
        referrals.bindReferral(buyer, referrer);
    }

    function test_bindRejectsUsageSelfReferralAndRebinding() public {
        accounting.setUsage(buyer, 1);
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.ReferralMustPrecedeUsage.selector);
        referrals.bindReferral(buyer, referrer);

        accounting.setUsage(buyer, 0);
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.SelfReferral.selector);
        referrals.bindReferral(buyer, buyer);

        address operator = address(0x1234);
        deposits.setOperator(buyer, operator);
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.SelfReferral.selector);
        referrals.bindReferral(buyer, operator);

        vm.prank(binder);
        referrals.bindReferral(buyer, referrer);
        assertEq(referrals.referredCount(referrer), 1);
        assertEq(referrals.boundAtEpoch(buyer), 10);
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.ReferralAlreadyBound.selector);
        referrals.bindReferral(buyer, stranger);
        assertEq(referrals.referrerOf(buyer), referrer);
    }
}
