// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { AntseedAttributionUsage } from "../emissions/AntseedAttributionUsage.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

/// Minimal accounting: cumulative weighted points per buyer, settable epoch.
contract AttributionAccountingMock {
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

contract AttributionReferralsMock {
    mapping(address => address) public referrerOf;

    function bind(address buyer, address referrer) external {
        referrerOf[buyer] = referrer;
    }
}

contract AttributionDepositsMock {
    mapping(address => address) public operator;

    function setOperator(address buyer, address value) external {
        operator[buyer] = value;
    }

    function getOperator(address buyer) external view returns (address) {
        return operator[buyer];
    }
}

contract AntseedAttributionUsageTest is Test {
    AttributionAccountingMock private accounting;
    MockERC8004Registry private identity;
    AttributionReferralsMock private referrals;
    AttributionDepositsMock private deposits;
    AntseedAttributionUsage private ledger;

    address private stats = address(0x57A75);
    address private buyer = address(0xB0B);
    address private referrer = address(0xA11CE);
    address private desktopOwner = address(0xD1);
    address private cliOwner = address(0xC1);
    uint256 private desktop;
    uint256 private cli;

    function setUp() public {
        accounting = new AttributionAccountingMock();
        identity = new MockERC8004Registry();
        referrals = new AttributionReferralsMock();
        deposits = new AttributionDepositsMock();
        ledger = new AntseedAttributionUsage(address(accounting), address(identity), address(deposits), stats);
        ledger.setReferrals(address(referrals));
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

    function _flush() private {
        address[] memory buyers = new address[](1);
        buyers[0] = buyer;
        ledger.flush(buyers);
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

        _flush();
        assertEq(ledger.clientEpochPoints(20, cli), 6);
        assertEq(ledger.totalClientPointsByEpoch(20), 23);
        assertEq(ledger.clientTotalPoints(desktop), 17);
        assertEq(ledger.clientTotalPoints(cli), 6);
        assertEq(ledger.clientRecipient(desktop), desktopOwner);

        _flush(); // idempotent
        assertEq(ledger.totalClientPointsByEpoch(20), 23);
    }

    function test_creditsReferrerWithTheBuyersRecognizedUsage() public {
        referrals.bind(buyer, referrer); // bound at the first settlement, before any points
        _settle(desktop, 10);
        _settle(cli, 4);
        _flush();
        assertEq(ledger.referrerEpochPoints(20, referrer), 14);
        assertEq(ledger.totalReferrerPointsByEpoch(20), 14);
        assertEq(ledger.referrerTotalPoints(referrer), 14);
        // Client credits are independent of the referrer credit.
        assertEq(ledger.totalClientPointsByEpoch(20), 14);
    }

    function test_referrerWhoIsTheOperatorEarnsNothing() public {
        referrals.bind(buyer, referrer);
        _settle(desktop, 10);
        deposits.setOperator(buyer, referrer); // operator authorized after the binding
        _settle(desktop, 5);
        _flush();
        assertEq(ledger.referrerEpochPoints(20, referrer), 0);
        assertEq(ledger.clientEpochPoints(20, desktop), 15);
    }

    function test_unreferredBuyersCreditNoReferrer() public {
        _settle(desktop, 10);
        _flush();
        assertEq(ledger.totalReferrerPointsByEpoch(20), 0);
        ledger.setReferrals(address(0));
        referrals.bind(buyer, referrer);
        _settle(desktop, 5);
        _flush();
        assertEq(ledger.totalReferrerPointsByEpoch(20), 0);
    }

    function test_creditsToTheEpochOfTheSettlementNotTheCallback() public {
        referrals.bind(buyer, referrer);
        _settle(desktop, 10);
        accounting.setCurrentEpoch(21);
        _settle(desktop, 5); // credits the 10 from epoch 20
        assertEq(ledger.clientEpochPoints(20, desktop), 10);
        assertEq(ledger.referrerEpochPoints(20, referrer), 10);
        assertEq(ledger.clientEpochPoints(21, desktop), 0);
        _flush();
        assertEq(ledger.clientEpochPoints(21, desktop), 5);
        assertEq(ledger.referrerEpochPoints(21, referrer), 5);
    }

    function test_unattributedAndUnregisteredClientsNeverLeak() public {
        _settle(desktop, 10);
        _settle(0, 3); // old client, no id
        _settle(999, 8); // unregistered agent id
        _settle(desktop, 1);
        assertEq(ledger.clientEpochPoints(20, desktop), 10);
        assertEq(ledger.unattributedClientPointsByEpoch(20), 11);
        assertEq(ledger.totalClientPointsByEpoch(20), 10);
    }

    function test_firstObservationOnlySetsBaseline() public {
        accounting.settle(buyer, 100); // usage before attribution existed
        _settle(desktop, 10);
        _settle(desktop, 0);
        assertEq(ledger.clientEpochPoints(20, desktop), 10);
        assertEq(ledger.unattributedClientPointsByEpoch(20), 0);
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

    function test_lateCreditsRollForwardIntoTheOldestOpenEpoch() public {
        referrals.bind(buyer, referrer);
        _settle(desktop, 10); // settled in epoch 20, credited only at the next callback
        accounting.setCurrentEpoch(23); // epoch 20 is claimable now: its totals are final
        assertEq(ledger.oldestOpenEpoch(), 22);
        (uint256 pending,, uint256 pendingEpoch) = ledger.pendingCredit(buyer);
        assertEq(pending, 10);
        assertEq(pendingEpoch, 22);

        _flush();
        assertEq(ledger.clientEpochPoints(20, desktop), 0);
        assertEq(ledger.referrerEpochPoints(20, referrer), 0);
        assertEq(ledger.clientEpochPoints(22, desktop), 10);
        assertEq(ledger.referrerEpochPoints(22, referrer), 10);

        // Still-open epochs keep the settlement's own epoch.
        _settle(desktop, 5); // epoch 23
        accounting.setCurrentEpoch(24);
        _flush();
        assertEq(ledger.clientEpochPoints(23, desktop), 5);
    }

    function test_oldestOpenEpochNeverPrecedesTheFirstRewardedEpoch() public {
        accounting.setCurrentEpoch(18);
        assertEq(ledger.oldestOpenEpoch(), 18);
        accounting.setCurrentEpoch(0);
        assertEq(ledger.oldestOpenEpoch(), 18);
    }

    function test_pausedLedgerMovesTheCursorWithoutCrediting() public {
        referrals.bind(buyer, referrer);
        _settle(desktop, 10);
        ledger.pause();

        accounting.setCurrentEpoch(21);
        vm.expectEmit(true, false, false, true);
        emit AntseedAttributionUsage.UsageDroppedWhilePaused(buyer, 10);
        _settle(cli, 500); // must not revert: Channels accrues either way
        _settle(cli, 300);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _flush();

        ledger.unpause();
        accounting.setCurrentEpoch(22);
        _settle(cli, 0);
        // Only growth since the last (paused) observation is credited, to the
        // client and epoch of that observation — never the pre-pause cursor.
        assertEq(ledger.clientEpochPoints(20, desktop), 0);
        assertEq(ledger.clientEpochPoints(21, cli), 300);
        assertEq(ledger.referrerEpochPoints(20, referrer), 0);
        assertEq(ledger.referrerEpochPoints(21, referrer), 300);
        (uint256 pending,,) = ledger.pendingCredit(buyer);
        assertEq(pending, 0);
    }

    function test_onlyRecorderCanRecord() public {
        vm.expectRevert(AntseedAttributionUsage.NotRecorder.selector);
        ledger.record(buyer, desktop);
        ledger.setRecorder(address(0));
        vm.prank(stats);
        vm.expectRevert(AntseedAttributionUsage.NotRecorder.selector);
        ledger.record(buyer, desktop);
    }
}
