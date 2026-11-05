// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";
import { SellerPoolsStakeMock } from "./mocks/SellerPoolsStakeMock.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

/// A settable epoch total.
contract ClientAccountingMock {
    mapping(uint256 => uint256) public totalWeightedBuyerPointsByEpoch;

    function setTotal(uint256 epoch, uint256 points) external {
        totalWeightedBuyerPointsByEpoch[epoch] = points;
    }
}

abstract contract ClientRewardsFixture is Test {
    EmissionsGateMock internal gate;
    ClientAccountingMock internal accounting;
    MockERC8004Registry internal identity;
    AntseedClientRewards internal rewards;

    address internal recorder = address(0x57A75);
    address internal buyer = address(0xB0B);
    address internal desktopOwner = address(0xD1);
    address internal cliOwner = address(0xC1);
    uint256 internal desktop;
    uint256 internal cli;

    function setUp() public {
        gate = new EmissionsGateMock();
        accounting = new ClientAccountingMock();
        identity = new MockERC8004Registry();
        rewards = new AntseedClientRewards(address(gate), address(accounting), address(identity), recorder);
        vm.prank(desktopOwner);
        desktop = identity.register();
        vm.prank(cliOwner);
        cli = identity.register();
    }

    /// Credit `points` to a client in `epoch`, as the middleware does on a settlement.
    function _credit(uint256 epoch, uint256 client, uint256 points) internal {
        gate.setCurrentEpoch(epoch);
        vm.prank(recorder);
        rewards.creditClientUsage(client, buyer, points);
    }
}

contract AntseedClientAttributionTest is ClientRewardsFixture {
    function test_creditsTheClientInTheCurrentEpoch() public {
        _credit(20, desktop, 10);
        _credit(20, cli, 4);
        _credit(20, desktop, 7);
        _credit(21, desktop, 1);
        assertEq(rewards.clientEpochPoints(20, desktop), 17);
        assertEq(rewards.clientEpochPoints(20, cli), 4);
        assertEq(rewards.clientEpochPoints(21, desktop), 1);
    }

    function test_emitsTheCredit() public {
        gate.setCurrentEpoch(20);
        vm.expectEmit(true, true, true, true);
        emit AntseedClientRewards.ClientUsageCredited(20, desktop, buyer, 10);
        vm.prank(recorder);
        rewards.creditClientUsage(desktop, buyer, 10);
    }

    function test_unregisteredClientsEarnNothing() public {
        _credit(20, 999, 8);
        assertEq(rewards.clientEpochPoints(20, 999), 0);
    }

    function test_onlyRecorderCanCredit() public {
        vm.expectRevert(AntseedClientRewards.NotRecorder.selector);
        rewards.creditClientUsage(desktop, buyer, 1);
        rewards.setRecorder(address(0));
        vm.prank(recorder);
        vm.expectRevert(AntseedClientRewards.NotRecorder.selector);
        rewards.creditClientUsage(desktop, buyer, 1);
    }

    function test_pauseStopsPayoutsButNotCredits() public {
        accounting.setTotal(20, 10);
        gate.setBudget(address(rewards), 20, 100 ether);
        rewards.pause();

        _credit(20, desktop, 10); // must not revert: settlements keep running
        assertEq(rewards.clientEpochPoints(20, desktop), 10);

        gate.setCurrentEpoch(21);
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
        new AntseedClientRewards(address(gate), address(accounting), address(0xDEAD), recorder);
    }

    function test_paysEachClientItsShareOfAllRecognizedUsage() public {
        accounting.setTotal(10, 1000);
        _credit(10, desktop, 30);
        _credit(10, cli, 20);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(11); // epoch 10 is over

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
        gate.setCurrentEpoch(11);

        vm.prank(cliOwner);
        vm.expectRevert(AntseedClientRewards.NotRewardRecipient.selector);
        rewards.claimClientReward(desktop, 10);
        assertFalse(rewards.clientEpochClaimed(desktop, 10));
    }

    function test_capsAClientAtFivePercentAndReservesTheExcess() public {
        accounting.setTotal(10, 200);
        _credit(10, desktop, 50); // 25% of usage: 25 gross
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(11);

        assertEq(rewards.pendingClientReward(desktop, 10), 5 ether);
        vm.expectEmit(true, true, true, true);
        emit AntseedClientRewards.ClientRewardClaimed(desktopOwner, desktop, 10, 50, 200, 25 ether, 5 ether, 20 ether);
        _claim(desktop, desktopOwner, 10);
        assertEq(gate.balanceOf(desktopOwner), 5 ether);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 20 ether);
        assertEq(gate.minted(address(rewards), 10), 25 ether);
    }

    function test_theUnearnedPartIsNeverMinted() public {
        accounting.setTotal(10, 1000);
        _credit(10, desktop, 30);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(11);

        _claim(desktop, desktopOwner, 10);
        assertEq(gate.minted(address(rewards), 10), 3 ether);
    }

    function test_anEpochIsClaimableOnceItEnds() public {
        accounting.setTotal(10, 100);
        _credit(10, desktop, 1);
        gate.setBudget(address(rewards), 10, 100 ether);
        assertFalse(rewards.isClaimable(10));
        assertEq(rewards.pendingClientReward(desktop, 10), 0);
        vm.prank(desktopOwner);
        vm.expectRevert(AntseedClientRewards.EpochNotClaimable.selector);
        rewards.claimClientReward(desktop, 10);

        gate.setCurrentEpoch(11);
        _claim(desktop, desktopOwner, 10);
        assertEq(gate.balanceOf(desktopOwner), 1 ether);
    }

    function test_noBucketOrNoPointsPaysNothing() public {
        accounting.setTotal(10, 1);
        _credit(10, desktop, 1);
        gate.setCurrentEpoch(11);
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
        gate.setCurrentEpoch(11);

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
        uint256 otherPoints,
        uint256 desktopPoints,
        uint256 cliPoints
    ) public {
        budget = bound(budget, 1, 5_000_000 ether);
        otherPoints = bound(otherPoints, 0, 1e36);
        desktopPoints = bound(desktopPoints, 1, 1e36);
        cliPoints = bound(cliPoints, 1, 1e36);
        accounting.setTotal(10, otherPoints + desktopPoints + cliPoints); // credits are part of the total
        _credit(10, desktop, desktopPoints);
        _credit(10, cli, cliPoints);
        gate.setBudget(address(rewards), 10, budget);
        gate.setCurrentEpoch(11);

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
