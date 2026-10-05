// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {AntseedRegistry} from "../../core/AntseedRegistry.sol";
import {IAntseedVerification} from "../../interfaces/IAntseedVerification.sol";
import {AntseedVerification} from "../../verification/AntseedVerification.sol";
import {MockERC8004Registry} from "../mocks/MockERC8004Registry.sol";

contract AntseedVerifierRegistryTest is Test {
    bytes32 private constant SERVICE_HASH = keccak256("gpt-5.6-sol");
    bytes32 private constant OTHER_SERVICE_HASH = keccak256("gpt-5.6-luna");

    address private verifier = address(0xA11CE);
    address private secondVerifier = address(0xB0B);
    address private seller = address(0xCAFE);

    AntseedVerification private verification;
    MockERC8004Registry private identityRegistry;
    uint256 private agentId;

    function setUp() public {
        AntseedRegistry registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identityRegistry));
        verification = new AntseedVerification(address(registry));
        verification.setVerifier(verifier, true);
        verification.setVerifier(secondVerifier, true);
        vm.prank(seller);
        agentId = identityRegistry.register();
    }

    function test_submitStoresCompactBundleAndResults() public {
        bytes32 evidenceHash = keccak256("bundle");
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](2);
        results[0] = _result(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME);
        results[1] = _result(_register(address(0xD00D)), OTHER_SERVICE_HASH, IAntseedVerification.Verdict.DIFF);

        _submit(verifier, evidenceHash, "ipfs://bundle", results);

        IAntseedVerification.VerificationBundle memory bundle = verification.verificationBundle(evidenceHash);
        assertEq(bundle.verifier, verifier);
        assertEq(bundle.submittedAt, block.timestamp);
        assertEq(bundle.resultCount, 2);
        assertEq(bundle.evidenceUri, "ipfs://bundle");

        IAntseedVerification.VerificationResult memory first = verification.verificationResult(evidenceHash, 0);
        assertEq(first.agentId, agentId);
        assertEq(first.serviceHash, SERVICE_HASH);
        assertEq(uint8(first.verdict), uint8(IAntseedVerification.Verdict.SAME));

        IAntseedVerification.VerificationResult memory second = verification.verificationResult(evidenceHash, 1);
        assertEq(second.serviceHash, OTHER_SERVICE_HASH);
        assertEq(uint8(second.verdict), uint8(IAntseedVerification.Verdict.DIFF));
    }

    function test_emitsVerifierAndCompactResult() public {
        bytes32 evidenceHash = keccak256("events");
        vm.recordLogs();
        _submit(verifier, evidenceHash, "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF));

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 resultTopic = keccak256("VerificationResultSubmitted(bytes32,uint256,bytes32,address,uint8)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 0 || logs[i].topics[0] != resultTopic) continue;
            (address emittedVerifier, IAntseedVerification.Verdict verdict) =
                abi.decode(logs[i].data, (address, IAntseedVerification.Verdict));
            assertEq(emittedVerifier, verifier);
            assertEq(uint8(verdict), uint8(IAntseedVerification.Verdict.DIFF));
            return;
        }
        fail("result event not emitted");
    }

    function test_acceptsAllFinalVerdicts() public {
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](3);
        results[0] = _result(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME);
        results[1] = _result(_register(address(0xD00D)), SERVICE_HASH, IAntseedVerification.Verdict.DIFF);
        results[2] = _result(_register(address(0xF00D)), SERVICE_HASH, IAntseedVerification.Verdict.UNDETERMINED);
        _submit(verifier, keccak256("all-verdicts"), "", results);
    }

    function test_rejectsUnapprovedVerifier() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(AntseedVerification.NotApprovedVerifier.selector);
        verification.submitVerificationBundle(
            keccak256("unapproved"), "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME)
        );
    }

    function test_rejectsDuplicateBundleAndDuplicateSubject() public {
        bytes32 evidenceHash = keccak256("duplicate-bundle");
        _submit(verifier, evidenceHash, "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME));

        vm.prank(secondVerifier);
        vm.expectRevert(AntseedVerification.VerificationAlreadySubmitted.selector);
        verification.submitVerificationBundle(
            evidenceHash, "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF)
        );

        IAntseedVerification.VerificationResult[] memory duplicates = new IAntseedVerification.VerificationResult[](2);
        duplicates[0] = _result(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME);
        duplicates[1] = _result(agentId, SERVICE_HASH, IAntseedVerification.Verdict.DIFF);
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.DuplicateResult.selector);
        verification.submitVerificationBundle(keccak256("duplicate-subject"), "", duplicates);
    }

    function test_rejectsUnknownAgentAndSelfAudit() public {
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.UnknownAgent.selector);
        verification.submitVerificationBundle(
            keccak256("unknown"), "", _oneResult(999, SERVICE_HASH, IAntseedVerification.Verdict.SAME)
        );

        verification.setVerifier(seller, true);
        vm.prank(seller);
        vm.expectRevert(AntseedVerification.SelfAudit.selector);
        verification.submitVerificationBundle(
            keccak256("self"), "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME)
        );
    }

    function test_rejectsInvalidValuesAndUri() public {
        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.submitVerificationBundle(
            bytes32(0), "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME)
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidValue.selector);
        verification.submitVerificationBundle(
            keccak256("zero-agent"), "", _oneResult(0, SERVICE_HASH, IAntseedVerification.Verdict.SAME)
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidVerdict.selector);
        verification.submitVerificationBundle(
            keccak256("unknown-verdict"), "", _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.UNKNOWN)
        );

        vm.prank(verifier);
        vm.expectRevert(AntseedVerification.InvalidEvidenceUri.selector);
        verification.submitVerificationBundle(
            keccak256("bad-uri"),
            "https://example.com",
            _oneResult(agentId, SERVICE_HASH, IAntseedVerification.Verdict.SAME)
        );
    }

    function test_onlyOwnerConfiguresVerifiers() public {
        vm.prank(address(0xBAD));
        vm.expectRevert();
        verification.setVerifier(address(0xF00D), true);

        verification.setVerifier(verifier, false);
        assertFalse(verification.approvedVerifiers(verifier));
    }

    function _submit(
        address caller,
        bytes32 evidenceHash,
        string memory evidenceUri,
        IAntseedVerification.VerificationResult[] memory results
    ) private {
        vm.prank(caller);
        verification.submitVerificationBundle(evidenceHash, evidenceUri, results);
    }

    function _oneResult(uint256 targetAgentId, bytes32 targetServiceHash, IAntseedVerification.Verdict verdict)
        private
        pure
        returns (IAntseedVerification.VerificationResult[] memory results)
    {
        results = new IAntseedVerification.VerificationResult[](1);
        results[0] = _result(targetAgentId, targetServiceHash, verdict);
    }

    function _result(uint256 targetAgentId, bytes32 targetServiceHash, IAntseedVerification.Verdict verdict)
        private
        pure
        returns (IAntseedVerification.VerificationResult memory)
    {
        return IAntseedVerification.VerificationResult({
            agentId: targetAgentId,
            serviceHash: targetServiceHash,
            verdict: verdict
        });
    }

    function _register(address owner) private returns (uint256 registeredAgentId) {
        vm.prank(owner);
        registeredAgentId = identityRegistry.register();
    }
}
