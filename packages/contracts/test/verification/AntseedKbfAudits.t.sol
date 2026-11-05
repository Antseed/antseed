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
import { MockVerificationAudit } from "../mocks/MockVerificationAudit.sol";
import { VerificationPointsAccounting } from "../mocks/MockVerificationAccounting.sol";

/// @dev The KBF audit on the results layer: confirmations, report rounds, credits and the
///      checks KBF owns (auditor epochs, evidence ownership, self-audits, staked agents), with
///      rewards claimed on the results layer.
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
        gate.setEmissionsReserve(address(0x5E5E));
        pools = new MockVerificationSellerPools();
        registry.setIdentityRegistry(address(identityRegistry));
        registry.setEmissions(address(gate));
        // Deployed the epoch before, so KBF's share (which applies from the next epoch) covers EPOCH.
        gate.setCurrentEpoch(EPOCH - 1);
        (results, kbf) = _deploy();
        gate.setCurrentEpoch(EPOCH);
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
            agentId, SERVICE_A, MODEL_A, NONE, SAME, address(kbf), gate.currentEpoch(), gate.currentEpoch() + 2
        );
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(agentId, 1, 0);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
    }

    function test_kbfSetsHowLongItsVerdictsCount() public {
        assertEq(kbf.validityEpochs(), 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.serviceStatus(agentId, SERVICE_A).validUntilEpoch, EPOCH + 2, "this epoch and the next");
        _advance(2);
        assertFalse(results.isVerified(agentId));

        vm.expectEmit(false, false, false, true, address(kbf));
        emit AntseedKbfAudits.ValidityEpochsSet(3);
        kbf.setValidityEpochs(3);
        assertFalse(results.isVerified(agentId), "recorded verdicts keep their expiry");
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.serviceStatus(agentId, SERVICE_A).validUntilEpoch, EPOCH + 5);
        _advance(2);
        assertTrue(results.isVerified(agentId), "a new verdict counts for three epochs");
        _advance(1);
        assertFalse(results.isVerified(agentId));

        kbf.setValidityEpochs(1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId));
        _advance(1);
        assertFalse(results.isVerified(agentId), "one epoch only");
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
            agentId, SERVICE_A, MODEL_A, SAME, DIFF, address(kbf), gate.currentEpoch(), gate.currentEpoch() + 2
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
            agentId, SERVICE_A, MODEL_A, SAME, UNDETERMINED, address(kbf), gate.currentEpoch(), gate.currentEpoch() + 2
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
        kbf.setValidityEpochs(3);
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
        kbf.setRequiredReports(DIFF, 3);
        vm.stopPrank();

        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setRequiredReports(NONE, 1);
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setRequiredReports(SAME, 0);

        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setValidityEpochs(0);
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setValidityEpochs(5);
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

    function test_creditsPerAuditAreSetByTheOwnerAndPerModel() public {
        assertEq(kbf.creditsPerAudit(), 1);
        assertEq(kbf.creditsFor(MODEL_A), 1, "default");

        vm.expectEmit(false, false, false, true, address(kbf));
        emit AntseedKbfAudits.CreditsPerAuditSet(3);
        kbf.setCreditsPerAudit(3);
        vm.expectEmit(true, false, false, true, address(kbf));
        emit AntseedKbfAudits.ModelCreditsPerAuditSet(MODEL_B, 10);
        kbf.setModelCreditsPerAudit(MODEL_B, 10);
        assertEq(kbf.creditsFor(MODEL_A), 3, "the default applies to models without their own amount");
        assertEq(kbf.creditsFor(MODEL_B), 10);

        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.AuditCredited(EPOCH, auditorA, MODEL_A, 3);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.AuditCredited(EPOCH, auditorA, MODEL_B, 10);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 13);
        assertEq(kbf.creditedAudits(EPOCH, auditorA, MODEL_B), 1, "counts audits, not credits");

        _audit(auditorB, MODEL_B, agentId, SERVICE_B, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), uint256(900 ether) * 13 / 23, "13 of the 23 credits");
        assertEq(results.pendingAuditorReward(address(kbf), auditorB, EPOCH), uint256(900 ether) * 10 / 23);

        kbf.setModelCreditsPerAudit(MODEL_B, 0);
        assertEq(kbf.creditsFor(MODEL_B), 3, "0 removes the override");
    }

    function test_creditsArePositiveAndOwnerSet() public {
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setCreditsPerAudit(0);
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setModelCreditsPerAudit(bytes32(0), 2);
        vm.startPrank(auditorA);
        vm.expectRevert();
        kbf.setCreditsPerAudit(2);
        vm.expectRevert();
        kbf.setModelCreditsPerAudit(MODEL_A, 2);
        vm.stopPrank();
    }

    function test_theResultsCapBoundsLargeCreditAmounts() public {
        results.setMaxCreditsPerAuditorPerEpoch(address(kbf), 5);
        kbf.setCreditsPerAudit(4);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.AuditCredited(EPOCH, auditorA, MODEL_B, 1);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 5, "clamped to the per-auditor cap");
    }

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
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerificationResults.AlreadyClaimed.selector);
        results.claimAuditorReward(address(kbf), EPOCH);
        assertEq(gate.minted(auditorA), 600 ether);
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
        assertEq(kbf.creditedAudits(EPOCH, auditorA, MODEL_A), 3, "fourth audit earns nothing");
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
        assertEq(results.pendingAuditorReward(address(kbf), auditorA, EPOCH), 180 ether, "675 capped at 20% of 900");
        assertEq(results.pendingAuditorReward(address(kbf), auditorB, EPOCH), 180 ether, "225 capped at 20% of 900");
        assertEq(_claim(auditorA), 180 ether);
        assertEq(_claim(auditorB), 180 ether);
        assertEq(gate.minted(address(0x5E5E)), 540 ether, "the capped part goes to the reserve");
        assertEq(gate.epochMinted(EPOCH), 900 ether, "the whole bucket is accounted for");
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
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerificationResults.EpochNotFinalized.selector);
        results.claimAuditorReward(address(kbf), EPOCH);
    }

    function test_currentEpochShowsNoPendingReward() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertGt(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 0);
        assertEq(results.pendingAuditorReward(address(kbf), auditorA, EPOCH), 0, "current epoch is not final");

        gate.setCurrentEpoch(EPOCH + 1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.pendingAuditorReward(address(kbf), auditorA, EPOCH + 1), 0, "new current epoch is not final");
        assertEq(results.pendingAuditorReward(address(kbf), auditorA, EPOCH), 900 ether, "finished epoch is claimable");
        assertEq(_claim(auditorA), 900 ether);
    }

    function test_unfundedBucketStaysClaimable() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setBudget(address(results), EPOCH, 0);
        gate.setCurrentEpoch(EPOCH + 1);
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerificationResults.NothingToClaim.selector);
        results.claimAuditorReward(address(kbf), EPOCH);
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
        assertEq(address(kbf.identityRegistry()), address(identityRegistry));

        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        new AntseedVerificationResults(address(0));
        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        new AntseedVerificationResults(address(0x1234));
    }

    // ── confirmations ────────────────────────────────────────────────

    function test_defaultsNeedASecondAuditorForADiffOnly() public {
        AntseedKbfAudits fresh = new AntseedKbfAudits(address(results), address(pools), address(identityRegistry));
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
            agentId, SERVICE_A, MODEL_A, SAME, DIFF, address(kbf), gate.currentEpoch(), gate.currentEpoch() + 2
        );
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertFalse(results.isVerified(agentId));
        assertEq(results.agentStatus(agentId).diffCount, 1);
    }

    function test_clearingAConfirmedDiffNeedsTwoAuditors() public {
        kbf.setDiffReplacementReports(2); // strict mode: clearing a DIFF needs two auditors
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
        kbf.setDiffReplacementReports(2); // strict mode: clearing a DIFF needs two auditors
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
        kbf.setDiffReplacementReports(2); // strict mode: clearing a DIFF needs two auditors
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
        kbf.setDiffReplacementReports(2); // strict mode: clearing a DIFF needs two auditors
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
        kbf.setDiffReplacementReports(2); // strict mode: clearing a DIFF needs two auditors
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

    function test_approvedAuditorsSetAndUpdateTheirOwnProfile() public {
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorProfileSet(auditorA, "Acme Labs", "ipfs://icon", "https://acme.example");
        vm.prank(auditorA);
        kbf.setAuditorProfile("Acme Labs", "ipfs://icon", "https://acme.example");
        IAntseedKbfAudits.AuditorProfile memory profile = kbf.auditorProfile(auditorA);
        assertEq(profile.name, "Acme Labs");
        assertEq(profile.iconUri, "ipfs://icon");
        assertEq(profile.url, "https://acme.example");
        assertEq(kbf.auditorProfile(auditorB).name, "", "others are untouched");

        vm.prank(auditorA);
        kbf.setAuditorProfile("Acme", "", "");
        profile = kbf.auditorProfile(auditorA);
        assertEq(profile.name, "Acme");
        assertEq(profile.iconUri, "", "every call replaces the whole profile");
    }

    function test_onlyApprovedAuditorsSetAProfileAndRevokedOnesKeepIt() public {
        vm.prank(address(0xE5));
        vm.expectRevert(AntseedKbfAudits.NotApprovedAuditor.selector);
        kbf.setAuditorProfile("Stranger", "", "");

        vm.prank(auditorA);
        kbf.setAuditorProfile("Acme", "", "");
        kbf.setAuditor(auditorA, false);
        assertEq(kbf.auditorProfile(auditorA).name, "Acme", "still readable after revocation");
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfAudits.NotApprovedAuditor.selector);
        kbf.setAuditorProfile("Changed", "", "");
    }

    function test_profileFieldsAreLengthLimited() public {
        uint256 nameMax = kbf.MAX_PROFILE_NAME_BYTES();
        uint256 uriMax = kbf.MAX_PROFILE_URI_BYTES();
        string memory name = _text("", nameMax);
        string memory uri = _text("https://", uriMax);
        string memory longName = _text("", nameMax + 1);
        string memory longUri = _text("https://", uriMax + 1);
        vm.startPrank(auditorA);
        kbf.setAuditorProfile(name, uri, uri); // at the limits
        vm.expectRevert(AntseedKbfAudits.InvalidProfile.selector);
        kbf.setAuditorProfile(longName, "", "");
        vm.expectRevert(AntseedKbfAudits.InvalidProfile.selector);
        kbf.setAuditorProfile("", longUri, "");
        vm.expectRevert(AntseedKbfAudits.InvalidProfile.selector);
        kbf.setAuditorProfile("", "", longUri);
        vm.stopPrank();
    }

    function test_profileLinksMustBeHttpsOrIpfsAndSafe() public {
        string[9] memory bad = [
            "javascript:alert(1)",
            "data:image/png;base64,AAAA",
            "http://insecure.example",
            "https://",
            "https://a.example/x y",
            "https://a.example/\"onerror=x",
            "https://a.example/<script>",
            "https://a.example/'x",
            "https://a.example/`x"
        ];
        vm.startPrank(auditorA);
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(AntseedKbfAudits.InvalidProfile.selector);
            kbf.setAuditorProfile("", bad[i], "");
            vm.expectRevert(AntseedKbfAudits.InvalidProfile.selector);
            kbf.setAuditorProfile("", "", bad[i]);
        }
        vm.expectRevert(AntseedKbfAudits.InvalidProfile.selector);
        kbf.setAuditorProfile("bad\nname", "", "");
        kbf.setAuditorProfile(unicode"Ünïcode Labs ✓", "ipfs://bafyicon", "https://acme.example/team?x=1#top");
        vm.stopPrank();
        assertEq(kbf.auditorProfile(auditorA).iconUri, "ipfs://bafyicon");
    }

    function test_ownerClearsAProfile() public {
        vm.prank(auditorA);
        kbf.setAuditorProfile("Acme", "ipfs://icon", "https://acme.example");
        vm.prank(auditorB);
        vm.expectRevert();
        kbf.clearAuditorProfile(auditorA);

        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorProfileSet(auditorA, "", "", "");
        kbf.clearAuditorProfile(auditorA);
        IAntseedKbfAudits.AuditorProfile memory profile = kbf.auditorProfile(auditorA);
        assertEq(profile.name, "");
        assertEq(profile.iconUri, "");
        assertEq(profile.url, "");
    }

    function test_anyAuditorMaySubmitAnEvidenceHashSoNoneCanBeSquatted() public {
        bytes32 evidence = keccak256("shared-evidence");
        IAntseedKbfAudits.ServiceResult[] memory unknownAgent = _single(999, SERVICE_A, SAME);
        vm.prank(auditorB); // e.g. copied from auditor A's pending transaction, against an unknown agent
        kbf.submitModelAudit(EPOCH, MODEL_A, evidence, "", unknownAgent);
        vm.prank(auditorA);
        kbf.submitModelAudit(EPOCH, MODEL_A, evidence, "", _single(agentId, SERVICE_A, SAME));
        assertTrue(results.isVerified(agentId), "the original audit still records");
    }

    function test_byDefaultOneSameReplacesAConfirmedDiff() public {
        assertEq(kbf.diffReplacementReports(), 1);
        kbf.setRequiredReports(DIFF, 2); // the deployed default
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_A)), uint8(DIFF), "two auditors confirm the DIFF");
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_A)), uint8(SAME), "one SAME replaces it");
        assertTrue(results.isVerified(agentId));
    }

    function test_aDiffStillNeedsTwoAuditorsWhenReplacementNeedsOne() public {
        kbf.setRequiredReports(DIFF, 2); // the deployed default
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_A)), uint8(NONE), "one DIFF only waits");
    }

    function test_onlyTheOwnerSetsDiffReplacementReportsAndNeverZero() public {
        vm.expectRevert(AntseedKbfAudits.InvalidValue.selector);
        kbf.setDiffReplacementReports(0);
        vm.prank(auditorA);
        vm.expectRevert();
        kbf.setDiffReplacementReports(2);
        vm.expectEmit(false, false, false, true, address(kbf));
        emit AntseedKbfAudits.DiffReplacementReportsSet(2);
        kbf.setDiffReplacementReports(2);
        assertEq(kbf.diffReplacementReports(), 2);
    }

    function test_approvalEmitsOnEveryCallAndOnlyRevocationsCount() public {
        address newcomer = address(0xE5);
        assertFalse(kbf.approvedAuditors(newcomer));
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorSet(newcomer, true, kbf.auditorRevocations());
        kbf.setAuditor(newcomer, true);
        assertTrue(kbf.approvedAuditors(newcomer));

        uint256 revocations = kbf.auditorRevocations();
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorSet(newcomer, true, revocations);
        kbf.setAuditor(newcomer, true); // already approved: still emits, counts nothing
        assertEq(kbf.auditorRevocations(), revocations);
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorSet(newcomer, false, revocations + 1);
        kbf.setAuditor(newcomer, false);
        assertFalse(kbf.approvedAuditors(newcomer));
        assertEq(kbf.auditorRevocations(), revocations + 1);
        vm.expectEmit(true, false, false, true, address(kbf));
        emit IAntseedKbfAudits.AuditorSet(newcomer, false, revocations + 1);
        kbf.setAuditor(newcomer, false); // already revoked: still emits, counts nothing
        assertEq(kbf.auditorRevocations(), revocations + 1);
    }

    function test_onlyOwnerApprovesAuditors() public {
        vm.prank(auditorA);
        vm.expectRevert();
        kbf.setAuditor(address(0xB0B), true);
        vm.expectRevert(AntseedKbfAudits.InvalidAddress.selector);
        kbf.setAuditor(address(0), true);
        vm.expectRevert(AntseedKbfAudits.InvalidAddress.selector);
        new AntseedKbfAudits(address(0x1234), address(pools), address(identityRegistry));
        vm.expectRevert(AntseedKbfAudits.InvalidAddress.selector);
        new AntseedKbfAudits(address(results), address(pools), address(0x1234));
    }

    function test_anotherAuditsDiffNeedsAKbfDiffQuorumToReplace() public {
        kbf.setDiffReplacementReports(2); // strict mode: clearing a DIFF needs two auditors
        kbf.setRequiredReports(DIFF, 2);
        MockVerificationAudit probes = new MockVerificationAudit(address(results));
        results.setAudit(address(probes), true);
        probes.record(agentId, SERVICE_A, MODEL_A, DIFF);
        assertEq(results.diffChanges(agentId, SERVICE_A), 1, "another audit's DIFF moves the KBF round too");

        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.ServiceAudited(agentId, SERVICE_A, auditorA, MODEL_A, SAME, 1, 1, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(DIFF), "one SAME does not clear a live DIFF");
        assertEq(status.audit, address(probes));
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 1, "the audit still earns its credit");

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(SAME), "a DIFF-sized quorum clears it");
        assertEq(status.audit, address(kbf));
        assertEq(results.diffChanges(agentId, SERVICE_A), 2, "clearing the DIFF starts a new round");
        assertTrue(results.isVerified(agentId));
    }

    function test_supportFromBeforeAnotherAuditsDiffCannotClearIt() public {
        kbf.setDiffReplacementReports(2); // strict mode: clearing a DIFF needs two auditors
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME); // recorded: SAME needs one report
        MockVerificationAudit probes = new MockVerificationAudit(address(results));
        results.setAudit(address(probes), true);
        probes.record(agentId, SERVICE_A, MODEL_A, DIFF);

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(
            uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF), "A's SAME from before the DIFF does not count"
        );
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME), "two fresh reports clear it");
    }

    function test_anotherAuditCanOverwriteKbfVerdicts() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        MockVerificationAudit probes = new MockVerificationAudit(address(results));
        results.setAudit(address(probes), true);
        probes.record(agentId, SERVICE_A, MODEL_A, SAME);
        assertEq(results.serviceStatus(agentId, SERVICE_A).audit, address(probes));
        assertTrue(results.isVerified(agentId), "the results layer takes the latest record from any audit");
    }

    function test_roundsMoveOnlyWhenAServiceMovesIntoOrOutOfDiff() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(results.diffChanges(agentId, SERVICE_A), 0);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(results.diffChanges(agentId, SERVICE_A), 1, "into DIFF");
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(results.diffChanges(agentId, SERVICE_A), 1, "still DIFF");
        _audit(auditorB, MODEL_B, agentId, SERVICE_A, DIFF);
        assertEq(results.diffChanges(agentId, SERVICE_A), 3, "a new model resets the DIFF (out) before recording its DIFF (in)");
        _audit(auditorC, MODEL_B, agentId, SERVICE_A, UNDETERMINED);
        assertEq(results.diffChanges(agentId, SERVICE_A), 4, "out of DIFF");
        _audit(auditorC, MODEL_B, agentId, SERVICE_A, SAME);
        assertEq(results.diffChanges(agentId, SERVICE_A), 4, "no DIFF involved");
        assertEq(kbf.reportRound(agentId, SERVICE_A), 4);
        kbf.setAuditor(auditorD, false);
        assertEq(kbf.reportRound(agentId, SERVICE_A), 5, "a revocation moves every round");
    }

    function test_clearingADiffStartsANewRound() public {
        kbf.setRequiredReports(DIFF, 2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF); // waits in the round after the DIFF
        uint256 roundBefore = kbf.reportRound(agentId, SERVICE_A);

        uint256[] memory agents = new uint256[](1);
        bytes32[] memory services = new bytes32[](1);
        agents[0] = agentId;
        services[0] = SERVICE_A;
        results.clearServiceStatuses(agents, services);
        assertGt(kbf.reportRound(agentId, SERVICE_A), roundBefore, "a clear moves the round");

        _audit(auditorD, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(
            uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE), "reports from before the clear do not count"
        );
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(results.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF), "two fresh reports record it");
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

    function test_anEpochWithoutAKbfShareHasNothingToClaim() public {
        results.setAuditShareBps(address(kbf), 0); // from EPOCH + 1 on
        gate.setCurrentEpoch(EPOCH + 1);
        gate.setBudget(address(results), EPOCH + 1, 900 ether);
        pools.setPower(agentId, EPOCH + 1, 300);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(results.isVerified(agentId), "the audit still records its verdict");
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH + 1, auditorA), 0, "no share, no credits");
        assertEq(kbf.creditedAudits(EPOCH + 1, auditorA, MODEL_A), 0, "and the audit slot is not used up");

        gate.setCurrentEpoch(EPOCH + 2);
        assertEq(results.pendingAuditorReward(address(kbf), auditorA, EPOCH + 1), 0, "no share, nothing pending");
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerificationResults.NothingToClaim.selector);
        results.claimAuditorReward(address(kbf), EPOCH + 1);
        assertFalse(results.auditorEpochClaimed(address(kbf), EPOCH + 1, auditorA));
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
        assertEq(kbf.creditedAudits(EPOCH, auditorA, MODEL_A), 1);
        assertEq(kbf.creditedAudits(EPOCH, auditorA, MODEL_B), 0, "the per-auditor cap credited nothing");

        results.setMaxCreditsPerAuditorPerEpoch(address(kbf), 2);
        vm.expectEmit(true, true, true, true, address(kbf));
        emit AntseedKbfAudits.AuditCredited(EPOCH, auditorA, MODEL_B, 1);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(kbf.creditedAudits(EPOCH, auditorA, MODEL_B), 1, "so the model can still earn once the cap allows");
        assertEq(results.auditorEpochCredits(address(kbf), EPOCH, auditorA), 2);
    }

    function test_removedAuditCannotRecord() public {
        results.setAudit(address(kbf), false);
        _expectAuditRevert(AntseedVerificationResults.NotAudit.selector);
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
                kbf.setValidityEpochs(uint8(1 + (step >> 5) % 4));
            } else {
                IAntseedVerificationResults.Verdict verdict = step % 3 == 0 ? SAME : step % 3 == 1 ? DIFF : UNDETERMINED;
                _audit(auditors[(step >> 1) % 3], models[(step >> 5) % 3], agentId, service, verdict);
            }
            uint256 current = gate.currentEpoch();
            uint256 verified;
            uint256 diffs;
            for (uint256 j = 0; j < services.length; j++) {
                IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, services[j]);
                if (current >= status.validUntilEpoch) continue;
                if (status.verdict == SAME) verified += 1;
                else if (status.verdict == DIFF) diffs += 1;
            }
            IAntseedVerificationResults.AgentStatus memory agent = results.agentStatus(agentId);
            assertEq(agent.verifiedCount, verified);
            assertEq(agent.diffCount, diffs);
            assertEq(results.isVerified(agentId), verified > 0 && diffs == 0);
            uint256 multiplier = 100 + 10 * verified;
            uint256 penalty = 10 * uint256(diffs) * diffs;
            assertEq(_sellerPoints(policy), multiplier > penalty ? multiplier - penalty : 0);
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

    /// @dev A results layer and the KBF audit on it at the whole bucket.
    function _deploy() private returns (AntseedVerificationResults results_, AntseedKbfAudits kbf_) {
        results_ = new AntseedVerificationResults(address(gate));
        kbf_ = new AntseedKbfAudits(address(results_), address(pools), address(identityRegistry));
        results_.setAudit(address(kbf_), true);
        results_.setAuditShareBps(address(kbf_), 10_000);
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

    /// @dev Claims `auditor`'s reward for EPOCH and returns what it received.
    function _claim(address auditor) private returns (uint256) {
        uint256 before = gate.minted(auditor);
        vm.prank(auditor);
        results.claimAuditorReward(address(kbf), EPOCH);
        return gate.minted(auditor) - before;
    }

    function _expectInvalidResults(IAntseedKbfAudits.ServiceResult[] memory batch) private {
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfAudits.InvalidResults.selector);
        kbf.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", batch);
    }

    /// @dev `prefix` padded with "a" to `length` bytes.
    function _text(string memory prefix, uint256 length) private pure returns (string memory) {
        bytes memory out = new bytes(length);
        bytes memory head = bytes(prefix);
        for (uint256 i = 0; i < length; i++) {
            out[i] = i < head.length ? head[i] : bytes1("a");
        }
        return string(out);
    }
}
