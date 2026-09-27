// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";
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

contract ReferralUsageRewardsMock {
    mapping(address => mapping(uint256 => uint256)) public rewards;

    function setReward(address buyer, uint256 epoch, uint256 amount) external {
        rewards[buyer][epoch] = amount;
    }

    function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256) {
        return rewards[buyer][epoch];
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

contract AntseedReferralsTest is Test {
    address private buyer = address(0xB0B);
    address private referrer = address(0xA11CE);
    address private binder = address(0x57A75);
    address private stranger = address(0xBEEF);

    EmissionsGateMock private gate;
    ReferralUsageAccountingMock private accounting;
    ReferralUsageRewardsMock private rewards;
    ReferralDepositsMock private deposits;
    AntseedReferrals private referrals;

    function setUp() public {
        gate = new EmissionsGateMock();
        accounting = new ReferralUsageAccountingMock();
        rewards = new ReferralUsageRewardsMock();
        deposits = new ReferralDepositsMock();
        referrals = new AntseedReferrals(address(gate), address(accounting), address(rewards), address(deposits), binder);
    }

    function _advance(uint256 epoch) private {
        accounting.setCurrentEpoch(epoch);
        gate.setCurrentEpoch(epoch);
    }

    function test_bindAccrueAndClaimTwoPercentFromEpochBuckets() public {
        _bind(referrer);
        assertEq(referrals.referredCount(referrer), 1);
        rewards.setReward(buyer, 10, 100 ether);
        rewards.setReward(buyer, 11, 25 ether);
        _advance(12);
        gate.setBudget(address(referrals), 10, 5 ether);
        gate.setBudget(address(referrals), 11, 5 ether);

        referrals.accrue(buyer, 11);
        assertEq(referrals.claimable(referrer), 2.5 ether);
        assertEq(referrals.claimableByEpoch(referrer, 10), 2 ether);
        assertEq(referrals.epochEntitled(11), 0.5 ether);
        assertEq(referrals.nextAccrualEpoch(buyer), 12);
        assertEq(referrals.payableAmount(referrer), 2.5 ether);

        vm.prank(referrer);
        referrals.claim();
        assertEq(gate.balanceOf(referrer), 2.5 ether);
        assertEq(referrals.claimable(referrer), 0);
        assertEq(referrals.epochMinted(10), 2 ether);
        assertEq(referrals.claimableEpochs(referrer).length, 0);

        vm.prank(referrer);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.claim();
    }

    function test_claimPaysWhatTheBucketAllowsAndKeepsTheRest() public {
        _bind(referrer);
        rewards.setReward(buyer, 10, 100 ether); // entitlement 2 ether
        _advance(11);
        gate.setBudget(address(referrals), 10, 1.5 ether);
        referrals.accrue(buyer, 10);

        assertEq(referrals.payableAmount(referrer), 1.5 ether);
        vm.prank(referrer);
        referrals.claim();
        assertEq(gate.balanceOf(referrer), 1.5 ether);
        assertEq(referrals.claimable(referrer), 0.5 ether);
        assertEq(referrals.claimableEpochs(referrer).length, 1);

        // No bucket at all (controller not registered yet): nothing payable, entitlement kept.
        gate.setBudget(address(referrals), 10, 1.5 ether);
        vm.prank(referrer);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.claim();

        gate.setBudget(address(referrals), 10, 2 ether);
        vm.prank(referrer);
        referrals.claimEpoch(10);
        assertEq(gate.balanceOf(referrer), 2 ether);
        assertEq(referrals.claimable(referrer), 0);
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

        _bind(referrer);
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.ReferralAlreadyBound.selector);
        referrals.bindReferral(buyer, stranger);
        assertEq(referrals.referrerOf(buyer), referrer);
    }

    function test_accrualSkipsRewardWhenReferrerBecomesOperator() public {
        _bind(referrer);
        deposits.setOperator(buyer, referrer); // operator authorized after the first settlement
        rewards.setReward(buyer, 10, 100 ether);
        _advance(11);

        referrals.accrue(buyer, 10);
        assertEq(referrals.claimable(referrer), 0);
        assertEq(referrals.nextAccrualEpoch(buyer), 11);
    }

    function test_accrualRejectsUnfinalizedEpochAndIsIdempotent() public {
        _bind(referrer);
        rewards.setReward(buyer, 10, 100 ether);
        _advance(11);

        vm.expectRevert(AntseedReferrals.EpochNotFinalized.selector);
        referrals.accrue(buyer, 11);

        referrals.accrue(buyer, 10);
        referrals.accrue(buyer, 10); // no-op
        assertEq(referrals.claimable(referrer), 2 ether);
        assertEq(referrals.claimableEpochs(referrer).length, 1);
    }

    function _bind(address referralWallet) private {
        vm.prank(binder);
        referrals.bindReferral(buyer, referralWallet);
    }
}
