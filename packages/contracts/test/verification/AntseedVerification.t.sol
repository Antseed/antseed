// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AntseedRegistry} from "../../core/AntseedRegistry.sol";
import {IAntseedVerification} from "../../interfaces/IAntseedVerification.sol";
import {AntseedVerification} from "../../verification/AntseedVerification.sol";
import {MockERC8004Registry} from "../mocks/MockERC8004Registry.sol";
import {MockVerificationEmissionsGate} from "../mocks/MockVerificationEmissionsGate.sol";
import {MockVerificationSellerPools} from "../mocks/MockVerificationSellerPools.sol";

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

    function test_sameVerifiesServiceAndAgentUntilExpiry() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        assertTrue(verification.isVerified(agentId));
        assertEq(verification.verifiedUntil(agentId), block.timestamp + 14 days);
        IAntseedVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, 1);
        assertEq(agent.diffCount, 0);
        IAntseedVerification.ServiceStatus memory service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(service.modelHash, MODEL_A);
        assertEq(uint8(service.verdict), uint8(SAME));

        vm.warp(block.timestamp + 14 days);
        assertFalse(verification.isVerified(agentId));
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
        uint64 until = verification.verifiedUntil(agentId);
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        _audit(auditorC, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        service = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(service.verdict), uint8(SAME), "verdict kept");
        assertEq(uint8(service.lastResult), uint8(UNDETERMINED));
        assertEq(service.undeterminedStreak, 2);
        assertEq(verification.verifiedUntil(agentId), until, "expiry not refreshed");
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

    function test_ownerCanClearVerificationAndServiceStatus() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, SAME);
        verification.clearVerification(agentId);
        assertFalse(verification.isVerified(agentId));

        _audit(auditorA, MODEL_B, agentId, SERVICE_B, DIFF);
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
        verification.setSellerPools(address(pools));
        vm.expectRevert();
        verification.clearVerification(agentId);
        vm.expectRevert();
        verification.clearServiceStatus(agentId, SERVICE_A);
        vm.stopPrank();

        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setValidity(0);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setDiffConfirmations(0);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setMaxCreditsPerAuditorPerEpoch(0);
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

    function test_undeterminedAuditEarnsCredit() public {
        _audit(auditorA, MODEL_A, agentId, SERVICE_A, UNDETERMINED);
        assertEq(verification.auditorEpochCredits(EPOCH, auditorA), 1);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 900 ether);
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
