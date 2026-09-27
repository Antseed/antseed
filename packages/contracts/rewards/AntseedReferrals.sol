// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
 * @notice Foundation-funded rewards for wallets that refer active buyers.
 *
 *         Binding: the buyer appends the referrer wallet to the metadata it
 *         signs for every settlement (SpendingAuth / FreeUsageAuth). AntseedStatsV2
 *         decodes that tail and calls `bindReferral` on the buyer's first
 *         settlement, so the binding is buyer-signed, gasless for the buyer,
 *         and lands before any recognized usage — including during free usage.
 *         Only the configured binder (Stats) may bind; the first binding is
 *         immutable.
 *
 *         Rewards: for each finalized epoch, the referrer earns
 *         REFERRAL_RATE_BPS of the referred buyer's usage reward
 *         (`AntseedUsageRewards.pendingBuyerReward`), paid from ANTS the
 *         Foundation deposits here. Accrual is permissionless and idempotent.
 */
contract AntseedReferrals is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint32 public constant BPS_DENOMINATOR = 10_000;
    uint32 public constant REFERRAL_RATE_BPS = 200;
    uint256 public constant MAX_EPOCHS_PER_ACCRUAL = 52;

    IERC20 public immutable ants;
    IAntseedReferralUsageAccounting public immutable usageAccounting;
    IAntseedReferralUsageRewards public immutable usageRewards;
    IAntseedReferralDeposits public immutable deposits;

    /// @notice Contract allowed to submit bindings (AntseedStats).
    address public binder;
    uint256 public totalClaimable;

    mapping(address buyer => address referrer) public referrerOf;
    mapping(address buyer => uint256 epoch) public boundAtEpoch;
    mapping(address buyer => uint256 epoch) public nextAccrualEpoch;
    mapping(address referrer => uint256 amount) public claimable;
    mapping(address referrer => uint256 count) public referredCount;

    event ReferralBound(address indexed buyer, address indexed referrer, uint256 epoch);
    event ReferralAccrued(
        address indexed buyer,
        address indexed referrer,
        uint256 indexed epoch,
        uint256 buyerReward,
        uint256 referralReward
    );
    event ReferralClaimed(address indexed referrer, uint256 amount);
    event Funded(address indexed funder, uint256 amount);
    event ExcessWithdrawn(address indexed to, uint256 amount);
    event BinderUpdated(address indexed binder);

    error InvalidAddress();
    error InvalidAmount();
    error NotBinder();
    error ReferralAlreadyBound();
    error ReferralNotBound();
    error ReferralMustPrecedeUsage();
    error SelfReferral();
    error EpochNotFinalized();
    error AccrualRangeTooLarge();
    error InsufficientFunding();
    error NothingToClaim();

    constructor(address _ants, address _usageAccounting, address _usageRewards, address _deposits, address _binder)
        Ownable(msg.sender)
    {
        if (
            _ants == address(0) || _usageAccounting == address(0) || _usageRewards == address(0)
                || _deposits == address(0)
        ) revert InvalidAddress();
        ants = IERC20(_ants);
        usageAccounting = IAntseedReferralUsageAccounting(_usageAccounting);
        usageRewards = IAntseedReferralUsageRewards(_usageRewards);
        deposits = IAntseedReferralDeposits(_deposits);
        binder = _binder;
    }

    // ─── Binding ─────────────────────────────────────────────────────

    /// @notice Bind `buyer` to `referrer`. Called by AntseedStats from the
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

    /// @notice Credit the referrer for every finalized epoch up to
    ///         `throughEpoch`. Permissionless; no-op for epochs already
    ///         accrued. Reverts (without advancing) when underfunded so the
    ///         Foundation can top up and retry.
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

        uint256 available = ants.balanceOf(address(this)) - totalClaimable;
        for (; epoch <= throughEpoch; epoch++) {
            uint256 buyerReward = usageRewards.pendingBuyerReward(buyer, epoch);
            uint256 referralReward = selfReferred ? 0 : (buyerReward * REFERRAL_RATE_BPS) / BPS_DENOMINATOR;
            if (referralReward > available) revert InsufficientFunding();
            if (referralReward != 0) {
                claimable[referrer] += referralReward;
                totalClaimable += referralReward;
                available -= referralReward;
            }
            emit ReferralAccrued(buyer, referrer, epoch, buyerReward, referralReward);
        }
        nextAccrualEpoch[buyer] = throughEpoch + 1;
    }

    // ─── Claims & funding ────────────────────────────────────────────

    function claim() external nonReentrant whenNotPaused {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        ants.safeTransfer(msg.sender, amount);

        emit ReferralClaimed(msg.sender, amount);
    }

    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        ants.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice ANTS not yet promised to any referrer.
    function unallocated() public view returns (uint256) {
        return ants.balanceOf(address(this)) - totalClaimable;
    }

    /// @notice Return unallocated ANTS to the Foundation. Never touches
    ///         amounts already credited to referrers.
    function withdrawExcess(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0 || amount > unallocated()) revert InvalidAmount();
        ants.safeTransfer(to, amount);
        emit ExcessWithdrawn(to, amount);
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
