// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AntseedRegistry} from "../../core/AntseedRegistry.sol";
import {IAntseedKbfVerification} from "../../interfaces/IAntseedKbfVerification.sol";
import {AntseedKbfVerification} from "../../verification/AntseedKbfVerification.sol";
import {AntseedKbfVerificationPointsPolicy} from "../../policies/AntseedKbfVerificationPointsPolicy.sol";
import {MockERC8004Registry} from "../mocks/MockERC8004Registry.sol";
import {MockVerificationEmissionsGate} from "../mocks/MockVerificationEmissionsGate.sol";
import {MockVerificationSellerPools} from "../mocks/MockVerificationSellerPools.sol";

/// @dev Mirrors AntseedUsageAccounting after M001: `registry.emissions()` resolves here, and the
///      gate is only reachable through `emissionsGate()`.
contract UsageAccountingFront {
    address public immutable emissionsGate;

    constructor(address gate) {
        emissionsGate = gate;
    }

    function currentEpoch() external view returns (uint256) {
        return MockVerificationEmissionsGate(emissionsGate).currentEpoch();
    }
}

contract VerificationPointsAccounting {
    address public immutable sellerPools;

    constructor(address pools) {
        sellerPools = pools;
    }
}

contract AntseedKbfVerificationTest is Test {
    uint256 private constant EPOCH = 5;
    bytes32 private constant MODEL_A = keccak256("model-a");
    bytes32 private constant MODEL_B = keccak256("model-b");
    bytes32 private constant SERVICE_A = bytes32(uint256(1));
    bytes32 private constant SERVICE_B = bytes32(uint256(2));

    IAntseedKbfVerification.Verdict private constant SAME = IAntseedKbfVerification.Verdict.SAME;
    IAntseedKbfVerification.Verdict private constant DIFF = IAntseedKbfVerification.Verdict.DIFF;
    IAntseedKbfVerification.Verdict private constant NONE = IAntseedKbfVerification.Verdict.NONE;
    IAntseedKbfVerification.Verdict private constant UNDETERMINED = IAntseedKbfVerification.Verdict.UNDETERMINED;

    address private auditorA = address(0xA1);
    address private auditorB = address(0xB2);
    address private auditorC = address(0xC3);
    address private seller = address(0x5E1);

    AntseedRegistry private registry;
    AntseedKbfVerification private verification;
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
        verification = new AntseedKbfVerification(address(registry), address(pools));
        verification.setAuditor(auditorA, true);
        verification.setAuditor(auditorB, true);
        verification.setAuditor(auditorC, true);
        gate.setCurrentEpoch(EPOCH);
        gate.setBudget(address(verification), EPOCH, 900 ether);
        verification.setRewardsStartEpoch(0);
        verification.setMaxAuditorShareBps(10_000);
        agentId = _register(seller, 300);
    }

    // ── status ───────────────────────────────────────────────────────

    function test_sameCountsForTwoEpochs() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
        IAntseedKbfVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1);
        assertEq(agent.diffCount, 0);
        IAntseedKbfVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(service.modelHash, MODEL_A);
        assertEq(uint8(service.verdict), uint8(SAME));
        assertEq(service.epoch, EPOCH);

        _advance(1);
        assertTrue(verification.isVerified(agentId), "still live in the next epoch");
        _advance(1);
        assertFalse(verification.isVerified(agentId));
        assertEq(verification.agentStatus(agentId).verifiedCount, 0);
        service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(SAME), "stored record stays");
        assertEq(service.epoch, EPOCH);
    }

    function test_expiredVerdictsLeavePointsWithoutCleanup() public {
        AntseedKbfVerificationPointsPolicy policy = _pointsPolicy();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(_sellerPoints(policy), 120);
        _advance(1);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        assertEq(_sellerPoints(policy), 100, "one SAME bonus, one DIFF penalty");
        _advance(1);
        assertEq(verification.agentStatus(agentId).verifiedCount, 0);
        assertEq(verification.agentStatus(agentId).diffCount, 1);
        assertEq(_sellerPoints(policy), 90, "SAME from two epochs ago no longer counts");
        _advance(1);
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        assertEq(_sellerPoints(policy), 100, "DIFF expires like SAME");
    }

    function test_repeatedVerdictMovesItToTheCurrentEpoch() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.agentStatus(agentId).verifiedCount, 1, "same-epoch repeat counts once");
        _advance(1);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).epoch, EPOCH + 1);
        assertEq(verification.agentStatus(agentId).verifiedCount, 1, "moved, not double counted");
        _advance(1);
        assertTrue(verification.isVerified(agentId));
        _advance(1);
        assertFalse(verification.isVerified(agentId));
    }

    function test_eachServiceExpiresIndependently() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _advance(1);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(verification.agentStatus(agentId).verifiedCount, 2);
        _advance(1);
        assertEq(verification.agentStatus(agentId).verifiedCount, 1);
        assertTrue(verification.isVerified(agentId));
    }

    function test_newResultOnExpiredServiceStartsFresh() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _advance(2);
        vm.expectEmit(true, true, false, true, address(verification));
        emit AntseedKbfVerification.ServiceStatusChanged(agentId, SERVICE_A, MODEL_A, NONE, SAME);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedKbfVerification.AgentStatusChanged(agentId, 1, 0);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
    }

    function test_validityEpochsAppliesToExistingVerdicts() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _advance(2);
        assertFalse(verification.isVerified(agentId));
        verification.setValidityEpochs(3);
        assertTrue(verification.isVerified(agentId));
        verification.setValidityEpochs(1);
        assertFalse(verification.isVerified(agentId));
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
        _advance(1);
        assertFalse(verification.isVerified(agentId));
    }

    function test_agentStatusAtEpochZero() public {
        gate.setCurrentEpoch(0);
        vm.prank(auditorA);
        verification.submitModelAudit(0, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));
        assertEq(verification.agentStatus(agentId).verifiedCount, 1);
    }

    function test_statusReadsStayCheapWithManyServices() public {
        AntseedKbfVerificationPointsPolicy policy = _pointsPolicy();
        for (uint256 batch = 0; batch < 3; batch++) {
            IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](256);
            for (uint256 i = 0; i < results.length; i++) {
                results[i] = _result(agentId, bytes32(batch * 256 + i + 1), SAME);
            }
            vm.prank(auditorA);
            verification.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", results);
        }
        assertEq(verification.agentStatus(agentId).verifiedCount, 768, "no per-agent service cap");
        vm.cool(address(verification));
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
        assertEq(verification.agentStatus(agentId).verifiedCount, 2);
    }

    function test_diffAffectsOnlyThatServiceButBlocksAgentVerification() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        IAntseedKbfVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1, "service A stays verified");
        assertEq(agent.diffCount, 1);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME));
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_B).verdict), uint8(DIFF));
        assertFalse(verification.isVerified(agentId));
    }

    function test_sameAfterDiffRestoresService() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        IAntseedKbfVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1);
        assertEq(agent.diffCount, 0);
        assertTrue(verification.isVerified(agentId));

        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 0);
        assertEq(agent.diffCount, 1);
    }

    function test_singleDiffLandsAndLatestResultWins() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        vm.expectEmit(true, true, false, true, address(verification));
        emit AntseedKbfVerification.ServiceStatusChanged(agentId, SERVICE_A, MODEL_A, SAME, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(verification.agentStatus(agentId).diffCount, 1, "one auditor's DIFF counts");
        assertFalse(verification.isVerified(agentId));
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(verification.agentStatus(agentId).diffCount, 1, "repeat DIFF counts once");
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        assertTrue(verification.isVerified(agentId));
    }

    function test_undeterminedReplacesDiff() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(UNDETERMINED));
        assertEq(verification.agentStatus(agentId).diffCount, 0, "latest result wins");
    }

    function test_undeterminedReplacesSame() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        IAntseedKbfVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(UNDETERMINED));
        assertEq(service.epoch, EPOCH);
        assertEq(service.modelHash, MODEL_A);
        assertFalse(verification.isVerified(agentId));

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));

        _advance(1);
        vm.expectEmit(true, true, false, true, address(verification));
        emit AntseedKbfVerification.ServiceStatusChanged(agentId, SERVICE_A, MODEL_A, SAME, UNDETERMINED);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedKbfVerification.AgentStatusChanged(agentId, 0, 0);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(UNDETERMINED), "latest result wins");
        assertEq(service.epoch, EPOCH + 1);
        assertEq(verification.agentStatus(agentId).verifiedCount, 0);
        assertFalse(verification.isVerified(agentId));

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId), "a new SAME verifies again");
    }

    function test_modelChangeResetsServiceStatus() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_B, agentId, SERVICE_A, SAME);
        IAntseedKbfVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.diffCount, 0, "old model's DIFF does not carry over");
        assertEq(agent.verifiedCount, 1);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).modelHash, MODEL_B);

        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(verification.agentStatus(agentId).verifiedCount, 0, "model change drops the verdict");
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(UNDETERMINED));
        assertEq(verification.serviceStatus(agentId, SERVICE_A).modelHash, MODEL_A);
    }

    function test_ownerCanClearServiceStatus() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        assertFalse(verification.isVerified(agentId));
        _clear(agentId, SERVICE_B);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_B).verdict), uint8(NONE));
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        assertTrue(verification.isVerified(agentId));
    }

    function test_clearingExpiredStatusesDoesNotUnderflow() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        _advance(2);
        _clear(agentId, SERVICE_A);
        _clear(agentId, SERVICE_B);
        _clear(agentId, SERVICE_B);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
        _clear(agentId, SERVICE_A);
        assertFalse(verification.isVerified(agentId));
    }

    function test_oneSubmissionCoversManySellers() public {
        uint256 other = _register(address(0x5E2), 100);
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](2);
        results[0] = _result(agentId, SERVICE_A, SAME);
        results[1] = _result(other, SERVICE_A, DIFF);

        vm.expectEmit(true, true, true, true, address(verification));
        emit AntseedKbfVerification.ServiceAudited(agentId, SERVICE_A, auditorA, MODEL_A, SAME);
        vm.expectEmit(true, true, true, true, address(verification));
        emit AntseedKbfVerification.ServiceAudited(other, SERVICE_A, auditorA, MODEL_A, DIFF);
        vm.expectEmit(true, true, true, true, address(verification));
        emit AntseedKbfVerification.ModelAudited(MODEL_A, auditorA, EPOCH, keccak256("evidence"), "ipfs://cid", 2);
        vm.prank(auditorA);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "ipfs://cid", results);

        assertTrue(verification.isVerified(agentId));
        assertEq(verification.agentStatus(other).diffCount, 1);
    }

    function test_batchStatusEventsAccumulateWithinAgentAndResetBetweenAgents() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_B, DIFF);
        uint256 other = _register(address(0x5E2), 100);
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](4);
        results[0] = _result(agentId, SERVICE_A, DIFF);
        results[1] = _result(agentId, SERVICE_B, SAME);
        results[2] = _result(other, SERVICE_A, SAME);
        results[3] = _result(other, SERVICE_B, DIFF);

        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedKbfVerification.AgentStatusChanged(agentId, 0, 2);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedKbfVerification.AgentStatusChanged(agentId, 1, 1);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedKbfVerification.AgentStatusChanged(other, 1, 0);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedKbfVerification.AgentStatusChanged(other, 1, 1);
        vm.prank(auditorB);
        verification.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", results);
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
        verification.clearServiceStatuses(agents, services);

        assertEq(verification.agentStatus(agentId).diffCount, 0);
        assertEq(verification.agentStatus(other).diffCount, 0);
        assertEq(uint8(verification.serviceStatus(other, SERVICE_A).verdict), uint8(NONE));
    }

    function test_clearRejectsMismatchedLists() public {
        uint256[] memory agents = new uint256[](2);
        bytes32[] memory services = new bytes32[](1);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.clearServiceStatuses(agents, services);
    }

    function test_clearResetsUndetermined() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        _clear(agentId, SERVICE_A);
        IAntseedKbfVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(NONE));
        assertEq(service.epoch, 0);
        assertEq(service.modelHash, MODEL_A);
    }

    // ── access and validation ────────────────────────────────────────

    function test_rejectsUnapprovedAuditor() public {
        _expectAuditRevert(AntseedKbfVerification.NotApprovedAuditor.selector);
        _audit(address(0xBAD), MODEL_A, agentId, SERVICE_A, SAME);

        verification.setAuditor(auditorA, false);
        _expectAuditRevert(AntseedKbfVerification.NotApprovedAuditor.selector);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
    }

    function test_rejectsSelfAudit() public {
        verification.setAuditor(seller, true);
        _expectAuditRevert(AntseedKbfVerification.SelfAudit.selector);
        _audit(seller, MODEL_A, agentId, SERVICE_A, SAME);
    }

    function test_skipsUnknownAgentWithoutFailingTheBatch() public {
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](2);
        results[0] = _result(agentId, SERVICE_A, SAME);
        results[1] = _result(999, SERVICE_A, DIFF);
        vm.expectEmit(address(verification));
        emit AntseedKbfVerification.UnknownAgentSkipped(999, MODEL_A);
        vm.prank(auditorA);
        verification.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", results);
        assertTrue(verification.isVerified(agentId), "known agents in the batch still count");
        assertEq(uint8(verification.serviceStatus(999, SERVICE_A).verdict), uint8(IAntseedKbfVerification.Verdict.NONE));
        assertEq(verification.agentStatus(999).diffCount, 0);
        assertEq(verification.epochCredits(EPOCH), 1);
    }

    function test_unknownAgentAloneEarnsNoCredit() public {
        _audit(auditorA, MODEL_A, 999, SERVICE_A, SAME);
        assertEq(verification.epochCredits(EPOCH), 0);
    }

    function testFuzz_rejectsZeroAgent(uint8 verdictSeed) public {
        IAntseedKbfVerification.Verdict verdict = IAntseedKbfVerification.Verdict(bound(verdictSeed, 1, 3));
        _expectAuditRevert(AntseedKbfVerification.UnknownAgent.selector);
        _audit(auditorA, MODEL_A, 0, SERVICE_A, verdict);
        assertFalse(verification.isVerified(0));
        assertEq(verification.agentStatus(0).verifiedCount, 0);
        assertEq(verification.agentStatus(0).diffCount, 0);
    }

    function test_rejectsZeroAgentBeforeValidAgent() public {
        bytes32 evidence = keccak256("zero-agent-evidence");
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](2);
        results[0] = _result(0, SERVICE_A, SAME);
        results[1] = _result(agentId, SERVICE_A, SAME);
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfVerification.UnknownAgent.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, evidence, "", results);

        assertFalse(verification.isVerified(0));
        assertFalse(verification.isVerified(agentId));
        assertEq(verification.epochCredits(EPOCH), 0);

        vm.prank(auditorA);
        verification.submitModelAudit(EPOCH, MODEL_A, evidence, "", _single(agentId, SERVICE_A, SAME));
        assertTrue(verification.isVerified(agentId));
        assertEq(verification.epochCredits(EPOCH), 1);
    }

    function test_rejectsStaleEpoch() public {
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfVerification.EpochChanged.selector);
        verification.submitModelAudit(EPOCH - 1, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
    }

    function test_sameEvidenceCanBeSubmittedAgain() public {
        vm.startPrank(auditorA);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
        vm.stopPrank();
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 1, "per-model cap still holds");
    }

    function test_rejectsInvalidResults() public {
        uint256 other = _register(address(0x5E2), 100);
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](0);
        _expectInvalidResults(results);

        _expectInvalidResults(_single(agentId, SERVICE_A, NONE));
        _expectInvalidResults(_single(agentId, bytes32(0), SAME));

        results = new IAntseedKbfVerification.ServiceResult[](2);
        results[0] = _result(agentId, SERVICE_B, SAME);
        results[1] = _result(agentId, SERVICE_A, SAME);
        _expectInvalidResults(results);

        results[0] = _result(agentId, SERVICE_A, SAME);
        results[1] = _result(agentId, SERVICE_A, DIFF);
        _expectInvalidResults(results);

        results[0] = _result(other, SERVICE_A, SAME);
        results[1] = _result(agentId, SERVICE_A, SAME);
        _expectInvalidResults(results);
    }

    function test_validatesModelAndEvidence() public {
        IAntseedKbfVerification.ServiceResult[] memory results = _single(agentId, SERVICE_A, SAME);
        vm.startPrank(auditorA);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.submitModelAudit(EPOCH, bytes32(0), keccak256("evidence"), "", results);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, bytes32(0), "", results);
        vm.expectRevert(AntseedKbfVerification.InvalidEvidenceUri.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "https://example.com/e", results);
        vm.expectRevert(AntseedKbfVerification.InvalidEvidenceUri.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "ipfs://", results);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", results);
        vm.stopPrank();
    }

    function test_onlyOwnerConfigures() public {
        vm.startPrank(auditorA);
        vm.expectRevert();
        verification.setAuditor(address(0xB0B), true);
        vm.expectRevert();
        verification.setValidityEpochs(3);
        vm.expectRevert();
        verification.setMaxAuditorShareBps(5_000);
        vm.expectRevert();
        verification.setRewardsStartEpoch(EPOCH);
        vm.expectRevert();
        verification.setMaxCreditsPerAuditorPerEpoch(5);
        vm.expectRevert();
        verification.setMaxCreditsPerModelPerEpoch(3);
        vm.expectRevert();
        verification.setSellerPools(address(pools));
        vm.expectRevert();
        verification.clearServiceStatuses(new uint256[](0), new bytes32[](0));
        vm.expectRevert();
        verification.voidAuditorCredits(EPOCH, auditorB);
        vm.stopPrank();

        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setValidityEpochs(0);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setValidityEpochs(5);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setMaxAuditorShareBps(0);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setMaxAuditorShareBps(10_001);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setMaxCreditsPerAuditorPerEpoch(0);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setMaxCreditsPerModelPerEpoch(0);
        vm.expectRevert(AntseedKbfVerification.InvalidAddress.selector);
        verification.setSellerPools(address(0x1234));
    }

    // ── rewards ──────────────────────────────────────────────────────

    function test_oneCreditPerAuditorModelAndEpoch() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);

        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 2, "repeat model audit earns nothing");
        assertEq(verification.auditorEpochCredits(EPOCH, auditorB), 1);
        assertEq(verification.epochCredits(EPOCH), 3);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 600 ether);
        assertEq(_claim(auditorB), 300 ether);
        assertEq(_claim(auditorA), 0, "second claim pays nothing");
        assertEq(gate.minted(auditorA), 600 ether);
    }

    function test_usesTheGateBehindUsageAccounting() public {
        registry.setEmissions(address(new UsageAccountingFront(address(gate))));
        verification = new AntseedKbfVerification(address(registry), address(pools));
        verification.setAuditor(auditorA, true);
        verification.setRewardsStartEpoch(0);
        verification.setMaxAuditorShareBps(10_000);
        gate.setBudget(address(verification), EPOCH, 900 ether);
        assertEq(address(verification.emissionsGate()), address(gate));
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 1);

        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfVerification.EpochChanged.selector);
        verification.submitModelAudit(EPOCH + 1, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(verification.pendingAuditorReward(auditorA, EPOCH), 900 ether);
        assertEq(_claim(auditorA), 900 ether);
        assertEq(gate.minted(auditorA), 900 ether);
    }

    function test_undeterminedAuditEarnsCredit() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 1);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 900 ether);
    }

    function test_configurableCreditsPerModelPerEpoch() public {
        assertEq(verification.maxCreditsPerModelPerEpoch(), 1);
        verification.setMaxCreditsPerModelPerEpoch(3);
        for (uint256 i = 0; i < 4; i++) {
            _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        }
        assertEq(verification.modelCredits(EPOCH, auditorA, MODEL_A), 3, "fourth audit earns nothing");
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 3);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 4, "other models still earn");

        verification.setMaxCreditsPerAuditorPerEpoch(4);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 4, "overall cap still applies");
    }

    function test_creditsRestartEachEpoch() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        pools.setPower(agentId, EPOCH + 1, 50);
        vm.prank(auditorA);
        verification.submitModelAudit(EPOCH + 1, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));
        assertEq(verification.auditorEpochCredits(EPOCH + 1, auditorA), 1);
    }

    function test_creditCapPerAuditorPerEpoch() public {
        verification.setMaxCreditsPerAuditorPerEpoch(1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 1);
        assertEq(verification.agentStatus(agentId).verifiedCount, 2, "capped audits still update status");
    }

    function test_unstakedSellersEarnNoCredit() public {
        uint256 unstaked = _register(address(0x5E3), 0);
        _audit(auditorA, MODEL_A, unstaked, SERVICE_A, SAME);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 0);
        assertTrue(verification.isVerified(unstaked), "status still recorded");
    }

    function test_rewardsAreOffByDefault() public {
        AntseedKbfVerification fresh = new AntseedKbfVerification(address(registry), address(pools));
        assertEq(fresh.rewardsStartEpoch(), type(uint256).max);
        assertEq(fresh.maxAuditorShareBps(), 2_000);
        fresh.setAuditor(auditorA, true);
        vm.prank(auditorA);
        fresh.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));
        assertTrue(fresh.isVerified(agentId), "status works without rewards");
        assertEq(fresh.epochCredits(EPOCH), 0, "no credit before rewards start");
    }

    function test_creditsOnlyFromRewardsStartEpoch() public {
        verification.setRewardsStartEpoch(EPOCH + 1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.epochCredits(EPOCH), 0, "pre-launch audits never claim past budgets");
        _advance(1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.epochCredits(EPOCH + 1), 1);

        verification.setRewardsStartEpoch(type(uint256).max);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.epochCredits(EPOCH + 1), 1, "turning rewards off stops new credits");
        assertEq(verification.auditorEpochCredits(EPOCH + 1, auditorA), 1, "earned credits stay");
    }

    function test_auditorShareIsCapped() public {
        verification.setMaxAuditorShareBps(2_000);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        _audit(auditorA, keccak256("model-c"), agentId, bytes32(uint256(3)), SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(verification.pendingAuditorReward(auditorA, EPOCH), 180 ether, "675 capped at 20% of 900");
        assertEq(verification.pendingAuditorReward(auditorB, EPOCH), 180 ether, "225 capped at 20% of 900");
        assertEq(_claim(auditorA), 180 ether);
        assertEq(_claim(auditorB), 180 ether);
        assertEq(gate.epochMinted(EPOCH), 360 ether, "the rest of the bucket is never minted");
    }

    function test_shareCapAppliesAtClaimTime() public {
        verification.setMaxAuditorShareBps(5_000);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 450 ether, "50% cap, half the credits");

        verification.setMaxAuditorShareBps(1_000);
        assertEq(_claim(auditorB), 90 ether, "lowered cap applies to unclaimed rewards");
    }

    function test_claimsOnlyFinalizedEpochs() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfVerification.EpochNotFinalized.selector);
        verification.claimAuditorRewards(epochs);
    }

    function test_currentEpochShowsNoPendingRewardSoClaimsSkipIt() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertGt(verification.auditorEpochCredits(EPOCH, auditorA), 0);
        assertEq(verification.pendingAuditorReward(auditorA, EPOCH), 0, "current epoch is not final");

        gate.setCurrentEpoch(EPOCH + 1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.pendingAuditorReward(auditorA, EPOCH + 1), 0, "new current epoch is not final");
        assertEq(verification.pendingAuditorReward(auditorA, EPOCH), 900 ether, "finished epoch is claimable");
        assertEq(_claim(auditorA), 900 ether);
    }

    function test_voidingCreditsRestoresHonestShares() public {
        verification.setMaxAuditorShareBps(10_000);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        _audit(auditorA, keccak256("model-c"), agentId, bytes32(uint256(3)), SAME);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.epochCredits(EPOCH), 4);

        vm.expectEmit(true, true, false, true, address(verification));
        emit AntseedKbfVerification.AuditorCreditsVoided(EPOCH, auditorA, 3);
        verification.voidAuditorCredits(EPOCH, auditorA);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 0);
        assertEq(verification.epochCredits(EPOCH), 1);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(verification.pendingAuditorReward(auditorA, EPOCH), 0);
        assertEq(_claim(auditorB), 900 ether, "the honest auditor gets the whole budget back");
        verification.voidAuditorCredits(EPOCH, auditorA);
    }

    function test_cannotVoidClaimedCredits() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        _claim(auditorA);
        vm.expectRevert(AntseedKbfVerification.AlreadyClaimed.selector);
        verification.voidAuditorCredits(EPOCH, auditorA);
    }

    function test_unfundedBucketStaysClaimable() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        gate.setBudget(address(verification), EPOCH, 0);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 0);
        assertFalse(verification.auditorEpochClaimed(EPOCH, auditorA));

        gate.setBudget(address(verification), EPOCH, 100 ether);
        assertEq(_claim(auditorA), 100 ether);
    }

    function test_auditSurvivesFailingPools() public {
        pools.setReverts(true);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
        assertEq(verification.epochCredits(EPOCH), 0);
    }

    function test_requiresAndPinsTheEmissionsGate() public {
        assertEq(address(verification.emissionsGate()), address(gate));

        AntseedRegistry noGateRegistry = new AntseedRegistry();
        noGateRegistry.setIdentityRegistry(address(identityRegistry));
        vm.expectRevert(AntseedKbfVerification.InvalidAddress.selector);
        new AntseedKbfVerification(address(noGateRegistry), address(pools));

        MockVerificationEmissionsGate other = new MockVerificationEmissionsGate();
        other.setCurrentEpoch(EPOCH + 50);
        registry.setEmissions(address(other));
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).epoch, EPOCH, "registry changes do not move the gate");
        assertTrue(verification.isVerified(agentId));
    }

    // ── invariants ───────────────────────────────────────────────────

    function testFuzz_liveCountsMatchServiceStatusesAcrossEpochs(uint8[32] calldata steps) public {
        AntseedKbfVerificationPointsPolicy policy = _pointsPolicy();
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
                verification.setValidityEpochs(uint8(1 + (step >> 5) % 4));
            } else {
                IAntseedKbfVerification.Verdict verdict = step % 3 == 0 ? SAME : step % 3 == 1 ? DIFF : UNDETERMINED;
                _audit(auditors[(step >> 1) % 3], models[(step >> 5) % 3], agentId, service, verdict);
            }
            uint256 current = gate.currentEpoch();
            uint256 window = verification.validityEpochs();
            uint256 verified;
            uint256 diffs;
            for (uint256 j = 0; j < services.length; j++) {
                IAntseedKbfVerification.ServiceStatus memory status = verification.serviceStatus(agentId, services[j]);
                if (current >= status.epoch + window) continue;
                if (status.verdict == SAME) verified += 1;
                else if (status.verdict == DIFF) diffs += 1;
            }
            IAntseedKbfVerification.AgentStatus memory agent = verification.agentStatus(agentId);
            assertEq(agent.verifiedCount, verified);
            assertEq(agent.diffCount, diffs);
            assertEq(verification.isVerified(agentId), verified > 0 && diffs == 0);
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

    function _result(uint256 id, bytes32 service, IAntseedKbfVerification.Verdict verdict)
        private
        pure
        returns (IAntseedKbfVerification.ServiceResult memory)
    {
        return IAntseedKbfVerification.ServiceResult({agentId: id, serviceHash: service, verdict: verdict});
    }

    function _single(uint256 id, bytes32 service, IAntseedKbfVerification.Verdict verdict)
        private
        pure
        returns (IAntseedKbfVerification.ServiceResult[] memory results)
    {
        results = new IAntseedKbfVerification.ServiceResult[](1);
        results[0] = _result(id, service, verdict);
    }

    function _evidence() private returns (bytes32) {
        evidenceNonce += 1;
        return keccak256(abi.encode("evidence", evidenceNonce));
    }

    function _pointsPolicy() private returns (AntseedKbfVerificationPointsPolicy policy) {
        pools.setSeller(seller, agentId);
        policy = new AntseedKbfVerificationPointsPolicy(
            address(verification), address(new VerificationPointsAccounting(address(pools))), 1_000, address(this)
        );
        policy.setPenaltyBps(1_000);
    }

    function _sellerPoints(AntseedKbfVerificationPointsPolicy policy) private view returns (uint256 points) {
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

    function _audit(address auditor, bytes32 model, uint256 id, bytes32 service, IAntseedKbfVerification.Verdict verdict)
        private
    {
        uint256 epoch = gate.currentEpoch();
        bytes32 evidence = _evidence();
        if (expectedAuditRevert != bytes4(0)) {
            vm.expectRevert(expectedAuditRevert);
            expectedAuditRevert = bytes4(0);
        }
        vm.prank(auditor);
        verification.submitModelAudit(epoch, model, evidence, "ipfs://cid", _single(id, service, verdict));
    }

    function _clear(uint256 agent, bytes32 service) private {
        uint256[] memory agents = new uint256[](1);
        bytes32[] memory services = new bytes32[](1);
        agents[0] = agent;
        services[0] = service;
        verification.clearServiceStatuses(agents, services);
    }

    function _claim(address auditor) private returns (uint256) {
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(auditor);
        return verification.claimAuditorRewards(epochs);
    }

    function _expectInvalidResults(IAntseedKbfVerification.ServiceResult[] memory results) private {
        vm.prank(auditorA);
        vm.expectRevert(AntseedKbfVerification.InvalidResults.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", results);
    }
}
