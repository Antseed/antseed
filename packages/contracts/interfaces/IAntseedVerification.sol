// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAntseedRegistry} from "./IAntseedRegistry.sol";

/// @notice Service-level model-verification attestations.
/// @dev Auditors generate and sign reports; approved verifiers check the off-chain
///      evidence and submit them. A quorum of distinct auditors agreeing on the same
///      per-service results finalizes an agent score that points policies can read.
interface IAntseedVerification {
    /// @param serviceHash keccak256 of the service name in the seller's signed metadata.
    /// @param referenceId KBF reference the service was audited against; distinct ids count toward breadth.
    /// @param flags Bitmask of SERVICE_MODEL_MATCH, SERVICE_PRICE_MATCH and SERVICE_UNDETERMINED.
    struct ServiceResult {
        bytes32 serviceHash;
        bytes32 referenceId;
        uint16 flags;
    }

    /// @notice What an auditor signs (EIP-712). `resultsHash` is keccak256(abi.encode(results)).
    struct AuditReport {
        uint256 agentId;
        bytes32 metadataHash;
        bytes32 evidenceHash;
        bytes32 resultsHash;
        uint64 auditedAt;
    }

    struct AgentScore {
        uint16 scoreBps;
        uint64 validUntil;
        uint64 finalizedAt;
    }

    function registry() external view returns (IAntseedRegistry);
    function approvedVerifiers(address verifier) external view returns (bool);
    function setVerifier(address verifier, bool approved) external;

    /// @notice Submits one auditor-signed report. Reverts unless the caller is an approved verifier.
    function submitReport(
        AuditReport calldata report,
        ServiceResult[] calldata results,
        string calldata evidenceUri,
        bytes calldata auditorSignature
    ) external;

    function hashAuditReport(AuditReport calldata report) external view returns (bytes32);
    function agentScore(uint256 agentId) external view returns (AgentScore memory);

    /// @notice Current score in basis points, or 0 when none has been finalized or it expired.
    function activeScoreBps(uint256 agentId) external view returns (uint256);
}
