// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AntseedEpochShareRewards} from "../emissions/AntseedEpochShareRewards.sol";

interface IAntseedReferralUsageAccounting {
    function currentEpoch() external view returns (uint256);
    function buyerUsageTotal(address buyer) external view returns (uint256 points, uint256 weightedPoints);
}

interface IAntseedReferralDeposits {
    function getOperator(address buyer) external view returns (address);
}

interface IAntseedReferrerUsageLedger {
    function referrerEpochPoints(uint256 epoch, address referrer) external view returns (uint256);
    function totalReferrerPointsByEpoch(uint256 epoch) external view returns (uint256);
}

/**
 * @title AntseedReferrals
 * @notice Referral bindings and emission-funded referrer rewards.
 *
 *         Binding: the buyer appends the referrer wallet to the metadata it
 *         signs for every settlement (SpendingAuth / FreeUsageAuth). AntseedStatsV2
 *         decodes that tail and calls `bindReferral` on the buyer's first
 *         settlement that carries it, so the binding is buyer-signed, gasless
 *         for the buyer, and works during free usage. Only the configured
 *         binder (Stats) may bind; the first binding is immutable.
 *
 *         Prior usage is no bar to binding: the attribution ledger credits a
 *         referrer only with usage recorded after the binding (it reads
 *         `referrerOf` live and credits growth since its last observation),
 *         so nothing before the bind can ever reach the referrer. Refusing
 *         late binds would only forfeit genuine referrals whose first
 *         attributed settlement was preceded by one without the tail.
 *
 *         Rewards: an AntseedEmissionsGate controller. Each epoch's bucket is
 *         split among referrers pro rata to the recognized usage of the buyers
 *         they referred (`AntseedAttributionUsage.referrerEpochPoints`): a
 *         lone referrer takes the whole bucket, and every additional referrer
 *         dilutes it. Claims are per epoch and permissionless; funds only ever
 *         go to the referrer wallet.
 */
contract AntseedReferrals is AntseedEpochShareRewards {
    IAntseedReferralUsageAccounting public immutable usageAccounting;
    IAntseedReferralDeposits public immutable deposits;
    IAntseedReferrerUsageLedger public immutable attributionUsage;

    /// @notice Contract allowed to submit bindings (AntseedStatsV2).
    address public binder;

    mapping(address buyer => address referrer) public referrerOf;
    mapping(address buyer => uint256 epoch) public boundAtEpoch;
    mapping(address referrer => uint256 count) public referredCount;

    event ReferralBound(address indexed buyer, address indexed referrer, uint256 epoch);
    event ReferralRewardClaimed(
        address indexed referrer, uint256 indexed epoch, uint256 points, uint256 totalPoints, uint256 amount
    );
    event BinderUpdated(address indexed binder);

    error NotBinder();
    error ReferralAlreadyBound();
    error SelfReferral();

    constructor(
        address _emissionsGate,
        address _usageAccounting,
        address _deposits,
        address _attributionUsage,
        address _binder
    ) AntseedEpochShareRewards(_emissionsGate) {
        if (_usageAccounting == address(0) || _deposits == address(0) || _attributionUsage == address(0)) {
            revert InvalidAddress();
        }
        usageAccounting = IAntseedReferralUsageAccounting(_usageAccounting);
        deposits = IAntseedReferralDeposits(_deposits);
        attributionUsage = IAntseedReferrerUsageLedger(_attributionUsage);
        binder = _binder;
    }

    // ─── Binding ─────────────────────────────────────────────────────

    /// @notice Bind `buyer` to `referrer`. Called by AntseedStatsV2 from the
    ///         buyer's first attributed settlement; the referrer value was
    ///         signed by the buyer via metadataHash.
    function bindReferral(address buyer, address referrer) external whenNotPaused {
        if (msg.sender != binder || binder == address(0)) revert NotBinder();
        if (buyer == address(0) || referrer == address(0)) revert InvalidAddress();
        if (referrerOf[buyer] != address(0)) revert ReferralAlreadyBound();

        address operator = deposits.getOperator(buyer);
        if (referrer == buyer || (operator != address(0) && referrer == operator)) revert SelfReferral();

        uint256 epoch = usageAccounting.currentEpoch();
        referrerOf[buyer] = referrer;
        boundAtEpoch[buyer] = epoch;
        referredCount[referrer] += 1;

        emit ReferralBound(buyer, referrer, epoch);
    }

    // ─── Rewards ─────────────────────────────────────────────────────

    /// @notice Mint a referrer's share of an epoch's bucket to the referrer.
    function claim(address referrer, uint256 epoch) external nonReentrant whenNotPaused {
        _claimReferrer(referrer, epoch);
    }

    /// @notice Claim several epochs at once; epochs with nothing to pay are skipped.
    function claimEpochs(address referrer, uint256[] calldata epochs) external nonReentrant whenNotPaused {
        uint256 paid;
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 points = attributionUsage.referrerEpochPoints(epochs[i], referrer);
            if (_pending(epochs[i], _key(referrer), points) == 0) continue;
            paid += _claimReferrer(referrer, epochs[i]);
        }
        if (paid == 0) revert NothingToClaim();
    }

    function claimed(address referrer, uint256 epoch) external view returns (bool) {
        return _isClaimed(epoch, _key(referrer));
    }

    /// @notice What a referrer would receive for an epoch right now.
    function pendingReward(address referrer, uint256 epoch) external view returns (uint256) {
        return _pending(epoch, _key(referrer), attributionUsage.referrerEpochPoints(epoch, referrer));
    }

    // ─── Internal ────────────────────────────────────────────────────

    function _claimReferrer(address referrer, uint256 epoch) internal returns (uint256 amount) {
        uint256 points = attributionUsage.referrerEpochPoints(epoch, referrer);
        uint256 total;
        (amount, total) = _claimShare(epoch, _key(referrer), points, referrer);
        emit ReferralRewardClaimed(referrer, epoch, points, total, amount);
    }

    function _key(address referrer) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(referrer)));
    }

    function _ledgerTotal(uint256 epoch) internal view override returns (uint256) {
        return attributionUsage.totalReferrerPointsByEpoch(epoch);
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setBinder(address _binder) external onlyOwner {
        binder = _binder;
        emit BinderUpdated(_binder);
    }
}
