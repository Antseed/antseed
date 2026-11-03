// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
///         minted to the emissions reserve in the same claim. `settleEpochRemainder` sweeps what no
///         verifier can claim (sources with no credits, and budget assigned to no source) through the
///         gate's remainder route. An epoch's shares freeze the first time it is claimed from or
///         settled, so later share changes never reshuffle an epoch that is being paid out. The share
///         cap and credit cap in force at claim or credit time apply. Integer rounding dust is never
///         minted.
///
///         Epochs come from the emissions gate pinned at deployment; sources read `currentEpoch`
///         here so verdicts, credits and claims can never disagree about the epoch.
contract AntseedVerificationResults is IAntseedVerificationResults, Ownable2Step, ReentrancyGuard {
    uint8 public constant MAX_VALIDITY_EPOCHS = 4;
    uint256 public constant MAX_SOURCES = 8;
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
        uint16 shareBps;
        uint16 maxAuditorShareBps;
        uint32 maxCreditsPerAuditorPerEpoch;
        uint64 rewardsStartEpoch;
    }

    IAntseedRegistry public immutable override registry;
    IAntseedEmissionsGate public immutable override emissionsGate;
    uint8 public override validityEpochs = 2;
    /// @notice Sum of every source's live share; never above BPS.
    uint256 public totalSourceShareBps;

    mapping(address source => bool approved) public override isSource;
    mapping(address source => SourceConfig config) private _sources;
    /// @notice Every source ever approved, in order; at most `MAX_SOURCES`.
    address[] public sourceList;

    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceStatus status)) private _serviceStatus;
    // Latest SAME/DIFF verdicts given in each epoch; a verdict moves out when the service gets a new one.
    mapping(uint256 agentId => mapping(uint256 epoch => EpochCounts counts)) private _epochCounts;

    mapping(address source => mapping(uint256 epoch => uint256 credits)) public override epochCredits;
    mapping(address source => mapping(uint256 epoch => mapping(address auditor => uint256 credits)))
        public
        override auditorEpochCredits;
    mapping(address source => mapping(uint256 epoch => mapping(address auditor => bool claimed)))
        public
        override auditorEpochClaimed;
    /// @notice True once an epoch's source shares are frozen (first claim or settlement).
    mapping(uint256 epoch => bool frozen) public epochSharesFrozen;
    mapping(uint256 epoch => mapping(address source => uint16 shareBps)) private _frozenShareBps;
    mapping(uint256 epoch => bool settled) public override epochRemainderSettled;

    event SourceSet(address indexed source, bool approved);
    event SourceShareBpsSet(address indexed source, uint16 shareBps);
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
    event EpochSharesFrozen(uint256 indexed epoch);
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
    error AlreadySettled();
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

    /// @notice Sets a listed source's share of the bucket. Shares sum to at most BPS. Applies to every
    ///         epoch whose shares are not frozen yet.
    function setSourceShareBps(address source, uint16 shareBps) external onlyOwner {
        SourceConfig storage config = _listed(source);
        uint256 total = totalSourceShareBps - config.shareBps + shareBps;
        if (total > BPS) revert SharesExceedBps();
        totalSourceShareBps = total;
        config.shareBps = shareBps;
        emit SourceShareBpsSet(source, shareBps);
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
    ///         each listed service's verdict. `agentIds[i]` pairs with `serviceHashes[i]`.
    function clearServiceStatuses(uint256[] calldata agentIds, bytes32[] calldata serviceHashes) external onlyOwner {
        uint256 count = agentIds.length;
        if (count != serviceHashes.length) revert InvalidValue();
        uint256 epoch = emissionsGate.currentEpoch();
        for (uint256 i = 0; i < count; i++) {
            _resetService(
                agentIds[i], serviceHashes[i], _serviceStatus[agentIds[i]][serviceHashes[i]], epoch, address(0), 0
            );
        }
    }

    /// @notice Remediation for credit farming: removes a verifier's unclaimed credits from a source
    ///         for an epoch so they no longer dilute others. Claimed credits cannot be voided. Voiding
    ///         only ever raises the other verifiers' shares, so earlier claims never overspend.
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
        Verdict previous = _liveVerdict(service, epoch);
        service.source = msg.sender;
        if (service.verdict == verdict && service.epoch == epoch) return;
        _uncount(agentId, service);
        EpochCounts storage counts = _epochCounts[agentId][epoch];
        if (verdict == Verdict.SAME) counts.same += 1;
        else if (verdict == Verdict.DIFF) counts.diff += 1;
        service.verdict = verdict;
        service.epoch = uint64(epoch);
        if (previous == verdict) return;
        service.updatedAt = uint64(block.timestamp);
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
        return _sources[source].shareBps;
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
        uint256 shareBps = epochSharesFrozen[epoch] ? _frozenShareBps[epoch][source] : _sources[source].shareBps;
        return (emissionsGate.controllerEpochBudget(address(this), epoch) * shareBps) / BPS;
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
        IAntseedEmissionsGate gate = emissionsGate;
        uint256 current = gate.currentEpoch();
        address reserve = gate.emissionsReserve();
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= current) revert EpochNotFinalized();
            if (auditorEpochClaimed[source][epoch][msg.sender] || auditorEpochCredits[source][epoch][msg.sender] == 0) {
                continue;
            }
            (uint256 amount, uint256 overflow) = _reward(source, msg.sender, epoch);
            if (amount == 0) continue;
            // Freeze only once something is paid, so an empty claim never locks in a zero share.
            _freezeShares(epoch);
            // With no reserve configured on the gate, the overflow is not minted.
            if (reserve == address(0)) overflow = 0;
            auditorEpochClaimed[source][epoch][msg.sender] = true;
            total += amount;
            gate.claim(epoch, msg.sender, amount);
            if (overflow != 0) gate.claim(epoch, reserve, overflow);
            emit RewardClaimed(source, epoch, msg.sender, amount, overflow);
        }
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
        if (epochRemainderSettled[epoch]) revert AlreadySettled();
        IAntseedEmissionsGate gate = emissionsGate;
        if (epoch >= gate.currentEpoch()) revert EpochNotFinalized();
        _freezeShares(epoch);
        uint256 budget = gate.controllerEpochBudget(address(this), epoch);
        uint256 allocated;
        uint256 count = sourceList.length;
        for (uint256 i = 0; i < count; i++) {
            address source = sourceList[i];
            if (epochCredits[source][epoch] != 0) allocated += (budget * _frozenShareBps[epoch][source]) / BPS;
        }
        if (allocated >= budget) revert NothingToSettle();
        uint256 amount = budget - allocated;
        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = gate.claimRemainder(epoch, gate.emissionsReserve(), amount);
        emit EpochRemainderSettled(epoch, amount, burnedAmount, reserveAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _listed(address source) private view returns (SourceConfig storage config) {
        config = _sources[source];
        if (!config.listed) revert UnknownSource();
    }

    /// @dev Records every listed source's share for `epoch` the first time the epoch is paid from.
    function _freezeShares(uint256 epoch) private {
        if (epochSharesFrozen[epoch]) return;
        epochSharesFrozen[epoch] = true;
        uint256 count = sourceList.length;
        for (uint256 i = 0; i < count; i++) {
            address source = sourceList[i];
            _frozenShareBps[epoch][source] = _sources[source].shareBps;
        }
        emit EpochSharesFrozen(epoch);
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
        emit ServiceStatusChanged(
            agentId, serviceHash, service.modelHash, previous, service.verdict, source, evidenceHash
        );
        AgentStatus memory agent = _agentStatusAt(agentId, epoch);
        emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
    }
}
