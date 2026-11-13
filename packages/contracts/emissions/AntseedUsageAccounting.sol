// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { IAntseedPoolWeightPolicy } from "../interfaces/IAntseedPoolWeightPolicy.sol";
import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { IAntseedUsageRewards } from "../interfaces/IAntseedUsageRewards.sol";

/**
 * @title AntseedUsageAccounting
 * @notice Facts-only recognized-usage ledger.
 *
 *         Existing AntseedChannels still emits the legacy two-call sequence
 *         (`accrueSellerPoints`, then `accrueBuyerPoints`) to whatever the
 *         global registry exposes as `emissions()`. This contract is that
 *         settlement-facing endpoint. It records settled usage facts by buyer
 *         and agent id. The agent id is the seller-pool key. It also records
 *         weighted points as raw usage multiplied by the agent pool's frozen
 *         epoch power, so reward distribution is fully on-chain.
 *
 *         Important behavior:
 *           - This is the intermediate points layer. Seller-pool stake math does
 *             not contain usage verification or wash-trading rules.
 *           - A points policy may scale buyer/seller points for verification
 *             outcomes such as announcement-shard checks. If no policy is set,
 *             raw points pass through unchanged.
 *           - Pool-weighted points are based on the pool power for the current
 *             epoch. Because pool power is precomputed and frozen per epoch,
 *             settlement can record usage without touching stake positions.
 *           - Usage against pools below `minimumAccountedPoolPower` is ignored.
 *             Pool points are not capped here. Reputation, verification, and
 *             wash-trading point shaping belongs in `pointsPolicy`; reward caps
 *             are applied by reward controllers when claims mint.
 *           - Buyer rewards are weighted by the seller pool the buyer used, so
 *             buyer points from stronger pools carry more reward weight. Buyer
 *             points are not capped by that seller pool's total epoch volume.
 *           - Seller operator rewards use the same direct points model as
 *             buyers: verified seller points multiplied by the pool power used
 *             in that settlement.
 *           - The legacy two-call path stores one pending seller accrual and
 *             pairs it with the next buyer accrual. Newer callers should prefer
 *             `accruePoints` with buyer, seller, and channel id in one call.
 */
contract AntseedUsageAccounting is IAntseedUsageAccounting, Ownable2Step, Pausable {
    // ─── External Contracts ──────────────────────────────────────────
    IAntseedEmissionsGate public immutable emissionsGate;
    /// @notice First epoch the gate will ever mint (its immutable
    ///         `effectiveEpoch`). Usage settled before it — the tail of the
    ///         cutover epoch — is accounted under this epoch instead, so it
    ///         stays claimable rather than landing in a pre-effective epoch
    ///         the gate refuses forever.
    uint256 public immutable firstRewardedEpoch;
    IAntseedSellerPools public sellerPools;
    IAntseedPointsPolicy public pointsPolicy;
    IAntseedPoolWeightPolicy public poolWeightPolicy;
    uint256 public minimumAccountedPoolPower = 1;

    /// @notice Usage rewards controller behind the seller delegation adapter
    ///         below. Unset disables the adapter (views return zero, claims
    ///         revert).
    IAntseedUsageRewards public usageRewards;

    // ─── Legacy Two-Call Settlement Pairing ──────────────────────────
    /// @notice Seller stashed by the legacy `accrueSellerPoints` leg, paired
    ///         with the next `accrueBuyerPoints` in the same settle tx. The
    ///         points delta is not stored: both legacy calls carry the same
    ///         delta, and the record uses the buyer leg's.
    address public pendingSellerAccrual;

    // ─── Usage Recorder Permissions ─────────────────────────────────
    mapping(address => bool) public usageRecorders;

    // ─── Structured Usage Accounting ────────────────────────────────
    UsageTotals private _totalUsage;
    mapping(uint256 => UsageTotals) private _epochUsage;
    mapping(address => BuyerUsage) private _buyerUsageTotal;
    mapping(address => mapping(uint256 => BuyerUsage)) private _buyerAgentUsageTotal;
    mapping(uint256 => mapping(address => BuyerUsage)) private _buyerEpochUsage;
    mapping(uint256 => mapping(address => mapping(uint256 => BuyerUsage))) private _buyerAgentEpochUsage;
    mapping(uint256 => mapping(uint256 => SellerUsage)) private _agentEpochUsage;
    mapping(uint256 => mapping(address => uint256)) private _sellerAgentIdByEpoch;

    // ─── Modifiers ───────────────────────────────────────────────────
    /// @dev Skips (no-op) instead of reverting for unrecognized callers: if a
    ///      recorder is later revoked (e.g. Channels/Deposits superseded by a
    ///      v2 the registry points at), channels still settling through the
    ///      old contract must keep working — they just stop earning emissions.
    modifier onlyUsageRecorder() {
        if (!usageRecorders[msg.sender]) return;
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────
    constructor(address _sellerPools, address _initialRecorder, address _emissionsGate) Ownable(msg.sender) {
        if (_initialRecorder == address(0) || _emissionsGate == address(0)) revert InvalidAddress();

        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        firstRewardedEpoch = IAntseedEmissionsGate(_emissionsGate).effectiveEpoch();
        sellerPools = IAntseedSellerPools(_sellerPools);
        usageRecorders[_initialRecorder] = true;

        emit UsageRecorderSet(_initialRecorder, true);
    }

    // ─── Epoch Helpers ────────────────────────────────────────────────
    function currentEpoch() public view returns (uint256) {
        return emissionsGate.currentEpoch();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RECORD USAGE
    // ═══════════════════════════════════════════════════════════════════

    // The accrual entrypoints are called inline by the deployed AntseedChannels
    // settlement path with no try/catch. They must never revert for reasons
    // outside the recorder's control, or pausing/misconfiguring this contract
    // would block all USDC settlements and seller payouts network-wide. While
    // paused, accruals are skipped (no usage recorded) instead of reverting.

    function accrueSellerPoints(address seller, uint256 pointsDelta) external onlyUsageRecorder {
        if (paused()) {
            emit AccrualSkippedWhilePaused(seller, address(0), pointsDelta);
            return;
        }
        if (seller == address(0)) revert InvalidAddress();
        if (pointsDelta == 0) revert InvalidValue();
        // Plain overwrite: the settle path always pairs this with
        // accrueBuyerPoints in the same tx, so a dangling entry cannot occur
        // — and this call must never revert settlement either way.
        pendingSellerAccrual = seller;
        emit LegacySellerAccrualPending(seller, currentEpoch(), pointsDelta);
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external onlyUsageRecorder {
        if (paused()) {
            delete pendingSellerAccrual;
            emit AccrualSkippedWhilePaused(address(0), buyer, pointsDelta);
            return;
        }
        if (buyer == address(0)) revert InvalidAddress();
        if (pointsDelta == 0) revert InvalidValue();

        address pendingSeller = pendingSellerAccrual;
        if (pendingSeller == address(0)) revert NoPendingSellerAccrual();

        delete pendingSellerAccrual;
        _recordUsage(buyer, pendingSeller, pointsDelta);
    }

    function accruePoints(bytes32 channelId, address buyer, address seller, uint256 pointsDelta)
        external
        onlyUsageRecorder
    {
        if (paused()) {
            emit AccrualSkippedWhilePaused(seller, buyer, pointsDelta);
            return;
        }
        _recordUsage(channelId, buyer, seller, pointsDelta);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setSellerPools(address _sellerPools) external onlyOwner {
        sellerPools = IAntseedSellerPools(_sellerPools);
        emit SellerPoolsSet(_sellerPools);
    }

    function setPointsPolicy(address policy) external onlyOwner {
        pointsPolicy = IAntseedPointsPolicy(policy);
        emit PointsPolicySet(policy);
    }

    /// @notice Set the pool weight policy converting raw pool power into the
    ///         effective weight applied to usage points. Unset preserves the
    ///         default linear behavior (weight = raw pool power).
    function setPoolWeightPolicy(address policy) external onlyOwner {
        poolWeightPolicy = IAntseedPoolWeightPolicy(policy);
        emit PoolWeightPolicySet(policy);
    }

    function setUsageRewards(address rewards) external onlyOwner {
        usageRewards = IAntseedUsageRewards(rewards);
        emit UsageRewardsSet(rewards);
    }

    function setMinimumAccountedPoolPower(uint256 minimumPoolPower) external onlyOwner {
        if (minimumPoolPower == 0) revert InvalidValue();
        minimumAccountedPoolPower = minimumPoolPower;
        emit MinimumAccountedPoolPowerSet(minimumPoolPower);
    }

    function setUsageRecorder(address recorder, bool allowed) external onlyOwner {
        if (recorder == address(0)) revert InvalidAddress();
        usageRecorders[recorder] = allowed;
        emit UsageRecorderSet(recorder, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    SELLER DELEGATION ADAPTER
    // ═══════════════════════════════════════════════════════════════════

    // Already-deployed seller delegation contracts (e.g. DiemStakingProxy)
    // resolve registry.emissions() live and call the legacy IAntseedEmissions
    // selectors on it. These adapters keep that surface answering: seller
    // emission amounts come from the AntseedUsageRewards agent bucket, keyed
    // by the caller's seller-pool agent id, and claims pay the caller (the
    // agent owner) through `claimAgentRewardFor`.

    /// @notice Legacy `IAntseedEmissions.pendingEmissions` view. `totalSeller`
    ///         is the account's unclaimed agent usage reward for `epochs`;
    ///         `totalBuyer` is always zero (delegation contracts only consume
    ///         the seller side).
    function pendingEmissions(address account, uint256[] calldata epochs)
        external
        view
        returns (uint256 totalSeller, uint256 totalBuyer)
    {
        totalBuyer = 0;
        IAntseedUsageRewards rewards = usageRewards;
        if (address(rewards) == address(0)) return (0, 0);
        uint256 agentId = _sellerPoolAgentId(account);
        if (agentId == 0) return (0, 0);
        if (!_isAgentRewardRecipient(rewards, agentId, account)) return (0, 0);
        uint256 firstGateEpoch = firstRewardedEpoch;

        for (uint256 i = 0; i < epochs.length; i++) {
            if (epochs[i] < firstGateEpoch) continue;
            if (rewards.agentEpochClaimed(agentId, epochs[i])) continue;
            totalSeller += rewards.pendingAgentReward(agentId, epochs[i]);
        }
    }

    /// @notice Legacy `IAntseedEmissions.claimSellerEmissions`. Claims the
    ///         caller's agent usage rewards from AntseedUsageRewards; rewards
    ///         are paid to the caller (verified as the agent owner by the
    ///         rewards controller). Epochs already claimed, with nothing to
    ///         claim, predating the gate, or belonging to an agent the caller
    ///         no longer owns are skipped so a batch never reverts partway,
    ///         mirroring the legacy claim semantics.
    function claimSellerEmissions(uint256[] calldata epochs) external {
        IAntseedUsageRewards rewards = usageRewards;
        if (address(rewards) == address(0)) revert UsageRewardsNotSet();
        uint256 agentId = _sellerPoolAgentId(msg.sender);
        if (agentId == 0) return;
        if (!_isAgentRewardRecipient(rewards, agentId, msg.sender)) return;
        uint256 firstGateEpoch = firstRewardedEpoch;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            // Pre-effective epochs belong to the legacy stack (settled via
            // the legacy escrow); the gate refuses them.
            if (epoch < firstGateEpoch) continue;
            if (rewards.agentEpochClaimed(agentId, epoch)) continue;
            if (rewards.pendingAgentReward(agentId, epoch) == 0) continue;
            rewards.claimAgentRewardFor(msg.sender, agentId, epoch);
        }
    }

    function _sellerPoolAgentId(address seller) internal view returns (uint256) {
        IAntseedSellerPools pools = sellerPools;
        if (address(pools) == address(0)) return 0;
        return pools.agentIdForSeller(seller);
    }

    /// @dev A stale seller→agent binding (agent NFT moved to a new owner who
    ///      hasn't re-registered) must degrade to a no-op, not a revert:
    ///      deployed delegation contracts batch these calls with no try/catch.
    function _isAgentRewardRecipient(IAntseedUsageRewards rewards, uint256 agentId, address account)
        internal
        view
        returns (bool)
    {
        try rewards.rewardRecipient(agentId) returns (address recipient) {
            return recipient == account;
        } catch {
            return false;
        }
    }

    // ─── Internal Recording ───────────────────────────────────────────
    function _recordUsage(address buyer, address seller, uint256 rawPoints) internal {
        _recordUsage(bytes32(0), buyer, seller, rawPoints);
    }

    function _recordUsage(bytes32 channelId, address buyer, address seller, uint256 rawPoints) internal {
        if (buyer == address(0) || seller == address(0)) revert InvalidAddress();
        if (rawPoints == 0) revert InvalidValue();

        uint256 epoch = currentEpoch();
        // Usage settled during the cutover epoch (before the gate's
        // effective epoch) would be permanently unmintable through the gate;
        // account it under the first gate-mintable epoch instead.
        if (epoch < firstRewardedEpoch) epoch = firstRewardedEpoch;
        IAntseedSellerPools pools = sellerPools;
        if (address(pools) == address(0)) return;

        uint256 agentId = pools.agentIdForSeller(seller);
        if (agentId == 0) return;

        uint256 poolPower = pools.poolWeightAtEpoch(agentId, epoch);
        if (poolPower < minimumAccountedPoolPower) return;

        (uint256 poolWeight, bool poolWeightOk) = _policyPoolWeight(agentId, epoch, poolPower);
        if (!poolWeightOk) return;

        (uint256 sellerPoints, uint256 buyerPoints) = _policyPoints(channelId, buyer, seller, rawPoints);
        if (sellerPoints == 0 && buyerPoints == 0) return;

        uint256 sellerWeightedPoints = sellerPoints * poolWeight;
        uint256 buyerWeightedPoints = buyerPoints * poolWeight;

        {
            UsageTotals storage totalUsage_ = _totalUsage;
            totalUsage_.buyers.points += buyerPoints;
            totalUsage_.buyers.weightedPoints += buyerWeightedPoints;
            totalUsage_.sellers.points += sellerPoints;
            totalUsage_.sellers.weightedPoints += sellerWeightedPoints;
        }
        {
            UsageTotals storage epochUsage_ = _epochUsage[epoch];
            epochUsage_.buyers.points += buyerPoints;
            epochUsage_.buyers.weightedPoints += buyerWeightedPoints;
            epochUsage_.sellers.points += sellerPoints;
            epochUsage_.sellers.weightedPoints += sellerWeightedPoints;
        }
        {
            BuyerUsage storage buyerTotal_ = _buyerUsageTotal[buyer];
            buyerTotal_.points += buyerPoints;
            buyerTotal_.weightedPoints += buyerWeightedPoints;
        }
        {
            BuyerUsage storage buyerAgentTotal_ = _buyerAgentUsageTotal[buyer][agentId];
            buyerAgentTotal_.points += buyerPoints;
            buyerAgentTotal_.weightedPoints += buyerWeightedPoints;
        }
        {
            BuyerUsage storage buyerEpoch_ = _buyerEpochUsage[epoch][buyer];
            buyerEpoch_.points += buyerPoints;
            buyerEpoch_.weightedPoints += buyerWeightedPoints;
        }
        {
            BuyerUsage storage buyerAgentEpoch_ = _buyerAgentEpochUsage[epoch][buyer][agentId];
            buyerAgentEpoch_.points += buyerPoints;
            buyerAgentEpoch_.weightedPoints += buyerWeightedPoints;
        }
        {
            SellerUsage storage agentEpoch_ = _agentEpochUsage[epoch][agentId];
            agentEpoch_.points += sellerPoints;
            agentEpoch_.weightedPoints += sellerWeightedPoints;
        }
        if (_sellerAgentIdByEpoch[epoch][seller] == 0) _sellerAgentIdByEpoch[epoch][seller] = agentId;

        emit UsagePointsAccrued(
            epoch,
            buyer,
            seller,
            agentId,
            rawPoints,
            buyerPoints,
            sellerPoints,
            poolPower,
            poolWeight,
            buyerWeightedPoints,
            sellerWeightedPoints
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function totalUsage() external view returns (UsageTotals memory) {
        return _totalUsage;
    }

    function epochUsage(uint256 epoch) external view returns (UsageTotals memory) {
        return _epochUsage[epoch];
    }

    function buyerUsageTotal(address buyer) external view returns (BuyerUsage memory) {
        return _buyerUsageTotal[buyer];
    }

    function buyerAgentUsageTotal(address buyer, uint256 agentId) external view returns (BuyerUsage memory) {
        return _buyerAgentUsageTotal[buyer][agentId];
    }

    function buyerEpochUsage(uint256 epoch, address buyer) external view returns (BuyerUsage memory) {
        return _buyerEpochUsage[epoch][buyer];
    }

    function buyerAgentEpochUsage(uint256 epoch, address buyer, uint256 agentId)
        external
        view
        returns (BuyerUsage memory)
    {
        return _buyerAgentEpochUsage[epoch][buyer][agentId];
    }

    function agentEpochUsage(uint256 epoch, uint256 agentId) external view returns (SellerUsage memory) {
        return _agentEpochUsage[epoch][agentId];
    }

    function totalBuyerPointsByEpoch(uint256 epoch) external view returns (uint256) {
        return _epochUsage[epoch].buyers.points;
    }

    function totalSellerPointsByEpoch(uint256 epoch) external view returns (uint256) {
        return _epochUsage[epoch].sellers.points;
    }

    /// @notice Alias of `totalSellerPointsByEpoch`: pool points equal seller
    ///         points (the sole recorder increments both with the same value).
    function totalPoolPointsByEpoch(uint256 epoch) external view returns (uint256) {
        return _epochUsage[epoch].sellers.points;
    }

    function totalWeightedBuyerPointsByEpoch(uint256 epoch) external view returns (uint256) {
        return _epochUsage[epoch].buyers.weightedPoints;
    }

    function buyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256) {
        return _buyerEpochUsage[epoch][buyer].points;
    }

    function sellerPointsByEpoch(uint256 epoch, address seller) external view returns (uint256) {
        uint256 agentId = _sellerAgentIdByEpoch[epoch][seller];
        return agentId == 0 ? 0 : _agentEpochUsage[epoch][agentId].points;
    }

    function weightedBuyerPointsByEpoch(uint256 epoch, address buyer) external view returns (uint256) {
        return _buyerEpochUsage[epoch][buyer].weightedPoints;
    }

    /// @notice Alias of `agentEpochUsage(epoch, agentId).points`: pool points
    ///         equal seller points.
    function agentPoolPointsByEpoch(uint256 epoch, uint256 agentId) external view returns (uint256) {
        return _agentEpochUsage[epoch][agentId].points;
    }

    function sellerAgentIdByEpoch(uint256 epoch, address seller) external view returns (uint256) {
        return _sellerAgentIdByEpoch[epoch][seller];
    }

    function poolPointsByEpoch(uint256 epoch, address seller) public view returns (uint256) {
        uint256 agentId = _sellerAgentIdByEpoch[epoch][seller];
        if (agentId == 0) return 0;
        return _agentEpochUsage[epoch][agentId].points;
    }

    function weightedPoolPointsByEpoch(uint256 epoch, uint256 agentId) public view returns (uint256 weightedPoints) {
        weightedPoints = _agentEpochUsage[epoch][agentId].weightedPoints;
    }

    function weightedPoolPointsByEpoch(uint256 epoch, address seller) public view returns (uint256 weightedPoints) {
        uint256 agentId = _sellerAgentIdByEpoch[epoch][seller];
        if (agentId == 0) return 0;
        weightedPoints = _agentEpochUsage[epoch][agentId].weightedPoints;
    }

    function totalWeightedPoolPointsByEpoch(uint256 epoch) public view returns (uint256 totalWeightedPoints) {
        totalWeightedPoints = _epochUsage[epoch].sellers.weightedPoints;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Convert raw pool power into the effective reward weight. With no
    ///      policy set the curve stays linear (weight = raw pool power). A
    ///      broken or reverting policy must not block settlement: the usage
    ///      record is skipped (no emissions credit) instead of bubbling the
    ///      revert into AntseedChannels' settle path.
    function _policyPoolWeight(uint256 agentId, uint256 epoch, uint256 poolPower)
        internal
        returns (uint256 poolWeight, bool ok)
    {
        IAntseedPoolWeightPolicy policy = poolWeightPolicy;
        if (address(policy) == address(0)) return (poolPower, true);
        try policy.poolWeight(agentId, epoch, poolPower) returns (uint256 weight) {
            return (weight, true);
        } catch {
            emit PoolWeightPolicyFailed(agentId, epoch, poolPower);
            return (0, false);
        }
    }

    function _policyPoints(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        internal
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        IAntseedPointsPolicy policy = pointsPolicy;
        if (address(policy) == address(0)) return (rawPoints, rawPoints);
        // A broken or reverting policy must not block settlement. Skip the
        // usage record (no emissions credit) rather than bubbling the revert
        // into AntseedChannels' settle path.
        try policy.points(channelId, buyer, seller, rawPoints) returns (
            uint256 policySellerPoints, uint256 policyBuyerPoints
        ) {
            return (policySellerPoints, policyBuyerPoints);
        } catch {
            emit PointsPolicyFailed(channelId, buyer, seller, rawPoints);
            return (0, 0);
        }
    }
}
