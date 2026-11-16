// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedEmissionsGate } from "./IAntseedEmissionsGate.sol";

/// @notice The verification results layer: a verdict registry and the holder of the verification
///         emission bucket. It is the one place a seller service's verification verdict lives,
///         whatever audit produced it. Readers (points policies, the node, dashboards) read this
///         contract only and never need to know which audits exist.
///
///         Audits are owner-approved contracts, one per verification method. Each one brings its
///         own admission rule and consensus (e.g. `AntseedKbfAudits`: an auditor set and report
///         confirmations) and decides what earns its auditors a credit. This contract does not
///         judge what an audit records: the latest record from any approved audit is the
///         service's verdict.
/// @dev Verdicts: status is kept per (agent, service). The latest recorded result (SAME, DIFF, or
///      UNDETERMINED) is the service's verdict, with the emissions epoch it was given in, the epoch
///      it stops counting in (`validUntilEpoch`, chosen by the audit) and the audit that gave it; it
///      is live while `currentEpoch < validUntilEpoch` and drops out on its own afterwards. Only
///      SAME and DIFF count in the agent's status.
///
///      Rewards: each audit has a share of the bucket this contract controls on the emissions
///      gate, its own rewards start epoch and its own safety caps. Audits grant credits with
///      `credit`; once an epoch is final an auditor claims it with `claimAuditorReward`, one audit
///      and epoch per call: `gross = auditBudget * credits / auditCredits`, of which it receives at
///      most `auditBudget * maxAuditorShareBps / BPS`; the rest goes to the emissions reserve in
///      the same claim. Budget nobody can claim (an epoch without credits, a share given to no
///      audit, a reward never claimed) stays unminted: the bucket is fixed, so there is no dynamic
///      remainder to sweep. Audit shares are checkpointed per epoch: a change applies from the next
///      epoch, so a running or finished epoch's split never moves.
interface IAntseedVerificationResults {
    enum Verdict {
        NONE,
        SAME,
        DIFF,
        UNDETERMINED
    }

    /// @param modelHash Model the service was last recorded as (keccak256 of the model id).
    /// @param verdict Latest recorded result. Live only while `currentEpoch < validUntilEpoch`;
    ///        only SAME and DIFF count in the agent's status.
    /// @param updatedAt When the live verdict last changed.
    /// @param epoch Emissions epoch `verdict` was given in; every recorded result moves it to the
    ///        current epoch. Zero while `verdict` is NONE.
    /// @param audit The audit contract that recorded `verdict`; zero while `verdict` is NONE.
    /// @param validUntilEpoch The first epoch `verdict` no longer counts in, set by the audit that
    ///        recorded it. Zero while `verdict` is NONE.
    struct ServiceStatus {
        bytes32 modelHash;
        Verdict verdict;
        uint64 updatedAt;
        uint64 epoch;
        address audit;
        uint64 validUntilEpoch;
    }

    /// @param verifiedCount Services whose live verdict is SAME.
    /// @param diffCount Services whose live verdict is DIFF.
    struct AgentStatus {
        uint16 verifiedCount;
        uint16 diffCount;
    }

    // ───────────────────────────── wiring ─────────────────────────────

    /// @notice Emissions gate pinned at deployment; every epoch in this contract and its audits comes from it.
    function emissionsGate() external view returns (IAntseedEmissionsGate);
    /// @notice The current epoch of the pinned gate. Audits should use this, never the gate directly.
    function currentEpoch() external view returns (uint256);
    /// @notice True for audit contracts allowed to `record` and `credit`.
    function isAudit(address audit) external view returns (bool);

    // ───────────────────────────── verdicts ───────────────────────────

    /// @notice Records a verdict for (agentId, serviceHash) under `modelHash` in the current epoch,
    ///         replacing whatever was there; it counts until `validUntilEpoch` (exclusive). Audits
    ///         only. Reverts on a NONE verdict, a zero service or model hash, or a `validUntilEpoch`
    ///         not after the current epoch or more than `MAX_VERDICT_EPOCHS` after it. The audit is
    ///         responsible for everything else (which agents exist, how many auditors had to agree,
    ///         how long its verdicts count, where the evidence is: an audit emits its own evidence events).
    function record(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict, uint256 validUntilEpoch)
        external;

    function serviceStatus(uint256 agentId, bytes32 serviceHash) external view returns (ServiceStatus memory);
    /// @notice Times the owner cleared this service with `clearServiceStatuses`. Audits fold it into
    ///         their report rounds so reports made before a clear stop counting.
    function serviceClears(uint256 agentId, bytes32 serviceHash) external view returns (uint256);
    /// @notice Times the service's live verdict moved into or out of DIFF, by any audit or an owner
    ///         clear. Audits fold it into their report rounds so support given before a DIFF was
    ///         recorded can't clear it, and support given before it was cleared can't restore it.
    function diffChanges(uint256 agentId, bytes32 serviceHash) external view returns (uint256);
    /// @notice The service's verdict if it is live in the current epoch, else NONE.
    function liveVerdict(uint256 agentId, bytes32 serviceHash) external view returns (Verdict);
    function agentStatus(uint256 agentId) external view returns (AgentStatus memory);
    /// @notice True while the agent has a live SAME service and no live DIFF service.
    function isVerified(uint256 agentId) external view returns (bool);

    // ───────────────────────────── rewards ────────────────────────────

    /// @notice The audit's latest share of the bucket's epoch budget, in bps of 10,000: what applies
    ///         from the next epoch on. Shares sum to at most 10,000.
    function auditShareBps(address audit) external view returns (uint16);
    /// @notice The audit's share for `epoch`.
    function auditShareBpsAt(address audit, uint256 epoch) external view returns (uint16);
    /// @notice First epoch whose credits from `audit` count; `type(uint64).max` while its rewards are off.
    function rewardsStartEpoch(address audit) external view returns (uint64);
    /// @notice Most of `audit`'s epoch budget one auditor can receive, in bps of 10,000.
    function maxAuditorShareBps(address audit) external view returns (uint16);
    /// @notice Safety limit: credits one auditor can earn from `audit` per epoch.
    function maxCreditsPerAuditorPerEpoch(address audit) external view returns (uint32);
    /// @notice What `audit`'s auditors share for `epoch`: the bucket's budget times the audit's
    ///         share for that epoch.
    function auditBudget(address audit, uint256 epoch) external view returns (uint256);

    function epochCredits(address audit, uint256 epoch) external view returns (uint256);
    function auditorEpochCredits(address audit, uint256 epoch, address auditor) external view returns (uint256);
    function auditorEpochClaimed(address audit, uint256 epoch, address auditor) external view returns (bool);

    /// @notice Grants `credits` to `auditor` for the current epoch, from the calling audit. Audits
    ///         only. Nothing is credited before the audit's rewards start epoch or in an epoch the audit has
    ///         no share of; the amount is
    ///         clamped to the audit's per-auditor cap. Returns what was actually credited.
    function credit(address auditor, uint256 credits) external returns (uint256 credited);

    /// @notice Claims the caller's reward from `audit` for one finalized epoch; the part above the
    ///         per-auditor cap goes to the emissions reserve. Reverts when there is nothing to claim.
    function claimAuditorReward(address audit, uint256 epoch) external;
    /// @notice What the auditor would receive from `audit` for a finalized epoch; 0 for the current
    ///         epoch, an epoch already claimed, or one without credits.
    function pendingAuditorReward(address audit, address auditor, uint256 epoch) external view returns (uint256);
}
