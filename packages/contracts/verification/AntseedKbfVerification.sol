// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedSellerPools} from "../interfaces/IAntseedSellerPools.sol";
import {IAntseedKbfVerification} from "../interfaces/IAntseedKbfVerification.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

interface IEmissionsGateSource {
    function emissionsGate() external view returns (address);
}

/// @notice Records KBF (Knowledge Boundary Fingerprinting) model audits from approved auditors, one
///         model per submission. KBF is one of several verification methods: every audit recorded
///         here is a KBF audit. Another method gets its own contract, its own points policy, and its
///         own emissions bucket, and never writes into KBF verdicts.
///
///
///         Status: each (agent, service) keeps its latest recorded result as its verdict, with the
///         emissions epoch it was given in. A verdict counts while `currentEpoch < epoch + validityEpochs`
///         (default 2: through the epoch after the audit). A SAME verifies that service, a DIFF
///         marks it as not serving the audited model, and an UNDETERMINED (the audit could not
///         decide) counts as neither.
///
///         Confirmations: a result is recorded once `requiredReports[verdict]` distinct approved
///         auditors report it for the same (agent, service, model) in the same epoch (defaults:
///         SAME 1, DIFF 2, UNDETERMINED 1), so a DIFF needs a second auditor. Replacing a live DIFF
///         needs as many reports as a DIFF does, whatever the new result or model, so one auditor
///         cannot clear a confirmed DIFF either. Reports count per epoch only, and only those made
///         after the service's verdict last moved into or out of DIFF: that change starts a new
///         report round, so support given before a DIFF was confirmed cannot clear it, and support
///         given before a DIFF was cleared cannot restore it. An auditor's later report replaces its
///         earlier one; a repeated report adds no support, so it records again only when one report
///         is enough. Every report emits `ServiceAudited` with its round, the reports so far and
///         the reports needed.
///         Each agent keeps per-epoch SAME and DIFF counters, so its status sums only the last
///         `validityEpochs` epochs and older verdicts drop out without any cleanup.
///         Results for agents the identity registry cannot resolve (e.g. burned) are skipped with
///         `UnknownAgentSkipped`, so one stale agent does not fail the whole audit.
///
///         Epochs come from the emissions gate pinned at deployment; audits revert without it.
///
///         Rewards: from `rewardsStartEpoch` on (off until the owner sets it), an auditor earns one
///         credit per model audit, whatever the results, up to `maxCreditsPerModelPerEpoch` per
///         model and `maxCreditsPerAuditorPerEpoch` overall, provided the audit covers at least one
///         agent with staked pool power. Once the epoch is final an auditor claims
///         `min(budget * credits / totalCredits, budget * maxAuditorShareBps / BPS)` from the
///         verification emission bucket, using the share cap in force at claim time. Budget above
///         the cap is never minted.
contract AntseedKbfVerification is IAntseedKbfVerification, Ownable2Step {
    uint256 public constant MAX_RESULTS_PER_AUDIT = 256;
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;
    uint8 public constant MAX_VALIDITY_EPOCHS = 4;
    uint256 public constant BPS = 10_000;

    struct EpochCounts {
        uint32 same;
        uint32 diff;
    }

    IAntseedRegistry public immutable override registry;
    IAntseedEmissionsGate public immutable override emissionsGate;
    IAntseedSellerPools public override sellerPools;
    uint8 public override validityEpochs = 2;
    // Safety limits against a compromised or malicious auditor; honest auditors should stay below them.
    /// @notice Safety limit: credits one auditor can earn per epoch (default 100). Stops an auditor
    ///         that invents model hashes from inflating total credits and diluting honest auditors.
    uint32 public maxCreditsPerAuditorPerEpoch = 100;
    /// @notice Safety limit: credited audits of the same model per auditor and epoch (default 1).
    ///         Stops an auditor from earning repeatedly by re-auditing one model.
    uint32 public maxCreditsPerModelPerEpoch = 1;
    /// @notice Safety limit: most of an epoch's verification budget one auditor can claim, in bps
    ///         (default 20%). Stops a single auditor from draining the bucket.
    uint16 public override maxAuditorShareBps = 2_000;
    /// @notice First epoch whose audits earn credits; `type(uint256).max` keeps rewards off.
    uint256 public override rewardsStartEpoch = type(uint256).max;
    /// @notice Distinct approved auditors that must report a verdict in one epoch before it is recorded.
    mapping(Verdict verdict => uint8 reports) public requiredReports;

    mapping(address auditor => bool approved) public override approvedAuditors;

    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceStatus status)) private _serviceStatus;
    // Latest SAME/DIFF verdicts given in each epoch; a verdict moves out when the service gets a new one.
    mapping(uint256 agentId => mapping(uint256 epoch => EpochCounts counts)) private _epochCounts;
    // Reports per (epoch, agent, service, model, round): how many auditors report each verdict, and each auditor's report.
    mapping(bytes32 reportKey => mapping(Verdict verdict => uint256 reports)) private _reportCounts;
    mapping(bytes32 reportKey => mapping(address auditor => Verdict verdict)) private _reports;
    // Bumped whenever a service's live verdict moves into or out of DIFF; earlier reports stop counting.
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint256 round)) public reportRound;

    mapping(uint256 epoch => uint256 credits) public epochCredits;
    mapping(uint256 epoch => mapping(address auditor => uint256 credits)) public auditorEpochCredits;
    mapping(uint256 epoch => mapping(address auditor => mapping(bytes32 modelHash => uint256 credits))) public
        modelCredits;
    mapping(uint256 epoch => mapping(address auditor => bool claimed)) public auditorEpochClaimed;

    event AuditorSet(address indexed auditor, bool approved);
    event SellerPoolsSet(address sellerPools);
    event ValidityEpochsSet(uint8 validityEpochs);
    event MaxCreditsPerAuditorPerEpochSet(uint32 maxCredits);
    event MaxCreditsPerModelPerEpochSet(uint32 maxCredits);
    event MaxAuditorShareBpsSet(uint16 shareBps);
    event RewardsStartEpochSet(uint256 epoch);
    event RequiredReportsSet(Verdict indexed verdict, uint8 reports);
    event ModelAudited(
        bytes32 indexed modelHash,
        address indexed auditor,
        uint256 indexed epoch,
        bytes32 evidenceHash,
        string evidenceUri,
        uint256 resultCount
    );
    /// @param round The service's report round; only reports of the current round count.
    /// @param reports Distinct auditors reporting `verdict` for this service and model this epoch and round.
    /// @param required Reports `verdict` needs to be recorded; it is recorded once `reports` reaches it.
    event ServiceAudited(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        address indexed auditor,
        bytes32 modelHash,
        Verdict verdict,
        uint256 round,
        uint256 reports,
        uint256 required
    );
    event ServiceStatusChanged(
        uint256 indexed agentId, bytes32 indexed serviceHash, bytes32 modelHash, Verdict previous, Verdict current
    );
    event AgentStatusChanged(uint256 indexed agentId, uint16 verifiedCount, uint16 diffCount);
    event AuditCredited(uint256 indexed epoch, address indexed auditor, bytes32 indexed modelHash);
    event AuditorRewardClaimed(uint256 indexed epoch, address indexed auditor, uint256 amount);
    event AuditorCreditsVoided(uint256 indexed epoch, address indexed auditor, uint256 credits);
    event UnknownAgentSkipped(uint256 indexed agentId, bytes32 indexed modelHash);

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedAuditor();
    error InvalidEvidenceUri();
    error InvalidResults();
    error UnknownAgent();
    error SelfAudit();
    error EpochChanged();
    error EpochNotFinalized();
    error AlreadyClaimed();

    /// @dev Pins the emissions gate behind `registry.emissions()`. After M001 the registry points at
    ///      usage accounting, which exposes the gate as `emissionsGate()`; otherwise the registry
    ///      entry is the gate itself. Verdict epochs only make sense against one gate, so a new
    ///      gate needs a new verification deployment.
    constructor(address registry_, address sellerPools_) Ownable(msg.sender) {
        if (registry_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
        address emissions = IAntseedRegistry(registry_).emissions();
        if (emissions.code.length == 0) revert InvalidAddress();
        address gate = emissions;
        try IEmissionsGateSource(emissions).emissionsGate() returns (address source) {
            if (source.code.length != 0) gate = source;
        } catch {}
        emissionsGate = IAntseedEmissionsGate(gate);
        _setSellerPools(sellerPools_);
        requiredReports[Verdict.SAME] = 1;
        requiredReports[Verdict.DIFF] = 2;
        requiredReports[Verdict.UNDETERMINED] = 1;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setAuditor(address auditor, bool approved) external override onlyOwner {
        if (auditor == address(0)) revert InvalidAddress();
        approvedAuditors[auditor] = approved;
        emit AuditorSet(auditor, approved);
    }

    function setSellerPools(address sellerPools_) external onlyOwner {
        _setSellerPools(sellerPools_);
    }

    /// @notice Epochs a verdict counts for, including the one it was given in. Applies to
    ///         existing verdicts immediately.
    function setValidityEpochs(uint8 epochs) external onlyOwner {
        if (epochs == 0 || epochs > MAX_VALIDITY_EPOCHS) revert InvalidValue();
        validityEpochs = epochs;
        emit ValidityEpochsSet(epochs);
    }

    /// @notice Distinct approved auditors `verdict` needs in one epoch before it is recorded.
    ///         Applies from the next report on.
    function setRequiredReports(Verdict verdict, uint8 reports) external onlyOwner {
        if (verdict == Verdict.NONE || reports == 0) revert InvalidValue();
        requiredReports[verdict] = reports;
        emit RequiredReportsSet(verdict, reports);
    }

    /// @notice Sets the per-auditor safety limit on credits per epoch.
    function setMaxCreditsPerAuditorPerEpoch(uint32 maxCredits) external onlyOwner {
        if (maxCredits == 0) revert InvalidValue();
        maxCreditsPerAuditorPerEpoch = maxCredits;
        emit MaxCreditsPerAuditorPerEpochSet(maxCredits);
    }

    /// @notice Sets the per-model safety limit on credited audits per auditor and epoch.
    function setMaxCreditsPerModelPerEpoch(uint32 maxCredits) external onlyOwner {
        if (maxCredits == 0) revert InvalidValue();
        maxCreditsPerModelPerEpoch = maxCredits;
        emit MaxCreditsPerModelPerEpochSet(maxCredits);
    }

    /// @notice Sets the safety limit on one auditor's share of an epoch's budget, so a compromised
    ///         auditor cannot take the whole bucket. Applies to every claim made after the change,
    ///         including past epochs.
    function setMaxAuditorShareBps(uint16 shareBps) external onlyOwner {
        if (shareBps == 0 || shareBps > BPS) revert InvalidValue();
        maxAuditorShareBps = shareBps;
        emit MaxAuditorShareBpsSet(shareBps);
    }

    /// @notice Audits earn credits from this epoch on. Set it to the epoch rewards launch so
    ///         audits made before launch never claim past budgets; `type(uint256).max` turns
    ///         new credits off again. Credits already earned stay claimable.
    function setRewardsStartEpoch(uint256 epoch) external onlyOwner {
        rewardsStartEpoch = epoch;
        emit RewardsStartEpochSet(epoch);
    }

    /// @notice Remediation for wrong results, e.g. from a revoked auditor: resets each listed
    ///         service's verdict. `agentIds[i]` pairs with `serviceHashes[i]`.
    function clearServiceStatuses(uint256[] calldata agentIds, bytes32[] calldata serviceHashes)
        external
        onlyOwner
    {
        uint256 count = agentIds.length;
        if (count != serviceHashes.length) revert InvalidValue();
        uint256 epoch = emissionsGate.currentEpoch();
        for (uint256 i = 0; i < count; i++) {
            _resetService(agentIds[i], serviceHashes[i], _serviceStatus[agentIds[i]][serviceHashes[i]], epoch);
        }
    }

    /// @notice Remediation for credit farming: removes an auditor's unclaimed credits for an
    ///         epoch so they no longer dilute other auditors' shares. Claimed epochs cannot be voided.
    function voidAuditorCredits(uint256 epoch, address auditor) external onlyOwner {
        if (auditorEpochClaimed[epoch][auditor]) revert AlreadyClaimed();
        uint256 credits = auditorEpochCredits[epoch][auditor];
        if (credits == 0) return;
        auditorEpochCredits[epoch][auditor] = 0;
        epochCredits[epoch] -= credits;
        emit AuditorCreditsVoided(epoch, auditor, credits);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        AUDITS
    // ═══════════════════════════════════════════════════════════════════

    function submitModelAudit(
        uint256 expectedEpoch,
        bytes32 modelHash,
        bytes32 evidenceHash,
        string calldata evidenceUri,
        ServiceResult[] calldata results
    ) external override {
        if (!approvedAuditors[msg.sender]) revert NotApprovedAuditor();
        if (modelHash == bytes32(0) || evidenceHash == bytes32(0)) revert InvalidValue();
        _validateEvidenceUri(evidenceUri);
        uint256 count = results.length;
        if (count == 0 || count > MAX_RESULTS_PER_AUDIT) revert InvalidResults();

        uint256 epoch = emissionsGate.currentEpoch();
        if (epoch != expectedEpoch) revert EpochChanged();

        bool staked;
        bool skipAgent;
        uint256 previousAgent;
        bytes32 previousService;
        for (uint256 i = 0; i < count; i++) {
            ServiceResult calldata result = results[i];
            if (
                result.serviceHash == bytes32(0) || result.verdict == Verdict.NONE || result.agentId < previousAgent
                    || (result.agentId == previousAgent && result.serviceHash <= previousService)
            ) revert InvalidResults();
            if (i == 0 || result.agentId != previousAgent) {
                if (result.agentId == 0) revert UnknownAgent();
                (bool known, address owner) = _agentOwner(result.agentId);
                if (known && msg.sender == owner) revert SelfAudit();
                skipAgent = !known;
                if (skipAgent) emit UnknownAgentSkipped(result.agentId, modelHash);
                else if (!staked) staked = _hasPoolPower(result.agentId, epoch);
                previousAgent = result.agentId;
            }
            previousService = result.serviceHash;
            if (skipAgent) continue;
            _report(result.agentId, result.serviceHash, modelHash, result.verdict, epoch);
        }

        emit ModelAudited(modelHash, msg.sender, expectedEpoch, evidenceHash, evidenceUri, count);
        if (staked && epoch >= rewardsStartEpoch) _creditAudit(epoch, modelHash);
    }

    function serviceStatus(uint256 agentId, bytes32 serviceHash)
        external
        view
        override
        returns (ServiceStatus memory)
    {
        return _serviceStatus[agentId][serviceHash];
    }

    function agentStatus(uint256 agentId) public view override returns (AgentStatus memory) {
        return _agentStatusAt(agentId, emissionsGate.currentEpoch());
    }

    function isVerified(uint256 agentId) external view override returns (bool) {
        AgentStatus memory agent = agentStatus(agentId);
        return agent.verifiedCount > 0 && agent.diffCount == 0;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        AUDITOR REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Claims the caller's share of the verification bucket for finalized epochs.
    ///         Epochs with nothing to claim, or whose bucket has no budget yet, are skipped
    ///         and stay claimable.
    function claimAuditorRewards(uint256[] calldata epochs) external override returns (uint256 total) {
        IAntseedEmissionsGate gate = emissionsGate;
        uint256 current = gate.currentEpoch();
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            if (epoch >= current) revert EpochNotFinalized();
            uint256 amount = _pendingReward(gate, msg.sender, epoch);
            if (amount == 0) continue;
            auditorEpochClaimed[epoch][msg.sender] = true;
            total += amount;
            gate.claim(epoch, msg.sender, amount);
            emit AuditorRewardClaimed(epoch, msg.sender, amount);
        }
    }

    /// @notice Claimable reward for a finalized epoch; 0 for the current epoch, whose share can still change.
    function pendingAuditorReward(address auditor, uint256 epoch) external view override returns (uint256) {
        return _pendingReward(emissionsGate, auditor, epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Counts the caller's report and records the verdict once enough auditors report it.
    function _report(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict, uint256 epoch)
        private
    {
        uint256 round = reportRound[agentId][serviceHash];
        bytes32 key = keccak256(abi.encode(epoch, agentId, serviceHash, modelHash, round));
        Verdict previous = _reports[key][msg.sender];
        bool addsSupport = previous != verdict;
        if (addsSupport) {
            if (previous != Verdict.NONE) _reportCounts[key][previous] -= 1;
            _reportCounts[key][verdict] += 1;
            _reports[key][msg.sender] = verdict;
        }
        uint256 reports = _reportCounts[key][verdict];
        uint256 required = requiredReports[verdict];
        // Replacing a live DIFF takes as many auditors as giving one.
        if (verdict != Verdict.DIFF && _liveVerdict(_serviceStatus[agentId][serviceHash], epoch) == Verdict.DIFF) {
            uint256 diffRequired = requiredReports[Verdict.DIFF];
            if (diffRequired > required) required = diffRequired;
        }
        emit ServiceAudited(agentId, serviceHash, msg.sender, modelHash, verdict, round, reports, required);
        if (reports >= required && (addsSupport || required == 1)) {
            _applyResult(agentId, serviceHash, modelHash, verdict, epoch);
        }
    }

    function _applyResult(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict, uint256 epoch)
        private
    {
        ServiceStatus storage service = _serviceStatus[agentId][serviceHash];
        if (service.modelHash != modelHash) {
            if (service.modelHash != bytes32(0)) _resetService(agentId, serviceHash, service, epoch);
            service.modelHash = modelHash;
        }
        Verdict previous = _liveVerdict(service, epoch);
        if (service.verdict == verdict && service.epoch == epoch) return;
        _uncount(agentId, service);
        EpochCounts storage counts = _epochCounts[agentId][epoch];
        if (verdict == Verdict.SAME) counts.same += 1;
        else if (verdict == Verdict.DIFF) counts.diff += 1;
        service.verdict = verdict;
        service.epoch = uint64(epoch);
        if (previous == verdict) return;
        service.updatedAt = uint64(block.timestamp);
        _emitServiceChange(agentId, serviceHash, service, previous, epoch);
    }

    function _resetService(uint256 agentId, bytes32 serviceHash, ServiceStatus storage service, uint256 epoch)
        private
    {
        Verdict previous = _liveVerdict(service, epoch);
        _uncount(agentId, service);
        service.verdict = Verdict.NONE;
        service.epoch = 0;
        service.updatedAt = uint64(block.timestamp);
        if (previous != Verdict.NONE) _emitServiceChange(agentId, serviceHash, service, previous, epoch);
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
        if (stored == Verdict.NONE || !_isLive(service.epoch, epoch)) return Verdict.NONE;
        return stored;
    }

    function _isLive(uint256 givenEpoch, uint256 epoch) private view returns (bool) {
        return epoch < givenEpoch + validityEpochs;
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
        uint256 agentId, bytes32 serviceHash, ServiceStatus storage service, Verdict previous, uint256 epoch
    ) private {
        // A DIFF given or cleared starts a new report round: support from before it no longer counts.
        if (previous == Verdict.DIFF || service.verdict == Verdict.DIFF) reportRound[agentId][serviceHash] += 1;
        emit ServiceStatusChanged(agentId, serviceHash, service.modelHash, previous, service.verdict);
        AgentStatus memory agent = _agentStatusAt(agentId, epoch);
        emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
    }

    /// @dev One credit per audit, up to the per-model and per-auditor caps for the epoch.
    function _creditAudit(uint256 epoch, bytes32 modelHash) private {
        if (modelCredits[epoch][msg.sender][modelHash] >= maxCreditsPerModelPerEpoch) return;
        if (auditorEpochCredits[epoch][msg.sender] >= maxCreditsPerAuditorPerEpoch) return;
        modelCredits[epoch][msg.sender][modelHash] += 1;
        auditorEpochCredits[epoch][msg.sender] += 1;
        epochCredits[epoch] += 1;
        emit AuditCredited(epoch, msg.sender, modelHash);
    }

    /// @dev Failing pools never block an audit; they only withhold the credit.
    function _hasPoolPower(uint256 agentId, uint256 epoch) private view returns (bool) {
        try sellerPools.poolWeightAtEpoch(agentId, epoch) returns (uint256 weight) {
            return weight != 0;
        } catch {
            return false;
        }
    }

    function _pendingReward(IAntseedEmissionsGate gate, address auditor, uint256 epoch)
        private
        view
        returns (uint256)
    {
        uint256 credits = auditorEpochCredits[epoch][auditor];
        if (credits == 0 || auditorEpochClaimed[epoch][auditor] || epoch >= gate.currentEpoch()) return 0;
        uint256 budget = gate.controllerEpochBudget(address(this), epoch);
        uint256 reward = (budget * credits) / epochCredits[epoch];
        uint256 cap = (budget * maxAuditorShareBps) / BPS;
        return reward < cap ? reward : cap;
    }

    function _setSellerPools(address sellerPools_) private {
        if (sellerPools_.code.length == 0) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(sellerPools_);
        emit SellerPoolsSet(sellerPools_);
    }

    /// @dev `known` is false for agents the identity registry cannot resolve, e.g. burned ones.
    function _agentOwner(uint256 agentId) private view returns (bool known, address owner) {
        try IERC8004Registry(registry.identityRegistry()).ownerOf(agentId) returns (address agentOwner) {
            return (agentOwner != address(0), agentOwner);
        } catch {
            return (false, address(0));
        }
    }

    function _validateEvidenceUri(string calldata evidenceUri) private pure {
        uint256 length = bytes(evidenceUri).length;
        if (length == 0) return;
        if (length <= 7 || length > MAX_EVIDENCE_URI_BYTES || bytes7(bytes(evidenceUri)[:7]) != bytes7("ipfs://")) {
            revert InvalidEvidenceUri();
        }
    }
}
