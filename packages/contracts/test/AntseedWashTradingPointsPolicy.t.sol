pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";
import { AntseedPositionInit } from "../sellers/AntseedPositionInit.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { MockLegacySellerStaking } from "./AntseedPositionInit.t.sol";

contract WashTradingStatusForPoints {
    mapping(address => bool) public isProvenWashTrader;

    function set(address seller, bool flagged) external {
        isProvenWashTrader[seller] = flagged;
    }
}

contract AntseedWashTradingPointsPolicyTest is Test {
    WashTradingStatusForPoints status;
    AntseedWashTradingPointsPolicy policy;
    AntseedPointsPolicyRegistry policies;
    AntseedUsageAccounting accounting;
    AntseedPositionInit faucet;
    AntseedSellerPools pools;
    address seller = address(0x100);
    address buyer = address(0x200);
    uint256 agentId;
    uint256 genesis;

    function setUp() public {
        vm.warp(1_700_000_000);
        genesis = block.timestamp;
        status = new WashTradingStatusForPoints();
        policy = new AntseedWashTradingPointsPolicy(address(status));
        policies = new AntseedPointsPolicyRegistry(address(this));
        policies.registerPolicy(address(policy));

        AntseedRegistry registry = new AntseedRegistry();
        ANTSToken token = new ANTSToken();
        token.setRegistry(address(registry));
        registry.setAntsToken(address(token));
        registry.setEmissions(address(this));
        MockERC8004Registry identity = new MockERC8004Registry();
        MockLegacySellerStaking legacy = new MockLegacySellerStaking();
        vm.prank(seller);
        agentId = identity.register();
        legacy.setAgent(seller, agentId);
        legacy.setStakedAboveMin(seller, true);
        pools = new AntseedSellerPools(address(token), address(this), address(identity), address(legacy));
        AntseedSellerRegistry sellers = new AntseedSellerRegistry(address(identity), address(pools), address(legacy));
        pools.setStakingSource(address(sellers));
        faucet = new AntseedPositionInit(address(pools), address(legacy), 1 ether, 105);
        token.setTransferWhitelist(address(faucet), true);
        token.setTransferWhitelist(address(pools), true);
        token.mint(address(faucet), 1 ether);
        accounting = new AntseedUsageAccounting(address(pools), address(this), address(this));
        accounting.setPointsPolicy(address(policies));
    }

    function currentEpoch() external view returns (uint256) {
        return (block.timestamp - genesis) / 1 weeks;
    }

    function effectiveEpoch() external pure returns (uint256) {
        return 1;
    }

    function test_rejectsZeroRegistry() public {
        vm.expectRevert(AntseedWashTradingPointsPolicy.InvalidAddress.selector);
        new AntseedWashTradingPointsPolicy(address(0));
    }

    function testFuzz_unflaggedSellerPreservesBothSides(uint128 rawPoints) public view {
        (uint256 sellerPoints, uint256 buyerPoints) = policies.points(bytes32(0), buyer, seller, rawPoints);
        assertEq(sellerPoints, rawPoints);
        assertEq(buyerPoints, rawPoints);
    }

    function testFuzz_flaggedSellerVetoesBothSides(uint128 rawPoints) public {
        status.set(seller, true);
        (uint256 sellerPoints, uint256 buyerPoints) = policies.points(bytes32(0), buyer, seller, rawPoints);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 0);
    }

    function test_checksSellerNotBuyer() public {
        status.set(buyer, true);
        (uint256 sellerPoints, uint256 buyerPoints) = policies.points(bytes32(0), buyer, seller, 123);
        assertEq(sellerPoints, 123);
        assertEq(buyerPoints, 123);
    }

    function test_preservesIndependentIncomingPoints() public view {
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 123, 456);
        assertEq(sellerPoints, 123);
        assertEq(buyerPoints, 456);
    }

    function test_accountingKeepsSellerFirstPolicyReturns() public {
        _initializeAndActivate();
        vm.mockCall(
            address(policy),
            abi.encodeWithSelector(policy.points.selector, bytes32(0), buyer, seller, 100, 100),
            abi.encode(456, 123)
        );
        accounting.accruePoints(bytes32(0), buyer, seller, 100);
        accounting.accrueSellerPoints(seller, 100);
        accounting.accrueBuyerPoints(buyer, 100);
        assertEq(accounting.totalUsage().buyers.points, 246);
        assertEq(accounting.totalUsage().sellers.points, 912);
        assertEq(accounting.totalUsage().sellers.weightedPoints, 912 * pools.poolWeightAtEpoch(agentId, 1));
    }

    function test_flaggedSellerCanInitializeButEarnsNoUsagePoints() public {
        status.set(seller, true);
        _initializeAndActivate();
        assertTrue(faucet.agentInitialized(agentId));
        assertGt(pools.poolWeightAtEpoch(agentId, 1), 0);

        accounting.accrueSellerPoints(seller, 100);
        accounting.accrueBuyerPoints(buyer, 100);
        assertEq(accounting.pendingSellerAccrual(), address(0));
        assertEq(accounting.totalUsage().sellers.points, 0);
        assertEq(accounting.totalUsage().buyers.points, 0);
    }

    function test_flaggingAffectsFutureRecordsNotPastPoints() public {
        _initializeAndActivate();
        accounting.accruePoints(bytes32(0), buyer, seller, 100);
        status.set(seller, true);
        accounting.accruePoints(bytes32(0), buyer, seller, 200);
        assertEq(accounting.totalUsage().sellers.points, 100);
        assertEq(accounting.totalUsage().buyers.points, 100);
        assertEq(accounting.totalUsage().sellers.weightedPoints, 100 * pools.poolWeightAtEpoch(agentId, 1));
    }

    function test_revertingStatusSkipsPointsWithoutRevertingAccrual() public {
        _initializeAndActivate();
        vm.mockCallRevert(address(status), abi.encodeWithSignature("isProvenWashTrader(address)", seller), hex"01");
        accounting.accrueSellerPoints(seller, 100);
        accounting.accrueBuyerPoints(buyer, 100);
        assertEq(accounting.pendingSellerAccrual(), address(0));
        assertEq(accounting.totalUsage().sellers.points, 0);
        assertEq(accounting.totalUsage().buyers.points, 0);
    }

    function test_ownerCanRemovePolicyWithoutChangingFaucet() public {
        status.set(seller, true);
        _initializeAndActivate();
        policies.removePolicy(address(policy));
        accounting.accruePoints(bytes32(0), buyer, seller, 100);
        assertEq(accounting.totalUsage().sellers.points, 100);
        assertEq(accounting.totalUsage().buyers.points, 100);
    }

    function _initializeAndActivate() internal {
        vm.prank(seller);
        faucet.initPosition();
        vm.warp(genesis + 1 weeks);
    }
}
