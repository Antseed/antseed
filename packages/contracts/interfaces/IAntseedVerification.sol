// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAntseedRegistry} from "./IAntseedRegistry.sol";
import {IAntseedSellerPools} from "./IAntseedSellerPools.sol";

/// @notice Model-verification audits submitted by approved auditors, one model per submission.
/// @dev Status is kept per (agent, service). SAME and DIFF set the service's verdict; UNDETERMINED
///      is recorded as the latest result for routing but leaves the verdict unchanged. Auditors
///      earn one credit per audited model per epoch, whatever the results, and are paid from the
///      verification emission bucket in proportion to their credits.
interface IAntseedVerification {
    enum Verdict {
        NONE,
        SAME,
        DIFF,
        UNDETERMINED
    }

    /// @param agentId Seller agent the result is for.
    /// @param serviceHash keccak256 of the lowercased service name in the seller's signed metadata.
    /// @param verdict SAME when the service answered as the audited model, DIFF when it did not,
    ///        UNDETERMINED when the audit ran but could not decide.
    struct ServiceResult {
        uint256 agentId;
        bytes32 serviceHash;
        Verdict verdict;
    }

    /// @param modelHash Model the service was last audited as.
    /// @param verdict Current definitive status (NONE, SAME, or DIFF). A DIFF only lands once
    ///        `diffConfirmations` auditors agree.
    /// @param diffVotes Distinct auditors that reported DIFF since the service last changed.
    /// @param round Bumped whenever pending DIFF votes are discarded.
    /// @param updatedAt When `verdict` last changed.
    /// @param lastResult Latest submitted result for this service, including UNDETERMINED.
    /// @param undeterminedStreak Consecutive UNDETERMINED results since the last SAME or DIFF.
    /// @param lastAuditedAt When `lastResult` was submitted.
    struct ServiceStatus {
        bytes32 modelHash;
        Verdict verdict;
        uint16 diffVotes;
        uint32 round;
        uint64 updatedAt;
        Verdict lastResult;
        uint16 undeterminedStreak;
        uint64 lastAuditedAt;
    }

    /// @param verifiedCount Services whose current status is SAME.
    /// @param diffCount Services whose current status is DIFF.
    /// @param verifiedUntil Expiry of the agent's verification, refreshed by every SAME result.
    struct AgentStatus {
        uint16 verifiedCount;
        uint16 diffCount;
        uint64 verifiedUntil;
    }

    function registry() external view returns (IAntseedRegistry);
    function sellerPools() external view returns (IAntseedSellerPools);
    function approvedAuditors(address auditor) external view returns (bool);
    function setAuditor(address auditor, bool approved) external;

    /// @notice Records one auditor's results for every seller audited as `modelHash`.
    /// @dev Reverts unless the caller is an approved auditor, `expectedEpoch` is the current
    ///      emissions epoch, `evidenceHash` is unused, and `results` is non-empty, bounded, and
    ///      strictly ordered by (agentId, serviceHash).
    function submitModelAudit(
        uint256 expectedEpoch,
        bytes32 modelHash,
        bytes32 evidenceHash,
        string calldata evidenceUri,
        ServiceResult[] calldata results
    ) external;

    function serviceStatus(uint256 agentId, bytes32 serviceHash) external view returns (ServiceStatus memory);
    function agentStatus(uint256 agentId) external view returns (AgentStatus memory);

    /// @notice Timestamp until which `agentId`'s SAME results count; 0 when never verified or cleared.
    function verifiedUntil(uint256 agentId) external view returns (uint64);

    /// @notice True while the agent has an unexpired SAME result and no service with a DIFF status.
    function isVerified(uint256 agentId) external view returns (bool);

    /// @notice Claims the caller's auditor share of the verification emission bucket.
    function claimAuditorRewards(uint256[] calldata epochs) external returns (uint256 total);
    function pendingAuditorReward(address auditor, uint256 epoch) external view returns (uint256);
}
