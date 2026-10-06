// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AntseedRegistry} from "../../core/AntseedRegistry.sol";
import {IAntseedVerification} from "../../interfaces/IAntseedVerification.sol";
import {AntseedVerification} from "../../verification/AntseedVerification.sol";
import {MockERC8004Registry} from "../mocks/MockERC8004Registry.sol";
import {MockVerificationEmissionsGate} from "../mocks/MockVerificationEmissionsGate.sol";

contract AntseedVerificationRewardsTest is Test {
    uint16 private constant PASS = 3;
    uint256 private constant AUDITOR_A_KEY = 0xA1;
    uint256 private constant AUDITOR_B_KEY = 0xB2;
    uint256 private constant AUDITOR_C_KEY = 0xC3;

    address private verifier = address(0xA11CE);
    AntseedVerification private verification;
    MockERC8004Registry private identityRegistry;
    MockVerificationEmissionsGate private gate;

    function setUp() public {
        vm.warp(1_800_000_000);
        AntseedRegistry registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        gate = new MockVerificationEmissionsGate();
        registry.setIdentityRegistry(address(identityRegistry));
        registry.setEmissions(address(gate));
        verification = new AntseedVerification(address(registry));
        verification.setVerifier(verifier, true);
        gate.setCurrentEpoch(5);
        gate.setBudget(address(verification), 5, 900 ether);
    }

    function test_creditsAgreeingAuditorsPerServiceRegardlessOfOutcome() public {
        uint256 agentA = _register(address(0x5E1));
        uint256 agentB = _register(address(0x5E2));
        _finalize(agentA, _results(2, PASS), AUDITOR_A_KEY, AUDITOR_B_KEY);
        _finalize(agentB, _results(1, 0), AUDITOR_A_KEY, AUDITOR_C_KEY);

        assertEq(verification.epochAuditUnits(5), 6);
        assertEq(verification.auditorEpochUnits(5, vm.addr(AUDITOR_A_KEY)), 3);
        assertEq(verification.auditorEpochUnits(5, vm.addr(AUDITOR_B_KEY)), 2);
        assertEq(verification.auditorEpochUnits(5, vm.addr(AUDITOR_C_KEY)), 1);
    }

    function test_disagreeingAuditorEarnsNothing() public {
        uint256 agent = _register(address(0x5E1));
        IAntseedVerification.ServiceResult[] memory agreed = _results(2, PASS);
        _submit(agent, agreed, AUDITOR_A_KEY, keccak256("a"));
        _submit(agent, _results(2, 1), AUDITOR_B_KEY, keccak256("b"));
        _submit(agent, agreed, AUDITOR_C_KEY, keccak256("c"));
        _submit(agent, agreed, AUDITOR_A_KEY, keccak256("a2"));
        assertEq(verification.auditorEpochUnits(5, vm.addr(AUDITOR_B_KEY)), 0);
        assertEq(verification.auditorEpochUnits(5, vm.addr(AUDITOR_C_KEY)), 2);
        assertEq(verification.auditorEpochUnits(5, vm.addr(AUDITOR_A_KEY)), 2);
    }

    function test_claimsProRataShareOfTheFinalizedBucket() public {
        uint256 agentA = _register(address(0x5E1));
        uint256 agentB = _register(address(0x5E2));
        _finalize(agentA, _results(2, PASS), AUDITOR_A_KEY, AUDITOR_B_KEY);
        _finalize(agentB, _results(1, PASS), AUDITOR_A_KEY, AUDITOR_C_KEY);

        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 5;
        vm.prank(vm.addr(AUDITOR_A_KEY));
        vm.expectRevert(AntseedVerification.EpochNotFinalized.selector);
        verification.claimAuditorRewards(epochs);

        gate.setCurrentEpoch(6);
        assertEq(verification.pendingAuditorReward(vm.addr(AUDITOR_A_KEY), 5), 450 ether);
        vm.prank(vm.addr(AUDITOR_A_KEY));
        assertEq(verification.claimAuditorRewards(epochs), 450 ether);
        vm.prank(vm.addr(AUDITOR_B_KEY));
        verification.claimAuditorRewards(epochs);
        vm.prank(vm.addr(AUDITOR_C_KEY));
        verification.claimAuditorRewards(epochs);

        assertEq(gate.minted(vm.addr(AUDITOR_A_KEY)), 450 ether);
        assertEq(gate.minted(vm.addr(AUDITOR_B_KEY)), 300 ether);
        assertEq(gate.minted(vm.addr(AUDITOR_C_KEY)), 150 ether);

        vm.prank(vm.addr(AUDITOR_A_KEY));
        assertEq(verification.claimAuditorRewards(epochs), 0, "second claim pays nothing");
        assertEq(gate.minted(vm.addr(AUDITOR_A_KEY)), 450 ether);
    }

    function test_unfundedBucketStaysClaimable() public {
        uint256 agent = _register(address(0x5E1));
        _finalize(agent, _results(1, PASS), AUDITOR_A_KEY, AUDITOR_B_KEY);
        gate.setBudget(address(verification), 5, 0);
        gate.setCurrentEpoch(6);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 5;

        vm.prank(vm.addr(AUDITOR_A_KEY));
        assertEq(verification.claimAuditorRewards(epochs), 0);
        assertFalse(verification.auditorEpochClaimed(5, vm.addr(AUDITOR_A_KEY)));

        gate.setBudget(address(verification), 5, 100 ether);
        vm.prank(vm.addr(AUDITOR_A_KEY));
        assertEq(verification.claimAuditorRewards(epochs), 50 ether);
    }

    function test_finalizationSurvivesMissingGate() public {
        AntseedRegistry registry = new AntseedRegistry();
        registry.setIdentityRegistry(address(identityRegistry));
        AntseedVerification noGate = new AntseedVerification(address(registry));
        noGate.setVerifier(verifier, true);
        noGate.setQuorum(1);
        verification = noGate;
        uint256 agent = _register(address(0x5E1));
        _submit(agent, _results(1, PASS), AUDITOR_A_KEY, keccak256("a"));
        assertGt(noGate.activeScoreBps(agent), 0);
    }

    function _finalize(
        uint256 agentId,
        IAntseedVerification.ServiceResult[] memory results,
        uint256 firstKey,
        uint256 secondKey
    ) private {
        _submit(agentId, results, firstKey, keccak256(abi.encode(agentId, firstKey)));
        _submit(agentId, results, secondKey, keccak256(abi.encode(agentId, secondKey)));
    }

    function _submit(
        uint256 agentId,
        IAntseedVerification.ServiceResult[] memory results,
        uint256 auditorKey,
        bytes32 evidenceHash
    ) private {
        IAntseedVerification.AuditReport memory report = IAntseedVerification.AuditReport({
            agentId: agentId,
            metadataHash: keccak256("metadata"),
            evidenceHash: evidenceHash,
            resultsHash: keccak256(abi.encode(results)),
            auditedAt: uint64(block.timestamp)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(auditorKey, verification.hashAuditReport(report));
        vm.prank(verifier);
        verification.submitReport(report, results, "", abi.encodePacked(r, s, v));
    }

    function _results(uint256 count, uint16 flags)
        private
        pure
        returns (IAntseedVerification.ServiceResult[] memory results)
    {
        results = new IAntseedVerification.ServiceResult[](count);
        for (uint256 i = 0; i < count; i++) {
            results[i] = IAntseedVerification.ServiceResult({
                serviceHash: bytes32(i + 1), referenceId: keccak256(abi.encode("ref", i)), flags: flags
            });
        }
    }

    function _register(address owner) private returns (uint256 agentId) {
        vm.prank(owner);
        agentId = identityRegistry.register();
    }
}
