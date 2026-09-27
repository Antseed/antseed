// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";

interface IAntseedReferralUsageAccounting {
    function currentEpoch() external view returns (uint256);
    function buyerUsageTotal(address buyer) external view returns (uint256 points, uint256 weightedPoints);
}

interface IAntseedReferralUsageRewards {
    function pendingBuyerReward(address buyer, uint256 epoch) external view returns (uint256 amount);
}

interface IAntseedReferralDeposits {
    function getOperator(address buyer) external view returns (address);
}

/**
 * @title AntseedReferrals
 * @notice Emission-funded rewards for wallets that refer active buyers. An
 *         AntseedEmissionsGate controller: each epoch's payouts are minted
 *         from this controller's bucket for that epoch.
 *
 *         Binding: the buyer appends the referrer wallet to the metadata it
 *         signs for every settlement (SpendingAuth / FreeUsageAuth). AntseedStatsV2
 *         decodes that tail and calls `bindReferral` on the buyer's first
 *         settlement, so the binding is buyer-signed, gasless for the buyer,
 *         and lands before any recognized usage — including during free usage.
 *         Only the configured binder (Stats) may bind; the first binding is
 *         immutable.
 *
 *         Rewards: for each finalized epoch, the referrer is entitled to
 *         REFERRAL_RATE_BPS of the referred buyer's usage reward
 *         (`AntseedUsageRewards.pendingBuyerReward`). Accrual is permissionless
 *         and idempotent and records entitlements per epoch; `claim` mints
 *         them from the matching epoch buckets, paying as much of each
 *         epoch's entitlement as that bucket still allows. Entitlements the
 *         bucket cannot cover stay recorded and are paid if budget appears.
 */
contract AntseedReferrals is Ownable2Step, Pausable, ReentrancyGuard {
    uint32 public constant BPS_DENOMINATOR = 10_000;
    uint32 public constant REFERRAL_RATE_BPS = 200;
    uint256 public constant MAX_EPOCHS_PER_ACCRUAL = 52;
    uint256 public constant MAX_EPOCHS_PER_CLAIM = 52;

    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedReferralUsageAccounting public immutable usageAccounting;
    IAntseedReferralUsageRewards public immutable usageRewards;
    IAntseedReferralDeposits public immutable deposits;

    /// @notice Contract allowed to submit bindings (AntseedStatsV2).
    address public binder;

    mapping(address buyer => address referrer) public referrerOf;
    mapping(address buyer => uint256 epoch) public boundAtEpoch;
    mapping(address buyer => uint256 epoch) public nextAccrualEpoch;
    mapping(address referrer => uint256 count) public referredCount;

    /// @notice Entitlement not yet minted, per referrer and epoch.
    mapping(address referrer => mapping(uint256 epoch => uint256 amount)) public claimableByEpoch;
    /// @notice Sum of `claimableByEpoch` over all epochs.
    mapping(address referrer => uint256 amount) public claimable;
    /// @notice Epochs with an entitlement ever recorded for the referrer (claim iterates these).
    mapping(address referrer => uint256[] epochs) private _claimableEpochs;
    mapping(address referrer => mapping(uint256 epoch => bool listed)) private _epochListed;
    /// @notice Total entitlement recorded per epoch, for bucket sizing.
    mapping(uint256 epoch => uint256 amount) public epochEntitled;
    /// @notice Total minted per epoch through this controller.
    mapping(uint256 epoch => uint256 amount) public epochMinted;

    event ReferralBound(address indexed buyer, address indexed referrer, uint256 epoch);
    event ReferralAccrued(
        address indexed buyer,
        address indexed referrer,
        uint256 indexed epoch,
        uint256 buyerReward,
        uint256 referralReward
    );
    event ReferralClaimed(address indexed referrer, uint256 indexed epoch, uint256 amount);
    event BinderUpdated(address indexed binder);

    error InvalidAddress();
    error NotBinder();
    error ReferralAlreadyBound();
    error ReferralNotBound();
    error ReferralMustPrecedeUsage();
    error SelfReferral();
    error EpochNotFinalized();
    error AccrualRangeTooLarge();
    error NothingToClaim();

    constructor(
        address _emissionsGate,
        address _usageAccounting,
        address _usageRewards,
        address _deposits,
        address _binder
    ) Ownable(msg.sender) {
        if (
            _emissionsGate == address(0) || _usageAccounting == address(0) || _usageRewards == address(0)
                || _deposits == address(0)
        ) revert InvalidAddress();
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        usageAccounting = IAntseedReferralUsageAccounting(_usageAccounting);
        usageRewards = IAntseedReferralUsageRewards(_usageRewards);
        deposits = IAntseedReferralDeposits(_deposits);
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

        (uint256 priorUsage,) = usageAccounting.buyerUsageTotal(buyer);
        if (priorUsage != 0) revert ReferralMustPrecedeUsage();

        address operator = deposits.getOperator(buyer);
        if (referrer == buyer || (operator != address(0) && referrer == operator)) revert SelfReferral();

        uint256 epoch = usageAccounting.currentEpoch();
        referrerOf[buyer] = referrer;
        boundAtEpoch[buyer] = epoch;
        nextAccrualEpoch[buyer] = epoch;
        referredCount[referrer] += 1;

        emit ReferralBound(buyer, referrer, epoch);
    }

    // ─── Accrual ─────────────────────────────────────────────────────

    /// @notice Record the referrer's entitlement for every finalized epoch up
    ///         to `throughEpoch`. Permissionless; no-op for epochs already
    ///         accrued.
    function accrue(address buyer, uint256 throughEpoch) external whenNotPaused {
        address referrer = referrerOf[buyer];
        if (referrer == address(0)) revert ReferralNotBound();

        uint256 currentEpoch = usageAccounting.currentEpoch();
        if (throughEpoch >= currentEpoch) revert EpochNotFinalized();

        uint256 epoch = nextAccrualEpoch[buyer];
        if (throughEpoch < epoch) return;
        if (throughEpoch - epoch + 1 > MAX_EPOCHS_PER_ACCRUAL) revert AccrualRangeTooLarge();

        // The operator is usually unset when the binding lands (first
        // settlement), so the self-referral guard is re-checked here once the
        // buyer's stable identity is known: a referrer who is the buyer's own
        // operator accrues nothing.
        bool selfReferred = referrer == deposits.getOperator(buyer);

        for (; epoch <= throughEpoch; epoch++) {
            uint256 buyerReward = usageRewards.pendingBuyerReward(buyer, epoch);
            uint256 referralReward = selfReferred ? 0 : (buyerReward * REFERRAL_RATE_BPS) / BPS_DENOMINATOR;
            if (referralReward != 0) {
                claimableByEpoch[referrer][epoch] += referralReward;
                claimable[referrer] += referralReward;
                epochEntitled[epoch] += referralReward;
                if (!_epochListed[referrer][epoch]) {
                    _epochListed[referrer][epoch] = true;
                    _claimableEpochs[referrer].push(epoch);
                }
            }
            emit ReferralAccrued(buyer, referrer, epoch, buyerReward, referralReward);
        }
        nextAccrualEpoch[buyer] = throughEpoch + 1;
    }

    // ─── Claims ──────────────────────────────────────────────────────

    /// @notice Mint every payable entitlement to the caller, each epoch from
    ///         its own bucket. Reverts only when nothing could be paid.
    function claim() external nonReentrant whenNotPaused {
        uint256[] storage epochs = _claimableEpochs[msg.sender];
        uint256 paidTotal;
        uint256 count = epochs.length;
        uint256 checked;
        for (uint256 i = count; i > 0 && checked < MAX_EPOCHS_PER_CLAIM; i--) {
            checked++;
            uint256 epoch = epochs[i - 1];
            uint256 paid = _payEpoch(msg.sender, epoch);
            paidTotal += paid;
            // Fully paid epochs leave the list (swap-remove keeps it short).
            if (claimableByEpoch[msg.sender][epoch] == 0) {
                _epochListed[msg.sender][epoch] = false;
                epochs[i - 1] = epochs[epochs.length - 1];
                epochs.pop();
            }
        }
        if (paidTotal == 0) revert NothingToClaim();
    }

    /// @notice Mint the caller's entitlement for one epoch.
    function claimEpoch(uint256 epoch) external nonReentrant whenNotPaused {
        if (_payEpoch(msg.sender, epoch) == 0) revert NothingToClaim();
    }

    /// @notice How much of the referrer's entitlement the buckets can pay right now.
    function payableAmount(address referrer) external view returns (uint256 total) {
        uint256[] storage epochs = _claimableEpochs[referrer];
        for (uint256 i = 0; i < epochs.length; i++) {
            total += _payableForEpoch(referrer, epochs[i]);
        }
    }

    function claimableEpochs(address referrer) external view returns (uint256[] memory) {
        return _claimableEpochs[referrer];
    }

    /// @notice Bucket budget for an epoch not yet minted by this controller.
    function remainingEpochBudget(uint256 epoch) public view returns (uint256) {
        uint256 budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        uint256 minted = epochMinted[epoch];
        return budget > minted ? budget - minted : 0;
    }

    // ─── Internal ────────────────────────────────────────────────────

    function _payableForEpoch(address referrer, uint256 epoch) internal view returns (uint256) {
        uint256 entitlement = claimableByEpoch[referrer][epoch];
        if (entitlement == 0 || epoch >= emissionsGate.currentEpoch()) return 0;
        uint256 remaining = remainingEpochBudget(epoch);
        return entitlement < remaining ? entitlement : remaining;
    }

    function _payEpoch(address referrer, uint256 epoch) internal returns (uint256 amount) {
        amount = _payableForEpoch(referrer, epoch);
        if (amount == 0) return 0;
        claimableByEpoch[referrer][epoch] -= amount;
        claimable[referrer] -= amount;
        epochMinted[epoch] += amount;
        emissionsGate.claim(epoch, referrer, amount);
        emit ReferralClaimed(referrer, epoch, amount);
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
