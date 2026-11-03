// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Checkpoints } from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedVerificationResults } from "../interfaces/IAntseedVerificationResults.sol";

interface IEmissionsGateSource {
    function emissionsGate() external view returns (address);
}

/// @notice The verification results layer: a verdict registry and the holder of the verification
///         emission bucket. See `IAntseedVerificationResults`.
///
///         Verdicts: each (agent, service) keeps its latest recorded result, the epoch it was given
///         in and the source that gave it. A verdict counts while `currentEpoch < epoch + validityEpochs`
///         (default 2: through the epoch after it was given). A SAME verifies that service, a DIFF
///         marks it as not serving the recorded model, and an UNDETERMINED counts as neither. Each
///         agent keeps per-epoch SAME and DIFF counters, so its status sums only the last
///         `validityEpochs` epochs and older verdicts drop out without any cleanup. How a verdict is
///         reached is the source's business: the latest record from any approved source wins.
///
///         Sources: contracts approved with `setSource` (at most `MAX_SOURCES` ever listed). Removing a
///         source stops its writes and new credits; credits it already granted stay claimable
///         until its share is set to 0.
///
///         Rewards, per source: a share of the bucket's epoch budget (shares sum to at most 100%), a
///         rewards start epoch (default off), a per-verifier credit cap per epoch (default 100), and a
///         per-verifier share cap (default 20%). A verifier's gross reward is
///         `sourceBudget * credits / sourceCredits`; it receives up to the share cap and the rest is
///         minted to the emissions reserve in the same claim. Share changes take effect from the
///         next epoch, like the gate's own minter shares, so a running or finished epoch's split never
///         changes. The share cap and credit cap in force at claim or credit time apply.
///
///         `settleEpochRemainder` sweeps what no verifier can ever claim through the gate's remainder
///         route (burn, then reserve): budget assigned to no source, sources without credits, and
///         what voided credits free up. It can be called again whenever more is freed. Rounding dust
///         of credited sources stays unminted.
///
///         Epochs come from the emissions gate pinned at deployment; sources read `currentEpoch`
///         here so verdicts, credits and claims can never disagree about the epoch.
contract AntseedVerificationResults is IAntseedVerificationResults, Ownable2Step, ReentrancyGuard {
    using Checkpoints for Checkpoints.Trace256;

    uint8 public constant MAX_VALIDITY_EPOCHS = 4;
    uint256 public constant MAX_SOURCES = 32;
    uint256 public constant BPS = 10_000;
    uint16 public constant DEFAULT_MAX_AUDITOR_SHARE_BPS = 2_000;
    uint32 public constant DEFAULT_MAX_CREDITS_PER_AUDITOR_PER_EPOCH = 100;
    uint64 public constant REWARDS_OFF = type(uint64).max;

    struct EpochCounts {
        uint32 same;
        uint32 diff;
    }

    struct SourceConfig {
        bool listed;
        uint16 maxAuditorShareBps;
        uint32 maxCreditsPerAuditorPerEpoch;
        uint64 rewardsStartEpoch;
    }

    IAntseedRegistry public immutable override registry;
    IAntseedEmissionsGate public immutable override emissionsGate;
    uint8 public override validityEpochs = 2;
    /// @notice Sum of every source's latest share (what applies from the next epoch); never above BPS.
    uint256 public totalSourceShareBps;

    mapping(address source => bool approved) public override isSource;
    mapping(address source => SourceConfig config) private _sources;
    // Share in bps per source, checkpointed by the epoch it applies from.
    mapping(address source => Checkpoints.Trace256 shares) private _shares;
    /// @notice Every source ever approved, in order; at most `MAX_SOURCES`.
    address[] public sourceList;

    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceStatus status)) private _serviceStatus;
    /// @inheritdoc IAntseedVerificationResults
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 clears)) public override serviceClears;
    /// @inheritdoc IAntseedVerificationResults
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 changes)) public override diffChanges;
    // Latest SAME/DIFF verdicts given in each epoch; a verdict moves out when the service gets a new one.
    mapping(uint256 agentId => mapping(uint256 epoch => EpochCounts counts)) private _epochCounts;

    mapping(address source => mapping(uint256 epoch => uint256 credits)) public override epochCredits;
    mapping(address source => mapping(uint256 epoch => mapping(address auditor => uint256 credits)))
        public
        override auditorEpochCredits;
    mapping(address source => mapping(uint256 epoch => mapping(address auditor => bool claimed)))
        public
        override auditorEpochClaimed;
    /// @inheritdoc IAntseedVerificationResults
    mapping(address source => mapping(uint256 epoch => uint256 credits)) public override claimedCredits;
    /// @inheritdoc IAntseedVerificationResults
    mapping(address source => mapping(uint256 epoch => uint256 amount)) public override paidRewards;
    /// @inheritdoc IAntseedVerificationResults
    mapping(uint256 epoch => uint256 amount) public override settledRemainder;

    event SourceSet(address indexed source, bool approved);
    event SourceShareBpsSet(address indexed source, uint16 shareBps, uint256 fromEpoch);
    event RewardsStartEpochSet(address indexed source, uint64 epoch);
    event MaxAuditorShareBpsSet(address indexed source, uint16 shareBps);
    event MaxCreditsPerAuditorPerEpochSet(address indexed source, uint32 maxCredits);
    event ValidityEpochsSet(uint8 validityEpochs);
    /// @param source The source that recorded `current`; zero when the owner cleared the service.
    /// @param evidenceHash Evidence the recording source cited; zero when none.
    event ServiceStatusChanged(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        bytes32 modelHash,
        Verdict previous,
        Verdict current,
        address source,
        bytes32 evidenceHash
    );
    event AgentStatusChanged(uint256 indexed agentId, uint16 verifiedCount, uint16 diffCount);
    event Credited(address indexed source, uint256 indexed epoch, address indexed auditor, uint256 credits);
    event CreditsVoided(address indexed source, uint256 indexed epoch, address indexed auditor, uint256 credits);
    /// @param amount What the verifier received. @param reserveAmount Its gross reward above the cap,
    ///        minted to the emissions reserve.
    event RewardClaimed(
        address indexed source, uint256 indexed epoch, address indexed auditor, uint256 amount, uint256 reserveAmount
    );
    event EpochRemainderSettled(uint256 indexed epoch, uint256 amount, uint256 burnedAmount, uint256 reserveAmount);

    error InvalidAddress();
    error InvalidValue();
    error NotSource();
    error UnknownSource();
    error TooManySources();
    error SharesExceedBps();
    error EpochNotFinalized();
    error AlreadyClaimed();
    error NothingToSettle();

    /// @dev Pins the emissions gate behind `registry.emissions()`. After M001 the registry points at
    ///      usage accounting, which exposes the gate as `emissionsGate()`; otherwise the registry
    ///      entry is the gate itself. Verdict epochs only make sense against one gate, so a new
    ///      gate needs a new results deployment.
    constructor(address registry_) Ownable(msg.sender) {
        if (registry_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
        address emissions = IAntseedRegistry(registry_).emissions();
        if (emissions.code.length == 0) revert InvalidAddress();
        address gate = emissions;
        try IEmissionsGateSource(emissions).emissionsGate() returns (address source) {
            if (source.code.length != 0) gate = source;
        } catch { }
        emissionsGate = IAntseedEmissionsGate(gate);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Approves or removes a source contract. The first approval lists it with the default
    ///         caps and its rewards off. A removed source keeps its settings, so credits it granted
    ///         stay claimable; set its share to 0 to stop that and free it for other sources.
    function setSource(address source, bool approved) external onlyOwner {
        if (source.code.length == 0) revert InvalidAddress();
        SourceConfig storage config = _sources[source];
        if (approved && !config.listed) {
            if (sourceList.length >= MAX_SOURCES) revert TooManySources();
            sourceList.push(source);
            config.listed = true;
            config.maxAuditorShareBps = DEFAULT_MAX_AUDITOR_SHARE_BPS;
            config.maxCreditsPerAuditorPerEpoch = DEFAULT_MAX_CREDITS_PER_AUDITOR_PER_EPOCH;
            config.rewardsStartEpoch = REWARDS_OFF;
        }
        isSource[source] = approved;
        emit SourceSet(source, approved);
    }

    /// @notice Sets a listed source's share of the bucket from the next epoch on; the current and
    ///         past epochs keep theirs. Shares sum to at most BPS.
    function setSourceShareBps(address source, uint16 shareBps) external onlyOwner {
        _listed(source);
        Checkpoints.Trace256 storage shares = _shares[source];
        uint256 total = totalSourceShareBps - shares.latest() + shareBps;
        if (total > BPS) revert SharesExceedBps();
        totalSourceShareBps = total;
        uint256 fromEpoch = emissionsGate.currentEpoch() + 1;
        shares.push(fromEpoch, shareBps);
        emit SourceShareBpsSet(source, shareBps, fromEpoch);
    }

    /// @notice Credits from `source` count from this epoch on. Set it to the epoch the source's
    ///         rewards launch so work done before launch never claims past budgets; `REWARDS_OFF`
    ///         turns new credits off again. Credits already earned stay claimable.
    function setRewardsStartEpoch(address source, uint64 epoch) external onlyOwner {
        _listed(source).rewardsStartEpoch = epoch;
        emit RewardsStartEpochSet(source, epoch);
    }

    /// @notice Most of the source's epoch budget one verifier can receive. Applies to every claim
    ///         made after the change, including past epochs; the rest of a capped reward goes to the reserve.
    function setMaxAuditorShareBps(address source, uint16 shareBps) external onlyOwner {
        if (shareBps == 0 || shareBps > BPS) revert InvalidValue();
        _listed(source).maxAuditorShareBps = shareBps;
        emit MaxAuditorShareBpsSet(source, shareBps);
    }

    /// @notice Most credits one verifier can earn from the source per epoch.
    function setMaxCreditsPerAuditorPerEpoch(address source, uint32 maxCredits) external onlyOwner {
        if (maxCredits == 0) revert InvalidValue();
        _listed(source).maxCreditsPerAuditorPerEpoch = maxCredits;
        emit MaxCreditsPerAuditorPerEpochSet(source, maxCredits);
    }

    /// @notice Epochs a verdict counts for, including the one it was given in. Applies to
    ///         existing verdicts immediately.
    function setValidityEpochs(uint8 epochs) external onlyOwner {
        if (epochs == 0 || epochs > MAX_VALIDITY_EPOCHS) revert InvalidValue();
        validityEpochs = epochs;
        emit ValidityEpochsSet(epochs);
    }

    /// @notice Remediation for wrong results, e.g. from a removed source or a bad verifier: resets
    ///         each listed service's verdict and bumps its `serviceClears`, so sources can drop
    ///         reports made before the clear. `agentIds[i]` pairs with `serviceHashes[i]`.
    function clearServiceStatuses(uint256[] calldata agentIds, bytes32[] calldata serviceHashes) external onlyOwner {
        uint256 count = agentIds.length;
        if (count != serviceHashes.length) revert InvalidValue();
        uint256 epoch = emissionsGate.currentEpoch();
        for (uint256 i = 0; i < count; i++) {
            serviceClears[agentIds[i]][serviceHashes[i]] += 1;
            _resetService(
                agentIds[i], serviceHashes[i], _serviceStatus[agentIds[i]][serviceHashes[i]], epoch, address(0), 0
            );
        }
    }

    /// @notice Remediation for credit farming: removes a verifier's unclaimed credits from a source
    ///         for an epoch so they no longer dilute others. Claimed credits cannot be voided. Voiding
    ///         only ever raises the other verifiers' shares, so earlier claims never overspend; budget
    ///         it frees that nobody can claim any more becomes settleable again.
    function voidCredits(address source, uint256 epoch, address auditor) external onlyOwner {
        if (auditorEpochClaimed[source][epoch][auditor]) revert AlreadyClaimed();
        uint256 credits = auditorEpochCredits[source][epoch][auditor];
        if (credits == 0) return;
        auditorEpochCredits[source][epoch][auditor] = 0;
        epochCredits[source][epoch] -= credits;
        emit CreditsVoided(source, epoch, auditor, credits);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VERDICTS (sources)
    // ═══════════════════════════════════════════════════════════════════

    function record(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict, bytes32 evidenceHash)
        external
        override
    {
        if (!isSource[msg.sender]) revert NotSource();
        if (serviceHash == bytes32(0) || modelHash == bytes32(0) || verdict == Verdict.NONE) revert InvalidValue();
        uint256 epoch = emissionsGate.currentEpoch();
        ServiceStatus storage service = _serviceStatus[agentId][serviceHash];
        if (service.modelHash != modelHash) {
            if (service.modelHash != bytes32(0)) {
                _resetService(agentId, serviceHash, service, epoch, msg.sender, evidenceHash);
            }
            service.modelHash = modelHash;
        }
        // The same verdict again in the same epoch changes nothing, attribution included.
        if (service.verdict == verdict && service.epoch == epoch) return;
        Verdict previous = _liveVerdict(service, epoch);
        address previousSource = service.source;
        _uncount(agentId, service);
        EpochCounts storage counts = _epochCounts[agentId][epoch];
        if (verdict == Verdict.SAME) counts.same += 1;
        else if (verdict == Verdict.DIFF) counts.diff += 1;
        service.verdict = verdict;
        service.epoch = uint64(epoch);
        service.source = msg.sender;
        if (previous != verdict) service.updatedAt = uint64(block.timestamp);
        else if (previousSource == msg.sender) return;
        // Emitted whenever the live verdict or the source behind it changes.
        _emitServiceChange(agentId, serviceHash, service, previous, epoch, msg.sender, evidenceHash);
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

    function sourceCount() external view returns (uint256) {
        return sourceList.length;
    }

    function sourceShareBps(address source) external view override returns (uint16) {
        return uint16(_shares[source].latest());
    }

    function sourceShareBpsAt(address source, uint256 epoch) public view override returns (uint16) {
        return uint16(_shares[source].upperLookupRecent(epoch));
    }

    function rewardsStartEpoch(address source) external view override returns (uint64) {
        return _sources[source].rewardsStartEpoch;
    }

    function maxAuditorShareBps(address source) external view override returns (uint16) {
        return _sources[source].maxAuditorShareBps;
    }

    function maxCreditsPerAuditorPerEpoch(address source) external view override returns (uint32) {
        return _sources[source].maxCreditsPerAuditorPerEpoch;
    }

    function sourceBudget(address source, uint256 epoch) public view override returns (uint256) {
        return (emissionsGate.controllerEpochBudget(address(this), epoch) * sourceShareBpsAt(source, epoch)) / BPS;
    }

    function unclaimableRemainder(uint256 epoch) public view override returns (uint256) {
        IAntseedEmissionsGate gate = emissionsGate;
        if (epoch >= gate.currentEpoch()) return 0;
        uint256 budget = gate.controllerEpochBudget(address(this), epoch);
        uint256 reserved;
        uint256 count = sourceList.length;
        for (uint256 i = 0; i < count; i++) {
            reserved += _reservedFor(sourceList[i], epoch, budget);
        }
        uint256 owed = budget - reserved - settledRemainder[epoch];
        // Never ask the gate for more than is left of the bucket, e.g. after an earlier controller of
        // the same minter id minted for this epoch.
        uint256 minted = gate.minterEpochMinted(gate.controllerMinterIds(address(this)), epoch);
        uint256 left = budget > minted ? budget - minted : 0;
        return owed < left ? owed : left;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REWARDS
    // ═══════════════════════════════════════════════════════════════════

    function credit(address auditor, uint256 credits) external override returns (uint256 credited) {
        if (!isSource[msg.sender]) revert NotSource();
        if (auditor == address(0)) revert InvalidAddress();
        if (credits == 0) return 0;
        SourceConfig storage config = _sources[msg.sender];
        uint256 epoch = emissionsGate.currentEpoch();
        if (epoch < config.rewardsStartEpoch) return 0;
        uint256 have = auditorEpochCredits[msg.sender][epoch][auditor];
        uint256 cap = config.maxCreditsPerAuditorPerEpoch;
        if (have >= cap) return 0;
        credited = credits;
        if (have + credited > cap) credited = cap - have;
        auditorEpochCredits[msg.sender][epoch][auditor] = have + credited;
        epochCredits[msg.sender][epoch] += credited;
        emit Credited(msg.sender, epoch, auditor, credited);
    }

    function claimRewards(address source, uint256[] calldata epochs)
        external
        override
        nonReentrant
        returns (uint256 total)
    {
        uint256 current = emissionsGate.currentEpoch();
        for (uint256 i = 0; i < epochs.length; i++) {
            if (epochs[i] >= current) revert EpochNotFinalized();
            total += _claimEpoch(source, epochs[i]);
        }
    }

    /// @dev Pays the caller's reward for one finalized epoch; 0 (and nothing changes) when there is none.
    function _claimEpoch(address source, uint256 epoch) private returns (uint256 amount) {
        if (auditorEpochClaimed[source][epoch][msg.sender] || auditorEpochCredits[source][epoch][msg.sender] == 0) {
            return 0;
        }
        uint256 overflow;
        (amount, overflow) = _reward(source, msg.sender, epoch);
        if (amount == 0) return 0;
        auditorEpochClaimed[source][epoch][msg.sender] = true;
        claimedCredits[source][epoch] += auditorEpochCredits[source][epoch][msg.sender];
        paidRewards[source][epoch] += amount + overflow;
        IAntseedEmissionsGate gate = emissionsGate;
        gate.claim(epoch, msg.sender, amount);
        if (overflow != 0) gate.claim(epoch, _emissionsReserve(gate), overflow);
        emit RewardClaimed(source, epoch, msg.sender, amount, overflow);
    }

    function pendingReward(address source, address auditor, uint256 epoch) external view override returns (uint256) {
        if (epoch >= emissionsGate.currentEpoch() || auditorEpochClaimed[source][epoch][auditor]) return 0;
        (uint256 amount,) = _reward(source, auditor, epoch);
        return amount;
    }

    function settleEpochRemainder(uint256 epoch)
        external
        override
        nonReentrant
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        IAntseedEmissionsGate gate = emissionsGate;
        if (epoch >= gate.currentEpoch()) revert EpochNotFinalized();
        uint256 amount = unclaimableRemainder(epoch);
        if (amount == 0) revert NothingToSettle();
        settledRemainder[epoch] += amount;
        (burnedAmount, reserveAmount) = gate.claimRemainder(epoch, _emissionsReserve(gate), amount);
        emit EpochRemainderSettled(epoch, amount, burnedAmount, reserveAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _listed(address source) private view returns (SourceConfig storage config) {
        config = _sources[source];
        if (!config.listed) revert UnknownSource();
    }

    /// @dev What `source` may still mint for a finalized `epoch`, plus what it already minted: its paid
    ///      rewards plus the gross of every unclaimed credit. Claims only ever lower it (a claim pays
    ///      at most the floor it reserved) and so do voids (fewer unclaimed credits over fewer credits),
    ///      so whatever settlement sweeps can never be needed by a later claim.
    function _reservedFor(address source, uint256 epoch, uint256 budget) private view returns (uint256) {
        uint256 credits = epochCredits[source][epoch];
        uint256 paid = paidRewards[source][epoch];
        if (credits == 0) return paid;
        uint256 sourceShare = (budget * sourceShareBpsAt(source, epoch)) / BPS;
        return paid + (sourceShare * (credits - claimedCredits[source][epoch])) / credits;
    }

    /// @dev The verifier's capped reward and the overflow above the cap, at the current share and caps.
    function _reward(address source, address auditor, uint256 epoch)
        private
        view
        returns (uint256 amount, uint256 overflow)
    {
        uint256 credits = auditorEpochCredits[source][epoch][auditor];
        if (credits == 0) return (0, 0);
        uint256 budget = sourceBudget(source, epoch);
        uint256 gross = (budget * credits) / epochCredits[source][epoch];
        uint256 cap = (budget * _sources[source].maxAuditorShareBps) / BPS;
        amount = gross < cap ? gross : cap;
        overflow = gross - amount;
    }

    function _resetService(
        uint256 agentId,
        bytes32 serviceHash,
        ServiceStatus storage service,
        uint256 epoch,
        address source,
        bytes32 evidenceHash
    ) private {
        Verdict previous = _liveVerdict(service, epoch);
        _uncount(agentId, service);
        service.verdict = Verdict.NONE;
        service.epoch = 0;
        service.source = address(0);
        service.updatedAt = uint64(block.timestamp);
        if (previous != Verdict.NONE) {
            _emitServiceChange(agentId, serviceHash, service, previous, epoch, source, evidenceHash);
        }
    }

    /// @dev Removes the service's stored verdict from the counter of the epoch it was given in.
    function _uncount(uint256 agentId, ServiceStatus storage service) private {
        Verdict stored = service.verdict;
        if (stored == Verdict.NONE) return;
        EpochCounts storage counts = _epochCounts[agentId][service.epoch];
        if (stored == Verdict.SAME) counts.same -= 1;
        else if (stored == Verdict.DIFF) counts.diff -= 1;
    }

    function _liveVerdict(ServiceStatus storage service, uint256 epoch) private view returns (Verdict) {
        Verdict stored = service.verdict;
        if (stored == Verdict.NONE || epoch >= uint256(service.epoch) + validityEpochs) return Verdict.NONE;
        return stored;
    }

    /// @dev Sums the counters of the epochs whose verdicts are still live, saturating at uint16.
    function _agentStatusAt(uint256 agentId, uint256 epoch) private view returns (AgentStatus memory status) {
        uint256 same;
        uint256 diff;
        uint256 window = validityEpochs;
        for (uint256 i = 0; i < window && i <= epoch; i++) {
            EpochCounts storage counts = _epochCounts[agentId][epoch - i];
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
        address source,
        bytes32 evidenceHash
    ) private {
        // Counted for every source and for owner clears, so a source's report rounds can start over
        // whenever the service's DIFF state moves, whoever moved it.
        Verdict current = service.verdict;
        if (previous != current && (previous == Verdict.DIFF || current == Verdict.DIFF)) {
            diffChanges[agentId][serviceHash] += 1;
        }
        emit ServiceStatusChanged(
            agentId, serviceHash, service.modelHash, previous, service.verdict, source, evidenceHash
        );
        AgentStatus memory agent = _agentStatusAt(agentId, epoch);
        emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
    }

    /// @dev Like the other emission controllers: a reserve must be configured to route overflow or remainders.
    function _emissionsReserve(IAntseedEmissionsGate gate) private view returns (address reserve) {
        reserve = gate.emissionsReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }
}
