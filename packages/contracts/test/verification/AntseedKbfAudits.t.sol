// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { IAntseedKbfAudits } from "../../interfaces/IAntseedKbfAudits.sol";
import { IAntseedVerificationResults } from "../../interfaces/IAntseedVerificationResults.sol";
import { AntseedKbfAudits } from "../../verification/AntseedKbfAudits.sol";
import { AntseedVerificationResults } from "../../verification/AntseedVerificationResults.sol";
import { AntseedVerificationPointsPolicy } from "../../policies/AntseedVerificationPointsPolicy.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockVerificationEmissionsGate } from "../mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "../mocks/MockVerificationSellerPools.sol";
import { MockVerificationSource } from "../mocks/MockVerificationSource.sol";
import { UsageAccountingFront, VerificationPointsAccounting } from "./AntseedKbfVerification.t.sol";

/// @dev The KBF source on the results layer. Ported from
///      `AntseedKbfVerification.t.sol`: same cases and names, with each call on the contract that now
///      owns it, plus the cases the split adds (auditor epochs, evidence ownership, locked records).
contract AntseedKbfAuditsTest is Test {
    uint256 private constant EPOCH = 5;
    bytes32 private constant MODEL_A = keccak256("model-a");
    bytes32 private constant MODEL_B = keccak256("model-b");
    bytes32 private constant SERVICE_A = bytes32(uint256(1));
    bytes32 private constant SERVICE_B = bytes32(uint256(2));

    IAntseedVerificationResults.Verdict private constant SAME = IAntseedVerificationResults.Verdict.SAME;
    IAntseedVerificationResults.Verdict private constant DIFF = IAntseedVerificationResults.Verdict.DIFF;
    IAntseedVerificationResults.Verdict private constant NONE = IAntseedVerificationResults.Verdict.NONE;
    IAntseedVerificationResults.Verdict private constant UNDETERMINED =
    IAntseedVerificationResults.Verdict.UNDETERMINED;

    address private auditorA = address(0xA1);
    address private auditorB = address(0xB2);
    address private auditorC = address(0xC3);
    address private auditorD = address(0xD4);
    address private seller = address(0x5E1);

    AntseedRegistry private registry;
    AntseedVerificationResults private results;
    AntseedKbfAudits private kbf;
    MockERC8004Registry private identityRegistry;
    MockVerificationEmissionsGate private gate;
    MockVerificationSellerPools private pools;
    uint256 private agentId;
    uint256 private evidenceNonce;
    bytes4 private expectedAuditRevert;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        gate = new MockVerificationEmissionsGate();
        pools = new MockVerificationSellerPools();
        registry.setIdentityRegistry(address(identityRegistry));
        registry.setEmissions(address(gate));
        gate.setCurrentEpoch(EPOCH);
        (results, kbf) = _deploy();
        kbf.setAuditor(auditorA, true);
        kbf.setAuditor(auditorB, true);
        kbf.setAuditor(auditorC, true);
        kbf.setAuditor(auditorD, true);
        // Most tests check status and rewards with one report per verdict; the confirmation tests
        // below put the default DIFF threshold back.
        kbf.setRequiredReports(DIFF, 1);
        gate.setBudget(address(results), EPOCH, 900 ether);
        results.setRewardsStartEpoch(address(kbf), uint64(0));
        results.setMaxAuditorShareBps(address(kbf), 10_000);
        agentId = _register(seller, 300);
    }

    // ── status ───────────────────────────────────────────────────────

    function test_sameCountsForTwoEpochs() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
        IAntseedVerificationResults.AgentStatus memory agent = results.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1);
        assertEq(agent.diffCount, 0);
        IAntseedVerificationResults.ServiceStatus memory service = results.serviceStatus(agentId, SERVICE_A);
        assertEq(service.modelHash, MODEL_A);
        assertEq(uint8(service.verdict), uint8(SAME));
        assertEq(service.epoch, EPOCH);

        _advance(1);
        assertTrue(results.isVerified(agentId), "still live in the next epoch");
        _advance(1);
        assertFalse(results.isVerified(agentId));
        assertEq(results.agentStatus(agentId).verifiedCount, 0);
        service = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(SAME), "stored record stays");
        assertEq(service.epoch, EPOCH);
    }

    function test_expiredVerdictsLeavePointsWithoutCleanup() public {
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(_sellerPoints(policy), 120);
        _advance(1);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        assertEq(_sellerPoints(policy), 100, "one SAME bonus, one DIFF penalty");
        _advance(1);
        assertEq(results.agentStatus(agentId).verifiedCount, 0);
        assertEq(results.agentStatus(agentId).diffCount, 1);
        assertEq(_sellerPoints(policy), 90, "SAME from two epochs ago no longer counts");
        _advance(1);
        assertEq(results.agentStatus(agentId).diffCount, 0);
        assertEq(_sellerPoints(policy), 100, "DIFF expires like SAME");
    }

    function test_repeatedVerdictMovesItToTheCurrentEpoch() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.agentStatus(agentId).verifiedCount, 1, "same-epoch repeat counts once");
        _advance(1);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.serviceStatus(agentId, SERVICE_A).epoch, EPOCH + 1);
        assertEq(results.agentStatus(agentId).verifiedCount, 1, "moved, not double counted");
        _advance(1);
        assertTrue(results.isVerified(agentId));
        _advance(1);
        assertFalse(results.isVerified(agentId));
    }

    function test_eachServiceExpiresIndependently() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _advance(1);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(results.agentStatus(agentId).verifiedCount, 2);
        _advance(1);
        assertEq(results.agentStatus(agentId).verifiedCount, 1);
        assertTrue(results.isVerified(agentId));
    }

    function test_newResultOnExpiredServiceStartsFresh() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _advance(2);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, NONE, SAME, address(kbf), _nextEvidence()
        );
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(agentId, 1, 0);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
    }

    function test_validityEpochsAppliesToExistingVerdicts() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _advance(2);
        assertFalse(results.isVerified(agentId));
        results.setValidityEpochs(3);
        assertTrue(results.isVerified(agentId));
        results.setValidityEpochs(1);
        assertFalse(results.isVerified(agentId));
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
        _advance(1);
        assertFalse(results.isVerified(agentId));
    }

    function test_agentStatusAtEpochZero() public {
        gate.setCurrentEpoch(0);
        vm.prank(auditorA);
        kbf.submitModelAudit(0, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));
        assertEq(results.agentStatus(agentId).verifiedCount, 1);
    }

    function test_statusReadsStayCheapWithManyServices() public {
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        for (uint256 round = 0; round < 3; round++) {
            IAntseedKbfAudits.ServiceResult[] memory batch = new IAntseedKbfAudits.ServiceResult[](256);
            for (uint256 i = 0; i < batch.length; i++) {
                batch[i] = _result(agentId, bytes32(round * 256 + i + 1), SAME);
            }
            vm.prank(auditorA);
            kbf.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", batch);
        }
        assertEq(results.agentStatus(agentId).verifiedCount, 768, "no per-agent service cap");
        vm.cool(address(results));
        uint256 gasBefore = gasleft();
        uint256 points = _sellerPoints(policy);
        uint256 readGas = gasBefore - gasleft();
        assertEq(points, 150);
        assertLt(readGas, 50_000, "settlement read does not depend on service count");
        emit log_named_uint("cold verification points gas", readGas);
    }

    function test_eachVerifiedServiceCountsOnce() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(results.agentStatus(agentId).verifiedCount, 2);
    }

    function test_diffAffectsOnlyThatServiceButBlocksAgentVerification() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        IAntseedVerificationResults.AgentStatus memory agent = results.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1, "service A stays verified");
        assertEq(agent.diffCount, 1);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME));
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_B).verdict), uint8(DIFF));
        assertFalse(results.isVerified(agentId));
    }

    function test_sameAfterDiffRestoresService() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        IAntseedVerificationResults.AgentStatus memory agent = results.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1);
        assertEq(agent.diffCount, 0);
        assertTrue(results.isVerified(agentId));

        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        agent = results.agentStatus(agentId);
        assertEq(agent.verifiedCount, 0);
        assertEq(agent.diffCount, 1);
    }

    function test_singleDiffLandsAndLatestResultWins() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, SAME, DIFF, address(kbf), _nextEvidence()
        );
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(results.agentStatus(agentId).diffCount, 1, "one auditor's DIFF counts");
        assertFalse(results.isVerified(agentId));
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(results.agentStatus(agentId).diffCount, 1, "repeat DIFF counts once");
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.agentStatus(agentId).diffCount, 0);
        assertTrue(results.isVerified(agentId));
    }

    function test_undeterminedReplacesDiff() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(UNDETERMINED));
        assertEq(results.agentStatus(agentId).diffCount, 0, "latest result wins");
    }

    function test_undeterminedReplacesSame() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        IAntseedVerificationResults.ServiceStatus memory service = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(UNDETERMINED));
        assertEq(service.epoch, EPOCH);
        assertEq(service.modelHash, MODEL_A);
        assertFalse(results.isVerified(agentId));

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));

        _advance(1);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, SAME, UNDETERMINED, address(kbf), _nextEvidence()
        );
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(agentId, 0, 0);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        service = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(UNDETERMINED), "latest result wins");
        assertEq(service.epoch, EPOCH + 1);
        assertEq(results.agentStatus(agentId).verifiedCount, 0);
        assertFalse(results.isVerified(agentId));

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId), "a new SAME verifies again");
    }

    function test_modelChangeResetsServiceStatus() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_B, agentId, SERVICE_A, SAME);
        IAntseedVerificationResults.AgentStatus memory agent = results.agentStatus(agentId);
        assertEq(agent.diffCount, 0, "old model's DIFF does not carry over");
        assertEq(agent.verifiedCount, 1);
        assertEq(results.serviceStatus(agentId, SERVICE_A).modelHash, MODEL_B);

        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(results.agentStatus(agentId).verifiedCount, 0, "model change drops the verdict");
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(UNDETERMINED));
        assertEq(results.serviceStatus(agentId, SERVICE_A).modelHash, MODEL_A);
    }

    function test_ownerCanClearServiceStatus() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        assertFalse(results.isVerified(agentId));
        _clear(agentId, SERVICE_B);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_B).verdict), uint8(NONE));
        assertEq(results.agentStatus(agentId).diffCount, 0);
        assertTrue(results.isVerified(agentId));
    }

    function test_clearingExpiredStatusesDoesNotUnderflow() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        _advance(2);
        _clear(agentId, SERVICE_A);
        _clear(agentId, SERVICE_B);
        _clear(agentId, SERVICE_B);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
        _clear(agentId, SERVICE_A);
        assertFalse(results.isVerified(agentId));
    }

    function test_oneSubmissionCoversManySellers() public {
        uint256 other = _register(address(0x5E2), 100);
        IAntseedKbfAudits.ServiceResult[] memory batch = new IAntseedKbfAudits.ServiceResult[](2);
        batch[0] = _result(agentId, SERVICE_A, SAME);
        batch[1] = _result(other, SERVICE_A, DIFF);

        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorA, MODEL_A, SAME, 0, 1, 1);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(other, SERVICE_A, auditorA, MODEL_A, DIFF, 0, 1, 1);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ModelAudited(MODEL_A, auditorA, EPOCH, keccak256("evidence"), "ipfs://cid", 2);
        vm.prank(auditorA);
        kbf.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "ipfs://cid", batch);

        assertTrue(results.isVerified(agentId));
        assertEq(results.agentStatus(other).diffCount, 1);
    }

    function test_batchStatusEventsAccumulateWithinAgentAndResetBetweenAgents() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_B, DIFF);
        uint256 other = _register(address(0x5E2), 100);
        IAntseedKbfAudits.ServiceResult[] memory batch = new IAntseedKbfAudits.ServiceResult[](4);
        batch[0] = _result(agentId, SERVICE_A, DIFF);
        batch[1] = _result(agentId, SERVICE_B, SAME);
        batch[2] = _result(other, SERVICE_A, SAME);
        batch[3] = _result(other, SERVICE_B, DIFF);

        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(agentId, 0, 2);
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(agentId, 1, 1);
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(other, 1, 0);
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(other, 1, 1);
        vm.prank(auditorB);
        kbf.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", batch);
    }

    function test_ownerClearsManyServicesInOneCall() public {
        uint256 other = _register(address(0x5E3), 100);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        _audit(auditorA, MODEL_A, other, SERVICE_A, DIFF);

        uint256[] memory agents = new uint256[](3);
        bytes32[] memory services = new bytes32[](3);
        (agents[0], agents[1], agents[2]) = (agentId, agentId, other);
        (services[0], services[1], services[2]) = (SERVICE_A, SERVICE_B, SERVICE_A);
        results.clearServiceStatuses(agents, services);

        assertEq(results.agentStatus(agentId).diffCount, 0);
        assertEq(results.agentStatus(other).diffCount, 0);
        assertEq(uint8(results.serviceStatus(other, SERVICE_A).verdict), uint8(NONE));
    }

    function test_clearRejectsMismatchedLists() public {
        uint256[] memory agents = new uint256[](2);
        bytes32[] memory services = new bytes32[](1);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.clearServiceStatuses(agents, services);
    }

    function test_clearResetsUndetermined() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        _clear(agentId, SERVICE_A);
        IAntseedVerificationResults.ServiceStatus memory service = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(NONE));
        assertEq(service.epoch, 0);
        assertEq(service.modelHash, MODEL_A);
    }

    // ── access and validation ────────────────────────────────────────

    function test_rejectsUnapprovedAuditor() public {
        _expectAuditRevert(AntseedKbfAudits.NotApprovedAuditor.selector);
        _audit(address(0xBAD), MODEL_A, agentId, SERVICE_A, SAME);

        kbf.setAuditor(auditorA, false);
        _expectAuditRevert(AntseedKbfAudits.NotApprovedAuditor.selector);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
    }

    function test_rejectsSelfAudit() public {
        kbf.setAuditor(seller, true);
        _expectAuditRevert(AntseedKbfAudits.SelfAudit.selector);
        _audit(seller, MODEL_A, agentId, SERVICE_A, SAME);
    }

    function test_skipsUnknownAgentWithoutFailingTheBatch() public {
        IAntseedKbfAudits.ServiceResult[] memory batch = new IAntseedKbfAudits.ServiceResult[](2);
        batch[0] = _result(agentId, SERVICE_A, SAME);
        batch[1] = _result(999, SERVICE_A, DIFF);
        vm.expectEmit(address(kbf));
        emit AntseedKbfAudits.UnknownAgentSkipped(999, MODEL_A);
        vm.prank(auditorA);
        kbf.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", batch);
        assertTrue(results.isVerified(agentId), "known agents in the batch still count");
        assertEq(uint8(results.serviceStatus(999, SERVICE_A).verdict), uint8(IAntseedVerificationResults.Verdict.NONE));
        assertEq(results.agentStatus(999).diffCount, 0);
        assertEq(results.epochCredits(address(kbf), EPOCH), 1);
    }

    function test_unknownAgentAloneEarnsNoCredit() public {
        _audit(auditorA, MODEL_A, 999, SERVICE_A, SAME);
        assertEq(results.epochCredits(address(kbf), EPOCH), 0);
    }

    function testFuzz_rejectsZeroAgent(uint8 verdictSeed) public {
        IAntseedVerificationResults.Verdict verdict = IAntseedVerificationResults.Verdict(bound(verdictSeed, 1, 3));
        _expectAuditRevert(AntseedKbfAudits.UnknownAgent.selector);
        _audit(auditorA, MODEL_A, 0, SERVICE_A, verdict);
        assertFalse(results.isVerified(0));
        assertEq(results.agentStatus(0).verifiedCount, 0);
        assertEq(results.agentStatus(0).diffCount, 0);
    }

    function test_rejectsZeroAgentBeforeValidAgent() public {
        bytes32 evidence = keccak256("zero-agent-evidence");
        IAntseedKbfAudits.ServiceResult[] memory batch = new IAntseedKbfAudits.ServiceResult[](2);
        batch[0] = _result(0, SERVICE_A, SAME);
        batch[1] = _result(agentId, SERVICE_A, SAME);
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfAudits.UnknownAgent.selector);
        kbf.submitModelAudit(EPOCH, MODEL_A, evidence, "", batch);

        assertFalse(results.isVerified(0));
        assertFalse(results.isVerified(agentId));
        assertEq(results.epochCredits(address(kbf), EPOCH), 0);

        vm.prank(auditorA);
        kbf.submitModelAudit(EPOCH, MODEL_A, evidence, "", _single(agentId, SERVICE_A, SAME));
        assertTrue(results.isVerified(agentId));
        assertEq(results.epochCredits(address(kbf), EPOCH), 1);
    }

    function test_rejectsStaleEpoch() public {
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfAudits.EpochChanged.selector);
        kbf.submitModelAudit(EPOCH - 1, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
    }

    function test_sameEvidenceCanBeSubmittedAgain() public {
        vm.startPrank(auditorA);
        kbf.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
        kbf.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
        vm.stopPrank();
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 1, "per-model cap still holds");
    }

    function test_rejectsInvalidResults() public {
        uint256 other = _register(address(0x5E2), 100);
        IAntseedKbfAudits.ServiceResult[] memory batch = new IAntseedKbfAudits.ServiceResult[](0);
        _expectInvalidResults(batch);

        _expectInvalidResults(_single(agentId, SERVICE_A, NONE));
        _expectInvalidResults(_single(agentId, bytes32(0), SAME));

        batch = new IAntseedKbfAudits.ServiceResult[](2);
        batch[0] = _result(agentId, SERVICE_B, SAME);
        batch[1] = _result(agentId, SERVICE_A, SAME);
        _expectInvalidResults(batch);

        batch[0] = _result(agentId, SERVICE_A, SAME);
        batch[1] = _result(agentId, SERVICE_A, DIFF);
        _expectInvalidResults(batch);

        batch[0] = _result(other, SERVICE_A, SAME);
        batch[1] = _result(agentId, SERVICE_A, SAME);
        _expectInvalidResults(batch);
    }

    function test_validatesModelAndEvidence() public {
        IAntseedKbfAudits.ServiceResult[] memory batch = _single(agentId, SERVICE_A, SAME);
        vm.startPrank(auditorA);
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.submitModelAudit(EPOCH, bytes32(0), keccak256("evidence"), "", batch);
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.submitModelAudit(EPOCH, MODEL_A, bytes32(0), "", batch);
        vm.expectRevert(AntseedKbfAudits.InvalidEvidenceUri.selector);
        kbf.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "https://example.com/e", batch);
        vm.expectRevert(AntseedKbfAudits.InvalidEvidenceUri.selector);
        kbf.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "ipfs://", batch);
        kbf.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", batch);
        vm.stopPrank();
    }

    function test_onlyOwnerConfigures() public {
        vm.startPrank(auditorA);
        vm.expectRevert();
        kbf.setAuditor(address(0xB0B), true);
        vm.expectRevert();
        results.setValidityEpochs(3);
        vm.expectRevert();
        results.setMaxAuditorShareBps(address(kbf), 5_000);
        vm.expectRevert();
        results.setRewardsStartEpoch(address(kbf), uint64(EPOCH));
        vm.expectRevert();
        results.setMaxCreditsPerAuditorPerEpoch(address(kbf), 5);
        vm.expectRevert();
        kbf.setMaxCreditsPerModelPerEpoch(3);
        vm.expectRevert();
        kbf.setSellerPools(address(pools));
        vm.expectRevert();
        results.clearServiceStatuses(new uint256[](0), new bytes32[](0));
        vm.expectRevert();
        results.voidCredits(address(kbf), EPOCH, auditorB);
        vm.expectRevert();
        kbf.setRequiredReports(DIFF, 3);
        vm.stopPrank();

        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setRequiredReports(NONE, 1);
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setRequiredReports(SAME, 0);

        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setValidityEpochs(0);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setValidityEpochs(5);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxAuditorShareBps(address(kbf), 0);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxAuditorShareBps(address(kbf), 10_001);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxCreditsPerAuditorPerEpoch(address(kbf), 0);
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setMaxCreditsPerModelPerEpoch(0);
        vm.expectRevert(AntseedKbfAudits.InvalidAddress.selector);
        kbf.setSellerPools(address(0x1234));
    }

    // ── rewards ──────────────────────────────────────────────────────

    function test_oneCreditPerAuditorModelAndEpoch() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);

        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 2, "repeat model audit earns nothing");
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorB), 1);
        assertEq(results.epochCredits(address(kbf), EPOCH), 3);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 600 ether);
        assertEq(_claim(auditorB), 300 ether);
        assertEq(_claim(auditorA), 0, "second claim pays nothing");
        assertEq(gate.minted(auditorA), 600 ether);
    }

    function test_usesTheGateBehindUsageAccounting() public {
        registry.setEmissions(address(new UsageAccountingFront(address(gate))));
        (results, kbf) = _deploy();
        kbf.setAuditor(auditorA, true);
        results.setRewardsStartEpoch(address(kbf), uint64(0));
        results.setMaxAuditorShareBps(address(kbf), 10_000);
        gate.setBudget(address(results), EPOCH, 900 ether);
        assertEq(address(results.emissionsGate()), address(gate));
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 1);

        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfAudits.EpochChanged.selector);
        kbf.submitModelAudit(EPOCH + 1, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(results.pendingReward(address(kbf), auditorA, EPOCH), 900 ether);
        assertEq(_claim(auditorA), 900 ether);
        assertEq(gate.minted(auditorA), 900 ether);
    }

    function test_undeterminedAuditEarnsCredit() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 1);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 900 ether);
    }

    function test_configurableCreditsPerModelPerEpoch() public {
        assertEq(kbf.maxCreditsPerModelPerEpoch(), 1);
        kbf.setMaxCreditsPerModelPerEpoch(3);
        for (uint256 i = 0; i < 4; i++) {
            _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        }
        assertEq(kbf.modelCredits(EPOCH, auditorA, MODEL_A), 3, "fourth audit earns nothing");
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 3);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 4, "other models still earn");

        results.setMaxCreditsPerAuditorPerEpoch(address(kbf), 4);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 4, "overall cap still applies");
    }

    function test_creditsRestartEachEpoch() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        pools.setPower(agentId, EPOCH + 1, 50);
        vm.prank(auditorA);
        kbf.submitModelAudit(EPOCH + 1, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH + 1, auditorA), 1);
    }

    function test_creditCapPerAuditorPerEpoch() public {
        results.setMaxCreditsPerAuditorPerEpoch(address(kbf), 1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 1);
        assertEq(results.agentStatus(agentId).verifiedCount, 2, "capped audits still update status");
    }

    function test_unstakedSellersEarnNoCredit() public {
        uint256 unstaked = _register(address(0x5E3), 0);
        _audit(auditorA, MODEL_A, unstaked, SERVICE_A, SAME);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 0);
        assertTrue(results.isVerified(unstaked), "status still recorded");
    }

    function test_rewardsAreOffByDefault() public {
        (AntseedVerificationResults fresh, AntseedKbfAudits freshKbf) = _deploy();
        assertEq(fresh.rewardsStartEpoch(address(freshKbf)), type(uint64).max);
        assertEq(fresh.maxAuditorShareBps(address(freshKbf)), 2_000);
        freshKbf.setAuditor(auditorA, true);
        vm.prank(auditorA);
        freshKbf.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));
        assertTrue(fresh.isVerified(agentId), "status works without rewards");
        assertEq(fresh.epochCredits(address(freshKbf), EPOCH), 0, "no credit before rewards start");
    }

    function test_creditsOnlyFromRewardsStartEpoch() public {
        results.setRewardsStartEpoch(address(kbf), uint64(EPOCH + 1));
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.epochCredits(address(kbf), EPOCH), 0, "pre-launch audits never claim past budgets");
        _advance(1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.epochCredits(address(kbf), EPOCH + 1), 1);

        results.setRewardsStartEpoch(address(kbf), type(uint64).max);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.epochCredits(address(kbf), EPOCH + 1), 1, "turning rewards off stops new credits");
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH + 1, auditorA), 1, "earned credits stay");
    }

    function test_auditorShareIsCapped() public {
        results.setMaxAuditorShareBps(address(kbf), 2_000);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        _audit(auditorA, keccak256("model-c"), agentId, bytes32(uint256(3)), SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(results.pendingReward(address(kbf), auditorA, EPOCH), 180 ether, "675 capped at 20% of 900");
        assertEq(results.pendingReward(address(kbf), auditorB, EPOCH), 180 ether, "225 capped at 20% of 900");
        assertEq(_claim(auditorA), 180 ether);
        assertEq(_claim(auditorB), 180 ether);
        assertEq(gate.epochMinted(EPOCH), 360 ether, "the rest of the bucket is never minted");
    }

    function test_shareCapAppliesAtClaimTime() public {
        results.setMaxAuditorShareBps(address(kbf), 5_000);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 450 ether, "50% cap, half the credits");

        results.setMaxAuditorShareBps(address(kbf), 1_000);
        assertEq(_claim(auditorB), 90 ether, "lowered cap applies to unclaimed rewards");
    }

    function test_claimsOnlyFinalizedEpochs() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerificationResults.EpochNotFinalized.selector);
        results.claimRewards(address(kbf), epochs);
    }

    function test_currentEpochShowsNoPendingRewardSoClaimsSkipIt() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertGt(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 0);
        assertEq(results.pendingReward(address(kbf), auditorA, EPOCH), 0, "current epoch is not final");

        gate.setCurrentEpoch(EPOCH + 1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.pendingReward(address(kbf), auditorA, EPOCH + 1), 0, "new current epoch is not final");
        assertEq(results.pendingReward(address(kbf), auditorA, EPOCH), 900 ether, "finished epoch is claimable");
        assertEq(_claim(auditorA), 900 ether);
    }

    function test_voidingCreditsRestoresHonestShares() public {
        results.setMaxAuditorShareBps(address(kbf), 10_000);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        _audit(auditorA, keccak256("model-c"), agentId, bytes32(uint256(3)), SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.epochCredits(address(kbf), EPOCH), 4);

        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.CreditsVoided(address(kbf), EPOCH, auditorA, 3);
        results.voidCredits(address(kbf), EPOCH, auditorA);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 0);
        assertEq(results.epochCredits(address(kbf), EPOCH), 1);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(results.pendingReward(address(kbf), auditorA, EPOCH), 0);
        assertEq(_claim(auditorB), 900 ether, "the honest auditor gets the whole budget back");
        results.voidCredits(address(kbf), EPOCH, auditorA);
    }

    function test_cannotVoidClaimedCredits() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        _claim(auditorA);
        vm.expectRevert(AntseedVerificationResults.AlreadyClaimed.selector);
        results.voidCredits(address(kbf), EPOCH, auditorA);
    }

    function test_unfundedBucketStaysClaimable() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setBudget(address(results), EPOCH, 0);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 0);
        assertFalse(results.auditorEpochClaimed(address(kbf), EPOCH, auditorA));

        gate.setBudget(address(results), EPOCH, 100 ether);
        assertEq(_claim(auditorA), 100 ether);
    }

    function test_auditSurvivesFailingPools() public {
        pools.setReverts(true);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
        assertEq(results.epochCredits(address(kbf), EPOCH), 0);
    }

    function test_requiresAndPinsTheEmissionsGate() public {
        assertEq(address(results.emissionsGate()), address(gate));

        AntseedRegistry noGateRegistry = new AntseedRegistry();
        noGateRegistry.setIdentityRegistry(address(identityRegistry));
        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        new AntseedVerificationResults(address(noGateRegistry));

        MockVerificationEmissionsGate other = new MockVerificationEmissionsGate();
        other.setCurrentEpoch(EPOCH + 50);
        registry.setEmissions(address(other));
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.serviceStatus(agentId, SERVICE_A).epoch, EPOCH, "registry changes do not move the gate");
        assertTrue(results.isVerified(agentId));
    }

    // ── confirmations ────────────────────────────────────────────────

    function test_defaultsNeedASecondAuditorForADiffOnly() public {
        AntseedKbfAudits fresh = new AntseedKbfAudits(address(results), address(pools));
        assertEq(fresh.requiredReports(SAME), 1);
        assertEq(fresh.requiredReports(DIFF), 2);
        assertEq(fresh.requiredReports(UNDETERMINED), 1);
        assertEq(fresh.requiredReports(NONE), 0);
    }

    function test_oneSameVerifiesAndADiffWaitsForASecondAuditor() public {
        kbf.setRequiredReports(DIFF, 2);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorA, MODEL_A, SAME, 0, 1, 1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId), "one SAME is enough");

        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorB, MODEL_A, DIFF, 0, 1, 2);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertTrue(results.isVerified(agentId), "one DIFF waits");
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME));

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertTrue(results.isVerified(agentId), "the same auditor cannot confirm itself");

        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorC, MODEL_A, DIFF, 0, 2, 2);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, SAME, DIFF, address(kbf), _nextEvidence()
        );
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertFalse(results.isVerified(agentId));
        assertEq(results.agentStatus(agentId).diffCount, 1);
    }

    function test_clearingAConfirmedDiffNeedsTwoAuditors() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(results.agentStatus(agentId).diffCount, 1);

        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorC, MODEL_A, SAME, 1, 1, 2);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.agentStatus(agentId).diffCount, 1, "one SAME cannot clear it");
        _audit(auditorD, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(results.agentStatus(agentId).diffCount, 1, "nor one UNDETERMINED");

        _audit(auditorD, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.agentStatus(agentId).diffCount, 0, "a second SAME clears it");
        assertTrue(results.isVerified(agentId));
    }

    function test_aConfirmedDiffStaysLiveIntoTheNextEpochUntilTwoAuditorsClearIt() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        _advance(1);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.agentStatus(agentId).diffCount, 1, "still live, one SAME is not enough");
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.agentStatus(agentId).diffCount, 0);
        assertTrue(results.isVerified(agentId));
    }

    function test_oneSameUnderAnotherModelCannotClearADiff() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorC, MODEL_B, agentId, SERVICE_A, SAME);
        IAntseedVerificationResults.ServiceStatus memory service = results.serviceStatus(agentId, SERVICE_A);
        assertEq(service.modelHash, MODEL_A);
        assertEq(uint8(service.verdict), uint8(DIFF));
        _audit(auditorD, MODEL_B, agentId, SERVICE_A, SAME);
        service = results.serviceStatus(agentId, SERVICE_A);
        assertEq(service.modelHash, MODEL_B, "two auditors move the service to the new model");
        assertEq(uint8(service.verdict), uint8(SAME));
    }

    function test_reportsCountPerEpoch() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _advance(1);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorB, MODEL_A, DIFF, 0, 1, 2);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE));
    }

    function test_changingAReportMovesItsSupport() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorB, MODEL_A, DIFF, 0, 1, 2);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertTrue(results.isVerified(agentId), "auditor A no longer reports DIFF");
    }

    function test_repeatedReportCannotReassertAReplacedVerdict() public {
        kbf.setRequiredReports(SAME, 2);
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorD, MODEL_A, agentId, SERVICE_A, DIFF);
        assertFalse(results.isVerified(agentId));
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorB, MODEL_A, SAME, 1, 1, 2);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertFalse(results.isVerified(agentId), "support from before the DIFF no longer counts");
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
    }

    function test_supportFromBeforeAConfirmedDiffCannotClearIt() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(kbf.reportRound(agentId, SERVICE_A), 1, "the DIFF started a new round");
        _audit(auditorD, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(
            uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF), "A's earlier SAME does not count"
        );
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(
            uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME), "two SAMEs after the DIFF clear it"
        );
        assertEq(kbf.reportRound(agentId, SERVICE_A), 2);
    }

    function test_oneAuditorCannotClearADiffByChangingAndRestoringItsReport() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorD, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
        assertFalse(results.isVerified(agentId));
    }

    function test_supportFromBeforeADiffWasClearedCannotRestoreIt() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorD, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId), "cleared");
        assertEq(kbf.reportRound(agentId, SERVICE_A), 2);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorA, MODEL_A, DIFF, 2, 1, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertTrue(results.isVerified(agentId), "B's DIFF from before the clear does not count");
    }

    function test_flippingBetweenSameAndUndeterminedDoesNotResetAWaitingDiff() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(kbf.reportRound(agentId, SERVICE_A), 0, "no DIFF moved, so no new round");
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF), "B's waiting DIFF still counts");
    }

    function test_aRevokedAuditorsWaitingReportStopsCounting() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        kbf.setAuditor(auditorB, false);
        assertEq(kbf.auditorRevocations(), 1);
        assertEq(kbf.reportRound(agentId, SERVICE_A), 1, "a revocation starts a new round");
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorC, MODEL_A, DIFF, 1, 1, 2);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertTrue(results.isVerified(agentId), "B's DIFF no longer counts, so C's is only 1 of 2");
        _audit(auditorD, MODEL_A, agentId, SERVICE_A, DIFF);
        assertFalse(results.isVerified(agentId), "two approved auditors record it");
    }

    function test_aRevocationLeavesRecordedVerdicts() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        kbf.setAuditor(auditorA, false);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
        assertEq(results.agentStatus(agentId).diffCount, 1);
    }

    function test_onlyRevokingAnApprovedAuditorStartsANewRound() public {
        kbf.setAuditor(address(0xBEEF), false);
        kbf.setAuditor(auditorA, true);
        assertEq(kbf.auditorRevocations(), 0);
        kbf.setAuditor(auditorA, false);
        kbf.setAuditor(auditorA, false);
        assertEq(kbf.auditorRevocations(), 1);
    }

    function test_unconfirmedAndConfirmingAuditsBothEarnCredit() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 1);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorB), 1);
        assertEq(results.epochCredits(address(kbf), EPOCH), 2);
    }

    // ── auditors ─────────────────────────────────────────────────────

    function test_rejectsAVerifierTheSetReportsInactive() public {
        address newcomer = address(0xE5);
        _expectAuditRevert(AntseedKbfAudits.NotApprovedAuditor.selector);
        _audit(newcomer, MODEL_A, agentId, SERVICE_A, SAME);
        kbf.setAuditor(newcomer, true);
        _audit(newcomer, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
    }

    function test_minActiveEpochsHoldsBackNewVerifiers() public {
        assertEq(kbf.minActiveEpochs(), 0);
        address newcomer = address(0xE5);
        kbf.setAuditor(newcomer, true);
        assertEq(kbf.activeSinceEpoch(newcomer), EPOCH);
        _audit(newcomer, MODEL_A, agentId, SERVICE_A, SAME); // 0: accepted in the epoch it joins

        vm.expectEmit(address(kbf));
        emit AntseedKbfAudits.MinActiveEpochsSet(1);
        kbf.setMinActiveEpochs(1);
        _expectAuditRevert(AntseedKbfAudits.AuditorTooNew.selector);
        _audit(newcomer, MODEL_B, agentId, SERVICE_B, SAME);
        _advance(1);
        _audit(newcomer, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_B).verdict), uint8(SAME), "accepted the next epoch");

        // Re-approving later restarts the wait.
        kbf.setAuditor(newcomer, false);
        kbf.setAuditor(newcomer, true);
        assertEq(kbf.activeSinceEpoch(newcomer), EPOCH + 1);
        _expectAuditRevert(AntseedKbfAudits.AuditorTooNew.selector);
        _audit(newcomer, MODEL_A, agentId, SERVICE_A, SAME);
    }

    function test_evidenceBelongsToTheVerifierThatFirstSubmitsIt() public {
        bytes32 evidence = keccak256("shared-evidence");
        vm.prank(auditorA);
        kbf.submitModelAudit(EPOCH, MODEL_A, evidence, "", _single(agentId, SERVICE_A, SAME));
        assertEq(kbf.evidenceAuditor(evidence), auditorA);

        vm.prank(auditorB);
        vm.expectRevert(AntseedKbfAudits.EvidenceReused.selector);
        kbf.submitModelAudit(EPOCH, MODEL_A, evidence, "", _single(agentId, SERVICE_A, SAME));

        vm.prank(auditorA);
        kbf.submitModelAudit(EPOCH, MODEL_A, evidence, "", _single(agentId, SERVICE_A, SAME)); // retries are fine
        assertEq(kbf.evidenceAuditor(evidence), auditorA);
    }

    function test_approvalStampsTheResultsEpochAndEmitsOnEveryCall() public {
        address newcomer = address(0xE5);
        assertFalse(kbf.approvedAuditors(newcomer));
        assertEq(kbf.activeSinceEpoch(newcomer), 0);
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorSet(newcomer, true);
        kbf.setAuditor(newcomer, true);
        assertTrue(kbf.approvedAuditors(newcomer));
        assertEq(kbf.activeSinceEpoch(newcomer), EPOCH);

        _advance(3);
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorSet(newcomer, true);
        kbf.setAuditor(newcomer, true);
        assertEq(kbf.activeSinceEpoch(newcomer), EPOCH, "re-approving an approved auditor keeps its epoch");

        uint256 revocations = kbf.auditorRevocations();
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorSet(newcomer, false);
        kbf.setAuditor(newcomer, false);
        assertEq(kbf.activeSinceEpoch(newcomer), 0, "revoking zeroes it");
        assertEq(kbf.auditorRevocations(), revocations + 1);
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorSet(newcomer, false);
        kbf.setAuditor(newcomer, false); // already revoked: still emits, counts nothing
        assertEq(kbf.auditorRevocations(), revocations + 1);

        kbf.setAuditor(newcomer, true);
        assertEq(kbf.activeSinceEpoch(newcomer), EPOCH + 3, "re-approval after a revocation restamps");
    }

    function test_onlyOwnerApprovesOrHoldsBackAuditors() public {
        vm.startPrank(auditorA);
        vm.expectRevert();
        kbf.setAuditor(address(0xB0B), true);
        vm.expectRevert();
        kbf.setMinActiveEpochs(1);
        vm.stopPrank();
        vm.expectRevert(AntseedKbfAudits.InvalidAddress.selector);
        kbf.setAuditor(address(0), true);
        vm.expectRevert(AntseedKbfAudits.InvalidAddress.selector);
        new AntseedKbfAudits(address(0x1234), address(pools));
    }

    function test_anotherSourcesDiffNeedsAKbfDiffQuorumToReplace() public {
        kbf.setRequiredReports(DIFF, 2);
        MockVerificationSource probes = new MockVerificationSource(address(results));
        results.setSource(address(probes), true);
        probes.record(agentId, SERVICE_A, MODEL_A, DIFF);
        assertEq(kbf.diffChanges(agentId, SERVICE_A), 0, "another source's DIFF moves no KBF round");

        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorA, MODEL_A, SAME, 0, 1, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(DIFF), "one SAME does not clear a live DIFF");
        assertEq(status.source, address(probes));
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 1, "the audit still earns its credit");

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(SAME), "a DIFF-sized quorum clears it");
        assertEq(status.source, address(kbf));
        assertEq(kbf.diffChanges(agentId, SERVICE_A), 1, "clearing a DIFF here starts a new round");
        assertTrue(results.isVerified(agentId));
    }

    function test_anotherSourceCanOverwriteKbfVerdicts() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        MockVerificationSource probes = new MockVerificationSource(address(results));
        results.setSource(address(probes), true);
        probes.record(agentId, SERVICE_A, MODEL_A, SAME);
        assertEq(results.serviceStatus(agentId, SERVICE_A).source, address(probes));
        assertTrue(results.isVerified(agentId), "the results layer takes the latest record from any source");
    }

    function test_roundsMoveOnlyWhenKbfMovesAServiceIntoOrOutOfDiff() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(kbf.diffChanges(agentId, SERVICE_A), 0);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(kbf.diffChanges(agentId, SERVICE_A), 1, "into DIFF");
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(kbf.diffChanges(agentId, SERVICE_A), 1, "still DIFF");
        _audit(auditorB, MODEL_B, agentId, SERVICE_A, DIFF);
        assertEq(kbf.diffChanges(agentId, SERVICE_A), 2, "a DIFF under a new model replaces the old one");
        _audit(auditorC, MODEL_B, agentId, SERVICE_A, UNDETERMINED);
        assertEq(kbf.diffChanges(agentId, SERVICE_A), 3, "out of DIFF");
        _audit(auditorC, MODEL_B, agentId, SERVICE_A, SAME);
        assertEq(kbf.diffChanges(agentId, SERVICE_A), 3, "no DIFF involved");
        assertEq(kbf.reportRound(agentId, SERVICE_A), 3);
        kbf.setAuditor(auditorD, false);
        assertEq(kbf.reportRound(agentId, SERVICE_A), 4, "a revocation moves every round");
    }

    function test_agentOwnerIsUnknownForZeroUnregisteredAndBurnedAgents() public {
        (bool known, address owner) = kbf.agentOwner(agentId);
        assertTrue(known);
        assertEq(owner, seller);
        (known, owner) = kbf.agentOwner(0);
        assertFalse(known);
        (known, owner) = kbf.agentOwner(999);
        assertFalse(known, "unregistered: ownerOf reverts");
        vm.mockCall(
            address(identityRegistry),
            abi.encodeWithSelector(MockERC8004Registry.ownerOf.selector, agentId),
            abi.encode(address(0))
        );
        (known, owner) = kbf.agentOwner(agentId);
        assertFalse(known, "burned: ownerOf returns zero");
        assertEq(owner, address(0));
    }

    function test_claimSkipsWhileTheSourceHasNoShare() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        results.setSourceShareBps(address(kbf), 0);
        assertEq(results.pendingReward(address(kbf), auditorA, EPOCH), 0, "no share, nothing pending");
        assertEq(_claim(auditorA), 0, "skipped and stays claimable");
        assertFalse(results.auditorEpochClaimed(address(kbf), EPOCH, auditorA));
        results.setSourceShareBps(address(kbf), 10_000);
        assertEq(_claim(auditorA), 900 ether);
    }

    function test_reportViewsReflectTheTally() public {
        kbf.setRequiredReports(DIFF, 2);
        bytes32 key = kbf.reportKey(EPOCH, agentId, SERVICE_A, MODEL_A, 0);
        assertEq(key, keccak256(abi.encode(EPOCH, agentId, SERVICE_A, MODEL_A, uint256(0))));
        assertEq(uint8(kbf.reportOf(key, auditorA)), uint8(NONE));

        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(kbf.reportOf(key, auditorA)), uint8(DIFF));
        assertEq(kbf.reportCount(key, DIFF), 1);

        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(uint8(kbf.reportOf(key, auditorA)), uint8(SAME), "a later report replaces the earlier one");
        assertEq(kbf.reportCount(key, DIFF), 0);
        assertEq(kbf.reportCount(key, SAME), 1);

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(kbf.reportCount(key, DIFF), 1);
        assertEq(kbf.reportCount(kbf.reportKey(EPOCH, agentId, SERVICE_A, MODEL_B, 0), DIFF), 0, "per model");
    }

    function test_perModelCounterOnlyMovesWhenTheResultsLayerCredits() public {
        results.setMaxCreditsPerAuditorPerEpoch(address(kbf), 1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(kbf.modelCredits(EPOCH, auditorA, MODEL_A), 1);
        assertEq(kbf.modelCredits(EPOCH, auditorA, MODEL_B), 0, "the per-auditor cap credited nothing");

        results.setMaxCreditsPerAuditorPerEpoch(address(kbf), 2);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.AuditCredited(EPOCH, auditorA, MODEL_B);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(kbf.modelCredits(EPOCH, auditorA, MODEL_B), 1, "so the model can still earn once the cap allows");
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 2);
    }

    function test_removedSourceCannotRecord() public {
        results.setSource(address(kbf), false);
        _expectAuditRevert(AntseedVerificationResults.NotSource.selector);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
    }

    // ── invariants ───────────────────────────────────────────────────

    function testFuzz_liveCountsMatchServiceStatusesAcrossEpochs(uint8[32] calldata steps) public {
        _checkLiveCounts(steps);
    }

    function testFuzz_liveCountsMatchServiceStatusesWithConfirmations(uint8[32] calldata steps) public {
        kbf.setRequiredReports(DIFF, 2);
        _checkLiveCounts(steps);
    }

    function _checkLiveCounts(uint8[32] calldata steps) private {
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        address[3] memory auditors = [auditorA, auditorB, auditorC];
        bytes32[3] memory models = [MODEL_A, MODEL_B, keccak256("model-c")];
        bytes32[3] memory services = [SERVICE_A, SERVICE_B, bytes32(uint256(3))];
        for (uint256 i = 0; i < steps.length; i++) {
            uint8 step = steps[i];
            bytes32 service = services[(step >> 3) % 3];
            if (step % 7 == 0) {
                _advance(1);
            } else if (step % 7 == 1) {
                _clear(agentId, service);
            } else if (step % 7 == 2) {
                results.setValidityEpochs(uint8(1 + (step >> 5) % 4));
            } else {
                IAntseedVerificationResults.Verdict verdict = step % 3 == 0 ? SAME : step % 3 == 1 ? DIFF : UNDETERMINED;
                _audit(auditors[(step >> 1) % 3], models[(step >> 5) % 3], agentId, service, verdict);
            }
            uint256 current = gate.currentEpoch();
            uint256 window = results.validityEpochs();
            uint256 verified;
            uint256 diffs;
            for (uint256 j = 0; j < services.length; j++) {
                IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, services[j]);
                if (current >= status.epoch + window) continue;
                if (status.verdict == SAME) verified += 1;
                else if (status.verdict == DIFF) diffs += 1;
            }
            IAntseedVerificationResults.AgentStatus memory agent = results.agentStatus(agentId);
            assertEq(agent.verifiedCount, verified);
            assertEq(agent.diffCount, diffs);
            assertEq(results.isVerified(agentId), verified > 0 && diffs == 0);
            uint256 multiplier = 100 + 10 * verified;
            assertEq(_sellerPoints(policy), multiplier > 10 * diffs ? multiplier - 10 * diffs : 0);
        }
    }

    // ── helpers ──────────────────────────────────────────────────────

    function _register(address owner, uint256 power) private returns (uint256 id) {
        vm.prank(owner);
        id = identityRegistry.register();
        pools.setPower(id, EPOCH, power);
    }

    function _result(uint256 id, bytes32 service, IAntseedVerificationResults.Verdict verdict)
        private
        pure
        returns (IAntseedKbfAudits.ServiceResult memory)
    {
        return IAntseedKbfAudits.ServiceResult({ agentId: id, serviceHash: service, verdict: verdict });
    }

    function _single(uint256 id, bytes32 service, IAntseedVerificationResults.Verdict verdict)
        private
        pure
        returns (IAntseedKbfAudits.ServiceResult[] memory batch)
    {
        batch = new IAntseedKbfAudits.ServiceResult[](1);
        batch[0] = _result(id, service, verdict);
    }

    function _evidence() private returns (bytes32) {
        evidenceNonce += 1;
        return keccak256(abi.encode("evidence", evidenceNonce));
    }

    /// @dev The evidence hash the next `_audit` submits, for `ServiceStatusChanged` expectations.
    function _nextEvidence() private view returns (bytes32) {
        return keccak256(abi.encode("evidence", evidenceNonce + 1));
    }

    /// @dev A results layer and the KBF source on it at the whole bucket.
    function _deploy() private returns (AntseedVerificationResults results_, AntseedKbfAudits kbf_) {
        results_ = new AntseedVerificationResults(address(registry));
        kbf_ = new AntseedKbfAudits(address(results_), address(pools));
        results_.setSource(address(kbf_), true);
        results_.setSourceShareBps(address(kbf_), 10_000);
    }

    function _pointsPolicy() private returns (AntseedVerificationPointsPolicy policy) {
        pools.setSeller(seller, agentId);
        policy = new AntseedVerificationPointsPolicy(
            address(results), address(new VerificationPointsAccounting(address(pools))), 1_000, address(this)
        );
        policy.setPenaltyBps(1_000);
    }

    function _sellerPoints(AntseedVerificationPointsPolicy policy) private view returns (uint256 points) {
        (points,) = policy.points(bytes32(0), address(0x123), seller, 100, 100);
    }

    /// @dev Moves to a later epoch; seller pool power follows so audits keep earning credit.
    function _advance(uint256 epochs) private {
        uint256 next = gate.currentEpoch() + epochs;
        gate.setCurrentEpoch(next);
        pools.setPower(agentId, next, 300);
    }

    /// @dev `vm.expectRevert` would bind to `_audit`'s own epoch read, so arm it inside `_audit`.
    function _expectAuditRevert(bytes4 selector) private {
        expectedAuditRevert = selector;
    }

    function _audit(
        address auditor,
        bytes32 model,
        uint256 id,
        bytes32 service,
        IAntseedVerificationResults.Verdict verdict
    ) private {
        uint256 epoch = gate.currentEpoch();
        bytes32 evidence = _evidence();
        if (expectedAuditRevert != bytes4(0)) {
            vm.expectRevert(expectedAuditRevert);
            expectedAuditRevert = bytes4(0);
        }
        vm.prank(auditor);
        kbf.submitModelAudit(epoch, model, evidence, "ipfs://cid", _single(id, service, verdict));
    }

    function _clear(uint256 agent, bytes32 service) private {
        uint256[] memory agents = new uint256[](1);
        bytes32[] memory services = new bytes32[](1);
        agents[0] = agent;
        services[0] = service;
        results.clearServiceStatuses(agents, services);
    }

    function _claim(address auditor) private returns (uint256) {
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(auditor);
        return results.claimRewards(address(kbf), epochs);
    }

    function _expectInvalidResults(IAntseedKbfAudits.ServiceResult[] memory batch) private {
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfAudits.InvalidResults.selector);
        kbf.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", batch);
    }
}
