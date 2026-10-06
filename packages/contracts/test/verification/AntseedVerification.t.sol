// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AntseedRegistry} from "../../core/AntseedRegistry.sol";
import {IAntseedVerification} from "../../interfaces/IAntseedVerification.sol";
import {AntseedVerification} from "../../verification/AntseedVerification.sol";
import {MockERC8004Registry} from "../mocks/MockERC8004Registry.sol";

contract AntseedVerificationTest is Test {
    uint16 private constant PASS = 3; // MODEL_MATCH | PRICE_MATCH
    uint16 private constant MODEL_ONLY = 1;
    uint16 private constant UNDETERMINED = 4;

    uint256 private constant AUDITOR_A_KEY = 0xA1;
    uint256 private constant AUDITOR_B_KEY = 0xB2;
    uint256 private constant AUDITOR_C_KEY = 0xC3;
    uint256 private constant SELLER_KEY = 0x5E;

    address private verifier = address(0xA11CE);
    address private seller;

    AntseedVerification private verification;
    MockERC8004Registry private identityRegistry;
    uint256 private agentId;

    function setUp() public {
        vm.warp(1_800_000_000);
        AntseedRegistry registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identityRegistry));
        verification = new AntseedVerification(address(registry));
        verification.setVerifier(verifier, true);
        seller = vm.addr(SELLER_KEY);
        vm.prank(seller);
        agentId = identityRegistry.register();
    }

    // ── quorum and score ─────────────────────────────────────────────

    function test_finalizesScoreWhenTwoAuditorsAgree() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));

        _submit(AUDITOR_A_KEY, results, keccak256("evidence-a"));
        assertEq(verification.activeScoreBps(agentId), 0, "one auditor is not a quorum");

        _submit(AUDITOR_B_KEY, results, keccak256("evidence-b"));
        // two distinct passed references, maxBreadth 8: log2(3)/log2(9) = 0.5
        assertEq(verification.activeScoreBps(agentId), 5_000);
        IAntseedVerification.AgentScore memory score = verification.agentScore(agentId);
        assertEq(score.validUntil, block.timestamp + 14 days);
        (,,, address[] memory pendingAuditors) = verification.pendingAttestation(agentId);
        assertEq(pendingAuditors.length, 0);
    }

    function test_scorePenalizesEveryFailedService() public view {
        // one of two services fails price: breadth log2(2)/log2(9), integrity 0.5^4
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, MODEL_ONLY, keccak256("ref-b"));
        assertEq(verification.computeScoreBps(results), 197);

        results = _results2(PASS, UNDETERMINED | PASS, keccak256("ref-b"));
        assertEq(verification.computeScoreBps(results), 197, "undetermined counts as failed");

        results = _results2(MODEL_ONLY, MODEL_ONLY, keccak256("ref-b"));
        assertEq(verification.computeScoreBps(results), 0);
    }

    function test_breadthCountsDistinctReferencesOnly() public view {
        IAntseedVerification.ServiceResult[] memory aliases = _results2(PASS, PASS, keccak256("ref-a"));
        IAntseedVerification.ServiceResult[] memory distinct = _results2(PASS, PASS, keccak256("ref-b"));
        assertEq(verification.computeScoreBps(aliases), 3_154);
        assertEq(verification.computeScoreBps(distinct), 5_000);
    }

    function test_breadthSaturatesAtMaxBreadth() public {
        verification.setMaxBreadth(2);
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](3);
        for (uint256 i = 0; i < 3; i++) {
            results[i] = IAntseedVerification.ServiceResult({
                serviceHash: bytes32(i + 1), modelHash: keccak256(abi.encode(i)), flags: PASS
            });
        }
        assertEq(verification.computeScoreBps(results), 10_000);
    }

    function test_disagreementRestartsQuorum() public {
        _submit(AUDITOR_A_KEY, _results2(PASS, PASS, keccak256("ref-b")), keccak256("evidence-a"));
        _submit(AUDITOR_B_KEY, _results2(PASS, MODEL_ONLY, keccak256("ref-b")), keccak256("evidence-b"));
        assertEq(verification.activeScoreBps(agentId), 0);
        (,,, address[] memory pendingAuditors) = verification.pendingAttestation(agentId);
        assertEq(pendingAuditors.length, 1);
        assertEq(pendingAuditors[0], vm.addr(AUDITOR_B_KEY));

        _submit(AUDITOR_C_KEY, _results2(PASS, MODEL_ONLY, keccak256("ref-b")), keccak256("evidence-c"));
        assertEq(verification.activeScoreBps(agentId), 197);
    }

    function test_expiredPendingClaimRestartsQuorum() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        _submit(AUDITOR_A_KEY, results, keccak256("evidence-a"));
        vm.warp(block.timestamp + 3 days + 1);
        _submit(AUDITOR_B_KEY, results, keccak256("evidence-b"));
        assertEq(verification.activeScoreBps(agentId), 0);
    }

    function test_quorumOfOneFinalizesImmediately() public {
        verification.setQuorum(1);
        _submit(AUDITOR_A_KEY, _results2(PASS, PASS, keccak256("ref-b")), keccak256("evidence-a"));
        assertEq(verification.activeScoreBps(agentId), 5_000);
    }

    function test_scoreExpiresAndRefreshIsRateLimited() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        _submit(AUDITOR_A_KEY, results, keccak256("evidence-a"));
        _submit(AUDITOR_B_KEY, results, keccak256("evidence-b"));

        vm.warp(block.timestamp + 6 days);
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence-c"));
        bytes memory signature = _sign(AUDITOR_C_KEY, report);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.RefreshTooSoon.selector);
        verification.submitReport(report, results, "", signature);

        vm.warp(block.timestamp + 8 days);
        assertEq(verification.activeScoreBps(agentId), 0, "score expires after validity");
    }

    // ── auditor / verifier separation ────────────────────────────────

    function test_rejectsUnapprovedSubmitter() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        bytes memory signature = _sign(AUDITOR_A_KEY, report);
        vm.prank(vm.addr(AUDITOR_A_KEY));
        vm.expectRevert(AntseedVerification.NotApprovedVerifier.selector);
        verification.submitReport(report, results, "", signature);
    }

    function test_emitsAuditorAndVerifierPerReport() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        bytes memory signature = _sign(AUDITOR_A_KEY, report);
        vm.expectEmit(true, true, true, true);
        emit AntseedVerification.ReportSubmitted(
            agentId, vm.addr(AUDITOR_A_KEY), verifier, report.metadataHash, report.evidenceHash, report.resultsHash, "ipfs://e"
        );
        vm.expectEmit(true, true, true, true);
        emit AntseedVerification.ServiceAudited(
            agentId, results[0].serviceHash, vm.addr(AUDITOR_A_KEY), results[0].modelHash, PASS, report.evidenceHash
        );
        vm.prank(verifier);
        verification.submitReport(report, results, "ipfs://e", signature);
    }

    function test_rejectsDuplicateAuditorAndReplay() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        bytes memory signature = _sign(AUDITOR_A_KEY, report);
        vm.prank(verifier);
        verification.submitReport(report, results, "", signature);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.ReportAlreadyUsed.selector);
        verification.submitReport(report, results, "", signature);

        IAntseedVerification.AuditReport memory second = _report(results, keccak256("evidence-2"));
        bytes memory secondSignature = _sign(AUDITOR_A_KEY, second);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.DuplicateAuditor.selector);
        verification.submitReport(second, results, "", secondSignature);
    }

    function test_rejectsSelfAuditByAuditorOrVerifier() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        bytes memory signature = _sign(SELLER_KEY, report);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.SelfAudit.selector);
        verification.submitReport(report, results, "", signature);

        verification.setVerifier(seller, true);
        signature = _sign(AUDITOR_A_KEY, report);
        vm.prank(seller);
        vm.expectRevert(AntseedVerification.SelfAudit.selector);
        verification.submitReport(report, results, "", signature);
    }

    function test_rejectsTamperedResultsAndBadSignature() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        bytes memory signature = _sign(AUDITOR_A_KEY, report);

        IAntseedVerification.ServiceResult[] memory tampered = _results2(PASS, MODEL_ONLY, keccak256("ref-b"));
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.ResultsHashMismatch.selector);
        verification.submitReport(report, tampered, "", signature);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidSignature.selector);
        verification.submitReport(report, results, "", hex"1234");
    }

    function test_signatureBindsTheWholeReport() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        bytes memory signature = _sign(AUDITOR_A_KEY, report);
        report.evidenceHash = keccak256("other evidence");
        vm.prank(verifier);
        verification.submitReport(report, results, "", signature);
        (,,, address[] memory pendingAuditors) = verification.pendingAttestation(agentId);
        assertTrue(pendingAuditors[0] != vm.addr(AUDITOR_A_KEY), "altered report recovers a different signer");
    }

    // ── input validation ─────────────────────────────────────────────

    function test_rejectsStaleOrFutureReports() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        report.auditedAt = uint64(block.timestamp - 3 days - 1);
        bytes memory signature = _sign(AUDITOR_A_KEY, report);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.StaleReport.selector);
        verification.submitReport(report, results, "", signature);

        report.auditedAt = uint64(block.timestamp + 1);
        signature = _sign(AUDITOR_A_KEY, report);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.StaleReport.selector);
        verification.submitReport(report, results, "", signature);
    }

    function test_rejectsUnorderedDuplicateOrUnknownFlagResults() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        (results[0], results[1]) = (results[1], results[0]);
        _expectInvalidResults(results);

        results = _results2(PASS, PASS, keccak256("ref-b"));
        results[1].serviceHash = results[0].serviceHash;
        _expectInvalidResults(results);

        results = _results2(PASS, 8, keccak256("ref-b"));
        _expectInvalidResults(results);

        results = _results2(PASS, PASS, bytes32(0));
        _expectInvalidResults(results);

        _expectInvalidResults(new IAntseedVerification.ServiceResult[](0));
    }

    function test_rejectsUnknownAgent() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        report.agentId = 999;
        bytes memory signature = _sign(AUDITOR_A_KEY, report);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.UnknownAgent.selector);
        verification.submitReport(report, results, "", signature);
    }

    function test_validatesEvidenceUri() public {
        IAntseedVerification.ServiceResult[] memory results = _results2(PASS, PASS, keccak256("ref-b"));
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        bytes memory signature = _sign(AUDITOR_A_KEY, report);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitReport(report, results, "https://example.com/e", signature);

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitReport(report, results, "ipfs://", signature);
    }

    function test_onlyOwnerConfigures() public {
        vm.startPrank(verifier);
        vm.expectRevert();
        verification.setVerifier(address(0xB0B), true);
        vm.expectRevert();
        verification.setQuorum(1);
        vm.expectRevert();
        verification.setMaxBreadth(4);
        vm.expectRevert();
        verification.setTiming(1 days, 1 days, 1 days);
        vm.stopPrank();

        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setQuorum(5);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setMaxBreadth(33);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setTiming(1 days, 2 days, 1 days);
    }

    // ── helpers ──────────────────────────────────────────────────────

    function _results2(uint16 firstFlags, uint16 secondFlags, bytes32 secondModel)
        private
        pure
        returns (IAntseedVerification.ServiceResult[] memory results)
    {
        results = new IAntseedVerification.ServiceResult[](2);
        results[0] = IAntseedVerification.ServiceResult({
            serviceHash: bytes32(uint256(1)), modelHash: keccak256("ref-a"), flags: firstFlags
        });
        results[1] = IAntseedVerification.ServiceResult({
            serviceHash: bytes32(uint256(2)), modelHash: secondModel, flags: secondFlags
        });
    }

    function _report(IAntseedVerification.ServiceResult[] memory results, bytes32 evidenceHash)
        private
        view
        returns (IAntseedVerification.AuditReport memory)
    {
        return IAntseedVerification.AuditReport({
            agentId: agentId,
            metadataHash: keccak256("signed metadata"),
            evidenceHash: evidenceHash,
            resultsHash: keccak256(abi.encode(results)),
            auditedAt: uint64(block.timestamp)
        });
    }

    function _sign(uint256 key, IAntseedVerification.AuditReport memory report) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, verification.hashAuditReport(report));
        return abi.encodePacked(r, s, v);
    }

    function _submit(uint256 auditorKey, IAntseedVerification.ServiceResult[] memory results, bytes32 evidenceHash)
        private
    {
        IAntseedVerification.AuditReport memory report = _report(results, evidenceHash);
        bytes memory signature = _sign(auditorKey, report);
        vm.prank(verifier);
        verification.submitReport(report, results, "", signature);
    }

    function _expectInvalidResults(IAntseedVerification.ServiceResult[] memory results) private {
        IAntseedVerification.AuditReport memory report = _report(results, keccak256("evidence"));
        bytes memory signature = _sign(AUDITOR_A_KEY, report);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidResults.selector);
        verification.submitReport(report, results, "", signature);
    }
}
