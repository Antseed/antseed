// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Checkpoints } from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedVerificationResults } from "../interfaces/IAntseedVerificationResults.sol";

/// @notice The verification results layer: a verdict registry and the holder of the verification
///         emission bucket. See `IAntseedVerificationResults`.
///
///         Verdicts: each (agent, service) keeps its latest recorded result, the epoch it was given
///         in, the epoch it stops counting in (`validUntilEpoch`, chosen by the audit that recorded
///         it, at most `MAX_VERDICT_EPOCHS` after it was given) and the audit that gave it. A verdict
///         counts while `currentEpoch < validUntilEpoch`. A SAME verifies that service, a DIFF marks
///         it as not serving the recorded model, and an UNDETERMINED counts as neither. Each agent
///         keeps SAME and DIFF counters per expiry epoch, so its status sums only the verdicts that
///         have not expired yet and older ones drop out without any cleanup. How a verdict is
///         reached, and how long it counts, is the audit's business: the latest record from any
///         approved audit wins.
///
///         Audits: contracts approved with `setAudit` (at most `MAX_AUDITS` ever listed), one per
///         verification method. Removing an audit stops its writes and new credits; credits it
///         already granted stay claimable from the shares of the epochs they were earned in.
///
///         Rewards, per audit: a share of the bucket's epoch budget (shares sum to at most 100%), a
///         rewards start epoch (default off), a per-auditor credit cap per epoch (default 100), and a
///         per-auditor share cap (default 20%). Claims follow `AntseedUsageRewards`: one epoch per
///         call, `gross = auditBudget * credits / auditCredits`, the auditor receives up to the share
///         cap and the rest is minted to the emissions reserve in the same claim. Share changes take
///         effect from the next epoch, like the gate's own minter shares, so a running or finished
///         epoch's split never changes. The share cap in force at claim time applies.
///
///         Epochs come from the emissions gate pinned at deployment; audits read `currentEpoch`
///         here so verdicts, credits and claims can never disagree about the epoch.
contract AntseedVerificationResults is IAntseedVerificationResults, Ownable2Step, Pausable, ReentrancyGuard {
    using Checkpoints for Checkpoints.Trace256;

    /// @notice Upper bound on how long any verdict counts: `record` accepts a `validUntilEpoch` at most
    ///         this many epochs after the current one, i.e. 52 weekly epochs, about a year. Each audit
    ///         picks the actual lifetime of its verdicts below this bound.
    /// @dev Also bounds the agent status sum, which reads one counter per epoch from the next epoch up
    ///      to the latest expiry any of the agent's SAME or DIFF verdicts ever had.
    uint256 public constant MAX_VERDICT_EPOCHS = 52;
    uint256 public constant MAX_AUDITS = 32;
    uint256 public constant BPS = 10_000;
    uint16 public constant DEFAULT_MAX_AUDITOR_SHARE_BPS = 2_000;
    uint32 public constant DEFAULT_MAX_CREDITS_PER_AUDITOR_PER_EPOCH = 100;
    uint64 public constant REWARDS_OFF = type(uint64).max;

    struct EpochCounts {
        uint32 same;
        uint32 diff;
    }

    struct AuditConfig {
        bool listed;
        uint16 maxAuditorShareBps;
        uint32 maxCreditsPerAuditorPerEpoch;
        uint64 rewardsStartEpoch;
    }

    /// @dev An auditor's reward for one audit and epoch. Copied from `AntseedUsageRewards.PreparedReward`
    ///      (emissions/AntseedUsageRewards.sol), field for field: `recipient`, the claimant's share
    ///      (there `weightedPoints` / `totalWeightedPoints`, here the auditor's `credits` against the
    ///      audit's `totalCredits` for the epoch), `grossAmount`, `claimableAmount` (what the auditor
    ///      receives) and `reserveAmount` (the part above the cap, minted to the emissions reserve).
    ///      Populated by `_prepareAuditorReward`, which also marks the epoch claimed.
    struct PreparedReward {
        address recipient;
        uint256 credits;
        uint256 totalCredits;
        uint256 grossAmount;
        uint256 claimableAmount;
        uint256 reserveAmount;
    }

    IAntseedEmissionsGate public immutable override emissionsGate;
    /// @notice Sum of every audit's latest share (what applies from the next epoch); never above BPS.
    uint256 public totalAuditShareBps;

    mapping(address audit => bool approved) public override isAudit;
    mapping(address audit => AuditConfig config) private _audits;
    // Share in bps per audit, checkpointed by the epoch it applies from.
    mapping(address audit => Checkpoints.Trace256 shares) private _shares;
    /// @notice Every audit ever approved, in order; at most `MAX_AUDITS`.
    address[] public auditList;

    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceStatus status)) private _serviceStatus;
    /// @inheritdoc IAntseedVerificationResults
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 clears)) public override serviceClears;
    /// @inheritdoc IAntseedVerificationResults
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 changes)) public override diffChanges;
    // Latest SAME/DIFF verdicts by the epoch they stop counting in; a verdict moves out when the
    // service gets a new one.
    mapping(uint256 agentId => mapping(uint256 validUntilEpoch => EpochCounts counts)) private _expiryCounts;
    // The latest expiry any of the agent's SAME or DIFF verdicts ever had; the status sum stops there.
    mapping(uint256 agentId => uint256 validUntilEpoch) private _lastExpiry;

    mapping(address audit => mapping(uint256 epoch => uint256 credits)) public override epochCredits;
    mapping(address audit => mapping(uint256 epoch => mapping(address auditor => uint256 credits)))
        public
        override auditorEpochCredits;
    mapping(address audit => mapping(uint256 epoch => mapping(address auditor => bool claimed)))
        public
        override auditorEpochClaimed;

    event AuditSet(address indexed audit, bool approved);
    event AuditShareBpsSet(address indexed audit, uint16 shareBps, uint256 fromEpoch);
    event RewardsStartEpochSet(address indexed audit, uint64 epoch);
    event MaxAuditorShareBpsSet(address indexed audit, uint16 shareBps);
    event MaxCreditsPerAuditorPerEpochSet(address indexed audit, uint32 maxCredits);
    /// @param audit The audit that recorded `current`; zero when the owner cleared the service.
    ///        The audit's own events (e.g. KBF's `ModelAudited`) carry the evidence behind it.
    /// @param epoch The emissions epoch the change happened in.
    /// @param validUntilEpoch The epoch `current` stops counting in; 0 when it is NONE.
    event ServiceStatusChanged(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        bytes32 modelHash,
        Verdict previous,
        Verdict current,
        address audit,
        uint256 epoch,
        uint256 validUntilEpoch
    );
    /// @notice The owner cleared a service with `clearServiceStatuses`. Emitted for every listed
    ///         service, also one with no live verdict (which emits no `ServiceStatusChanged`), so
    ///         indexers see every `serviceClears` bump. @param clears The new `serviceClears` value.
    event ServiceCleared(uint256 indexed agentId, bytes32 indexed serviceHash, uint256 epoch, uint256 clears);
    event AgentStatusChanged(uint256 indexed agentId, uint16 verifiedCount, uint16 diffCount);
    event Credited(address indexed audit, uint256 indexed epoch, address indexed auditor, uint256 credits);
    /// @param claimableAmount What the auditor received. @param reserveAmount Its gross reward above
    ///        the cap, minted to the emissions reserve.
    event AuditorRewardClaimed(
        address indexed audit,
        uint256 indexed epoch,
        address indexed auditor,
        uint256 credits,
        uint256 totalCredits,
        uint256 grossAmount,
        uint256 claimableAmount,
        uint256 reserveAmount
    );

    error InvalidAddress();
    error InvalidValue();
    error NotAudit();
    error UnknownAudit();
    error TooManyAudits();
    error SharesExceedBps();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error NothingToClaim();

    modifier onlyAudit() {
        if (!isAudit[msg.sender]) revert NotAudit();
        _;
    }

    /// @dev Takes the emissions gate directly, like the other emission controllers. Verdict epochs
    ///      only make sense against one gate, so a new gate needs a new results deployment.
    constructor(address emissionsGate_) Ownable(msg.sender) {
        if (emissionsGate_.code.length == 0) revert InvalidAddress();
        emissionsGate = IAntseedEmissionsGate(emissionsGate_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Approves or removes an audit contract. The first approval lists it with the default
    ///         caps and its rewards off. A removed audit keeps its settings, so credits it granted
    ///         stay claimable. Setting its share to 0 frees that share for other audits from the next
    ///         epoch on; it does not touch earlier epochs.
    function setAudit(address audit, bool approved) external onlyOwner {
        if (audit.code.length == 0) revert InvalidAddress();
        AuditConfig storage config = _audits[audit];
        if (approved && !config.listed) {
            if (auditList.length >= MAX_AUDITS) revert TooManyAudits();
            auditList.push(audit);
            config.listed = true;
            config.maxAuditorShareBps = DEFAULT_MAX_AUDITOR_SHARE_BPS;
            config.maxCreditsPerAuditorPerEpoch = DEFAULT_MAX_CREDITS_PER_AUDITOR_PER_EPOCH;
            config.rewardsStartEpoch = REWARDS_OFF;
        }
        isAudit[audit] = approved;
        emit AuditSet(audit, approved);
    }

    /// @notice Sets a listed audit's share of the bucket from the next epoch on; the current and
    ///         past epochs keep theirs. Shares sum to at most BPS.
    function setAuditShareBps(address audit, uint16 shareBps) external onlyOwner {
        _listed(audit);
        Checkpoints.Trace256 storage shares = _shares[audit];
        uint256 total = totalAuditShareBps - shares.latest() + shareBps;
        if (total > BPS) revert SharesExceedBps();
        totalAuditShareBps = total;
        uint256 fromEpoch = emissionsGate.currentEpoch() + 1;
        shares.push(fromEpoch, shareBps);
        emit AuditShareBpsSet(audit, shareBps, fromEpoch);
    }

    /// @notice Credits from `audit` count from this epoch on. Set it to the epoch the audit's
    ///         rewards launch so work done before launch never claims past budgets; `REWARDS_OFF`
    ///         turns new credits off again. Credits already earned stay claimable.
    function setRewardsStartEpoch(address audit, uint64 epoch) external onlyOwner {
        _listed(audit).rewardsStartEpoch = epoch;
        emit RewardsStartEpochSet(audit, epoch);
    }

    /// @notice Most of the audit's epoch budget one auditor can receive. Applies to every claim
    ///         made after the change, including past epochs; the rest of a capped reward goes to the reserve.
    function setMaxAuditorShareBps(address audit, uint16 shareBps) external onlyOwner {
        if (shareBps == 0 || shareBps > BPS) revert InvalidValue();
        _listed(audit).maxAuditorShareBps = shareBps;
        emit MaxAuditorShareBpsSet(audit, shareBps);
    }

    /// @notice Most credits one auditor can earn from the audit per epoch.
    function setMaxCreditsPerAuditorPerEpoch(address audit, uint32 maxCredits) external onlyOwner {
        if (maxCredits == 0) revert InvalidValue();
        _listed(audit).maxCreditsPerAuditorPerEpoch = maxCredits;
        emit MaxCreditsPerAuditorPerEpochSet(audit, maxCredits);
    }

    /// @notice Remediation for wrong results, e.g. from a removed audit or a bad auditor: resets
    ///         each listed service's verdict and bumps its `serviceClears`, so audits can drop
    ///         reports made before the clear. `agentIds[i]` pairs with `serviceHashes[i]`.
    function clearServiceStatuses(uint256[] calldata agentIds, bytes32[] calldata serviceHashes) external onlyOwner {
        uint256 count = agentIds.length;
        if (count != serviceHashes.length) revert InvalidValue();
        uint256 epoch = emissionsGate.currentEpoch();
        for (uint256 i = 0; i < count; i++) {
            uint256 clears = serviceClears[agentIds[i]][serviceHashes[i]] + 1;
            serviceClears[agentIds[i]][serviceHashes[i]] = clears;
            _resetService(
                agentIds[i], serviceHashes[i], _serviceStatus[agentIds[i]][serviceHashes[i]], epoch, address(0)
            );
            emit ServiceCleared(agentIds[i], serviceHashes[i], epoch, clears);
        }
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VERDICTS (audits)
    // ═══════════════════════════════════════════════════════════════════

    function record(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict, uint256 validUntilEpoch)
        external
        override
        onlyAudit
    {
        if (serviceHash == bytes32(0) || modelHash == bytes32(0) || verdict == Verdict.NONE) revert InvalidValue();
        uint256 epoch = emissionsGate.currentEpoch();
        if (validUntilEpoch <= epoch || validUntilEpoch > epoch + MAX_VERDICT_EPOCHS) revert InvalidValue();
        ServiceStatus storage service = _serviceStatus[agentId][serviceHash];
        if (service.modelHash != modelHash) {
            if (service.modelHash != bytes32(0)) {
                _resetService(agentId, serviceHash, service, epoch, msg.sender);
            }
            service.modelHash = modelHash;
        }
        // The same verdict again in the same epoch, counting as long, changes nothing, attribution included.
        if (service.verdict == verdict && service.epoch == epoch && service.validUntilEpoch == validUntilEpoch) return;
        Verdict previous = _liveVerdict(service, epoch);
        address previousAudit = service.audit;
        uint256 previousValidUntil = service.validUntilEpoch;
        _uncount(agentId, service);
        EpochCounts storage counts = _expiryCounts[agentId][validUntilEpoch];
        // Only SAME and DIFF are counted, so only they extend the status sum.
        if (verdict != Verdict.UNDETERMINED && validUntilEpoch > _lastExpiry[agentId]) {
            _lastExpiry[agentId] = validUntilEpoch;
        }
        if (verdict == Verdict.SAME) counts.same += 1;
        else if (verdict == Verdict.DIFF) counts.diff += 1;
        service.verdict = verdict;
        service.epoch = uint64(epoch);
        service.validUntilEpoch = uint64(validUntilEpoch);
        service.audit = msg.sender;
        if (previous != verdict) service.updatedAt = uint64(block.timestamp);
        else if (previousAudit == msg.sender && previousValidUntil == validUntilEpoch) return;
        // Emitted whenever the live verdict, the audit behind it, or how long it counts changes, so
        // indexers can follow `validUntilEpoch` from events alone.
        _emitServiceChange(agentId, serviceHash, service, previous, epoch, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function currentEpoch() external view override returns (uint256) {
        return emissionsGate.currentEpoch();
    }

    function serviceStatus(uint256 agentId, bytes32 serviceHash) external view override returns (ServiceStatus memory) {
        return _serviceStatus[agentId][serviceHash];
    }

    function liveVerdict(uint256 agentId, bytes32 serviceHash) external view override returns (Verdict) {
        return _liveVerdict(_serviceStatus[agentId][serviceHash], emissionsGate.currentEpoch());
    }

    function agentStatus(uint256 agentId) public view override returns (AgentStatus memory) {
        return _agentStatusAt(agentId, emissionsGate.currentEpoch());
    }

    function isVerified(uint256 agentId) external view override returns (bool) {
        AgentStatus memory agent = agentStatus(agentId);
        return agent.verifiedCount > 0 && agent.diffCount == 0;
    }

    function auditCount() external view returns (uint256) {
        return auditList.length;
    }

    function auditShareBps(address audit) external view override returns (uint16) {
        return uint16(_shares[audit].latest());
    }

    function auditShareBpsAt(address audit, uint256 epoch) public view override returns (uint16) {
        return uint16(_shares[audit].upperLookupRecent(epoch));
    }

    function rewardsStartEpoch(address audit) external view override returns (uint64) {
        return _audits[audit].rewardsStartEpoch;
    }

    function maxAuditorShareBps(address audit) external view override returns (uint16) {
        return _audits[audit].maxAuditorShareBps;
    }

    function maxCreditsPerAuditorPerEpoch(address audit) external view override returns (uint32) {
        return _audits[audit].maxCreditsPerAuditorPerEpoch;
    }

    function auditBudget(address audit, uint256 epoch) public view override returns (uint256) {
        return (emissionsGate.controllerEpochBudget(address(this), epoch) * auditShareBpsAt(audit, epoch)) / BPS;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function credit(address auditor, uint256 credits) external override onlyAudit returns (uint256 credited) {
        if (auditor == address(0)) revert InvalidAddress();
        if (credits == 0) return 0;
        AuditConfig storage config = _audits[msg.sender];
        uint256 epoch = emissionsGate.currentEpoch();
        if (epoch < config.rewardsStartEpoch) return 0;
        // No share of this epoch's bucket means nothing could ever pay these credits: grant none, so no
        // auditor is told it was credited for an epoch it can never claim.
        if (auditShareBpsAt(msg.sender, epoch) == 0) return 0;
        uint256 have = auditorEpochCredits[msg.sender][epoch][auditor];
        uint256 cap = config.maxCreditsPerAuditorPerEpoch;
        if (have >= cap) return 0;
        credited = credits;
        if (have + credited > cap) credited = cap - have;
        auditorEpochCredits[msg.sender][epoch][auditor] = have + credited;
        epochCredits[msg.sender][epoch] += credited;
        emit Credited(msg.sender, epoch, auditor, credited);
    }

    /// @dev Copied from `AntseedUsageRewards.claimAgentReward` / `_claimAgentReward`: one epoch per
    ///      call, `nonReentrant whenNotPaused`, prepare (check, compute, mark claimed) then mint, then
    ///      emit the full breakdown. The claimant is the auditor itself (msg.sender), so there is no
    ///      recipient lookup like UsageRewards' agent owner check.
    function claimAuditorReward(address audit, uint256 epoch) external override nonReentrant whenNotPaused {
        PreparedReward memory reward = _prepareAuditorReward(audit, epoch, msg.sender);
        _mintReward(epoch, reward.recipient, reward.claimableAmount, reward.reserveAmount);
        emit AuditorRewardClaimed(
            audit,
            epoch,
            reward.recipient,
            reward.credits,
            reward.totalCredits,
            reward.grossAmount,
            reward.claimableAmount,
            reward.reserveAmount
        );
    }

    /// @dev Copied from `AntseedUsageRewards.pendingAgentReward` / `_pendingAgentReward`: the claimable
    ///      amount from the same share math as the claim, 0 instead of a revert. Additionally 0 for the
    ///      current epoch and for an epoch already claimed, so it always equals what a claim would pay.
    function pendingAuditorReward(address audit, address auditor, uint256 epoch)
        external
        view
        override
        returns (uint256 amount)
    {
        if (epoch >= emissionsGate.currentEpoch() || auditorEpochClaimed[audit][epoch][auditor]) return 0;
        return _pendingReward(
            audit, auditBudget(audit, epoch), auditorEpochCredits[audit][epoch][auditor], epochCredits[audit][epoch]
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Copied from `AntseedUsageRewards._prepareAgentReward`: revert if already claimed, read the
    ///      share, compute the amounts with `_rewardAmounts`, then mark the epoch claimed before any mint.
    ///      Differences: an explicit `EpochNotFinalized` check (UsageRewards relies on the gate's own
    ///      check in `claim`), and no budget freeze. UsageRewards freezes each epoch's budget on the
    ///      first claim (`_freezeUsageEpochBudgets`) because it depends on live usage volume; here the
    ///      budget is the gate's controller budget times the audit's checkpointed share for that epoch
    ///      (`auditBudget`), which can no longer change once the epoch is over.
    function _prepareAuditorReward(address audit, uint256 epoch, address auditor)
        internal
        returns (PreparedReward memory reward)
    {
        if (epoch >= emissionsGate.currentEpoch()) revert EpochNotFinalized();
        if (auditorEpochClaimed[audit][epoch][auditor]) revert AlreadyClaimed();

        reward.credits = auditorEpochCredits[audit][epoch][auditor];
        reward.totalCredits = epochCredits[audit][epoch];
        (reward.grossAmount, reward.claimableAmount, reward.reserveAmount) =
            _rewardAmounts(audit, auditBudget(audit, epoch), reward.credits, reward.totalCredits);
        reward.recipient = auditor;

        auditorEpochClaimed[audit][epoch][auditor] = true;
    }

    /// @dev Copied from `AntseedUsageRewards._rewardAmounts`, line for line: gross pro rata share of the
    ///      epoch budget, capped, the rest to the reserve, reverting `NothingToClaim` on no share or a zero
    ///      amount. One difference: the cap is the audit's `maxAuditorShareBps` (default 20%, owner-set per
    ///      audit) instead of UsageRewards' constant `MAX_REWARD_SHARE_BPS`.
    function _rewardAmounts(address audit, uint256 epochBudget, uint256 credits, uint256 totalCredits)
        internal
        view
        returns (uint256 grossAmount, uint256 claimableAmount, uint256 reserveAmount)
    {
        if (credits == 0 || totalCredits == 0) revert NothingToClaim();

        grossAmount = (epochBudget * credits) / totalCredits;
        if (grossAmount == 0) revert NothingToClaim();

        uint256 cap = (epochBudget * _audits[audit].maxAuditorShareBps) / BPS;
        claimableAmount = grossAmount < cap ? grossAmount : cap;
        reserveAmount = grossAmount - claimableAmount;
        if (claimableAmount == 0 && reserveAmount == 0) revert NothingToClaim();
    }

    /// @dev Copied from `AntseedUsageRewards._pendingReward`: the capped gross share, 0 when there is none.
    function _pendingReward(address audit, uint256 epochBudget, uint256 credits, uint256 totalCredits)
        internal
        view
        returns (uint256)
    {
        if (credits == 0 || totalCredits == 0) return 0;
        uint256 grossAmount = (epochBudget * credits) / totalCredits;
        uint256 cap = (epochBudget * _audits[audit].maxAuditorShareBps) / BPS;
        return grossAmount < cap ? grossAmount : cap;
    }

    /// @dev Copied from `AntseedUsageRewards._mintReward`, unchanged: the auditor's part and the reserve's
    ///      part are separate `emissionsGate.claim` calls against the same epoch budget.
    function _mintReward(uint256 epoch, address recipient, uint256 claimableAmount, uint256 reserveAmount) internal {
        if (claimableAmount != 0) {
            emissionsGate.claim(epoch, recipient, claimableAmount);
        }
        if (reserveAmount != 0) {
            emissionsGate.claim(epoch, _emissionsReserve(), reserveAmount);
        }
    }

    function _listed(address audit) private view returns (AuditConfig storage config) {
        config = _audits[audit];
        if (!config.listed) revert UnknownAudit();
    }

    function _resetService(
        uint256 agentId,
        bytes32 serviceHash,
        ServiceStatus storage service,
        uint256 epoch,
        address audit
    ) private {
        Verdict previous = _liveVerdict(service, epoch);
        _uncount(agentId, service);
        service.verdict = Verdict.NONE;
        service.epoch = 0;
        service.validUntilEpoch = 0;
        service.audit = address(0);
        service.updatedAt = uint64(block.timestamp);
        if (previous != Verdict.NONE) {
            _emitServiceChange(agentId, serviceHash, service, previous, epoch, audit);
        }
    }

    /// @dev Removes the service's stored verdict from the counter of the epoch it stops counting in.
    function _uncount(uint256 agentId, ServiceStatus storage service) private {
        Verdict stored = service.verdict;
        if (stored == Verdict.NONE) return;
        EpochCounts storage counts = _expiryCounts[agentId][service.validUntilEpoch];
        if (stored == Verdict.SAME) counts.same -= 1;
        else if (stored == Verdict.DIFF) counts.diff -= 1;
    }

    function _liveVerdict(ServiceStatus storage service, uint256 epoch) private view returns (Verdict) {
        Verdict stored = service.verdict;
        if (stored == Verdict.NONE || epoch >= service.validUntilEpoch) return Verdict.NONE;
        return stored;
    }

    /// @dev Sums the counters of the verdicts still live in `epoch`: those that stop counting in a
    ///      later epoch, up to the agent's latest expiry (never more than `MAX_VERDICT_EPOCHS` ahead),
    ///      saturating at uint16.
    function _agentStatusAt(uint256 agentId, uint256 epoch) private view returns (AgentStatus memory status) {
        uint256 same;
        uint256 diff;
        uint256 last = _lastExpiry[agentId];
        for (uint256 until = epoch + 1; until <= last; until++) {
            EpochCounts storage counts = _expiryCounts[agentId][until];
            same += counts.same;
            diff += counts.diff;
        }
        status.verifiedCount = uint16(same > type(uint16).max ? type(uint16).max : same);
        status.diffCount = uint16(diff > type(uint16).max ? type(uint16).max : diff);
    }

    function _emitServiceChange(
        uint256 agentId,
        bytes32 serviceHash,
        ServiceStatus storage service,
        Verdict previous,
        uint256 epoch,
        address audit
    ) private {
        // Counted for every audit and for owner clears, so an audit's report rounds can start over
        // whenever the service's DIFF state moves, whoever moved it.
        Verdict current = service.verdict;
        if (previous != current && (previous == Verdict.DIFF || current == Verdict.DIFF)) {
            diffChanges[agentId][serviceHash] += 1;
        }
        emit ServiceStatusChanged(
            agentId, serviceHash, service.modelHash, previous, current, audit, epoch, service.validUntilEpoch
        );
        AgentStatus memory agent = _agentStatusAt(agentId, epoch);
        emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
    }

    /// @dev Like the other emission controllers: a reserve must be configured to route the part above the cap.
    function _emissionsReserve() private view returns (address reserve) {
        reserve = emissionsGate.emissionsReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }
}
