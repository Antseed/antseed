pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedVerification } from "../../verification/AntseedVerification.sol";
import { AntseedPointsPolicyRegistry } from "../../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../../policies/AntseedVerificationPointsPolicy.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockVerificationEmissionsGate } from "../mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "../mocks/MockVerificationSellerPools.sol";
import { IAntseedVerification } from "../../interfaces/IAntseedVerification.sol";
import { M003DeployVerificationRegistry } from "../../script/migrations/M003VerificationRegistry/Deploy.s.sol";

contract M003UsageAccounting {
    address public sellerPools;
    address public pointsPolicy;
    address public emissionsGate;

    constructor(address sellerPools_, address pointsPolicy_, address emissionsGate_) {
        sellerPools = sellerPools_;
        pointsPolicy = pointsPolicy_;
        emissionsGate = emissionsGate_;
    }
}

contract M003VerificationRegistryTest is Test {
    bytes32 private constant KBF_AUDIT_TYPE = keccak256("kbf-model-identity/v1");
    M003DeployVerificationRegistry private script;
    AntseedRegistry private registry;
    MockERC8004Registry private identity;
    MockVerificationSellerPools private pools;
    MockVerificationEmissionsGate private gate;
    AntseedPointsPolicyRegistry private pointsPolicyRegistry;
    M003UsageAccounting private accounting;
    address private owner = address(0xA11CE);
    address private auditor = address(0xB0B);

    function setUp() public {
        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        pools = new MockVerificationSellerPools();
        registry.setIdentityRegistry(address(identity));
        gate = new MockVerificationEmissionsGate();
        pointsPolicyRegistry = new AntseedPointsPolicyRegistry(owner);
        accounting = new M003UsageAccounting(address(pools), address(pointsPolicyRegistry), address(gate));
        registry.setEmissions(address(accounting));
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
            usageAccounting: address(accounting),
            pointsPolicyRegistry: address(pointsPolicyRegistry),
            owner: owner,
            deploymentNonce: vm.getNonce(owner),
            bonusBps: 100,
            auditors: auditors
        });
    }

    function deploy(M003DeployVerificationRegistry.Config memory settings) private returns (AntseedVerification verification) {
        (verification,) = script.runWith(settings);
    }

    function test_deployAndRepeatWithoutChangingProtocolPointers() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        (AntseedVerification verification, AntseedVerificationPointsPolicy policy) = script.runWith(settings);
        assertEq(verification.owner(), owner);
        assertEq(verification.pendingOwner(), address(0));
        assertEq(address(verification.registry()), address(registry));
        assertEq(address(verification.sellerPools()), address(pools));
        assertTrue(verification.approvedAuditors(auditor));
        assertEq(address(policy), vm.computeCreateAddress(owner, settings.deploymentNonce + 1));
        assertEq(address(policy.verification()), address(verification));
        assertEq(address(policy.usageAccounting()), address(accounting));
        assertEq(policy.bonusBps(), 100);
        assertEq(policy.owner(), owner);
        assertTrue(pointsPolicyRegistry.isPolicyRegistered(address(policy)));
        assertEq(pointsPolicyRegistry.policyCount(), 1);
        uint64 nonce = vm.getNonce(owner);
        (AntseedVerification again, AntseedVerificationPointsPolicy againPolicy) = script.runWith(settings);
        assertEq(address(again), address(verification));
        assertEq(address(againPolicy), address(policy));
        assertEq(pointsPolicyRegistry.policyCount(), 1);
        assertEq(vm.getNonce(owner), nonce);
        assertEq(registry.emissions(), address(accounting));
        assertEq(address(again.emissionsGate()), address(gate));
        assertEq(registry.staking(), address(0x5111));
    }

    function test_resumeApprovalsOnOriginalDeployment() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        M003DeployVerificationRegistry.Config memory empty = config();
        empty.auditors = new address[](0);
        AntseedVerification verification = deploy(empty);
        assertFalse(verification.approvedAuditors(auditor));
        assertEq(address(deploy(settings)), address(verification));
        assertTrue(verification.approvedAuditors(auditor));
    }

    function test_runReadsEnvironmentWithEmptyAllowlist() public {
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("ANTSEED_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("EXPECTED_IDENTITY_REGISTRY", vm.toString(address(identity)));
        vm.setEnv("SELLER_POOLS", vm.toString(address(pools)));
        vm.setEnv("USAGE_ACCOUNTING", vm.toString(address(accounting)));
        vm.setEnv("POINTS_POLICY_REGISTRY", vm.toString(address(pointsPolicyRegistry)));
        vm.setEnv("VERIFICATION_BONUS_BPS", "250");
        vm.setEnv("VERIFICATION_OWNER", vm.toString(owner));
        vm.setEnv("VERIFICATION_DEPLOYMENT_NONCE", vm.toString(vm.getNonce(owner)));
        vm.setEnv("VERIFICATION_AUDITORS", "");
        (AntseedVerification verification, AntseedVerificationPointsPolicy policy) = script.run();
        assertEq(verification.owner(), owner);
        assertEq(policy.bonusBps(), 250);
        assertFalse(verification.approvedAuditors(auditor));
    }

    function test_approvedAuditorCanSubmitAudit() public {
        AntseedVerification verification = deploy(config());
        vm.prank(address(0xCAFE));
        uint256 agentId = identity.register();
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](1);
        results[0] = IAntseedVerification.ServiceResult({
            agentId: agentId, serviceHash: keccak256("service"), verdict: IAntseedVerification.Verdict.SAME
        });
        vm.prank(auditor);
        verification.submitModelAudit(0, KBF_AUDIT_TYPE, keccak256("model"), keccak256("evidence"), "ipfs://evidence", results);
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
        AntseedVerification verification = deploy(settings);
        vm.prank(owner);
        verification.transferOwnership(address(0xCAFE));
        vm.expectRevert("M003: pending ownership transfer");
        script.runWith(settings);
    }

    function test_rejectsChangedOwner() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        AntseedVerification verification = deploy(settings);
        vm.prank(owner);
        verification.transferOwnership(address(0xCAFE));
        vm.prank(address(0xCAFE));
        verification.acceptOwnership();
        vm.expectRevert("M003: wrong owner");
        script.runWith(settings);
    }

    function test_resumesPolicyAfterVerificationOnlyDeployment() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        vm.prank(owner);
        AntseedVerification first = new AntseedVerification(address(registry), address(pools));
        (AntseedVerification verification, AntseedVerificationPointsPolicy policy) = script.runWith(settings);
        assertEq(address(verification), address(first));
        assertEq(address(policy.verification()), address(first));
        assertTrue(pointsPolicyRegistry.isPolicyRegistered(address(policy)));
    }

    function test_rejectsPolicyNonceDrift() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        vm.startPrank(owner);
        new AntseedVerification(address(registry), address(pools));
        vm.setNonce(owner, uint64(settings.deploymentNonce + 2));
        vm.stopPrank();
        vm.expectRevert("M003: policy nonce changed");
        script.runWith(settings);
    }

    function test_rejectsBonusAboveCap() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        settings.bonusBps = 5_001;
        vm.expectRevert("M003: bonus above cap");
        script.runWith(settings);
    }

    function test_rejectsWrongUsageAccountingOrPointsRegistry() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        settings.usageAccounting =
            address(new M003UsageAccounting(address(0xBEEF), address(pointsPolicyRegistry), address(gate)));
        vm.expectRevert("M003: wrong usage accounting seller pools");
        script.runWith(settings);

        settings = config();
        settings.usageAccounting =
            address(new M003UsageAccounting(address(pools), address(pointsPolicyRegistry), address(gate)));
        vm.expectRevert("M003: registry emissions is not usage accounting");
        script.runWith(settings);

        settings = config();
        settings.pointsPolicyRegistry = address(new AntseedPointsPolicyRegistry(owner));
        vm.expectRevert("M003: wrong points policy registry");
        script.runWith(settings);
    }

    function test_rejectsOwnerWithoutPointsRegistryOwnership() public {
        vm.prank(owner);
        pointsPolicyRegistry.transferOwnership(address(0xCAFE));
        vm.prank(address(0xCAFE));
        pointsPolicyRegistry.acceptOwnership();
        vm.expectRevert("M003: owner does not own points policy registry");
        script.runWith(config());
    }

    function test_policyChangesSellerPointsAfterSameAudit() public {
        (AntseedVerification verification, AntseedVerificationPointsPolicy policy) = script.runWith(config());
        address seller = address(0x5E11);
        vm.prank(seller);
        uint256 agentId = identity.register();
        pools.setSeller(seller, agentId);
        IAntseedVerification.ServiceResult[] memory results = new IAntseedVerification.ServiceResult[](1);
        results[0] = IAntseedVerification.ServiceResult({
            agentId: agentId, serviceHash: keccak256("service"), verdict: IAntseedVerification.Verdict.SAME
        });
        vm.prank(auditor);
        verification.submitModelAudit(0, KBF_AUDIT_TYPE, keccak256("model"), keccak256("evidence"), "", results);
        (uint256 sellerPoints,) = pointsPolicyRegistry.points(bytes32(0), address(0xB0), seller, 1_000_000);
        assertEq(sellerPoints, 1_010_000, "the deployed bonus applies at once");

        vm.prank(owner);
        policy.setBonusBps(0);
        (sellerPoints,) = pointsPolicyRegistry.points(bytes32(0), address(0xB0), seller, 1_000_000);
        assertEq(sellerPoints, 1_000_000, "zero rates leave points unchanged");
    }
}
