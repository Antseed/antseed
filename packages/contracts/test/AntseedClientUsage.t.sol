// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedClientUsage } from "../emissions/AntseedClientUsage.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

/// Minimal accounting: cumulative weighted points per buyer, settable epoch.
contract ClientUsageAccountingMock {
    uint256 public currentEpoch = 20;
    uint256 public firstRewardedEpoch = 18;
    mapping(address => uint256) private _weighted;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }

    function settle(address buyer, uint256 weightedDelta) external {
        _weighted[buyer] += weightedDelta;
    }

    function buyerUsageTotal(address buyer) external view returns (IAntseedUsageAccounting.BuyerUsage memory usage) {
        usage.points = _weighted[buyer];
        usage.weightedPoints = _weighted[buyer];
    }
}

contract AntseedClientUsageTest is Test {
    ClientUsageAccountingMock private accounting;
    MockERC8004Registry private identity;
    AntseedClientUsage private ledger;

    address private stats = address(0x57A75);
    address private buyer = address(0xB0B);
    address private desktopOwner = address(0xD1);
    address private cliOwner = address(0xC1);
    uint256 private desktop;
    uint256 private cli;

    function setUp() public {
        accounting = new ClientUsageAccountingMock();
        identity = new MockERC8004Registry();
        ledger = new AntseedClientUsage(address(accounting), address(identity), stats);
        vm.prank(desktopOwner);
        desktop = identity.register();
        vm.prank(cliOwner);
        cli = identity.register();
    }

    /// One settlement as the chain performs it: Stats callback, then accounting.
    function _settle(uint256 client, uint256 weightedDelta) private {
        vm.prank(stats);
        ledger.record(buyer, client);
        accounting.settle(buyer, weightedDelta);
    }

    function test_creditsEachSettlementToTheClientThatProducedIt() public {
        _settle(desktop, 10);
        _settle(cli, 4);
        _settle(desktop, 7);
        _settle(cli, 2);

        // The last settlement (cli, 2) is still pending.
        assertEq(ledger.clientEpochPoints(20, desktop), 17);
        assertEq(ledger.clientEpochPoints(20, cli), 4);
        (uint256 pending, uint256 pendingClient, uint256 pendingEpoch) = ledger.pendingCredit(buyer);
        assertEq(pending, 2);
        assertEq(pendingClient, cli);
        assertEq(pendingEpoch, 20);

        address[] memory buyers = new address[](1);
        buyers[0] = buyer;
        ledger.flush(buyers);
        assertEq(ledger.clientEpochPoints(20, cli), 6);
        assertEq(ledger.totalClientPointsByEpoch(20), 23);
        assertEq(ledger.clientTotalPoints(desktop), 17);
        assertEq(ledger.clientTotalPoints(cli), 6);
        assertEq(ledger.clientRecipient(desktop), desktopOwner);

        ledger.flush(buyers); // idempotent
        assertEq(ledger.totalClientPointsByEpoch(20), 23);
    }

    function test_creditsToTheEpochOfTheSettlementNotTheCallback() public {
        _settle(desktop, 10);
        accounting.setCurrentEpoch(21);
        _settle(desktop, 5); // credits the 10 from epoch 20
        assertEq(ledger.clientEpochPoints(20, desktop), 10);
        assertEq(ledger.clientEpochPoints(21, desktop), 0);
        address[] memory buyers = new address[](1);
        buyers[0] = buyer;
        ledger.flush(buyers);
        assertEq(ledger.clientEpochPoints(21, desktop), 5);
    }

    function test_unattributedAndUnregisteredClientsNeverLeak() public {
        _settle(desktop, 10);
        _settle(0, 3); // old client, no id
        _settle(999, 8); // unregistered agent id
        _settle(desktop, 1);
        assertEq(ledger.clientEpochPoints(20, desktop), 10);
        assertEq(ledger.unattributedPointsByEpoch(20), 11);
        assertEq(ledger.totalClientPointsByEpoch(20), 10);
    }

    function test_firstObservationOnlySetsBaseline() public {
        accounting.settle(buyer, 100); // usage before attribution existed
        _settle(desktop, 10);
        _settle(desktop, 0);
        assertEq(ledger.clientEpochPoints(20, desktop), 10);
        assertEq(ledger.unattributedPointsByEpoch(20), 0);
    }

    function test_freeUsageCallbacksContributeNothingButMoveTheCursor() public {
        _settle(desktop, 10);
        _settle(cli, 0); // free-usage settlement from the CLI: no accounting points
        _settle(desktop, 5);
        assertEq(ledger.clientEpochPoints(20, desktop), 10);
        assertEq(ledger.clientEpochPoints(20, cli), 0);
    }

    function test_epochClampedToFirstRewardedEpoch() public {
        accounting.setCurrentEpoch(3);
        _settle(desktop, 10);
        _settle(desktop, 0);
        assertEq(ledger.clientEpochPoints(18, desktop), 10);
    }

    function test_onlyRecorderCanRecord() public {
        vm.expectRevert(AntseedClientUsage.NotRecorder.selector);
        ledger.record(buyer, desktop);
        ledger.setRecorder(address(0));
        vm.prank(stats);
        vm.expectRevert(AntseedClientUsage.NotRecorder.selector);
        ledger.record(buyer, desktop);
    }
}
