// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedSellerPools} from "../interfaces/IAntseedSellerPools.sol";
import {IAntseedVerification} from "../interfaces/IAntseedVerification.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

/// @notice Records model-verification audits from approved auditors.
///
///         Status: an audit that passes every service verifies the agent for `validity`;
///         an audit with any failed service clears it immediately.
///
///         Rewards: the first audit of an agent in an epoch earns the auditor that agent's
///         pool power for the epoch, whatever the outcome. Once the epoch is final an auditor
///         claims `budget * power / totalPower` from the verification emission bucket. Agents
///         without staked power earn nothing, so auditing fake agents pays nothing.
contract AntseedVerification is IAntseedVerification, Ownable2Step {
    uint256 public constant MAX_SERVICES_PER_AUDIT = 64;
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;

    IAntseedRegistry public immutable override registry;
    IAntseedSellerPools public override sellerPools;
    uint64 public validity = 14 days;

    mapping(address auditor => bool approved) public override approvedAuditors;
    mapping(uint256 agentId => uint64 until) public override verifiedUntil;
    /// @dev epoch + 1 of the agent's last rewarded audit, so 0 means never rewarded.
    mapping(uint256 agentId => uint256 epochPlusOne) public lastRewardedEpoch;
    mapping(uint256 epoch => uint256 power) public epochAuditPower;
    mapping(uint256 epoch => mapping(address auditor => uint256 power)) public auditorEpochPower;
    mapping(uint256 epoch => mapping(address auditor => bool claimed)) public auditorEpochClaimed;

    event AuditorSet(address indexed auditor, bool approved);
    event SellerPoolsSet(address sellerPools);
    event ValiditySet(uint64 validity);
    event AgentAudited(
        uint256 indexed agentId, address indexed auditor, bool passed, uint64 verifiedUntil, bytes32 evidenceHash, string evidenceUri
    );
    event ServiceAudited(uint256 indexed agentId, bytes32 indexed serviceHash, bytes32 modelHash, bool passed);
    event VerificationCleared(uint256 indexed agentId);
    event AuditPowerCredited(uint256 indexed epoch, address indexed auditor, uint256 indexed agentId, uint256 power);
    event AuditorRewardClaimed(uint256 indexed epoch, address indexed auditor, uint256 amount);

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedAuditor();
    error InvalidEvidenceUri();
    error InvalidResults();
    error UnknownAgent();
    error SelfAudit();
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

    /// @notice Remediation for an audit later shown to be wrong, e.g. from a revoked auditor.
    function clearVerification(uint256 agentId) external onlyOwner {
        verifiedUntil[agentId] = 0;
        emit VerificationCleared(agentId);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        AUDITS
    // ═══════════════════════════════════════════════════════════════════

    function submitAudit(
        uint256 agentId,
        ServiceResult[] calldata results,
        bytes32 evidenceHash,
        string calldata evidenceUri
    ) external override {
        if (!approvedAuditors[msg.sender]) revert NotApprovedAuditor();
        if (evidenceHash == bytes32(0)) revert InvalidValue();
        if (msg.sender == _agentOwner(agentId)) revert SelfAudit();
        _validateEvidenceUri(evidenceUri);
        bool passed = _recordResults(agentId, results);

        uint64 until = passed ? uint64(block.timestamp) + validity : 0;
        verifiedUntil[agentId] = until;
        emit AgentAudited(agentId, msg.sender, passed, until, evidenceHash, evidenceUri);

        _creditAuditPower(agentId);
    }

    function isVerified(uint256 agentId) external view override returns (bool) {
        return block.timestamp < verifiedUntil[agentId];
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

    /// @dev Crediting must never block an audit: without a live gate or pools nothing is credited.
    function _creditAuditPower(uint256 agentId) private {
        address gate = registry.emissions();
        if (gate.code.length == 0) return;
        uint256 epoch;
        try IAntseedEmissionsGate(gate).currentEpoch() returns (uint256 current) {
            epoch = current;
        } catch {
            return;
        }
        if (lastRewardedEpoch[agentId] == epoch + 1) return;
        uint256 power;
        try sellerPools.poolWeightAtEpoch(agentId, epoch) returns (uint256 weight) {
            power = weight;
        } catch {
            return;
        }
        if (power == 0) return;
        lastRewardedEpoch[agentId] = epoch + 1;
        epochAuditPower[epoch] += power;
        auditorEpochPower[epoch][msg.sender] += power;
        emit AuditPowerCredited(epoch, msg.sender, agentId, power);
    }

    function _pendingReward(IAntseedEmissionsGate gate, address auditor, uint256 epoch)
        private
        view
        returns (uint256)
    {
        uint256 power = auditorEpochPower[epoch][auditor];
        if (power == 0 || auditorEpochClaimed[epoch][auditor]) return 0;
        return (gate.controllerEpochBudget(address(this), epoch) * power) / epochAuditPower[epoch];
    }

    function _emissionsGate() private view returns (IAntseedEmissionsGate) {
        address gate = registry.emissions();
        if (gate.code.length == 0) revert InvalidAddress();
        return IAntseedEmissionsGate(gate);
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

    /// @dev Results must be non-empty, bounded, and strictly ordered by serviceHash (no duplicates).
    ///      Emits one ServiceAudited per result and returns whether every service passed.
    function _recordResults(uint256 agentId, ServiceResult[] calldata results) private returns (bool allPassed) {
        uint256 count = results.length;
        if (count == 0 || count > MAX_SERVICES_PER_AUDIT) revert InvalidResults();
        allPassed = true;
        bytes32 previous;
        for (uint256 i = 0; i < count; i++) {
            ServiceResult calldata result = results[i];
            if (result.serviceHash <= previous || result.modelHash == bytes32(0)) revert InvalidResults();
            previous = result.serviceHash;
            allPassed = allPassed && result.passed;
            emit ServiceAudited(agentId, result.serviceHash, result.modelHash, result.passed);
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
