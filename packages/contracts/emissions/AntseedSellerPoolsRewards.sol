// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { AntseedShareMath } from "./AntseedShareMath.sol";

/**
 * @title AntseedSellerPoolsRewards
 * @notice Lazy seller-pool reward controller for recognized usage.
 *
 *         Usage accounting records raw seller usage and weighted pool points
 *         during each epoch. The pool epoch is settled once, and staker
 *         positions split the settled claimable budget:
 *
 *         poolReward = sellerPoolsBudget(epoch) * poolWeightedPoints / totalWeightedPoints
 *         positionReward = poolReward * positionWeight / poolWeight
 *
 *         Unallocated dynamic staker budget is settled separately through the
 *         emissions gate, where global burn/reserve routing is enforced.
 *
 *         Important behavior:
 *           - This is the staker pool-reward controller, separate from the
 *             direct seller/operator usage rewards.
 *           - Pool epochs are indexed before staker claim/restake. Settlement
 *             mints pool-level claimable ANTS to this contract.
 *           - Restaking rewards creates a new locked position in the source
 *             agent pool and may receive a configured weight bonus based on lock
 *             length.
 *           - Position reward claims use indexed pool accounting and do not
 *             loop over every epoch since the position started.
 */
contract AntseedSellerPoolsRewards is Ownable2Step, Pausable, ReentrancyGuard {
    using Math for uint256;
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace256;

    // ─── Constants ───────────────────────────────────────────────────
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant GATE_SHARE_DENOMINATOR = 100_000;
    uint256 public constant INDEX_SCALE = 1e30;
    uint32 public constant MAX_STAKER_SHARE_BPS = 40_000;

    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedSellerPools public immutable sellerPools;
    IAntseedUsageAccounting public immutable usageAccounting;
    uint256 public immutable initialEmission;
    /// @dev ANTS resolved once at construction from the pools contract,
    ///      which pins it immutably at deployment — keeping principal and
    ///      rewards on the same asset even if the registry's token address
    ///      is later repointed, and saving per-claim external resolution.
    IERC20 private immutable _antsToken;

    // ─── Claim State ─────────────────────────────────────────────────
    mapping(uint256 => bool) public epochRemainderSettled;
    /// @dev Budget frozen at first settlement use (stored as budget + 1 so a
    ///      frozen zero is distinguishable from unset). Later dynamic-config
    ///      changes must not retroactively resize a finalized epoch's budget:
    ///      remainder settlement and lazy pool settlement share one gate
    ///      bucket, and a mid-flight resize would over-commit it.
    mapping(uint256 => uint256) private _frozenStakerBudgets;
    mapping(uint256 => mapping(uint256 => PoolEpochEmission)) public poolEpochEmissions;
    mapping(uint256 => uint256) public poolRewardIndexNextEpoch;
    mapping(uint256 => uint256) public positionClaimCursor;
    mapping(uint256 => Checkpoints.Trace256) private _poolCumulativeRewardPerWeight;
    mapping(uint256 => Checkpoints.Trace256) private _poolCumulativeEpochRewardPerWeight;
    uint256 public immutable initialIndexEpoch;

    // ─── Dynamic Share Config ────────────────────────────────────────
    /// @dev Config changes take effect from the next epoch. The outgoing
    ///      config is retained so elapsed epochs whose budgets are not yet
    ///      frozen keep pricing against the config active while they ran.
    struct DynamicStakerConfig {
        uint32 minShareBps;
        uint32 maxShareBps;
        /// @dev Target at the gate's initial emission level. The effective
        ///      epoch target scales proportionally with epoch emissions.
        uint256 stakeShareTarget;
    }

    DynamicStakerConfig private _currentConfig;
    DynamicStakerConfig private _pendingConfig;
    /// @dev First epoch `_pendingConfig` applies to; 0 = none scheduled.
    uint256 private _pendingFromEpoch;

    struct ClaimRoute {
        address recipient;
        address staker;
        bool emitClaimEvents;
    }

    /// @dev Pool-level APY clipping was removed, so the settled pool budget
    ///      is fully claimable — one amount. Burn/reserve routing happens in
    ///      `settleEpochRemainder`.
    struct PoolEpochEmission {
        bool settled;
        uint256 amount;
    }

    // ─── Events ──────────────────────────────────────────────────────
    event StakerUsageRewardRestaked(
        uint256 indexed sourcePositionId, uint256 indexed newPositionId, address indexed staker, uint256 amount
    );
    event PoolUsageRewardSettled(uint256 indexed agentId, uint256 indexed epoch, uint256 amount);
    event PoolUsageRewardIndexed(
        uint256 indexed agentId,
        uint256 indexed epoch,
        uint256 rewardPerWeight,
        uint256 cumulativeRewardPerWeight,
        uint256 cumulativeEpochRewardPerWeight
    );
    event StakerUsageRewardsClaimed(
        uint256 indexed positionId,
        address indexed staker,
        address indexed recipient,
        uint256 fromEpoch,
        uint256 toEpoch,
        uint256 claimableAmount
    );
    event DynamicStakerConfigSet(uint32 minShareBps, uint32 maxShareBps, uint256 stakeShareTarget, uint256 fromEpoch);
    event StakerEpochBudgetFrozen(uint256 indexed epoch, uint256 budget);
    event StakerRewardRemainderSettled(
        uint256 indexed epoch, uint256 unallocatedAmount, uint256 burnedAmount, uint256 reserveAmount
    );

    // ─── Custom Errors ───────────────────────────────────────────────
    error InvalidAddress();
    error InvalidValue();
    error AlreadyClaimed();
    error NothingToClaim();
    error NotPositionOwner();

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _emissionsGate, address _sellerPools, address _usageAccounting) Ownable(msg.sender) {
        if (_emissionsGate == address(0) || _sellerPools == address(0) || _usageAccounting == address(0)) {
            revert InvalidAddress();
        }
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        sellerPools = IAntseedSellerPools(_sellerPools);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        initialEmission = IAntseedEmissionsGate(_emissionsGate).INITIAL_EMISSION();
        if (initialEmission == 0) revert InvalidValue();
        initialIndexEpoch = IAntseedUsageAccounting(_usageAccounting).currentEpoch();
        IERC20 token = IAntseedSellerPools(_sellerPools).antsToken();
        if (address(token) == address(0)) revert InvalidAddress();
        _antsToken = token;

        _currentConfig =
            DynamicStakerConfig({ minShareBps: 2_000, maxShareBps: 40_000, stakeShareTarget: 400_000_000e18 });
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLAIM STAKER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function indexPoolRewards(uint256 agentId, uint256 maxEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 nextEpoch)
    {
        if (agentId == 0 || maxEpochs == 0) revert InvalidValue();

        nextEpoch = poolRewardIndexNextEpoch[agentId];
        if (nextEpoch == 0) nextEpoch = initialIndexEpoch;

        uint256 currentEpoch_ = sellerPools.currentEpoch();
        uint256 limit = nextEpoch + maxEpochs;
        if (limit > currentEpoch_) limit = currentEpoch_;

        while (nextEpoch < limit) {
            _indexPoolRewardEpoch(agentId, nextEpoch);
            nextEpoch++;
        }
        poolRewardIndexNextEpoch[agentId] = nextEpoch;
    }

    function claimStakerRewards(uint256 positionId, address recipient) external nonReentrant whenNotPaused {
        if (recipient == address(0)) revert InvalidAddress();
        uint256 claimedAmount = _claimIndexedStakerRewards(positionId, ClaimRoute(recipient, msg.sender, true));
        if (claimedAmount == 0) revert NothingToClaim();
    }

    function claimStakerRewardsBatch(uint256[] calldata positionIds, address recipient)
        external
        nonReentrant
        whenNotPaused
    {
        if (recipient == address(0)) revert InvalidAddress();
        if (positionIds.length == 0) revert InvalidValue();

        uint256 totalClaimed;
        for (uint256 p = 0; p < positionIds.length; p++) {
            totalClaimed += _claimIndexedStakerRewards(positionIds[p], ClaimRoute(recipient, msg.sender, true));
        }
        if (totalClaimed == 0) revert NothingToClaim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESTAKE STAKER REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function restakeStakerRewards(uint256 positionId, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 newPositionId)
    {
        uint256 totalRestaked =
            _claimIndexedStakerRewards(positionId, ClaimRoute(address(sellerPools), msg.sender, false));
        if (totalRestaked == 0) revert NothingToClaim();
        newPositionId = sellerPools.stakeMintedReward(msg.sender, positionId, totalRestaked, stakeEpochs);
        emit StakerUsageRewardRestaked(positionId, newPositionId, msg.sender, totalRestaked);
    }

    function restakeStakerRewardsBatch(uint256[] calldata positionIds, uint256 stakeEpochs)
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory newPositionIds)
    {
        if (positionIds.length == 0) revert InvalidValue();

        newPositionIds = new uint256[](positionIds.length);
        uint256 totalRestakedAll;
        for (uint256 p = 0; p < positionIds.length; p++) {
            uint256 totalRestaked =
                _claimIndexedStakerRewards(positionIds[p], ClaimRoute(address(sellerPools), msg.sender, false));
            if (totalRestaked == 0) continue;

            totalRestakedAll += totalRestaked;
            newPositionIds[p] = sellerPools.stakeMintedReward(msg.sender, positionIds[p], totalRestaked, stakeEpochs);
            emit StakerUsageRewardRestaked(positionIds[p], newPositionIds[p], msg.sender, totalRestaked);
        }
        if (totalRestakedAll == 0) revert NothingToClaim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function pendingStakerReward(uint256 positionId, uint256 epoch) external view returns (uint256 amount) {
        (address owner, uint256 agentId,,,,,,) = sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();
        amount = _positionReward(positionId, agentId, epoch);
    }

    function pendingIndexedStakerReward(uint256 positionId) external view returns (uint256 claimableAmount) {
        (address owner, uint256 agentId,, uint256 weightAmount, uint64 stakeStartEpoch,, uint64 closedAtEpoch,) =
            sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();

        uint256 fromEpoch = positionClaimCursor[positionId];
        if (fromEpoch < stakeStartEpoch) fromEpoch = stakeStartEpoch;

        uint256 toEpoch = poolRewardIndexNextEpoch[agentId];
        if (toEpoch == 0 || toEpoch <= fromEpoch) return 0;
        if (closedAtEpoch != 0 && toEpoch > closedAtEpoch) toEpoch = closedAtEpoch;
        if (toEpoch <= fromEpoch) return 0;

        claimableAmount = _positionIndexedReward(agentId, weightAmount, fromEpoch, toEpoch, positionId);
    }

    function poolCumulativeRewardPerWeightAt(uint256 agentId, uint256 epoch) external view returns (uint256) {
        return _poolCumulativeRewardPerWeight[agentId].upperLookupRecent(epoch);
    }

    function poolCumulativeEpochRewardPerWeightAt(uint256 agentId, uint256 epoch) external view returns (uint256) {
        return _poolCumulativeEpochRewardPerWeight[agentId].upperLookupRecent(epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setDynamicStakerConfig(uint32 minShareBps, uint32 maxShareBps, uint256 _stakeShareTarget)
        external
        onlyOwner
    {
        if (minShareBps > maxShareBps || maxShareBps > MAX_STAKER_SHARE_BPS || _stakeShareTarget == 0) {
            revert InvalidValue();
        }

        uint256 fromEpoch = emissionsGate.currentEpoch() + 1;
        if (_pendingFromEpoch != 0 && _pendingFromEpoch < fromEpoch) {
            _currentConfig = _pendingConfig;
        }
        _pendingConfig = DynamicStakerConfig({
            minShareBps: minShareBps,
            maxShareBps: maxShareBps,
            stakeShareTarget: _stakeShareTarget
        });
        _pendingFromEpoch = fromEpoch;

        emit DynamicStakerConfigSet(minShareBps, maxShareBps, _stakeShareTarget, fromEpoch);
    }

    /// @notice Dynamic share config active for `epoch`.
    function dynamicStakerConfigAt(uint256 epoch) public view returns (DynamicStakerConfig memory) {
        if (_pendingFromEpoch != 0 && epoch >= _pendingFromEpoch) return _pendingConfig;
        return _currentConfig;
    }

    function stakerEpochBudget(uint256 epoch) public view returns (uint256) {
        uint256 frozen = _frozenStakerBudgets[epoch];
        if (frozen != 0) return frozen - 1;
        return _liveStakerEpochBudget(epoch);
    }

    function _liveStakerEpochBudget(uint256 epoch) internal view returns (uint256) {
        return _liveStakerEpochBudget(epoch, emissionsGate.controllerEpochBudget(address(this), epoch));
    }

    /// @dev `maxBudget` avoids reloading the gate budget when already known.
    ///      The configured target is denominated at the initial emission level
    ///      and scales with each epoch's emission.
    function _liveStakerEpochBudget(uint256 epoch, uint256 maxBudget) internal view returns (uint256) {
        uint256 activeStake = sellerPools.totalActiveStakeAtEpoch(epoch);
        DynamicStakerConfig memory config = dynamicStakerConfigAt(epoch);
        uint256 epochEmission = emissionsGate.getEpochEmission(epoch);
        uint256 scaledTarget = Math.mulDiv(config.stakeShareTarget, epochEmission, initialEmission);
        uint32 shareBps =
            AntseedShareMath.saturatingShareBps(activeStake, config.minShareBps, config.maxShareBps, scaledTarget);
        if (shareBps == 0) return 0;

        uint256 desiredBudget = Math.mulDiv(epochEmission, shareBps, GATE_SHARE_DENOMINATOR);
        return desiredBudget < maxBudget ? desiredBudget : maxBudget;
    }

    function _freezeStakerEpochBudget(uint256 epoch) internal returns (uint256 budget) {
        uint256 frozen = _frozenStakerBudgets[epoch];
        if (frozen != 0) return frozen - 1;
        return _freezeStakerEpochBudget(epoch, emissionsGate.controllerEpochBudget(address(this), epoch));
    }

    function _freezeStakerEpochBudget(uint256 epoch, uint256 maxBudget) internal returns (uint256 budget) {
        uint256 frozen = _frozenStakerBudgets[epoch];
        if (frozen != 0) return frozen - 1;
        budget = _liveStakerEpochBudget(epoch, maxBudget);
        _frozenStakerBudgets[epoch] = budget + 1;
        emit StakerEpochBudgetFrozen(epoch, budget);
    }

    function settleEpochRemainder(uint256 epoch)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (epochRemainderSettled[epoch]) revert AlreadyClaimed();

        uint256 maxBudget = emissionsGate.controllerEpochBudget(address(this), epoch);
        // An epoch with no weighted usage can never mint through pool
        // settlement, so its whole bucket is remainder — the stake-based
        // budget would otherwise be stranded outside the burn/reserve route.
        uint256 allocatedBudget =
            usageAccounting.totalWeightedPoolPointsByEpoch(epoch) == 0 ? 0 : _freezeStakerEpochBudget(epoch, maxBudget);
        if (allocatedBudget >= maxBudget) revert NothingToClaim();

        uint256 unallocatedAmount = maxBudget - allocatedBudget;
        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = emissionsGate.claimRemainder(epoch, _emissionsReserve(), unallocatedAmount);
        emit StakerRewardRemainderSettled(epoch, unallocatedAmount, burnedAmount, reserveAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function _claimIndexedStakerRewards(uint256 positionId, ClaimRoute memory route)
        internal
        returns (uint256 claimableAmount)
    {
        (address owner, uint256 agentId,, uint256 weightAmount, uint64 stakeStartEpoch,, uint64 closedAtEpoch,) =
            sellerPools.positions(positionId);
        if (owner == address(0)) revert InvalidValue();
        if (owner != route.staker) revert NotPositionOwner();

        uint256 fromEpoch = positionClaimCursor[positionId];
        if (fromEpoch < stakeStartEpoch) fromEpoch = stakeStartEpoch;

        uint256 toEpoch = poolRewardIndexNextEpoch[agentId];
        if (toEpoch == 0 || toEpoch <= fromEpoch) return 0;
        if (closedAtEpoch != 0 && toEpoch > closedAtEpoch) toEpoch = closedAtEpoch;
        if (toEpoch <= fromEpoch) return 0;

        claimableAmount = _positionIndexedReward(agentId, weightAmount, fromEpoch, toEpoch, positionId);
        if (claimableAmount == 0) return 0;

        positionClaimCursor[positionId] = toEpoch;
        _transferReward(route.recipient, claimableAmount);
        if (route.emitClaimEvents) {
            emit StakerUsageRewardsClaimed(
                positionId, route.staker, route.recipient, fromEpoch, toEpoch, claimableAmount
            );
        }
    }

    function _positionIndexedReward(
        uint256 agentId,
        uint256 weightAmount,
        uint256 fromEpoch,
        uint256 toEpoch,
        uint256 positionId
    ) internal view returns (uint256 rewardAmount) {
        uint256 cursor = fromEpoch;
        while (cursor < toEpoch) {
            (uint256 normalEndEpoch, uint256 maxLockPower, uint256 nextChangeEpoch) =
                sellerPools.positionPowerSegmentAt(positionId, cursor);
            uint256 segmentEnd = nextChangeEpoch < toEpoch ? nextChangeEpoch : toEpoch;
            if (segmentEnd <= cursor) break;

            if (maxLockPower != 0) {
                uint256 rewardDelta = _cumulativeDelta(_poolCumulativeRewardPerWeight[agentId], cursor, segmentEnd);
                rewardAmount += Math.mulDiv(maxLockPower, rewardDelta, INDEX_SCALE);
            } else if (normalEndEpoch != 0 && cursor < normalEndEpoch) {
                if (segmentEnd > normalEndEpoch) segmentEnd = normalEndEpoch;
                uint256 rewardDelta = _cumulativeDelta(_poolCumulativeRewardPerWeight[agentId], cursor, segmentEnd);
                uint256 epochRewardDelta =
                    _cumulativeDelta(_poolCumulativeEpochRewardPerWeight[agentId], cursor, segmentEnd);
                rewardAmount += Math.mulDiv(weightAmount, normalEndEpoch * rewardDelta - epochRewardDelta, INDEX_SCALE);
            }

            cursor = segmentEnd;
        }
    }

    function _indexPoolRewardEpoch(uint256 agentId, uint256 epoch) internal {
        PoolEpochEmission storage emission = _settlePoolEpoch(agentId, epoch);

        uint256 rewardPerWeight;
        uint256 poolWeight = sellerPools.poolWeightAtEpoch(agentId, epoch);
        if (poolWeight != 0 && emission.amount != 0) {
            rewardPerWeight = Math.mulDiv(emission.amount, INDEX_SCALE, poolWeight);
        }

        uint256 cumulativeReward = _poolCumulativeRewardPerWeight[agentId].latest() + rewardPerWeight;
        uint256 cumulativeEpochReward = _poolCumulativeEpochRewardPerWeight[agentId].latest() + rewardPerWeight * epoch;
        if (rewardPerWeight != 0) {
            _poolCumulativeRewardPerWeight[agentId].push(epoch + 1, cumulativeReward);
            _poolCumulativeEpochRewardPerWeight[agentId].push(epoch + 1, cumulativeEpochReward);
        }

        emit PoolUsageRewardIndexed(agentId, epoch, rewardPerWeight, cumulativeReward, cumulativeEpochReward);
    }

    function _cumulativeDelta(Checkpoints.Trace256 storage trace, uint256 fromEpoch, uint256 toEpoch)
        internal
        view
        returns (uint256)
    {
        return trace.upperLookupRecent(toEpoch) - trace.upperLookupRecent(fromEpoch);
    }

    function _positionReward(uint256 positionId, uint256 agentId, uint256 epoch)
        internal
        view
        returns (uint256 amount)
    {
        if (agentId == 0 || epoch < positionClaimCursor[positionId]) return 0;

        IAntseedSellerPools pools = sellerPools;
        uint256 positionWeight = pools.positionWeightAtEpoch(positionId, epoch);
        if (positionWeight == 0) return 0;

        uint256 poolWeight = pools.poolWeightAtEpoch(agentId, epoch);
        if (poolWeight == 0) return 0;

        uint256 poolReward = _poolRewardPreview(agentId, epoch);
        if (poolReward == 0) return 0;

        amount = Math.mulDiv(poolReward, positionWeight, poolWeight);
    }

    function _settlePoolEpoch(uint256 agentId, uint256 epoch) internal returns (PoolEpochEmission storage emission) {
        emission = poolEpochEmissions[epoch][agentId];
        if (emission.settled) return emission;

        _freezeStakerEpochBudget(epoch);
        uint256 amount = _poolRewardPreview(agentId, epoch);
        emission.settled = true;
        emission.amount = amount;

        _mint(epoch, address(this), amount);
        emit PoolUsageRewardSettled(agentId, epoch, amount);
    }

    function _poolRewardPreview(uint256 agentId, uint256 epoch) internal view returns (uint256 amount) {
        PoolEpochEmission memory settledEmission = poolEpochEmissions[epoch][agentId];
        if (settledEmission.settled) return settledEmission.amount;
        return _poolGrossReward(agentId, epoch);
    }

    function _poolGrossReward(uint256 agentId, uint256 epoch) internal view returns (uint256) {
        IAntseedUsageAccounting accounting = usageAccounting;
        uint256 poolPoints = accounting.weightedPoolPointsByEpoch(epoch, agentId);
        uint256 totalPoints = accounting.totalWeightedPoolPointsByEpoch(epoch);
        if (poolPoints == 0 || totalPoints == 0) return 0;

        uint256 budget = stakerEpochBudget(epoch);
        if (budget == 0) return 0;
        return Math.mulDiv(budget, poolPoints, totalPoints);
    }

    function _mint(uint256 epoch, address recipient, uint256 amount) internal {
        if (amount == 0) return;
        emissionsGate.claim(epoch, recipient, amount);
    }

    function _transferReward(address recipient, uint256 amount) internal {
        if (amount == 0) return;
        _antsToken.safeTransfer(recipient, amount);
    }

    function _emissionsReserve() internal view returns (address reserve) {
        reserve = emissionsGate.emissionsReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }
}
