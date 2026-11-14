// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedTokenizerAudits } from "../../interfaces/IAntseedTokenizerAudits.sol";
import { IAntseedVerificationResults } from "../../interfaces/IAntseedVerificationResults.sol";
import { AntseedResponseAuth } from "../../verification/AntseedResponseAuth.sol";
import { AntseedTokenizerAudits } from "../../verification/AntseedTokenizerAudits.sol";
import { AntseedVerificationResults } from "../../verification/AntseedVerificationResults.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockVerificationAudit } from "../mocks/MockVerificationAudit.sol";
import { MockVerificationEmissionsGate } from "../mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "../mocks/MockVerificationSellerPools.sol";

/// @dev Tokenizer audits against live-SAME reference sellers: what a proof must show, what it records (DIFF
///      or a usage flag), credits and points, and that nobody can frame a seller with prompts it did not read.
contract AntseedTokenizerAuditsTest is Test {
    uint256 private constant EPOCH = 5;
    uint256 private constant SUSPECT_KEY = 0xA11CE;
    uint256 private constant OTHER_KEY = 0xB0B;
    uint256[3] private REF_KEYS = [uint256(0xC1), 0xC2, 0xC3];
    string[3] private REF_SERVICES = ["glm-5.3", "z-ai/glm-5.3", "GLM-5.3"];
    string private constant SERVICE = "glm-5.3";
    bytes private constant CHAT_PATH = "/v1/chat/completions";
    bytes private constant HEAD = '{"model":"';
    bytes private constant MID = '","messages":[{"role":"user","content":"';
    bytes private constant TAIL = '"}],"max_tokens":64}';
    bytes private constant MESSAGES_PATH = "/v1/messages";
    bytes private constant MESSAGES_MID = '","max_tokens":64,"messages":[{"role":"user","content":"';
    bytes private constant MESSAGES_TAIL = '"}]}';
    int256 private constant MODEL_DELTA = 139;
    uint256 private constant BASE_TOKENS = 20;

    IAntseedVerificationResults.Verdict private constant SAME = IAntseedVerificationResults.Verdict.SAME;
    IAntseedVerificationResults.Verdict private constant DIFF = IAntseedVerificationResults.Verdict.DIFF;

    AntseedVerificationResults private results;
    AntseedTokenizerAudits private audits;
    MockVerificationAudit private kbf;
    MockERC8004Registry private identityRegistry;
    MockVerificationEmissionsGate private gate;
    MockVerificationSellerPools private pools;

    address private suspect;
    address private prover = address(0xF00D);
    address private buyer = address(0xB1);
    uint256 private suspectAgent;
    uint256[3] private refAgents;
    bytes32 private shapeId;
    bytes32 private messagesShapeId;
    bytes32 private modelHash = keccak256("glm-5.3");
    bytes32 private serviceHash = keccak256("glm-5.3");
    uint256 private nonce;
    uint64 private signedAt = 1_800_000_000_000;

    function setUp() public {
        vm.warp(1_800_000_000);
        identityRegistry = new MockERC8004Registry();
        gate = new MockVerificationEmissionsGate();
        gate.setEmissionsReserve(address(0x5E5E));
        pools = new MockVerificationSellerPools();
        gate.setCurrentEpoch(EPOCH - 1);
        results = new AntseedVerificationResults(address(gate));
        audits = new AntseedTokenizerAudits(address(results), address(pools), address(identityRegistry));
        kbf = new MockVerificationAudit(address(results));
        results.setAudit(address(audits), true);
        results.setAuditShareBps(address(audits), 9_000);
        results.setAudit(address(kbf), true);
        gate.setCurrentEpoch(EPOCH);
        gate.setBudget(address(results), EPOCH, 900 ether);
        results.setRewardsStartEpoch(address(audits), uint64(0));
        results.setMaxAuditorShareBps(address(audits), 10_000);

        suspect = vm.addr(SUSPECT_KEY);
        suspectAgent = _register(suspect);
        for (uint256 k = 0; k < 3; k++) {
            refAgents[k] = _register(vm.addr(REF_KEYS[k]));
            kbf.record(refAgents[k], audits.serviceHashOf(REF_SERVICES[k]), modelHash, SAME);
        }
        shapeId = audits.setShape(CHAT_PATH, HEAD, MID, TAIL, true);
        messagesShapeId = audits.setShape(MESSAGES_PATH, HEAD, MESSAGES_MID, MESSAGES_TAIL, true);
    }

    // ── outcomes ─────────────────────────────────────────────────────

    function test_unauditedSuspectGetsDiff() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.prank(prover);
        audits.proveTokenizerMismatch(modelHash, rounds);
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(DIFF));
        assertEq(results.serviceStatus(suspectAgent, serviceHash).audit, address(audits));
        assertEq(results.auditorEpochCredits(address(audits), EPOCH, prover), 1);
        assertEq(audits.liveFlags(suspectAgent), 0);
    }

    function test_sameSuspectGetsUsageFlagNotDiff() public {
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.prank(prover);
        audits.proveTokenizerMismatch(modelHash, rounds);
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(SAME), "KBF's SAME stays");
        assertEq(audits.liveFlags(suspectAgent), 1);
        IAntseedTokenizerAudits.Flag memory f = audits.flag(suspectAgent, serviceHash);
        assertEq(f.modelHash, modelHash);
        assertEq(f.validUntilEpoch, EPOCH + audits.validityEpochs());
        assertEq(results.auditorEpochCredits(address(audits), EPOCH, prover), 1);
    }

    function test_diffSuspectIsRefreshedWithoutCredit() public {
        kbf.record(suspectAgent, serviceHash, modelHash, DIFF);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.prank(prover);
        audits.proveTokenizerMismatch(modelHash, rounds);
        // Same DIFF, same epoch and expiry: the results layer keeps it as it was.
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(DIFF));
        assertEq(results.auditorEpochCredits(address(audits), EPOCH, prover), 0);
    }

    function test_anyoneCanProve() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.prank(makeAddr("stranger"));
        audits.proveTokenizerMismatch(modelHash, rounds);
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(DIFF));
    }

    // ── what a proof must show ───────────────────────────────────────

    function test_honestSuspectCannotBeProven() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, MODEL_DELTA + 2, MODEL_DELTA);
        vm.expectRevert(
            abi.encodeWithSelector(IAntseedTokenizerAudits.WithinTolerance.selector, 0, MODEL_DELTA + 2, MODEL_DELTA)
        );
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_everyRoundMustMismatch() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = new IAntseedTokenizerAudits.Round[](3);
        rounds[0] = _round(129, _refs(MODEL_DELTA));
        rounds[1] = _round(MODEL_DELTA, _refs(MODEL_DELTA));
        rounds[2] = _round(129, _refs(MODEL_DELTA));
        vm.expectRevert(
            abi.encodeWithSelector(IAntseedTokenizerAudits.WithinTolerance.selector, 1, MODEL_DELTA, MODEL_DELTA)
        );
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_referencesMustAgree() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        int256[] memory split = new int256[](3);
        (split[0], split[1], split[2]) = (MODEL_DELTA, MODEL_DELTA, 120);
        rounds[0] = _round(129, split);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.ReferencesDisagree.selector, 0));
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_needsEnoughRoundsAndReferences() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(2, 129, MODEL_DELTA);
        vm.expectRevert(IAntseedTokenizerAudits.InvalidRounds.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);

        rounds = _rounds(3, 129, MODEL_DELTA);
        IAntseedTokenizerAudits.ProbePair[] memory two = new IAntseedTokenizerAudits.ProbePair[](2);
        (two[0], two[1]) = (rounds[0].references[0], rounds[0].references[1]);
        rounds[0].references = two;
        vm.expectRevert(IAntseedTokenizerAudits.InvalidRounds.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_referencesMustBeLiveSameForTheModel() public {
        _mapSuspect();
        // Not audited.
        uint256 stranger = _register(vm.addr(OTHER_KEY));
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].references[2] = _pair(OTHER_KEY, SERVICE, rounds[0].a, rounds[0].b, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 2));
        audits.proveTokenizerMismatch(modelHash, rounds);

        // SAME, but for another model.
        kbf.record(stranger, serviceHash, keccak256("glm-5.2"), SAME);
        rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].references[2] = _pair(OTHER_KEY, SERVICE, rounds[0].a, rounds[0].b, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 2));
        audits.proveTokenizerMismatch(modelHash, rounds);

        // SAME verdicts that have expired.
        gate.setCurrentEpoch(EPOCH + 2);
        rounds = _rounds(3, 129, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 0));
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_referencesMustBeOtherDistinctSellers() public {
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].references[1] = rounds[0].references[0];
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 1));
        audits.proveTokenizerMismatch(modelHash, rounds);

        rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].references[2] = _pair(SUSPECT_KEY, SERVICE, rounds[0].a, rounds[0].b, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 2));
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_suspectServiceMustBeTheModel() public {
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.expectRevert(IAntseedTokenizerAudits.UnknownService.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
        // Audited as another model: the proof must use that model.
        kbf.record(suspectAgent, serviceHash, keccak256("glm-5.2"), SAME);
        vm.expectRevert(IAntseedTokenizerAudits.UnknownService.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    // ── nobody can frame a seller ────────────────────────────────────

    function test_suspectMustReadTheSamePromptAsReferences() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        // The suspect got a longer B than the references.
        rounds[0].suspect = _pair(SUSPECT_KEY, SERVICE, rounds[0].a, abi.encodePacked(rounds[0].b, " more"), 129);
        vm.expectRevert(IAntseedTokenizerAudits.NotProbePair.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_rejectsProbeInAFieldTheModelIgnores() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 0, MODEL_DELTA);
        bytes memory head = abi.encodePacked(HEAD, SERVICE, MID, rounds[0].a, '"}],"metadata":"');
        rounds[0].suspect.base = _receipt(SUSPECT_KEY, SERVICE, abi.encodePacked(head, '"}'), _usage(BASE_TOKENS));
        rounds[0].suspect.probed =
            _receipt(SUSPECT_KEY, SERVICE, abi.encodePacked(head, rounds[0].b, '"}'), _usage(BASE_TOKENS));
        vm.expectRevert(IAntseedTokenizerAudits.NotProbePair.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_contentMustStayInsideTheMessage() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].b = ' ","metadata":"x';
        vm.expectRevert(IAntseedTokenizerAudits.InvalidContent.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_pairsMayUseDifferentApis() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        for (uint256 i = 0; i < rounds.length; i++) {
            rounds[i].suspect = _messagesPair(SUSPECT_KEY, SERVICE, rounds[i].a, rounds[i].b, 129);
            rounds[i].references[1] = _messagesPair(REF_KEYS[1], REF_SERVICES[1], rounds[i].a, rounds[i].b, MODEL_DELTA);
        }
        vm.prank(prover);
        audits.proveTokenizerMismatch(modelHash, rounds);
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(DIFF));
    }

    function test_requestMustUseTheShapePath() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        // The Messages body sent to another endpoint: the seller may have read it differently.
        IAntseedTokenizerAudits.ProbePair memory pair = _messagesPair(SUSPECT_KEY, SERVICE, rounds[0].a, rounds[0].b, 129);
        pair.base = _receiptAt(
            SUSPECT_KEY,
            SERVICE,
            "/v1/responses",
            abi.encodePacked(HEAD, SERVICE, MESSAGES_MID, rounds[0].a, MESSAGES_TAIL),
            _anthropicUsage(BASE_TOKENS)
        );
        rounds[0].suspect = pair;
        vm.expectRevert(IAntseedTokenizerAudits.NotProbePair.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_everyPairNeedsAnActiveShape() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        audits.setShape(MESSAGES_PATH, HEAD, MESSAGES_MID, MESSAGES_TAIL, false);
        rounds[1].references[0] = _messagesPair(REF_KEYS[0], REF_SERVICES[0], rounds[1].a, rounds[1].b, MODEL_DELTA);
        vm.expectRevert(IAntseedTokenizerAudits.InvalidShape.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_listsShapesOnce() public {
        audits.setShape(CHAT_PATH, HEAD, MID, TAIL, false);
        bytes32[] memory ids = audits.shapeIds();
        assertEq(ids.length, 2);
        assertEq(ids[0], shapeId);
        assertEq(ids[1], messagesShapeId);
        assertFalse(audits.shape(shapeId).active);
        assertEq(audits.shape(messagesShapeId).path, MESSAGES_PATH);
    }

    function test_rejectsReceiptNotSignedBySeller() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[1].suspect.probed.signature = _sign(OTHER_KEY, rounds[1].suspect.probed);
        vm.expectRevert(IAntseedTokenizerAudits.BadSignature.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_rejectsEditedUsage() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, MODEL_DELTA, MODEL_DELTA);
        rounds[0].suspect.probed.response = _response(rounds[0].suspect.probed.requestId, _usage(BASE_TOKENS + 129));
        vm.expectRevert(IAntseedTokenizerAudits.BadSignature.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_roundMustBeSignedTogether() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        signedAt += 2 hours * 1000;
        rounds[0].references[2] = _pair(REF_KEYS[2], REF_SERVICES[2], rounds[0].a, rounds[0].b, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.RoundTooSpread.selector, 0));
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    function test_suspectReceiptsAreSingleUseReferencesAreNot() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        audits.proveTokenizerMismatch(modelHash, rounds);
        assertTrue(audits.receiptUsed(suspect, rounds[0].suspect.base.requestId));
        vm.expectRevert(IAntseedTokenizerAudits.ReceiptUsed.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);

        // The same reference rounds back a proof against another suspect.
        uint256 other = _register(vm.addr(OTHER_KEY));
        for (uint256 i = 0; i < 3; i++) {
            rounds[i].suspect = _pair(OTHER_KEY, SERVICE, rounds[i].a, rounds[i].b, 129);
        }
        audits.proveTokenizerMismatch(modelHash, rounds);
        assertEq(uint8(results.liveVerdict(other, serviceHash)), uint8(DIFF));
    }

    function test_agentOwnerCannotProveItsOwnAgent() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.prank(suspect);
        vm.expectRevert(IAntseedTokenizerAudits.SelfAudit.selector);
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    // ── points ───────────────────────────────────────────────────────

    function test_flagCutsSellerPointsUntilItExpires() public {
        audits.setPenaltyBps(1_000);
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        (uint256 before,) = audits.points(bytes32(0), buyer, suspect, 100, 100);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        audits.proveTokenizerMismatch(modelHash, rounds);
        (uint256 sellerPoints, uint256 buyerPoints) = audits.points(bytes32(0), buyer, suspect, 100, 100);
        assertEq(before, 100);
        assertEq(sellerPoints, 90);
        assertEq(buyerPoints, 100);
        gate.setCurrentEpoch(EPOCH + audits.validityEpochs());
        (sellerPoints,) = audits.points(bytes32(0), buyer, suspect, 100, 100);
        assertEq(sellerPoints, 100);
    }

    function test_clearFlag() public {
        audits.setPenaltyBps(1_000);
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        audits.proveTokenizerMismatch(modelHash, rounds);
        audits.clearFlag(suspectAgent, serviceHash);
        assertEq(audits.liveFlags(suspectAgent), 0);
        (uint256 sellerPoints,) = audits.points(bytes32(0), buyer, suspect, 100, 100);
        assertEq(sellerPoints, 100);
    }

    function test_aClearedFlagProvenAgainCountsOnce() public {
        audits.setPenaltyBps(1_000);
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA));
        audits.clearFlag(suspectAgent, serviceHash);
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA));
        assertEq(audits.liveFlags(suspectAgent), 1);
        (uint256 sellerPoints,) = audits.points(bytes32(0), buyer, suspect, 100, 100);
        assertEq(sellerPoints, 90);
    }

    function test_pointsNeverRevert() public {
        audits.setPenaltyBps(1_000);
        pools.setReverts(true);
        (uint256 sellerPoints, uint256 buyerPoints) = audits.points(bytes32(0), buyer, suspect, 100, 50);
        assertEq(sellerPoints, 100);
        assertEq(buyerPoints, 50);
    }

    // ── views and usage parsing ──────────────────────────────────────

    function test_resolveServices() public {
        kbf.record(suspectAgent, serviceHash, modelHash, DIFF);
        address[] memory sellers = new address[](2);
        string[] memory services = new string[](2);
        (sellers[0], services[0]) = (vm.addr(REF_KEYS[1]), REF_SERVICES[1]);
        (sellers[1], services[1]) = (suspect, SERVICE);
        (uint256[] memory agents, bytes32[] memory models, bool[] memory same) = audits.resolveServices(sellers, services);
        assertEq(agents[0], refAgents[1]);
        assertEq(models[0], modelHash);
        assertTrue(same[0]);
        assertEq(agents[1], suspectAgent);
        assertEq(models[1], modelHash);
        assertFalse(same[1]);
    }

    function test_readsAnthropicUsage() public view {
        (bool found, uint256 tokens) = audits.promptTokensOf(
            '{"type":"message","usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":1,"output_tokens":2}}'
        );
        assertTrue(found);
        assertEq(tokens, 16);
    }

    function test_ignoresKeysInsideStrings() public view {
        (bool found, uint256 tokens) = audits.promptTokensOf(
            '{"choices":[{"message":{"content":"\\"prompt_tokens\\": 999"}}],"usage":{"prompt_tokens":15,"prompt_tokens_details":{"cached_tokens":0}}}'
        );
        assertTrue(found);
        assertEq(tokens, 15);
    }

    function test_readsTopLevelUsageOnly() public view {
        // A Responses answer repeats `input_tokens` in per-item breakdowns and tool usage; only the top-level
        // `usage` counts.
        (bool found, uint256 tokens) = audits.promptTokensOf(
            '{"object":"response","output":[{"content":[{"text":"{\\"usage\\":{\\"input_tokens\\":7}}"}]}],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4},"output_tokens":3,"items":{"m":{"input_tokens":2}}},"tool_usage":{"image_gen":{"input_tokens":0}},"x":{"prompt_tokens":20}}'
        );
        assertTrue(found);
        assertEq(tokens, 12);
    }

    function test_rejectsAmbiguousUsage() public view {
        (bool found,) = audits.promptTokensOf('{"usage":{"prompt_tokens":15,"prompt_tokens":20}}');
        assertFalse(found, "a key twice in usage");
        (found,) = audits.promptTokensOf('{"usage":{"prompt_tokens":15},"usage":{"prompt_tokens":20}}');
        assertFalse(found, "two usage objects");
        (found,) = audits.promptTokensOf('{"x":{"usage":{"prompt_tokens":15}}}');
        assertFalse(found, "no top-level usage");
    }

    function test_serviceHashMatchesResultsKeys() public view {
        assertEq(audits.serviceHashOf("  GLM-5.3 "), keccak256("glm-5.3"));
    }

    // ── admin ────────────────────────────────────────────────────────

    function test_adminIsOwnerOnly() public {
        vm.startPrank(prover);
        vm.expectRevert();
        audits.setShape(CHAT_PATH, HEAD, MID, TAIL, true);
        vm.expectRevert();
        audits.setParameters(1, 1, 0, 1);
        vm.expectRevert();
        audits.setServiceModels(new bytes32[](0), modelHash);
        vm.expectRevert();
        audits.setPenaltyBps(1);
        vm.expectRevert();
        audits.clearFlag(suspectAgent, serviceHash);
        vm.stopPrank();
    }

    function test_parameterBounds() public {
        vm.expectRevert(IAntseedTokenizerAudits.InvalidValue.selector);
        audits.setParameters(0, 3, 2, 3600);
        vm.expectRevert(IAntseedTokenizerAudits.InvalidValue.selector);
        audits.setParameters(3, 9, 2, 3600);
        vm.expectRevert(IAntseedTokenizerAudits.InvalidValue.selector);
        audits.setPenaltyBps(10_001);
        vm.expectRevert(IAntseedTokenizerAudits.InvalidShape.selector);
        audits.setShape("", HEAD, MID, TAIL, true);
    }

    function testFuzz_honestSuspectNeverProves(uint32 delta, int8 drift) public {
        _mapSuspect();
        delta = uint32(bound(delta, 1, 100_000));
        int256 suspectDelta = int256(uint256(delta)) + bound(int256(drift), -2, 2);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, suspectDelta, int256(uint256(delta)));
        vm.expectRevert();
        audits.proveTokenizerMismatch(modelHash, rounds);
    }

    // ── helpers ──────────────────────────────────────────────────────

    function _register(address owner) private returns (uint256 id) {
        vm.prank(owner);
        id = identityRegistry.register();
        pools.setSeller(owner, id);
        pools.setPower(id, EPOCH, 100);
    }

    function _mapSuspect() private {
        bytes32[] memory services = new bytes32[](1);
        services[0] = serviceHash;
        audits.setServiceModels(services, modelHash);
    }

    function _refs(int256 delta) private pure returns (int256[] memory deltas) {
        deltas = new int256[](3);
        (deltas[0], deltas[1], deltas[2]) = (delta, delta, delta);
    }

    function _rounds(uint256 count, int256 suspectDelta, int256 referenceDelta)
        private
        returns (IAntseedTokenizerAudits.Round[] memory rounds)
    {
        rounds = new IAntseedTokenizerAudits.Round[](count);
        for (uint256 i = 0; i < count; i++) {
            rounds[i] = _round(suspectDelta, _refs(referenceDelta));
        }
    }

    function _round(int256 suspectDelta, int256[] memory referenceDeltas)
        private
        returns (IAntseedTokenizerAudits.Round memory round)
    {
        round.a = abi.encodePacked("Can you help me plan a trip to Lisbon #", bytes(vm.toString(++nonce)), "?");
        round.b = unicode" My budget is 450 € and my friend said “obrigado” 😅 — here is my plan: `trip.days = 9`";
        round.suspect = _pair(SUSPECT_KEY, SERVICE, round.a, round.b, suspectDelta);
        round.references = new IAntseedTokenizerAudits.ProbePair[](referenceDeltas.length);
        for (uint256 k = 0; k < referenceDeltas.length; k++) {
            round.references[k] = _pair(REF_KEYS[k], REF_SERVICES[k], round.a, round.b, referenceDeltas[k]);
        }
    }

    function _pair(uint256 key, string memory service, bytes memory a, bytes memory b, int256 delta)
        private
        returns (IAntseedTokenizerAudits.ProbePair memory pair)
    {
        pair.shapeId = shapeId;
        pair.base = _receipt(key, service, abi.encodePacked(HEAD, service, MID, a, TAIL), _usage(BASE_TOKENS));
        pair.probed = _receipt(
            key, service, abi.encodePacked(HEAD, service, MID, a, b, TAIL), _usage(uint256(int256(BASE_TOKENS) + delta))
        );
    }

    /// @dev A pair sent as Anthropic Messages, with Anthropic usage (fresh plus cached input).
    function _messagesPair(uint256 key, string memory service, bytes memory a, bytes memory b, int256 delta)
        private
        returns (IAntseedTokenizerAudits.ProbePair memory pair)
    {
        pair.shapeId = messagesShapeId;
        pair.base = _receiptAt(
            key, service, MESSAGES_PATH, abi.encodePacked(HEAD, service, MESSAGES_MID, a, MESSAGES_TAIL), _anthropicUsage(BASE_TOKENS)
        );
        pair.probed = _receiptAt(
            key,
            service,
            MESSAGES_PATH,
            abi.encodePacked(HEAD, service, MESSAGES_MID, a, b, MESSAGES_TAIL),
            _anthropicUsage(uint256(int256(BASE_TOKENS) + delta))
        );
    }

    function _receipt(uint256 key, string memory service, bytes memory requestBody, bytes memory responseBody)
        private
        returns (AntseedResponseAuth.Receipt memory)
    {
        return _receiptAt(key, service, CHAT_PATH, requestBody, responseBody);
    }

    function _receiptAt(
        uint256 key,
        string memory service,
        bytes memory path,
        bytes memory requestBody,
        bytes memory responseBody
    ) private returns (AntseedResponseAuth.Receipt memory receipt) {
        string memory requestId = string.concat("req-", vm.toString(++nonce));
        receipt.version = 1;
        receipt.requestId = requestId;
        receipt.channelId = "";
        receipt.buyer = buyer;
        receipt.seller = vm.addr(key);
        receipt.advertisedService = service;
        receipt.provider = "openai";
        receipt.statusCode = 200;
        receipt.responseStartedAt = signedAt;
        receipt.responseCompletedAt = signedAt + 900;
        receipt.request = _request(requestId, path, requestBody);
        receipt.response = _response(requestId, responseBody);
        receipt.signature = _sign(key, receipt);
    }

    function _sign(uint256 key, AntseedResponseAuth.Receipt memory receipt) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, audits.receiptDigest(receipt));
        return abi.encodePacked(r, s, v);
    }

    function _usage(uint256 promptTokens) private pure returns (bytes memory) {
        return abi.encodePacked(
            '{"choices":[{"message":{"content":"OK"}}],"usage":{"prompt_tokens":',
            bytes(vm.toString(promptTokens)),
            ',"completion_tokens":2}}'
        );
    }

    function _anthropicUsage(uint256 promptTokens) private pure returns (bytes memory) {
        // Half the prompt read from the cache: the contract adds it back.
        uint256 cached = promptTokens / 2;
        return abi.encodePacked(
            '{"content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":',
            bytes(vm.toString(promptTokens - cached)),
            ',"cache_creation_input_tokens":0,"cache_read_input_tokens":',
            bytes(vm.toString(cached)),
            ',"output_tokens":2}}'
        );
    }

    function _request(string memory requestId, bytes memory path, bytes memory body) private pure returns (bytes memory) {
        bytes memory method = "POST";
        return abi.encodePacked(
            uint16(bytes(requestId).length), requestId, uint8(method.length), method, uint16(path.length), path,
            _headers(), uint32(body.length), body
        );
    }

    function _response(string memory requestId, bytes memory body) private pure returns (bytes memory) {
        return abi.encodePacked(uint16(bytes(requestId).length), requestId, uint16(200), _headers(), uint32(body.length), body);
    }

    function _headers() private pure returns (bytes memory) {
        bytes memory key = "content-type";
        bytes memory value = "application/json";
        return abi.encodePacked(uint16(1), uint16(key.length), key, uint16(value.length), value);
    }
}
