// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedTokenizerAudits } from "../interfaces/IAntseedTokenizerAudits.sol";
import { IAntseedVerificationResults } from "../interfaces/IAntseedVerificationResults.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";
import { AntseedResponseAuth } from "./AntseedResponseAuth.sol";

/// @notice Tokenizer audit. See `IAntseedTokenizerAudits`.
///
///         For every round the contract checks, for the suspect and each reference pair: the seller signed both
///         receipts, both are HTTP 200, both requests are exactly the pair's shape (its path, and its body with
///         the seller's advertised service and content A (base) or A + B (probed)), and reads the prompt tokens
///         from the signed responses. Pairs in a round may use different shapes: the delta is B's length in the
///         model's tokenizer whichever API carried it. References must be distinct sellers and agents, other
///         than the suspect, whose service has a live SAME for `modelHash`; their deltas must all lie within
///         `tolerance` of each other, and the suspect's must be more than `tolerance` outside their range. All
///         receipts of a round must be signed within `maxRoundSpreadSeconds` of each other, none more than
///         `maxEvidenceAgeSeconds` before the proof or in its future, and the suspect's after any `clearFlag` of
///         the service. Suspect receipts are single-use; reference receipts may back several proofs (the same
///         round can be checked against many suspects).
contract AntseedTokenizerAudits is IAntseedTokenizerAudits, Ownable2Step {
    uint8 public constant MAX_ROUNDS = 8;
    uint8 public constant MAX_REFERENCES = 8;
    /// @notice Most epochs a tokenizer DIFF or flag can count for, including the one it was given in.
    uint8 public constant MAX_VALIDITY_EPOCHS = 4;
    uint256 public constant MAX_SHAPE_BYTES = 1024;
    uint256 public constant MAX_CONTENT_BYTES = 4096;
    uint256 private constant BPS = 10_000;
    uint256 private constant MAX_TOKEN_DIGITS = 15;
    /// @dev How far a seller's clock may run ahead of the block's.
    uint256 private constant MAX_CLOCK_SKEW_SECONDS = 300;

    bytes private constant USAGE = '"usage"';
    bytes private constant PROMPT_TOKENS = '"prompt_tokens"';
    bytes private constant INPUT_TOKENS = '"input_tokens"';
    bytes private constant CACHE_READ_TOKENS = '"cache_read_input_tokens"';
    bytes private constant CACHE_CREATION_TOKENS = '"cache_creation_input_tokens"';

    IAntseedVerificationResults public immutable override results;
    IERC8004Registry public immutable override identityRegistry;
    IAntseedSellerPools public override sellerPools;

    /// @inheritdoc IAntseedTokenizerAudits
    mapping(bytes32 serviceHash => bytes32 modelHash) public override serviceModel;
    /// @inheritdoc IAntseedTokenizerAudits
    uint8 public override minRounds = 3;
    /// @inheritdoc IAntseedTokenizerAudits
    uint8 public override minReferences = 3;
    /// @inheritdoc IAntseedTokenizerAudits
    uint32 public override tolerance = 2;
    /// @inheritdoc IAntseedTokenizerAudits
    uint32 public override maxRoundSpreadSeconds = 3600;
    /// @inheritdoc IAntseedTokenizerAudits
    uint32 public override maxEvidenceAgeSeconds = 1 days;
    /// @inheritdoc IAntseedTokenizerAudits
    uint8 public override validityEpochs = 2;
    /// @inheritdoc IAntseedTokenizerAudits
    uint32 public override creditsPerProof = 1;
    /// @inheritdoc IAntseedTokenizerAudits
    uint256 public override penaltyBps;

    mapping(bytes32 shapeId => Shape) private _shapes;
    bytes32[] private _shapeIds;
    mapping(bytes32 receiptKey => bool) private _usedReceipts;
    mapping(uint256 agentId => mapping(bytes32 serviceHash => Flag)) private _flags;
    mapping(uint256 agentId => bytes32[] serviceHashes) private _flaggedServices;
    /// @inheritdoc IAntseedTokenizerAudits
    mapping(uint256 agentId => mapping(bytes32 serviceHash => uint64 timestamp)) public override flagClearedAt;

    /// @dev What one round showed: the suspect's delta, the references' range and the receipts it covered.
    struct RoundResult {
        int256 suspectDelta;
        int256 referenceMin;
        int256 referenceMax;
        bytes32 digests;
    }

    /// @dev One checked pair: its delta, the earliest and latest signed start (ms), and its receipts' digests.
    struct PairResult {
        int256 delta;
        uint64 firstAt;
        uint64 lastAt;
        bytes32 digests;
    }

    constructor(address results_, address sellerPools_, address identityRegistry_) Ownable(msg.sender) {
        if (results_.code.length == 0 || identityRegistry_.code.length == 0) revert InvalidAddress();
        results = IAntseedVerificationResults(results_);
        identityRegistry = IERC8004Registry(identityRegistry_);
        _setSellerPools(sellerPools_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setSellerPools(address sellerPools_) external onlyOwner {
        _setSellerPools(sellerPools_);
    }

    /// @notice Registers or (de)activates a request shape; its id is
    ///         `keccak256(abi.encode(path, head, mid, tail))`.
    function setShape(bytes calldata path, bytes calldata head, bytes calldata mid, bytes calldata tail, bool active)
        external
        onlyOwner
        returns (bytes32 shapeId)
    {
        if (
            path.length == 0 || head.length == 0 || mid.length == 0 || tail.length == 0
                || path.length + head.length + mid.length + tail.length > MAX_SHAPE_BYTES
        ) revert InvalidShape();
        shapeId = keccak256(abi.encode(path, head, mid, tail));
        if (_shapes[shapeId].head.length == 0) _shapeIds.push(shapeId);
        _shapes[shapeId] = Shape(path, head, mid, tail, active);
        emit ShapeSet(shapeId, path, head, mid, tail, active);
    }

    /// @notice Maps never-audited service names (as `serviceHashOf`) to the model they are sold as; zero
    ///         removes them. A service with a live results status counts as the model of that status instead.
    function setServiceModels(bytes32[] calldata serviceHashes, bytes32 modelHash) external onlyOwner {
        for (uint256 i = 0; i < serviceHashes.length; i++) {
            if (serviceHashes[i] == bytes32(0)) revert InvalidValue();
            serviceModel[serviceHashes[i]] = modelHash;
            emit ServiceModelSet(serviceHashes[i], modelHash);
        }
    }

    function setParameters(uint8 rounds, uint8 references, uint32 tolerance_, uint32 maxRoundSpreadSeconds_)
        external
        onlyOwner
    {
        if (rounds == 0 || rounds > MAX_ROUNDS || references == 0 || references > MAX_REFERENCES) revert InvalidValue();
        if (maxRoundSpreadSeconds_ == 0) revert InvalidValue();
        minRounds = rounds;
        minReferences = references;
        tolerance = tolerance_;
        maxRoundSpreadSeconds = maxRoundSpreadSeconds_;
        emit ParametersSet(rounds, references, tolerance_, maxRoundSpreadSeconds_);
    }

    /// @notice Oldest a proof's receipts may be when it is submitted.
    function setMaxEvidenceAge(uint32 seconds_) external onlyOwner {
        if (seconds_ == 0) revert InvalidValue();
        maxEvidenceAgeSeconds = seconds_;
        emit MaxEvidenceAgeSet(seconds_);
    }

    function setValidityEpochs(uint8 epochs) external onlyOwner {
        if (epochs == 0 || epochs > MAX_VALIDITY_EPOCHS) revert InvalidValue();
        validityEpochs = epochs;
        emit ValidityEpochsSet(epochs);
    }

    /// @notice Credits a proof earns when it creates a new DIFF or flag for a staked agent; 0 turns rewards off.
    function setCreditsPerProof(uint32 credits) external onlyOwner {
        creditsPerProof = credits;
        emit CreditsPerProofSet(credits);
    }

    /// @notice Seller points removed per flagged service, in bps (at most all of them); 0 turns it off.
    function setPenaltyBps(uint256 penaltyBps_) external onlyOwner {
        if (penaltyBps_ > BPS) revert InvalidValue();
        penaltyBps = penaltyBps_;
        emit PenaltyBpsSet(penaltyBps_);
    }

    /// @notice Removes a usage flag (e.g. after a seller fixed its reporting). It also leaves the agent's
    ///         flagged list, so a later proof lists it once again, and only suspect receipts signed after now
    ///         can flag the service again.
    function clearFlag(uint256 agentId, bytes32 serviceHash) external onlyOwner {
        delete _flags[agentId][serviceHash];
        flagClearedAt[agentId][serviceHash] = uint64(block.timestamp);
        bytes32[] storage services = _flaggedServices[agentId];
        for (uint256 i = 0; i < services.length; i++) {
            if (services[i] == serviceHash) {
                services[i] = services[services.length - 1];
                services.pop();
                break;
            }
        }
        emit FlagCleared(agentId, serviceHash);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        PROOFS
    // ═══════════════════════════════════════════════════════════════════

    /// @inheritdoc IAntseedTokenizerAudits
    function proveTokenizerMismatch(bytes32 modelHash, Round[] calldata rounds) external override {
        uint256 count = rounds.length;
        if (modelHash == bytes32(0) || count < minRounds || count > MAX_ROUNDS) revert InvalidRounds();

        address seller = rounds[0].suspect.base.seller;
        bytes32 serviceHash = serviceHashOf(rounds[0].suspect.base.advertisedService);
        uint256 agentId = _agentIdForSeller(seller);
        if (agentId == 0) revert UnknownAgent();
        (bool known, address agentOwner) = _agentOwner(agentId);
        if (!known) revert UnknownAgent();
        if (agentOwner == msg.sender) revert SelfAudit();
        IAntseedVerificationResults.Verdict live = results.liveVerdict(agentId, serviceHash);
        if (_modelOf(agentId, serviceHash, live) != modelHash) revert UnknownService();

        int256[] memory suspectDeltas = new int256[](count);
        int256[] memory referenceMins = new int256[](count);
        int256[] memory referenceMaxes = new int256[](count);
        bytes32 evidenceHash = bytes32(0);
        for (uint256 i = 0; i < count; i++) {
            RoundResult memory round = _checkRound(i, rounds[i], seller, serviceHash, agentId, modelHash);
            suspectDeltas[i] = round.suspectDelta;
            referenceMins[i] = round.referenceMin;
            referenceMaxes[i] = round.referenceMax;
            evidenceHash = keccak256(abi.encode(evidenceHash, round.digests));
        }

        uint256 epoch = results.currentEpoch();
        uint256 validUntil = epoch + validityEpochs;
        bool misreported = live == IAntseedVerificationResults.Verdict.SAME;
        bool isNew;
        if (misreported) {
            Flag storage existing = _flags[agentId][serviceHash];
            isNew = existing.validUntilEpoch <= epoch;
            if (existing.validUntilEpoch == 0) _flaggedServices[agentId].push(serviceHash);
            _flags[agentId][serviceHash] = Flag(modelHash, uint64(epoch), uint64(validUntil));
            emit UsageMisreported(agentId, serviceHash, modelHash, validUntil);
        } else {
            isNew = live != IAntseedVerificationResults.Verdict.DIFF;
        }
        emit TokenizerMismatchProven(
            agentId, serviceHash, msg.sender, seller, modelHash, misreported, epoch, suspectDeltas, referenceMins, referenceMaxes,
            evidenceHash
        );
        if (!misreported) {
            results.record(agentId, serviceHash, modelHash, IAntseedVerificationResults.Verdict.DIFF, validUntil);
        }

        uint32 credits = creditsPerProof;
        if (isNew && credits != 0 && _hasPoolPower(agentId, epoch)) {
            uint256 credited = results.credit(msg.sender, credits);
            if (credited != 0) emit ProofCredited(epoch, msg.sender, credited);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        POINTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Points modifier: removes `penaltyBps` of the seller's points per live usage flag. Never reverts;
    ///         buyer points are unchanged.
    function points(bytes32, address, address seller, uint256 sellerPoints, uint256 buyerPoints)
        external
        view
        override
        returns (uint256, uint256)
    {
        uint256 penalty = penaltyBps;
        if (penalty == 0 || sellerPoints == 0) return (sellerPoints, buyerPoints);
        uint256 agentId = _agentIdForSeller(seller);
        if (agentId == 0) return (sellerPoints, buyerPoints);
        uint256 flags;
        try results.currentEpoch() returns (uint256 epoch) {
            flags = _liveFlagsAt(agentId, epoch);
        } catch {
            return (sellerPoints, buyerPoints);
        }
        if (flags == 0) return (sellerPoints, buyerPoints);
        uint256 removed = penalty * flags;
        if (removed >= BPS) return (0, buyerPoints);
        return (sellerPoints * (BPS - removed) / BPS, buyerPoints);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    function shapeIds() external view override returns (bytes32[] memory) {
        return _shapeIds;
    }

    function shape(bytes32 shapeId) external view override returns (Shape memory) {
        return _shapes[shapeId];
    }

    function receiptUsed(address seller, string calldata requestId) external view override returns (bool) {
        return _usedReceipts[_receiptKey(seller, requestId)];
    }

    function flag(uint256 agentId, bytes32 serviceHash) external view override returns (Flag memory) {
        return _flags[agentId][serviceHash];
    }

    function liveFlags(uint256 agentId) external view override returns (uint256) {
        return _liveFlagsAt(agentId, results.currentEpoch());
    }

    function resolveServices(address[] calldata sellers, string[] calldata services)
        external
        view
        override
        returns (uint256[] memory agentIds, bytes32[] memory modelHashes, bool[] memory liveSame)
    {
        if (sellers.length != services.length) revert InvalidValue();
        agentIds = new uint256[](sellers.length);
        modelHashes = new bytes32[](sellers.length);
        liveSame = new bool[](sellers.length);
        for (uint256 i = 0; i < sellers.length; i++) {
            uint256 agentId = _agentIdForSeller(sellers[i]);
            agentIds[i] = agentId;
            bytes32 serviceHash = serviceHashOf(services[i]);
            IAntseedVerificationResults.Verdict live = agentId == 0
                ? IAntseedVerificationResults.Verdict.NONE
                : results.liveVerdict(agentId, serviceHash);
            modelHashes[i] = _modelOf(agentId, serviceHash, live);
            liveSame[i] = live == IAntseedVerificationResults.Verdict.SAME;
        }
    }

    function serviceHashOf(string calldata serviceName) public pure override returns (bytes32) {
        bytes calldata name = bytes(serviceName);
        uint256 start = 0;
        uint256 end = name.length;
        while (start < end && _isAsciiSpace(name[start])) start++;
        while (end > start && _isAsciiSpace(name[end - 1])) end--;
        bytes memory lowered = new bytes(end - start);
        for (uint256 i = start; i < end; i++) {
            bytes1 c = name[i];
            lowered[i - start] = (c >= "A" && c <= "Z") ? bytes1(uint8(c) + 32) : c;
        }
        return keccak256(lowered);
    }

    function receiptDigest(AntseedResponseAuth.Receipt calldata receipt) external pure override returns (bytes32) {
        return AntseedResponseAuth.digest(receipt);
    }

    function promptTokensOf(bytes calldata responseBody) public pure override returns (bool found, uint256 tokens) {
        UsageKeys memory usage = _usageKeys(responseBody);
        if (usage.objects != 1) return (false, 0);
        if (usage.promptCount == 1) return (true, usage.prompt);
        if (usage.promptCount > 1 || usage.inputCount != 1 || usage.readCount > 1 || usage.creationCount > 1) {
            return (false, 0);
        }
        return (true, usage.input + usage.cacheRead + usage.cacheCreation);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _checkRound(
        uint256 index,
        Round calldata round,
        address seller,
        bytes32 serviceHash,
        uint256 suspectAgent,
        bytes32 modelHash
    ) private returns (RoundResult memory result) {
        if (
            round.b.length == 0 || round.a.length + round.b.length > MAX_CONTENT_BYTES || !_isJsonStringSafe(round.a)
                || !_isJsonStringSafe(round.b)
        ) revert InvalidContent();
        uint256 refCount = round.references.length;
        if (refCount < minReferences || refCount > MAX_REFERENCES) revert InvalidRounds();

        if (serviceHashOf(round.suspect.base.advertisedService) != serviceHash) revert DifferentService();
        PairResult memory suspect = _checkPair(round.suspect, round.a, round.b, seller, true);
        if (uint256(suspect.firstAt) <= uint256(flagClearedAt[suspectAgent][serviceHash]) * 1000) {
            revert StaleEvidence(index);
        }
        uint64 firstAt = suspect.firstAt;
        uint64 lastAt = suspect.lastAt;
        result.suspectDelta = suspect.delta;
        result.digests = suspect.digests;

        uint256[] memory agents = new uint256[](refCount);
        for (uint256 k = 0; k < refCount; k++) {
            ProbePair calldata pair = round.references[k];
            agents[k] = _referenceAgent(index, k, pair, seller, suspectAgent, modelHash, agents);
            PairResult memory ref = _checkPair(pair, round.a, round.b, pair.base.seller, false);
            if (k == 0 || ref.delta < result.referenceMin) result.referenceMin = ref.delta;
            if (k == 0 || ref.delta > result.referenceMax) result.referenceMax = ref.delta;
            if (ref.firstAt < firstAt) firstAt = ref.firstAt;
            if (ref.lastAt > lastAt) lastAt = ref.lastAt;
            result.digests = keccak256(abi.encode(result.digests, ref.digests));
        }
        // The references agree when their whole range fits in `tolerance`, whatever their order.
        if (uint256(result.referenceMax - result.referenceMin) > tolerance) revert ReferencesDisagree(index);
        if (uint256(lastAt - firstAt) > uint256(maxRoundSpreadSeconds) * 1000) revert RoundTooSpread(index);
        uint256 nowMs = block.timestamp * 1000;
        if (uint256(firstAt) + uint256(maxEvidenceAgeSeconds) * 1000 < nowMs) revert StaleEvidence(index);
        if (uint256(lastAt) > nowMs + MAX_CLOCK_SKEW_SECONDS * 1000) revert FutureEvidence(index);
        // A mismatch is a suspect delta more than `tolerance` outside the references' range.
        if (
            result.suspectDelta + int256(uint256(tolerance)) >= result.referenceMin
                && result.suspectDelta <= result.referenceMax + int256(uint256(tolerance))
        ) {
            revert WithinTolerance(index, result.suspectDelta, result.referenceMin, result.referenceMax);
        }
    }

    /// @dev A reference is another seller and agent, not repeated in the round, whose service has a live SAME
    ///      for `modelHash`.
    function _referenceAgent(
        uint256 index,
        uint256 k,
        ProbePair calldata pair,
        address suspectSeller,
        uint256 suspectAgent,
        bytes32 modelHash,
        uint256[] memory earlier
    ) private view returns (uint256 agentId) {
        address seller = pair.base.seller;
        agentId = _agentIdForSeller(seller);
        if (agentId == 0 || agentId == suspectAgent || seller == suspectSeller) revert NotAReference(index, k);
        for (uint256 j = 0; j < k; j++) {
            if (earlier[j] == agentId) revert NotAReference(index, k);
        }
        bytes32 serviceHash = serviceHashOf(pair.base.advertisedService);
        if (
            results.liveVerdict(agentId, serviceHash) != IAntseedVerificationResults.Verdict.SAME
                || results.serviceStatus(agentId, serviceHash).modelHash != modelHash
        ) revert NotAReference(index, k);
    }

    /// @dev Both receipts signed by `seller` for the same service, HTTP 200, requests exactly the pair's
    ///      active shape with content A and A + B, and a readable usage field. Suspect receipts are marked used.
    function _checkPair(
        ProbePair calldata pair,
        bytes calldata a,
        bytes calldata b,
        address seller,
        bool markUsed
    ) private returns (PairResult memory result) {
        bytes memory service = bytes(pair.base.advertisedService);
        if (keccak256(service) != keccak256(bytes(pair.probed.advertisedService))) revert DifferentService();
        (uint256 baseTokens, bytes32 baseDigest) = _checkReceipt(pair.base, seller, markUsed);
        (uint256 probedTokens, bytes32 probedDigest) = _checkReceipt(pair.probed, seller, markUsed);
        Shape storage shape_ = _shapes[pair.shapeId];
        if (!shape_.active) revert InvalidShape();
        bytes32 path = keccak256(shape_.path);
        _checkRequest(pair.base.request, path, keccak256(abi.encodePacked(shape_.head, service, shape_.mid, a, shape_.tail)));
        _checkRequest(
            pair.probed.request, path, keccak256(abi.encodePacked(shape_.head, service, shape_.mid, a, b, shape_.tail))
        );
        result.delta = int256(probedTokens) - int256(baseTokens);
        (result.firstAt, result.lastAt) = pair.base.responseStartedAt <= pair.probed.responseStartedAt
            ? (pair.base.responseStartedAt, pair.probed.responseStartedAt)
            : (pair.probed.responseStartedAt, pair.base.responseStartedAt);
        result.digests = keccak256(abi.encode(baseDigest, probedDigest));
    }

    function _checkRequest(bytes calldata request, bytes32 path, bytes32 body) private pure {
        (uint256 pathStart, uint256 pathLength, uint256 bodyStart, uint256 bodyLength) =
            AntseedResponseAuth.requestPathAndBody(request);
        if (
            AntseedResponseAuth.hashCalldata(request[pathStart:pathStart + pathLength]) != path
                || AntseedResponseAuth.hashCalldata(request[bodyStart:bodyStart + bodyLength]) != body
        ) revert NotProbePair();
    }

    function _checkReceipt(AntseedResponseAuth.Receipt calldata receipt, address seller, bool markUsed)
        private
        returns (uint256 tokens, bytes32 digest)
    {
        if (receipt.seller != seller) revert DifferentService();
        if (receipt.statusCode != 200) revert NotOk();
        digest = AntseedResponseAuth.digest(receipt);
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, receipt.signature);
        if (err != ECDSA.RecoverError.NoError || signer != seller || signer == address(0)) revert BadSignature();
        if (markUsed) {
            bytes32 key = _receiptKey(seller, receipt.requestId);
            if (_usedReceipts[key]) revert ReceiptUsed();
            _usedReceipts[key] = true;
        }
        (uint16 status, uint256 start, uint256 length) = AntseedResponseAuth.responseBody(receipt.response);
        if (status != 200) revert NotOk();
        bool found;
        (found, tokens) = promptTokensOf(receipt.response[start:start + length]);
        if (!found) revert UsageNotFound();
    }

    /// @dev The model a service counts as: its live results status if it has one, else the owner mapping.
    function _modelOf(uint256 agentId, bytes32 serviceHash, IAntseedVerificationResults.Verdict live)
        private
        view
        returns (bytes32)
    {
        if (agentId != 0 && live != IAntseedVerificationResults.Verdict.NONE) {
            return results.serviceStatus(agentId, serviceHash).modelHash;
        }
        return serviceModel[serviceHash];
    }

    function _liveFlagsAt(uint256 agentId, uint256 epoch) private view returns (uint256 live) {
        bytes32[] storage services = _flaggedServices[agentId];
        for (uint256 i = 0; i < services.length; i++) {
            if (_flags[agentId][services[i]].validUntilEpoch > epoch) live++;
        }
    }

    /// @dev The top-level `usage` objects of a response, and inside them how many times each usage key
    ///      appears with a number, and its first number.
    struct UsageKeys {
        uint256 objects;
        uint256 promptCount;
        uint256 prompt;
        uint256 inputCount;
        uint256 input;
        uint256 readCount;
        uint256 cacheRead;
        uint256 creationCount;
        uint256 cacheCreation;
    }

    /// @dev One pass over the JSON `body`, tracking strings and nesting, that reads the usage keys directly
    ///      inside the top-level `usage` object only (nested breakdowns, e.g. Responses' per-item usage, and
    ///      text that looks like a key are ignored).
    function _usageKeys(bytes calldata body) private pure returns (UsageKeys memory usage) {
        uint256 length = body.length;
        uint256 depth;
        bool inString;
        bool escaped;
        bool inUsage;
        for (uint256 i = 0; i < length; i++) {
            bytes1 c;
            assembly {
                // `i < length`, so the read stays inside `body`.
                c := and(calldataload(add(body.offset, i)), shl(248, 0xff))
            }
            if (inString) {
                if (escaped) escaped = false;
                else if (c == "\\") escaped = true;
                else if (c == '"') inString = false;
                continue;
            }
            if (c == "{" || c == "[") {
                depth++;
            } else if (c == "}" || c == "]") {
                if (depth == 2 && inUsage) inUsage = false;
                if (depth != 0) depth--;
            } else if (c == '"') {
                uint256 next = depth == 1 ? _usageObjectAfter(body, i) : 0;
                if (next != 0) {
                    usage.objects++;
                    inUsage = true;
                    depth = 2;
                    i = next;
                    continue;
                }
                next = depth == 2 && inUsage ? _readUsageKey(body, i, usage) : 0;
                if (next != 0) i = next - 1;
                else inString = true;
            }
        }
    }

    /// @dev If a `"usage"` key whose value is an object starts at `offset`, the offset of that `{`; else 0.
    function _usageObjectAfter(bytes calldata body, uint256 offset) private pure returns (uint256) {
        uint256 end = offset + USAGE.length;
        if (end > body.length || keccak256(USAGE) != AntseedResponseAuth.hashCalldata(body[offset:end])) return 0;
        uint256 length = body.length;
        while (end < length && _isAsciiSpace(body[end])) end++;
        if (end >= length || body[end] != ":") return 0;
        end++;
        while (end < length && _isAsciiSpace(body[end])) end++;
        return end < length && body[end] == "{" ? end : 0;
    }

    /// @dev Reads the usage key starting at `offset`, if it is one followed by a number, and returns the
    ///      offset just after the key's closing quote; 0 otherwise.
    function _readUsageKey(bytes calldata body, uint256 offset, UsageKeys memory usage) private pure returns (uint256) {
        bytes1 first = offset + 1 < body.length ? body[offset + 1] : bytes1(0);
        bool ok;
        uint256 value;
        uint256 end;
        if (first == "p") {
            (ok, value, end) = _keyNumber(body, offset, PROMPT_TOKENS);
            if (ok && usage.promptCount++ == 0) usage.prompt = value;
        } else if (first == "i") {
            (ok, value, end) = _keyNumber(body, offset, INPUT_TOKENS);
            if (ok && usage.inputCount++ == 0) usage.input = value;
        } else if (first == "c") {
            (ok, value, end) = _keyNumber(body, offset, CACHE_READ_TOKENS);
            if (ok) {
                if (usage.readCount++ == 0) usage.cacheRead = value;
            } else {
                (ok, value, end) = _keyNumber(body, offset, CACHE_CREATION_TOKENS);
                if (ok && usage.creationCount++ == 0) usage.cacheCreation = value;
            }
        }
        return ok ? end : 0;
    }

    /// @dev Whether `key` (quotes included) starts at `offset` and is followed by a colon and a number; the
    ///      number and the offset after the key.
    function _keyNumber(bytes calldata body, uint256 offset, bytes memory key)
        private
        pure
        returns (bool ok, uint256 value, uint256 end)
    {
        end = offset + key.length;
        if (end > body.length || keccak256(key) != AntseedResponseAuth.hashCalldata(body[offset:end])) {
            return (false, 0, 0);
        }
        (ok, value) = _numberAfterColon(body, end);
    }

    /// @dev Optional whitespace, a colon, optional whitespace, then 1 to 15 digits.
    function _numberAfterColon(bytes calldata body, uint256 offset) private pure returns (bool, uint256) {
        uint256 length = body.length;
        while (offset < length && _isAsciiSpace(body[offset])) offset++;
        if (offset >= length || body[offset] != ":") return (false, 0);
        offset++;
        while (offset < length && _isAsciiSpace(body[offset])) offset++;
        uint256 value;
        uint256 digits;
        while (offset < length && body[offset] >= "0" && body[offset] <= "9") {
            if (++digits > MAX_TOKEN_DIGITS) return (false, 0);
            value = value * 10 + (uint8(body[offset]) - 48);
            offset++;
        }
        return (digits != 0, value);
    }

    function _receiptKey(address seller, string calldata requestId) private pure returns (bytes32) {
        return keccak256(abi.encode(seller, requestId));
    }

    function _agentIdForSeller(address seller) private view returns (uint256) {
        try sellerPools.agentIdForSeller(seller) returns (uint256 agentId) {
            return agentId;
        } catch {
            return 0;
        }
    }

    function _agentOwner(uint256 agentId) private view returns (bool known, address owner) {
        try identityRegistry.ownerOf(agentId) returns (address agentOwner_) {
            return (agentOwner_ != address(0), agentOwner_);
        } catch {
            return (false, address(0));
        }
    }

    /// @dev Failing pools never block a proof; they only withhold the credit.
    function _hasPoolPower(uint256 agentId, uint256 epoch) private view returns (bool) {
        try sellerPools.poolWeightAtEpoch(agentId, epoch) returns (uint256 weight) {
            return weight != 0;
        } catch {
            return false;
        }
    }

    function _setSellerPools(address sellerPools_) private {
        if (sellerPools_.code.length == 0) revert InvalidAddress();
        sellerPools = IAntseedSellerPools(sellerPools_);
        emit SellerPoolsSet(sellerPools_);
    }

    function _isJsonStringSafe(bytes calldata text) private pure returns (bool) {
        for (uint256 i = 0; i < text.length; i++) {
            bytes1 c = text[i];
            if (c < 0x20 || c == '"' || c == "\\" || c == 0x7f) return false;
        }
        return true;
    }

    function _isAsciiSpace(bytes1 c) private pure returns (bool) {
        return c == " " || c == "\t" || c == "\n" || c == "\r" || c == 0x0b || c == 0x0c;
    }
}
