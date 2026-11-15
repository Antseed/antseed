// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedTokenizerAudits } from "../../interfaces/IAntseedTokenizerAudits.sol";
import { IAntseedVerificationResults } from "../../interfaces/IAntseedVerificationResults.sol";
import { AntseedResponseAuth } from "../../verification/AntseedResponseAuth.sol";
import { AntseedTokenizerAudits } from "../../verification/AntseedTokenizerAudits.sol";
import { AntseedTokenizerProbeGuard } from "../../verification/AntseedTokenizerProbeGuard.sol";
import { AntseedTokenizerUsageReader } from "../../verification/AntseedTokenizerUsageReader.sol";
import { AntseedVerificationResults } from "../../verification/AntseedVerificationResults.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { ResponseAuthHarness } from "../mocks/ResponseAuthHarness.sol";
import { MockVerificationAudit } from "../mocks/MockVerificationAudit.sol";
import { MockVerificationEmissionsGate } from "../mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "../mocks/MockVerificationSellerPools.sol";

/// @dev Tokenizer audits against live-SAME reference sellers: what a proof must show, what it records (DIFF
///      or a usage flag), credits and points, and that nobody can frame a seller with prompts it did not read.
contract AntseedTokenizerAuditsTest is Test {
    uint256 private constant EPOCH = 5;
    uint256 private constant SUSPECT_KEY = 0xA11CE;
    uint256 private constant OTHER_KEY = 0xB0B;
    uint256 private constant BUYER_KEY = 0xB1;
    uint256 private constant OTHER_BUYER_KEY = 0xB2;
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
    ResponseAuthHarness private responseAuth = new ResponseAuthHarness();

    address private suspect;
    address private prover = address(0xF00D);
    address private buyer = vm.addr(BUYER_KEY);
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
        audits = new AntseedTokenizerAudits(
            address(results), address(pools), address(identityRegistry), address(new AntseedTokenizerUsageReader()), address(new AntseedTokenizerProbeGuard())
        );
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
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(prover));
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(DIFF));
        assertEq(results.serviceStatus(suspectAgent, serviceHash).audit, address(audits));
        assertEq(results.auditorEpochCredits(address(audits), EPOCH, prover), 1);
        assertEq(audits.liveFlags(suspectAgent), 0);
    }

    function test_sameSuspectGetsUsageFlagNotDiff() public {
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.prank(prover);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(prover));
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
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(prover));
        // Same DIFF, same epoch and expiry: the results layer keeps it as it was.
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(DIFF));
        assertEq(results.auditorEpochCredits(address(audits), EPOCH, prover), 0);
    }

    function test_anyoneCanProve() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(stranger));
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(DIFF));
    }

    // ── who may prove ────────────────────────────────────────────────

    function test_aCopyOfAPendingProofCannotTakeItsCredit() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        bytes memory signature = _auth(prover);
        address copier = makeAddr("copier");
        vm.prank(copier);
        vm.expectRevert(IAntseedTokenizerAudits.NotAuthorizedProver.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, signature);

        vm.prank(prover);
        audits.proveTokenizerMismatch(modelHash, rounds, signature);
        assertEq(results.auditorEpochCredits(address(audits), EPOCH, prover), 1);
        assertEq(results.auditorEpochCredits(address(audits), EPOCH, copier), 0);
    }

    function test_onlyTheSuspectReceiptsBuyerAuthorizesAProver() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        bytes memory otherBuyers = _authBy(OTHER_BUYER_KEY, prover);
        vm.prank(prover);
        vm.expectRevert(IAntseedTokenizerAudits.NotAuthorizedProver.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, otherBuyers);

        vm.prank(prover);
        vm.expectRevert(IAntseedTokenizerAudits.NotAuthorizedProver.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, "");
    }

    function test_suspectReceiptsNameOneBuyer() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        address original = buyer;
        buyer = vm.addr(OTHER_BUYER_KEY);
        rounds[2].suspect = _pair(SUSPECT_KEY, SERVICE, rounds[2].a, rounds[2].b, 129);
        buyer = original;
        vm.prank(prover);
        vm.expectRevert(IAntseedTokenizerAudits.DifferentBuyer.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(prover));
    }

    function test_referencesMayComeFromAnyBuyer() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        address original = buyer;
        buyer = vm.addr(OTHER_BUYER_KEY);
        for (uint256 i = 0; i < rounds.length; i++) {
            rounds[i].references[0] = _pair(REF_KEYS[0], REF_SERVICES[0], rounds[i].a, rounds[i].b, MODEL_DELTA);
        }
        buyer = original;
        vm.prank(prover);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(prover));
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(DIFF));
    }

    function test_proverAuthDigestIsEip712() public view {
        assertEq(audits.proverAuthDigest(prover), _proverAuthDigest(prover));
    }

    // ── what a proof must show ───────────────────────────────────────

    function test_honestSuspectCannotBeProven() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, MODEL_DELTA + 2, MODEL_DELTA);
        vm.expectRevert(
            abi.encodeWithSelector(IAntseedTokenizerAudits.WithinTolerance.selector, 0, MODEL_DELTA + 2, MODEL_DELTA, MODEL_DELTA
            )
        );
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_everyRoundMustMismatch() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = new IAntseedTokenizerAudits.Round[](3);
        rounds[0] = _round(129, _refs(MODEL_DELTA));
        rounds[1] = _round(MODEL_DELTA, _refs(MODEL_DELTA));
        rounds[2] = _round(129, _refs(MODEL_DELTA));
        vm.expectRevert(
            abi.encodeWithSelector(IAntseedTokenizerAudits.WithinTolerance.selector, 1, MODEL_DELTA, MODEL_DELTA, MODEL_DELTA
            )
        );
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_referencesMustAgree() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        int256[] memory split = new int256[](3);
        (split[0], split[1], split[2]) = (MODEL_DELTA, MODEL_DELTA, 120);
        rounds[0] = _round(129, split);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.ReferencesDisagree.selector, 0));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_referencesAgreeOnlyWhenTheirWholeRangeFits() public {
        _mapSuspect();
        // Each is within tolerance (2) of the first, but the range is 4: no order makes them agree.
        int256[3][3] memory orders = [
            [MODEL_DELTA, MODEL_DELTA + 2, MODEL_DELTA - 2],
            [MODEL_DELTA + 2, MODEL_DELTA - 2, MODEL_DELTA],
            [MODEL_DELTA - 2, MODEL_DELTA, MODEL_DELTA + 2]
        ];
        for (uint256 o = 0; o < orders.length; o++) {
            IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
            rounds[0] = _round(129, _deltas(orders[o]));
            vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.ReferencesDisagree.selector, 0));
            audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
        }
    }

    function test_suspectWithinToleranceOfAnyReferenceIsNoMismatch() public {
        _mapSuspect();
        // References MODEL_DELTA - 1 .. MODEL_DELTA + 1; a suspect at MODEL_DELTA + 3 is within tolerance of the
        // largest, in every order.
        int256[3][2] memory orders =
            [[MODEL_DELTA - 1, MODEL_DELTA, MODEL_DELTA + 1], [MODEL_DELTA + 1, MODEL_DELTA - 1, MODEL_DELTA]];
        for (uint256 o = 0; o < orders.length; o++) {
            IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, MODEL_DELTA + 3, MODEL_DELTA);
            rounds[0] = _round(MODEL_DELTA + 3, _deltas(orders[o]));
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAntseedTokenizerAudits.WithinTolerance.selector, 0, MODEL_DELTA + 3, MODEL_DELTA - 1, MODEL_DELTA + 1
                )
            );
            audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
        }
    }

    function test_evidenceMustBeFromTheLastDay() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.StaleEvidence.selector, 0));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));

        vm.warp(block.timestamp - 2);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_evidenceCannotBeFromTheFuture() public {
        _mapSuspect();
        signedAt += 10 minutes * 1000;
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.FutureEvidence.selector, 0));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_evidenceFromBeforeAClearCannotFlagAgain() public {
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA), _auth(address(this)));
        IAntseedTokenizerAudits.Round[] memory archived = _rounds(3, 129, MODEL_DELTA);
        vm.warp(block.timestamp + 1 hours);
        audits.clearFlag(suspectAgent, serviceHash);
        assertEq(audits.flagClearedAt(suspectAgent, serviceHash), block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.StaleEvidence.selector, 0));
        audits.proveTokenizerMismatch(modelHash, archived, _auth(address(this)));

        _signAfterClear();
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA), _auth(address(this)));
        assertEq(audits.liveFlags(suspectAgent), 1);
    }

    function test_evidenceSignedAheadOfAClearCannotFlagAgain() public {
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA), _auth(address(this)));
        // A seller clock 4 minutes ahead: accepted as not from the future, yet collected before the clear.
        signedAt = uint64((block.timestamp + 4 minutes) * 1000);
        IAntseedTokenizerAudits.Round[] memory archived = _rounds(3, 129, MODEL_DELTA);
        audits.clearFlag(suspectAgent, serviceHash);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.StaleEvidence.selector, 0));
        audits.proveTokenizerMismatch(modelHash, archived, _auth(address(this)));
    }

    function test_maxEvidenceAge() public {
        assertEq(audits.maxEvidenceAgeSeconds(), 1 days);
        vm.expectRevert(IAntseedTokenizerAudits.InvalidValue.selector);
        audits.setMaxEvidenceAge(0);
        audits.setMaxEvidenceAge(2 hours);
        assertEq(audits.maxEvidenceAgeSeconds(), 2 hours);
        vm.prank(prover);
        vm.expectRevert();
        audits.setMaxEvidenceAge(1 days);
    }

    function test_needsEnoughRoundsAndReferences() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(2, 129, MODEL_DELTA);
        vm.expectRevert(IAntseedTokenizerAudits.InvalidRounds.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));

        rounds = _rounds(3, 129, MODEL_DELTA);
        IAntseedTokenizerAudits.ProbePair[] memory two = new IAntseedTokenizerAudits.ProbePair[](2);
        (two[0], two[1]) = (rounds[0].references[0], rounds[0].references[1]);
        rounds[0].references = two;
        vm.expectRevert(IAntseedTokenizerAudits.InvalidRounds.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_referencesMustBeLiveSameForTheModel() public {
        _mapSuspect();
        // Not audited.
        uint256 stranger = _register(vm.addr(OTHER_KEY));
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].references[2] = _pair(OTHER_KEY, SERVICE, rounds[0].a, rounds[0].b, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 2));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));

        // SAME, but for another model.
        kbf.record(stranger, serviceHash, keccak256("glm-5.2"), SAME);
        rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].references[2] = _pair(OTHER_KEY, SERVICE, rounds[0].a, rounds[0].b, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 2));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));

        // SAME verdicts that have expired.
        gate.setCurrentEpoch(EPOCH + 2);
        rounds = _rounds(3, 129, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 0));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_aRevokedAuditProvesNothing() public {
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA), _auth(address(this)));
        results.setAudit(address(audits), false);

        // Refreshing a live flag earns no credit, so it never reached the results layer's own check.
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.expectRevert(IAntseedTokenizerAudits.NotApprovedAudit.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));

        // Nor does a new flag with credits turned off.
        audits.clearFlag(suspectAgent, serviceHash);
        audits.setCreditsPerProof(0);
        signedAt += 1000;
        rounds = _rounds(3, 129, MODEL_DELTA);
        vm.expectRevert(IAntseedTokenizerAudits.NotApprovedAudit.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_aUsageFlaggedServiceIsNoReference() public {
        // Flag reference 0's service: it misreports against the stranger and references 1 and 2.
        uint256 stranger = _register(vm.addr(OTHER_KEY));
        kbf.record(stranger, serviceHash, modelHash, SAME);
        IAntseedTokenizerAudits.Round[] memory rounds = new IAntseedTokenizerAudits.Round[](3);
        for (uint256 i = 0; i < 3; i++) {
            rounds[i] = _round(MODEL_DELTA, _refs(MODEL_DELTA));
            rounds[i].suspect = _pair(REF_KEYS[0], REF_SERVICES[0], rounds[i].a, rounds[i].b, 152);
            rounds[i].references[0] = _pair(OTHER_KEY, SERVICE, rounds[i].a, rounds[i].b, MODEL_DELTA);
        }
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
        assertEq(audits.liveFlags(refAgents[0]), 1);

        address[] memory sellers = new address[](1);
        string[] memory services = new string[](1);
        (sellers[0], services[0]) = (vm.addr(REF_KEYS[0]), REF_SERVICES[0]);
        (,, bool[] memory same) = audits.resolveServices(sellers, services);
        assertFalse(same[0], "a flagged service is not offered as a reference");

        _mapSuspect();
        rounds = _rounds(3, 129, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 0));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_referencesMustBeOtherDistinctSellers() public {
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].references[1] = rounds[0].references[0];
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 1));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));

        rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].references[2] = _pair(SUSPECT_KEY, SERVICE, rounds[0].a, rounds[0].b, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.NotAReference.selector, 0, 2));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_suspectServiceMustBeTheModel() public {
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.expectRevert(IAntseedTokenizerAudits.UnknownService.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
        // Audited as another model: the proof must use that model.
        kbf.record(suspectAgent, serviceHash, keccak256("glm-5.2"), SAME);
        vm.expectRevert(IAntseedTokenizerAudits.UnknownService.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    // ── nobody can frame a seller ────────────────────────────────────

    function test_suspectMustReadTheSamePromptAsReferences() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        // The suspect got a longer B than the references.
        rounds[0].suspect = _pair(SUSPECT_KEY, SERVICE, rounds[0].a, abi.encodePacked(rounds[0].b, " more"), 129);
        vm.expectRevert(IAntseedTokenizerAudits.NotProbePair.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_rejectsProbeInAFieldTheModelIgnores() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 0, MODEL_DELTA);
        bytes memory head = abi.encodePacked(HEAD, SERVICE, MID, rounds[0].a, '"}],"metadata":"');
        rounds[0].suspect.base = _receipt(SUSPECT_KEY, SERVICE, abi.encodePacked(head, '"}'), _usage(BASE_TOKENS));
        rounds[0].suspect.probed =
            _receipt(SUSPECT_KEY, SERVICE, abi.encodePacked(head, rounds[0].b, '"}'), _usage(BASE_TOKENS));
        vm.expectRevert(IAntseedTokenizerAudits.NotProbePair.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_contentMustStayInsideTheMessage() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        rounds[0].b = ' ","metadata":"x';
        vm.expectRevert(IAntseedTokenizerAudits.InvalidContent.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_pairsMayUseDifferentApis() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        for (uint256 i = 0; i < rounds.length; i++) {
            rounds[i].suspect = _messagesPair(SUSPECT_KEY, SERVICE, rounds[i].a, rounds[i].b, 129);
            rounds[i].references[1] = _messagesPair(REF_KEYS[1], REF_SERVICES[1], rounds[i].a, rounds[i].b, MODEL_DELTA);
        }
        vm.prank(prover);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(prover));
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
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_everyPairNeedsAnActiveShape() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        audits.setShape(MESSAGES_PATH, HEAD, MESSAGES_MID, MESSAGES_TAIL, false);
        rounds[1].references[0] = _messagesPair(REF_KEYS[0], REF_SERVICES[0], rounds[1].a, rounds[1].b, MODEL_DELTA);
        vm.expectRevert(IAntseedTokenizerAudits.InvalidShape.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
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
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_rejectsEditedUsage() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, MODEL_DELTA, MODEL_DELTA);
        rounds[0].suspect.probed.response = _response(rounds[0].suspect.probed.requestId, _usage(BASE_TOKENS + 129));
        vm.expectRevert(IAntseedTokenizerAudits.BadSignature.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_roundMustBeSignedTogether() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        signedAt += 2 hours * 1000;
        rounds[0].references[2] = _pair(REF_KEYS[2], REF_SERVICES[2], rounds[0].a, rounds[0].b, MODEL_DELTA);
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.RoundTooSpread.selector, 0));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_suspectReceiptsAreSingleUseReferencesAreNot() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
        assertTrue(audits.receiptUsed(suspect, rounds[0].suspect.base.requestId));
        vm.expectRevert(IAntseedTokenizerAudits.ReceiptUsed.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));

        // The same reference rounds back a proof against another suspect.
        uint256 other = _register(vm.addr(OTHER_KEY));
        for (uint256 i = 0; i < 3; i++) {
            rounds[i].suspect = _pair(OTHER_KEY, SERVICE, rounds[i].a, rounds[i].b, 129);
        }
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
        assertEq(uint8(results.liveVerdict(other, serviceHash)), uint8(DIFF));
    }

    function test_agentOwnerCannotProveItsOwnAgent() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        vm.prank(suspect);
        vm.expectRevert(IAntseedTokenizerAudits.SelfAudit.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(suspect));
    }

    // ── points ───────────────────────────────────────────────────────

    function test_flagCutsSellerPointsUntilItExpires() public {
        audits.setPenaltyBps(1_000);
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        (uint256 before,) = audits.points(bytes32(0), buyer, suspect, 100, 100);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
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
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
        audits.clearFlag(suspectAgent, serviceHash);
        assertEq(audits.liveFlags(suspectAgent), 0);
        (uint256 sellerPoints,) = audits.points(bytes32(0), buyer, suspect, 100, 100);
        assertEq(sellerPoints, 100);
    }

    function test_aClearedFlagProvenAgainCountsOnce() public {
        audits.setPenaltyBps(1_000);
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA), _auth(address(this)));
        audits.clearFlag(suspectAgent, serviceHash);
        _signAfterClear();
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA), _auth(address(this)));
        assertEq(audits.liveFlags(suspectAgent), 1);
        (uint256 sellerPoints,) = audits.points(bytes32(0), buyer, suspect, 100, 100);
        assertEq(sellerPoints, 90);
    }

    function test_pointsNeverRevert() public {
        audits.setPenaltyBps(1_000);
        kbf.record(suspectAgent, serviceHash, modelHash, SAME);
        audits.proveTokenizerMismatch(modelHash, _rounds(3, 129, MODEL_DELTA), _auth(address(this)));
        (uint256 sellerPoints, uint256 buyerPoints) = audits.points(bytes32(0), buyer, suspect, 100, 50);
        assertEq(sellerPoints, 90, "the live flag applies");

        vm.mockCallRevert(address(pools), abi.encodeWithSelector(pools.agentIdForSeller.selector), "pools down");
        (sellerPoints, buyerPoints) = audits.points(bytes32(0), buyer, suspect, 100, 50);
        assertEq(sellerPoints, 100, "a failing seller lookup leaves points unchanged");
        assertEq(buyerPoints, 50);
        vm.clearMockedCalls();

        vm.mockCallRevert(address(results), abi.encodeWithSelector(results.currentEpoch.selector), "results down");
        (sellerPoints, buyerPoints) = audits.points(bytes32(0), buyer, suspect, 100, 50);
        assertEq(sellerPoints, 100, "a failing epoch read leaves points unchanged");
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
        (bool found, uint256 tokens) = audits.usageReader().promptTokensOf(
            '{"type":"message","usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":1,"output_tokens":2}}'
        );
        assertTrue(found);
        assertEq(tokens, 16);
    }

    function test_ignoresKeysInsideStrings() public view {
        (bool found, uint256 tokens) = audits.usageReader().promptTokensOf(
            '{"choices":[{"message":{"content":"\\"prompt_tokens\\": 999"}}],"usage":{"prompt_tokens":15,"prompt_tokens_details":{"cached_tokens":0}}}'
        );
        assertTrue(found);
        assertEq(tokens, 15);
    }

    function test_readsTopLevelUsageOnly() public view {
        // A Responses answer repeats `input_tokens` in per-item breakdowns and tool usage; only the top-level
        // `usage` counts.
        (bool found, uint256 tokens) = audits.usageReader().promptTokensOf(
            '{"object":"response","output":[{"content":[{"text":"{\\"usage\\":{\\"input_tokens\\":7}}"}]}],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4},"output_tokens":3,"items":{"m":{"input_tokens":2}}},"tool_usage":{"image_gen":{"input_tokens":0}},"x":{"prompt_tokens":20}}'
        );
        assertTrue(found);
        assertEq(tokens, 12);
    }

    function test_rejectsAmbiguousUsage() public view {
        (bool found,) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens":15,"prompt_tokens":20}}');
        assertFalse(found, "a key twice in usage");
        (found,) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens":15},"usage":{"prompt_tokens":20}}');
        assertFalse(found, "two usage objects");
        (found,) = audits.usageReader().promptTokensOf('{"x":{"usage":{"prompt_tokens":15}}}');
        assertFalse(found, "no top-level usage");
    }

    function test_readsUsageAsTheBuyerDoes() public view {
        (bool found, uint256 tokens) =
            audits.usageReader().promptTokensOf('{"usage":{"input_tokens":150,"output_tokens":75,"prompt_cache_hit_tokens":600}}');
        assertTrue(found);
        assertEq(tokens, 750, "prompt_cache_hit_tokens is cached input, added like cache_read_input_tokens");
        (, tokens) = audits.usageReader().promptTokensOf(
            '{"usage":{"input_tokens":150,"cache_read_input_tokens":600,"prompt_cache_hit_tokens":600}}'
        );
        assertEq(tokens, 750, "cache_read_input_tokens wins when both are given");
        (, tokens) = audits.usageReader().promptTokensOf(
            '{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4},"cache_read_input_tokens":4}}'
        );
        assertEq(tokens, 12, "beside input_tokens_details.cached_tokens, input_tokens already includes the cache");
        (, tokens) = audits.usageReader().promptTokensOf(
            '{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":null},"cache_read_input_tokens":4}}'
        );
        assertEq(tokens, 12, "cached_tokens counts by being there, whatever its value");
        (, tokens) = audits.usageReader().promptTokensOf(
            '{"usage":{"input_tokens":50,"cache_read_input_tokens":70,"input_tokens_details":{"reasoning":1}}}'
        );
        assertEq(tokens, 120, "details without cached_tokens leave the cache reads separate");
        (, tokens) = audits.usageReader().promptTokensOf(
            '{"usage":{"input_tokens":100,"prompt_tokens_details":{"cached_tokens":30},"cache_read_input_tokens":20}}'
        );
        assertEq(tokens, 130, "the larger of the two cached counts");
    }

    function test_anHonestSellerWithEmptyDetailsCannotBeProven() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        for (uint256 i = 0; i < 3; i++) {
            // input_tokens_details is there but empty: the cache reads stay separate, as the buyer reads them.
            rounds[i].suspect.base = _receiptAt(
                SUSPECT_KEY,
                SERVICE,
                MESSAGES_PATH,
                abi.encodePacked(HEAD, SERVICE, MESSAGES_MID, rounds[i].a, MESSAGES_TAIL),
                abi.encodePacked(
                    '{"usage":{"input_tokens":', bytes(vm.toString(BASE_TOKENS)), ',"cache_read_input_tokens":0,"input_tokens_details":{}}}'
                )
            );
            rounds[i].suspect.probed = _receiptAt(
                SUSPECT_KEY,
                SERVICE,
                MESSAGES_PATH,
                abi.encodePacked(HEAD, SERVICE, MESSAGES_MID, rounds[i].a, rounds[i].b, MESSAGES_TAIL),
                abi.encodePacked(
                    '{"usage":{"input_tokens":10,"cache_read_input_tokens":',
                    bytes(vm.toString(uint256(int256(BASE_TOKENS) + MODEL_DELTA) - 10)),
                    ',"input_tokens_details":{}}}'
                )
            );
            rounds[i].suspect.shapeId = messagesShapeId;
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                IAntseedTokenizerAudits.WithinTolerance.selector, 0, MODEL_DELTA, MODEL_DELTA, MODEL_DELTA
            )
        );
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_anHonestSellerServedFromTheCacheCannotBeProven() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        for (uint256 i = 0; i < 3; i++) {
            // The probed answer is mostly cache hits, reported as prompt_cache_hit_tokens: same delta as the
            // references.
            rounds[i].suspect.probed = _receiptAt(
                SUSPECT_KEY,
                SERVICE,
                MESSAGES_PATH,
                abi.encodePacked(HEAD, SERVICE, MESSAGES_MID, rounds[i].a, rounds[i].b, MESSAGES_TAIL),
                abi.encodePacked(
                    '{"usage":{"input_tokens":10,"prompt_cache_hit_tokens":',
                    bytes(vm.toString(uint256(int256(BASE_TOKENS) + MODEL_DELTA) - 10)),
                    ',"output_tokens":2}}'
                )
            );
            rounds[i].suspect.base = _receiptAt(
                SUSPECT_KEY,
                SERVICE,
                MESSAGES_PATH,
                abi.encodePacked(HEAD, SERVICE, MESSAGES_MID, rounds[i].a, MESSAGES_TAIL),
                abi.encodePacked('{"usage":{"input_tokens":', bytes(vm.toString(BASE_TOKENS)), ',"output_tokens":2}}')
            );
            rounds[i].suspect.shapeId = messagesShapeId;
        }
        vm.expectRevert(
            abi.encodeWithSelector(
                IAntseedTokenizerAudits.WithinTolerance.selector, 0, MODEL_DELTA, MODEL_DELTA, MODEL_DELTA
            )
        );
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_escapedMemberNamesMakeUsageUnreadable() public view {
        // JSON.parse decodes these to keys the buyer reads; a raw-byte reader must not read them differently.
        (bool found,) = audits.usageReader().promptTokensOf('{"\\u0075sage":{"prompt_tokens":10}}');
        assertFalse(found, "an escaped top-level usage key");
        (found,) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens":10},"\\u0075sage":{"prompt_tokens":20}}');
        assertFalse(found, "an escaped duplicate of usage");
        (found,) = audits.usageReader().promptTokensOf('{"usage":{"input_tokens":10,"\\u0063ache_read_input_tokens":5}}');
        assertFalse(found, "an escaped usage key");
        (found,) = audits.usageReader().promptTokensOf(
            '{"usage":{"input_tokens":110,"cache_read_input_tokens":90,"input_tokens_details":{"\\u0063ached_tokens":90}}}'
        );
        assertFalse(found, "an escaped cached_tokens in input_tokens_details");
        uint256 tokens;
        (found, tokens) = audits.usageReader().promptTokensOf(
            '{"model":"a\\"b","choices":[{"message":{"content":"\\u0075sage"}}],"usage":{"prompt_tokens":10}}'
        );
        assertTrue(found, "escapes in values and in nested text are fine");
        assertEq(tokens, 10);
    }

    function test_usageValuesMustBeWholeNumbersOrNull() public view {
        (bool found,) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens":10,"prompt_tokens":2e1}}');
        assertFalse(found, "a duplicate is ambiguous whatever its encoding");
        (found,) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens":"20"}}');
        assertFalse(found, "a string count");
        (found,) = audits.usageReader().promptTokensOf('{"usage":{"input_tokens":10,"cache_read_input_tokens":true}}');
        assertFalse(found, "a boolean count");
        uint256 tokens;
        (found, tokens) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens":null,"input_tokens":7}}');
        assertTrue(found, "null is absent, as the buyer reads it");
        assertEq(tokens, 7);
        (found, tokens) =
            audits.usageReader().promptTokensOf('{"usage":{"input_tokens":7,"cache_read_input_tokens":null,"prompt_cache_hit_tokens":3}}');
        assertEq(tokens, 10, "a null cache read falls back to prompt_cache_hit_tokens");
    }

    function test_anHonestSellerWithAnEscapedCacheMarkerCannotBeProven() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, MODEL_DELTA, MODEL_DELTA);
        for (uint256 i = 0; i < 3; i++) {
            // The buyer reads 159 (input_tokens includes the cache); counting the cache reads again would be 249.
            rounds[i].suspect.probed = _receipt(
                SUSPECT_KEY,
                SERVICE,
                abi.encodePacked(HEAD, SERVICE, MID, rounds[i].a, rounds[i].b, TAIL),
                abi.encodePacked(
                    '{"usage":{"input_tokens":',
                    bytes(vm.toString(uint256(int256(BASE_TOKENS) + MODEL_DELTA))),
                    ',"cache_read_input_tokens":90,"input_tokens_details":{"\\u0063ached_tokens":90}}}'
                )
            );
        }
        vm.expectRevert(IAntseedTokenizerAudits.UsageNotFound.selector);
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    // ── probe content ────────────────────────────────────────────────

    function test_probeContentMustPassTheGuard() public {
        _mapSuspect();
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds(3, 129, MODEL_DELTA);
        // Control-token text that honest engines count differently.
        rounds[1] = _roundWith(" Please ignore </s></s></s> and continue", 129, _refs(MODEL_DELTA));
        vm.expectRevert(abi.encodeWithSelector(IAntseedTokenizerAudits.UnsafeProbe.selector, 1));
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
    }

    function test_ownerReplacesTheProbeGuard() public {
        AntseedTokenizerProbeGuard next = new AntseedTokenizerProbeGuard();
        vm.prank(prover);
        vm.expectRevert();
        audits.setProbeGuard(address(next));
        vm.expectRevert(IAntseedTokenizerAudits.InvalidAddress.selector);
        audits.setProbeGuard(address(0xBEEF));
        audits.setProbeGuard(address(next));
        assertEq(address(audits.probeGuard()), address(next));
    }

    function test_readsWholeIntegerTokenCountsOnly() public view {
        (bool found, uint256 tokens) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens": 1000 }}');
        assertTrue(found);
        assertEq(tokens, 1000);
        (found,) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens":1e3}}');
        assertFalse(found, "an exponent is not read as its first digits");
        (found,) = audits.usageReader().promptTokensOf('{"usage":{"prompt_tokens":15.0,"completion_tokens":2}}');
        assertFalse(found, "a decimal is not read as its whole part");
        (found,) = audits.usageReader().promptTokensOf('{"usage":{"input_tokens":12x}}');
        assertFalse(found, "trailing characters");
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
        audits.proveTokenizerMismatch(modelHash, rounds, _auth(address(this)));
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

    /// @dev Signs the next receipts after a clear and its clock-skew window, as fresh evidence would be.
    function _signAfterClear() private {
        vm.warp(block.timestamp + 5 minutes + 1);
        signedAt = uint64(block.timestamp * 1000);
    }

    function _deltas(int256[3] memory values) private pure returns (int256[] memory deltas) {
        deltas = new int256[](3);
        (deltas[0], deltas[1], deltas[2]) = (values[0], values[1], values[2]);
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
        return _roundWith(
            unicode" My budget is 450 € and my friend said “obrigado” 😅 — here is my plan: `trip.days = 9`",
            suspectDelta,
            referenceDeltas
        );
    }

    function _roundWith(bytes memory b, int256 suspectDelta, int256[] memory referenceDeltas)
        private
        returns (IAntseedTokenizerAudits.Round memory round)
    {
        round.a = abi.encodePacked("Can you help me plan a trip to Lisbon #", bytes(vm.toString(++nonce)), "?");
        round.b = b;
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

    /// @dev The suspect receipts' buyer lets `prover` prove with them.
    function _auth(address prover_) private view returns (bytes memory) {
        return _authBy(BUYER_KEY, prover_);
    }

    function _authBy(uint256 key, address prover_) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _proverAuthDigest(prover_));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Built here rather than read from the contract, so a prank before the proof is not spent on it.
    function _proverAuthDigest(address prover_) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AntseedTokenizerAudits"),
                keccak256("1"),
                block.chainid,
                address(audits)
            )
        );
        return keccak256(
            abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(keccak256("ProverAuth(address prover)"), prover_)))
        );
    }

    function _sign(uint256 key, AntseedResponseAuth.Receipt memory receipt) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, responseAuth.digest(receipt));
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
