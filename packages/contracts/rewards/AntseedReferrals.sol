// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {AntseedEpochShareRewards} from "../emissions/AntseedEpochShareRewards.sol";

interface IAntseedReferralUsageAccounting {
    function currentEpoch() external view returns (uint256);
    function buyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256);
    function sellerPointsByEpoch(uint256 epoch, address seller) external view returns (uint256);
}

interface IAntseedReferralDeposits {
    function getOperator(address buyer) external view returns (address);
}

interface IAntseedReferralUsageLedger {
    function referrerEpochPoints(uint256 epoch, address referrer) external view returns (uint256);
    function refereeEpochPoints(uint256 epoch, address referee) external view returns (uint256);
    function totalReferralPointsByEpoch(uint256 epoch) external view returns (uint256);
    function firstUsageEpoch(address buyer) external view returns (bool seen, uint256 epoch);
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
 *         Only new buyers can bind: one whose first recognized usage
 *         (`AntseedAttributionUsage.firstUsageEpoch`) is at most
 *         `NEW_BUYER_EPOCHS` epochs before the current one, or that has none
 *         yet. The attribution ledger credits only usage recorded after the
 *         binding.
 *
 *         Rewards: an AntseedEmissionsGate controller. Each epoch's bucket is
 *         split pro rata to the ledger's referral points: every referred
 *         buyer's recognized usage is credited to its referrer and, during the
 *         referee window (`AntseedAttributionUsage.REFEREE_BONUS_EPOCHS`), to
 *         the buyer as referee too, so the two halve that buyer's share. A
 *         lone claimant takes the whole bucket, and every additional one
 *         dilutes it. Claims are per epoch and permissionless. Referrer
 *         rewards go to the referrer's Deposits operator when it has one,
 *         else to the referrer address (sellers and plain wallets); referee
 *         rewards go only to the buyer's operator. A buyer hot wallet never
 *         receives funds in either role.
 *         Referrer and referee claims use distinct keys, so one wallet may
 *         hold both roles.
 *
 *         Self-referral: an invite signed by the buyer itself, its operator,
 *         or a wallet sharing the buyer's (non-zero) operator is rejected, and
 *         the ledger re-checks both operator rules at every credit.
 *         Sibling wallets (one person controlling an unrelated referrer and
 *         buyer) are not detectable on-chain. They are bounded by the quota
 *         (the referrer must have spent or sold for real the epoch before),
 *         the new-buyer rule (no re-binding established wallets) and the
 *         referee window (both halves of the buyer's share only for 12
 *         epochs, afterwards just the referrer share any genuine referral
 *         earns).
 */
contract AntseedReferrals is AntseedEpochShareRewards, EIP712 {
    /// @notice A buyer may bind only if its first recognized usage was at
    ///         most this many epochs before the current one.
    uint256 public constant NEW_BUYER_EPOCHS = 2;

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

    bytes32 private constant REFERRER_ROLE = keccak256("antseed.referrals.referrer");
    bytes32 private constant REFEREE_ROLE = keccak256("antseed.referrals.referee");

    IAntseedReferralUsageAccounting public immutable usageAccounting;
    IAntseedReferralDeposits public immutable deposits;
    IAntseedReferralUsageLedger public immutable attributionUsage;

    /// @notice Contract allowed to submit bindings (AntseedStatsV2).
    address public binder;

    mapping(address buyer => address referrer) public referrerOf;
    mapping(address buyer => uint256 epoch) public boundAtEpoch;
    mapping(address referrer => uint256 count) public referredCount;

    /// @dev Bit `index` set once invite (referrer, issuedEpoch, index) is used.
    mapping(address referrer => mapping(uint256 issuedEpoch => uint256 bitmap)) private _usedInvites;

    event ReferralBound(
        address indexed buyer, address indexed referrer, uint256 epoch, uint256 inviteEpoch, uint256 inviteIndex
    );
    event ReferralRewardClaimed(
        address indexed referrer,
        uint256 indexed epoch,
        address indexed recipient,
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

    error NotBinder();
    error ReferralAlreadyBound();
    error SelfReferral();
    error NotNewBuyer();
    error InvalidInviteSignature();
    error InviteNotActive();
    error InviteOverQuota();
    error InviteAlreadyUsed();
    error RewardRecipientUnavailable();

    constructor(
        address _emissionsGate,
        address _usageAccounting,
        address _deposits,
        address _attributionUsage,
        address _binder
    ) AntseedEpochShareRewards(_emissionsGate) EIP712("AntseedReferrals", "1") {
        if (_usageAccounting == address(0) || _deposits == address(0) || _attributionUsage == address(0)) {
            revert InvalidAddress();
        }
        usageAccounting = IAntseedReferralUsageAccounting(_usageAccounting);
        deposits = IAntseedReferralDeposits(_deposits);
        attributionUsage = IAntseedReferralUsageLedger(_attributionUsage);
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

    // ─── Referrer rewards ────────────────────────────────────────────

    /// @notice Mint a referrer's share of an epoch's bucket to
    ///         `referrerRecipient(referrer)`. Permissionless.
    function claim(address referrer, uint256 epoch) external nonReentrant whenNotPaused {
        _claimReferrer(
            referrer, referrerRecipient(referrer), epoch, attributionUsage.referrerEpochPoints(epoch, referrer)
        );
    }

    /// @notice Where a referrer's rewards go: its Deposits operator when it
    ///         has one (a buyer hot wallet never receives funds), else the
    ///         referrer address itself (sellers and plain wallets).
    function referrerRecipient(address referrer) public view returns (address) {
        address operator = deposits.getOperator(referrer);
        return operator != address(0) ? operator : referrer;
    }

    /// @notice Claim several epochs at once; epochs with nothing to pay are skipped.
    function claimEpochs(address referrer, uint256[] calldata epochs) external nonReentrant whenNotPaused {
        address recipient = referrerRecipient(referrer);
        bytes32 key = _referrerKey(referrer);
        uint256 paid;
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 points = attributionUsage.referrerEpochPoints(epochs[i], referrer);
            if (_pending(epochs[i], key, points) == 0) continue;
            paid += _claimReferrer(referrer, recipient, epochs[i], points);
        }
        if (paid == 0) revert NothingToClaim();
    }

    function claimed(address referrer, uint256 epoch) external view returns (bool) {
        return _isClaimed(epoch, _referrerKey(referrer));
    }

    /// @notice What a referrer would receive for an epoch right now.
    function pendingReward(address referrer, uint256 epoch) external view returns (uint256) {
        return _pending(epoch, _referrerKey(referrer), attributionUsage.referrerEpochPoints(epoch, referrer));
    }

    // ─── Referee rewards ─────────────────────────────────────────────

    /// @notice Mint a referee's share of an epoch's bucket to the buyer's
    ///         Deposits operator. Permissionless; reverts while the buyer has
    ///         no operator so the claim can be retried once it has one.
    function claimReferee(address buyer, uint256 epoch) external nonReentrant whenNotPaused {
        _claimReferee(buyer, _refereeRecipient(buyer), epoch, attributionUsage.refereeEpochPoints(epoch, buyer));
    }

    /// @notice Claim several referee epochs at once; epochs with nothing to pay are skipped.
    function claimRefereeEpochs(address buyer, uint256[] calldata epochs) external nonReentrant whenNotPaused {
        address recipient = _refereeRecipient(buyer);
        bytes32 key = _refereeKey(buyer);
        uint256 paid;
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 points = attributionUsage.refereeEpochPoints(epochs[i], buyer);
            if (_pending(epochs[i], key, points) == 0) continue;
            paid += _claimReferee(buyer, recipient, epochs[i], points);
        }
        if (paid == 0) revert NothingToClaim();
    }

    function refereeClaimed(address buyer, uint256 epoch) external view returns (bool) {
        return _isClaimed(epoch, _refereeKey(buyer));
    }

    /// @notice What a referee would receive for an epoch right now (paid to its operator).
    function pendingRefereeReward(address buyer, uint256 epoch) external view returns (uint256) {
        return _pending(epoch, _refereeKey(buyer), attributionUsage.refereeEpochPoints(epoch, buyer));
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

    function _claimReferrer(address referrer, address recipient, uint256 epoch, uint256 points)
        internal
        returns (uint256 amount)
    {
        uint256 total;
        (amount, total) = _claimShare(epoch, _referrerKey(referrer), points, recipient);
        emit ReferralRewardClaimed(referrer, epoch, recipient, points, total, amount);
    }

    function _claimReferee(address buyer, address recipient, uint256 epoch, uint256 points)
        internal
        returns (uint256 amount)
    {
        uint256 total;
        (amount, total) = _claimShare(epoch, _refereeKey(buyer), points, recipient);
        emit RefereeRewardClaimed(buyer, epoch, recipient, points, total, amount);
    }

    function _refereeRecipient(address buyer) internal view returns (address recipient) {
        recipient = deposits.getOperator(buyer);
        if (recipient == address(0)) revert RewardRecipientUnavailable();
    }

    function _isNewBuyer(address buyer, uint256 currentEpoch) internal view returns (bool) {
        (bool seen, uint256 firstEpoch) = attributionUsage.firstUsageEpoch(buyer);
        return !seen || firstEpoch + NEW_BUYER_EPOCHS >= currentEpoch;
    }

    /// @dev Role-tagged claim keys: a wallet that is both a referrer and a
    ///      referee holds two independent claims per epoch.
    function _referrerKey(address referrer) internal pure returns (bytes32) {
        return keccak256(abi.encode(REFERRER_ROLE, referrer));
    }

    function _refereeKey(address buyer) internal pure returns (bytes32) {
        return keccak256(abi.encode(REFEREE_ROLE, buyer));
    }

    function _ledgerTotal(uint256 epoch) internal view override returns (uint256) {
        return attributionUsage.totalReferralPointsByEpoch(epoch);
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setBinder(address _binder) external onlyOwner {
        binder = _binder;
        emit BinderUpdated(_binder);
    }
}
