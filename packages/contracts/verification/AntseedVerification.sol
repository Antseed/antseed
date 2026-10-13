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
///         Status: each (agent, service) keeps its latest definitive verdict with its own expiry.
///         A SAME verifies that service until `now + validity`. A DIFF only lands once
///         `diffConfirmations` distinct auditors report it; until then the service keeps its status.
///         A SAME discards pending DIFF votes. Repeating the current verdict refreshes its expiry.
///         An UNDETERMINED result is recorded as the service's latest result (with a streak
///         counter for routing) but changes no verdict, vote, or expiry. Each agent counts its
///         SAME and DIFF services; once a verdict expires, anyone can call `expire` to drop it
///         from those counts.
///
///         Rewards: an auditor earns one credit per model audit, whatever the results, up to
///         `maxCreditsPerModelPerEpoch` per model and `maxCreditsPerAuditorPerEpoch` overall, provided
///         the audit covers at least one agent with staked pool power. Once the epoch is final an auditor claims
///         `budget * credits / totalCredits` from the verification emission bucket.
contract AntseedVerification is IAntseedVerification, Ownable2Step {
    uint256 public constant MAX_RESULTS_PER_AUDIT = 256;
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;

    IAntseedRegistry public immutable override registry;
    IAntseedSellerPools public override sellerPools;
    uint64 public validity = 14 days;
    uint16 public diffConfirmations = 1;
    uint32 public maxCreditsPerAuditorPerEpoch = 100;
    uint32 public maxCreditsPerModelPerEpoch = 1;

    mapping(address auditor => bool approved) public override approvedAuditors;
    mapping(bytes32 evidenceHash => bool used) public usedEvidence;

    mapping(uint256 agentId => AgentStatus status) private _agentStatus;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => ServiceStatus status)) private _serviceStatus;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => mapping(uint32 round => mapping(address auditor => bool))))
        private _diffVoted;

    mapping(uint256 epoch => uint256 credits) public epochCredits;
    mapping(uint256 epoch => mapping(address auditor => uint256 credits)) public auditorEpochCredits;
    mapping(uint256 epoch => mapping(address auditor => mapping(bytes32 modelHash => uint256 credits))) public
        modelCredits;
    mapping(uint256 epoch => mapping(address auditor => bool claimed)) public auditorEpochClaimed;

    event AuditorSet(address indexed auditor, bool approved);
    event SellerPoolsSet(address sellerPools);
    event ValiditySet(uint64 validity);
    event DiffConfirmationsSet(uint16 diffConfirmations);
    event MaxCreditsPerAuditorPerEpochSet(uint32 maxCredits);
    event MaxCreditsPerModelPerEpochSet(uint32 maxCredits);
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
    event ServiceExpired(uint256 indexed agentId, bytes32 indexed serviceHash, Verdict verdict);
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

    constructor(address registry_, address sellerPools_) Ownable(msg.sender) {
        if (registry_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
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

    function setValidity(uint64 validity_) external onlyOwner {
        if (validity_ == 0) revert InvalidValue();
        validity = validity_;
        emit ValiditySet(validity_);
    }

    /// @notice Distinct auditors that must report DIFF on a service before it is marked DIFF.
    function setDiffConfirmations(uint16 confirmations) external onlyOwner {
        if (confirmations == 0) revert InvalidValue();
        diffConfirmations = confirmations;
        emit DiffConfirmationsSet(confirmations);
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

    /// @notice Remediation for a wrong service result: resets it and discards pending DIFF votes.
    function clearServiceStatus(uint256 agentId, bytes32 serviceHash) external onlyOwner {
        _resetService(agentId, serviceHash, _serviceStatus[agentId][serviceHash]);
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

        (bool hasEpoch, uint256 epoch) = _currentEpoch();
        if (hasEpoch && epoch != expectedEpoch) revert EpochChanged();
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
            if (result.agentId != previousAgent) {
                if (msg.sender == _agentOwner(result.agentId)) revert SelfAudit();
                if (hasEpoch && !staked) staked = _hasPoolPower(result.agentId, epoch);
                previousAgent = result.agentId;
            }
            previousService = result.serviceHash;
            emit ServiceAudited(result.agentId, result.serviceHash, msg.sender, modelHash, result.verdict);
            _applyResult(result.agentId, result.serviceHash, modelHash, result.verdict);
        }

        emit ModelAudited(modelHash, msg.sender, expectedEpoch, evidenceHash, evidenceUri, count);
        if (staked) _creditAudit(epoch, modelHash);
    }

    function serviceStatus(uint256 agentId, bytes32 serviceHash)
        external
        view
        override
        returns (ServiceStatus memory)
    {
        return _serviceStatus[agentId][serviceHash];
    }

    function agentStatus(uint256 agentId) external view override returns (AgentStatus memory) {
        return _agentStatus[agentId];
    }

    function isVerified(uint256 agentId) external view override returns (bool) {
        AgentStatus memory agent = _agentStatus[agentId];
        return agent.verifiedCount > 0 && agent.diffCount == 0;
    }

    function expire(ServiceKey[] calldata services) external override returns (uint256 expired) {
        for (uint256 i = 0; i < services.length; i++) {
            if (_expireIfStale(services[i].agentId, services[i].serviceHash)) expired += 1;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        AUDITOR REWARDS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Claims the caller's share of the verification bucket for finalized epochs.
    ///         Epochs with nothing to claim, or whose bucket has no budget yet, are skipped
    ///         and stay claimable.
    function claimAuditorRewards(uint256[] calldata epochs) external override returns (uint256 total) {
        IAntseedEmissionsGate gate = _emissionsGate();
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
        return _pendingReward(_emissionsGate(), auditor, epoch);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _applyResult(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict) private {
        _expireIfStale(agentId, serviceHash);
        ServiceStatus storage service = _serviceStatus[agentId][serviceHash];
        if (service.modelHash != modelHash) {
            if (service.modelHash != bytes32(0)) _resetService(agentId, serviceHash, service);
            service.modelHash = modelHash;
        }
        service.lastResult = verdict;
        service.lastAuditedAt = uint64(block.timestamp);
        if (verdict == Verdict.UNDETERMINED) {
            if (service.undeterminedStreak < type(uint16).max) service.undeterminedStreak += 1;
            return;
        }
        service.undeterminedStreak = 0;
        AgentStatus storage agent = _agentStatus[agentId];

        if (verdict == Verdict.SAME) {
            Verdict previous = service.verdict;
            if (previous == Verdict.DIFF) agent.diffCount -= 1;
            if (previous != Verdict.SAME) agent.verifiedCount += 1;
            _discardDiffVotes(service);
            service.expiresAt = uint64(block.timestamp) + validity;
            if (previous == Verdict.SAME) return;
            service.verdict = Verdict.SAME;
            service.updatedAt = uint64(block.timestamp);
            _emitServiceChange(agentId, serviceHash, modelHash, previous, Verdict.SAME);
            emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
            return;
        }

        if (service.verdict == Verdict.DIFF) {
            service.expiresAt = uint64(block.timestamp) + validity;
            return;
        }
        mapping(address => bool) storage voted = _diffVoted[agentId][serviceHash][service.round];
        if (voted[msg.sender]) return;
        voted[msg.sender] = true;
        service.diffVotes += 1;
        if (service.diffVotes < diffConfirmations) return;

        Verdict before = service.verdict;
        if (before == Verdict.SAME) agent.verifiedCount -= 1;
        agent.diffCount += 1;
        _discardDiffVotes(service);
        service.verdict = Verdict.DIFF;
        service.updatedAt = uint64(block.timestamp);
        service.expiresAt = uint64(block.timestamp) + validity;
        _emitServiceChange(agentId, serviceHash, modelHash, before, Verdict.DIFF);
        emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
    }

    function _resetService(uint256 agentId, bytes32 serviceHash, ServiceStatus storage service) private {
        Verdict previous = service.verdict;
        AgentStatus storage agent = _agentStatus[agentId];
        if (previous == Verdict.SAME) agent.verifiedCount -= 1;
        if (previous == Verdict.DIFF) agent.diffCount -= 1;
        _discardDiffVotes(service);
        service.verdict = Verdict.NONE;
        service.lastResult = Verdict.NONE;
        service.undeterminedStreak = 0;
        service.updatedAt = uint64(block.timestamp);
        service.expiresAt = 0;
        if (previous != Verdict.NONE) {
            _emitServiceChange(agentId, serviceHash, service.modelHash, previous, Verdict.NONE);
            emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
        }
    }

    /// @dev Drops an expired SAME/DIFF verdict from the agent's counts and discards pending DIFF
    ///      votes. The latest result and model stay recorded.
    function _expireIfStale(uint256 agentId, bytes32 serviceHash) private returns (bool) {
        ServiceStatus storage service = _serviceStatus[agentId][serviceHash];
        Verdict previous = service.verdict;
        if (previous == Verdict.NONE || block.timestamp < service.expiresAt) return false;
        AgentStatus storage agent = _agentStatus[agentId];
        if (previous == Verdict.SAME) agent.verifiedCount -= 1;
        else agent.diffCount -= 1;
        _discardDiffVotes(service);
        service.verdict = Verdict.NONE;
        service.updatedAt = uint64(block.timestamp);
        service.expiresAt = 0;
        emit ServiceExpired(agentId, serviceHash, previous);
        _emitServiceChange(agentId, serviceHash, service.modelHash, previous, Verdict.NONE);
        emit AgentStatusChanged(agentId, agent.verifiedCount, agent.diffCount);
        return true;
    }

    function _discardDiffVotes(ServiceStatus storage service) private {
        if (service.diffVotes == 0) return;
        service.diffVotes = 0;
        service.round += 1;
    }

    function _emitServiceChange(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict previous, Verdict current)
        private
    {
        emit ServiceStatusChanged(agentId, serviceHash, modelHash, previous, current);
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

    /// @dev Without a live gate there is no epoch to check against and nothing is credited.
    function _currentEpoch() private view returns (bool ok, uint256 epoch) {
        address gate = _gateAddress();
        if (gate == address(0)) return (false, 0);
        try IAntseedEmissionsGate(gate).currentEpoch() returns (uint256 current) {
            return (true, current);
        } catch {
            return (false, 0);
        }
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
        return (gate.controllerEpochBudget(address(this), epoch) * credits) / epochCredits[epoch];
    }

    function _emissionsGate() private view returns (IAntseedEmissionsGate) {
        address gate = _gateAddress();
        if (gate == address(0)) revert InvalidAddress();
        return IAntseedEmissionsGate(gate);
    }

    /// @dev The emissions gate behind `registry.emissions()`. After M001 the registry points at
    ///      usage accounting, which exposes the gate as `emissionsGate()`; otherwise the registry
    ///      entry is the gate itself. Zero when there is no contract.
    function _gateAddress() private view returns (address) {
        address emissions = registry.emissions();
        if (emissions.code.length == 0) return address(0);
        try IEmissionsGateSource(emissions).emissionsGate() returns (address gate) {
            if (gate.code.length != 0) return gate;
        } catch {}
        return emissions;
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
