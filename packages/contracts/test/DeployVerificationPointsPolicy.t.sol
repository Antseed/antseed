// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../policies/AntseedVerificationPointsPolicy.sol";
import { DeployVerificationPointsPolicy } from "../script/DeployVerificationPointsPolicy.s.sol";

contract PolicyDeployResults {
    mapping(address => bool) public isAudit;

    function setAudit(address audit, bool approved) external {
        isAudit[audit] = approved;
    }
}

contract PolicyDeployAccounting {
    address public sellerPools;

    function setSellerPools(address pools) external {
        sellerPools = pools;
    }
}

contract PolicyDeployKbf { }

contract DeployVerificationPointsPolicyTest is Test {
    DeployVerificationPointsPolicy private script;
    PolicyDeployResults private results;
    PolicyDeployAccounting private accounting;
    AntseedPointsPolicyRegistry private registry;
    address private kbf;
    address private owner = address(0xA11CE);

    function setUp() public {
        script = new DeployVerificationPointsPolicy();
        results = new PolicyDeployResults();
        accounting = new PolicyDeployAccounting();
        registry = new AntseedPointsPolicyRegistry(address(this));
        kbf = address(new PolicyDeployKbf());
        results.setAudit(kbf, true);
        accounting.setSellerPools(address(0x7001));
        vm.deal(owner, 1 ether);
    }

    function _config() private view returns (DeployVerificationPointsPolicy.Config memory) {
        return DeployVerificationPointsPolicy.Config({
            expectedChainId: block.chainid,
            results: address(results),
            kbfAudits: kbf,
            usageAccounting: address(accounting),
            pointsPolicyRegistry: address(registry),
            owner: owner,
            bonusBps: 0
        });
    }

    function test_deploysOwnedByOwnerWithRatesOffAndUnregistered() public {
        AntseedVerificationPointsPolicy policy = script.runWith(_config());

        assertEq(policy.owner(), owner);
        assertEq(policy.pendingOwner(), address(0));
        assertEq(address(policy.results()), address(results));
        assertEq(address(policy.usageAccounting()), address(accounting));
        assertEq(policy.bonusBps(), 0);
        assertEq(policy.penaltyBps(), 0);
        assertFalse(registry.isPolicyRegistered(address(policy)));
        assertEq(registry.policyCount(), 0);
    }

    function test_keepsTheConfiguredBonus() public {
        DeployVerificationPointsPolicy.Config memory config = _config();
        config.bonusBps = 100;
        assertEq(script.runWith(config).bonusBps(), 100);
    }

    function test_rejectsAWrongChain() public {
        DeployVerificationPointsPolicy.Config memory config = _config();
        config.expectedChainId = block.chainid + 1;
        vm.expectRevert(
            abi.encodeWithSelector(DeployVerificationPointsPolicy.WrongChain.selector, block.chainid + 1, block.chainid)
        );
        script.runWith(config);
    }

    function test_rejectsAZeroOwner() public {
        DeployVerificationPointsPolicy.Config memory config = _config();
        config.owner = address(0);
        vm.expectRevert(DeployVerificationPointsPolicy.InvalidOwner.selector);
        script.runWith(config);
    }

    function test_rejectsATargetWithoutCode() public {
        DeployVerificationPointsPolicy.Config memory config = _config();
        config.pointsPolicyRegistry = address(0x1234);
        vm.expectRevert(abi.encodeWithSelector(DeployVerificationPointsPolicy.NoCode.selector, address(0x1234)));
        script.runWith(config);
    }

    function test_rejectsResultsThatDoNotApproveTheKbfAudit() public {
        results.setAudit(kbf, false);
        vm.expectRevert(abi.encodeWithSelector(DeployVerificationPointsPolicy.KbfNotAnAudit.selector, kbf));
        script.runWith(_config());
    }

    function test_rejectsAccountingWithoutSellerPools() public {
        accounting.setSellerPools(address(0));
        vm.expectRevert(
            abi.encodeWithSelector(DeployVerificationPointsPolicy.NoSellerPools.selector, address(accounting))
        );
        script.runWith(_config());
    }
}
