// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAntseedEmissionsGate} from "./IAntseedEmissionsGate.sol";
import {IAntseedRegistry} from "./IAntseedRegistry.sol";
import {IAntseedSellerPools} from "./IAntseedSellerPools.sol";

/// @notice Model-verification audits submitted by approved auditors, one model per submission.
/// @dev Status is kept per (agent, service). SAME and DIFF set the service's verdict and record
///      the emissions epoch it was given in; the verdict counts while
///      `currentEpoch < epoch + validityEpochs`, and drops out on its own afterwards.
///      UNDETERMINED is recorded as the latest result for routing but leaves the verdict and its
///      epoch unchanged. A single approved auditor's SAME or DIFF sets the verdict; auditors
///      double-check DIFF results off-chain before submitting them. Auditors earn one credit per model audit, whatever the results, up to an
///      owner-set number per model and epoch (default 1), once the owner sets `rewardsStartEpoch`,
///      and are paid from the verification emission bucket in proportion to their credits, capped
///      at `maxAuditorShareBps` of the epoch's budget per auditor.
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
    /// @param verdict Latest definitive status (NONE, SAME, or DIFF). Counted in the agent's
    ///        status only while `currentEpoch < epoch + validityEpochs`.
    /// @param updatedAt When the live verdict last changed.
    /// @param lastResult Latest submitted result for this service, including UNDETERMINED.
    /// @param undeterminedStreak Consecutive UNDETERMINED results since the last SAME or DIFF.
    /// @param lastAuditedAt When `lastResult` was submitted.
    /// @param epoch Emissions epoch `verdict` was given in; every SAME or DIFF result moves it to
    ///        the current epoch. Zero while `verdict` is NONE.
    struct ServiceStatus {
        bytes32 modelHash;
        Verdict verdict;
        uint64 updatedAt;
        Verdict lastResult;
        uint16 undeterminedStreak;
        uint64 lastAuditedAt;
        uint64 epoch;
    }

    /// @param verifiedCount Services whose live verdict is SAME.
    /// @param diffCount Services whose live verdict is DIFF.
    struct AgentStatus {
        uint16 verifiedCount;
        uint16 diffCount;
    }

    function registry() external view returns (IAntseedRegistry);
    /// @notice Emissions gate pinned at deployment; every epoch the contract uses comes from it.
    function emissionsGate() external view returns (IAntseedEmissionsGate);
    /// @notice Epochs a SAME or DIFF verdict counts for, including the one it was given in.
    function validityEpochs() external view returns (uint8);
    function sellerPools() external view returns (IAntseedSellerPools);
    function approvedAuditors(address auditor) external view returns (bool);
    function setAuditor(address auditor, bool approved) external;

    /// @notice Records one auditor's results for every seller audited as `modelHash`.
    /// @dev Reverts unless the caller is an approved auditor, `expectedEpoch` is the current
    ///      epoch of the pinned emissions gate, `evidenceHash` is unused, and `results` is non-empty, bounded, and
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

    /// @notice True while the agent has a live SAME service and no live DIFF service.
    function isVerified(uint256 agentId) external view returns (bool);

    /// @notice Most of an epoch's verification budget one auditor can claim, in bps of 10,000.
    function maxAuditorShareBps() external view returns (uint16);
    /// @notice First epoch whose audits earn credits; `type(uint256).max` while rewards are off.
    function rewardsStartEpoch() external view returns (uint256);

    /// @notice Claims the caller's auditor share of the verification emission bucket.
    function claimAuditorRewards(uint256[] calldata epochs) external returns (uint256 total);
    function pendingAuditorReward(address auditor, uint256 epoch) external view returns (uint256);
}
