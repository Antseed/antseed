// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";
import { SellerPoolsStakeMock } from "./mocks/SellerPoolsStakeMock.sol";

contract ReferralUsageAccountingMock {
    uint256 public currentEpoch = 10;
    mapping(uint256 => mapping(address => uint256)) public buyerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public sellerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public weightedBuyerPointsByEpoch;
    mapping(uint256 => uint256) public totalWeightedBuyerPointsByEpoch;
    mapping(address => uint256) private _lifetimeWeighted;

    function buyerUsageTotal(address buyer) external view returns (IAntseedUsageAccounting.BuyerUsage memory usage) {
        usage.weightedPoints = _lifetimeWeighted[buyer];
    }

    function setLifetimeWeighted(address buyer, uint256 points) external {
        _lifetimeWeighted[buyer] = points;
    }

    function setWeighted(uint256 epoch, address buyer, uint256 points, uint256 total) external {
        weightedBuyerPointsByEpoch[epoch][buyer] = points;
        totalWeightedBuyerPointsByEpoch[epoch] = total;
    }

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }

    function setBuyerPoints(uint256 epoch, address buyer, uint256 points) external {
        buyerPointsByEpoch[epoch][buyer] = points;
    }

    function setSellerPoints(uint256 epoch, address seller, uint256 points) external {
        sellerPointsByEpoch[epoch][seller] = points;
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
    uint256 private constant REFERRER_KEY = 0xA11CE;
    uint256 private constant OTHER_KEY = 0xB0B0;

    address private buyer = address(0xB0B);
    address private referrer;
    address private otherReferrer = address(0xA11CF);
    address private binder = address(0x57A75);
    address private stranger = address(0xBEEF);

    EmissionsGateMock private gate;
    ReferralUsageAccountingMock private accounting;
    ReferralDepositsMock private deposits;
    AntseedReferrals private referrals;

    function setUp() public {
        referrer = vm.addr(REFERRER_KEY);
        gate = new EmissionsGateMock();
        accounting = new ReferralUsageAccountingMock();
        deposits = new ReferralDepositsMock();
        referrals = new AntseedReferrals(address(gate), address(accounting), address(deposits), binder);
        accounting.setBuyerPoints(9, referrer, 25e6); // 25 USDC spent in epoch 9: 5 invites in epoch 10
    }

    function _invite(uint256 key, uint256 epoch, uint256 index) private view returns (bytes32 r, bytes32 vs) {
        return vm.signCompact(key, referrals.inviteDigest(epoch, index));
    }

    function _bind(address who, uint256 key, uint256 epoch, uint256 index) private {
        (bytes32 r, bytes32 vs) = _invite(key, epoch, index);
        vm.prank(binder);
        referrals.bindReferral(who, epoch, index, r, vs);
    }

    function _expectBindRevert(address who, uint256 key, uint256 epoch, uint256 index, bytes4 err) private {
        (bytes32 r, bytes32 vs) = _invite(key, epoch, index);
        (, bytes4 previewed) = referrals.previewInvite(who, epoch, index, r, vs);
        assertEq(previewed, err);
        vm.prank(binder);
        vm.expectRevert(err);
        referrals.bindReferral(who, epoch, index, r, vs);
    }

    // ─── Quota ───────────────────────────────────────────────────────

    function test_inviteQuotaFollowsPreviousEpochActivity() public {
        address a = address(0xAC);
        assertEq(referrals.inviteQuota(a, 10), 0); // no activity in epoch 9
        accounting.setBuyerPoints(9, a, 1e6 - 1);
        assertEq(referrals.inviteQuota(a, 10), 0); // below 1 USDC
        accounting.setBuyerPoints(9, a, 1e6);
        assertEq(referrals.inviteQuota(a, 10), 3); // base
        accounting.setBuyerPoints(9, a, 19_999_999);
        assertEq(referrals.inviteQuota(a, 10), 4); // 3 + 1 per full 10 USDC
        accounting.setSellerPoints(9, a, 1); // seller activity adds up
        assertEq(referrals.inviteQuota(a, 10), 5);
        accounting.setBuyerPoints(9, a, 0);
        accounting.setSellerPoints(9, a, 170e6);
        assertEq(referrals.inviteQuota(a, 10), 20); // cap reached at 170 USDC
        accounting.setSellerPoints(9, a, 1_000_000e6);
        assertEq(referrals.inviteQuota(a, 10), 20);

        // Only the immediately preceding epoch counts.
        assertEq(referrals.inviteQuota(a, 11), 0);
        assertEq(referrals.inviteQuota(a, 9), 0);
        assertEq(referrals.inviteQuota(a, 0), 0);
        assertEq(referrals.inviteQuota(address(0), 10), 0);
    }

    // ─── Binding ─────────────────────────────────────────────────────

    function test_validInviteBindsTheSignerOnce() public {
        (bytes32 r, bytes32 vs) = _invite(REFERRER_KEY, 10, 4); // last of 5
        (address previewed, bytes4 failure) = referrals.previewInvite(buyer, 10, 4, r, vs);
        assertEq(previewed, referrer);
        assertEq(failure, bytes4(0));
        assertEq(referrals.inviteSigner(10, 4, r, vs), referrer);

        vm.expectEmit(true, true, false, true);
        emit AntseedReferrals.ReferralBound(buyer, referrer, 10, 10, 4);
        vm.prank(binder);
        referrals.bindReferral(buyer, 10, 4, r, vs);
        assertEq(referrals.referrerOf(buyer), referrer);
        assertEq(referrals.boundAtEpoch(buyer), 10);
        assertEq(referrals.referredCount(referrer), 1);
        assertTrue(referrals.inviteUsed(referrer, 10, 4));
        assertFalse(referrals.inviteUsed(referrer, 10, 3));
        (address bound, uint256 epoch) = referrals.referralOf(buyer);
        assertEq(bound, referrer);
        assertEq(epoch, 10);

        // Single use: another buyer cannot reuse it.
        _expectBindRevert(stranger, REFERRER_KEY, 10, 4, AntseedReferrals.InviteAlreadyUsed.selector);
        // The bound buyer presenting it again (or any invite) is already bound.
        _expectBindRevert(buyer, REFERRER_KEY, 10, 3, AntseedReferrals.ReferralAlreadyBound.selector);
        // A fresh index still works.
        _bind(stranger, REFERRER_KEY, 10, 3);
        assertEq(referrals.referredCount(referrer), 2);
    }

    function test_indexAtOrAboveQuotaIsRejected() public {
        _expectBindRevert(buyer, REFERRER_KEY, 10, 5, AntseedReferrals.InviteOverQuota.selector);
        _expectBindRevert(buyer, REFERRER_KEY, 10, 255, AntseedReferrals.InviteOverQuota.selector);
        _expectBindRevert(buyer, REFERRER_KEY, 10, type(uint256).max, AntseedReferrals.InviteOverQuota.selector);
        // A referrer with no activity has no invites at all.
        _expectBindRevert(buyer, OTHER_KEY, 10, 0, AntseedReferrals.InviteOverQuota.selector);
    }

    function test_invitesAreValidForFourEpochsFromIssue() public {
        // Issued for a future epoch: not yet usable.
        accounting.setBuyerPoints(10, referrer, 1e6);
        _expectBindRevert(buyer, REFERRER_KEY, 11, 0, AntseedReferrals.InviteNotActive.selector);

        accounting.setCurrentEpoch(13); // issue epoch 10 + 3: last valid epoch
        _bind(buyer, REFERRER_KEY, 10, 0);

        accounting.setCurrentEpoch(14); // expired
        _expectBindRevert(stranger, REFERRER_KEY, 10, 1, AntseedReferrals.InviteNotActive.selector);
    }

    function test_invitesSignedByAnotherKeyOrTamperedAreRejected() public {
        // Tampering with the index recovers some other address, which has no quota.
        (bytes32 r, bytes32 vs) = _invite(REFERRER_KEY, 10, 1);
        (address signer, bytes4 failure) = referrals.previewInvite(buyer, 10, 2, r, vs);
        assertTrue(signer != referrer);
        assertEq(failure, AntseedReferrals.InviteOverQuota.selector);
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.InviteOverQuota.selector);
        referrals.bindReferral(buyer, 10, 2, r, vs);

        // Signed by another active key: binds to that key, never to `referrer`.
        address other = vm.addr(OTHER_KEY);
        accounting.setBuyerPoints(9, other, 1e6);
        _bind(buyer, OTHER_KEY, 10, 0);
        assertEq(referrals.referrerOf(buyer), other);

        // Signed in another contract's domain: recovers a stranger without quota.
        AntseedReferrals elsewhere =
            new AntseedReferrals(address(gate), address(accounting), address(deposits), binder);
        (r, vs) = vm.signCompact(REFERRER_KEY, elsewhere.inviteDigest(10, 0));
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.InviteOverQuota.selector);
        referrals.bindReferral(stranger, 10, 0, r, vs);

        // Malformed signature.
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.InvalidInviteSignature.selector);
        referrals.bindReferral(stranger, 10, 0, bytes32(0), bytes32(0));
    }

    function test_selfInvitesAreRejected() public {
        _expectBindRevert(referrer, REFERRER_KEY, 10, 0, AntseedReferrals.SelfReferral.selector);
        deposits.setOperator(buyer, referrer);
        _expectBindRevert(buyer, REFERRER_KEY, 10, 0, AntseedReferrals.SelfReferral.selector);
        assertFalse(referrals.inviteUsed(referrer, 10, 0));
    }

    function test_aWalletTheBuyerOperatesCannotInvite() public {
        deposits.setOperator(referrer, buyer);
        _expectBindRevert(buyer, REFERRER_KEY, 10, 0, AntseedReferrals.SelfReferral.selector);
    }

    function test_walletsSharingTheBuyersOperatorCannotInvite() public {
        address shared = address(0x5A5E);
        deposits.setOperator(buyer, shared);
        deposits.setOperator(referrer, shared);
        _expectBindRevert(buyer, REFERRER_KEY, 10, 0, AntseedReferrals.SelfReferral.selector);

        // Distinct operators, or an operator only on the referrer side, are fine.
        deposits.setOperator(referrer, address(0x0E1));
        (bytes32 r, bytes32 vs) = _invite(REFERRER_KEY, 10, 0);
        (, bytes4 failure) = referrals.previewInvite(buyer, 10, 0, r, vs);
        assertEq(failure, bytes4(0));
        deposits.setOperator(buyer, address(0));
        (, failure) = referrals.previewInvite(buyer, 10, 0, r, vs);
        assertEq(failure, bytes4(0));
        _bind(buyer, REFERRER_KEY, 10, 0);
    }

    function test_onlyNewBuyersCanBind() public {
        accounting.setWeighted(8, buyer, 5, 5); // all of it two epochs ago: still new
        accounting.setLifetimeWeighted(buyer, 5);
        assertTrue(referrals.isNewBuyer(buyer));
        _bind(buyer, REFERRER_KEY, 10, 0);

        address oldBuyer = address(0x01D);
        accounting.setWeighted(8, oldBuyer, 5, 5);
        accounting.setLifetimeWeighted(oldBuyer, 6); // one point from before the window
        assertFalse(referrals.isNewBuyer(oldBuyer));
        _expectBindRevert(oldBuyer, REFERRER_KEY, 10, 1, AntseedReferrals.NotNewBuyer.selector);
        assertFalse(referrals.inviteUsed(referrer, 10, 1)); // a rejected bind spends nothing

        address lapsedBuyer = address(0x1E6);
        accounting.setLifetimeWeighted(lapsedBuyer, 1); // nothing recent at all
        _expectBindRevert(lapsedBuyer, REFERRER_KEY, 10, 1, AntseedReferrals.NotNewBuyer.selector);

        assertTrue(referrals.isNewBuyer(stranger)); // no usage at all
    }

    function test_onlyBinderCanBind() public {
        (bytes32 r, bytes32 vs) = _invite(REFERRER_KEY, 10, 0);
        vm.prank(stranger);
        vm.expectRevert(AntseedReferrals.NotBinder.selector);
        referrals.bindReferral(buyer, 10, 0, r, vs);

        referrals.setBinder(address(0));
        vm.prank(binder);
        vm.expectRevert(AntseedReferrals.NotBinder.selector);
        referrals.bindReferral(buyer, 10, 0, r, vs);
    }

    /// Fixed vector shared with the TypeScript client (packages/protocol).
    function test_inviteSignatureVector() public {
        vm.chainId(8453);
        address fixedAddress = 0x1111111111111111111111111111111111111111;
        vm.etch(fixedAddress, address(referrals).code);
        AntseedReferrals atFixed = AntseedReferrals(fixedAddress);

        uint256 key = 0xA11CE;
        uint256 issuedEpoch = 42;
        uint256 index = 7;

        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AntseedReferrals"),
                keccak256("1"),
                uint256(8453),
                fixedAddress
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(keccak256("Invite(uint256 issuedEpoch,uint256 index)"), issuedEpoch, index));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        assertEq(atFixed.INVITE_TYPEHASH(), keccak256("Invite(uint256 issuedEpoch,uint256 index)"));
        assertEq(atFixed.INVITE_TYPEHASH(), 0x787424ddbd067db314529d6126aaa36d95cddd0034c3b0321ba23f851eaa52a8);
        assertEq(domainSeparator, 0x7c61f7df600144621a276a74c7d6dcb93fdecf901357c79df42bcca8b8743495);
        assertEq(structHash, 0x0fd739de67ca2598fb01ecdc42b4dbc8cc4aa98cca50e14e2af44bfcaa6cef83);
        assertEq(atFixed.inviteDigest(issuedEpoch, index), digest);
        assertEq(digest, 0x23a154885f1032c2161dc1e68d05535b819dbdeb17a51793c019bdfe30d4b4c9);

        (bytes32 r, bytes32 vs) = vm.signCompact(key, digest);
        assertEq(atFixed.inviteSigner(issuedEpoch, index, r, vs), vm.addr(key));
        assertEq(vm.addr(key), 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7);
        assertEq(r, 0xd802ee5a16750afbabae3b72ff1d3fd4b0e020078f532d083845ef4abd2c8eda);
        assertEq(vs, 0x446c5c2a3057d6654b49e84d192c62a787ff15082d4748ae083e366b78e80755);
    }

    // ─── Rewards ─────────────────────────────────────────────────────

    address private constant REFERRER_OPERATOR = address(0x0E1);
    address private constant BUYER_OPERATOR = address(0x0FE);
    uint256 private constant BOUND = 10;
    uint256 private constant AFTER_WINDOW = BOUND + 13;

    /// @dev `buyer` bound to `referrer` in epoch 10, both with operators.
    function _bound() private {
        deposits.setOperator(referrer, REFERRER_OPERATOR);
        deposits.setOperator(buyer, BUYER_OPERATOR);
        _bind(buyer, REFERRER_KEY, 10, 0);
    }

    function _one(uint256 epoch) private pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }

    function _only(address who) private pure returns (address[] memory buyers) {
        buyers = new address[](1);
        buyers[0] = who;
    }

    function _claimReferrer(address[] memory buyers, uint256[] memory epochs) private {
        vm.prank(REFERRER_OPERATOR);
        referrals.claimReferrerRewards(referrer, buyers, epochs);
    }

    function _claimReferee(uint256 epoch) private {
        vm.prank(BUYER_OPERATOR);
        referrals.claimRefereeRewards(buyer, _one(epoch));
    }

    function test_rewardIsTheBuyersShareOfAllRecognizedUsageSplitInItsWindow() public {
        _bound();
        accounting.setWeighted(10, buyer, 30, 1000);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11); // claimable once the epoch has ended

        assertEq(referrals.pendingReferrerReward(buyer, 10), 1.5 ether);
        assertEq(referrals.pendingRefereeReward(buyer, 10), 1.5 ether);

        vm.expectEmit(true, true, true, true);
        emit AntseedReferrals.ReferrerRewardClaimed(
            referrer, buyer, 10, REFERRER_OPERATOR, 30, 1000, 1.5 ether, 1.5 ether, 0
        );
        _claimReferrer(_only(buyer), _one(10));
        vm.expectEmit(true, true, true, true);
        emit AntseedReferrals.RefereeRewardClaimed(buyer, BUYER_OPERATOR, 10, 30, 1000, 1.5 ether, 1.5 ether, 0);
        _claimReferee(10);

        assertEq(gate.balanceOf(REFERRER_OPERATOR), 1.5 ether);
        assertEq(gate.balanceOf(BUYER_OPERATOR), 1.5 ether);
        assertEq(gate.balanceOf(referrer), 0);
        assertEq(gate.balanceOf(buyer), 0);
        assertTrue(referrals.referrerEpochClaimed(buyer, 10));
        assertTrue(referrals.refereeEpochClaimed(buyer, 10));
        assertEq(gate.minted(address(referrals), 10), 3 ether); // the rest stays un-minted

        assertEq(referrals.pendingReferrerReward(buyer, 10), 0);
        assertEq(referrals.pendingRefereeReward(buyer, 10), 0);
        address[] memory buyers = _only(buyer);
        uint256[] memory epochs = _one(10);
        vm.prank(REFERRER_OPERATOR);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.claimReferrerRewards(referrer, buyers, epochs);
        vm.prank(BUYER_OPERATOR);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.claimRefereeRewards(buyer, epochs);
    }

    function test_onlyTheOperatorCanClaimOrStake() public {
        _bound();
        accounting.setWeighted(10, buyer, 30, 1000);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);
        address[] memory buyers = _only(buyer);
        uint256[] memory epochs = _one(10);

        vm.prank(referrer); // the wallet itself is not the recipient
        vm.expectRevert(AntseedReferrals.NotRewardRecipient.selector);
        referrals.claimReferrerRewards(referrer, buyers, epochs);
        vm.prank(buyer);
        vm.expectRevert(AntseedReferrals.NotRewardRecipient.selector);
        referrals.claimRefereeRewards(buyer, epochs);
        vm.prank(stranger);
        vm.expectRevert(AntseedReferrals.NotRewardRecipient.selector);
        referrals.stakeReferrerRewards(referrer, buyers, 10, 1, 4);
        vm.prank(stranger);
        vm.expectRevert(AntseedReferrals.NotRewardRecipient.selector);
        referrals.stakeRefereeReward(buyer, 10, 1, 4);
    }

    function test_refereeIsCappedAtFivePercentAndTheExcessIsReserved() public {
        _bound();
        accounting.setWeighted(10, buyer, 30, 100); // 30 share: 15 each side
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);

        assertEq(referrals.pendingRefereeReward(buyer, 10), 5 ether);
        vm.expectEmit(true, true, true, true);
        emit AntseedReferrals.RefereeRewardClaimed(buyer, BUYER_OPERATOR, 10, 30, 100, 15 ether, 5 ether, 10 ether);
        _claimReferee(10);
        assertEq(gate.balanceOf(BUYER_OPERATOR), 5 ether);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 10 ether);
    }

    function test_referrerCapCoversAllItsBuyersInAnEpochAcrossClaims() public {
        _bound();
        accounting.setBuyerPoints(9, referrer, 25e6);
        _bind(stranger, REFERRER_KEY, 10, 1);
        accounting.setWeighted(10, buyer, 6, 100); // 3 gross
        accounting.setWeighted(10, stranger, 8, 100); // 4 gross
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);

        _claimReferrer(_only(buyer), _one(10));
        assertEq(referrals.referrerEpochPaid(referrer, 10), 3 ether);
        assertEq(referrals.pendingReferrerReward(stranger, 10), 2 ether); // only 2 of the cap left

        _claimReferrer(_only(stranger), _one(10));
        assertEq(gate.balanceOf(REFERRER_OPERATOR), 5 ether);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 2 ether);
        assertEq(referrals.referrerEpochPaid(referrer, 10), 5 ether);
    }

    function test_stakesForTheOperatorAndReservesTheExcess() public {
        SellerPoolsStakeMock pools = new SellerPoolsStakeMock(gate);
        _bound();
        accounting.setWeighted(10, buyer, 30, 100); // 15 gross each side
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);
        address[] memory buyers = _only(buyer);

        vm.prank(REFERRER_OPERATOR);
        vm.expectRevert(AntseedReferrals.InvalidAddress.selector);
        referrals.stakeReferrerRewards(referrer, buyers, 10, 1, 4); // no pools configured

        referrals.setSellerPools(address(pools));
        vm.prank(REFERRER_OPERATOR);
        assertEq(referrals.stakeReferrerRewards(referrer, buyers, 10, 1, 4), 7);
        assertEq(pools.lastStaker(), REFERRER_OPERATOR);
        assertEq(pools.lastAmount(), 5 ether);

        vm.prank(BUYER_OPERATOR);
        assertEq(referrals.stakeRefereeReward(buyer, 10, 2, 8), 7);
        assertEq(pools.lastStaker(), BUYER_OPERATOR);
        assertEq(pools.lastAgentId(), 2);
        assertEq(pools.lastEpochs(), 8);
        assertEq(gate.balanceOf(address(pools)), 10 ether);
        assertEq(gate.balanceOf(address(referrals)), 0);
        assertEq(gate.allowance(address(referrals), address(pools)), 0);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 20 ether);

        vm.prank(REFERRER_OPERATOR);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.stakeReferrerRewards(referrer, buyers, 10, 1, 4);
    }

    function test_openEpochsAndEpochsWithoutABucketPayNothing() public {
        _bound();
        accounting.setWeighted(10, buyer, 30, 30);
        gate.setBudget(address(referrals), 10, 100 ether);
        assertFalse(referrals.isClaimable(10)); // gate is still in epoch 10
        assertEq(referrals.pendingReferrerReward(buyer, 10), 0);
        address[] memory buyers = _only(buyer);
        uint256[] memory epochs = _one(10);
        vm.prank(REFERRER_OPERATOR);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.claimReferrerRewards(referrer, buyers, epochs);

        gate.setCurrentEpoch(11);
        assertTrue(referrals.isClaimable(10));
        gate.setBudget(address(referrals), 10, 0);
        vm.prank(REFERRER_OPERATOR);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.claimReferrerRewards(referrer, buyers, epochs);
    }

    function test_refereeWindowEndsAfterTwelveEpochs() public {
        _bound();
        uint256 last = BOUND + referrals.REFEREE_BONUS_EPOCHS();
        accounting.setWeighted(last, buyer, 2, 100);
        accounting.setWeighted(AFTER_WINDOW, buyer, 2, 100);
        gate.setBudget(address(referrals), last, 100 ether);
        gate.setBudget(address(referrals), AFTER_WINDOW, 100 ether);
        gate.setCurrentEpoch(AFTER_WINDOW + 1);

        assertEq(referrals.pendingReferrerReward(buyer, last), 1 ether);
        assertEq(referrals.pendingRefereeReward(buyer, last), 1 ether);
        assertEq(referrals.pendingReferrerReward(buyer, AFTER_WINDOW), 2 ether);
        assertEq(referrals.pendingRefereeReward(buyer, AFTER_WINDOW), 0);
    }

    function test_onlyUsageAfterTheBindingEarns() public {
        accounting.setWeighted(9, buyer, 50, 1000); // the epoch before the binding
        accounting.setWeighted(10, buyer, 40, 1000); // earlier in the binding epoch
        deposits.setOperator(referrer, REFERRER_OPERATOR);
        _bind(buyer, REFERRER_KEY, 10, 0);
        assertEq(referrals.pointsBeforeBinding(buyer), 40);
        accounting.setWeighted(10, buyer, 65, 1000); // 25 settled since

        gate.setBudget(address(referrals), 9, 100 ether);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);
        assertEq(referrals.pendingReferrerReward(buyer, 9), 0);
        assertEq(referrals.pendingReferrerReward(buyer, 10), 1.25 ether); // 2.5% of the bucket, halved
    }

    function test_claimBatchesBuyersAndEpochsOncePerEpochAndPairOnce() public {
        _bound();
        accounting.setBuyerPoints(9, referrer, 25e6);
        _bind(stranger, REFERRER_KEY, 10, 1);
        accounting.setWeighted(10, buyer, 2, 100);
        accounting.setWeighted(10, stranger, 4, 100);
        accounting.setWeighted(11, buyer, 6, 100);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setBudget(address(referrals), 11, 100 ether);
        gate.setCurrentEpoch(12);

        address[] memory buyers = new address[](3);
        buyers[0] = buyer;
        buyers[1] = stranger;
        buyers[2] = buyer; // a duplicate pays once
        uint256[] memory epochs = new uint256[](3);
        epochs[0] = 10;
        epochs[1] = 11;
        epochs[2] = 12; // not claimable: skipped
        _claimReferrer(buyers, epochs);

        assertEq(gate.balanceOf(REFERRER_OPERATOR), 6 ether); // (2+4)/2 + 6/2
        assertEq(gate.minted(address(referrals), 10), 3 ether);
        assertEq(gate.minted(address(referrals), 11), 3 ether);
    }

    function test_aReferrerCannotClaimAnotherReferrersBuyer() public {
        _bound();
        address otherOperator = address(0x0E2);
        deposits.setOperator(otherReferrer, otherOperator);
        accounting.setWeighted(10, buyer, 1, 100);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);
        address[] memory buyers = _only(buyer);
        uint256[] memory epochs = _one(10);
        vm.prank(otherOperator);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.claimReferrerRewards(otherReferrer, buyers, epochs);
        assertFalse(referrals.referrerEpochClaimed(buyer, 10));
    }

    function test_bothRolesPayOnlyAnOperator() public {
        _bind(buyer, REFERRER_KEY, 10, 0);
        accounting.setWeighted(10, buyer, 2, 100);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);
        address[] memory buyers = _only(buyer);
        uint256[] memory epochs = _one(10);

        assertEq(referrals.rewardRecipient(referrer), address(0));
        vm.expectRevert(AntseedReferrals.RewardRecipientUnavailable.selector);
        referrals.claimReferrerRewards(referrer, buyers, epochs);
        vm.expectRevert(AntseedReferrals.RewardRecipientUnavailable.selector);
        referrals.claimRefereeRewards(buyer, epochs);

        deposits.setOperator(referrer, REFERRER_OPERATOR);
        deposits.setOperator(buyer, BUYER_OPERATOR);
        assertEq(referrals.rewardRecipient(referrer), REFERRER_OPERATOR);
        _claimReferrer(buyers, epochs);
        _claimReferee(10);
        assertEq(gate.balanceOf(REFERRER_OPERATOR), 1 ether);
        assertEq(gate.balanceOf(BUYER_OPERATOR), 1 ether);
    }

    function test_operatorChangeAfterTheBindingVoidsOnlyTheReferrerSide() public {
        _bind(buyer, REFERRER_KEY, 10, 0);
        accounting.setWeighted(10, buyer, 2, 100);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);

        deposits.setOperator(buyer, referrer); // the referrer now operates the buyer
        assertEq(referrals.pendingReferrerReward(buyer, 10), 0);
        assertEq(referrals.pendingRefereeReward(buyer, 10), 1 ether);

        deposits.setOperator(buyer, REFERRER_OPERATOR);
        deposits.setOperator(referrer, buyer); // the buyer now operates the referrer
        assertEq(referrals.pendingReferrerReward(buyer, 10), 0);
        assertEq(referrals.pendingRefereeReward(buyer, 10), 1 ether);

        address shared = address(0x5A5E);
        deposits.setOperator(buyer, shared);
        deposits.setOperator(referrer, shared); // one operator runs both wallets
        assertEq(referrals.pendingReferrerReward(buyer, 10), 0);
        address[] memory buyers = _only(buyer);
        uint256[] memory epochs = _one(10);
        vm.prank(shared);
        vm.expectRevert(AntseedReferrals.NothingToClaim.selector);
        referrals.claimReferrerRewards(referrer, buyers, epochs);

        // Matching operators, which a referrer can set alone, cost the buyer nothing.
        vm.prank(shared);
        referrals.claimRefereeRewards(buyer, epochs);
        assertEq(gate.balanceOf(shared), 1 ether);

        deposits.setOperator(referrer, REFERRER_OPERATOR); // distinct again
        assertEq(referrals.pendingReferrerReward(buyer, 10), 1 ether);
    }

    function test_unboundBuyerEarnsNothing() public {
        accounting.setWeighted(5, buyer, 10, 10);
        gate.setBudget(address(referrals), 5, 100 ether);
        assertEq(referrals.pendingReferrerReward(buyer, 5), 0);
        assertEq(referrals.pendingRefereeReward(buyer, 5), 0);
    }

    function test_pauseBlocksClaims() public {
        _bound();
        accounting.setWeighted(10, buyer, 1, 100);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);
        referrals.pause();
        address[] memory buyers = _only(buyer);
        uint256[] memory epochs = _one(10);
        vm.prank(REFERRER_OPERATOR);
        vm.expectRevert();
        referrals.claimReferrerRewards(referrer, buyers, epochs);
        referrals.unpause();
        _claimReferrer(buyers, epochs);
    }

    function testFuzz_rewardsOfTwoBuyersNeverExceedTheBucket(uint256 budget, uint256 a, uint256 b, uint256 rest) public {
        budget = bound(budget, 1, 5_000_000 ether);
        a = bound(a, 1, 1e45);
        b = bound(b, 1, 1e45);
        rest = bound(rest, 0, 1e45);
        _bound();
        accounting.setBuyerPoints(9, referrer, 25e6);
        _bind(stranger, REFERRER_KEY, 10, 1);
        deposits.setOperator(stranger, address(0x0F2));
        accounting.setWeighted(10, buyer, a, a + b + rest);
        accounting.setWeighted(10, stranger, b, a + b + rest);
        gate.setBudget(address(referrals), 10, budget);
        gate.setCurrentEpoch(11);

        uint256 cap = (budget * referrals.MAX_REWARD_SHARE_BPS()) / referrals.BPS_DENOMINATOR();
        address[] memory buyers = new address[](2);
        buyers[0] = buyer;
        buyers[1] = stranger;
        // The gate reverts anything past the bucket, the reserve part included.
        try this.claimAllReferrer(buyers) { } catch (bytes memory reason) {
            assertEq(bytes4(reason), AntseedReferrals.NothingToClaim.selector);
        }
        try this.claimAllReferee(BUYER_OPERATOR, buyer) { } catch (bytes memory reason) {
            assertEq(bytes4(reason), AntseedReferrals.NothingToClaim.selector);
        }
        try this.claimAllReferee(address(0x0F2), stranger) { } catch (bytes memory reason) {
            assertEq(bytes4(reason), AntseedReferrals.NothingToClaim.selector);
        }
        assertLe(gate.balanceOf(REFERRER_OPERATOR), cap);
        assertLe(gate.balanceOf(BUYER_OPERATOR), cap);
        assertLe(gate.minted(address(referrals), 10), budget);
    }

    function claimAllReferrer(address[] calldata buyers) external {
        vm.prank(REFERRER_OPERATOR);
        referrals.claimReferrerRewards(referrer, buyers, _one(10));
    }

    function claimAllReferee(address operator, address who) external {
        vm.prank(operator);
        referrals.claimRefereeRewards(who, _one(10));
    }
}
