// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedSellerPools} from "../interfaces/IAntseedSellerPools.sol";
import {IAntseedUsageAccounting} from "../interfaces/IAntseedUsageAccounting.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";
import {AntseedRewardPayout} from "../rewards/AntseedRewardPayout.sol";

/**
 * @title AntseedClientRewards
 * @notice Emission-funded rewards for client software (Desktop, CLI,
 *         third-party apps), structured like AntseedUsageRewards.
 *
 *         Rewards: a client earns the epoch's gate bucket in proportion to its share of all
 *         recognized buyer usage: producing 3% of an epoch's weighted buyer
 *         points earns 3% of the bucket. Each client is capped at 5% of the
 *         bucket per epoch and the excess goes to the emissions reserve. The
 *         part of the bucket earned by usage no client produced is never
 *         minted. Only the ERC-8004 agent owner claims or stakes, so
 *         transferring an agent hands over its unclaimed past epochs too.
 *
 *         Attribution: AntseedChannelsMiddleware reads the client from the
 *         buyer-signed metadata and credits the growth in the buyer's weighted
 *         points here, inside the settlement. Points are the accounting's, so
 *         wash exclusion and verification shaping are already applied.
 *
 *         Per-buyer cap: the buyer signs the client id, so a buyer can name an
 *         agent of their own and earn the client share on their own spend.
 *         Each buyer's spend counts toward clients, across every client id,
 *         only up to `buyerEpochCap` USDC per epoch; the points for spend past
 *         it are credited to no client. Clients earn by reaching many buyers,
 *         not by one large buyer's volume.
 *
 *         Finality: every credit lands in the epoch that settled it, so an epoch
 *         is final and claimable as soon as it ends.
 */
contract AntseedClientRewards is Ownable2Step, Pausable, ReentrancyGuard {
    /// @dev Values shared by the claim and stake tails of a reward.
    struct PreparedReward {
        address recipient;
        uint256 weightedPoints;
        uint256 totalWeightedPoints;
        uint256 grossAmount;
        uint256 claimableAmount;
        uint256 reserveAmount;
    }

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_REWARD_SHARE_BPS = 500;
    /// @notice Bounds and start value of `buyerEpochCap`, in USDC base units (6 decimals).
    uint256 public constant MIN_BUYER_EPOCH_CAP = 1e6;
    uint256 public constant MAX_BUYER_EPOCH_CAP = 1_000e6;
    uint256 public constant DEFAULT_BUYER_EPOCH_CAP = 50e6;

    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedUsageAccounting public immutable usageAccounting;
    IERC8004Registry public immutable identityRegistry;
    /// @notice The accounting records earlier settlements under this epoch, so credits do too.
    uint256 public immutable firstCreditEpoch;
    IAntseedSellerPools public sellerPools;

    /// @notice Contract allowed to credit usage (AntseedChannelsMiddleware).
    address public recorder;

    /// @notice USDC a buyer's spend can count toward clients per epoch, across all clients.
    uint256 public buyerEpochCap = DEFAULT_BUYER_EPOCH_CAP;

    mapping(uint256 epoch => mapping(uint256 clientAgentId => uint256 points)) public clientEpochPoints;

    /// @notice USDC of a buyer's spend already counted toward clients in an epoch.
    mapping(uint256 epoch => mapping(address buyer => uint256 usdc)) public buyerEpochCreditedUsdc;

    mapping(uint256 clientAgentId => mapping(uint256 epoch => bool)) public clientEpochClaimed;

    event ClientUsageCredited(uint256 indexed epoch, uint256 indexed clientAgentId, address indexed buyer, uint256 points);
    event ClientRewardClaimed(
        address indexed recipient,
        uint256 indexed clientAgentId,
        uint256 indexed epoch,
        uint256 weightedPoints,
        uint256 totalWeightedPoints,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 reserveAmount
    );
    event ClientRewardStaked(
        address indexed recipient,
        uint256 indexed clientAgentId,
        uint256 indexed stakeAgentId,
        uint256 epoch,
        uint256 newPositionId,
        uint256 weightedPoints,
        uint256 totalWeightedPoints,
        uint256 grossAmount,
        uint256 stakedAmount,
        uint256 reserveAmount
    );
    event SellerPoolsSet(address indexed sellerPools);
    event RecorderUpdated(address indexed recorder);
    event BuyerEpochCapUpdated(uint256 buyerEpochCap);

    error InvalidAddress();
    error NotRecorder();
    error NotRewardRecipient();
    error EpochNotClaimable();
    error AlreadyClaimed();
    error NothingToClaim();
    error InvalidBuyerEpochCap();

    constructor(address _emissionsGate, address _usageAccounting, address _identityRegistry, address _recorder)
        Ownable(msg.sender)
    {
        if (_emissionsGate == address(0) || _usageAccounting == address(0) || _identityRegistry == address(0)) {
            revert InvalidAddress();
        }
        // `ownerOf` is wrapped in try/catch, but a call to an address without
        // code succeeds with empty return data and the caller-side ABI decode
        // then reverts outside the catch. That would make every credit and
        // every claim revert, so a mis-set registry must fail here.
        if (_identityRegistry.code.length == 0) revert InvalidAddress();
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        firstCreditEpoch = IAntseedUsageAccounting(_usageAccounting).firstRewardedEpoch();
        identityRegistry = IERC8004Registry(_identityRegistry);
        recorder = _recorder;
    }

    // ─── Recording ───────────────────────────────────────────────────

    /// @notice Credit a settlement's weighted points to the client that produced
    ///         it, for the part of its `usdc` still under the buyer's epoch cap.
    ///         Not pausable: pausing stops payouts, not bookkeeping. A client id
    ///         with no registered agent earns nothing and uses none of the cap.
    function creditClientUsage(uint256 clientAgentId, address buyer, uint256 usdc, uint256 points) external {
        if (msg.sender != recorder) revert NotRecorder();
        if (usdc == 0 || points == 0) return;
        if (_agentOwner(clientAgentId) == address(0)) return;
        uint256 epoch = Math.max(emissionsGate.currentEpoch(), firstCreditEpoch);

        uint256 counted = buyerEpochCreditedUsdc[epoch][buyer];
        uint256 cap = buyerEpochCap;
        if (counted >= cap) return;
        uint256 countedNow = Math.min(usdc, cap - counted);
        buyerEpochCreditedUsdc[epoch][buyer] = counted + countedNow;

        uint256 credited = countedNow == usdc ? points : Math.mulDiv(points, countedNow, usdc);
        if (credited == 0) return;
        clientEpochPoints[epoch][clientAgentId] += credited;
        emit ClientUsageCredited(epoch, clientAgentId, buyer, credited);
    }

    // ─── Rewards ─────────────────────────────────────────────────────

    function isClaimable(uint256 epoch) public view returns (bool) {
        return epoch < emissionsGate.currentEpoch();
    }

    /// @notice Mint a client's reward to the agent owner, who must send this.
    function claimClientReward(uint256 clientAgentId, uint256 epoch) external nonReentrant whenNotPaused {
        PreparedReward memory reward = _prepareClientReward(clientAgentId, epoch);
        AntseedRewardPayout.mint(emissionsGate, epoch, reward.recipient, reward.claimableAmount, reward.reserveAmount);
        emit ClientRewardClaimed(
            reward.recipient,
            clientAgentId,
            epoch,
            reward.weightedPoints,
            reward.totalWeightedPoints,
            reward.grossAmount,
            reward.claimableAmount,
            reward.reserveAmount
        );
    }

    /// @notice Stake a client's reward into any seller's pool for the agent's owner.
    function stakeClientReward(uint256 clientAgentId, uint256 epoch, uint256 stakeAgentId, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 newPositionId)
    {
        if (stakeAgentId == 0) revert InvalidAddress();
        PreparedReward memory reward = _prepareClientReward(clientAgentId, epoch);
        newPositionId = AntseedRewardPayout.stake(
            emissionsGate,
            sellerPools,
            reward.recipient, stakeAgentId, stakeEpochs, epoch, reward.claimableAmount, reward.reserveAmount
        );
        emit ClientRewardStaked(
            reward.recipient,
            clientAgentId,
            stakeAgentId,
            epoch,
            newPositionId,
            reward.weightedPoints,
            reward.totalWeightedPoints,
            reward.grossAmount,
            reward.claimableAmount,
            reward.reserveAmount
        );
    }

    /// @notice What a client's owner would receive for an epoch right now.
    function pendingClientReward(uint256 clientAgentId, uint256 epoch) external view returns (uint256) {
        if (!isClaimable(epoch) || clientEpochClaimed[clientAgentId][epoch]) return 0;
        uint256 points = clientEpochPoints[epoch][clientAgentId];
        uint256 total = usageAccounting.totalWeightedBuyerPointsByEpoch(epoch);
        if (points == 0 || total == 0) return 0;
        uint256 budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        return Math.min(Math.mulDiv(budget, points, total), _rewardCap(budget));
    }

    function rewardRecipient(uint256 clientAgentId) external view returns (address) {
        return _agentOwner(clientAgentId);
    }

    // ─── Internal ────────────────────────────────────────────────────

    function _prepareClientReward(uint256 clientAgentId, uint256 epoch) internal returns (PreparedReward memory reward) {
        if (!isClaimable(epoch)) revert EpochNotClaimable();
        if (clientEpochClaimed[clientAgentId][epoch]) revert AlreadyClaimed();

        reward.weightedPoints = clientEpochPoints[epoch][clientAgentId];
        reward.totalWeightedPoints = usageAccounting.totalWeightedBuyerPointsByEpoch(epoch);
        if (reward.weightedPoints == 0 || reward.totalWeightedPoints == 0) revert NothingToClaim();

        uint256 budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        reward.grossAmount = Math.mulDiv(budget, reward.weightedPoints, reward.totalWeightedPoints);
        if (reward.grossAmount == 0) revert NothingToClaim();
        reward.claimableAmount = Math.min(reward.grossAmount, _rewardCap(budget));
        reward.reserveAmount = reward.grossAmount - reward.claimableAmount;

        reward.recipient = _agentOwner(clientAgentId);
        if (reward.recipient == address(0)) revert InvalidAddress();
        if (msg.sender != reward.recipient) revert NotRewardRecipient();

        clientEpochClaimed[clientAgentId][epoch] = true;
    }

    function _rewardCap(uint256 budget) internal pure returns (uint256) {
        return (budget * MAX_REWARD_SHARE_BPS) / BPS_DENOMINATOR;
    }

    /// @dev ERC-721 registries revert for unknown ids; treat that as no owner.
    function _agentOwner(uint256 clientAgentId) internal view returns (address) {
        try identityRegistry.ownerOf(clientAgentId) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setRecorder(address _recorder) external onlyOwner {
        recorder = _recorder;
        emit RecorderUpdated(_recorder);
    }

    /// @notice Change the per-buyer cap. It applies from the next credit, and
    ///         spend already counted this epoch stays counted.
    function setBuyerEpochCap(uint256 _buyerEpochCap) external onlyOwner {
        if (_buyerEpochCap < MIN_BUYER_EPOCH_CAP || _buyerEpochCap > MAX_BUYER_EPOCH_CAP) {
            revert InvalidBuyerEpochCap();
        }
        buyerEpochCap = _buyerEpochCap;
        emit BuyerEpochCapUpdated(_buyerEpochCap);
    }

    function setSellerPools(address _sellerPools) external onlyOwner {
        if (_sellerPools == address(0)) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(_sellerPools);
        emit SellerPoolsSet(_sellerPools);
    }

    /// @notice Stops claims and stakes. Crediting keeps running.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
