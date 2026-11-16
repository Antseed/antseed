// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";
import { IAntseedVerificationResults } from "../interfaces/IAntseedVerificationResults.sol";

contract VerificationResultsForPoints {
    mapping(uint256 => IAntseedVerificationResults.AgentStatus) private _status;
    bool public reverts;

    function set(uint256 agentId, uint16 verifiedCount, uint16 diffCount) external {
        _status[agentId] = IAntseedVerificationResults.AgentStatus(verifiedCount, diffCount);
    }

    function setReverts(bool value) external {
        reverts = value;
    }

    function status(uint256 agentId) external view returns (IAntseedVerificationResults.AgentStatus memory) {
        return _status[agentId];
    }
}

/// @dev Routes `agentStatus` through a switch so the policy can be tested against a reverting source.
contract SwitchableVerificationResults {
    VerificationResultsForPoints public immutable source;

    constructor(VerificationResultsForPoints source_) {
        source = source_;
    }

    function agentStatus(uint256 agentId) external view returns (IAntseedVerificationResults.AgentStatus memory) {
        if (source.reverts()) revert("score source down");
        return source.status(agentId);
    }
}

contract SellerPoolsForVerificationPoints {
    mapping(address => uint256) public agentIdForSeller;

    function set(address seller, uint256 agentId) external {
        agentIdForSeller[seller] = agentId;
    }
}

contract UsageAccountingForVerificationPoints {
    address public sellerPools;

    function setSellerPools(address pools) external {
        sellerPools = pools;
    }
}

contract WashStatusForResultsPoints {
    mapping(address => bool) public isProvenWashTrader;

    function set(address seller, bool flagged) external {
        isProvenWashTrader[seller] = flagged;
    }
}

contract AntseedVerificationPointsPolicyTest is Test {
    VerificationResultsForPoints scores;
    SellerPoolsForVerificationPoints pools;
    UsageAccountingForVerificationPoints accounting;
    AntseedVerificationPointsPolicy policy;
    address seller = address(0x100);
    address buyer = address(0x200);

    function setUp() public {
        vm.warp(1_800_000_000);
        scores = new VerificationResultsForPoints();
        pools = new SellerPoolsForVerificationPoints();
        accounting = new UsageAccountingForVerificationPoints();
        accounting.setSellerPools(address(pools));
        pools.set(seller, 7);
        policy = new AntseedVerificationPointsPolicy(
            address(new SwitchableVerificationResults(scores)), address(accounting), 100, address(this)
        );
    }

    function test_ratesApplyAsSoonAsTheOwnerSetsThem() public {
        AntseedVerificationPointsPolicy fresh = new AntseedVerificationPointsPolicy(
            address(new SwitchableVerificationResults(scores)), address(accounting), 0, address(this)
        );
        assertEq(fresh.bonusBps(), 0, "bonus off by default");
        assertEq(fresh.penaltyBps(), 0, "penalty off by default");
        scores.set(7, 10, 1);
        (uint256 sellerPoints,) = fresh.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 10_000, "unchanged while both rates are 0");

        vm.expectEmit(address(fresh));
        emit AntseedVerificationPointsPolicy.PenaltyBpsSet(5_000);
        fresh.setPenaltyBps(5_000);
        (sellerPoints,) = fresh.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 5_000, "penalty applies on the next settlement");

        fresh.setBonusBps(100);
        (sellerPoints,) = fresh.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 6_000, "1 + 10 * 1% - 1 * 50%");

        fresh.setBonusBps(0);
        fresh.setPenaltyBps(0);
        (sellerPoints,) = fresh.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 10_000, "zeroing both rates turns it off again");
    }

    function test_eachVerifiedModelAddsBonusUpToCap() public {
        _verify(1);
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 10_100);
        assertEq(buyerPoints, 10_100, "buyer points get the same bonus");

        _verify(30);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 13_000);

        _verify(500);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 15_000, "total bonus capped at 50%");
    }

    function test_unverifiedOrUnknownSellerIsUnchanged() public {
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);

        _verify(3);
        (sellerPoints,) = policy.points(bytes32(0), buyer, address(0x999), 1_000, 1_000);
        assertEq(sellerPoints, 1_000, "unknown seller");
    }

    function test_diffOnlyRemovesThatModelAndPenaltyIsOffByDefault() public {
        assertEq(policy.penaltyBps(), 0);
        scores.set(7, 3, 1);
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 10_300, "other verified models keep their bonus");
    }

    function test_penaltyGrowsWithTheSquareOfDiffsAndFloorsAtZero() public {
        policy.setPenaltyBps(1_000);
        scores.set(7, 20, 1);
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 11_000, "1 + 20 * 1% - 1 * 10%");
        assertEq(buyerPoints, 11_000);

        scores.set(7, 0, 3);
        (sellerPoints, buyerPoints) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 1_000, "1 - 3^2 * 10%");
        assertEq(buyerPoints, 1_000, "buyer points get the same penalty");

        scores.set(7, 0, 11);
        (sellerPoints, buyerPoints) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 0, "never below zero");
        assertEq(buyerPoints, 0, "buyer points never below zero");

        policy.setPenaltyBps(type(uint256).max);
        scores.set(7, 5, 2);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 0, "huge penalty does not overflow");

        policy.setBonusBps(0);
        policy.setPenaltyBps(1_000);
        scores.set(7, 5, 2);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 6_000, "1 - 2^2 * 10%, with the bonus off");

        vm.prank(address(0xBAD));
        vm.expectRevert();
        policy.setPenaltyBps(0);
    }

    function test_penaltyCurveAtTheLaunchRate() public {
        policy.setBonusBps(0);
        policy.setPenaltyBps(400);
        uint256[6] memory expected = [uint256(10_000), 9_600, 8_400, 6_400, 3_600, 0];
        for (uint16 diffs = 0; diffs < expected.length; ++diffs) {
            scores.set(7, 0, diffs);
            (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
            assertEq(sellerPoints, expected[diffs]);
            assertEq(buyerPoints, expected[diffs]);
        }
    }

    function test_scalesEachSideFromItsOwnPoints() public {
        policy.setPenaltyBps(2_000);
        scores.set(7, 0, 1);

        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 10_000, 5_000);
        assertEq(sellerPoints, 8_000);
        assertEq(buyerPoints, 4_000);

        (sellerPoints, buyerPoints) = policy.points(bytes32(0), buyer, seller, 0, 5_000);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 4_000, "a seller side already at zero still scales the buyer");

        (sellerPoints, buyerPoints) = policy.points(bytes32(0), buyer, seller, 10_000, 0);
        assertEq(sellerPoints, 8_000);
        assertEq(buyerPoints, 0, "a buyer side already at zero stays zero");
    }

    function test_zeroBonusLeavesVerifiedSellerUnchanged() public {
        policy.setBonusBps(0);
        _verify(10);
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);
        assertEq(buyerPoints, 1_000);
    }

    function test_failingDependenciesNeverRevert() public {
        _verify(2);
        scores.setReverts(true);
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);
        assertEq(buyerPoints, 1_000);

        scores.setReverts(false);
        accounting.setSellerPools(address(0));
        (sellerPoints, buyerPoints) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);
        assertEq(buyerPoints, 1_000);
    }

    function test_bonusIsCappedAndOwnerOnly() public {
        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidValue.selector);
        policy.setBonusBps(5_001);
        policy.setBonusBps(5_000);
        _verify(1);
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_500);

        vm.prank(address(0xBAD));
        vm.expectRevert();
        policy.setBonusBps(0);
    }

    function testFuzz_pointsMatchFormula(
        uint128 points_,
        uint128 buyerPoints_,
        uint16 count,
        uint16 diffs,
        uint16 bonus,
        uint32 penalty
    ) public {
        bonus = uint16(bound(bonus, 0, 5_000));
        policy.setBonusBps(bonus);
        policy.setPenaltyBps(penalty);
        scores.set(7, count, diffs);
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, points_, buyerPoints_);
        uint256 total = uint256(count) * bonus;
        if (total > 5_000) total = 5_000;
        uint256 minus = uint256(diffs) * diffs * penalty;
        uint256 multiplier = 10_000 + total > minus ? 10_000 + total - minus : 0;
        assertEq(sellerPoints, (uint256(points_) * multiplier) / 10_000);
        assertEq(buyerPoints, (uint256(buyerPoints_) * multiplier) / 10_000);
    }

    function test_washTradingZeroStaysZeroInTheRegistryChain() public {
        WashStatusForResultsPoints wash = new WashStatusForResultsPoints();
        AntseedPointsPolicyRegistry registry = new AntseedPointsPolicyRegistry(address(this));
        registry.registerPolicy(address(policy));
        registry.registerPolicy(address(new AntseedWashTradingPointsPolicy(address(wash))));
        _verify(25);

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(bytes32(0), buyer, seller, 1_000);
        assertEq(sellerPoints, 1_250);
        assertEq(buyerPoints, 1_250);

        wash.set(seller, true);
        (sellerPoints, buyerPoints) = registry.points(bytes32(0), buyer, seller, 1_000);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 0);
    }

    function test_constructorValidates() public {
        address results = address(new SwitchableVerificationResults(scores));
        assertEq(address(policy.usageAccounting()), address(accounting));
        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidAddress.selector);
        new AntseedVerificationPointsPolicy(address(0x1234), address(accounting), 0, address(this));
        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidAddress.selector);
        new AntseedVerificationPointsPolicy(results, address(0x1234), 0, address(this));
        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidValue.selector);
        new AntseedVerificationPointsPolicy(results, address(accounting), 5_001, address(this));
        AntseedVerificationPointsPolicy owned =
            new AntseedVerificationPointsPolicy(results, address(accounting), 0, address(0xB0B));
        assertEq(address(owned.results()), results);
        assertEq(owned.owner(), address(0xB0B));
    }

    function _verify(uint16 verifiedCount) private {
        scores.set(7, verifiedCount, 0);
    }
}
