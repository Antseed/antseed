// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedTokenizerAudits } from "../interfaces/IAntseedTokenizerAudits.sol";
import { IAntseedTokenizerProbeGuard } from "../interfaces/IAntseedTokenizerProbeGuard.sol";
import { IAntseedTokenizerUsageReader } from "../interfaces/IAntseedTokenizerUsageReader.sol";
import { IAntseedVerificationResults } from "../interfaces/IAntseedVerificationResults.sol";
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
///         round can be checked against many suspects). All suspect receipts name one buyer, whose EIP-712
///         `ProverAuth` must name the sender.
contract AntseedTokenizerAudits is IAntseedTokenizerAudits, Ownable2Step {
    uint8 public constant MAX_ROUNDS = 8;
    uint8 public constant MAX_REFERENCES = 8;
    /// @notice Most epochs a tokenizer DIFF or flag can count for, including the one it was given in.
    uint8 public constant MAX_VALIDITY_EPOCHS = 4;
    uint256 public constant MAX_SHAPE_BYTES = 1024;
    uint256 public constant MAX_CONTENT_BYTES = 4096;
    uint256 private constant BPS = 10_000;
    /// @dev How far a seller's clock may run ahead of the block's.
    uint256 private constant MAX_CLOCK_SKEW_SECONDS = 300;

    /// @dev EIP-712 domain `AntseedTokenizerAudits` version 1, built per call from the chain id and address.
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("AntseedTokenizerAudits");
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");
    bytes32 private constant PROVER_AUTH_TYPEHASH = keccak256("ProverAuth(address prover)");

    IAntseedVerificationResults public immutable override results;
    IAntseedSellerPools public override sellerPools;
    IAntseedTokenizerUsageReader public immutable override usageReader;
    IAntseedTokenizerProbeGuard public override probeGuard;

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

    /// @dev What every round of one proof is checked against: the suspect and the epoch it is proven in.
    struct Suspect {
        address seller;
        address buyer;
        uint256 agentId;
        bytes32 serviceHash;
        bytes32 modelHash;
        uint256 epoch;
    }

    constructor(address results_, address sellerPools_, address usageReader_, address probeGuard_)
        Ownable(msg.sender)
    {
        if (results_.code.length == 0 || usageReader_.code.length == 0) revert InvalidAddress();
        results = IAntseedVerificationResults(results_);
        usageReader = IAntseedTokenizerUsageReader(usageReader_);
        _setSellerPools(sellerPools_);
        _setProbeGuard(probeGuard_);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    function setSellerPools(address sellerPools_) external onlyOwner {
        _setSellerPools(sellerPools_);
    }

    /// @notice Replaces the guard that decides which probe content B a proof may measure.
    function setProbeGuard(address probeGuard_) external onlyOwner {
        _setProbeGuard(probeGuard_);
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
    ///         (plus the allowed clock skew) can flag the service again.
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
    function proveTokenizerMismatch(bytes32 modelHash, Round[] calldata rounds, bytes calldata buyerSignature)
        external
        override
    {
        // A revoked audit records nothing, flags included (they never reach the results layer's own check).
        if (!results.isAudit(address(this))) revert NotApprovedAudit();
        uint256 count = rounds.length;
        if (modelHash == bytes32(0) || count < minRounds || count > MAX_ROUNDS) revert InvalidRounds();
        // The buyer that collected the suspect receipts names who proves with them, so a copy of a pending
        // proof sent from another address reverts.
        AntseedResponseAuth.Receipt calldata first = rounds[0].suspect.base;
        if (!_signedBy(proverAuthDigest(msg.sender), buyerSignature, first.buyer)) revert NotAuthorizedProver();

        Suspect memory suspect = Suspect({
            seller: first.seller,
            buyer: first.buyer,
            agentId: _agentIdForSeller(first.seller),
            serviceHash: serviceHashOf(first.advertisedService),
            modelHash: modelHash,
            epoch: results.currentEpoch()
        });
        if (suspect.agentId == 0) revert UnknownAgent();
        IAntseedVerificationResults.Verdict live = results.liveVerdict(suspect.agentId, suspect.serviceHash);
        if (_modelOf(suspect.agentId, suspect.serviceHash, live) != modelHash) revert UnknownService();

        int256[] memory suspectDeltas = new int256[](count);
        int256[] memory referenceMins = new int256[](count);
        int256[] memory referenceMaxes = new int256[](count);
        for (uint256 i = 0; i < count; i++) {
            (suspectDeltas[i], referenceMins[i], referenceMaxes[i]) = _checkRound(i, rounds[i], suspect);
        }

        uint256 validUntil = suspect.epoch + validityEpochs;
        bool misreported = live == IAntseedVerificationResults.Verdict.SAME;
        bool isNew;
        if (misreported) {
            Flag storage existing = _flags[suspect.agentId][suspect.serviceHash];
            isNew = existing.validUntilEpoch <= suspect.epoch;
            if (existing.validUntilEpoch == 0) _flaggedServices[suspect.agentId].push(suspect.serviceHash);
            _flags[suspect.agentId][suspect.serviceHash] = Flag(modelHash, uint64(suspect.epoch), uint64(validUntil));
        } else {
            isNew = live != IAntseedVerificationResults.Verdict.DIFF;
        }
        emit TokenizerMismatchProven(
            suspect.agentId,
            suspect.serviceHash,
            msg.sender,
            suspect.seller,
            modelHash,
            misreported,
            suspect.epoch,
            suspectDeltas,
            referenceMins,
            referenceMaxes
        );
        if (!misreported) {
            results.record(
                suspect.agentId, suspect.serviceHash, modelHash, IAntseedVerificationResults.Verdict.DIFF, validUntil
            );
        }

        // The results layer emits `Credited` for what it gives.
        uint32 credits = creditsPerProof;
        if (isNew && credits != 0 && _hasPoolPower(suspect.agentId, suspect.epoch)) results.credit(msg.sender, credits);
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
        uint256 epoch = results.currentEpoch();
        for (uint256 i = 0; i < sellers.length; i++) {
            uint256 agentId = _agentIdForSeller(sellers[i]);
            agentIds[i] = agentId;
            bytes32 serviceHash = serviceHashOf(services[i]);
            IAntseedVerificationResults.Verdict live = agentId == 0
                ? IAntseedVerificationResults.Verdict.NONE
                : results.liveVerdict(agentId, serviceHash);
            modelHashes[i] = _modelOf(agentId, serviceHash, live);
            liveSame[i] = live == IAntseedVerificationResults.Verdict.SAME
                && _flags[agentId][serviceHash].validUntilEpoch <= epoch;
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

    /// @inheritdoc IAntseedTokenizerAudits
    function proverAuthDigest(address prover) public view override returns (bytes32) {
        bytes32 domain =
            keccak256(abi.encode(DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this)));
        return MessageHashUtils.toTypedDataHash(domain, keccak256(abi.encode(PROVER_AUTH_TYPEHASH, prover)));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Checks one round and returns the suspect's delta and the references' range.
    function _checkRound(uint256 index, Round calldata round, Suspect memory suspect)
        private
        returns (int256 suspectDelta, int256 referenceMin, int256 referenceMax)
    {
        if (
            round.b.length == 0 || round.a.length + round.b.length > MAX_CONTENT_BYTES || !_isJsonStringSafe(round.a)
                || !_isJsonStringSafe(round.b)
        ) revert InvalidContent();
        if (!probeGuard.isSafeProbe(round.b)) revert UnsafeProbe(index);
        uint256 refCount = round.references.length;
        if (refCount < minReferences || refCount > MAX_REFERENCES) revert InvalidRounds();

        if (serviceHashOf(round.suspect.base.advertisedService) != suspect.serviceHash) revert DifferentService();
        uint64 firstAt;
        uint64 lastAt;
        (suspectDelta, firstAt, lastAt) = _checkPair(round.suspect, round.a, round.b, suspect.seller, suspect.buyer);
        uint256 clearedAt = flagClearedAt[suspect.agentId][suspect.serviceHash];
        // Receipts may run up to the clock skew ahead of the block, so a clear also covers that window.
        if (clearedAt != 0 && uint256(firstAt) <= (clearedAt + MAX_CLOCK_SKEW_SECONDS) * 1000) {
            revert StaleEvidence(index);
        }

        uint256[] memory agents = new uint256[](refCount);
        for (uint256 k = 0; k < refCount; k++) {
            ProbePair calldata pair = round.references[k];
            agents[k] = _referenceAgent(index, k, pair, suspect, agents);
            (int256 delta, uint64 pairFirstAt, uint64 pairLastAt) =
                _checkPair(pair, round.a, round.b, pair.base.seller, address(0));
            if (k == 0 || delta < referenceMin) referenceMin = delta;
            if (k == 0 || delta > referenceMax) referenceMax = delta;
            if (pairFirstAt < firstAt) firstAt = pairFirstAt;
            if (pairLastAt > lastAt) lastAt = pairLastAt;
        }
        int256 allowed = int256(uint256(tolerance));
        // The references agree when their whole range fits in `tolerance`, whatever their order.
        if (referenceMax - referenceMin > allowed) revert ReferencesDisagree(index);
        if (uint256(lastAt - firstAt) > uint256(maxRoundSpreadSeconds) * 1000) revert RoundTooSpread(index);
        uint256 nowMs = block.timestamp * 1000;
        if (uint256(firstAt) + uint256(maxEvidenceAgeSeconds) * 1000 < nowMs) revert StaleEvidence(index);
        if (uint256(lastAt) > nowMs + MAX_CLOCK_SKEW_SECONDS * 1000) revert FutureEvidence(index);
        // A mismatch is a suspect delta more than `tolerance` outside the references' range.
        if (suspectDelta + allowed >= referenceMin && suspectDelta <= referenceMax + allowed) {
            revert WithinTolerance(index, suspectDelta, referenceMin, referenceMax);
        }
    }

    /// @dev A reference is another seller and agent, not repeated in the round, whose service has a live SAME
    ///      for the suspect's model and no live usage flag (its signed usage is known to be wrong).
    function _referenceAgent(
        uint256 index,
        uint256 k,
        ProbePair calldata pair,
        Suspect memory suspect,
        uint256[] memory earlier
    ) private view returns (uint256 agentId) {
        address seller = pair.base.seller;
        agentId = _agentIdForSeller(seller);
        if (agentId == 0 || agentId == suspect.agentId || seller == suspect.seller) revert NotAReference(index, k);
        for (uint256 j = 0; j < k; j++) {
            if (earlier[j] == agentId) revert NotAReference(index, k);
        }
        bytes32 serviceHash = serviceHashOf(pair.base.advertisedService);
        if (
            results.liveVerdict(agentId, serviceHash) != IAntseedVerificationResults.Verdict.SAME
                || results.serviceStatus(agentId, serviceHash).modelHash != suspect.modelHash
                || _flags[agentId][serviceHash].validUntilEpoch > suspect.epoch
        ) revert NotAReference(index, k);
    }

    /// @dev Both receipts signed by `seller` for the same service, HTTP 200, requests exactly the pair's
    ///      active shape with content A and A + B, and a readable usage field. A suspect pair (`buyer` set) must
    ///      name `buyer` and is marked used; a reference pair (`buyer` zero) may come from any buyer. Returns
    ///      the pair's delta and its earliest and latest signed start (ms).
    function _checkPair(
        ProbePair calldata pair,
        bytes calldata a,
        bytes calldata b,
        address seller,
        address buyer
    ) private returns (int256 delta, uint64 firstAt, uint64 lastAt) {
        bytes memory service = bytes(pair.base.advertisedService);
        if (keccak256(service) != keccak256(bytes(pair.probed.advertisedService))) revert DifferentService();
        uint256 baseTokens = _checkReceipt(pair.base, seller, buyer);
        uint256 probedTokens = _checkReceipt(pair.probed, seller, buyer);
        Shape storage shape_ = _shapes[pair.shapeId];
        if (!shape_.active) revert InvalidShape();
        bytes32 path = keccak256(shape_.path);
        _checkRequest(pair.base.request, path, keccak256(abi.encodePacked(shape_.head, service, shape_.mid, a, shape_.tail)));
        _checkRequest(
            pair.probed.request, path, keccak256(abi.encodePacked(shape_.head, service, shape_.mid, a, b, shape_.tail))
        );
        delta = int256(probedTokens) - int256(baseTokens);
        (firstAt, lastAt) = pair.base.responseStartedAt <= pair.probed.responseStartedAt
            ? (pair.base.responseStartedAt, pair.probed.responseStartedAt)
            : (pair.probed.responseStartedAt, pair.base.responseStartedAt);
    }

    function _checkRequest(bytes calldata request, bytes32 path, bytes32 body) private pure {
        (uint256 pathStart, uint256 pathLength, uint256 bodyStart, uint256 bodyLength) =
            AntseedResponseAuth.requestPathAndBody(request);
        if (
            AntseedResponseAuth.hashCalldata(request[pathStart:pathStart + pathLength]) != path
                || AntseedResponseAuth.hashCalldata(request[bodyStart:bodyStart + bodyLength]) != body
        ) revert NotProbePair();
    }

    function _checkReceipt(AntseedResponseAuth.Receipt calldata receipt, address seller, address buyer)
        private
        returns (uint256 tokens)
    {
        if (receipt.seller != seller) revert DifferentService();
        if (buyer != address(0) && receipt.buyer != buyer) revert DifferentBuyer();
        if (receipt.statusCode != 200) revert NotOk();
        if (!_signedBy(AntseedResponseAuth.digest(receipt), receipt.signature, seller)) revert BadSignature();
        if (buyer != address(0)) {
            bytes32 key = _receiptKey(seller, receipt.requestId);
            if (_usedReceipts[key]) revert ReceiptUsed();
            _usedReceipts[key] = true;
        }
        (uint16 status, uint256 start, uint256 length) = AntseedResponseAuth.responseBody(receipt.response);
        if (status != 200) revert NotOk();
        bool found;
        (found, tokens) = usageReader.promptTokensOf(receipt.response[start:start + length]);
        if (!found) revert UsageNotFound();
    }

    function _signedBy(bytes32 digest, bytes calldata signature, address signer) private pure returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && recovered == signer && signer != address(0);
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

    function _setProbeGuard(address probeGuard_) private {
        if (probeGuard_.code.length == 0) revert InvalidAddress();
        probeGuard = IAntseedTokenizerProbeGuard(probeGuard_);
        emit ProbeGuardSet(probeGuard_);
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
