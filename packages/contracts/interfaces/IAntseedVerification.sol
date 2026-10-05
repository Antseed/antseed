// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAntseedRegistry} from "./IAntseedRegistry.sol";

interface IAntseedVerification {
    enum Verdict {
        UNKNOWN,
        SAME,
        DIFF,
        UNDETERMINED
    }

    struct VerificationResult {
        uint256 agentId;
        bytes32 serviceHash;
        Verdict verdict;
    }

    struct VerificationBundle {
        address verifier;
        uint64 submittedAt;
        uint32 resultCount;
        string evidenceUri;
    }

    function registry() external view returns (IAntseedRegistry);
    function approvedVerifiers(address verifier) external view returns (bool);
    function setVerifier(address verifier, bool approved) external;

    /// @notice Records service-level verification results and anchors their off-chain evidence.
    /// @dev Reward, routing, points, and slashing decisions belong in separate consumer contracts.
    function submitVerificationBundle(
        bytes32 evidenceHash,
        string calldata evidenceUri,
        VerificationResult[] calldata results
    ) external;

    function isVerificationSubmitted(bytes32 evidenceHash) external view returns (bool);
    function verificationBundle(bytes32 evidenceHash) external view returns (VerificationBundle memory);
    function verificationResult(bytes32 evidenceHash, uint256 index)
        external
        view
        returns (VerificationResult memory);
}
