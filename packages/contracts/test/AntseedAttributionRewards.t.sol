// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";
import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";
import { AntseedChannelsMiddleware } from "../payments/AntseedChannelsMiddleware.sol";
import { AntseedStats } from "../stats/AntseedStats.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

/// Accounting whose epoch follows the gate, as AntseedUsageAccounting's does.
contract RewardsAccountingMock {
    EmissionsGateMock private immutable gate;
    mapping(address => uint256) private _weighted;
    mapping(uint256 => mapping(address => uint256)) public buyerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public sellerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public weightedBuyerPointsByEpoch;
    mapping(uint256 => uint256) public totalWeightedBuyerPointsByEpoch;

    constructor(EmissionsGateMock _gate) {
        gate = _gate;
    }

    function currentEpoch() external view returns (uint256) {
        return gate.currentEpoch();
    }

    function accrueSellerPoints(address, uint256) external {}

    function accrueBuyerPoints(address buyer, uint256 weightedDelta) external {
        uint256 epoch = gate.currentEpoch();
        _weighted[buyer] += weightedDelta;
        buyerPointsByEpoch[epoch][buyer] += weightedDelta;
        weightedBuyerPointsByEpoch[epoch][buyer] += weightedDelta;
        totalWeightedBuyerPointsByEpoch[epoch] += weightedDelta;
    }

    function setBuyerPoints(uint256 epoch, address buyer, uint256 points) external {
        buyerPointsByEpoch[epoch][buyer] = points;
    }

    function buyerUsageTotal(address buyer) external view returns (IAntseedUsageAccounting.BuyerUsage memory usage) {
        usage.points = _weighted[buyer];
        usage.weightedPoints = _weighted[buyer];
    }
}

contract RewardsRegistryMock {
    address public stats;

    function setStats(address value) external {
        stats = value;
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

/// Makes one settlement's calls inside a single call, as AntseedChannels does.
contract RewardsChannelsCaller {
    function settle(AntseedChannelsMiddleware middleware, address who, bytes32 channelId, bytes calldata metadata, uint256 delta)
        external
    {
        middleware.recordMetadata(1, who, channelId, metadata);
        middleware.accrueSellerPoints(address(0x5E), delta);
        middleware.accrueBuyerPoints(who, delta);
    }
}

/// Full referral program: a referrer signs an invite off-chain, the buyer's
/// client carries it in the signed metadata tail, and the real middleware
/// forwards it to the real client and referral controllers, as Channels does on
/// every settlement.
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
    AntseedClientRewards private clientRewards;
    AntseedReferrals private referrals;
    AntseedStats private stats;
    AntseedChannelsMiddleware private middleware;

    RewardsChannelsCaller private channels;
    address private referrer = vm.addr(REFERRER_KEY);
    address private buyer = vm.addr(BUYER_KEY);
    address private buyerOperator = address(0x0B0B0);
    address private newcomer = address(0x2E3);
    address private newcomerOperator = address(0x2E30);
    address private referrerOperator = address(0x0E3);
    bytes32 private channelId;
    Invite private none;

    function setUp() public {
        channels = new RewardsChannelsCaller();
        gate = new EmissionsGateMock();
        gate.setCurrentEpoch(20);
        accounting = new RewardsAccountingMock(gate);
        identity = new MockERC8004Registry();
        deposits = new RewardsDepositsMock();
        stats = new AntseedStats();
        clientRewards = new AntseedClientRewards(address(gate), address(accounting), address(identity), address(0));
        referrals = new AntseedReferrals(address(gate), address(accounting), address(deposits), address(0));
        RewardsRegistryMock registry = new RewardsRegistryMock();
        registry.setStats(address(stats));
        middleware = new AntseedChannelsMiddleware(
            address(registry), address(accounting), address(clientRewards), address(referrals), address(channels), address(0xF0)
        );
        clientRewards.setRecorder(address(middleware));
        referrals.setBinder(address(middleware));
        stats.setWriter(address(middleware), true);
        deposits.setOperator(buyer, buyerOperator);
        deposits.setOperator(newcomer, newcomerOperator);
        deposits.setOperator(referrer, referrerOperator); // referrer rewards are paid only to an operator
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

    /// One settlement, in the order AntseedChannels makes these calls.
    function _settleWith(address who, bytes memory metadata, uint256 weightedDelta) private {
        channels.settle(middleware, who, keccak256(abi.encode(who, channelId)), metadata, weightedDelta);
        channelId = bytes32(uint256(channelId) + 1);
    }

    function _settle(address who, Invite memory inv, uint256 weightedDelta) private {
        _settleWith(who, _metadata(inv, 0), weightedDelta);
    }

    function _one(uint256 epoch) private pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }

    function _only(address who) private pure returns (address[] memory buyers) {
        buyers = new address[](1);
        buyers[0] = who;
    }

    function test_inviteToFiftyFiftySplitThenReferrerOnly() public {
        Invite memory inv = _invite(REFERRER_KEY, 20, 0);
        vm.expectEmit(true, false, false, true, address(middleware));
        emit AntseedChannelsMiddleware.InviteForwarded(buyer, 20, 0, true, bytes4(0));
        _settle(buyer, inv, 30e6); // binds in epoch 20; this settlement counts
        assertEq(referrals.referrerOf(buyer), referrer);
        assertEq(referrals.pointsBeforeBinding(buyer), 0);
        assertTrue(referrals.inviteUsed(referrer, 20, 0));
        _settle(newcomer, none, 30e6); // someone nobody referred

        // Final and claimable as soon as the epoch ends.
        gate.setCurrentEpoch(21);
        gate.setBudget(address(referrals), 20, 100 ether);
        assertEq(referrals.pendingReferrerReward(buyer, 20), 5 ether); // 25 gross, capped at 5%
        assertEq(referrals.pendingRefereeReward(buyer, 20), 5 ether);
        vm.prank(referrerOperator);
        referrals.claimReferrerRewards(referrer, _only(buyer), _one(20));
        vm.prank(buyerOperator);
        referrals.claimRefereeRewards(buyer, _one(20));
        assertEq(gate.balanceOf(referrerOperator), 5 ether);
        assertEq(gate.balanceOf(buyerOperator), 5 ether);
        assertEq(gate.balanceOf(buyer), 0);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 40 ether);
        assertEq(gate.minted(address(referrals), 20), 50 ether); // the unreferred half stays un-minted

        // After the window the referrer takes the buyer's whole share.
        uint256 after_ = 20 + referrals.REFEREE_BONUS_EPOCHS() + 1;
        gate.setCurrentEpoch(after_);
        _settle(buyer, none, 40e6);
        gate.setCurrentEpoch(after_ + 1);
        gate.setBudget(address(referrals), after_, 100 ether);
        assertEq(referrals.pendingRefereeReward(buyer, after_), 0);
        vm.prank(referrerOperator);
        referrals.claimReferrerRewards(referrer, _only(buyer), _one(after_));
        assertEq(gate.balanceOf(referrerOperator), 10 ether);
        assertEq(gate.minted(address(referrals), after_), 100 ether);
    }

    function test_reusedInviteIsRejectedButTheSettlementSucceeds() public {
        Invite memory inv = _invite(REFERRER_KEY, 20, 1);
        _settle(buyer, inv, 1e6);
        vm.expectEmit(true, false, false, true, address(middleware));
        emit AntseedChannelsMiddleware.InviteForwarded(newcomer, 20, 1, false, AntseedReferrals.InviteAlreadyUsed.selector);
        _settle(newcomer, inv, 1e6);
        assertEq(referrals.referrerOf(newcomer), address(0));
    }

    function test_sameWalletAsReferrerAndRefereeClaimsBoth() public {
        _settle(buyer, _invite(REFERRER_KEY, 20, 0), 10e6); // epoch 20: buyer is bound and active
        gate.setCurrentEpoch(21);
        assertEq(referrals.inviteQuota(buyer, 21), 4); // earned by its 10 USDC in epoch 20
        _settle(newcomer, _invite(BUYER_KEY, 21, 3), 30e6); // buyer invites the newcomer
        assertEq(referrals.referrerOf(newcomer), buyer);
        _settle(buyer, none, 10e6);
        // Epoch 21: the newcomer holds 75% of all usage, the buyer 25%.

        gate.setCurrentEpoch(22);
        gate.setBudget(address(referrals), 21, 80 ether);
        // Independent claims, each capped at 5% of the bucket (4 ether).
        vm.startPrank(buyerOperator);
        referrals.claimReferrerRewards(buyer, _only(newcomer), _one(21));
        assertEq(gate.balanceOf(buyerOperator), 4 ether);
        referrals.claimRefereeRewards(buyer, _one(21));
        vm.stopPrank();
        vm.prank(referrerOperator);
        referrals.claimReferrerRewards(referrer, _only(buyer), _one(21));
        vm.prank(newcomerOperator);
        referrals.claimRefereeRewards(newcomer, _one(21));
        assertEq(gate.balanceOf(buyer), 0); // a buyer hot wallet never receives funds
        assertEq(gate.balanceOf(buyerOperator), 8 ether);
        assertEq(gate.balanceOf(referrerOperator), 4 ether);
        assertEq(gate.balanceOf(newcomerOperator), 4 ether);
        assertEq(gate.minted(address(referrals), 21), 80 ether);
    }

    function test_usageBeforeALateBindingEarnsNothing() public {
        _settle(buyer, none, 10e6);
        _settle(buyer, _invite(REFERRER_KEY, 20, 0), 30e6); // binds with 10e6 already accounted this epoch
        assertEq(referrals.pointsBeforeBinding(buyer), 10e6);

        gate.setCurrentEpoch(21);
        gate.setBudget(address(referrals), 20, 10 ether);
        // 75% of usage, halved: 3.75 gross, against a 0.5 cap.
        assertEq(referrals.pendingReferrerReward(buyer, 20), 0.5 ether);
        vm.prank(referrerOperator);
        referrals.claimReferrerRewards(referrer, _only(buyer), _one(20));
        assertEq(gate.minted(address(referrals), 20), 3.75 ether);
    }

    function test_oldBuyerInviteIsRejectedButTheSettlementSucceeds() public {
        _settle(newcomer, none, 10e6); // first recognized usage in epoch 20
        gate.setCurrentEpoch(23); // three epochs later
        accounting.setBuyerPoints(22, referrer, 1e6);
        _settle(newcomer, none, 5e6);
        assertFalse(referrals.isNewBuyer(newcomer));

        vm.expectEmit(true, false, false, true, address(middleware));
        emit AntseedChannelsMiddleware.InviteForwarded(newcomer, 23, 0, false, AntseedReferrals.NotNewBuyer.selector);
        _settle(newcomer, _invite(REFERRER_KEY, 23, 0), 7e6); // must not revert
        assertEq(referrals.referrerOf(newcomer), address(0));
        assertFalse(referrals.inviteUsed(referrer, 23, 0)); // the invite is still good for a new buyer
        assertEq(stats.getBuyerMetadataStats(1, newcomer).totalRequestCount, 3);
    }

    function test_selfInviteIsRejectedButTheSettlementSucceeds() public {
        vm.expectEmit(true, false, false, true, address(middleware));
        emit AntseedChannelsMiddleware.InviteForwarded(referrer, 20, 0, false, AntseedReferrals.SelfReferral.selector);
        _settle(referrer, _invite(REFERRER_KEY, 20, 0), 1e6);
        assertEq(referrals.referrerOf(referrer), address(0));

        deposits.setOperator(newcomer, referrer); // inviting a wallet you operate is self-referral too
        vm.expectEmit(true, false, false, true, address(middleware));
        emit AntseedChannelsMiddleware.InviteForwarded(newcomer, 20, 0, false, AntseedReferrals.SelfReferral.selector);
        _settle(newcomer, _invite(REFERRER_KEY, 20, 0), 1e6);
        assertEq(stats.getBuyerMetadataStats(1, referrer).totalRequestCount, 1);
    }

    function test_sharedOperatorInviteIsRejectedButTheSettlementSucceeds() public {
        deposits.setOperator(referrer, buyerOperator); // one operator runs both wallets
        vm.expectEmit(true, false, false, true, address(middleware));
        emit AntseedChannelsMiddleware.InviteForwarded(buyer, 20, 0, false, AntseedReferrals.SelfReferral.selector);
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
            assertTrue(logs[i].topics[0] != AntseedChannelsMiddleware.InviteForwarded.selector);
        }
        assertEq(referrals.referrerOf(buyer), address(0));
        assertEq(stats.getBuyerMetadataStats(1, buyer).totalRequestCount, 1);
    }

    function test_clientAttributionWorksWithAndWithoutAnInvite() public {
        vm.prank(address(0xD1));
        uint256 desktop = identity.register();
        _settleWith(buyer, _metadata(_invite(REFERRER_KEY, 20, 0), desktop), 4e6);
        _settleWith(buyer, _metadata(none, desktop), 6e6);
        assertEq(referrals.referrerOf(buyer), referrer);
        assertEq(clientRewards.clientEpochPoints(20, desktop), 10e6);
    }

    function test_clientsAreClaimableAsSoonAsTheEpochEnds() public {
        vm.prank(address(0xD1));
        uint256 desktop = identity.register();
        _settleWith(buyer, _metadata(none, desktop), 30e6);
        _settle(newcomer, none, 70e6); // an old client: counts in the total, earns nobody anything

        gate.setCurrentEpoch(21);
        gate.setBudget(address(clientRewards), 20, 100 ether);
        vm.prank(address(0xD1));
        clientRewards.claimClientReward(desktop, 20);
        assertEq(gate.balanceOf(address(0xD1)), 5 ether); // 30 gross, capped at 5%
        assertEq(gate.balanceOf(gate.emissionsReserve()), 25 ether);
        assertEq(gate.minted(address(clientRewards), 20), 30 ether);
    }
}
