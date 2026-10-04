// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedAttributionUsage } from "../emissions/AntseedAttributionUsage.sol";
import { AntseedEpochShareRewards } from "../emissions/AntseedEpochShareRewards.sol";
import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";
import { AntseedStatsV2 } from "../stats/AntseedStatsV2.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

/// Accounting whose epoch follows the gate, as AntseedUsageAccounting's does.
contract RewardsAccountingMock {
    EmissionsGateMock private immutable gate;
    uint256 public firstRewardedEpoch = 18;
    mapping(address => uint256) private _weighted;
    mapping(uint256 => mapping(address => uint256)) public buyerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public sellerPointsByEpoch;

    constructor(EmissionsGateMock _gate) {
        gate = _gate;
    }

    function currentEpoch() external view returns (uint256) {
        return gate.currentEpoch();
    }

    function settle(address buyer, uint256 weightedDelta) external {
        _weighted[buyer] += weightedDelta;
        buyerPointsByEpoch[gate.currentEpoch()][buyer] += weightedDelta;
    }

    function setBuyerPoints(uint256 epoch, address buyer, uint256 points) external {
        buyerPointsByEpoch[epoch][buyer] = points;
    }

    function buyerUsageTotal(address buyer) external view returns (IAntseedUsageAccounting.BuyerUsage memory usage) {
        usage.points = _weighted[buyer];
        usage.weightedPoints = _weighted[buyer];
    }
}

contract RewardsDepositsMock {
    mapping(address => address) private _operator;

    function setOperator(address buyer, address operator) external {
        _operator[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return _operator[buyer];
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
    address private r1 = vm.addr(0xA1);
    address private honest = vm.addr(0xA2);
    address private r2 = vm.addr(0xA3);
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

        _bind(x1, 0xA1);
        _bind(x2, 0xA2);
        _bind(x3, 0xA3);
    }

    function _bind(address buyer, uint256 referrerKey) private {
        accounting.setBuyerPoints(19, vm.addr(referrerKey), 1e6); // active last epoch: has invites
        (bytes32 r, bytes32 vs) = vm.signCompact(referrerKey, referrals.inviteDigest(20, 0));
        vm.prank(stats);
        referrals.bindReferral(buyer, 20, 0, r, vs);
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
        assertEq(ledger.totalReferralPointsByEpoch(20), 202); // every buyer is also a referee

        gate.setCurrentEpoch(22);
        gate.setBudget(address(referrals), 20, 100 ether);
        referrals.claim(r1, 20); // freezes epoch 20 at 202 points
        assertEq(referrals.frozenTotalPoints(20), 202);

        _flush(x3); // lands in the oldest open epoch, never in the frozen one
        assertEq(ledger.referrerEpochPoints(20, r2), 0);
        assertEq(ledger.referrerEpochPoints(21, r2), 1000);
        assertEq(ledger.totalReferrerPointsByEpoch(20), 101);
        assertEq(ledger.totalReferralPointsByEpoch(20), 202);

        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claim(r2, 20);

        referrals.claim(honest, 20);
        assertEq(gate.balanceOf(honest), uint256(100 ether) * 100 / 202);
        assertEq(gate.balanceOf(r1), uint256(100 ether) / 202);

        gate.setCurrentEpoch(23);
        gate.setBudget(address(referrals), 21, 50 ether);
        referrals.claim(r2, 21);
        assertEq(gate.balanceOf(r2), 25 ether); // x3 settled in its window: the referee holds the other half
    }
}

/// Full referral program: a referrer signs an invite off-chain, the buyer's
/// client carries it in the signed metadata tail, and the real StatsV2 forwards
/// it to the real ledger and referral controller, as Channels does on every
/// settlement.
contract AntseedReferralProgramIntegrationTest is Test {
    struct Invite {
        uint256 epoch;
        uint256 index;
        bytes32 r;
        bytes32 vs;
    }

    uint256 private constant REFERRER_KEY = 0xA11CE;
    uint256 private constant BUYER_KEY = 0xB0B;

    EmissionsGateMock private gate;
    RewardsAccountingMock private accounting;
    RewardsDepositsMock private deposits;
    MockERC8004Registry private identity;
    AntseedAttributionUsage private ledger;
    AntseedReferrals private referrals;
    AntseedStatsV2 private stats;

    address private channels = address(0xC4A);
    address private referrer = vm.addr(REFERRER_KEY);
    address private buyer = vm.addr(BUYER_KEY);
    address private buyerOperator = address(0x0B0B0);
    address private newcomer = address(0x2E3);
    address private newcomerOperator = address(0x2E30);
    bytes32 private channelId;
    Invite private none;

    function setUp() public {
        gate = new EmissionsGateMock();
        gate.setCurrentEpoch(20);
        accounting = new RewardsAccountingMock(gate);
        identity = new MockERC8004Registry();
        deposits = new RewardsDepositsMock();
        stats = new AntseedStatsV2();
        ledger = new AntseedAttributionUsage(address(accounting), address(identity), address(deposits), address(stats));
        referrals =
            new AntseedReferrals(address(gate), address(accounting), address(deposits), address(ledger), address(stats));
        ledger.setReferrals(address(referrals));
        stats.setWriter(channels, true);
        stats.setReferrals(address(referrals));
        stats.setAttributionUsage(address(ledger));
        deposits.setOperator(buyer, buyerOperator);
        deposits.setOperator(newcomer, newcomerOperator);
        accounting.setBuyerPoints(19, referrer, 50e6); // the referrer spent 50 USDC last epoch: 8 invites
    }

    function _invite(uint256 key, uint256 epoch, uint256 index) private view returns (Invite memory inv) {
        inv.epoch = epoch;
        inv.index = index;
        (inv.r, inv.vs) = vm.signCompact(key, referrals.inviteDigest(epoch, index));
    }

    function _metadata(Invite memory inv, uint256 clientId) private pure returns (bytes memory) {
        uint256[] memory services = new uint256[](0);
        return abi.encode(
            uint256(3), uint256(1), uint256(1), uint256(1), uint256(0), services,
            bytes32(clientId), inv.epoch, inv.index, inv.r, inv.vs
        );
    }

    /// One settlement: Stats sees the buyer-signed metadata, then accounting accrues.
    function _settleWith(address who, bytes memory metadata, uint256 weightedDelta) private {
        vm.prank(channels);
        stats.recordMetadata(1, who, keccak256(abi.encode(who, channelId)), metadata);
        accounting.settle(who, weightedDelta);
        channelId = bytes32(uint256(channelId) + 1);
    }

    function _settle(address who, Invite memory inv, uint256 weightedDelta) private {
        _settleWith(who, _metadata(inv, 0), weightedDelta);
    }

    function _flush(address who) private {
        address[] memory buyers = new address[](1);
        buyers[0] = who;
        ledger.flush(buyers);
    }

    function test_inviteToFiftyFiftySplitThenReferrerOnly() public {
        Invite memory inv = _invite(REFERRER_KEY, 20, 0);
        vm.expectEmit(true, false, false, true, address(stats));
        emit AntseedStatsV2.InviteForwarded(buyer, 20, 0, true, bytes4(0));
        _settle(buyer, inv, 30e6); // binds in epoch 20
        assertEq(referrals.referrerOf(buyer), referrer);
        assertTrue(referrals.inviteUsed(referrer, 20, 0));

        _settle(buyer, none, 0); // a bound buyer's client drops the invite
        _flush(buyer);
        assertEq(ledger.referrerEpochPoints(20, referrer), 30e6);
        assertEq(ledger.refereeEpochPoints(20, buyer), 30e6);

        gate.setCurrentEpoch(22);
        gate.setBudget(address(referrals), 20, 100 ether);
        assertEq(referrals.pendingReward(referrer, 20), 50 ether);
        assertEq(referrals.pendingRefereeReward(buyer, 20), 50 ether);
        referrals.claim(referrer, 20);
        referrals.claimReferee(buyer, 20);
        assertEq(gate.balanceOf(referrer), 50 ether);
        assertEq(gate.balanceOf(buyerOperator), 50 ether);
        assertEq(gate.balanceOf(buyer), 0);
        assertEq(gate.minted(address(referrals), 20), 100 ether);

        // After the window the referrer takes the buyer's whole share.
        uint256 after_ = 20 + ledger.REFEREE_BONUS_EPOCHS() + 1;
        gate.setCurrentEpoch(after_);
        _settle(buyer, none, 40e6);
        _flush(buyer);
        assertEq(ledger.refereeEpochPoints(after_, buyer), 0);
        gate.setCurrentEpoch(after_ + 2);
        gate.setBudget(address(referrals), after_, 100 ether);
        assertEq(referrals.pendingRefereeReward(buyer, after_), 0);
        referrals.claim(referrer, after_);
        assertEq(gate.balanceOf(referrer), 150 ether);
        assertEq(gate.minted(address(referrals), after_), 100 ether);
    }

    function test_reusedInviteIsRejectedButTheSettlementSucceeds() public {
        Invite memory inv = _invite(REFERRER_KEY, 20, 1);
        _settle(buyer, inv, 1e6);
        vm.expectEmit(true, false, false, true, address(stats));
        emit AntseedStatsV2.InviteForwarded(newcomer, 20, 1, false, AntseedReferrals.InviteAlreadyUsed.selector);
        _settle(newcomer, inv, 1e6);
        assertEq(referrals.referrerOf(newcomer), address(0));
    }

    function test_sameWalletAsReferrerAndRefereeClaimsBoth() public {
        _settle(buyer, _invite(REFERRER_KEY, 20, 0), 10e6); // epoch 20: buyer is bound and active
        gate.setCurrentEpoch(21);
        assertEq(referrals.inviteQuota(buyer, 21), 4); // earned by its 10 USDC in epoch 20
        _settle(newcomer, _invite(BUYER_KEY, 21, 3), 30e6); // buyer invites the newcomer
        assertEq(referrals.referrerOf(newcomer), buyer);
        _settle(buyer, none, 5e6); // credits the 10e6 to epoch 20
        _flush(buyer); // credits the 5e6 to epoch 21
        _flush(newcomer);
        // Epoch 21: buyer referee 5, referrer 5, buyer as referrer 30, newcomer referee 30.
        assertEq(ledger.totalReferralPointsByEpoch(21), 70e6);

        gate.setCurrentEpoch(23);
        gate.setBudget(address(referrals), 21, 70 ether);
        referrals.claim(buyer, 21); // distinct keys: both roles pay out, each to the operator
        assertEq(gate.balanceOf(buyerOperator), 30 ether);
        referrals.claimReferee(buyer, 21);
        referrals.claim(referrer, 21); // no operator: the referrer wallet itself
        referrals.claimReferee(newcomer, 21);
        assertEq(gate.balanceOf(buyer), 0); // a buyer hot wallet never receives funds
        assertEq(gate.balanceOf(buyerOperator), 35 ether);
        assertEq(gate.balanceOf(referrer), 5 ether);
        assertEq(gate.balanceOf(newcomerOperator), 30 ether);
        assertEq(gate.minted(address(referrals), 21), 70 ether);
    }

    function test_oldBuyerInviteIsRejectedButTheSettlementSucceeds() public {
        _settle(newcomer, none, 10e6); // first recognized usage in epoch 20
        gate.setCurrentEpoch(23); // three epochs later
        accounting.setBuyerPoints(22, referrer, 1e6);
        _settle(newcomer, none, 5e6); // ledger observes the epoch-20 usage
        assertFalse(referrals.isNewBuyer(newcomer));

        vm.expectEmit(true, false, false, true, address(stats));
        emit AntseedStatsV2.InviteForwarded(newcomer, 23, 0, false, AntseedReferrals.NotNewBuyer.selector);
        _settle(newcomer, _invite(REFERRER_KEY, 23, 0), 7e6); // must not revert
        assertEq(referrals.referrerOf(newcomer), address(0));
        assertFalse(referrals.inviteUsed(referrer, 23, 0)); // the invite is still good for a new buyer
        assertEq(stats.getBuyerMetadataStats(1, newcomer).totalRequestCount, 3);
    }

    function test_selfInviteIsRejectedButTheSettlementSucceeds() public {
        vm.expectEmit(true, false, false, true, address(stats));
        emit AntseedStatsV2.InviteForwarded(referrer, 20, 0, false, AntseedReferrals.SelfReferral.selector);
        _settle(referrer, _invite(REFERRER_KEY, 20, 0), 1e6);
        assertEq(referrals.referrerOf(referrer), address(0));

        deposits.setOperator(newcomer, referrer); // inviting a wallet you operate is self-referral too
        vm.expectEmit(true, false, false, true, address(stats));
        emit AntseedStatsV2.InviteForwarded(newcomer, 20, 0, false, AntseedReferrals.SelfReferral.selector);
        _settle(newcomer, _invite(REFERRER_KEY, 20, 0), 1e6);
        assertEq(stats.getBuyerMetadataStats(1, referrer).totalRequestCount, 1);
    }

    function test_sharedOperatorInviteIsRejectedButTheSettlementSucceeds() public {
        deposits.setOperator(referrer, buyerOperator); // one operator runs both wallets
        vm.expectEmit(true, false, false, true, address(stats));
        emit AntseedStatsV2.InviteForwarded(buyer, 20, 0, false, AntseedReferrals.SelfReferral.selector);
        _settle(buyer, _invite(REFERRER_KEY, 20, 0), 1e6);
        assertEq(referrals.referrerOf(buyer), address(0));
        assertFalse(referrals.inviteUsed(referrer, 20, 0));
        assertEq(stats.getBuyerMetadataStats(1, buyer).totalRequestCount, 1);
    }

    function test_bareReferrerTailNoLongerBinds() public {
        uint256[] memory services = new uint256[](0);
        bytes memory retired =
            abi.encode(uint256(3), uint256(1), uint256(1), uint256(1), uint256(0), services, referrer, bytes32(0));
        vm.recordLogs();
        _settleWith(buyer, retired, 1e6);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != AntseedStatsV2.InviteForwarded.selector);
        }
        assertEq(referrals.referrerOf(buyer), address(0));
        assertEq(stats.getBuyerMetadataStats(1, buyer).totalRequestCount, 1);
    }

    function test_clientAttributionWorksWithAndWithoutAnInvite() public {
        vm.prank(address(0xD1));
        uint256 desktop = identity.register();
        _settleWith(buyer, _metadata(_invite(REFERRER_KEY, 20, 0), desktop), 4e6);
        _settleWith(buyer, _metadata(none, desktop), 6e6);
        _flush(buyer);
        assertEq(referrals.referrerOf(buyer), referrer);
        assertEq(ledger.clientEpochPoints(20, desktop), 10e6);
        assertEq(ledger.referrerEpochPoints(20, referrer), 10e6);
    }
}
