// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";

contract ReferralToken is ERC20 {
    constructor() ERC20("ANTS", "ANTS") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

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

    ReferralToken private ants;
    ReferralUsageAccountingMock private accounting;
    ReferralUsageRewardsMock private rewards;
    ReferralDepositsMock private deposits;
    AntseedReferrals private referrals;

    function setUp() public {
        ants = new ReferralToken();
        accounting = new ReferralUsageAccountingMock();
        rewards = new ReferralUsageRewardsMock();
        deposits = new ReferralDepositsMock();
        referrals = new AntseedReferrals(address(ants), address(accounting), address(rewards), address(deposits), binder);
    }

    function test_bindAndAccrueTwoPercentOfBuyerRewards() public {
        _bind(referrer);
        assertEq(referrals.referredCount(referrer), 1);
        rewards.setReward(buyer, 10, 100 ether);
        rewards.setReward(buyer, 11, 25 ether);
        accounting.setCurrentEpoch(12);

        _fund(10 ether);
        referrals.accrue(buyer, 11);

        assertEq(referrals.claimable(referrer), 2.5 ether);
        assertEq(referrals.nextAccrualEpoch(buyer), 12);
        assertEq(referrals.unallocated(), 7.5 ether);

        vm.prank(referrer);
        referrals.claim();
        assertEq(ants.balanceOf(referrer), 2.5 ether);
        assertEq(referrals.totalClaimable(), 0);
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
        accounting.setCurrentEpoch(11);
        _fund(10 ether);

        referrals.accrue(buyer, 10);
        assertEq(referrals.claimable(referrer), 0);
        assertEq(referrals.nextAccrualEpoch(buyer), 11);
    }

    function test_accrualDoesNotAdvanceWhenUnderfunded() public {
        _bind(referrer);
        rewards.setReward(buyer, 10, 100 ether);
        accounting.setCurrentEpoch(11);

        vm.expectRevert(AntseedReferrals.InsufficientFunding.selector);
        referrals.accrue(buyer, 10);
        assertEq(referrals.nextAccrualEpoch(buyer), 10);
    }

    function test_accrualRejectsUnfinalizedEpochAndIsIdempotent() public {
        _bind(referrer);
        rewards.setReward(buyer, 10, 100 ether);
        accounting.setCurrentEpoch(11);
        _fund(10 ether);

        vm.expectRevert(AntseedReferrals.EpochNotFinalized.selector);
        referrals.accrue(buyer, 11);

        referrals.accrue(buyer, 10);
        referrals.accrue(buyer, 10); // no-op
        assertEq(referrals.claimable(referrer), 2 ether);
    }

    function test_withdrawExcessNeverTouchesClaimable() public {
        _bind(referrer);
        rewards.setReward(buyer, 10, 100 ether);
        accounting.setCurrentEpoch(11);
        _fund(10 ether);
        referrals.accrue(buyer, 10); // 2 ether promised

        vm.expectRevert(AntseedReferrals.InvalidAmount.selector);
        referrals.withdrawExcess(address(this), 8 ether + 1);

        referrals.withdrawExcess(address(this), 8 ether);
        assertEq(ants.balanceOf(address(referrals)), 2 ether);

        vm.prank(stranger);
        vm.expectRevert();
        referrals.withdrawExcess(stranger, 1);
    }

    function _bind(address referralWallet) private {
        vm.prank(binder);
        referrals.bindReferral(buyer, referralWallet);
    }

    function _fund(uint256 amount) private {
        ants.mint(address(this), amount);
        ants.approve(address(referrals), amount);
        referrals.fund(amount);
    }
}
