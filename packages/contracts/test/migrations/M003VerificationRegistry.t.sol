pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockVerificationSellerPools } from "../mocks/MockVerificationSellerPools.sol";
import { IAntseedVerification } from "../../interfaces/IAntseedVerification.sol";
import { M003DeployVerificationRegistry } from "../../script/migrations/M003VerificationRegistry/Deploy.s.sol";

contract M003VerificationRegistryTest is Test {
    M003DeployVerificationRegistry private script;
    AntseedRegistry private registry;
    MockERC8004Registry private identity;
    MockVerificationSellerPools private pools;
    address private owner = address(0xA11CE);
    address private auditor = address(0xB0B);

    function setUp() public {
        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        pools = new MockVerificationSellerPools();
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(0xE111));
        registry.setStaking(address(0x5111));
        registry.transferOwnership(owner);
        script = new M003DeployVerificationRegistry();
        vm.deal(owner, 10 ether);
    }

    function config() private view returns (M003DeployVerificationRegistry.Config memory result) {
        address[] memory auditors = new address[](1);
        auditors[0] = auditor;
        result = M003DeployVerificationRegistry.Config({
            chainId: block.chainid,
            registry: address(registry),
            identityRegistry: address(identity),
            sellerPools: address(pools),
            owner: owner,
            deploymentNonce: vm.getNonce(owner),
            auditors: auditors
        });
    }

    function test_deployAndRepeatWithoutChangingProtocolPointers() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        AntseedVerification verification = script.runWith(settings);
        assertEq(verification.owner(), owner);
        assertEq(verification.pendingOwner(), address(0));
        assertEq(address(verification.registry()), address(registry));
        assertEq(address(verification.sellerPools()), address(pools));
        assertTrue(verification.approvedAuditors(auditor));
        uint64 nonce = vm.getNonce(owner);
        assertEq(address(script.runWith(settings)), address(verification));
        assertEq(vm.getNonce(owner), nonce);
        assertEq(registry.emissions(), address(0xE111));
        assertEq(registry.staking(), address(0x5111));
    }

    function test_resumeApprovalsOnOriginalDeployment() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        M003DeployVerificationRegistry.Config memory empty = config();
        empty.auditors = new address[](0);
        AntseedVerification verification = script.runWith(empty);
        assertFalse(verification.approvedAuditors(auditor));
        assertEq(address(script.runWith(settings)), address(verification));
        assertTrue(verification.approvedAuditors(auditor));
    }

    function test_runReadsEnvironmentWithEmptyAllowlist() public {
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("ANTSEED_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("EXPECTED_IDENTITY_REGISTRY", vm.toString(address(identity)));
        vm.setEnv("SELLER_POOLS", vm.toString(address(pools)));
        vm.setEnv("VERIFICATION_OWNER", vm.toString(owner));
        vm.setEnv("VERIFICATION_DEPLOYMENT_NONCE", vm.toString(vm.getNonce(owner)));
        vm.setEnv("VERIFICATION_AUDITORS", "");
        AntseedVerification verification = script.run();
        assertEq(verification.owner(), owner);
        assertFalse(verification.approvedAuditors(auditor));
    }

    function test_approvedAuditorCanSubmitAudit() public {
        AntseedVerification verification = script.runWith(config());
        vm.prank(address(0xCAFE));
        uint256 agentId = identity.register();
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](1);
        results[0] = IAntseedVerification.ServiceResult({
            serviceHash: keccak256("service"), modelHash: keccak256("model"), passed: true
        });
        vm.prank(auditor);
        verification.submitAudit(agentId, results, keccak256("evidence"), "ipfs://evidence");
        assertTrue(verification.isVerified(agentId));
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

    function test_rejectsZeroAuditorBeforeDeployment() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        settings.auditors[0] = address(0);
        vm.expectRevert("M003: zero auditor");
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
