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

    address private auditorA = address(0xA1);
    address private auditorB = address(0xB2);
    address private seller = address(0x5E1);

    AntseedRegistry private registry;
    AntseedVerification private verification;
    MockERC8004Registry private identityRegistry;
    MockVerificationEmissionsGate private gate;
    MockVerificationSellerPools private pools;
    uint256 private agentId;

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
        gate.setCurrentEpoch(EPOCH);
        gate.setBudget(address(verification), EPOCH, 900 ether);
        agentId = _register(seller, 300);
    }

    // ── status ───────────────────────────────────────────────────────

    function test_passingAuditVerifiesUntilExpiry() public {
        _audit(auditorA, agentId, true, true);
        assertTrue(verification.isVerified(agentId));
        assertEq(verification.verifiedUntil(agentId), block.timestamp + 14 days);

        vm.warp(block.timestamp + 14 days);
        assertFalse(verification.isVerified(agentId));
    }

    function test_anyFailedServiceClearsVerification() public {
        _audit(auditorA, agentId, true, true);
        _audit(auditorB, agentId, true, false);
        assertFalse(verification.isVerified(agentId));
        assertEq(verification.verifiedUntil(agentId), 0);
    }

    function test_ownerCanClearVerification() public {
        _audit(auditorA, agentId, true, true);
        verification.clearVerification(agentId);
        assertFalse(verification.isVerified(agentId));
    }

    function test_emitsPerServiceResults() public {
        vm.expectEmit(true, true, false, true, address(verification));
        emit AntseedVerification.ServiceAudited(agentId, bytes32(uint256(1)), keccak256("model-a"), true);
        vm.expectEmit(true, true, false, true, address(verification));
        emit AntseedVerification.ServiceAudited(agentId, bytes32(uint256(2)), keccak256("model-b"), false);
        vm.expectEmit(true, true, false, true, address(verification));
        emit AntseedVerification.AgentAudited(agentId, auditorA, false, 0, keccak256("evidence"), "ipfs://cid");
        _audit(auditorA, agentId, true, false);
    }

    // ── access and validation ────────────────────────────────────────

    function test_rejectsUnapprovedAuditor() public {
        vm.expectRevert(AntseedVerification.NotApprovedAuditor.selector);
        _audit(address(0xBAD), agentId, true, true);

        verification.setAuditor(auditorA, false);
        vm.expectRevert(AntseedVerification.NotApprovedAuditor.selector);
        _audit(auditorA, agentId, true, true);
    }

    function test_rejectsSelfAudit() public {
        verification.setAuditor(seller, true);
        vm.expectRevert(AntseedVerification.SelfAudit.selector);
        _audit(seller, agentId, true, true);
    }

    function test_rejectsUnknownAgent() public {
        vm.expectRevert(AntseedVerification.UnknownAgent.selector);
        _audit(auditorA, 999, true, true);
    }

    function test_rejectsEmptyUnorderedOrDuplicateResults() public {
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](0);
        _expectInvalidResults(results);

        results = _results(true, true);
        (results[0], results[1]) = (results[1], results[0]);
        _expectInvalidResults(results);

        results = _results(true, true);
        results[1].serviceHash = results[0].serviceHash;
        _expectInvalidResults(results);

        results = _results(true, true);
        results[0].modelHash = bytes32(0);
        _expectInvalidResults(results);
    }

    function test_validatesEvidence() public {
        IAntseedVerification.ServiceResult[] memory results = _results(true, true);
        vm.startPrank(auditorA);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.submitAudit(agentId, results, bytes32(0), "");
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitAudit(agentId, results, keccak256("evidence"), "https://example.com/e");
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitAudit(agentId, results, keccak256("evidence"), "ipfs://");
        verification.submitAudit(agentId, results, keccak256("evidence"), "");
        vm.stopPrank();
    }

    function test_onlyOwnerConfigures() public {
        vm.startPrank(auditorA);
        vm.expectRevert();
        verification.setAuditor(address(0xB0B), true);
        vm.expectRevert();
        verification.setValidity(1 days);
        vm.expectRevert();
        verification.setSellerPools(address(pools));
        vm.expectRevert();
        verification.clearVerification(agentId);
        vm.stopPrank();

        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.setValidity(0);
        vm.expectRevert(AntseedVerification.InvalidAddress.selector);
        verification.setSellerPools(address(0x1234));
    }

    // ── rewards ──────────────────────────────────────────────────────

    function test_rewardsArePoolPowerWeighted() public {
        uint256 small = _register(address(0x5E2), 100);
        uint256 unstaked = _register(address(0x5E3), 0);

        _audit(auditorA, agentId, true, true);
        _audit(auditorB, small, true, false);
        _audit(auditorB, unstaked, true, true);

        assertEq(verification.auditorEpochPower(EPOCH, auditorA), 300);
        assertEq(verification.auditorEpochPower(EPOCH, auditorB), 100, "unstaked agent earns nothing");
        assertEq(verification.epochAuditPower(EPOCH), 400);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 675 ether);
        assertEq(_claim(auditorB), 225 ether);
        assertEq(_claim(auditorA), 0, "second claim pays nothing");
        assertEq(gate.minted(auditorA), 675 ether);
    }

    function test_onlyFirstAuditOfAnAgentPerEpochEarns() public {
        _audit(auditorA, agentId, true, true);
        _audit(auditorB, agentId, true, true);
        assertEq(verification.auditorEpochPower(EPOCH, auditorA), 300);
        assertEq(verification.auditorEpochPower(EPOCH, auditorB), 0);
        assertTrue(verification.isVerified(agentId), "later audits still update status");

        gate.setCurrentEpoch(EPOCH + 1);
        pools.setPower(agentId, EPOCH + 1, 50);
        _audit(auditorB, agentId, true, true);
        assertEq(verification.auditorEpochPower(EPOCH + 1, auditorB), 50);
    }

    function test_claimsOnlyFinalizedEpochs() public {
        _audit(auditorA, agentId, true, true);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(auditorA);
        vm.expectRevert(AntseedVerification.EpochNotFinalized.selector);
        verification.claimAuditorRewards(epochs);
    }

    function test_unfundedBucketStaysClaimable() public {
        _audit(auditorA, agentId, true, true);
        gate.setBudget(address(verification), EPOCH, 0);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(auditorA), 0);
        assertFalse(verification.auditorEpochClaimed(EPOCH, auditorA));

        gate.setBudget(address(verification), EPOCH, 100 ether);
        assertEq(_claim(auditorA), 100 ether);
    }

    function test_auditSurvivesMissingGateOrFailingPools() public {
        pools.setReverts(true);
        _audit(auditorA, agentId, true, true);
        assertTrue(verification.isVerified(agentId));
        assertEq(verification.epochAuditPower(EPOCH), 0);

        AntseedRegistry noGateRegistry = new AntseedRegistry();
        noGateRegistry.setIdentityRegistry(address(identityRegistry));
        verification = new AntseedVerification(address(noGateRegistry), address(pools));
        verification.setAuditor(auditorA, true);
        _audit(auditorA, agentId, true, true);
        assertTrue(verification.isVerified(agentId));
    }

    // ── helpers ──────────────────────────────────────────────────────

    function _register(address owner, uint256 power) private returns (uint256 id) {
        vm.prank(owner);
        id = identityRegistry.register();
        pools.setPower(id, EPOCH, power);
    }

    function _results(bool first, bool second)
        private
        pure
        returns (IAntseedVerification.ServiceResult[] memory results)
    {
        results = new IAntseedVerification.ServiceResult[](2);
        results[0] = IAntseedVerification.ServiceResult({
            serviceHash: bytes32(uint256(1)), modelHash: keccak256("model-a"), passed: first
        });
        results[1] = IAntseedVerification.ServiceResult({
            serviceHash: bytes32(uint256(2)), modelHash: keccak256("model-b"), passed: second
        });
    }

    function _audit(address auditor, uint256 id, bool first, bool second) private {
        vm.prank(auditor);
        verification.submitAudit(id, _results(first, second), keccak256("evidence"), "ipfs://cid");
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
        verification.submitAudit(agentId, results, keccak256("evidence"), "");
    }
}
