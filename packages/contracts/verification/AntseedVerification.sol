// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedSellerPools} from "../interfaces/IAntseedSellerPools.sol";
import {IAntseedVerification} from "../interfaces/IAntseedVerification.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

interface IEmissionsGateSource {
    function emissionsGate() external view returns (address);
}

/// @notice Records model-verification audits from approved auditors, one model per submission.
///
///         Status: each (agent, service) keeps its latest definitive verdict and the emissions
///         epoch it was given in. A verdict counts while `currentEpoch < epoch + validityEpochs`
///         (default 2: through the epoch after the audit). A SAME verifies that service and a
///         DIFF marks it as not serving the audited model; the latest SAME or DIFF wins and moves
///         the verdict to the current epoch. Auditors double-check a DIFF off-chain before
///         submitting it. An UNDETERMINED result is recorded as the service's latest result
///         (with a streak counter for routing) but changes no verdict or epoch.
///         Each agent keeps per-epoch SAME and DIFF counters, so its status sums only the last
///         `validityEpochs` epochs and older verdicts drop out without any cleanup.
///
///         Epochs come from the emissions gate pinned at deployment; audits revert without it.
///
///         Rewards: from `rewardsStartEpoch` on (off until the owner sets it), an auditor earns one
///         credit per model audit, whatever the results, up to `maxCreditsPerModelPerEpoch` per
///         model and `maxCreditsPerAuditorPerEpoch` overall, provided the audit covers at least one
///         agent with staked pool power. Once the epoch is final an auditor claims
///         `min(budget * credits / totalCredits, budget * maxAuditorShareBps / BPS)` from the
///         verification emission bucket, using the share cap in force when the epoch's first
///         credit was earned. Budget above the cap is never minted.
contract AntseedVerification is IAntseedVerification, Ownable2Step {
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
    uint32 public maxCreditsPerAuditorPerEpoch = 100;
    uint32 public maxCreditsPerModelPerEpoch = 1;
    /// @notice Most of an epoch's verification budget one auditor can claim, in bps (default 20%).
    uint16 public override maxAuditorShareBps = 2_000;
    /// @notice First epoch whose audits earn credits; `type(uint256).max` keeps rewards off.
    uint256 public override rewardsStartEpoch = type(uint256).max;

    mapping(address auditor => bool approved) public override approvedAuditors;
    mapping(bytes32 evidenceHash => bool used) public usedEvidence;

    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceStatus status)) private _serviceStatus;
    // Latest SAME/DIFF verdicts given in each epoch; a verdict moves out when the service gets a new one.
    mapping(uint256 agentId => mapping(uint256 epoch => EpochCounts counts)) private _epochCounts;

    mapping(uint256 epoch => uint256 credits) public epochCredits;
    mapping(uint256 epoch => mapping(address auditor => uint256 credits)) public auditorEpochCredits;
    mapping(uint256 epoch => mapping(address auditor => mapping(bytes32 modelHash => uint256 credits))) public
        modelCredits;
    mapping(uint256 epoch => mapping(address auditor => bool claimed)) public auditorEpochClaimed;
    /// @notice `maxAuditorShareBps` saved when the epoch earned its first credit; 0 before that.
    mapping(uint256 epoch => uint16 shareBps) public epochMaxAuditorShareBps;

    event AuditorSet(address indexed auditor, bool approved);
    event SellerPoolsSet(address sellerPools);
    event ValidityEpochsSet(uint8 validityEpochs);
    event MaxCreditsPerAuditorPerEpochSet(uint32 maxCredits);
    event MaxCreditsPerModelPerEpochSet(uint32 maxCredits);
    event MaxAuditorShareBpsSet(uint16 shareBps);
    event RewardsStartEpochSet(uint256 epoch);
    event ModelAudited(
        bytes32 indexed modelHash,
        address indexed auditor,
        uint256 indexed epoch,
        bytes32 evidenceHash,
        string evidenceUri,
        uint256 resultCount
    );
    event ServiceAudited(
        uint256 indexed agentId, bytes32 indexed serviceHash, address indexed auditor, bytes32 modelHash, Verdict verdict
    );
    event ServiceStatusChanged(
        uint256 indexed agentId, bytes32 indexed serviceHash, bytes32 modelHash, Verdict previous, Verdict current
    );
    event AgentStatusChanged(uint256 indexed agentId, uint16 verifiedCount, uint16 diffCount);
    event AuditCredited(uint256 indexed epoch, address indexed auditor, bytes32 indexed modelHash);
    event AuditorRewardClaimed(uint256 indexed epoch, address indexed auditor, uint256 amount);

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedAuditor();
    error InvalidEvidenceUri();
    error EvidenceAlreadyUsed();
    error InvalidResults();
    error UnknownAgent();
    error SelfAudit();
    error EpochChanged();
    error EpochNotFinalized();

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

    function setMaxCreditsPerAuditorPerEpoch(uint32 maxCredits) external onlyOwner {
        if (maxCredits == 0) revert InvalidValue();
        maxCreditsPerAuditorPerEpoch = maxCredits;
        emit MaxCreditsPerAuditorPerEpochSet(maxCredits);
    }

    /// @notice Credited audits of the same model per auditor and epoch (default 1).
    function setMaxCreditsPerModelPerEpoch(uint32 maxCredits) external onlyOwner {
        if (maxCredits == 0) revert InvalidValue();
        maxCreditsPerModelPerEpoch = maxCredits;
        emit MaxCreditsPerModelPerEpochSet(maxCredits);
    }

    /// @notice Caps one auditor's claim per epoch so a compromised auditor cannot take the whole
    ///         bucket. Applies to epochs that earn their first credit after the change.
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

    /// @notice Remediation for a wrong service result: resets its verdict and latest result.
    function clearServiceStatus(uint256 agentId, bytes32 serviceHash) external onlyOwner {
        ServiceStatus storage service = _serviceStatus[agentId][serviceHash];
        _resetService(agentId, serviceHash, service, emissionsGate.currentEpoch());
        service.lastResult = Verdict.NONE;
        service.undeterminedStreak = 0;
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
        if (usedEvidence[evidenceHash]) revert EvidenceAlreadyUsed();
        _validateEvidenceUri(evidenceUri);
        uint256 count = results.length;
        if (count == 0 || count > MAX_RESULTS_PER_AUDIT) revert InvalidResults();

        uint256 epoch = emissionsGate.currentEpoch();
        if (epoch != expectedEpoch) revert EpochChanged();
        usedEvidence[evidenceHash] = true;

        bool staked;
        uint256 previousAgent;
        bytes32 previousService;
        for (uint256 i = 0; i < count; i++) {
            ServiceResult calldata result = results[i];
            if (
                result.serviceHash == bytes32(0) || result.verdict == Verdict.NONE || result.agentId < previousAgent
                    || (result.agentId == previousAgent && result.serviceHash <= previousService)
            ) revert InvalidResults();
            if (i == 0 || result.agentId != previousAgent) {
                if (msg.sender == _agentOwner(result.agentId)) revert SelfAudit();
                if (!staked) staked = _hasPoolPower(result.agentId, epoch);
                previousAgent = result.agentId;
            }
            previousService = result.serviceHash;
            emit ServiceAudited(result.agentId, result.serviceHash, msg.sender, modelHash, result.verdict);
            _applyResult(result.agentId, result.serviceHash, modelHash, result.verdict, epoch);
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

    function pendingAuditorReward(address auditor, uint256 epoch) external view override returns (uint256) {
        return _pendingReward(emissionsGate, auditor, epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _applyResult(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict, uint256 epoch)
        private
    {
        ServiceStatus storage service = _serviceStatus[agentId][serviceHash];
        if (service.modelHash != modelHash) {
            if (service.modelHash != bytes32(0)) _resetService(agentId, serviceHash, service, epoch);
            service.modelHash = modelHash;
            service.undeterminedStreak = 0;
        }
        service.lastResult = verdict;
        service.lastAuditedAt = uint64(block.timestamp);
        if (verdict == Verdict.UNDETERMINED) {
            if (service.undeterminedStreak < type(uint16).max) service.undeterminedStreak += 1;
            return;
        }
        service.undeterminedStreak = 0;

        Verdict previous = _liveVerdict(service, epoch);
        if (service.verdict == verdict && service.epoch == epoch) return;
        _uncount(agentId, service);
        EpochCounts storage counts = _epochCounts[agentId][epoch];
        if (verdict == Verdict.SAME) counts.same += 1;
        else counts.diff += 1;
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
        else counts.diff -= 1;
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
        emit ServiceStatusChanged(agentId, serviceHash, service.modelHash, previous, service.verdict);
        AgentStatus memory agent = _agentStatusAt(agentId, epoch);
        emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
    }

    /// @dev One credit per audit, up to the per-model and per-auditor caps for the epoch.
    function _creditAudit(uint256 epoch, bytes32 modelHash) private {
        if (modelCredits[epoch][msg.sender][modelHash] >= maxCreditsPerModelPerEpoch) return;
        if (auditorEpochCredits[epoch][msg.sender] >= maxCreditsPerAuditorPerEpoch) return;
        if (epochCredits[epoch] == 0) epochMaxAuditorShareBps[epoch] = maxAuditorShareBps;
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
        if (credits == 0 || auditorEpochClaimed[epoch][auditor]) return 0;
        uint256 budget = gate.controllerEpochBudget(address(this), epoch);
        uint256 reward = (budget * credits) / epochCredits[epoch];
        uint256 cap = (budget * epochMaxAuditorShareBps[epoch]) / BPS;
        return reward < cap ? reward : cap;
    }

    function _setSellerPools(address sellerPools_) private {
        if (sellerPools_.code.length == 0) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(sellerPools_);
        emit SellerPoolsSet(sellerPools_);
    }

    function _agentOwner(uint256 agentId) private view returns (address) {
        if (agentId == 0) revert UnknownAgent();
        try IERC8004Registry(registry.identityRegistry()).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent();
            return owner;
        } catch {
            revert UnknownAgent();
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
