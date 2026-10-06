// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedVerificationPointsPolicy } from "../policies/AntseedVerificationPointsPolicy.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";

contract ScoreSourceForPoints {
    mapping(uint256 => uint256) public activeScoreBps;
    bool public reverts;

    function set(uint256 agentId, uint256 scoreBps) external {
        activeScoreBps[agentId] = scoreBps;
    }

    function setReverts(bool value) external {
        reverts = value;
    }
}

/// @dev Routes `activeScoreBps` through a switch so the policy can be tested against a reverting source.
contract SwitchableScoreSource {
    ScoreSourceForPoints public immutable source;

    constructor(ScoreSourceForPoints source_) {
        source = source_;
    }

    function activeScoreBps(uint256 agentId) external view returns (uint256) {
        if (source.reverts()) revert("score source down");
        return source.activeScoreBps(agentId);
    }
}

contract SellerPoolsForPoints {
    mapping(address => uint256) public agentIdForSeller;

    function set(address seller, uint256 agentId) external {
        agentIdForSeller[seller] = agentId;
    }
}

contract UsageAccountingForPoints {
    address public sellerPools;

    function setSellerPools(address pools) external {
        sellerPools = pools;
    }
}

contract WashStatusForVerificationPoints {
    mapping(address => bool) public isProvenWashTrader;

    function set(address seller, bool flagged) external {
        isProvenWashTrader[seller] = flagged;
    }
}

contract AntseedVerificationPointsPolicyTest is Test {
    ScoreSourceForPoints scores;
    SellerPoolsForPoints pools;
    UsageAccountingForPoints accounting;
    AntseedVerificationPointsPolicy policy;
    address seller = address(0x100);
    address buyer = address(0x200);

    function setUp() public {
        scores = new ScoreSourceForPoints();
        pools = new SellerPoolsForPoints();
        accounting = new UsageAccountingForPoints();
        accounting.setSellerPools(address(pools));
        pools.set(seller, 7);
        policy = new AntseedVerificationPointsPolicy(
            address(new SwitchableScoreSource(scores)), address(accounting), 2_500, address(this)
        );
    }

    function test_boostsSellerPointsByScoreWeightedBonus() public {
        scores.set(7, 10_000);
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_250);
        assertEq(buyerPoints, 1_000, "buyer points pass through");

        scores.set(7, 5_000);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_125);
    }

    function test_unverifiedOrUnknownSellerIsUnchanged() public {
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);
        scores.set(7, 10_000);
        (sellerPoints,) = policy.points(bytes32(0), buyer, address(0x999), 1_000, 1_000);
        assertEq(sellerPoints, 1_000);
    }

    function test_failingDependenciesNeverRevert() public {
        scores.set(7, 10_000);
        scores.setReverts(true);
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);

        scores.setReverts(false);
        accounting.setSellerPools(address(0));
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);
    }

    function test_bonusIsCappedAndOwnerOnly() public {
        vm.expectRevert(AntseedVerificationPointsPolicy.InvalidValue.selector);
        policy.setBonusBps(5_001);
        policy.setBonusBps(5_000);
        scores.set(7, 20_000);
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_500, "score above BPS is clamped");

        vm.prank(address(0xBAD));
        vm.expectRevert();
        policy.setBonusBps(0);
    }

    function test_washTradingZeroStaysZeroInTheRegistryChain() public {
        WashStatusForVerificationPoints wash = new WashStatusForVerificationPoints();
        AntseedPointsPolicyRegistry registry = new AntseedPointsPolicyRegistry(address(this));
        registry.registerPolicy(address(policy));
        registry.registerPolicy(address(new AntseedWashTradingPointsPolicy(address(wash))));
        scores.set(7, 10_000);

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(bytes32(0), buyer, seller, 1_000);
        assertEq(sellerPoints, 1_250);
        assertEq(buyerPoints, 1_000);

        wash.set(seller, true);
        (sellerPoints, buyerPoints) = registry.points(bytes32(0), buyer, seller, 1_000);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 0);
    }
}
