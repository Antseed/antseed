// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAntseedRegistry} from "./IAntseedRegistry.sol";
import {IAntseedSellerPools} from "./IAntseedSellerPools.sol";

/// @notice Model-verification audits submitted by approved auditors, one model per submission.
/// @dev Status is kept per (agent, service). SAME and DIFF set the service's verdict until
///      `expiresAt`; UNDETERMINED is recorded as the latest result for routing but leaves the
///      verdict unchanged. Pending DIFF votes have a fixed confirmation window starting with
///      the first vote; expired votes are discarded before the next audit. Once expired,
///      anyone may call `expire` to clean up its stored verdict; agent counts already
///      exclude expired verdicts. Auditors
///      earn one credit per model audit, whatever the results, up to an owner-set number per model
///      and epoch (default 1), and are paid from the
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
    ///        `diffConfirmations` auditors agree within the confirmation window. Counted in
    ///        the agent's status only while unexpired.
    /// @param diffVotes Distinct auditors in the current pending round. Expired votes stay
    ///        recorded until the next audit discards them.
    /// @param round Bumped whenever pending DIFF votes are discarded.
    /// @param updatedAt When `verdict` last changed.
    /// @param lastResult Latest submitted result for this service, including UNDETERMINED.
    /// @param undeterminedStreak Consecutive UNDETERMINED results since the last SAME or DIFF.
    /// @param lastAuditedAt When `lastResult` was submitted.
    /// @param expiresAt When `verdict` stops applying; refreshed by every SAME or DIFF result.
    struct ServiceStatus {
        bytes32 modelHash;
        Verdict verdict;
        uint16 diffVotes;
        uint32 round;
        uint64 updatedAt;
        Verdict lastResult;
        uint16 undeterminedStreak;
        uint64 lastAuditedAt;
        uint64 expiresAt;
    }

    struct ServiceKey {
        uint256 agentId;
        bytes32 serviceHash;
    }

    /// @param verifiedCount Unexpired services whose current status is SAME.
    /// @param diffCount Unexpired services whose current status is DIFF.
    /// @dev Expired verdicts never contribute, regardless of whether `expire` has been called.
    struct AgentStatus {
        uint16 verifiedCount;
        uint16 diffCount;
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

    /// @notice True while the agent has an unexpired SAME service and no unexpired DIFF service.
    function isVerified(uint256 agentId) external view returns (bool);

    /// @notice Cleans up stored expired SAME/DIFF verdicts, which are already excluded from
    ///         agent counts. Callable by anyone; unexpired or already-cleared services are skipped.
    /// @return expired Number of services expired by this call.
    function expire(ServiceKey[] calldata services) external returns (uint256 expired);

    /// @notice Claims the caller's auditor share of the verification emission bucket.
    function claimAuditorRewards(uint256[] calldata epochs) external returns (uint256 total);
    function pendingAuditorReward(address auditor, uint256 epoch) external view returns (uint256);
}
