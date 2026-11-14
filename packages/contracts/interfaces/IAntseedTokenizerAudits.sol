// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AntseedResponseAuth } from "../verification/AntseedResponseAuth.sol";
import { IAntseedPointsModifier } from "./IAntseedPointsModifier.sol";
import { IAntseedSellerPools } from "./IAntseedSellerPools.sol";
import { IAntseedVerificationResults } from "./IAntseedVerificationResults.sol";
import { IERC8004Registry } from "./IERC8004Registry.sol";

/// @notice Tokenizer audits: a permissionless verification method that proves, from sellers' own signed
///         receipts, that a service's reported usage is not its model's tokenizer.
///
///         A round sends two requests to several sellers of one model: prompt A, and A followed by B. The
///         prompt-token difference each seller signs is B's length in the tokenizer that actually ran; chat
///         templates and hidden system prompts cancel out. A and B are fresh for every round (the prover makes
///         them up, e.g. with a model), so a seller can't tell a probe from real traffic.
///
///         The reference is other sellers, not a stored number: in every round at least `minReferences`
///         distinct sellers whose service has a live SAME verdict for the model on the results layer must sign
///         the same delta. Every request is an owner-registered request shape (one per API: Chat Completions,
///         Anthropic Messages, Responses) with the round's A and B as the user message; only the model name
///         differs per seller. So the suspect and the references read the exact same prompt, each in an API it
///         speaks natively, and nobody can put B where one seller's model never reads it.
///
///         The suspect must be off the references' delta by more than `tolerance` in every round (at least
///         `minRounds` rounds), every receipt signed within `maxEvidenceAgeSeconds` before the proof. Then:
///         - if the suspect's service has a live SAME itself (it answers like the model), the contract flags
///           it `UsageMisreported`: the usage it signs, and is paid on, is not the model's. This contract is
///           also a points modifier that cuts seller points for flagged services;
///         - otherwise it records DIFF for the service on the results layer, like any other audit.
///
///         Credits: a proof that creates a new DIFF or a new flag for a staked agent earns the prover
///         `creditsPerProof` through the results layer.
/// @dev Trust: the owner registers request shapes and, for services no audit has recorded yet, which
///      model a service name is sold as. A seller can still escape by reporting usage computed with the
///      model's own tokenizer. References sign their own usage, so `minReferences` colluding agents with a
///      live SAME for the model could prove a mismatch against an honest seller; the owner can clear such a
///      flag, and the results layer's owner such a DIFF. The submitter is credited: a copy of a pending proof
///      sent first takes the credit. That is accepted: the evidence is single-use and expires after
///      `maxEvidenceAgeSeconds`, so a copy can't be replayed, and the seller's verdict is the same either way.
interface IAntseedTokenizerAudits is IAntseedPointsModifier {
    /// @notice A request to `path` whose body is `head + service + mid + content + tail`, with `content` = A
    ///         or A + B and `service` the advertised service the seller signed. E.g. path
    ///         `/v1/chat/completions`, head `{"model":"`, mid `","messages":[{"role":"user","content":"`, tail
    ///         `"}],"max_tokens":64}`.
    struct Shape {
        bytes path;
        bytes head;
        bytes mid;
        bytes tail;
        bool active;
    }

    /// @param shapeId The registered shape both requests use.
    /// @param base The request with content A.
    /// @param probed The request with content A + B.
    struct ProbePair {
        bytes32 shapeId;
        AntseedResponseAuth.Receipt base;
        AntseedResponseAuth.Receipt probed;
    }

    /// @param a The base content; JSON-string-safe (no quotes, backslashes or control characters).
    /// @param b The probe content appended to `a`; JSON-string-safe.
    /// @param suspect The suspect seller's pair.
    /// @param references Pairs from distinct sellers with a live SAME for the model, which must agree.
    struct Round {
        bytes a;
        bytes b;
        ProbePair suspect;
        ProbePair[] references;
    }

    /// @param validUntilEpoch The first epoch the flag no longer counts in.
    struct Flag {
        bytes32 modelHash;
        uint64 epoch;
        uint64 validUntilEpoch;
    }

    event SellerPoolsSet(address sellerPools);
    event ShapeSet(bytes32 indexed shapeId, bytes path, bytes head, bytes mid, bytes tail, bool active);
    /// @param modelHash Model the service name counts as; zero removes the mapping.
    event ServiceModelSet(bytes32 indexed serviceHash, bytes32 indexed modelHash);
    event ParametersSet(uint8 minRounds, uint8 minReferences, uint32 tolerance, uint32 maxRoundSpreadSeconds);
    event MaxEvidenceAgeSet(uint32 maxEvidenceAgeSeconds);
    event ValidityEpochsSet(uint8 validityEpochs);
    event CreditsPerProofSet(uint32 credits);
    event PenaltyBpsSet(uint256 penaltyBps);
    /// @param suspectDeltas The suspect's signed delta in each round.
    /// @param referenceMinDeltas The smallest reference delta in each round.
    /// @param referenceMaxDeltas The largest reference delta in each round (within `tolerance` of the smallest).
    event TokenizerMismatchProven(
        uint256 indexed agentId,
        bytes32 indexed serviceHash,
        address indexed prover,
        address seller,
        bytes32 modelHash,
        bool usageMisreported,
        uint256 epoch,
        int256[] suspectDeltas,
        int256[] referenceMinDeltas,
        int256[] referenceMaxDeltas,
        bytes32 evidenceHash
    );
    event UsageMisreported(uint256 indexed agentId, bytes32 indexed serviceHash, bytes32 modelHash, uint256 validUntilEpoch);
    event FlagCleared(uint256 indexed agentId, bytes32 indexed serviceHash);
    event ProofCredited(uint256 indexed epoch, address indexed prover, uint256 credits);

    error InvalidAddress();
    error InvalidValue();
    error InvalidShape();
    error InvalidRounds();
    error InvalidContent();
    error BadSignature();
    error NotOk();
    error DifferentService();
    error ReceiptUsed();
    error NotProbePair();
    error UsageNotFound();
    error UnknownService();
    error NotAReference(uint256 round, uint256 referenceIndex);
    error ReferencesDisagree(uint256 round);
    error WithinTolerance(uint256 round, int256 suspectDelta, int256 referenceMinDelta, int256 referenceMaxDelta);
    error RoundTooSpread(uint256 round);
    /// @notice A receipt older than `maxEvidenceAgeSeconds`, or a suspect receipt from before `clearFlag`.
    error StaleEvidence(uint256 round);
    /// @notice A receipt signed later than the block's time (beyond a small clock skew).
    error FutureEvidence(uint256 round);
    error UnknownAgent();
    error SelfAudit();

    function results() external view returns (IAntseedVerificationResults);
    function sellerPools() external view returns (IAntseedSellerPools);
    function identityRegistry() external view returns (IERC8004Registry);

    /// @notice Every shape ever registered, active or not, in registration order.
    function shapeIds() external view returns (bytes32[] memory);
    function shape(bytes32 shapeId) external view returns (Shape memory);
    /// @notice Model a never-audited service name is sold as (owner-set); zero when unmapped.
    function serviceModel(bytes32 serviceHash) external view returns (bytes32);

    /// @notice Rounds a proof needs; the suspect must be off in every one.
    function minRounds() external view returns (uint8);
    /// @notice Distinct live-SAME references every round needs.
    function minReferences() external view returns (uint8);
    /// @notice Widest the references' deltas may spread and still agree, and how far outside their range a
    ///         suspect's delta may be and still count as the model.
    function tolerance() external view returns (uint32);
    /// @notice All receipts of a round must be signed within this many seconds of each other.
    function maxRoundSpreadSeconds() external view returns (uint32);
    /// @notice Oldest, in seconds, a proof's receipts may be when it is submitted.
    function maxEvidenceAgeSeconds() external view returns (uint32);
    /// @notice When the owner last cleared the service's flag (0 if never); older suspect receipts can't
    ///         flag it again.
    function flagClearedAt(uint256 agentId, bytes32 serviceHash) external view returns (uint64);
    /// @notice Epochs a DIFF or flag recorded here counts for, including the one it was given in.
    function validityEpochs() external view returns (uint8);
    /// @notice Credits a proof earns when it creates a new DIFF or flag for a staked agent; 0 turns rewards off.
    function creditsPerProof() external view returns (uint32);
    /// @notice Seller points removed per flagged service, in bps; 0 turns the points modifier off.
    function penaltyBps() external view returns (uint256);
    /// @notice True once a suspect receipt (seller, requestId) has been used in a proof.
    function receiptUsed(address seller, string calldata requestId) external view returns (bool);

    /// @notice The service's usage-misreported flag (zero when none).
    function flag(uint256 agentId, bytes32 serviceHash) external view returns (Flag memory);
    /// @notice The agent's services whose flag is live in the current epoch.
    function liveFlags(uint256 agentId) external view returns (uint256);

    /// @notice For each seller and service: its agent, the model it counts as (its live results status, else
    ///         the owner mapping), and whether it can serve as a reference (live SAME and no live usage flag).
    function resolveServices(address[] calldata sellers, string[] calldata services)
        external
        view
        returns (uint256[] memory agentIds, bytes32[] memory modelHashes, bool[] memory liveSame);

    /// @notice keccak256 of `serviceName` trimmed of ASCII whitespace and ASCII-lowercased, as the results
    ///         layer keys services.
    function serviceHashOf(string calldata serviceName) external pure returns (bytes32);
    /// @notice The EIP-191 digest a seller signs for `receipt` (for off-chain checks).
    function receiptDigest(AntseedResponseAuth.Receipt calldata receipt) external pure returns (bytes32);
    /// @notice The prompt tokens a signed response body reports (Chat Completions `prompt_tokens`, or
    ///         `input_tokens` plus Anthropic's cache tokens for Messages and Responses). `found` is false when the body has no single usage field.
    function promptTokensOf(bytes calldata responseBody) external pure returns (bool found, uint256 tokens);

    /// @notice Proves that a suspect service's signed usage does not match its model's tokenizer, against
    ///         live-SAME reference sellers given the same prompts, and records DIFF or a usage flag. Anyone may
    ///         call.
    /// @param modelHash The model the suspect service is sold as (its own results status, or the owner
    ///        mapping) and the references are live SAME for.
    function proveTokenizerMismatch(bytes32 modelHash, Round[] calldata rounds) external;
}
