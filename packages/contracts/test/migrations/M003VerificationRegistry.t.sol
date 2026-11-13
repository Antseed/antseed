// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { IAntseedKbfAudits } from "../../interfaces/IAntseedKbfAudits.sol";
import { IAntseedVerificationResults } from "../../interfaces/IAntseedVerificationResults.sol";
import { AntseedPointsPolicyRegistry } from "../../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationResults } from "../../verification/AntseedVerificationResults.sol";
import { AntseedKbfAudits } from "../../verification/AntseedKbfAudits.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockVerificationEmissionsGate } from "../mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "../mocks/MockVerificationSellerPools.sol";
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
        gate.setEmissionsReserve(address(0x5E5E));
        pointsPolicyRegistry = new AntseedPointsPolicyRegistry(owner);
        accounting = new M003UsageAccounting(address(pools), address(pointsPolicyRegistry), address(gate));
        registry.setEmissions(address(accounting));
        registry.setStaking(address(0x5111));
        registry.transferOwnership(owner);
        script = new M003DeployVerificationRegistry();
        vm.deal(owner, 10 ether);
    }

    function config() private view returns (M003DeployVerificationRegistry.Config memory) {
        return M003DeployVerificationRegistry.Config({
            chainId: block.chainid,
            registry: address(registry),
            identityRegistry: address(identity),
            sellerPools: address(pools),
            usageAccounting: address(accounting),
            pointsPolicyRegistry: address(pointsPolicyRegistry),
            owner: owner,
            deploymentNonce: vm.getNonce(owner),
            bonusBps: 100
        });
    }

    function test_deploysWiresAndRepeatsAsANoOp() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        M003DeployVerificationRegistry.Deployment memory d = script.runWith(settings);
        assertEq(address(d.results), vm.computeCreateAddress(owner, settings.deploymentNonce));
        assertEq(address(d.kbf), vm.computeCreateAddress(owner, settings.deploymentNonce + 1));
        assertEq(address(d.policy), vm.computeCreateAddress(owner, settings.deploymentNonce + 2));

        assertEq(address(d.kbf.identityRegistry()), address(identity));
        assertEq(address(d.kbf.sellerPools()), address(pools));
        assertEq(address(d.results.emissionsGate()), address(gate));
        assertEq(d.results.owner(), owner);
        assertTrue(d.results.isAudit(address(d.kbf)));
        assertEq(d.results.auditShareBps(address(d.kbf)), 10_000);
        assertEq(d.results.totalAuditShareBps(), 10_000);
        assertEq(d.results.rewardsStartEpoch(address(d.kbf)), type(uint64).max, "rewards stay off");
        assertFalse(d.kbf.approvedAuditors(auditor), "M003 approves no auditors");
        assertEq(address(d.kbf.results()), address(d.results));
        assertEq(d.kbf.owner(), owner);
        assertEq(d.kbf.requiredReports(IAntseedVerificationResults.Verdict.SAME), 1);
        assertEq(d.kbf.requiredReports(IAntseedVerificationResults.Verdict.DIFF), 2, "a DIFF needs a second auditor");
        assertEq(d.kbf.requiredReports(IAntseedVerificationResults.Verdict.UNDETERMINED), 1);
        assertEq(address(d.policy.results()), address(d.results));
        assertEq(address(d.policy.usageAccounting()), address(accounting));
        assertEq(d.policy.bonusBps(), 100);
        assertEq(d.policy.owner(), owner);
        assertFalse(pointsPolicyRegistry.isPolicyRegistered(address(d.policy)), "M003 only deploys");
        assertEq(pointsPolicyRegistry.policyCount(), 0);

        uint64 nonce = vm.getNonce(owner);
        vm.recordLogs();
        M003DeployVerificationRegistry.Deployment memory again = script.runWith(settings);
        assertEq(vm.getRecordedLogs().length, 0, "nothing is sent again");
        assertEq(vm.getNonce(owner), nonce);
        assertEq(address(again.results), address(d.results));
        assertEq(address(again.kbf), address(d.kbf));
        assertEq(address(again.policy), address(d.policy));
        assertEq(registry.emissions(), address(accounting));
        assertEq(registry.staking(), address(0x5111));
    }

    function test_runReadsEnvironmentAndApprovesNoAuditors() public {
        vm.setEnv("EXPECTED_CHAIN_ID", vm.toString(block.chainid));
        vm.setEnv("ANTSEED_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("EXPECTED_IDENTITY_REGISTRY", vm.toString(address(identity)));
        vm.setEnv("SELLER_POOLS", vm.toString(address(pools)));
        vm.setEnv("USAGE_ACCOUNTING", vm.toString(address(accounting)));
        vm.setEnv("POINTS_POLICY_REGISTRY", vm.toString(address(pointsPolicyRegistry)));
        vm.setEnv("VERIFICATION_BONUS_BPS", "250");
        vm.setEnv("VERIFICATION_OWNER", vm.toString(owner));
        vm.setEnv("VERIFICATION_DEPLOYMENT_NONCE", vm.toString(vm.getNonce(owner)));
        vm.setEnv("VERIFICATION_AUDITORS", vm.toString(auditor)); // ignored: M003 never approves auditors
        M003DeployVerificationRegistry.Deployment memory d = script.run();
        assertEq(d.results.owner(), owner);
        assertEq(d.policy.bonusBps(), 250);
        assertFalse(d.kbf.approvedAuditors(auditor));
    }

    function test_resumesAfterAPartialDeployment() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        vm.startPrank(owner);
        AntseedVerificationResults results = new AntseedVerificationResults(address(gate));
        AntseedKbfAudits kbf = new AntseedKbfAudits(address(results), address(pools), address(identity));
        vm.stopPrank();
        M003DeployVerificationRegistry.Deployment memory d = script.runWith(settings);
        assertEq(address(d.results), address(results));
        assertEq(address(d.kbf), address(kbf));
        assertEq(address(d.kbf.results()), address(results));
        assertTrue(results.isAudit(address(d.kbf)));
        assertFalse(pointsPolicyRegistry.isPolicyRegistered(address(d.policy)));
    }

    function test_restoresMissingWiringOnARerun() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        M003DeployVerificationRegistry.Deployment memory d = script.runWith(settings);
        vm.prank(owner);
        d.results.setAuditShareBps(address(d.kbf), 0);
        script.runWith(settings);
        assertEq(d.results.auditShareBps(address(d.kbf)), 10_000);
    }

    function test_rejectsChangedNonceRatherThanDeployingElsewhere() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        vm.setNonce(owner, uint64(settings.deploymentNonce + 1));
        vm.expectRevert("M003: deployment nonce changed");
        script.runWith(settings);
    }

    function test_rejectsKbfNonceDrift() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        vm.startPrank(owner);
        new AntseedVerificationResults(address(gate));
        vm.setNonce(owner, uint64(settings.deploymentNonce + 2));
        vm.stopPrank();
        vm.expectRevert("M003: KBF nonce changed");
        script.runWith(settings);
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

    function test_rejectsPendingOwnershipTransfer() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        M003DeployVerificationRegistry.Deployment memory d = script.runWith(settings);
        vm.prank(owner);
        d.kbf.transferOwnership(address(0xCAFE));
        vm.expectRevert("M003: pending KBF ownership transfer");
        script.runWith(settings);
    }

    function test_rejectsChangedOwner() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        M003DeployVerificationRegistry.Deployment memory d = script.runWith(settings);
        vm.prank(owner);
        d.results.transferOwnership(address(0xCAFE));
        vm.prank(address(0xCAFE));
        d.results.acceptOwnership();
        vm.expectRevert("M003: wrong results owner");
        script.runWith(settings);
    }

    function test_deploysWithAnOwnerThatDoesNotOwnThePointsRegistry() public {
        M003DeployVerificationRegistry.Config memory settings = config();
        settings.owner = address(0xCAFE);
        settings.deploymentNonce = vm.getNonce(address(0xCAFE));
        M003DeployVerificationRegistry.Deployment memory d = script.runWith(settings);
        assertEq(d.results.owner(), address(0xCAFE));
        assertEq(d.policy.owner(), address(0xCAFE));
        assertEq(pointsPolicyRegistry.owner(), owner);
    }

    /// @dev The manual steps from the README, then one audit end to end: verdict, points, reward.
    function test_manualStepsThenAnAuditVerifiesAndPays() public {
        M003DeployVerificationRegistry.Deployment memory d = script.runWith(config());
        assertEq(d.results.auditShareBpsAt(address(d.kbf), 0), 0, "KBF's share starts the epoch after deploy");
        assertEq(d.results.auditShareBpsAt(address(d.kbf), 1), 10_000);
        gate.setCurrentEpoch(1);
        gate.setBudget(address(d.results), 1, 1_000 ether); // stands in for setMinterController
        vm.startPrank(owner);
        d.kbf.setAuditor(auditor, true);
        pointsPolicyRegistry.registerPolicy(address(d.policy));
        d.results.setRewardsStartEpoch(address(d.kbf), 0);
        vm.stopPrank();

        address seller = address(0x5E11);
        vm.prank(seller);
        uint256 agentId = identity.register();
        pools.setSeller(seller, agentId);
        pools.setPower(agentId, 1, 1);
        IAntseedKbfAudits.ServiceResult[] memory batch = new IAntseedKbfAudits.ServiceResult[](1);
        batch[0] = IAntseedKbfAudits.ServiceResult({
            agentId: agentId, serviceHash: keccak256("service"), verdict: IAntseedVerificationResults.Verdict.SAME
        });
        vm.prank(auditor);
        d.kbf.submitModelAudit(1, keccak256("model"), keccak256("evidence"), "ipfs://evidence", batch);
        assertTrue(d.results.isVerified(agentId));
        (uint256 sellerPoints,) = pointsPolicyRegistry.points(bytes32(0), address(0xB0), seller, 1_000_000);
        assertEq(sellerPoints, 1_010_000, "the deployed bonus applies at once");

        vm.prank(owner);
        d.policy.setBonusBps(0);
        (sellerPoints,) = pointsPolicyRegistry.points(bytes32(0), address(0xB0), seller, 1_000_000);
        assertEq(sellerPoints, 1_000_000, "zero rates leave points unchanged");

        gate.setCurrentEpoch(2);
        vm.prank(auditor);
        d.results.claimAuditorReward(address(d.kbf), 1);
        assertEq(gate.minted(auditor), 200 ether, "20% cap of the KBF share");
    }
}
