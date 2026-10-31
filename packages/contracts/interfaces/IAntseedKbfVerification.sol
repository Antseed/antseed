// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAntseedEmissionsGate} from "./IAntseedEmissionsGate.sol";
import {IAntseedRegistry} from "./IAntseedRegistry.sol";
import {IAntseedSellerPools} from "./IAntseedSellerPools.sol";

/// @notice Distributed KBF (model identity) verification. KBF is one of several verification
///         methods; each method has its own contract and interface with its own verdicts,
///         verifiers and rewards bucket.
/// @dev One audit round runs per emissions epoch, driven by deadlines instead of messages:
///      1. The publisher commits the epoch's sealed question bank (`commitBank`): the hash of the
///         encrypted bank and the hash of its key.
///      2. Anyone opens the epoch (`openEpoch`), which snapshots the approved verifiers, the
///         audited model list and the schedule, and fixes a future block. Its hash becomes the
///         epoch seed (`fixSeed`), so nobody can choose which questions a seller gets.
///      3. The publisher commits the plan (`commitPlan`): the target list and one encrypted
///         question envelope per verifier, derived from the seed.
///      4. Verifiers buy their assigned slices from sellers and commit the seller-signed
///         transcripts (`commitSlices`) by the commit deadline; missing slices go to backup
///         verifiers (`commitBackupPlan`, then `commitSlices` again) until the backup deadline.
///      5. The publisher reveals the bank key (`revealBankKey`), so everyone can score.
///      6. Each verifier scores every transcript and attests the Merkle root of the results
///         (`attest`). A root attested by a majority of the snapshot's verifiers finalizes.
///      7. Anyone applies the finalized results with Merkle proofs (`applyResults`).
///      Status is kept per (agent, service): the latest applied verdict with the epoch it was
///      given in, live while `currentEpoch < epoch + validityEpochs`. Only SAME and DIFF count
///      in the agent's status.
interface IAntseedKbfVerification {
    enum Verdict {
        NONE,
        SAME,
        DIFF,
        UNDETERMINED
    }

    /// @param modelHash keccak256 of the lowercased audited model id, e.g. "claude-opus-5.5".
    /// @param service The audited model id that `modelHash` is derived from.
    struct Model {
        bytes32 modelHash;
        string service;
    }

    /// @notice Per-epoch timing and sampling, as offsets from the epoch start.
    /// @param collectSeconds Primary collection window; slices committed before it ends count as primary.
    /// @param backupSeconds Backup round after collection, for slices their owner did not deliver.
    /// @param attestSeconds Attestation window after the backup round.
    /// @param probesPerService Questions asked per (seller, service).
    /// @param slicesPerService Slices those questions are split into, each bought by one verifier.
    struct Schedule {
        uint32 collectSeconds;
        uint32 backupSeconds;
        uint32 attestSeconds;
        uint16 probesPerService;
        uint16 slicesPerService;
    }

    /// @notice Everything a verifier needs to follow one epoch. Zero values mean "not yet".
    struct EpochInfo {
        uint256 startedAt;
        uint64 seedBlock;
        bytes32 seed;
        uint32 modelsVersion;
        uint16 verifierCount;
        Schedule schedule;
        bytes32 bankHash;
        bytes32 bankKeyHash;
        bytes32 bankKey;
        bytes32 planHash;
        bytes32 backupPlanHash;
        bytes32 finalizedRoot;
        bool voided;
    }

    /// @notice One leaf of an epoch's results root.
    /// @param serviceHash keccak256 of the lowercased service name in the seller's signed metadata.
    /// @param modelHash Audited model the service was matched to.
    struct ServiceResult {
        uint256 agentId;
        bytes32 serviceHash;
        bytes32 modelHash;
        Verdict verdict;
    }

    /// @param modelHash Model the service was last audited as.
    /// @param verdict Latest applied result. Live only while `currentEpoch < epoch + validityEpochs`.
    /// @param updatedAt When the live verdict last changed.
    /// @param epoch Emissions epoch `verdict` was given in. Zero while `verdict` is NONE.
    struct ServiceStatus {
        bytes32 modelHash;
        Verdict verdict;
        uint64 updatedAt;
        uint64 epoch;
    }

    /// @param verifiedCount Services whose live verdict is SAME.
    /// @param diffCount Services whose live verdict is DIFF.
    struct AgentStatus {
        uint16 verifiedCount;
        uint16 diffCount;
    }

    function registry() external view returns (IAntseedRegistry);
    /// @notice Gate pinned at deployment; every epoch and reward reads it.
    function emissionsGate() external view returns (IAntseedEmissionsGate);
    /// @notice Epochs a verdict counts for, including the one it was given in.
    function validityEpochs() external view returns (uint8);
    function sellerPools() external view returns (IAntseedSellerPools);

    function isVerifier(address verifier) external view returns (bool);
    function verifiers() external view returns (address[] memory);
    function encryptionKeys(address verifier) external view returns (bytes32);
    function publisher() external view returns (address);
    function modelsVersion() external view returns (uint32);
    function models(uint32 version) external view returns (Model[] memory);
    function schedule() external view returns (Schedule memory);

    function epochInfo(uint256 epoch) external view returns (EpochInfo memory);
    function epochVerifiers(uint256 epoch) external view returns (address[] memory);
    /// @notice Attestations needed to finalize: a majority of the epoch's verifier snapshot.
    function threshold(uint256 epoch) external view returns (uint256);
    function attestations(uint256 epoch, address verifier) external view returns (bytes32 root);
    function rootVotes(uint256 epoch, bytes32 root) external view returns (uint256);

    function commitBank(uint256 epoch, bytes32 bankHash, bytes32 bankKeyHash, string calldata bankUri) external;
    function openEpoch(uint256 epoch) external;
    function fixSeed(uint256 epoch) external;
    function commitPlan(uint256 epoch, bytes32 planHash, string calldata planUri) external;
    function commitBackupPlan(uint256 epoch, bytes32 planHash, string calldata planUri) external;
    function revealBankKey(uint256 epoch, bytes32 bankKey) external;
    function commitSlices(uint256 epoch, bytes32 slicesRoot, string calldata manifestUri) external;
    function attest(uint256 epoch, bytes32 resultsRoot, string calldata evidenceUri) external;
    function applyResults(uint256 epoch, ServiceResult[] calldata results, bytes32[][] calldata proofs) external;

    function serviceStatus(uint256 agentId, bytes32 serviceHash) external view returns (ServiceStatus memory);
    function agentStatus(uint256 agentId) external view returns (AgentStatus memory);
    /// @notice True when the agent has at least one live SAME and no live DIFF.
    function isVerified(uint256 agentId) external view returns (bool);

    function rewardsStartEpoch() external view returns (uint256);
    /// @notice Claims the caller's reward for one finished epoch: an equal share of the attester
    ///         pool if it attested the finalized root, plus its share of the collector pool for the
    ///         slices the finalized root credits it with (`slices` of `totalSlices`, proven by `proof`).
    function claimRewards(uint256 epoch, uint32 slices, uint32 totalSlices, bytes32[] calldata proof)
        external
        returns (uint256 amount);
    function pendingReward(address verifier, uint256 epoch, uint32 slices, uint32 totalSlices, bytes32[] calldata proof)
        external
        view
        returns (uint256);
}
