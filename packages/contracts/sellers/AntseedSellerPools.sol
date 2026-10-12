// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

/**
 * @title AntseedSellerPools
 * @notice ANTS stake pools keyed by ERC-8004 agent id.
 *
 *         Sellers are not special stakers in this contract. Every position has
 *         an owner, an agent id, an amount, and a lock window. Pool rewards are
 *         routed to the agent pool and claimed pro-rata by position weight.
 *
 *         Important behavior:
 *           - There is no explicit "create pool" action. A pool exists when an
 *             agent id has active stake for an epoch.
 *           - Pools are keyed by agent id, not seller address. If an agent is
 *             sold, historical stake remains attached to that agent pool.
 *           - This contract only tracks stake, pool power, position weights,
 *             and slashing. Usage verification, wash-trading policy, and
 *             reward-program shares live outside it.
 *           - Normal pool power is stored as range deltas in Fenwick trees.
 *             Reads use exact prefix sums and never loop over positions.
 *           - New stake and restaked rewards activate after
 *             `stakeActivationDelay`. Moves and early withdrawals take effect
 *             at the next epoch so current-epoch power stays frozen.
 *           - Max-locked positions hold constant maximum-duration power until
 *             disabled. Disabling starts a fresh max-duration countdown.
 *           - Moving stake keeps principal but may reduce `weightAmount` via
 *             `moveWeightPenaltyBps`; early withdrawal may slash principal.
 */
contract AntseedSellerPools is IAntseedSellerPools, ERC721, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace256;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_STAKE_EPOCHS = 104;
    uint256 public constant MAX_RESTAKED_REWARD_WEIGHT_BONUS_BPS = 2_000;
    uint256 public constant FENWICK_SIZE = 4096;
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsGate public immutable emissionsGate;
    address public immutable identityRegistry;
    address public stakingSource;
    IERC20 public immutable antsToken;

    // ─── Configurable Parameters ─────────────────────────────────────
    uint256 public minStakeEpochs = 1;
    uint256 public stakeActivationDelay = 1;
    uint256 public maxSlashBps = 5_000;
    uint256 public minEarlyExitSlashBps = 500;
    uint256 public restakedRewardWeightBonusBps = 500;
    uint256 public moveWeightPenaltyBps = 0;
    uint256 public nextPositionId = 1;

    // ─── Structs ─────────────────────────────────────────────────────
    struct Position {
        address owner;
        uint256 agentId;
        uint256 amount;
        uint256 weightAmount;
        uint64 stakeStartEpoch;
        uint64 stakeEndEpoch;
        uint64 closedAtEpoch;
        bool withdrawn;
    }

    struct FenwickTree {
        mapping(uint256 => int256) values;
    }

    // ─── Position And Epoch Accounting ───────────────────────────────
    mapping(uint256 => Position) public positions;

    mapping(uint256 => FenwickTree) private _poolPowerTree;
    FenwickTree private _totalPowerTree;
    mapping(uint256 => Checkpoints.Trace256) private _poolMaxLockWeightAmount;
    Checkpoints.Trace256 private _totalMaxLockWeightAmount;
    mapping(uint256 => Checkpoints.Trace256) private _positionMaxLockPower;
    mapping(uint256 => Checkpoints.Trace256) private _positionNormalStartEpoch;
    mapping(uint256 => Checkpoints.Trace256) private _positionNormalEndEpoch;
    mapping(uint256 => uint64) public positionWithdrawableEpoch;

    // ─── Reward-Staker Permissions ───────────────────────────────────
    mapping(address => bool) public rewardStakers;

    mapping(address => uint256[]) private _stakerPositionIds;
    mapping(uint256 => uint256) private _stakerPositionIndex;

    // ─── Staker Portfolio Totals ─────────────────────────────────────
    mapping(address => uint256) public stakerTotalActiveStake;
    mapping(address => mapping(uint256 => uint256)) public stakerAgentActiveStake;

    // ─── Modifiers ───────────────────────────────────────────────────
    modifier onlyRewardStaker() {
        if (!rewardStakers[msg.sender]) revert NotRewardStaker();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _antsToken, address _emissionsGate, address _identityRegistry, address _stakingSource)
        ERC721("Locked Antseed Stake", "lANTS")
        Ownable(msg.sender)
    {
        if (_antsToken == address(0) || _emissionsGate == address(0) || _identityRegistry == address(0)) {
            revert InvalidAddress();
        }
        antsToken = IERC20(_antsToken);
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        identityRegistry = _identityRegistry;
        stakingSource = _stakingSource;
    }

    // ─── Epoch Helpers ────────────────────────────────────────────────
    function currentEpoch() public view returns (uint256) {
        return emissionsGate.currentEpoch();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — STAKE
    // ═══════════════════════════════════════════════════════════════════

    function stake(uint256 agentId, uint256 amount, uint256 stakeEpochs) external returns (uint256 positionId) {
        return stakeFor(msg.sender, agentId, amount, stakeEpochs);
    }

    /**
     * @notice Stake ANTS for `staker` into an agent pool.
     *         Tokens are pulled from msg.sender, but the created position
     *         belongs to `staker`. This supports wallets, contracts, and
     *         delegated funding flows without changing position ownership.
     */
    function stakeFor(address staker, uint256 agentId, uint256 amount, uint256 stakeEpochs)
        public
        nonReentrant
        returns (uint256 positionId)
    {
        if (staker == address(0)) revert InvalidAddress();
        _requireRegisteredSellerAgent(agentId);
        if (amount == 0) revert InvalidValue();
        if (stakeEpochs < minStakeEpochs || stakeEpochs > MAX_STAKE_EPOCHS) revert StakeDurationOutOfBounds();

        antsToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 startEpoch = currentEpoch() + stakeActivationDelay;
        uint256 stakeEndEpoch = startEpoch + stakeEpochs;
        positionId = _createWeightedPosition(staker, agentId, amount, amount, startEpoch, startEpoch, stakeEndEpoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — MOVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Move one position's remaining lock window to another agent pool.
     *         This closes the old pool exposure next epoch and opens a new
     *         position with the same principal and end epoch. Any configured
     *         move penalty reduces only future weight, not withdrawable
     *         principal. The replacement preserves the source's early-exit
     *         slash basis and cannot be withdrawn before it takes over the
     *         source's power.
     */
    function moveStake(uint256 positionId, uint256 toAgentId) external nonReentrant returns (uint256 newPositionId) {
        _requireRegisteredSellerAgent(toAgentId);
        newPositionId = _movePosition(positionId, toAgentId, msg.sender, currentEpoch() + 1);
    }

    function moveStakes(uint256[] calldata positionIds, uint256 toAgentId)
        external
        nonReentrant
        returns (uint256[] memory newPositionIds)
    {
        if (positionIds.length == 0) revert InvalidValue();
        _requireRegisteredSellerAgent(toAgentId);
        uint256 effectiveEpoch = currentEpoch() + 1;
        newPositionIds = new uint256[](positionIds.length);
        for (uint256 i = 0; i < positionIds.length; i++) {
            newPositionIds[i] = _movePosition(positionIds[i], toAgentId, msg.sender, effectiveEpoch);
        }
    }

    /**
     * @notice Extend a normal locked position from the next epoch onward.
     *         Historical epochs keep the old lock curve. The new end cannot be
     *         further than `MAX_STAKE_EPOCHS` from the effective epoch.
     */
    function extendLock(uint256 positionId, uint256 additionalEpochs) external nonReentrant {
        if (additionalEpochs == 0) revert InvalidValue();

        Position storage position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (ownerOf(positionId) != msg.sender) revert NotPositionOwner();
        if (position.withdrawn || position.closedAtEpoch != 0) revert PositionClosed();

        uint256 effectiveEpoch = currentEpoch() + 1;
        if (effectiveEpoch < position.stakeStartEpoch) effectiveEpoch = position.stakeStartEpoch;
        if (_positionMaxLockPower[positionId].upperLookupRecent(effectiveEpoch) != 0) revert PositionClosed();

        uint256 oldEndEpoch = _positionNormalEndEpoch[positionId].upperLookupRecent(effectiveEpoch);
        if (oldEndEpoch == 0 || effectiveEpoch >= oldEndEpoch) revert StakeDurationOutOfBounds();

        uint256 maxEndEpoch = effectiveEpoch + MAX_STAKE_EPOCHS;
        uint256 requestedEndEpoch = oldEndEpoch + additionalEpochs;
        uint256 newEndEpoch = requestedEndEpoch > maxEndEpoch ? maxEndEpoch : requestedEndEpoch;
        if (newEndEpoch <= oldEndEpoch) revert StakeDurationOutOfBounds();

        position.stakeEndEpoch = uint64(newEndEpoch);
        _positionNormalEndEpoch[positionId].push(effectiveEpoch, newEndEpoch);
        _removePowerRange(position.agentId, effectiveEpoch, oldEndEpoch, position.weightAmount);
        _addPowerRange(position.agentId, effectiveEpoch, newEndEpoch, position.weightAmount);

        emit LockExtended(positionId, msg.sender, effectiveEpoch, newEndEpoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — MAX LOCK
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Keep a position at max-duration power from the next epoch onward.
     *         Historical epochs remain claimable under the position's previous
     *         lock curve. The position cannot be moved or withdrawn while
     *         max-lock power is active; disable first to start the countdown.
     */
    function enableMaxLock(uint256 positionId) external nonReentrant {
        Position storage position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (ownerOf(positionId) != msg.sender) revert NotPositionOwner();
        if (position.withdrawn || position.closedAtEpoch != 0) revert PositionClosed();

        uint256 effectiveEpoch = currentEpoch() + 1;
        if (effectiveEpoch < position.stakeStartEpoch) revert StakeDurationOutOfBounds();
        if (_positionMaxLockPower[positionId].upperLookupRecent(effectiveEpoch) != 0) revert InvalidValue();

        uint256 normalEndEpoch = _positionNormalEndEpoch[positionId].upperLookupRecent(effectiveEpoch);
        if (normalEndEpoch == 0 || effectiveEpoch >= normalEndEpoch) revert StakeDurationOutOfBounds();

        _removePowerRange(position.agentId, effectiveEpoch, normalEndEpoch, position.weightAmount);

        uint256 maxLockPower = position.weightAmount * MAX_STAKE_EPOCHS;
        _positionMaxLockPower[positionId].push(effectiveEpoch, maxLockPower);
        _positionNormalStartEpoch[positionId].push(effectiveEpoch, 0);
        _positionNormalEndEpoch[positionId].push(effectiveEpoch, 0);
        _applyMaxLockWeightAmount(position.agentId, effectiveEpoch, position.weightAmount, true);

        emit MaxLockEnabled(positionId, msg.sender, effectiveEpoch);
    }

    /**
     * @notice Disable max lock from the next epoch. The position starts a fresh
     *         max-duration linear countdown and can only be withdrawn once that
     *         countdown has elapsed, unless it exits early with the configured
     *         slash.
     */
    function disableMaxLock(uint256 positionId) external nonReentrant {
        Position storage position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (ownerOf(positionId) != msg.sender) revert NotPositionOwner();
        if (position.withdrawn || position.closedAtEpoch != 0) revert PositionClosed();

        uint256 effectiveEpoch = currentEpoch() + 1;
        if (_positionMaxLockPower[positionId].upperLookupRecent(effectiveEpoch) == 0) revert InvalidValue();

        uint256 newStakeEndEpoch = effectiveEpoch + MAX_STAKE_EPOCHS;
        position.stakeEndEpoch = uint64(newStakeEndEpoch);
        _positionMaxLockPower[positionId].push(effectiveEpoch, 0);
        _positionNormalStartEpoch[positionId].push(effectiveEpoch, effectiveEpoch);
        _positionNormalEndEpoch[positionId].push(effectiveEpoch, newStakeEndEpoch);
        _applyMaxLockWeightAmount(position.agentId, effectiveEpoch, position.weightAmount, false);
        _addPowerRange(position.agentId, effectiveEpoch, newStakeEndEpoch, position.weightAmount);

        emit MaxLockDisabled(positionId, msg.sender, effectiveEpoch, newStakeEndEpoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — SPLIT / MERGE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Split a position into two positions with the same lock terms.
     *         Principal is divided exactly and weight pro-rata to principal, so
     *         pool power is unchanged. The source position closes next epoch
     *         and its rewards accrued until then stay claimable on it.
     *         The replacements preserve the source's early-exit slash basis
     *         and cannot be withdrawn before they take over its power.
     *         Max-locked positions must disable max lock first; disabling,
     *         splitting, and re-enabling on the parts within one epoch keeps
     *         max power seamless since all take effect at the next epoch.
     */
    function splitStake(uint256 positionId, uint256 splitAmount)
        external
        nonReentrant
        returns (uint256 firstPositionId, uint256 secondPositionId)
    {
        Position storage position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (ownerOf(positionId) != msg.sender) revert NotPositionOwner();
        if (splitAmount == 0 || splitAmount >= position.amount) revert InvalidValue();

        uint256 effectiveEpoch = currentEpoch() + 1;
        if (effectiveEpoch < position.stakeStartEpoch) effectiveEpoch = position.stakeStartEpoch;

        uint256 agentId = position.agentId;
        uint256 firstAmount = position.amount - splitAmount;
        uint256 secondWeight = (position.weightAmount * splitAmount) / position.amount;
        uint256 firstWeight = position.weightAmount - secondWeight;
        // A zero-weight part would be a pointless dust position.
        if (firstWeight == 0 || secondWeight == 0) revert InvalidValue();

        (uint256 normalStartEpoch, uint256 normalEndEpoch) = _closePositionForRestructure(positionId, effectiveEpoch);

        firstPositionId = _createRestructuredPosition(
            msg.sender, agentId, firstAmount, firstWeight, effectiveEpoch, normalStartEpoch, normalEndEpoch
        );
        secondPositionId = _createRestructuredPosition(
            msg.sender, agentId, splitAmount, secondWeight, effectiveEpoch, normalStartEpoch, normalEndEpoch
        );
        emit StakeSplit(positionId, firstPositionId, secondPositionId, msg.sender, firstAmount, splitAmount);
    }

    /**
     * @notice Merge positions in the same agent pool into one position.
     *         All positions must share the same end epoch and early-exit slash
     *         start, so merging preserves both pool power and slash terms. The
     *         sources close next epoch and their rewards accrued until then
     *         stay claimable on them. The replacement cannot be withdrawn
     *         before it takes over the sources' power.
     *         Max-locked positions must disable max lock first; disabling the
     *         sources in the same epoch aligns their end epochs, making them
     *         mergeable even if their original terms differed.
     */
    function mergeStakes(uint256[] calldata positionIds) external nonReentrant returns (uint256 newPositionId) {
        if (positionIds.length < 2) revert InvalidValue();

        // The merged position starts when the latest source would have; sources
        // that are already active keep earning until then.
        uint256 effectiveEpoch = currentEpoch() + 1;
        for (uint256 i = 0; i < positionIds.length; i++) {
            Position storage position = positions[positionIds[i]];
            if (position.owner == address(0)) revert InvalidPosition();
            if (ownerOf(positionIds[i]) != msg.sender) revert NotPositionOwner();
            if (position.stakeStartEpoch > effectiveEpoch) effectiveEpoch = position.stakeStartEpoch;
        }

        uint256 agentId = positions[positionIds[0]].agentId;
        uint256 mergedAmount;
        uint256 mergedWeight;
        uint256 sharedStartEpoch;
        uint256 sharedEndEpoch;
        for (uint256 i = 0; i < positionIds.length; i++) {
            Position storage position = positions[positionIds[i]];
            if (position.agentId != agentId) revert InvalidValue();
            mergedAmount += position.amount;
            mergedWeight += position.weightAmount;

            // Duplicate ids revert here: the first close stamps closedAtEpoch.
            (uint256 normalStartEpoch, uint256 normalEndEpoch) =
                _closePositionForRestructure(positionIds[i], effectiveEpoch);
            if (i == 0) {
                sharedStartEpoch = normalStartEpoch;
                sharedEndEpoch = normalEndEpoch;
            } else if (normalStartEpoch != sharedStartEpoch || normalEndEpoch != sharedEndEpoch) {
                revert InvalidValue();
            }
        }

        newPositionId = _createRestructuredPosition(
            msg.sender, agentId, mergedAmount, mergedWeight, effectiveEpoch, sharedStartEpoch, sharedEndEpoch
        );
        emit StakesMerged(positionIds, newPositionId, msg.sender, mergedAmount, mergedWeight);
    }

    // ─── Internal Move Helper ─────────────────────────────────────────
    function _movePosition(uint256 positionId, uint256 toAgentId, address staker, uint256 effectiveEpoch)
        internal
        returns (uint256 newPositionId)
    {
        Position storage position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (ownerOf(positionId) != staker) revert NotPositionOwner();

        // A position that has not activated yet (stakeActivationDelay > 1) added
        // power only from stakeStartEpoch onward; never remove before that, and
        // keep the original activation epoch instead of activating earlier.
        if (effectiveEpoch < position.stakeStartEpoch) effectiveEpoch = position.stakeStartEpoch;
        (uint256 normalStartEpoch, uint256 normalEndEpoch) = _closePositionForRestructure(positionId, effectiveEpoch);

        uint256 movedWeightAmount = position.weightAmount;
        uint256 penaltyBps = moveWeightPenaltyBps;
        if (penaltyBps != 0) {
            movedWeightAmount = (movedWeightAmount * (BPS_DENOMINATOR - penaltyBps)) / BPS_DENOMINATOR;
        }

        newPositionId = _createRestructuredPosition(
            staker, toAgentId, position.amount, movedWeightAmount, effectiveEpoch, normalStartEpoch, normalEndEpoch
        );
        emit StakeMoved(positionId, newPositionId, staker, position.agentId, toAgentId);
    }

    // ─── Internal Restructure Helper ──────────────────────────────────

    /**
     * @dev Close a position at `effectiveEpoch` for move/split/merge, removing
     *      its remaining power range. Max-locked positions must be disabled
     *      first, as for withdrawals. Rewards accrued through effectiveEpoch
     *      stay claimable on the closed position.
     */
    function _closePositionForRestructure(uint256 positionId, uint256 effectiveEpoch)
        internal
        returns (uint256 normalStartEpoch, uint256 normalEndEpoch)
    {
        Position storage position = positions[positionId];
        if (position.withdrawn) revert AlreadyWithdrawn();
        if (position.closedAtEpoch != 0) revert PositionClosed();
        if (_positionMaxLockPower[positionId].upperLookupRecent(effectiveEpoch) != 0) revert PositionClosed();

        normalStartEpoch = _positionNormalStartEpoch[positionId].upperLookupRecent(effectiveEpoch);
        normalEndEpoch = _positionNormalEndEpoch[positionId].upperLookupRecent(effectiveEpoch);
        if (normalEndEpoch == 0 || effectiveEpoch >= normalEndEpoch) {
            revert StakeDurationOutOfBounds();
        }
        _removePowerRange(position.agentId, effectiveEpoch, normalEndEpoch, position.weightAmount);

        position.closedAtEpoch = uint64(effectiveEpoch);
        _decreaseActiveStake(position.owner, position.agentId, position.amount);
        _burn(positionId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESTAKE REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Called by approved reward controllers after they mint earned ANTS
     *         to this contract. The minted amount is staked into the source
     *         position's agent pool with a lock-length-based weight bonus.
     */
    function stakeMintedReward(address staker, uint256 sourcePositionId, uint256 amount, uint256 stakeEpochs)
        external
        nonReentrant
        onlyRewardStaker
        returns (uint256 newPositionId)
    {
        if (staker == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidValue();
        if (stakeEpochs < minStakeEpochs || stakeEpochs > MAX_STAKE_EPOCHS) revert StakeDurationOutOfBounds();

        Position memory sourcePosition = positions[sourcePositionId];
        if (sourcePosition.owner == address(0)) revert InvalidPosition();
        if (sourcePosition.owner != staker) revert NotPositionOwner();

        uint256 startEpoch = currentEpoch() + stakeActivationDelay;
        uint256 stakeEndEpoch = startEpoch + stakeEpochs;
        uint256 bonusBps = (restakedRewardWeightBonusBps * stakeEpochs) / MAX_STAKE_EPOCHS;
        uint256 weightAmount = (amount * (BPS_DENOMINATOR + bonusBps)) / BPS_DENOMINATOR;
        newPositionId = _createWeightedPosition(
            staker, sourcePosition.agentId, amount, weightAmount, startEpoch, startEpoch, stakeEndEpoch
        );
        emit StakerRewardsRestaked(
            staker, sourcePositionId, newPositionId, amount, weightAmount, startEpoch, stakeEndEpoch
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Withdraw one position. If the position has not reached its end
     *         epoch, the close takes effect next epoch and the slash is sent to
     *         the dead address.
     */
    function withdrawStake(uint256 positionId) external nonReentrant {
        (uint256 returnedAmount, uint256 slashedAmount) = _withdrawPosition(positionId, msg.sender, currentEpoch());
        if (returnedAmount > 0) antsToken.safeTransfer(msg.sender, returnedAmount);
        if (slashedAmount > 0) antsToken.safeTransfer(DEAD_ADDRESS, slashedAmount);
    }

    function withdrawStakes(uint256[] calldata positionIds)
        external
        nonReentrant
        returns (uint256 returnedAmount, uint256 slashedAmount)
    {
        if (positionIds.length == 0) revert InvalidValue();
        uint256 epoch = currentEpoch();
        for (uint256 i = 0; i < positionIds.length; i++) {
            (uint256 positionReturned, uint256 positionSlashed) = _withdrawPosition(positionIds[i], msg.sender, epoch);
            returnedAmount += positionReturned;
            slashedAmount += positionSlashed;
        }

        if (returnedAmount > 0) antsToken.safeTransfer(msg.sender, returnedAmount);
        if (slashedAmount > 0) antsToken.safeTransfer(DEAD_ADDRESS, slashedAmount);
    }

    function _withdrawPosition(uint256 positionId, address staker, uint256 epoch)
        internal
        returns (uint256 returnedAmount, uint256 slashedAmount)
    {
        Position storage position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (ownerOf(positionId) != staker) revert NotPositionOwner();
        if (position.withdrawn) revert AlreadyWithdrawn();
        if (position.closedAtEpoch != 0) revert PositionClosed();
        if (epoch < positionWithdrawableEpoch[positionId]) revert PositionChangePending();

        // Power ends in the epoch of the withdrawal: the principal leaves now, so
        // it must not keep earning this epoch. A position that has not activated
        // yet added power only from stakeStartEpoch onward; never remove before that.
        uint256 closeEpoch = epoch < position.stakeStartEpoch ? position.stakeStartEpoch : epoch;
        if (_positionMaxLockPower[positionId].upperLookupRecent(closeEpoch) != 0) revert PositionClosed();
        if (_positionMaxLockPower[positionId].upperLookupRecent(closeEpoch + 1) != 0) revert PositionChangePending();
        returnedAmount = position.amount;

        position.withdrawn = true;
        position.closedAtEpoch = uint64(closeEpoch);
        uint256 normalEndEpoch = _positionNormalEndEpoch[positionId].upperLookupRecent(closeEpoch);
        if (normalEndEpoch == 0) revert StakeDurationOutOfBounds();
        if (_positionNormalEndEpoch[positionId].upperLookupRecent(closeEpoch + 1) != normalEndEpoch) {
            revert PositionChangePending();
        }

        if (closeEpoch < normalEndEpoch) {
            _removePowerRange(position.agentId, closeEpoch, normalEndEpoch, position.weightAmount);
        }
        _decreaseActiveStake(staker, position.agentId, position.amount);

        // The position stops serving at closeEpoch, so the unserved term — and
        // the slash — is measured from there.
        if (closeEpoch < normalEndEpoch) {
            uint256 slashBps = _earlyExitSlashBps(positionId, closeEpoch);
            slashedAmount = (position.amount * slashBps) / BPS_DENOMINATOR;
            returnedAmount = position.amount - slashedAmount;
        }

        _burn(positionId);
        emit StakeWithdrawn(positionId, staker, returnedAmount, slashedAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function earlyExitSlashBps(uint256 positionId) public view returns (uint256) {
        Position memory position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        uint256 epoch = currentEpoch();
        if (epoch < positionWithdrawableEpoch[positionId]) revert PositionChangePending();
        uint256 closeEpoch = epoch < position.stakeStartEpoch ? position.stakeStartEpoch : epoch;
        if (_positionMaxLockPower[positionId].upperLookupRecent(closeEpoch) != 0) return maxSlashBps;
        if (closeEpoch >= position.stakeEndEpoch) return 0;
        return _earlyExitSlashBps(positionId, closeEpoch);
    }

    function ownerOf(uint256 positionId) public view override(ERC721, IAntseedSellerPools) returns (address) {
        return super.ownerOf(positionId);
    }

    function agentIdForSeller(address seller) public view returns (uint256) {
        if (seller == address(0)) return 0;
        address staking = stakingSource;
        if (staking == address(0)) return 0;
        return IAntseedStaking(staking).getAgentId(seller);
    }

    function hasPoolAtEpoch(uint256 agentId, uint256 epoch) public view returns (bool) {
        return poolWeightAtEpoch(agentId, epoch) != 0;
    }

    function hasPoolAtEpoch(address seller, uint256 epoch) public view returns (bool) {
        uint256 agentId = agentIdForSeller(seller);
        return agentId != 0 && hasPoolAtEpoch(agentId, epoch);
    }

    function poolWeightAtEpoch(uint256 agentId, uint256 epoch) public view returns (uint256 weight) {
        (weight,) = _poolPowerAndActiveWeightAtEpoch(agentId, epoch);
    }

    function poolWeightAtEpoch(address seller, uint256 epoch) public view returns (uint256 weight) {
        uint256 agentId = agentIdForSeller(seller);
        if (agentId == 0) return 0;
        return poolWeightAtEpoch(agentId, epoch);
    }

    function positionWeightAtEpoch(uint256 positionId, uint256 epoch) public view returns (uint256) {
        Position memory position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (epoch < position.stakeStartEpoch) return 0;
        if (position.closedAtEpoch != 0 && epoch >= position.closedAtEpoch) return 0;

        uint256 maxLockPower = _positionMaxLockPower[positionId].upperLookupRecent(epoch);
        if (maxLockPower != 0) return maxLockPower;

        uint256 normalEndEpoch = _positionNormalEndEpoch[positionId].upperLookupRecent(epoch);
        if (normalEndEpoch == 0 || epoch >= normalEndEpoch) return 0;
        return position.weightAmount * (normalEndEpoch - epoch);
    }

    function positionMaxLockPowerAtEpoch(uint256 positionId, uint256 epoch) public view returns (uint256) {
        Position memory position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (position.closedAtEpoch != 0 && epoch >= position.closedAtEpoch) return 0;
        return _positionMaxLockPower[positionId].upperLookupRecent(epoch);
    }

    function positionPowerSegmentAt(uint256 positionId, uint256 epoch)
        public
        view
        returns (uint256 normalEndEpoch, uint256 maxLockPower, uint256 nextChangeEpoch)
    {
        Position memory position = positions[positionId];
        if (position.owner == address(0)) revert InvalidPosition();
        if (position.closedAtEpoch != 0 && epoch >= position.closedAtEpoch) {
            return (0, 0, position.closedAtEpoch);
        }

        normalEndEpoch = _positionNormalEndEpoch[positionId].upperLookupRecent(epoch);
        maxLockPower = _positionMaxLockPower[positionId].upperLookupRecent(epoch);

        uint256 nextNormalChange = _nextCheckpointKeyAfter(_positionNormalEndEpoch[positionId], epoch);
        uint256 nextMaxLockChange = _nextCheckpointKeyAfter(_positionMaxLockPower[positionId], epoch);
        nextChangeEpoch = nextNormalChange < nextMaxLockChange ? nextNormalChange : nextMaxLockChange;
        if (position.closedAtEpoch != 0 && position.closedAtEpoch < nextChangeEpoch) {
            nextChangeEpoch = position.closedAtEpoch;
        }
    }

    function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) public view returns (uint256 activeStake) {
        (, activeStake) = _poolPowerAndActiveWeightAtEpoch(agentId, epoch);
    }

    function poolActiveStakeAtEpoch(address seller, uint256 epoch) public view returns (uint256 activeStake) {
        uint256 agentId = agentIdForSeller(seller);
        if (agentId == 0) return 0;
        return poolActiveStakeAtEpoch(agentId, epoch);
    }

    function totalActiveStakeAtEpoch(uint256 epoch) public view returns (uint256 activeStake) {
        (, activeStake) = _powerAndActiveWeightAtEpoch(_totalPowerTree, epoch);
        activeStake += _totalMaxLockWeightAmount.upperLookupRecent(epoch);
    }

    function totalPowerWeightAtEpoch(uint256 epoch) external view returns (uint256) {
        return _powerAtEpoch(_totalPowerTree, epoch) + _totalMaxLockPowerAtEpoch(epoch);
    }

    function currentPoolSecurityWeight(uint256 agentId) external view returns (uint256) {
        return poolWeightAtEpoch(agentId, currentEpoch());
    }

    function currentPoolSecurityWeight(address seller) external view returns (uint256) {
        return poolWeightAtEpoch(seller, currentEpoch());
    }

    function currentTotalSecurityWeight() external view returns (uint256) {
        uint256 epoch = currentEpoch();
        return _powerAtEpoch(_totalPowerTree, epoch) + _totalMaxLockPowerAtEpoch(epoch);
    }

    function currentPoolSecurityShareBps(uint256 agentId) public view returns (uint256 shareBps) {
        uint256 epoch = currentEpoch();
        uint256 poolWeight = poolWeightAtEpoch(agentId, epoch);
        uint256 totalWeight = _powerAtEpoch(_totalPowerTree, epoch) + _totalMaxLockPowerAtEpoch(epoch);
        if (poolWeight == 0 || totalWeight == 0) return 0;
        return (poolWeight * BPS_DENOMINATOR) / totalWeight;
    }

    function currentPoolSecurityShareBps(address seller) external view returns (uint256 shareBps) {
        uint256 agentId = agentIdForSeller(seller);
        if (agentId == 0) return 0;
        return currentPoolSecurityShareBps(agentId);
    }

    function stakerPositionCount(address staker) public view returns (uint256) {
        return _stakerPositionIds[staker].length;
    }

    function stakerPositionIdAt(address staker, uint256 index) public view returns (uint256) {
        return _stakerPositionIds[staker][index];
    }

    function stakerPositionIds(address staker, uint256 offset, uint256 limit)
        public
        view
        returns (uint256[] memory ids)
    {
        uint256 count = _stakerPositionIds[staker].length;
        if (offset >= count || limit == 0) return new uint256[](0);

        uint256 end = offset + limit;
        if (end > count) end = count;
        ids = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            ids[i - offset] = _stakerPositionIds[staker][i];
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setStakingSource(address _stakingSource) external onlyOwner {
        if (_stakingSource == address(0)) revert InvalidAddress();
        stakingSource = _stakingSource;
        emit StakingSourceSet(_stakingSource);
    }

    function setPoolConfig(
        uint256 _minStakeEpochs,
        uint256 _stakeActivationDelay,
        uint256 _maxSlashBps,
        uint256 _minEarlyExitSlashBps
    ) external onlyOwner {
        if (
            _minStakeEpochs == 0 || _minStakeEpochs > MAX_STAKE_EPOCHS || _stakeActivationDelay == 0
                || _stakeActivationDelay > MAX_STAKE_EPOCHS
        ) revert InvalidValue();
        if (_maxSlashBps > BPS_DENOMINATOR || _minEarlyExitSlashBps > _maxSlashBps) revert InvalidValue();
        minStakeEpochs = _minStakeEpochs;
        stakeActivationDelay = _stakeActivationDelay;
        maxSlashBps = _maxSlashBps;
        minEarlyExitSlashBps = _minEarlyExitSlashBps;
        emit PoolConfigSet(_minStakeEpochs, _stakeActivationDelay, _maxSlashBps, _minEarlyExitSlashBps);
    }

    function setRewardStaker(address rewardStaker, bool allowed) external onlyOwner {
        if (rewardStaker == address(0)) revert InvalidAddress();
        rewardStakers[rewardStaker] = allowed;
        emit RewardStakerSet(rewardStaker, allowed);
    }

    function setRestakedRewardWeightBonus(uint256 bonusBps) external onlyOwner {
        if (bonusBps > MAX_RESTAKED_REWARD_WEIGHT_BONUS_BPS) revert InvalidValue();
        restakedRewardWeightBonusBps = bonusBps;
        emit RestakedRewardWeightBonusSet(bonusBps);
    }

    function setMoveWeightPenalty(uint256 penaltyBps) external onlyOwner {
        if (penaltyBps > BPS_DENOMINATOR) revert InvalidValue();
        moveWeightPenaltyBps = penaltyBps;
        emit MoveWeightPenaltySet(penaltyBps);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _createWeightedPosition(
        address owner,
        uint256 agentId,
        uint256 amount,
        uint256 weightAmount,
        uint256 startEpoch,
        uint256 normalStartEpoch,
        uint256 stakeEndEpoch
    ) internal returns (uint256 positionId) {
        positionId = nextPositionId++;
        positions[positionId] = Position({
            owner: owner,
            agentId: agentId,
            amount: amount,
            weightAmount: weightAmount,
            stakeStartEpoch: uint64(startEpoch),
            stakeEndEpoch: uint64(stakeEndEpoch),
            closedAtEpoch: 0,
            withdrawn: false
        });

        _positionNormalStartEpoch[positionId].push(startEpoch, normalStartEpoch);
        _positionNormalEndEpoch[positionId].push(startEpoch, stakeEndEpoch);
        _addPowerRange(agentId, startEpoch, stakeEndEpoch, weightAmount);
        _increaseActiveStake(owner, agentId, amount);
        _safeMint(owner, positionId);
        emit StakeCreated(positionId, owner, agentId, amount, weightAmount, startEpoch, stakeEndEpoch);
    }

    function _createRestructuredPosition(
        address owner,
        uint256 agentId,
        uint256 amount,
        uint256 weightAmount,
        uint256 startEpoch,
        uint256 normalStartEpoch,
        uint256 stakeEndEpoch
    ) internal returns (uint256 positionId) {
        positionId =
            _createWeightedPosition(owner, agentId, amount, weightAmount, startEpoch, normalStartEpoch, stakeEndEpoch);
        positionWithdrawableEpoch[positionId] = uint64(startEpoch);
    }

    function _requireRegisteredSellerAgent(uint256 agentId) internal view {
        if (agentId == 0) revert InvalidValue();

        address owner;
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address agentOwner) {
            owner = agentOwner;
        } catch {
            revert InvalidValue();
        }
        if (owner == address(0)) revert InvalidValue();

        address staking = stakingSource;
        if (staking == address(0)) revert InvalidAddress();

        try IAntseedStaking(staking).getAgentId(owner) returns (uint256 registeredAgentId) {
            if (registeredAgentId != agentId) revert InvalidValue();
        } catch {
            revert InvalidValue();
        }
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);

        if (from == address(0)) {
            _addStakerPosition(to, tokenId);
        } else if (to == address(0)) {
            _removeStakerPosition(from, tokenId);
        } else {
            Position storage position = positions[tokenId];
            _removeStakerPosition(from, tokenId);
            _addStakerPosition(to, tokenId);
            _decreaseActiveStake(from, position.agentId, position.amount);
            _increaseActiveStake(to, position.agentId, position.amount);
            position.owner = to;
        }
    }

    function _addStakerPosition(address staker, uint256 positionId) internal {
        _stakerPositionIds[staker].push(positionId);
        _stakerPositionIndex[positionId] = _stakerPositionIds[staker].length;
    }

    function _removeStakerPosition(address staker, uint256 positionId) internal {
        uint256 index = _stakerPositionIndex[positionId];
        if (index == 0) return;

        uint256[] storage ids = _stakerPositionIds[staker];
        uint256 removeIndex = index - 1;
        uint256 lastIndex = ids.length - 1;
        if (removeIndex != lastIndex) {
            uint256 lastPositionId = ids[lastIndex];
            ids[removeIndex] = lastPositionId;
            _stakerPositionIndex[lastPositionId] = index;
        }
        ids.pop();
        delete _stakerPositionIndex[positionId];
    }

    function _increaseActiveStake(address staker, uint256 agentId, uint256 amount) internal {
        uint256 newTotalStake = stakerTotalActiveStake[staker] + amount;
        uint256 newAgentStake = stakerAgentActiveStake[staker][agentId] + amount;
        stakerTotalActiveStake[staker] = newTotalStake;
        stakerAgentActiveStake[staker][agentId] = newAgentStake;
        emit StakerActiveStakeUpdated(staker, agentId, newTotalStake, newAgentStake);
    }

    function _decreaseActiveStake(address staker, uint256 agentId, uint256 amount) internal {
        uint256 newTotalStake = stakerTotalActiveStake[staker] - amount;
        uint256 newAgentStake = stakerAgentActiveStake[staker][agentId] - amount;
        stakerTotalActiveStake[staker] = newTotalStake;
        stakerAgentActiveStake[staker][agentId] = newAgentStake;
        emit StakerActiveStakeUpdated(staker, agentId, newTotalStake, newAgentStake);
    }

    function _earlyExitSlashBps(uint256 positionId, uint256 effectiveCloseEpoch) internal view returns (uint256) {
        uint256 normalStartEpoch = _positionNormalStartEpoch[positionId].upperLookupRecent(effectiveCloseEpoch);
        uint256 normalEndEpoch = _positionNormalEndEpoch[positionId].upperLookupRecent(effectiveCloseEpoch);
        if (normalStartEpoch == 0 || normalEndEpoch == 0 || effectiveCloseEpoch >= normalEndEpoch) return 0;

        uint256 originalStakeEpochs = normalEndEpoch - normalStartEpoch;
        if (originalStakeEpochs == 0) return 0;
        uint256 remainingEpochs = normalEndEpoch - effectiveCloseEpoch;
        uint256 slashBps = (maxSlashBps * remainingEpochs) / originalStakeEpochs;
        if (slashBps < minEarlyExitSlashBps) return minEarlyExitSlashBps;
        if (slashBps > maxSlashBps) return maxSlashBps;
        return slashBps;
    }

    function _addPowerRange(uint256 agentId, uint256 startEpoch, uint256 stakeEndEpoch, uint256 amount) internal {
        _applyPowerRange(agentId, startEpoch, stakeEndEpoch, amount, true);
    }

    function _removePowerRange(uint256 agentId, uint256 startEpoch, uint256 stakeEndEpoch, uint256 amount) internal {
        _applyPowerRange(agentId, startEpoch, stakeEndEpoch, amount, false);
    }

    function _applyPowerRange(uint256 agentId, uint256 startEpoch, uint256 stakeEndEpoch, uint256 amount, bool add)
        internal
    {
        int256 signedAmount = _signedAmount(amount, add);
        int256 signedWeightedEnd = _signedAmount(amount * stakeEndEpoch, add);
        _applyRangeDelta(_poolPowerTree[agentId], startEpoch, stakeEndEpoch, signedAmount, signedWeightedEnd);
        _applyRangeDelta(_totalPowerTree, startEpoch, stakeEndEpoch, signedAmount, signedWeightedEnd);
    }

    function _poolPowerAndActiveWeightAtEpoch(uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 power, uint256 activeWeight)
    {
        (power, activeWeight) = _powerAndActiveWeightAtEpoch(_poolPowerTree[agentId], epoch);
        uint256 maxLockWeightAmount = _poolMaxLockWeightAmount[agentId].upperLookupRecent(epoch);
        if (maxLockWeightAmount != 0) {
            power += maxLockWeightAmount * MAX_STAKE_EPOCHS;
            activeWeight += maxLockWeightAmount;
        }
    }

    function _totalMaxLockPowerAtEpoch(uint256 epoch) internal view returns (uint256) {
        return _totalMaxLockWeightAmount.upperLookupRecent(epoch) * MAX_STAKE_EPOCHS;
    }

    function _nextCheckpointKeyAfter(Checkpoints.Trace256 storage trace, uint256 epoch)
        internal
        view
        returns (uint256)
    {
        uint256 low;
        uint256 high = trace.length();
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (trace.at(uint32(mid))._key <= epoch) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        if (low == trace.length()) return type(uint256).max;
        return trace.at(uint32(low))._key;
    }

    function _applyMaxLockWeightAmount(uint256 agentId, uint256 epoch, uint256 amount, bool add) internal {
        Checkpoints.Trace256 storage poolTrace = _poolMaxLockWeightAmount[agentId];
        uint256 poolAmount = poolTrace.latest();
        poolTrace.push(epoch, add ? poolAmount + amount : poolAmount - amount);

        uint256 totalAmount = _totalMaxLockWeightAmount.latest();
        _totalMaxLockWeightAmount.push(epoch, add ? totalAmount + amount : totalAmount - amount);
    }

    function _powerAtEpoch(FenwickTree storage tree, uint256 epoch) internal view returns (uint256 power) {
        (power,) = _powerAndActiveWeightAtEpoch(tree, epoch);
    }

    function _powerAndActiveWeightAtEpoch(FenwickTree storage tree, uint256 epoch)
        internal
        view
        returns (uint256 power, uint256 activeWeight)
    {
        (int256 activeAmount, int256 activeWeightedEnd) = _fenwickPrefixSum(tree, epoch);
        if (activeAmount <= 0 || activeWeightedEnd <= 0) return (0, 0);
        int256 signedPower = activeWeightedEnd - activeAmount * int256(epoch);
        if (signedPower <= 0) return (0, 0);
        return (uint256(signedPower), uint256(activeAmount));
    }

    function _applyRangeDelta(
        FenwickTree storage tree,
        uint256 startEpoch,
        uint256 stakeEndEpoch,
        int256 amountDelta,
        int256 weightedEndDelta
    ) internal {
        _fenwickAdd(tree, startEpoch, amountDelta, weightedEndDelta);
        _fenwickAdd(tree, stakeEndEpoch, -amountDelta, -weightedEndDelta);
    }

    function _fenwickAdd(FenwickTree storage tree, uint256 epoch, int256 amountDelta, int256 weightedEndDelta)
        internal
    {
        uint256 index = _fenwickIndex(epoch);
        int128 amountDelta128 = _toInt128(amountDelta);
        int128 weightedEndDelta128 = _toInt128(weightedEndDelta);
        while (index <= FENWICK_SIZE) {
            (int128 amount, int128 weightedEnd) = _unpackFenwickValue(tree.values[index]);
            tree.values[index] = _packFenwickValue(
                _toInt128(int256(amount) + int256(amountDelta128)),
                _toInt128(int256(weightedEnd) + int256(weightedEndDelta128))
            );
            index += index & (~index + 1);
        }
    }

    function _fenwickPrefixSum(FenwickTree storage tree, uint256 epoch)
        internal
        view
        returns (int256 amountSum, int256 weightedEndSum)
    {
        uint256 index = _fenwickIndex(epoch);
        while (index != 0) {
            (int128 amount, int128 weightedEnd) = _unpackFenwickValue(tree.values[index]);
            amountSum += amount;
            weightedEndSum += weightedEnd;
            index -= index & (~index + 1);
        }
    }

    function _fenwickIndex(uint256 epoch) internal pure returns (uint256 index) {
        index = epoch + 1;
        if (index == 0 || index > FENWICK_SIZE) revert InvalidValue();
    }

    function _packFenwickValue(int128 amount, int128 weightedEnd) internal pure returns (int256) {
        return int256(uint256(uint128(amount)) | (uint256(uint128(weightedEnd)) << 128));
    }

    function _unpackFenwickValue(int256 value) internal pure returns (int128 amount, int128 weightedEnd) {
        uint256 raw = uint256(value);
        amount = int128(uint128(raw));
        weightedEnd = int128(uint128(raw >> 128));
    }

    function _toInt128(int256 value) internal pure returns (int128) {
        if (value < type(int128).min || value > type(int128).max) revert InvalidValue();
        return int128(value);
    }

    function _signedAmount(uint256 amount, bool add) internal pure returns (int256 signedAmount) {
        signedAmount = int256(amount);
        if (!add) signedAmount = -signedAmount;
    }
}
