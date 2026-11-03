// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedSellerPools } from "./IAntseedSellerPools.sol";
import { IAntseedVerificationResults } from "./IAntseedVerificationResults.sol";

/// @notice KBF (Knowledge Boundary Fingerprinting) model audits, submitted by owner-approved
///         auditors, one model per submission, and recorded into an
///         `IAntseedVerificationResults` once enough auditors agree. KBF is one of several
///         verification methods: each method is its own source contract next to this one, with
///         its own admission rule, consensus and reward rules, writing into the same results layer.
/// @dev Confirmations: a result is recorded once `requiredReports[verdict]` distinct approved
///      auditors report it for the same (agent, service, model) in the same epoch and report
///      round. Replacing a live DIFF (from any source) needs as many reports as a DIFF does. Reports
///      count per epoch only, and only in the current round: `reportRound` moves on whenever a
///      result this contract records moves the service's live verdict into or out of DIFF
///      (`diffChanges`), and whenever an auditor is revoked (`auditorRevocations`).
///
///      Credits: one credit per model audit that covers at least one agent with staked pool power,
///      at most `maxCreditsPerModelPerEpoch` per model, granted through `results.credit`. The results
///      layer applies this source's rewards start epoch and per-verifier caps, and verifiers claim
///      there with this contract as the source.
interface IAntseedKbfAudits {
    /// @param agentId Seller agent the result is for.
    /// @param serviceHash keccak256 of the lowercased service name in the seller's signed metadata.
    /// @param verdict SAME when the service answered as the audited model, DIFF when it did not,
    ///        UNDETERMINED when the audit ran but could not decide.
    struct ServiceResult {
        uint256 agentId;
        bytes32 serviceHash;
        IAntseedVerificationResults.Verdict verdict;
    }

    /// @notice How an auditor shows itself in UIs. All fields are plain UTF-8 and may be empty.
    /// @param name Display name, at most `MAX_PROFILE_NAME_BYTES`.
    /// @param iconUri Link to a square image (https:// or ipfs://), at most `MAX_PROFILE_URI_BYTES`.
    /// @param url Website or profile link, at most `MAX_PROFILE_URI_BYTES`.
    struct AuditorProfile {
        string name;
        string iconUri;
        string url;
    }

    event AuditorSet(address indexed auditor, bool approved);
    event AuditorProfileSet(address indexed auditor, string name, string iconUri, string url);

    function results() external view returns (IAntseedVerificationResults);
    function sellerPools() external view returns (IAntseedSellerPools);

    // ───────────────────────────── auditors ───────────────────────────

    /// @notice True while `auditor` may submit audits.
    function approvedAuditors(address auditor) external view returns (bool);
    /// @notice Auditors revoked so far; folded into every report round so a revoked auditor's
    ///         waiting reports stop counting.
    function auditorRevocations() external view returns (uint256);
    /// @notice Approves or revokes an auditor. Owner only. Emits `AuditorSet` on every call.
    function setAuditor(address auditor, bool approved) external;
    /// @notice The auditor's display profile; empty fields when it never set one.
    function auditorProfile(address auditor) external view returns (AuditorProfile memory);
    /// @notice Sets the caller's display profile. Approved auditors only; a revoked auditor's profile
    ///         stays readable but can no longer be changed. Reverts on a field over its length limit.
    function setAuditorProfile(string calldata name, string calldata iconUri, string calldata url) external;
    /// @notice Clears an auditor's profile (e.g. for abusive content). Owner only.
    function clearAuditorProfile(address auditor) external;
    /// @notice Resolves the agent's owner through the identity registry. `known` is false for
    ///         agents the registry cannot resolve (e.g. burned, or id 0); never reverts.
    function agentOwner(uint256 agentId) external view returns (bool known, address owner);

    // ───────────────────────────── audits ─────────────────────────────

    /// @notice Distinct approved auditors that must report a verdict in one epoch before it is recorded.
    function requiredReports(IAntseedVerificationResults.Verdict verdict) external view returns (uint8);
    /// @notice Auditor that first submitted an evidence hash; nobody else may submit it.
    function evidenceAuditor(bytes32 evidenceHash) external view returns (address);

    /// @notice Records one auditor's KBF results for every seller audited as `modelHash`.
    /// @dev Reverts unless the caller is an approved auditor, `expectedEpoch` is the results layer's current epoch, `evidenceHash` is non-zero and not
    ///      another auditor's, and `results` is non-empty, bounded, and strictly ordered by
    ///      (agentId, serviceHash).
    function submitModelAudit(
        uint256 expectedEpoch,
        bytes32 modelHash,
        bytes32 evidenceHash,
        string calldata evidenceUri,
        ServiceResult[] calldata results
    ) external;

    /// @notice Times a result recorded by this contract moved the service's live verdict into or out of DIFF.
    function diffChanges(uint256 agentId, bytes32 serviceHash) external view returns (uint256);
    /// @notice The service's report round: only reports made in it count.
    function reportRound(uint256 agentId, bytes32 serviceHash) external view returns (uint256);
    /// @notice Key of one tally: (epoch, agent, service, model, round).
    function reportKey(uint256 epoch, uint256 agentId, bytes32 serviceHash, bytes32 modelHash, uint256 round)
        external
        pure
        returns (bytes32);
    /// @notice What `auditor` last reported under `key`; NONE when nothing.
    function reportOf(bytes32 key, address auditor) external view returns (IAntseedVerificationResults.Verdict);
    /// @notice Distinct auditors currently reporting `verdict` under `key`.
    function reportCount(bytes32 key, IAntseedVerificationResults.Verdict verdict) external view returns (uint256);

    // ───────────────────────────── credits ────────────────────────────

    /// @notice Safety limit: credited audits of the same model per auditor and epoch.
    function maxCreditsPerModelPerEpoch() external view returns (uint32);
    function modelCredits(uint256 epoch, address auditor, bytes32 modelHash) external view returns (uint256);
}
