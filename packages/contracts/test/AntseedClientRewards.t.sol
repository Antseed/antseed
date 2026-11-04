// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";
import { SellerPoolsStakeMock } from "./mocks/SellerPoolsStakeMock.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

/// Cumulative weighted points per buyer, and a settable epoch total.
contract ClientAccountingMock {
    mapping(uint256 => uint256) public totalWeightedBuyerPointsByEpoch;
    mapping(address => uint256) private _weighted;

    function setTotal(uint256 epoch, uint256 points) external {
        totalWeightedBuyerPointsByEpoch[epoch] = points;
    }

    function settle(address buyer, uint256 weightedDelta) external {
        _weighted[buyer] += weightedDelta;
    }

    function buyerUsageTotal(address buyer) external view returns (IAntseedUsageAccounting.BuyerUsage memory usage) {
        usage.points = _weighted[buyer];
        usage.weightedPoints = _weighted[buyer];
    }
}

abstract contract ClientRewardsFixture is Test {
    EmissionsGateMock internal gate;
    ClientAccountingMock internal accounting;
    MockERC8004Registry internal identity;
    AntseedClientRewards internal rewards;

    address internal stats = address(0x57A75);
    address internal buyer = address(0xB0B);
    address internal desktopOwner = address(0xD1);
    address internal cliOwner = address(0xC1);
    uint256 internal desktop;
    uint256 internal cli;

    uint160 private _nextBuyer = 0xB000;

    function setUp() public {
        gate = new EmissionsGateMock();
        accounting = new ClientAccountingMock();
        identity = new MockERC8004Registry();
        rewards = new AntseedClientRewards(address(gate), address(accounting), address(identity), stats);
        vm.prank(desktopOwner);
        desktop = identity.register();
        vm.prank(cliOwner);
        cli = identity.register();
    }

    /// One settlement as the chain performs it: Stats callback, then accounting.
    function _settle(uint256 client, uint256 weightedDelta) internal {
        vm.prank(stats);
        rewards.record(buyer, client);
        accounting.settle(buyer, weightedDelta);
    }

    function _flush(address who) internal {
        address[] memory buyers = new address[](1);
        buyers[0] = who;
        rewards.flush(buyers);
    }

    /// Credit `points` to a client in `epoch` through a fresh buyer.
    function _credit(uint256 epoch, uint256 client, uint256 points) internal {
        address who = address(_nextBuyer++);
        gate.setCurrentEpoch(epoch);
        vm.prank(stats);
        rewards.record(who, client);
        accounting.settle(who, points);
        _flush(who);
    }
}

contract AntseedClientAttributionTest is ClientRewardsFixture {
    function test_creditsEachSettlementToTheClientThatProducedIt() public {
        gate.setCurrentEpoch(20);
        _settle(desktop, 10);
        _settle(cli, 4);
        _settle(desktop, 7);
        _settle(cli, 2);

        // The last settlement (cli, 2) waits for the next callback or a flush.
        assertEq(rewards.clientEpochPoints(20, desktop), 17);
        assertEq(rewards.clientEpochPoints(20, cli), 4);

        _flush(buyer);
        assertEq(rewards.clientEpochPoints(20, cli), 6);
        assertEq(rewards.totalClientPointsByEpoch(20), 23);

        _flush(buyer); // idempotent
        assertEq(rewards.totalClientPointsByEpoch(20), 23);
    }

    function test_creditsToTheEpochOfTheSettlementNotTheCallback() public {
        gate.setCurrentEpoch(20);
        _settle(desktop, 10);
        gate.setCurrentEpoch(21);
        _settle(desktop, 5); // credits the 10 from epoch 20
        assertEq(rewards.clientEpochPoints(20, desktop), 10);
        assertEq(rewards.clientEpochPoints(21, desktop), 0);
        _flush(buyer);
        assertEq(rewards.clientEpochPoints(21, desktop), 5);
    }

    function test_unattributedAndUnregisteredClientsNeverLeak() public {
        gate.setCurrentEpoch(20);
        _settle(desktop, 10);
        _settle(0, 3); // old client, no id
        _settle(999, 8); // unregistered agent id
        _settle(desktop, 1);
        assertEq(rewards.clientEpochPoints(20, desktop), 10);
        assertEq(rewards.totalClientPointsByEpoch(20), 10);
    }

    function test_firstObservationOnlySetsBaseline() public {
        gate.setCurrentEpoch(20);
        accounting.settle(buyer, 100); // usage before this contract existed
        _settle(desktop, 10);
        _settle(desktop, 0);
        assertEq(rewards.clientEpochPoints(20, desktop), 10);
    }

    function test_freeUsageCallbacksContributeNothingButMoveTheCursor() public {
        gate.setCurrentEpoch(20);
        _settle(desktop, 10);
        _settle(cli, 0); // free-usage settlement from the CLI: no accounting points
        _settle(desktop, 5);
        assertEq(rewards.clientEpochPoints(20, desktop), 10);
        assertEq(rewards.clientEpochPoints(20, cli), 0);
    }

    function test_lateCreditsRollForwardIntoTheOldestOpenEpoch() public {
        gate.setCurrentEpoch(20);
        _settle(desktop, 10); // settled in epoch 20, credited only at the next callback
        gate.setCurrentEpoch(23); // epoch 20 is claimable now: its totals are final

        _flush(buyer);
        assertEq(rewards.clientEpochPoints(20, desktop), 0);
        assertEq(rewards.clientEpochPoints(22, desktop), 10);

        // Still-open epochs keep the settlement's own epoch.
        _settle(desktop, 5); // epoch 23
        gate.setCurrentEpoch(24);
        _flush(buyer);
        assertEq(rewards.clientEpochPoints(23, desktop), 5);
    }

    function test_onlyRecorderCanRecord() public {
        vm.expectRevert(AntseedClientRewards.NotRecorder.selector);
        rewards.record(buyer, desktop);
        rewards.setRecorder(address(0));
        vm.prank(stats);
        vm.expectRevert(AntseedClientRewards.NotRecorder.selector);
        rewards.record(buyer, desktop);
    }

    function test_pauseStopsPayoutsButNotCredits() public {
        gate.setCurrentEpoch(20);
        accounting.setTotal(20, 10);
        gate.setBudget(address(rewards), 20, 100 ether);
        rewards.pause();

        _settle(desktop, 10); // must not revert: Channels accrues either way
        _flush(buyer);
        assertEq(rewards.clientEpochPoints(20, desktop), 10);

        gate.setCurrentEpoch(22);
        vm.prank(desktopOwner);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        rewards.claimClientReward(desktop, 20);

        rewards.unpause();
        vm.prank(desktopOwner);
        rewards.claimClientReward(desktop, 20);
        assertEq(gate.balanceOf(desktopOwner), 5 ether);
    }
}

contract AntseedClientRewardsTest is ClientRewardsFixture {
    function _claim(uint256 client, address owner, uint256 epoch) private {
        vm.prank(owner);
        rewards.claimClientReward(client, epoch);
    }

    function test_constructorRejectsACodelessIdentityRegistry() public {
        vm.expectRevert(AntseedClientRewards.InvalidAddress.selector);
        new AntseedClientRewards(address(gate), address(accounting), address(0xDEAD), stats);
    }

    function test_paysEachClientItsShareOfAllRecognizedUsage() public {
        accounting.setTotal(10, 1000);
        _credit(10, desktop, 30);
        _credit(10, cli, 20);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(12); // epoch 10 finalized and one grace epoch elapsed

        assertEq(rewards.rewardRecipient(desktop), desktopOwner);
        assertEq(rewards.pendingClientReward(desktop, 10), 3 ether);
        _claim(desktop, desktopOwner, 10);
        assertEq(gate.balanceOf(desktopOwner), 3 ether);
        assertTrue(rewards.clientEpochClaimed(desktop, 10));
        assertFalse(rewards.clientEpochClaimed(cli, 10));
        assertEq(rewards.pendingClientReward(desktop, 10), 0);

        _claim(cli, cliOwner, 10);
        assertEq(gate.balanceOf(cliOwner), 2 ether);

        vm.prank(cliOwner);
        vm.expectRevert(AntseedClientRewards.AlreadyClaimed.selector);
        rewards.claimClientReward(cli, 10);
    }

    function test_onlyTheAgentOwnerCanClaim() public {
        accounting.setTotal(10, 1000);
        _credit(10, desktop, 30);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(12);

        vm.prank(cliOwner);
        vm.expectRevert(AntseedClientRewards.NotRewardRecipient.selector);
        rewards.claimClientReward(desktop, 10);
        assertFalse(rewards.clientEpochClaimed(desktop, 10));
    }

    function test_capsAClientAtFivePercentAndReservesTheExcess() public {
        accounting.setTotal(10, 200);
        _credit(10, desktop, 50); // 25% of usage: 25 gross
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(12);

        assertEq(rewards.pendingClientReward(desktop, 10), 5 ether);
        vm.expectEmit(true, true, true, true);
        emit AntseedClientRewards.ClientRewardClaimed(desktopOwner, desktop, 10, 50, 200, 25 ether, 5 ether, 20 ether);
        _claim(desktop, desktopOwner, 10);
        assertEq(gate.balanceOf(desktopOwner), 5 ether);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 20 ether);
        assertEq(gate.minted(address(rewards), 10), 25 ether);
    }

    function test_creditsRolledIntoAQuietEpochStayWithinTheBucket() public {
        accounting.setTotal(10, 1); // less settled in the epoch than was credited to it
        _credit(10, desktop, 60);
        _credit(10, cli, 40);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(12);

        _claim(desktop, desktopOwner, 10);
        _claim(cli, cliOwner, 10);
        assertEq(gate.balanceOf(desktopOwner), 5 ether);
        assertEq(gate.balanceOf(cliOwner), 5 ether);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 90 ether);
        assertEq(gate.minted(address(rewards), 10), 100 ether);
    }

    function test_theUnearnedPartIsNeverMinted() public {
        accounting.setTotal(10, 1000);
        _credit(10, desktop, 30);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(12);

        _claim(desktop, desktopOwner, 10);
        assertEq(gate.minted(address(rewards), 10), 3 ether);
    }

    function test_waitsOneGraceEpochBeforeAnEpochIsClaimable() public {
        accounting.setTotal(10, 100);
        _credit(10, desktop, 1);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(11);
        assertFalse(rewards.isClaimable(10));
        assertEq(rewards.pendingClientReward(desktop, 10), 0);
        vm.prank(desktopOwner);
        vm.expectRevert(AntseedClientRewards.EpochNotClaimable.selector);
        rewards.claimClientReward(desktop, 10);

        gate.setCurrentEpoch(12);
        _claim(desktop, desktopOwner, 10);
        assertEq(gate.balanceOf(desktopOwner), 1 ether);
    }

    function test_noBucketOrNoPointsPaysNothing() public {
        accounting.setTotal(10, 1);
        _credit(10, desktop, 1);
        gate.setCurrentEpoch(12);
        vm.prank(desktopOwner);
        vm.expectRevert(AntseedClientRewards.NothingToClaim.selector);
        rewards.claimClientReward(desktop, 10); // controller not registered: budget 0

        gate.setBudget(address(rewards), 10, 10 ether);
        vm.prank(cliOwner);
        vm.expectRevert(AntseedClientRewards.NothingToClaim.selector);
        rewards.claimClientReward(cli, 10); // no points
    }

    function test_stakesTheCappedRewardForTheOwnerAndReservesTheExcess() public {
        SellerPoolsStakeMock pools = new SellerPoolsStakeMock(gate);
        accounting.setTotal(10, 200);
        _credit(10, desktop, 50);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(12);

        vm.prank(desktopOwner);
        vm.expectRevert(AntseedClientRewards.InvalidAddress.selector);
        rewards.stakeClientReward(desktop, 10, 4); // no pools configured

        rewards.setSellerPools(address(pools));
        vm.prank(desktopOwner);
        assertEq(rewards.stakeClientReward(desktop, 10, 4), 7);
        assertEq(pools.lastStaker(), desktopOwner);
        assertEq(pools.lastAgentId(), desktop);
        assertEq(pools.lastAmount(), 5 ether);
        assertEq(pools.lastEpochs(), 4);
        assertEq(gate.balanceOf(address(pools)), 5 ether);
        assertEq(gate.balanceOf(address(rewards)), 0);
        assertEq(gate.allowance(address(rewards), address(pools)), 0);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 20 ether);
    }

    function testFuzz_sharesNeverExceedTheBucket(
        uint256 budget,
        uint256 accountingTotal,
        uint256 desktopPoints,
        uint256 cliPoints
    ) public {
        budget = bound(budget, 1, 5_000_000 ether);
        accountingTotal = bound(accountingTotal, 0, 1e36);
        desktopPoints = bound(desktopPoints, 1, 1e36);
        cliPoints = bound(cliPoints, 1, 1e36);
        accounting.setTotal(10, accountingTotal);
        _credit(10, desktop, desktopPoints);
        _credit(10, cli, cliPoints);
        gate.setBudget(address(rewards), 10, budget);
        gate.setCurrentEpoch(12);

        uint256 cap = (budget * rewards.MAX_REWARD_SHARE_BPS()) / rewards.BPS_DENOMINATOR();
        assertLe(rewards.pendingClientReward(desktop, 10), cap);
        assertLe(rewards.pendingClientReward(cli, 10), cap);
        // The gate reverts a claim past the bucket, and the reserve part is charged to it too.
        try this.claimAs(desktopOwner, desktop) { } catch (bytes memory reason) {
            assertEq(bytes4(reason), AntseedClientRewards.NothingToClaim.selector);
        }
        try this.claimAs(cliOwner, cli) { } catch (bytes memory reason) {
            assertEq(bytes4(reason), AntseedClientRewards.NothingToClaim.selector);
        }
        assertLe(gate.balanceOf(desktopOwner), cap);
        assertLe(gate.minted(address(rewards), 10), budget);
    }

    function claimAs(address owner, uint256 client) external {
        vm.prank(owner);
        rewards.claimClientReward(client, 10);
    }
}
