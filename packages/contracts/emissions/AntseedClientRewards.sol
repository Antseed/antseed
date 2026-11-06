// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedSellerPools} from "../interfaces/IAntseedSellerPools.sol";
import {IAntseedUsageAccounting} from "../interfaces/IAntseedUsageAccounting.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

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
 *         Finality: every credit lands in the epoch that settled it, so an epoch
 *         is final and claimable as soon as it ends.
 */
contract AntseedClientRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedUsageAccounting public immutable usageAccounting;
    IERC8004Registry public immutable identityRegistry;
    /// @notice The accounting records earlier settlements under this epoch, so credits do too.
    uint256 public immutable firstCreditEpoch;
    IAntseedSellerPools public sellerPools;

    /// @notice Contract allowed to credit usage (AntseedChannelsMiddleware).
    address public recorder;

    mapping(uint256 epoch => mapping(uint256 clientAgentId => uint256 points)) public clientEpochPoints;

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

    error InvalidAddress();
    error NotRecorder();
    error NotRewardRecipient();
    error EpochNotClaimable();
    error AlreadyClaimed();
    error NothingToClaim();

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
    ///         it. Not pausable: pausing stops payouts, not bookkeeping. A client
    ///         id with no registered agent earns nothing.
    function creditClientUsage(uint256 clientAgentId, address buyer, uint256 points) external {
        if (msg.sender != recorder) revert NotRecorder();
        if (_agentOwner(clientAgentId) == address(0)) return;
        uint256 epoch = Math.max(emissionsGate.currentEpoch(), firstCreditEpoch);
        clientEpochPoints[epoch][clientAgentId] += points;
        emit ClientUsageCredited(epoch, clientAgentId, buyer, points);
    }

    // ─── Rewards ─────────────────────────────────────────────────────

    function isClaimable(uint256 epoch) public view returns (bool) {
        return epoch < emissionsGate.currentEpoch();
    }

    /// @notice Mint a client's reward to the agent owner, who must send this.
    function claimClientReward(uint256 clientAgentId, uint256 epoch) external nonReentrant whenNotPaused {
        PreparedReward memory reward = _prepareClientReward(clientAgentId, epoch);
        _mintReward(epoch, reward.recipient, reward.claimableAmount, reward.reserveAmount);
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
        newPositionId = _stakeClaimedReward(
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

    function _mintReward(uint256 epoch, address recipient, uint256 claimableAmount, uint256 reserveAmount) internal {
        if (claimableAmount != 0) emissionsGate.claim(epoch, recipient, claimableAmount);
        if (reserveAmount != 0) emissionsGate.claim(epoch, _emissionsReserve(), reserveAmount);
    }

    function _stakeClaimedReward(
        address staker,
        uint256 stakeAgentId,
        uint256 stakeEpochs,
        uint256 epoch,
        uint256 claimableAmount,
        uint256 reserveAmount
    ) internal returns (uint256 newPositionId) {
        IAntseedSellerPools pools = sellerPools;
        if (address(pools) == address(0)) revert InvalidAddress();

        _mintReward(epoch, address(this), claimableAmount, reserveAmount);

        IERC20 token = pools.antsToken();
        if (address(token) == address(0)) revert InvalidAddress();
        token.forceApprove(address(pools), claimableAmount);
        newPositionId = pools.stakeFor(staker, stakeAgentId, claimableAmount, stakeEpochs);
        token.forceApprove(address(pools), 0);
    }

    function _emissionsReserve() internal view returns (address reserve) {
        reserve = emissionsGate.emissionsReserve();
        if (reserve == address(0)) revert InvalidAddress();
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
