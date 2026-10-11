// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedReferrals } from "../rewards/AntseedReferrals.sol";
import { AntseedEpochShareRewards } from "../emissions/AntseedEpochShareRewards.sol";
import { EmissionsGateMock } from "./mocks/EmissionsGateMock.sol";

contract ReferralUsageAccountingMock {
    uint256 public currentEpoch = 10;
    mapping(uint256 => mapping(address => uint256)) public buyerPointsByEpoch;
    mapping(uint256 => mapping(address => uint256)) public sellerPointsByEpoch;

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

contract ReferrerLedgerMock {
    mapping(uint256 => mapping(address => uint256)) public referrerEpochPoints;
    mapping(uint256 => mapping(address => uint256)) public refereeEpochPoints;
    mapping(uint256 => uint256) public totalReferralPointsByEpoch;
    mapping(address => uint256) private _firstUsage;

    function credit(uint256 epoch, address referrer, uint256 points) external {
        referrerEpochPoints[epoch][referrer] += points;
        totalReferralPointsByEpoch[epoch] += points;
    }

    function creditReferee(uint256 epoch, address referee, uint256 points) external {
        refereeEpochPoints[epoch][referee] += points;
        totalReferralPointsByEpoch[epoch] += points;
    }

    function setFirstUsage(address buyer, uint256 epoch) external {
        _firstUsage[buyer] = epoch + 1;
    }

    function firstUsageEpoch(address buyer) external view returns (bool seen, uint256 epoch) {
        uint256 stored = _firstUsage[buyer];
        return stored == 0 ? (false, 0) : (true, stored - 1);
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
    ReferrerLedgerMock private ledger;
    AntseedReferrals private referrals;

    function setUp() public {
        referrer = vm.addr(REFERRER_KEY);
        gate = new EmissionsGateMock();
        accounting = new ReferralUsageAccountingMock();
        deposits = new ReferralDepositsMock();
        ledger = new ReferrerLedgerMock();
        referrals = new AntseedReferrals(address(gate), address(accounting), address(deposits), address(ledger), binder);
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
            new AntseedReferrals(address(gate), address(accounting), address(deposits), address(ledger), binder);
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
        ledger.setFirstUsage(buyer, 8); // two epochs ago: still new
        assertTrue(referrals.isNewBuyer(buyer));
        _bind(buyer, REFERRER_KEY, 10, 0);

        address oldBuyer = address(0x01D);
        ledger.setFirstUsage(oldBuyer, 7); // three epochs ago
        assertFalse(referrals.isNewBuyer(oldBuyer));
        _expectBindRevert(oldBuyer, REFERRER_KEY, 10, 1, AntseedReferrals.NotNewBuyer.selector);
        assertFalse(referrals.inviteUsed(referrer, 10, 1)); // a rejected bind spends nothing

        address legacyBuyer = address(0x1E6);
        ledger.setFirstUsage(legacyBuyer, 0); // usage predating the ledger
        _expectBindRevert(legacyBuyer, REFERRER_KEY, 10, 1, AntseedReferrals.NotNewBuyer.selector);

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
        assertEq(atFixed.inviteDigest(issuedEpoch, index), digest);
        assertEq(digest, 0x23a154885f1032c2161dc1e68d05535b819dbdeb17a51793c019bdfe30d4b4c9);

        (bytes32 r, bytes32 vs) = vm.signCompact(key, digest);
        assertEq(atFixed.inviteSigner(issuedEpoch, index, r, vs), vm.addr(key));
        assertEq(vm.addr(key), 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7);
        assertEq(r, 0xd802ee5a16750afbabae3b72ff1d3fd4b0e020078f532d083845ef4abd2c8eda);
        assertEq(vs, 0x446c5c2a3057d6654b49e84d192c62a787ff15082d4748ae083e366b78e80755);
    }

    // ─── Rewards ─────────────────────────────────────────────────────

    function test_loneReferrerTakesTheWholeBucketAndOthersDiluteIt() public {
        ledger.credit(10, referrer, 30);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(12); // finalized plus one grace epoch
        assertEq(referrals.pendingReward(referrer, 10), 100 ether);

        ledger.credit(11, referrer, 30);
        ledger.credit(11, otherReferrer, 10);
        gate.setBudget(address(referrals), 11, 100 ether);
        gate.setCurrentEpoch(13);
        assertEq(referrals.pendingReward(referrer, 11), 75 ether);
        assertEq(referrals.pendingReward(otherReferrer, 11), 25 ether);

        uint256[] memory epochs = new uint256[](2);
        epochs[0] = 10;
        epochs[1] = 11;
        referrals.claimEpochs(referrer, epochs);
        assertEq(gate.balanceOf(referrer), 175 ether);
        assertTrue(referrals.claimed(referrer, 10));

        // Late ledger credits never change a frozen denominator.
        ledger.credit(11, otherReferrer, 1000);
        referrals.claim(otherReferrer, 11);
        assertEq(gate.balanceOf(otherReferrer), 25 ether);

        vm.expectRevert(AntseedEpochShareRewards.AlreadyClaimed.selector);
        referrals.claim(referrer, 10);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claimEpochs(referrer, epochs);
    }

    function test_epochsNeedAGraceEpochAndABucket() public {
        ledger.credit(10, referrer, 1);
        gate.setCurrentEpoch(11);
        assertFalse(referrals.isClaimable(10));
        vm.expectRevert(AntseedEpochShareRewards.EpochNotClaimable.selector);
        referrals.claim(referrer, 10);

        gate.setCurrentEpoch(12);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claim(referrer, 10); // controller not registered as a minter: budget 0

        gate.setBudget(address(referrals), 10, 5 ether);
        referrals.claim(referrer, 10);
        assertEq(gate.balanceOf(referrer), 5 ether);
    }

    function test_epochWithoutPointsIsSweptToBurnAndReserve() public {
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(11);
        vm.expectRevert(AntseedEpochShareRewards.EpochNotClaimable.selector);
        referrals.settleEpochRemainder(10);

        gate.setCurrentEpoch(12);
        (uint256 burned, uint256 reserved) = referrals.settleEpochRemainder(10);
        assertEq(burned, 30 ether);
        assertEq(reserved, 70 ether);
        assertEq(gate.balanceOf(gate.DEAD_ADDRESS()), 30 ether);
        assertEq(gate.balanceOf(gate.emissionsReserve()), 70 ether);
        assertTrue(referrals.epochFrozen(10));
        assertEq(referrals.frozenTotalPoints(10), 0);
        vm.expectRevert(AntseedEpochShareRewards.AlreadyClaimed.selector);
        referrals.settleEpochRemainder(10);

        // A late credit cannot resurrect the swept epoch: its total is frozen at zero.
        ledger.credit(10, referrer, 5);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claim(referrer, 10);

        // Epochs with claimants keep their bucket for them.
        ledger.credit(11, referrer, 1);
        gate.setBudget(address(referrals), 11, 100 ether);
        gate.setCurrentEpoch(13);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.settleEpochRemainder(11);
        referrals.claim(referrer, 11);
        assertEq(gate.balanceOf(referrer), 100 ether);
    }

    function test_refereeAndReferrerSplitTheBucketWithDistinctKeys() public {
        address operator = address(0x0FE);
        deposits.setOperator(buyer, operator);
        // `referrer` is also a referee of someone else: both roles, one wallet.
        address referrersOperator = address(0x0FF);
        deposits.setOperator(referrer, referrersOperator);
        ledger.credit(10, referrer, 40);
        ledger.creditReferee(10, buyer, 40);
        ledger.creditReferee(10, referrer, 20);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(12);

        assertEq(referrals.pendingReward(referrer, 10), 40 ether);
        assertEq(referrals.pendingRefereeReward(buyer, 10), 40 ether);
        assertEq(referrals.pendingRefereeReward(referrer, 10), 20 ether);

        referrals.claim(referrer, 10);
        assertTrue(referrals.claimed(referrer, 10));
        assertFalse(referrals.refereeClaimed(referrer, 10));
        assertEq(referrals.pendingRefereeReward(referrer, 10), 20 ether);

        referrals.claimReferee(referrer, 10); // paid to that wallet's operator, not the wallet
        assertTrue(referrals.refereeClaimed(referrer, 10));
        assertEq(gate.balanceOf(referrer), 0); // a wallet with an operator never receives funds
        assertEq(gate.balanceOf(referrersOperator), 60 ether); // 40 as referrer + 20 as referee

        uint256[] memory epochs = new uint256[](2);
        epochs[0] = 10;
        epochs[1] = 11; // nothing there: skipped
        referrals.claimRefereeEpochs(buyer, epochs);
        assertEq(gate.balanceOf(operator), 40 ether);
        assertEq(gate.balanceOf(buyer), 0); // the buyer hot wallet never receives funds
        assertEq(gate.minted(address(referrals), 10), 100 ether); // the bucket sums to the budget

        vm.expectRevert(AntseedEpochShareRewards.AlreadyClaimed.selector);
        referrals.claimReferee(buyer, 10);
        vm.expectRevert(AntseedEpochShareRewards.NothingToClaim.selector);
        referrals.claimRefereeEpochs(buyer, epochs);
    }

    function test_refereeClaimNeedsAnOperator() public {
        ledger.creditReferee(10, buyer, 10);
        gate.setBudget(address(referrals), 10, 10 ether);
        gate.setCurrentEpoch(12);
        assertEq(referrals.pendingRefereeReward(buyer, 10), 10 ether);
        vm.expectRevert(AntseedReferrals.RewardRecipientUnavailable.selector);
        referrals.claimReferee(buyer, 10);

        deposits.setOperator(buyer, address(0x0FE));
        referrals.claimReferee(buyer, 10);
        assertEq(gate.balanceOf(address(0x0FE)), 10 ether);
    }

    function test_referrerRewardsPayTheOperatorWhenSetElseTheReferrer() public {
        address operator = address(0x0FE);
        ledger.credit(10, referrer, 30);
        ledger.credit(10, otherReferrer, 10);
        gate.setBudget(address(referrals), 10, 100 ether);
        gate.setCurrentEpoch(12);

        // A buyer hot wallet referrer: paid to its operator, by anyone.
        deposits.setOperator(referrer, operator);
        assertEq(referrals.referrerRecipient(referrer), operator);
        vm.expectEmit(true, true, true, true);
        emit AntseedReferrals.ReferralRewardClaimed(referrer, 10, operator, 30, 40, 75 ether);
        vm.prank(stranger);
        referrals.claim(referrer, 10);
        assertEq(gate.balanceOf(operator), 75 ether);
        assertEq(gate.balanceOf(referrer), 0);

        // A seller or plain wallet without an operator: paid to itself.
        assertEq(referrals.referrerRecipient(otherReferrer), otherReferrer);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 10;
        vm.expectEmit(true, true, true, true);
        emit AntseedReferrals.ReferralRewardClaimed(otherReferrer, 10, otherReferrer, 10, 40, 25 ether);
        vm.prank(stranger);
        referrals.claimEpochs(otherReferrer, epochs);
        assertEq(gate.balanceOf(otherReferrer), 25 ether);
    }

    function test_refereeRewardsPayOnlyTheOperator() public {
        ledger.creditReferee(10, buyer, 10);
        gate.setBudget(address(referrals), 10, 10 ether);
        gate.setCurrentEpoch(12);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 10;

        // No fallback to the buyer: both claim paths revert without an operator.
        vm.expectRevert(AntseedReferrals.RewardRecipientUnavailable.selector);
        referrals.claimReferee(buyer, 10);
        vm.expectRevert(AntseedReferrals.RewardRecipientUnavailable.selector);
        referrals.claimRefereeEpochs(buyer, epochs);

        address operator = address(0x0FE);
        deposits.setOperator(buyer, operator);
        vm.expectEmit(true, true, true, true);
        emit AntseedReferrals.RefereeRewardClaimed(buyer, 10, operator, 10, 10, 10 ether);
        vm.prank(stranger);
        referrals.claimRefereeEpochs(buyer, epochs);
        assertEq(gate.balanceOf(operator), 10 ether);
        assertEq(gate.balanceOf(buyer), 0);
    }
}
