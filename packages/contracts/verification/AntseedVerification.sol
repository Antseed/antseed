// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedVerification} from "../interfaces/IAntseedVerification.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

/// @notice Records auditor-signed, verifier-submitted model-verification reports and
///         finalizes a per-agent score once `quorum` distinct auditors agree.
///
///         Score (formula version 1), over the services in the agreed results:
///           passed     = MODEL_MATCH and PRICE_MATCH set, UNDETERMINED clear
///           breadth    = log2(1 + min(distinct passed referenceIds, maxBreadth)) / log2(1 + maxBreadth)
///           integrity  = passed / audited
///           scoreBps   = BPS * breadth * integrity^4
///         Breadth rewards offering more distinct verified models; the steep integrity
///         term makes every failed service expensive, so honest padding cannot hide a
///         substituted flagship model.
contract AntseedVerification is IAntseedVerification, EIP712, Ownable2Step {
    uint256 public constant BPS = 10_000;
    uint256 public constant FORMULA_VERSION = 1;
    uint256 public constant MAX_SERVICES_PER_REPORT = 64;
    uint256 public constant MAX_EVIDENCE_URI_BYTES = 200;
    uint256 public constant MAX_BREADTH_LIMIT = 32;
    uint256 public constant MAX_QUORUM = 4;

    uint16 public constant SERVICE_MODEL_MATCH = 1;
    uint16 public constant SERVICE_PRICE_MATCH = 2;
    uint16 public constant SERVICE_UNDETERMINED = 4;
    uint16 private constant SERVICE_KNOWN_FLAGS = SERVICE_MODEL_MATCH | SERVICE_PRICE_MATCH | SERVICE_UNDETERMINED;
    uint16 private constant SERVICE_PASSED = SERVICE_MODEL_MATCH | SERVICE_PRICE_MATCH;

    bytes32 public constant AUDIT_REPORT_TYPEHASH = keccak256(
        "AuditReport(uint256 agentId,bytes32 metadataHash,bytes32 evidenceHash,bytes32 resultsHash,uint64 auditedAt)"
    );

    /// @dev round(log2(n) * 1e6) for n = 1..33, packed as 3-byte big-endian words.
    bytes private constant LOG2_MICRO_TABLE =
        hex"0000000f4240182f431e8480236e082771832ad63b2dc6c0305e8532b04834c96836b3c33876d83a187b3b9d4b3d09003e5ea73fa0c540d17841f28843057d440ba845062a45f60346dc1047b918488dc8495abb4a207d4adf8b4b98544c4b404cf8aa";

    struct PendingAttestation {
        bytes32 metadataHash;
        bytes32 resultsHash;
        uint64 openedAt;
        address[] auditors;
    }

    IAntseedRegistry public immutable override registry;

    mapping(address verifier => bool approved) public override approvedVerifiers;
    mapping(bytes32 reportDigest => bool used) public reportUsed;

    uint256 public quorum = 2;
    uint256 public maxBreadth = 8;
    uint64 public scoreValidity = 14 days;
    uint64 public refreshInterval = 7 days;
    uint64 public maxReportAge = 3 days;

    mapping(uint256 agentId => PendingAttestation pending) private _pending;
    mapping(uint256 agentId => AgentScore score) private _scores;

    event VerifierApprovalSet(address indexed verifier, bool approved);
    event QuorumSet(uint256 quorum);
    event MaxBreadthSet(uint256 maxBreadth);
    event TimingSet(uint64 scoreValidity, uint64 refreshInterval, uint64 maxReportAge);
    event ReportSubmitted(
        uint256 indexed agentId,
        address indexed auditor,
        address indexed verifier,
        bytes32 metadataHash,
        bytes32 evidenceHash,
        bytes32 resultsHash,
        string evidenceUri
    );
    event ServiceAudited(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        address indexed auditor,
        bytes32 referenceId,
        uint16 flags,
        bytes32 evidenceHash
    );
    event AgentScoreFinalized(
        uint256 indexed agentId, uint16 scoreBps, uint64 validUntil, bytes32 resultsHash, address[] auditors
    );

    error InvalidAddress();
    error InvalidValue();
    error NotApprovedVerifier();
    error InvalidEvidenceUri();
    error InvalidResults();
    error ResultsHashMismatch();
    error ReportAlreadyUsed();
    error StaleReport();
    error InvalidSignature();
    error UnknownAgent();
    error SelfAudit();
    error DuplicateAuditor();
    error RefreshTooSoon();

    modifier onlyApprovedVerifier() {
        if (!approvedVerifiers[msg.sender]) revert NotApprovedVerifier();
        _;
    }

    constructor(address registry_) EIP712("AntseedVerification", "1") Ownable(msg.sender) {
        if (registry_ == address(0) || registry_.code.length == 0) revert InvalidAddress();
        registry = IAntseedRegistry(registry_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setVerifier(address verifier, bool approved) external override onlyOwner {
        if (verifier == address(0)) revert InvalidAddress();
        approvedVerifiers[verifier] = approved;
        emit VerifierApprovalSet(verifier, approved);
    }

    function setQuorum(uint256 quorum_) external onlyOwner {
        if (quorum_ == 0 || quorum_ > MAX_QUORUM) revert InvalidValue();
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    function setMaxBreadth(uint256 maxBreadth_) external onlyOwner {
        if (maxBreadth_ == 0 || maxBreadth_ > MAX_BREADTH_LIMIT) revert InvalidValue();
        maxBreadth = maxBreadth_;
        emit MaxBreadthSet(maxBreadth_);
    }

    function setTiming(uint64 scoreValidity_, uint64 refreshInterval_, uint64 maxReportAge_) external onlyOwner {
        if (scoreValidity_ == 0 || refreshInterval_ > scoreValidity_ || maxReportAge_ == 0) revert InvalidValue();
        scoreValidity = scoreValidity_;
        refreshInterval = refreshInterval_;
        maxReportAge = maxReportAge_;
        emit TimingSet(scoreValidity_, refreshInterval_, maxReportAge_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        SUBMISSION
    // ═══════════════════════════════════════════════════════════════════

    function submitReport(
        AuditReport calldata report,
        ServiceResult[] calldata results,
        string calldata evidenceUri,
        bytes calldata auditorSignature
    ) external override onlyApprovedVerifier {
        if (report.metadataHash == bytes32(0) || report.evidenceHash == bytes32(0)) revert InvalidValue();
        if (report.auditedAt > block.timestamp || block.timestamp - report.auditedAt > maxReportAge) {
            revert StaleReport();
        }
        _validateEvidenceUri(evidenceUri);
        _validateResults(results);
        if (keccak256(abi.encode(results)) != report.resultsHash) revert ResultsHashMismatch();

        bytes32 digest = _hashTypedDataV4(_structHash(report));
        if (reportUsed[digest]) revert ReportAlreadyUsed();
        reportUsed[digest] = true;
        (address auditor, ECDSA.RecoverError recoverError,) = ECDSA.tryRecover(digest, auditorSignature);
        if (recoverError != ECDSA.RecoverError.NoError) revert InvalidSignature();

        address agentOwner = _resolveAgentOwner(report.agentId);
        if (auditor == agentOwner || msg.sender == agentOwner) revert SelfAudit();

        AgentScore memory current = _scores[report.agentId];
        if (current.finalizedAt != 0 && block.timestamp < uint256(current.finalizedAt) + refreshInterval) {
            revert RefreshTooSoon();
        }

        emit ReportSubmitted(
            report.agentId,
            auditor,
            msg.sender,
            report.metadataHash,
            report.evidenceHash,
            report.resultsHash,
            evidenceUri
        );
        for (uint256 i = 0; i < results.length; i++) {
            emit ServiceAudited(
                report.agentId,
                results[i].serviceHash,
                auditor,
                results[i].referenceId,
                results[i].flags,
                report.evidenceHash
            );
        }

        _recordAgreement(report, results, auditor);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function hashAuditReport(AuditReport calldata report) external view override returns (bytes32) {
        return _hashTypedDataV4(_structHash(report));
    }

    function agentScore(uint256 agentId) external view override returns (AgentScore memory) {
        return _scores[agentId];
    }

    function activeScoreBps(uint256 agentId) external view override returns (uint256) {
        AgentScore memory score = _scores[agentId];
        if (block.timestamp >= score.validUntil) return 0;
        return score.scoreBps;
    }

    function pendingAttestation(uint256 agentId)
        external
        view
        returns (bytes32 metadataHash, bytes32 resultsHash, uint64 openedAt, address[] memory auditors)
    {
        PendingAttestation storage pending = _pending[agentId];
        return (pending.metadataHash, pending.resultsHash, pending.openedAt, pending.auditors);
    }

    /// @notice Formula version 1 score for a result set, in basis points.
    function computeScoreBps(ServiceResult[] calldata results) public view returns (uint256) {
        uint256 count = results.length;
        if (count == 0) return 0;

        bytes32[] memory passedReferences = new bytes32[](count);
        uint256 passed;
        uint256 distinct;
        for (uint256 i = 0; i < count; i++) {
            uint16 flags = results[i].flags;
            if (flags & SERVICE_PASSED != SERVICE_PASSED || flags & SERVICE_UNDETERMINED != 0) continue;
            passed++;
            bytes32 referenceId = results[i].referenceId;
            bool seen;
            for (uint256 j = 0; j < distinct; j++) {
                if (passedReferences[j] == referenceId) {
                    seen = true;
                    break;
                }
            }
            if (!seen) passedReferences[distinct++] = referenceId;
        }
        if (passed == 0) return 0;

        uint256 cap = maxBreadth;
        uint256 breadth = distinct < cap ? distinct : cap;
        uint256 breadthBps = (_log2Micro(breadth + 1) * BPS) / _log2Micro(cap + 1);
        uint256 integrityBps = (passed * BPS) / count;
        return (breadthBps * integrityBps ** 4) / BPS ** 4;
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _recordAgreement(AuditReport calldata report, ServiceResult[] calldata results, address auditor)
        private
    {
        PendingAttestation storage pending = _pending[report.agentId];
        bool sameClaim = pending.auditors.length != 0 && pending.metadataHash == report.metadataHash
            && pending.resultsHash == report.resultsHash && block.timestamp - pending.openedAt <= maxReportAge;

        if (sameClaim) {
            for (uint256 i = 0; i < pending.auditors.length; i++) {
                if (pending.auditors[i] == auditor) revert DuplicateAuditor();
            }
        } else {
            // A disagreeing or expired claim restarts the quorum; the earlier auditors are not credited.
            delete _pending[report.agentId];
            pending.metadataHash = report.metadataHash;
            pending.resultsHash = report.resultsHash;
            pending.openedAt = uint64(block.timestamp);
        }
        pending.auditors.push(auditor);
        if (pending.auditors.length < quorum) return;

        address[] memory auditors = pending.auditors;
        delete _pending[report.agentId];

        uint16 scoreBps = uint16(computeScoreBps(results));
        uint64 validUntil = uint64(block.timestamp) + scoreValidity;
        _scores[report.agentId] =
            AgentScore({scoreBps: scoreBps, validUntil: validUntil, finalizedAt: uint64(block.timestamp)});
        emit AgentScoreFinalized(report.agentId, scoreBps, validUntil, report.resultsHash, auditors);
    }

    function _structHash(AuditReport calldata report) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AUDIT_REPORT_TYPEHASH,
                report.agentId,
                report.metadataHash,
                report.evidenceHash,
                report.resultsHash,
                report.auditedAt
            )
        );
    }

    function _resolveAgentOwner(uint256 agentId) private view returns (address) {
        if (agentId == 0) revert UnknownAgent();
        address identityRegistry = registry.identityRegistry();
        if (identityRegistry.code.length == 0) revert UnknownAgent();
        try IERC8004Registry(identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert UnknownAgent();
            return owner;
        } catch {
            revert UnknownAgent();
        }
    }

    /// @dev Results must be non-empty, bounded, and strictly ordered by serviceHash so that
    ///      independent auditors produce the same canonical resultsHash.
    function _validateResults(ServiceResult[] calldata results) private pure {
        uint256 count = results.length;
        if (count == 0 || count > MAX_SERVICES_PER_REPORT) revert InvalidResults();
        bytes32 previous;
        for (uint256 i = 0; i < count; i++) {
            ServiceResult calldata result = results[i];
            if (result.serviceHash <= previous || result.referenceId == bytes32(0)) revert InvalidResults();
            if (result.flags & ~SERVICE_KNOWN_FLAGS != 0) revert InvalidResults();
            previous = result.serviceHash;
        }
    }

    function _validateEvidenceUri(string calldata evidenceUri) private pure {
        uint256 length = bytes(evidenceUri).length;
        if (length == 0) return;
        if (length <= 7 || length > MAX_EVIDENCE_URI_BYTES || bytes7(bytes(evidenceUri)[:7]) != bytes7("ipfs://")) {
            revert InvalidEvidenceUri();
        }
    }

    function _log2Micro(uint256 n) private pure returns (uint256) {
        bytes memory table = LOG2_MICRO_TABLE;
        uint256 offset = (n - 1) * 3;
        return (uint256(uint8(table[offset])) << 16) | (uint256(uint8(table[offset + 1])) << 8)
            | uint256(uint8(table[offset + 2]));
    }
}
