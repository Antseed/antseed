// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedUsageAccounting} from "../interfaces/IAntseedUsageAccounting.sol";

interface IAntseedReferralDeposits {
    function getOperator(address buyer) external view returns (address);
}

/**
 * @title AntseedReferrals
 * @notice Two-sided, invite-only referral program: bindings, activity-based
 *         single-use invites, and emission-funded rewards for both the
 *         referrer and the referred buyer (the referee).
 *
 *         Invites: a referrer issues an invite off-chain and gaslessly by
 *         signing the EIP-712 struct `Invite(uint256 issuedEpoch,uint256 index)`
 *         in this contract's domain (name "AntseedReferrals", version "1").
 *         The referrer is recovered from the signature, so the shareable
 *         invite is just (issuedEpoch, index, 64-byte EIP-2098 compact
 *         signature `r, vs`). Nothing touches the chain until a buyer uses it.
 *         An invite binds only if:
 *           - `issuedEpoch <= currentEpoch < issuedEpoch + INVITE_VALIDITY_EPOCHS`;
 *           - `index < inviteQuota(referrer, issuedEpoch)`;
 *           - (referrer, issuedEpoch, index) was never used before;
 *           - the buyer is new and unbound, and the referrer is neither the
 *             buyer nor the buyer's Deposits operator.
 *         Invites are bearer tokens: whoever presents an unused one first
 *         gets it, which is why they are scarce (quota) and short-lived.
 *
 *         Quota: invites are earned by activity. The quota for epoch E is
 *         read from the referrer's recognized activity in epoch E-1, which
 *         is final once E has started: its buyer points plus the points of
 *         the seller pool it settled as a seller (AntseedUsageAccounting
 *         `buyerPointsByEpoch` + `sellerPointsByEpoch`). Points are the
 *         settled USDC amount in base units (1 USDC = 1e6) after the points
 *         policy (wash exclusion, verification shaping), unweighted by pool
 *         power. Below `MIN_ACTIVE_POINTS` (1 USDC) the quota is 0;
 *         otherwise `min(MAX_INVITES_PER_EPOCH, BASE_INVITES +
 *         activity / POINTS_PER_EXTRA_INVITE)`: 3 invites for any real
 *         activity, one more per 10 USDC, capped at 20 (reached at 170 USDC).
 *
 *         Binding: the buyer's client puts the invite in the attribution tail
 *         of the metadata it signs for every settlement (SpendingAuth /
 *         FreeUsageAuth) until it is bound. AntseedStatsV2 decodes it and
 *         calls `bindReferral`, so the binding is buyer-signed, gasless for
 *         both sides, and works during free usage. Only the configured binder
 *         (Stats) may bind; the first binding is immutable. Any rejection
 *         reverts here and Stats swallows it, so a bad invite never blocks a
 *         settlement. `previewInvite` runs the same checks as a view.
 *
 *         Only new buyers can bind: all of the buyer's recognized usage in
 *         AntseedUsageAccounting must fall within the current epoch and the
 *         `NEW_BUYER_EPOCHS` before it. Only usage recorded after the binding
 *         earns rewards.
 *
 *         Rewards: an AntseedEmissionsGate controller. A referred buyer's
 *         share of the bucket is its share of all recognized buyer usage, read
 *         straight from AntseedUsageAccounting: `bucket * weighted points /
 *         total weighted points`, final as soon as the epoch ends. During the
 *         referee window (`REFEREE_BONUS_EPOCHS`) the referrer and the buyer
 *         each earn half of that share; afterwards the referrer earns all of
 *         it. Usage by buyers nobody referred leaves its part of the bucket
 *         un-minted: which part that is cannot be known on-chain without
 *         summing every referred buyer, so it is never swept.
 *
 *         Claims are per buyer and epoch and permissionless, and both roles
 *         are paid only to the wallet's Deposits operator: a claim reverts
 *         while the wallet has none, and can be retried once it has one. Any
 *         wallet (buyer or seller) can set one with `Deposits.setOperator`.
 *         A hot wallet never receives funds in either role. A wallet may hold
 *         both roles; their claims are independent.
 *
 *         Self-referral: an invite signed by the buyer itself, its operator,
 *         or a wallet sharing the buyer's (non-zero) operator is rejected, and
 *         both operator rules are checked again at every claim.
 *         Sibling wallets (one person controlling an unrelated referrer and
 *         buyer) are not detectable on-chain. They are bounded by the quota
 *         (the referrer must have spent or sold for real the epoch before),
 *         the new-buyer rule (no re-binding established wallets) and the
 *         referee window (both halves of the buyer's share only for 12
 *         epochs, afterwards just the referrer share any genuine referral
 *         earns).
 */
contract AntseedReferrals is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    /// @notice A buyer may bind only if its first recognized usage was at
    ///         most this many epochs before the current one.
    uint256 public constant NEW_BUYER_EPOCHS = 2;

    /// @notice Epochs after the binding epoch during which a referred buyer
    ///         also earns as referee (12 weekly epochs, about 90 days including
    ///         the binding epoch). The window bounds what a self-referral
    ///         through a sibling wallet can capture.
    uint256 public constant REFEREE_BONUS_EPOCHS = 12;

    /// @notice Epochs an invite stays usable, counting its issue epoch.
    uint256 public constant INVITE_VALIDITY_EPOCHS = 4;
    /// @notice Previous-epoch activity (points, 1e6 = 1 USDC) below which a
    ///         referrer may issue no invites.
    uint256 public constant MIN_ACTIVE_POINTS = 1e6;
    /// @notice Invites for any qualifying activity.
    uint256 public constant BASE_INVITES = 3;
    /// @notice Activity points per invite above `BASE_INVITES` (10 USDC).
    uint256 public constant POINTS_PER_EXTRA_INVITE = 10e6;
    /// @notice Hard cap on invites per referrer per epoch (fits the bitmap).
    uint256 public constant MAX_INVITES_PER_EPOCH = 20;

    bytes32 public constant INVITE_TYPEHASH = keccak256("Invite(uint256 issuedEpoch,uint256 index)");

    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedUsageAccounting public immutable usageAccounting;
    IAntseedReferralDeposits public immutable deposits;

    /// @notice Contract allowed to submit bindings (AntseedStatsV2).
    address public binder;

    mapping(address buyer => address referrer) public referrerOf;
    mapping(address buyer => uint256 epoch) public boundAtEpoch;
    mapping(address referrer => uint256 count) public referredCount;
    /// @notice Buyer's weighted points in its binding epoch before it bound;
    ///         that usage earns no referral rewards.
    mapping(address buyer => uint256 points) public pointsBeforeBinding;

    /// @notice Whether the referrer's reward on this buyer's epoch was claimed.
    mapping(address buyer => mapping(uint256 epoch => bool)) public claimed;
    mapping(address buyer => mapping(uint256 epoch => bool)) public refereeClaimed;

    /// @dev Bit `index` set once invite (referrer, issuedEpoch, index) is used.
    mapping(address referrer => mapping(uint256 issuedEpoch => uint256 bitmap)) private _usedInvites;

    event ReferralBound(
        address indexed buyer, address indexed referrer, uint256 epoch, uint256 inviteEpoch, uint256 inviteIndex
    );
    event ReferralRewardClaimed(
        address indexed referrer,
        address indexed buyer,
        uint256 indexed epoch,
        address recipient,
        uint256 points,
        uint256 totalPoints,
        uint256 amount
    );
    event RefereeRewardClaimed(
        address indexed referee,
        uint256 indexed epoch,
        address indexed recipient,
        uint256 points,
        uint256 totalPoints,
        uint256 amount
    );
    event BinderUpdated(address indexed binder);

    error InvalidAddress();
    error NothingToClaim();
    error NotBinder();
    error ReferralAlreadyBound();
    error SelfReferral();
    error NotNewBuyer();
    error InvalidInviteSignature();
    error InviteNotActive();
    error InviteOverQuota();
    error InviteAlreadyUsed();
    error RewardRecipientUnavailable();

    constructor(address _emissionsGate, address _usageAccounting, address _deposits, address _binder)
        Ownable(msg.sender)
        EIP712("AntseedReferrals", "1")
    {
        if (_emissionsGate == address(0) || _usageAccounting == address(0) || _deposits == address(0)) {
            revert InvalidAddress();
        }
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        deposits = IAntseedReferralDeposits(_deposits);
        binder = _binder;
    }

    // ─── Invites ─────────────────────────────────────────────────────

    /// @notice Invites `referrer` may issue for `epoch`, from its activity
    ///         in `epoch - 1` (final once `epoch` has started).
    function inviteQuota(address referrer, uint256 epoch) public view returns (uint256) {
        if (epoch == 0 || referrer == address(0)) return 0;
        uint256 previous = epoch - 1;
        uint256 activity = usageAccounting.buyerPointsByEpoch(previous, referrer)
            + usageAccounting.sellerPointsByEpoch(previous, referrer);
        if (activity < MIN_ACTIVE_POINTS) return 0;
        uint256 quota = BASE_INVITES + activity / POINTS_PER_EXTRA_INVITE;
        return quota < MAX_INVITES_PER_EPOCH ? quota : MAX_INVITES_PER_EPOCH;
    }

    /// @notice EIP-712 digest a referrer signs to issue an invite.
    function inviteDigest(uint256 issuedEpoch, uint256 index) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INVITE_TYPEHASH, issuedEpoch, index)));
    }

    /// @notice The invite's signer (zero for a malformed signature).
    function inviteSigner(uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs) public view returns (address) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(inviteDigest(issuedEpoch, index), r, vs);
        return err == ECDSA.RecoverError.NoError ? signer : address(0);
    }

    function inviteUsed(address referrer, uint256 issuedEpoch, uint256 index) public view returns (bool) {
        return index < 256 && (_usedInvites[referrer][issuedEpoch] >> index) & 1 == 1;
    }

    /// @notice Run every `bindReferral` check for `buyer` presenting this
    ///         invite now. Returns the referrer and the error selector the
    ///         bind would revert with (zero when it would bind).
    function previewInvite(address buyer, uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs)
        external
        view
        returns (address referrer, bytes4 failure)
    {
        return _checkInvite(buyer, issuedEpoch, index, r, vs);
    }

    // ─── Binding ─────────────────────────────────────────────────────

    /// @notice Bind `buyer` to the signer of the invite. Called by
    ///         AntseedStatsV2 with the invite from the buyer-signed metadata
    ///         tail. Reverts with the reason on any failed check; Stats
    ///         swallows the revert.
    function bindReferral(address buyer, uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs)
        external
        whenNotPaused
    {
        if (msg.sender != binder) revert NotBinder();
        (address referrer, bytes4 failure) = _checkInvite(buyer, issuedEpoch, index, r, vs);
        if (failure != bytes4(0)) {
            assembly ("memory-safe") {
                mstore(0, failure)
                revert(0, 4)
            }
        }

        uint256 epoch = usageAccounting.currentEpoch();
        _usedInvites[referrer][issuedEpoch] |= uint256(1) << index;
        referrerOf[buyer] = referrer;
        boundAtEpoch[buyer] = epoch;
        referredCount[referrer] += 1;
        pointsBeforeBinding[buyer] = usageAccounting.weightedBuyerPointsByEpoch(epoch, buyer);

        emit ReferralBound(buyer, referrer, epoch, issuedEpoch, index);
    }

    /// @notice The buyer's referrer and binding epoch (zero referrer: unbound).
    function referralOf(address buyer) external view returns (address referrer, uint256 epoch) {
        return (referrerOf[buyer], boundAtEpoch[buyer]);
    }

    /// @notice Whether a binding for `buyer` would pass the new-buyer rule now.
    function isNewBuyer(address buyer) external view returns (bool) {
        return _isNewBuyer(buyer, usageAccounting.currentEpoch());
    }

    // ─── Rewards ─────────────────────────────────────────────────────

    /// @notice An epoch is claimable once it has ended: accounting only ever
    ///         records the current epoch, so its points are already final.
    function isClaimable(uint256 epoch) public view returns (bool) {
        return epoch < emissionsGate.currentEpoch();
    }

    /// @notice Mint a referrer's rewards on `buyers` for `epochs` to the
    ///         referrer's Deposits operator. Pairs with nothing to pay are
    ///         skipped. Permissionless; reverts while the referrer has no
    ///         operator so the claim can be retried.
    function claim(address referrer, address[] calldata buyers, uint256[] calldata epochs)
        external
        nonReentrant
        whenNotPaused
    {
        address recipient = _operatorOf(referrer);
        uint256 paid;
        for (uint256 e = 0; e < epochs.length; e++) {
            uint256 epoch = epochs[e];
            uint256 epochAmount;
            for (uint256 b = 0; b < buyers.length; b++) {
                address buyer = buyers[b];
                if (referrerOf[buyer] != referrer || claimed[buyer][epoch]) continue;
                (uint256 amount, uint256 points, uint256 total) = _referrerReward(buyer, epoch);
                if (amount == 0) continue;
                claimed[buyer][epoch] = true;
                epochAmount += amount;
                emit ReferralRewardClaimed(referrer, buyer, epoch, recipient, points, total, amount);
            }
            if (epochAmount != 0) {
                paid += epochAmount;
                emissionsGate.claim(epoch, recipient, epochAmount);
            }
        }
        if (paid == 0) revert NothingToClaim();
    }

    /// @notice Mint a referee's bonus for `epochs` to the buyer's Deposits
    ///         operator. Epochs with nothing to pay are skipped. Permissionless;
    ///         reverts while the buyer has no operator so the claim can be retried.
    function claimReferee(address buyer, uint256[] calldata epochs) external nonReentrant whenNotPaused {
        address recipient = _operatorOf(buyer);
        uint256 paid;
        for (uint256 e = 0; e < epochs.length; e++) {
            uint256 epoch = epochs[e];
            if (refereeClaimed[buyer][epoch]) continue;
            (uint256 amount, uint256 points, uint256 total) = _refereeReward(buyer, epoch);
            if (amount == 0) continue;
            refereeClaimed[buyer][epoch] = true;
            paid += amount;
            emit RefereeRewardClaimed(buyer, epoch, recipient, points, total, amount);
            emissionsGate.claim(epoch, recipient, amount);
        }
        if (paid == 0) revert NothingToClaim();
    }

    /// @notice Where a referrer's rewards go: its Deposits operator, or
    ///         zero while it has none (claims revert until one is set).
    function referrerRecipient(address referrer) public view returns (address) {
        return deposits.getOperator(referrer);
    }

    /// @notice What the buyer's referrer would receive on this buyer's epoch right now.
    function pendingReward(address buyer, uint256 epoch) external view returns (uint256 amount) {
        if (claimed[buyer][epoch]) return 0;
        (amount,,) = _referrerReward(buyer, epoch);
    }

    /// @notice What a referee would receive for an epoch right now (paid to its operator).
    function pendingRefereeReward(address buyer, uint256 epoch) external view returns (uint256 amount) {
        if (refereeClaimed[buyer][epoch]) return 0;
        (amount,,) = _refereeReward(buyer, epoch);
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Every bind check, cheapest first; returns the failing error's selector.
    function _checkInvite(address buyer, uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs)
        internal
        view
        returns (address referrer, bytes4 failure)
    {
        if (buyer == address(0)) return (address(0), InvalidAddress.selector);
        if (referrerOf[buyer] != address(0)) return (address(0), ReferralAlreadyBound.selector);

        referrer = inviteSigner(issuedEpoch, index, r, vs);
        if (referrer == address(0)) return (address(0), InvalidInviteSignature.selector);
        if (_isSelfReferral(buyer, referrer)) return (referrer, SelfReferral.selector);

        uint256 current = usageAccounting.currentEpoch();
        if (issuedEpoch > current || current - issuedEpoch >= INVITE_VALIDITY_EPOCHS) {
            return (referrer, InviteNotActive.selector);
        }
        if (index >= inviteQuota(referrer, issuedEpoch)) return (referrer, InviteOverQuota.selector);
        if (inviteUsed(referrer, issuedEpoch, index)) return (referrer, InviteAlreadyUsed.selector);
        if (!_isNewBuyer(buyer, current)) return (referrer, NotNewBuyer.selector);
    }

    /// @dev The buyer itself, the buyer's operator, or a wallet run by the
    ///      same operator as the buyer.
    function _isSelfReferral(address buyer, address referrer) internal view returns (bool) {
        if (referrer == buyer) return true;
        address buyerOperator = deposits.getOperator(buyer);
        if (buyerOperator == address(0)) return false;
        return referrer == buyerOperator || deposits.getOperator(referrer) == buyerOperator;
    }

    function _referrerReward(address buyer, uint256 epoch)
        internal
        view
        returns (uint256 amount, uint256 points, uint256 total)
    {
        (amount, points, total) = _buyerShare(buyer, epoch);
        if (_inRefereeWindow(buyer, epoch)) amount /= 2;
    }

    function _refereeReward(address buyer, uint256 epoch)
        internal
        view
        returns (uint256 amount, uint256 points, uint256 total)
    {
        if (!_inRefereeWindow(buyer, epoch)) return (0, 0, 0);
        (amount, points, total) = _buyerShare(buyer, epoch);
        amount /= 2;
    }

    /// @dev The referred buyer's share of the epoch's bucket, before any split.
    ///      Zero for epochs still open, an unbound buyer, and a referrer that
    ///      became the buyer's operator or shares it since the binding.
    ///      Shares of distinct buyers sum to at most the bucket.
    function _buyerShare(address buyer, uint256 epoch)
        internal
        view
        returns (uint256 share, uint256 points, uint256 total)
    {
        address referrer = referrerOf[buyer];
        if (referrer == address(0) || !isClaimable(epoch) || epoch < boundAtEpoch[buyer]) return (0, 0, 0);
        if (_isSelfReferral(buyer, referrer)) return (0, 0, 0);

        points = usageAccounting.weightedBuyerPointsByEpoch(epoch, buyer);
        if (epoch == boundAtEpoch[buyer]) points -= Math.min(points, pointsBeforeBinding[buyer]);
        total = usageAccounting.totalWeightedBuyerPointsByEpoch(epoch);
        if (points == 0 || total == 0) return (0, points, total);
        share = Math.mulDiv(emissionsGate.controllerEpochBudget(address(this), epoch), points, total);
    }

    function _inRefereeWindow(address buyer, uint256 epoch) internal view returns (bool) {
        return epoch <= boundAtEpoch[buyer] + REFEREE_BONUS_EPOCHS;
    }

    /// @dev The only reward recipient for either role: the wallet's operator.
    function _operatorOf(address wallet) internal view returns (address recipient) {
        recipient = deposits.getOperator(wallet);
        if (recipient == address(0)) revert RewardRecipientUnavailable();
    }

    function _isNewBuyer(address buyer, uint256 currentEpoch) internal view returns (bool) {
        uint256 recent;
        for (uint256 i = 0; i <= NEW_BUYER_EPOCHS && i <= currentEpoch; i++) {
            recent += usageAccounting.weightedBuyerPointsByEpoch(currentEpoch - i, buyer);
        }
        return usageAccounting.buyerUsageTotal(buyer).weightedPoints <= recent;
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setBinder(address _binder) external onlyOwner {
        binder = _binder;
        emit BinderUpdated(_binder);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
