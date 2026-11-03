// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedEmissionsGate } from "./IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "./IAntseedRegistry.sol";

/// @notice The verification results layer: a verdict registry and the holder of the verification
///         emission bucket. It is the one place a seller service's verification verdict lives,
///         whatever method produced it. Readers (points policies, the node, dashboards) read this
///         contract only and never need to know which sources exist.
///
///         Sources are owner-approved contracts. Each one brings its own admission rule and
///         consensus (e.g. `AntseedKbfAudits`: an auditor set and report confirmations) and decides
///         what earns its verifiers a credit. This contract does not judge what a source records:
///         the latest record from any approved source is the service's verdict.
/// @dev Verdicts: status is kept per (agent, service). The latest recorded result (SAME, DIFF, or
///      UNDETERMINED) is the service's verdict, with the emissions epoch it was given in and the
///      source that gave it; it is live while `currentEpoch < epoch + validityEpochs` and drops out
///      on its own afterwards. Only SAME and DIFF count in the agent's status.
///
///      Rewards: each source has a share of the bucket this contract controls on the emissions
///      gate, its own rewards start epoch and its own safety caps. Sources grant credits with
///      `credit`; once an epoch is final a verifier claims, per source,
///      `gross = sourceBudget * credits / sourceCredits`, receiving at most
///      `sourceBudget * maxAuditorShareBps / BPS`; anything above that cap goes to the emissions
///      reserve in the same claim. Budget no verifier can ever claim (sources with no credits that
///      epoch, any part of the bucket assigned to no source, and what voided credits free up) is
///      swept through the gate's remainder route (burn, then reserve) by anyone with
///      `settleEpochRemainder`. Source shares are checkpointed per epoch: a change applies from the
///      next epoch, so a running or finished epoch's split never moves.
interface IAntseedVerificationResults {
    enum Verdict {
        NONE,
        SAME,
        DIFF,
        UNDETERMINED
    }

    /// @param modelHash Model the service was last recorded as (keccak256 of the model id).
    /// @param verdict Latest recorded result. Live only while `currentEpoch < epoch + validityEpochs`;
    ///        only SAME and DIFF count in the agent's status.
    /// @param updatedAt When the live verdict last changed.
    /// @param epoch Emissions epoch `verdict` was given in; every recorded result moves it to the
    ///        current epoch. Zero while `verdict` is NONE.
    /// @param source The source contract that recorded `verdict`; zero while `verdict` is NONE.
    struct ServiceStatus {
        bytes32 modelHash;
        Verdict verdict;
        uint64 updatedAt;
        uint64 epoch;
        address source;
    }

    /// @param verifiedCount Services whose live verdict is SAME.
    /// @param diffCount Services whose live verdict is DIFF.
    struct AgentStatus {
        uint16 verifiedCount;
        uint16 diffCount;
    }

    // ───────────────────────────── wiring ─────────────────────────────

    function registry() external view returns (IAntseedRegistry);
    /// @notice Emissions gate pinned at deployment; every epoch in this contract and its sources comes from it.
    function emissionsGate() external view returns (IAntseedEmissionsGate);
    /// @notice The current epoch of the pinned gate. Sources should use this, never the gate directly.
    function currentEpoch() external view returns (uint256);
    /// @notice Epochs a SAME or DIFF verdict counts for, including the one it was given in.
    function validityEpochs() external view returns (uint8);
    /// @notice True for contracts allowed to `record` and `credit`.
    function isSource(address source) external view returns (bool);

    // ───────────────────────────── verdicts ───────────────────────────

    /// @notice Records a verdict for (agentId, serviceHash) under `modelHash` in the current epoch,
    ///         replacing whatever was there. Sources only. Reverts on a NONE verdict or a zero
    ///         service or model hash; the source is responsible for everything else (which agents
    ///         exist, how many verifiers had to agree). `evidenceHash` is emitted, not stored.
    function record(uint256 agentId, bytes32 serviceHash, bytes32 modelHash, Verdict verdict, bytes32 evidenceHash)
        external;

    function serviceStatus(uint256 agentId, bytes32 serviceHash) external view returns (ServiceStatus memory);
    /// @notice Times the owner cleared this service with `clearServiceStatuses`. Sources fold it into
    ///         their report rounds so reports made before a clear stop counting.
    function serviceClears(uint256 agentId, bytes32 serviceHash) external view returns (uint256);
    /// @notice Times the service's live verdict moved into or out of DIFF, by any source or an owner
    ///         clear. Sources fold it into their report rounds so support given before a DIFF was
    ///         recorded can't clear it, and support given before it was cleared can't restore it.
    function diffChanges(uint256 agentId, bytes32 serviceHash) external view returns (uint256);
    /// @notice The service's verdict if it is live in the current epoch, else NONE.
    function liveVerdict(uint256 agentId, bytes32 serviceHash) external view returns (Verdict);
    function agentStatus(uint256 agentId) external view returns (AgentStatus memory);
    /// @notice True while the agent has a live SAME service and no live DIFF service.
    function isVerified(uint256 agentId) external view returns (bool);

    // ───────────────────────────── rewards ────────────────────────────

    /// @notice The source's latest share of the bucket's epoch budget, in bps of 10,000: what applies
    ///         from the next epoch on. Shares sum to at most 10,000.
    function sourceShareBps(address source) external view returns (uint16);
    /// @notice The source's share for `epoch`.
    function sourceShareBpsAt(address source, uint256 epoch) external view returns (uint16);
    /// @notice First epoch whose credits from `source` count; `type(uint64).max` while its rewards are off.
    function rewardsStartEpoch(address source) external view returns (uint64);
    /// @notice Most of `source`'s epoch budget one verifier can receive, in bps of 10,000.
    function maxAuditorShareBps(address source) external view returns (uint16);
    /// @notice Safety limit: credits one verifier can earn from `source` per epoch.
    function maxCreditsPerAuditorPerEpoch(address source) external view returns (uint32);
    /// @notice What `source`'s verifiers share for `epoch`: the bucket's budget times the source's
    ///         share for that epoch.
    function sourceBudget(address source, uint256 epoch) external view returns (uint256);

    function epochCredits(address source, uint256 epoch) external view returns (uint256);
    function auditorEpochCredits(address source, uint256 epoch, address auditor) external view returns (uint256);
    function auditorEpochClaimed(address source, uint256 epoch, address auditor) external view returns (bool);
    /// @notice Credits of verifiers that already claimed from `source` for `epoch`.
    function claimedCredits(address source, uint256 epoch) external view returns (uint256);
    /// @notice Minted from `source`'s share for `epoch` so far, overflow to the reserve included.
    function paidRewards(address source, uint256 epoch) external view returns (uint256);
    /// @notice Swept through `settleEpochRemainder` for `epoch` so far.
    function settledRemainder(uint256 epoch) external view returns (uint256);
    /// @notice What `settleEpochRemainder(epoch)` would sweep now; 0 for the current epoch.
    function unclaimableRemainder(uint256 epoch) external view returns (uint256);

    /// @notice Grants `credits` to `auditor` for the current epoch, from the calling source. Sources
    ///         only. Nothing is credited before the source's rewards start epoch; the amount is
    ///         clamped to the source's per-verifier cap. Returns what was actually credited.
    function credit(address auditor, uint256 credits) external returns (uint256 credited);

    /// @notice Claims the caller's rewards from `source` for finalized epochs; the part above the
    ///         per-verifier cap goes to the emissions reserve. Epochs with nothing to claim, or whose
    ///         bucket has no budget yet, are skipped and stay claimable.
    function claimRewards(address source, uint256[] calldata epochs) external returns (uint256 total);
    /// @notice What the verifier would receive from `source` for a finalized epoch; 0 for the current epoch.
    function pendingReward(address source, address auditor, uint256 epoch) external view returns (uint256);

    /// @notice Sweeps a finalized epoch's budget no verifier can ever claim (sources without credits,
    ///         the part of the bucket assigned to no source, budget freed by voided credits) through the
    ///         gate's remainder route. Anyone may call it, again whenever more is freed; reverts
    ///         `NothingToSettle` when there is nothing to sweep.
    function settleEpochRemainder(uint256 epoch) external returns (uint256 burnedAmount, uint256 reserveAmount);
}
