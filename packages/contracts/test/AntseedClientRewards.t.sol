// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";
import { AntseedEpochShareRewards } from "../emissions/AntseedEpochShareRewards.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

contract ClientUsageLedgerMock {
    mapping(uint256 => mapping(uint256 => uint256)) public clientEpochPoints;
    mapping(uint256 => uint256) public totalClientPointsByEpoch;

    function credit(uint256 epoch, uint256 client, uint256 points) external {
        clientEpochPoints[epoch][client] += points;
        totalClientPointsByEpoch[epoch] += points;
    }
}

contract AntseedClientRewardsTest is Test {
    EmissionsGateMock private gate;
    ClientUsageLedgerMock private ledger;
    MockERC8004Registry private identity;
    AntseedClientRewards private rewards;

    address private desktopOwner = address(0xD1);
    address private cliOwner = address(0xC1);
    uint256 private desktop;
    uint256 private cli;

    function setUp() public {
        gate = new EmissionsGateMock();
        ledger = new ClientUsageLedgerMock();
        identity = new MockERC8004Registry();
        rewards = new AntseedClientRewards(address(gate), address(ledger), address(identity));
        vm.prank(desktopOwner);
        desktop = identity.register();
        vm.prank(cliOwner);
        cli = identity.register();
    }

    function test_splitsTheEpochBucketByRecognizedPointsAndPaysAgentOwners() public {
        ledger.credit(10, desktop, 75);
        ledger.credit(10, cli, 25);
        gate.setBudget(address(rewards), 10, 100 ether);
        gate.setCurrentEpoch(12); // epoch 10 finalized and one grace epoch elapsed

        assertEq(rewards.pendingReward(desktop, 10), 75 ether);
        rewards.claim(desktop, 10);
        assertEq(gate.balanceOf(desktopOwner), 75 ether);

        // Late credit after the freeze does not change anyone's denominator.
        ledger.credit(10, cli, 100);
        rewards.claim(cli, 10);
        assertEq(gate.balanceOf(cliOwner), 25 ether);
        assertEq(rewards.frozenTotalPoints(10), 100);

        vm.expectRevert(AntseedEpochShareRewards.AlreadyClaimed.selector);
        rewards.claim(cli, 10);
    }

    function test_waitsOneGraceEpochBeforeAnEpochIsClaimable() public {
        ledger.credit(10, desktop, 1);
        gate.setBudget(address(rewards), 10, 10 ether);
        gate.setCurrentEpoch(11);
        assertFalse(rewards.isClaimable(10));
        assertEq(rewards.pendingReward(desktop, 10), 0);
        vm.expectRevert(AntseedEpochShareRewards.EpochNotClaimable.selector);
        rewards.claim(desktop, 10);

        gate.setCurrentEpoch(12);
        rewards.claim(desktop, 10);
        assertEq(gate.balanceOf(desktopOwner), 10 ether);
    }

    function test_noBucketOrNoPointsPaysNothing() public {
        gate.setCurrentEpoch(12);
        ledger.credit(10, desktop, 1);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        rewards.claim(desktop, 10); // controller not registered: budget 0

        gate.setBudget(address(rewards), 10, 10 ether);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        rewards.claim(cli, 10); // no points

        vm.expectRevert(AntseedEpochShareRewards.InvalidAddress.selector);
        rewards.claim(999, 10); // unregistered agent
    }
}
