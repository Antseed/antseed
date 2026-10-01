// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedAttributionUsage } from "../emissions/AntseedAttributionUsage.sol";
import { AntseedEpochShareRewards } from "../emissions/AntseedEpochShareRewards.sol";
import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

/// Accounting whose epoch follows the gate, as AntseedUsageAccounting's does.
contract RewardsAccountingMock {
    EmissionsGateMock private immutable gate;
    uint256 public firstRewardedEpoch = 18;
    mapping(address => uint256) private _weighted;

    constructor(EmissionsGateMock _gate) {
        gate = _gate;
    }

    function currentEpoch() external view returns (uint256) {
        return gate.currentEpoch();
    }

    function settle(address buyer, uint256 weightedDelta) external {
        _weighted[buyer] += weightedDelta;
    }

    function buyerUsageTotal(address buyer) external view returns (IAntseedUsageAccounting.BuyerUsage memory usage) {
        usage.points = _weighted[buyer];
        usage.weightedPoints = _weighted[buyer];
    }
}

contract RewardsDepositsMock {
    function getOperator(address) external pure returns (address) {
        return address(0);
    }
}

/// The real ledger feeding the real referral controller: a flush landing
/// after an epoch's total is frozen must not change that epoch's shares.
contract AntseedAttributionRewardsTest is Test {
    EmissionsGateMock private gate;
    RewardsAccountingMock private accounting;
    AntseedAttributionUsage private ledger;
    AntseedReferrals private referrals;

    address private stats = address(0x57A75);
    address private r1 = address(0xA1);
    address private honest = address(0xA2);
    address private r2 = address(0xA3);
    address private x1 = address(0xB1);
    address private x2 = address(0xB2);
    address private x3 = address(0xB3);

    function setUp() public {
        gate = new EmissionsGateMock();
        gate.setCurrentEpoch(20);
        accounting = new RewardsAccountingMock(gate);
        MockERC8004Registry identity = new MockERC8004Registry();
        RewardsDepositsMock deposits = new RewardsDepositsMock();
        ledger = new AntseedAttributionUsage(address(accounting), address(identity), address(deposits), stats);
        referrals = new AntseedReferrals(address(gate), address(accounting), address(deposits), address(ledger), stats);
        ledger.setReferrals(address(referrals));

        vm.startPrank(stats);
        referrals.bindReferral(x1, r1);
        referrals.bindReferral(x2, honest);
        referrals.bindReferral(x3, r2);
        vm.stopPrank();
    }

    function _settle(address buyer, uint256 weightedDelta) private {
        vm.prank(stats);
        ledger.record(buyer, 0);
        accounting.settle(buyer, weightedDelta);
    }

    function _flush(address buyer) private {
        address[] memory buyers = new address[](1);
        buyers[0] = buyer;
        ledger.flush(buyers);
    }

    function test_flushAfterTheFreezeCannotDrainAnEpochsBucket() public {
        _settle(x1, 1);
        _flush(x1);
        _settle(x2, 100);
        _flush(x2);
        _settle(x3, 1000); // left unflushed on purpose
        assertEq(ledger.totalReferrerPointsByEpoch(20), 101);

        gate.setCurrentEpoch(22);
        gate.setBudget(address(referrals), 20, 100 ether);
        referrals.claim(r1, 20); // freezes epoch 20 at 101 points
        assertEq(referrals.frozenTotalPoints(20), 101);

        _flush(x3); // lands in the oldest open epoch, never in the frozen one
        assertEq(ledger.referrerEpochPoints(20, r2), 0);
        assertEq(ledger.referrerEpochPoints(21, r2), 1000);
        assertEq(ledger.totalReferrerPointsByEpoch(20), 101);

        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claim(r2, 20);

        referrals.claim(honest, 20);
        assertEq(gate.balanceOf(honest), uint256(100 ether) * 100 / 101);
        assertEq(gate.balanceOf(r1), uint256(100 ether) / 101);

        gate.setCurrentEpoch(23);
        gate.setBudget(address(referrals), 21, 50 ether);
        referrals.claim(r2, 21);
        assertEq(gate.balanceOf(r2), 50 ether);
    }
}
