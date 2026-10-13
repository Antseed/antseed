// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AntseedRegistry} from "../../core/AntseedRegistry.sol";
import {IAntseedVerification} from "../../interfaces/IAntseedVerification.sol";
import {AntseedVerification} from "../../verification/AntseedVerification.sol";
import {AntseedVerificationPointsPolicy} from "../../policies/AntseedVerificationPointsPolicy.sol";
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

contract AntseedVerificationTest is Test {
    uint256 private constant EPOCH = 5;
    bytes32 private constant MODEL_A = keccak256("model-a");
    bytes32 private constant MODEL_B = keccak256("model-b");
    bytes32 private constant SERVICE_A = bytes32(uint256(1));
    bytes32 private constant SERVICE_B = bytes32(uint256(2));

    IAntseedVerification.Verdict private constant SAME = IAntseedVerification.Verdict.SAME;
    IAntseedVerification.Verdict private constant DIFF = IAntseedVerification.Verdict.DIFF;
    IAntseedVerification.Verdict private constant NONE = IAntseedVerification.Verdict.NONE;
    IAntseedVerification.Verdict private constant UNDETERMINED = IAntseedVerification.Verdict.UNDETERMINED;

    address private auditorA = address(0xA1);
    address private auditorB = address(0xB2);
    address private auditorC = address(0xC3);
    address private seller = address(0x5E1);

    AntseedRegistry private registry;
    AntseedVerification private verification;
    MockERC8004Registry private identityRegistry;
    MockVerificationEmissionsGate private gate;
    MockVerificationSellerPools private pools;
    uint256 private agentId;
    uint256 private evidenceNonce;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        gate = new MockVerificationEmissionsGate();
        pools = new MockVerificationSellerPools();
        registry.setIdentityRegistry(address(identityRegistry));
        registry.setEmissions(address(gate));
        verification = new AntseedVerification(address(registry), address(pools));
        verification.setAuditor(auditorA, true);
        verification.setAuditor(auditorB, true);
        verification.setAuditor(auditorC, true);
        gate.setCurrentEpoch(EPOCH);
        gate.setBudget(address(verification), EPOCH, 900 ether);
        agentId = _register(seller, 300);
    }

    // ── status ───────────────────────────────────────────────────────

    function test_sameVerifiesServiceUntilItsOwnExpiry() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
        IAntseedVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1);
        assertEq(agent.diffCount, 0);
        IAntseedVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(service.modelHash, MODEL_A);
        assertEq(uint8(service.verdict), uint8(SAME));
        assertEq(service.expiresAt, block.timestamp + 14 days);

        vm.warp(block.timestamp + 14 days - 1);
        assertEq(_expire(agentId, SERVICE_A), 0, "not yet expired");
        vm.warp(block.timestamp + 1);
        assertEq(_expire(agentId, SERVICE_A), 1);
        assertEq(verification.agentStatus(agentId).verifiedCount, 0);
        service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(NONE));
        assertEq(uint8(service.lastResult), uint8(SAME), "latest result kept");
        assertEq(service.expiresAt, 0);
        assertFalse(verification.isVerified(agentId));
        assertEq(_expire(agentId, SERVICE_A), 0, "expiring twice is a no-op");
    }

    function test_statusAndPointsIgnoreExpiredSameWithoutCleanup() public {
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(_sellerPoints(policy), 110);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        assertEq(verification.agentStatus(agentId).verifiedCount, 0);
        assertFalse(verification.isVerified(agentId));
        assertEq(_sellerPoints(policy), 100);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME), "record remains");
        assertEq(_expire(agentId, SERVICE_A), 1);
        assertEq(_sellerPoints(policy), 100, "cleanup does not change points");
    }

    function test_selectiveDiffCleanupCannotRetainExpiredSameBonus() public {
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        assertEq(_sellerPoints(policy), 100);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        assertEq(_sellerPoints(policy), 100);
        vm.prank(seller);
        verification.expire(_serviceKeys(agentId, SERVICE_B));
        IAntseedVerification.AgentStatus memory status = verification.agentStatus(agentId);
        assertEq(status.verifiedCount, 0);
        assertEq(status.diffCount, 0);
        assertFalse(verification.isVerified(agentId));
        assertEq(_sellerPoints(policy), 100, "expired SAME cannot supply a bonus");
        assertEq(_expire(agentId, SERVICE_A), 1);
        assertEq(_sellerPoints(policy), 100);
    }

    function test_selectiveSameCleanupCannotRetainExpiredDiffPenalty() public {
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        _expire(agentId, SERVICE_A);
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        assertEq(_sellerPoints(policy), 100, "expired DIFF cannot supply a penalty");
    }

    function test_expiredDiffDoesNotBlockFreshSameOrPenalizePoints() public {
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        assertTrue(verification.isVerified(agentId));
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        assertEq(verification.agentStatus(agentId).verifiedCount, 1);
        assertEq(_sellerPoints(policy), 110);
        assertEq(_expire(agentId, SERVICE_A), 1);
        assertEq(_sellerPoints(policy), 110);
    }

    function test_auditEventsOnlyCountUnexpiredServices() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedVerification.AgentStatusChanged(agentId, 0, 1);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        assertEq(verification.agentStatus(agentId).verifiedCount, 0);
        assertEq(verification.agentStatus(agentId).diffCount, 1);
    }

    function test_clearExpiredStatusesDoesNotUnderflowLiveCounts() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        verification.clearServiceStatus(agentId, SERVICE_A);
        verification.clearServiceStatus(agentId, SERVICE_B);
        assertEq(verification.agentStatus(agentId).verifiedCount, 0);
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
        verification.clearServiceStatus(agentId, SERVICE_A);
        assertFalse(verification.isVerified(agentId));
    }

    function test_countedServiceCapAllowsRefreshAndVerdictChanges() public {
        _fillCountedServices();
        assertEq(verification.agentStatus(agentId).verifiedCount, 512);
        vm.expectRevert(AntseedVerification.TooManyServices.selector);
        _audit(auditorA, MODEL_A, agentId, bytes32(uint256(513)), SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(verification.agentStatus(agentId).verifiedCount, 511);
        assertEq(verification.agentStatus(agentId).diffCount, 1);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.agentStatus(agentId).verifiedCount, 512);
        vm.expectRevert(AntseedVerification.TooManyServices.selector);
        _audit(auditorA, MODEL_A, agentId, bytes32(uint256(513)), SAME);
    }

    function test_countedServiceCapReclaimsExpiredSlots() public {
        _fillCountedServices();
        vm.warp(vm.getBlockTimestamp() + 14 days);
        assertEq(verification.agentStatus(agentId).verifiedCount, 0);
        _audit(auditorA, MODEL_A, agentId, bytes32(uint256(513)), SAME);
        assertEq(verification.agentStatus(agentId).verifiedCount, 1);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE));
        _audit(auditorA, MODEL_A, agentId, bytes32(uint256(514)), SAME);
        assertEq(verification.agentStatus(agentId).verifiedCount, 2);
        assertTrue(verification.isVerified(agentId));
    }

    function test_modelChangeAndOwnerClearFreeTrackedSlots() public {
        _fillCountedServices();
        _audit(auditorA, MODEL_B, agentId, SERVICE_A, UNDETERMINED);
        assertEq(verification.agentStatus(agentId).verifiedCount, 511);
        _audit(auditorA, MODEL_A, agentId, bytes32(uint256(513)), SAME);
        verification.clearServiceStatus(agentId, SERVICE_B);
        _audit(auditorA, MODEL_A, agentId, bytes32(uint256(514)), DIFF);
        assertEq(verification.agentStatus(agentId).verifiedCount, 511);
        assertEq(verification.agentStatus(agentId).diffCount, 1);
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, bytes32(uint256(515)), DIFF);
        assertEq(verification.serviceStatus(agentId, bytes32(uint256(515))).diffVotes, 1);
        vm.expectRevert(AntseedVerification.TooManyServices.selector);
        _audit(auditorB, MODEL_A, agentId, bytes32(uint256(515)), DIFF);
        assertEq(verification.serviceStatus(agentId, bytes32(uint256(515))).diffVotes, 1);
    }

    function test_coldStatusAndPointsReadsAreBoundedAtCapacity() public {
        _fillCountedServices();
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.cool(address(verification));
        uint256 gasBefore = gasleft();
        IAntseedVerification.AgentStatus memory status = verification.agentStatus(agentId);
        uint256 readGas = gasBefore - gasleft();
        assertEq(status.verifiedCount, 512);
        assertLt(readGas, 5_000_000, "bounded cold status read");
        emit log_named_uint("cold agentStatus gas", readGas);
        vm.cool(address(verification));
        gasBefore = gasleft();
        uint256 points = _sellerPoints(policy);
        readGas = gasBefore - gasleft();
        assertEq(points, 150);
        assertLt(readGas, 5_000_000, "bounded cold points read");
        emit log_named_uint("cold verification points gas", readGas);
    }

    function test_eachServiceExpiresIndependently() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        vm.warp(block.timestamp + 10 days);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, SAME);
        vm.warp(block.timestamp + 4 days);

        IAntseedVerification.ServiceKey[] memory keys = new IAntseedVerification.ServiceKey[](2);
        keys[0] = IAntseedVerification.ServiceKey(agentId, SERVICE_A);
        keys[1] = IAntseedVerification.ServiceKey(agentId, SERVICE_B);
        vm.prank(address(0xA11CE));
        assertEq(verification.expire(keys), 1, "anyone can expire; only A is stale");
        assertEq(verification.agentStatus(agentId).verifiedCount, 1);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_B).verdict), uint8(SAME));
        assertTrue(verification.isVerified(agentId));
    }

    function test_repeatedVerdictRefreshesExpiry() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        vm.warp(block.timestamp + 10 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).expiresAt, block.timestamp + 14 days);
        assertEq(verification.agentStatus(agentId).verifiedCount, 1);

        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        vm.warp(block.timestamp + 10 days);
        _audit(auditorB, MODEL_B, agentId, SERVICE_B, DIFF);
        assertEq(verification.serviceStatus(agentId, SERVICE_B).expiresAt, block.timestamp + 14 days);
        assertEq(verification.agentStatus(agentId).diffCount, 1);
    }

    function test_diffExpiresLikeSame() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(verification.agentStatus(agentId).diffCount, 1);
        vm.warp(block.timestamp + 14 days);
        assertEq(_expire(agentId, SERVICE_A), 1);
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE));
    }

    function test_newResultOnExpiredServiceStartsFresh() public {
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        vm.warp(block.timestamp + 14 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        IAntseedVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 0, "stale SAME expired by the new audit");
        assertEq(agent.diffCount, 0, "one DIFF vote is not enough");
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 1);

        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(verification.agentStatus(agentId).diffCount, 1);
    }

    function test_expireIgnoresUnauditedAndUndeterminedServices() public {
        assertEq(_expire(agentId, SERVICE_A), 0);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        vm.warp(block.timestamp + 30 days);
        assertEq(_expire(agentId, SERVICE_A), 0);
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
        IAntseedVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1, "service A stays verified");
        assertEq(agent.diffCount, 1);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME));
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_B).verdict), uint8(DIFF));
        assertFalse(verification.isVerified(agentId));
    }

    function test_sameAfterDiffRestoresService() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        IAntseedVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1);
        assertEq(agent.diffCount, 0);
        assertTrue(verification.isVerified(agentId));

        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 0);
        assertEq(agent.diffCount, 1);
    }

    function test_diffConfirmationsRequireDistinctAuditors() public {
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME), "one auditor is not enough");
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 1);
        assertTrue(verification.isVerified(agentId));

        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 0, "votes reset once applied");
        assertFalse(verification.isVerified(agentId));
    }

    function test_pendingDiffVotesExpireAtDeadlineAndAuditorsCanVoteAgain() public {
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        uint32 round = verification.serviceStatus(agentId, SERVICE_A).round;
        vm.warp(block.timestamp + 14 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        IAntseedVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(NONE));
        assertEq(service.diffVotes, 1, "stale vote does not complete quorum");
        assertEq(service.round, round + 1);
        assertEq(verification.agentStatus(agentId).diffCount, 0);

        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
    }

    function test_repeatedDiffDoesNotExtendConfirmationWindow() public {
        verification.setDiffConfirmations(2);
        uint256 startedAt = vm.getBlockTimestamp();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(startedAt + 10 days);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 1);
        vm.warp(startedAt + 14 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE));
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 1);
    }

    function test_undeterminedDoesNotExtendConfirmationWindow() public {
        verification.setDiffConfirmations(2);
        uint256 startedAt = vm.getBlockTimestamp();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(startedAt + 10 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 1);
        vm.warp(startedAt + 14 days);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE));
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 1);
    }

    function test_undeterminedClearsExpiredPendingDiffVotes() public {
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(block.timestamp + 365 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        IAntseedVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(service.diffVotes, 0);
        assertEq(service.round, 1);
        assertEq(uint8(service.verdict), uint8(NONE));
        assertEq(uint8(service.lastResult), uint8(UNDETERMINED));
        assertEq(service.undeterminedStreak, 1);
    }

    function test_confirmationWindowSnapshotsValidity() public {
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        verification.setValidity(30 days);
        vm.warp(block.timestamp + 14 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE));
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 1);

        verification.setValidity(1 days);
        vm.warp(block.timestamp + 2 days);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
    }

    function test_confirmationWindowsAreIndependentPerService() public {
        verification.setDiffConfirmations(2);
        uint256 startedAt = vm.getBlockTimestamp();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(startedAt + 7 days);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        vm.warp(startedAt + 14 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_B, agentId, SERVICE_B, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE));
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_B).verdict), uint8(DIFF));
        assertEq(verification.agentStatus(agentId).diffCount, 1);
    }

    function test_sameStartsNextPendingDiffRoundWithFreshDeadline() public {
        verification.setDiffConfirmations(2);
        uint256 startedAt = vm.getBlockTimestamp();
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(startedAt + 10 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(startedAt + 15 days);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
    }

    function test_pendingDiffExpiryPreservesUnexpiredSameVerdict() public {
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        uint64 expiresAt = verification.serviceStatus(agentId, SERVICE_A).expiresAt;
        verification.setValidity(2 days);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(block.timestamp + 2 days);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        IAntseedVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(service.diffVotes, 0);
        assertEq(uint8(service.verdict), uint8(SAME));
        assertEq(service.expiresAt, expiresAt);
        assertEq(verification.agentStatus(agentId).verifiedCount, 1);
        assertTrue(verification.isVerified(agentId));
    }

    function testFuzz_pendingDiffConfirmationWindowBoundary(uint64 elapsed) public {
        elapsed = uint64(bound(elapsed, 0, 14 days + 1));
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        vm.warp(block.timestamp + elapsed);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, DIFF);
        IAntseedVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        if (elapsed < 14 days) {
            assertEq(uint8(service.verdict), uint8(DIFF));
            assertEq(service.diffVotes, 0);
        } else {
            assertEq(uint8(service.verdict), uint8(NONE));
            assertEq(service.diffVotes, 1);
        }
    }

    function test_sameDiscardsPendingDiffVotes() public {
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 0);

        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(SAME), "old vote does not count");
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
    }

    function test_undeterminedIsRecordedWithoutChangingVerdict() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        IAntseedVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(NONE));
        assertEq(uint8(service.lastResult), uint8(UNDETERMINED));
        assertEq(service.undeterminedStreak, 1);
        assertEq(service.lastAuditedAt, block.timestamp);
        assertEq(service.modelHash, MODEL_A);
        assertFalse(verification.isVerified(agentId));

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        vm.warp(block.timestamp + 1 days);
        uint64 until = verification.serviceStatus(agentId, SERVICE_A).expiresAt;
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(SAME), "verdict kept");
        assertEq(uint8(service.lastResult), uint8(UNDETERMINED));
        assertEq(service.undeterminedStreak, 2);
        assertEq(service.expiresAt, until, "expiry not refreshed");
        assertTrue(verification.isVerified(agentId));

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.lastResult), uint8(SAME));
        assertEq(service.undeterminedStreak, 0, "definitive result resets streak");
    }

    function test_undeterminedKeepsPendingDiffVotes() public {
        verification.setDiffConfirmations(2);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).diffVotes, 1);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, DIFF);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(DIFF));
    }

    function test_modelChangeResetsServiceStatus() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, DIFF);
        _audit(auditorB, MODEL_B, agentId, SERVICE_A, SAME);
        IAntseedVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.diffCount, 0, "old model's DIFF does not carry over");
        assertEq(agent.verifiedCount, 1);
        assertEq(verification.serviceStatus(agentId, SERVICE_A).modelHash, MODEL_B);
    }

    function test_ownerCanClearServiceStatus() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
        assertFalse(verification.isVerified(agentId));
        verification.clearServiceStatus(agentId, SERVICE_B);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_B).verdict), uint8(NONE));
        assertEq(verification.agentStatus(agentId).diffCount, 0);

        _audit(auditorB, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
    }

    function test_oneSubmissionCoversManySellers() public {
        uint256 other = _register(address(0x5E2), 100);
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](2);
        results[0] = _result(agentId, SERVICE_A, SAME);
        results[1] = _result(other, SERVICE_A, DIFF);

        vm.expectEmit(true, true, true, true, address(verification));
        emit AntseedVerification.ServiceAudited(agentId, SERVICE_A, auditorA, MODEL_A, SAME);
        vm.expectEmit(true, true, true, true, address(verification));
        emit AntseedVerification.ServiceAudited(other, SERVICE_A, auditorA, MODEL_A, DIFF);
        vm.expectEmit(true, true, true, true, address(verification));
        emit AntseedVerification.ModelAudited(MODEL_A, auditorA, EPOCH, keccak256("evidence"), "ipfs://cid", 2);
        vm.prank(auditorA);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "ipfs://cid", results);

        assertTrue(verification.isVerified(agentId));
        assertEq(verification.agentStatus(other).diffCount, 1);
    }

    function test_batchStatusEventsAccumulateWithinAgentAndResetBetweenAgents() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_B, DIFF);
        uint256 other = _register(address(0x5E2), 100);
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](4);
        results[0] = _result(agentId, SERVICE_A, DIFF);
        results[1] = _result(agentId, SERVICE_B, SAME);
        results[2] = _result(other, SERVICE_A, SAME);
        results[3] = _result(other, SERVICE_B, DIFF);

        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedVerification.AgentStatusChanged(agentId, 0, 2);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedVerification.AgentStatusChanged(agentId, 1, 1);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedVerification.AgentStatusChanged(other, 1, 0);
        vm.expectEmit(true, false, false, true, address(verification));
        emit AntseedVerification.AgentStatusChanged(other, 1, 1);
        vm.prank(auditorB);
        verification.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", results);
    }

    function test_expiryPreservesLatestResultAndUndeterminedStreak() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        assertEq(_expire(agentId, SERVICE_A), 1);
        IAntseedVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(NONE));
        assertEq(uint8(service.lastResult), uint8(UNDETERMINED));
        assertEq(service.undeterminedStreak, 1);
        assertEq(service.modelHash, MODEL_A);
        verification.clearServiceStatus(agentId, SERVICE_A);
        service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.lastResult), uint8(NONE));
        assertEq(service.undeterminedStreak, 0);
    }

    // ── access and validation ────────────────────────────────────────

    function test_rejectsUnapprovedAuditor() public {
        vm.expectRevert(AntseedVerification.NotApprovedAuditor.selector);
        _audit(address(0xBAD), MODEL_A, agentId, SERVICE_A, SAME);

        verification.setAuditor(auditorA, false);
        vm.expectRevert(AntseedVerification.NotApprovedAuditor.selector);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
    }

    function test_rejectsSelfAudit() public {
        verification.setAuditor(seller, true);
        vm.expectRevert(AntseedVerification.SelfAudit.selector);
        _audit(seller, MODEL_A, agentId, SERVICE_A, SAME);
    }

    function test_rejectsUnknownAgent() public {
        vm.expectRevert(AntseedVerification.UnknownAgent.selector);
        _audit(auditorA, MODEL_A, 999, SERVICE_A, SAME);
    }

    function testFuzz_rejectsZeroAgent(uint8 verdictSeed) public {
        IAntseedVerification.Verdict verdict = IAntseedVerification.Verdict(bound(verdictSeed, 1, 3));
        vm.expectRevert(AntseedVerification.UnknownAgent.selector);
        _audit(auditorA, MODEL_A, 0, SERVICE_A, verdict);
        assertFalse(verification.isVerified(0));
        assertEq(verification.agentStatus(0).verifiedCount, 0);
        assertEq(verification.agentStatus(0).diffCount, 0);
    }

    function test_rejectsZeroAgentBeforeValidAgentWithoutConsumingEvidence() public {
        bytes32 evidence = keccak256("zero-agent-evidence");
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](2);
        results[0] = _result(0, SERVICE_A, SAME);
        results[1] = _result(agentId, SERVICE_A, SAME);
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerification.UnknownAgent.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, evidence, "", results);

        assertFalse(verification.usedEvidence(evidence));
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
        vm.expectRevert(AntseedVerification.EpochChanged.selector);
        verification.submitModelAudit(EPOCH - 1, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
    }

    function test_rejectsReusedEvidence() public {
        vm.startPrank(auditorA);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
        vm.expectRevert(AntseedVerification.EvidenceAlreadyUsed.selector);
        verification.submitModelAudit(EPOCH, MODEL_B, keccak256("evidence"), "", _single(agentId, SERVICE_B, SAME));
        vm.stopPrank();
        vm.prank(auditorB);
        vm.expectRevert(AntseedVerification.EvidenceAlreadyUsed.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", _single(agentId, SERVICE_A, SAME));
    }

    function test_rejectsInvalidResults() public {
        uint256 other = _register(address(0x5E2), 100);
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](0);
        _expectInvalidResults(results);

        _expectInvalidResults(_single(agentId, SERVICE_A, NONE));
        _expectInvalidResults(_single(agentId, bytes32(0), SAME));

        results = new IAntseedVerification.ServiceResult[](2);
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
        IAntseedVerification.ServiceResult[] memory results = _single(agentId, SERVICE_A, SAME);
        vm.startPrank(auditorA);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.submitModelAudit(EPOCH, bytes32(0), keccak256("evidence"), "", results);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, bytes32(0), "", results);
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "https://example.com/e", results);
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "ipfs://", results);
        verification.submitModelAudit(EPOCH, MODEL_A, keccak256("evidence"), "", results);
        vm.stopPrank();
    }

    function test_onlyOwnerConfigures() public {
        vm.startPrank(auditorA);
        vm.expectRevert();
        verification.setAuditor(address(0xB0B), true);
        vm.expectRevert();
        verification.setValidity(1 days);
        vm.expectRevert();
        verification.setDiffConfirmations(2);
        vm.expectRevert();
        verification.setMaxCreditsPerAuditorPerEpoch(5);
        vm.expectRevert();
        verification.setMaxCreditsPerModelPerEpoch(3);
        vm.expectRevert();
        verification.setSellerPools(address(pools));
        vm.expectRevert();
        verification.clearServiceStatus(agentId, SERVICE_A);
        vm.stopPrank();

        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setValidity(0);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setDiffConfirmations(0);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setMaxCreditsPerAuditorPerEpoch(0);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setMaxCreditsPerModelPerEpoch(0);
        vm.expectRevert(AntseedVerification.InvalidAddress.selector);
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
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 1);
        assertEq(verification.pendingAuditorReward(auditorA, EPOCH), 900 ether);

        vm.prank(auditorA);
        vm.expectRevert(AntseedVerification.EpochChanged.selector);
        verification.submitModelAudit(EPOCH + 1, MODEL_A, _evidence(), "", _single(agentId, SERVICE_A, SAME));

        gate.setCurrentEpoch(EPOCH + 1);
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

    function test_claimsOnlyFinalizedEpochs() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerification.EpochNotFinalized.selector);
        verification.claimAuditorRewards(epochs);
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

    function test_auditSurvivesMissingGateOrFailingPools() public {
        pools.setReverts(true);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
        assertEq(verification.epochCredits(EPOCH), 0);

        AntseedRegistry noGateRegistry = new AntseedRegistry();
        noGateRegistry.setIdentityRegistry(address(identityRegistry));
        verification = new AntseedVerification(address(noGateRegistry), address(pools));
        verification.setAuditor(auditorA, true);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
    }

    // ── invariants ───────────────────────────────────────────────────

    function testFuzz_liveCountsMatchUnexpiredServicesAfterMutations(uint8[24] calldata steps) public {
        AntseedVerificationPointsPolicy policy = _pointsPolicy();
        verification.setDiffConfirmations(2);
        bytes32[3] memory services = [SERVICE_A, SERVICE_B, bytes32(uint256(3))];
        for (uint256 i = 0; i < steps.length; i++) {
            uint8 step = steps[i];
            bytes32 service = services[(step >> 3) % 3];
            vm.warp(vm.getBlockTimestamp() + uint256(step % 5) * 5 days);
            if (step % 5 == 0) verification.clearServiceStatus(agentId, service);
            else if (step % 5 == 1) _expire(agentId, service);
            else {
                IAntseedVerification.Verdict verdict = step % 3 == 0 ? SAME : step % 3 == 1 ? DIFF : UNDETERMINED;
                _audit(
                    (step & 1) == 0 ? auditorA : auditorB,
                    (step & 2) == 0 ? MODEL_A : MODEL_B,
                    agentId,
                    service,
                    verdict
                );
            }
            uint256 verified;
            uint256 diffs;
            for (uint256 j = 0; j < services.length; j++) {
                IAntseedVerification.ServiceStatus memory status = verification.serviceStatus(agentId, services[j]);
                if (status.expiresAt <= vm.getBlockTimestamp()) continue;
                if (status.verdict == SAME) verified += 1;
                else if (status.verdict == DIFF) diffs += 1;
            }
            IAntseedVerification.AgentStatus memory agent = verification.agentStatus(agentId);
            assertEq(agent.verifiedCount, verified);
            assertEq(agent.diffCount, diffs);
            assertEq(verification.isVerified(agentId), verified > 0 && diffs == 0);
            assertEq(_sellerPoints(policy), 100 + 10 * verified - 10 * diffs);
        }
    }

    function testFuzz_countersMatchServiceStatuses(uint8[24] calldata steps) public {
        verification.setDiffConfirmations(2);
        address[3] memory auditors = [auditorA, auditorB, auditorC];
        bytes32[3] memory models = [MODEL_A, MODEL_B, keccak256("model-c")];
        bytes32[3] memory services = [SERVICE_A, SERVICE_B, bytes32(uint256(3))];
        for (uint256 i = 0; i < steps.length; i++) {
            uint8 step = steps[i];
            IAntseedVerification.Verdict verdict = step % 3 == 0 ? SAME : step % 3 == 1 ? DIFF : UNDETERMINED;
            address auditor = auditors[(step >> 1) % 3];
            bytes32 service = services[(step >> 3) % 3];
            bytes32 model = models[(step >> 5) % 3];
            vm.prank(auditor);
            verification.submitModelAudit(EPOCH, model, _evidence(), "", _single(agentId, service, verdict));
        }
        uint256 verified;
        uint256 diff;
        for (uint256 i = 0; i < services.length; i++) {
            IAntseedVerification.Verdict verdict = verification.serviceStatus(agentId, services[i]).verdict;
            if (verdict == SAME) verified += 1;
            if (verdict == DIFF) diff += 1;
        }
        IAntseedVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, verified);
        assertEq(agent.diffCount, diff);
    }

    // ── helpers ──────────────────────────────────────────────────────

    function _register(address owner, uint256 power) private returns (uint256 id) {
        vm.prank(owner);
        id = identityRegistry.register();
        pools.setPower(id, EPOCH, power);
    }

    function _result(uint256 id, bytes32 service, IAntseedVerification.Verdict verdict)
        private
        pure
        returns (IAntseedVerification.ServiceResult memory)
    {
        return IAntseedVerification.ServiceResult({agentId: id, serviceHash: service, verdict: verdict});
    }

    function _single(uint256 id, bytes32 service, IAntseedVerification.Verdict verdict)
        private
        pure
        returns (IAntseedVerification.ServiceResult[] memory results)
    {
        results = new IAntseedVerification.ServiceResult[](1);
        results[0] = _result(id, service, verdict);
    }

    function _evidence() private returns (bytes32) {
        evidenceNonce += 1;
        return keccak256(abi.encode("evidence", evidenceNonce));
    }

    function _audit(address auditor, bytes32 model, uint256 id, bytes32 service, IAntseedVerification.Verdict verdict)
        private
    {
        vm.prank(auditor);
        verification.submitModelAudit(EPOCH, model, _evidence(), "ipfs://cid", _single(id, service, verdict));
    }

    function _fillCountedServices() private {
        for (uint256 batch = 0; batch < 2; batch++) {
            IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](256);
            for (uint256 i = 0; i < results.length; i++) {
                results[i] = _result(agentId, bytes32(batch * 256 + i + 1), SAME);
            }
            bytes32 evidence = _evidence();
            vm.prank(auditorA);
            uint256 gasBefore = gasleft();
            verification.submitModelAudit(EPOCH, MODEL_A, evidence, "", results);
            uint256 auditGas = gasBefore - gasleft();
            assertLt(auditGas, 40_000_000, "bounded 256-result audit");
            emit log_named_uint("256-result audit gas", auditGas);
        }
    }

    function _pointsPolicy() private returns (AntseedVerificationPointsPolicy policy) {
        pools.setSeller(seller, agentId);
        policy = new AntseedVerificationPointsPolicy(
            address(verification), address(new VerificationPointsAccounting(address(pools))), 1_000, address(this)
        );
        policy.setPenaltyBps(1_000);
    }

    function _sellerPoints(AntseedVerificationPointsPolicy policy) private view returns (uint256 points) {
        (points,) = policy.points(bytes32(0), address(0x123), seller, 100, 100);
    }

    function _serviceKeys(uint256 id, bytes32 service)
        private
        pure
        returns (IAntseedVerification.ServiceKey[] memory keys)
    {
        keys = new IAntseedVerification.ServiceKey[](1);
        keys[0] = IAntseedVerification.ServiceKey(id, service);
    }

    function _expire(uint256 id, bytes32 service) private returns (uint256) {
        IAntseedVerification.ServiceKey[] memory keys = new IAntseedVerification.ServiceKey[](1);
        keys[0] = IAntseedVerification.ServiceKey(id, service);
        return verification.expire(keys);
    }

    function _claim(address auditor) private returns (uint256) {
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(auditor);
        return verification.claimAuditorRewards(epochs);
    }

    function _expectInvalidResults(IAntseedVerification.ServiceResult[] memory results) private {
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerification.InvalidResults.selector);
        verification.submitModelAudit(EPOCH, MODEL_A, _evidence(), "", results);
    }
}
