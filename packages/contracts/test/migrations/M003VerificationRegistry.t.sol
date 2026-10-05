pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { IAntseedVerification } from "../../interfaces/IAntseedVerification.sol";
import { M003DeployVerificationRegistry } from "../../script/migrations/M003VerificationRegistry/Deploy.s.sol";

contract M003VerificationRegistryTest is Test {
    M003DeployVerificationRegistry private script;
    AntseedRegistry private registry;
    MockERC8004Registry private identity;
    address private owner = address(0xA11CE);
    address private verifier = address(0xB0B);

    function setUp() public {
        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(0xE111));
        registry.setStaking(address(0x5111));
        registry.transferOwnership(owner);
        script = new M003DeployVerificationRegistry();
        vm.deal(owner, 10 ether);
    }

    function config() private view returns (M003DeployVerificationRegistry.Config memory result) {
        address[] memory verifiers = new address[](1);
        verifiers[0] = verifier;
        result = M003DeployVerificationRegistry.Config({
            chainId: block.chainid,
            registry: address(registry),
            identityRegistry: address(identity),
            owner: owner,
            deploymentNonce: vm.getNonce(owner),
            verifiers: verifiers
        });
    }

    function test_deployAndRepeatWithoutChangingProtocolPointers() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        AntseedVerification verification = script.runWith(settings);
        assertEq(verification.owner(), owner);
        assertEq(verification.pendingOwner(), address(0));
        assertEq(address(verification.registry()), address(registry));
        assertTrue(verification.approvedVerifiers(verifier));
        uint64 nonce = vm.getNonce(owner);
        assertEq(address(script.runWith(settings)), address(verification));
        assertEq(vm.getNonce(owner), nonce);
        assertEq(registry.emissions(), address(0xE111));
        assertEq(registry.staking(), address(0x5111));
    }

    function test_resumeApprovalsOnOriginalDeployment() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        M003DeployVerificationRegistry.Config memory empty = config();
        empty.verifiers = new address[](0);
        AntseedVerification verification = script.runWith(empty);
        assertFalse(verification.approvedVerifiers(verifier));
        assertEq(address(script.runWith(settings)), address(verification));
        assertTrue(verification.approvedVerifiers(verifier));
    }

    function test_runReadsEnvironmentWithEmptyAllowlist() public {
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("ANTSEED_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("EXPECTED_IDENTITY_REGISTRY", vm.toString(address(identity)));
        vm.setEnv("VERIFICATION_OWNER", vm.toString(owner));
        vm.setEnv("VERIFICATION_DEPLOYMENT_NONCE", vm.toString(vm.getNonce(owner)));
        vm.setEnv("VERIFICATION_VERIFIERS", "");
        AntseedVerification verification = script.run();
        assertEq(verification.owner(), owner);
        assertFalse(verification.approvedVerifiers(verifier));
    }

    function test_approvedVerifierCanSubmitAndReadBundle() public {
        AntseedVerification verification = script.runWith(config());
        vm.prank(address(0xCAFE));
        uint256 agentId = identity.register();
        IAntseedVerification.VerificationResult[] memory results = new IAntseedVerification.VerificationResult[](1);
        results[0] = IAntseedVerification.VerificationResult({
            agentId: agentId,
            serviceHash: keccak256("model"),
            verdict: IAntseedVerification.Verdict.SAME
        });
        bytes32 evidence = keccak256("evidence");
        vm.prank(verifier);
        verification.submitVerificationBundle(evidence, "ipfs://evidence", results);
        assertEq(verification.verificationBundle(evidence).verifier, verifier);
        assertEq(verification.verificationResult(evidence, 0).agentId, agentId);
    }

    function test_rejectsWrongChain() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        settings.chainId++;
        vm.expectRevert("M003: wrong chain");
        script.runWith(settings);
    }

    function test_rejectsWrongIdentityRegistry() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        settings.identityRegistry = address(new MockERC8004Registry());
        vm.expectRevert("M003: wrong identity registry");
        script.runWith(settings);
    }

    function test_rejectsZeroVerifierBeforeDeployment() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        settings.verifiers[0] = address(0);
        vm.expectRevert("M003: zero verifier");
        script.runWith(settings);
        assertEq(vm.getNonce(owner), settings.deploymentNonce);
    }

    function test_rejectsChangedNonceRatherThanDeployingAnotherRegistry() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        vm.setNonce(owner, uint64(settings.deploymentNonce + 1));
        vm.expectRevert("M003: deployment nonce changed");
        script.runWith(settings);
    }

    function test_rejectsPendingOwnershipTransfer() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        AntseedVerification verification = script.runWith(settings);
        vm.prank(owner);
        verification.transferOwnership(address(0xCAFE));
        vm.expectRevert("M003: pending ownership transfer");
        script.runWith(settings);
    }

    function test_rejectsChangedOwner() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        AntseedVerification verification = script.runWith(settings);
        vm.prank(owner);
        verification.transferOwnership(address(0xCAFE));
        vm.prank(address(0xCAFE));
        verification.acceptOwnership();
        vm.expectRevert("M003: wrong owner");
        script.runWith(settings);
    }
}
