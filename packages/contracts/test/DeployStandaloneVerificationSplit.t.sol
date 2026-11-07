// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { DeployStandaloneVerificationSplit } from "../script/DeployStandaloneVerificationSplit.s.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { MockVerificationEmissionsGate } from "./mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "./mocks/MockVerificationSellerPools.sol";
import { VerificationPointsAccounting } from "./mocks/MockVerificationAccounting.sol";

contract DeployStandaloneVerificationSplitTest is Test {
    AntseedRegistry private registry;
    MockERC8004Registry private identity;
    MockVerificationEmissionsGate private emissions;
    MockVerificationSellerPools private sellerPools;
    VerificationPointsAccounting private accounting;
    DeployStandaloneVerificationSplit private script;

    address private owner = address(0xA11CE);
    address private auditor = address(0xB0B);

    function setUp() public {
        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        emissions = new MockVerificationEmissionsGate();
        sellerPools = new MockVerificationSellerPools();
        accounting = new VerificationPointsAccounting(address(sellerPools));
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(emissions));
        script = new DeployStandaloneVerificationSplit();
        vm.deal(owner, 1 ether);
    }

    function _config() private view returns (DeployStandaloneVerificationSplit.Config memory config) {
        address[] memory auditors = new address[](1);
        auditors[0] = auditor;
        config = DeployStandaloneVerificationSplit.Config({
            expectedChainId: block.chainid,
            registry: address(registry),
            sellerPools: address(sellerPools),
            usageAccounting: address(accounting),
            owner: owner,
            auditors: auditors,
            bonusBps: 0
        });
    }

    function test_deploysTheSplitWithRewardsOff() public {
        address originalEmissions = registry.emissions();
        address originalIdentity = registry.identityRegistry();
        uint64 originalOwnerNonce = vm.getNonce(owner);

        DeployStandaloneVerificationSplit.Deployment memory d = script.runWith(_config());

        assertEq(d.results.owner(), owner);
        assertEq(d.kbf.owner(), owner);
        assertEq(d.policy.owner(), owner);
        assertEq(address(d.kbf.identityRegistry()), address(identity));
        assertEq(address(d.kbf.sellerPools()), address(sellerPools));
        assertEq(address(d.results.emissionsGate()), address(emissions));
        assertEq(d.results.rewardsStartEpoch(address(d.kbf)), type(uint64).max);
        assertTrue(d.results.isAudit(address(d.kbf)));
        assertEq(d.results.auditShareBps(address(d.kbf)), 10_000);
        assertEq(address(d.kbf.results()), address(d.results));
        assertEq(address(d.policy.results()), address(d.results));
        assertTrue(d.kbf.approvedAuditors(auditor));
        assertEq(registry.emissions(), originalEmissions);
        assertEq(registry.identityRegistry(), originalIdentity);
        // 3 deployments + setAudit + setAuditShareBps + one setAuditor per auditor.
        assertEq(vm.getNonce(owner), originalOwnerNonce + 5 + _config().auditors.length);
    }

    function test_rejectsWrongChainBeforeDeployment() public {
        DeployStandaloneVerificationSplit.Config memory config = _config();
        config.expectedChainId++;
        vm.expectRevert("standalone: wrong chain");
        script.runWith(config);
        assertEq(vm.getNonce(owner), 0);
    }

    function test_rejectsZeroAuditorBeforeDeployment() public {
        DeployStandaloneVerificationSplit.Config memory config = _config();
        config.auditors[0] = address(0);
        vm.expectRevert("standalone: zero auditor");
        script.runWith(config);
        assertEq(vm.getNonce(owner), 0);
    }

    function test_rejectsMissingUsageAccountingAndBonusAboveCap() public {
        DeployStandaloneVerificationSplit.Config memory config = _config();
        config.usageAccounting = address(0x1234);
        vm.expectRevert("standalone: missing usage accounting");
        script.runWith(config);
        config = _config();
        config.bonusBps = 5_001;
        vm.expectRevert("standalone: bonus above cap");
        script.runWith(config);
    }
}
