// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedKbfVerificationPointsPolicy } from "../policies/AntseedKbfVerificationPointsPolicy.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";
import { IAntseedKbfVerification } from "../interfaces/IAntseedKbfVerification.sol";

contract ScoreSourceForPoints {
    mapping(uint256 => IAntseedKbfVerification.AgentStatus) private _status;
    bool public reverts;

    function set(uint256 agentId, uint16 verifiedCount, uint16 diffCount) external {
        _status[agentId] = IAntseedKbfVerification.AgentStatus(verifiedCount, diffCount);
    }

    function setReverts(bool value) external {
        reverts = value;
    }

    function status(uint256 agentId) external view returns (IAntseedKbfVerification.AgentStatus memory) {
        return _status[agentId];
    }
}

/// @dev Routes `agentStatus` through a switch so the policy can be tested against a reverting source.
contract SwitchableScoreSource {
    ScoreSourceForPoints public immutable source;

    constructor(ScoreSourceForPoints source_) {
        source = source_;
    }

    function auditType() external pure returns (bytes32) {
        return keccak256("kbf-model-identity/v1");
    }

    function agentStatus(uint256 agentId) external view returns (IAntseedKbfVerification.AgentStatus memory) {
        if (source.reverts()) revert("score source down");
        return source.status(agentId);
    }
}

/// @dev A verification contract for some other method.
contract OtherMethodVerificationForPoints {
    function auditType() external pure returns (bytes32) {
        return keccak256("other-method/v1");
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

contract AntseedKbfVerificationPointsPolicyTest is Test {
    ScoreSourceForPoints scores;
    SellerPoolsForPoints pools;
    UsageAccountingForPoints accounting;
    AntseedKbfVerificationPointsPolicy policy;
    address seller = address(0x100);
    address buyer = address(0x200);

    function setUp() public {
        vm.warp(1_800_000_000);
        scores = new ScoreSourceForPoints();
        pools = new SellerPoolsForPoints();
        accounting = new UsageAccountingForPoints();
        accounting.setSellerPools(address(pools));
        pools.set(seller, 7);
        policy = new AntseedKbfVerificationPointsPolicy(
            address(new SwitchableScoreSource(scores)), address(accounting), 100, address(this)
        );
    }

    function test_onlyReadsAKbfVerificationContract() public {
        assertEq(policy.AUDIT_TYPE(), keccak256("kbf-model-identity/v1"), "KBF audit type");
        address other = address(new OtherMethodVerificationForPoints());
        vm.expectRevert(AntseedKbfVerificationPointsPolicy.InvalidAddress.selector);
        new AntseedKbfVerificationPointsPolicy(other, address(accounting), 0, address(this));
    }

    function test_ratesApplyAsSoonAsTheOwnerSetsThem() public {
        AntseedKbfVerificationPointsPolicy fresh = new AntseedKbfVerificationPointsPolicy(
            address(new SwitchableScoreSource(scores)), address(accounting), 0, address(this)
        );
        assertEq(fresh.bonusBps(), 0, "bonus off by default");
        assertEq(fresh.penaltyBps(), 0, "penalty off by default");
        scores.set(7, 10, 1);
        (uint256 sellerPoints,) = fresh.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 10_000, "unchanged while both rates are 0");

        vm.expectEmit(address(fresh));
        emit AntseedKbfVerificationPointsPolicy.PenaltyBpsSet(5_000);
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
        assertEq(buyerPoints, 10_000, "buyer points pass through");

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

    function test_penaltyPerDiffModelIsUncappedAndFloorsAtZero() public {
        policy.setPenaltyBps(1_000);
        scores.set(7, 20, 1);
        (uint256 sellerPoints, uint256 buyerPoints) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 11_000, "1 + 20 * 1% - 1 * 10%");
        assertEq(buyerPoints, 10_000);

        scores.set(7, 0, 3);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 7_000);

        scores.set(7, 0, 11);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 0, "never below zero");

        policy.setPenaltyBps(type(uint256).max);
        scores.set(7, 5, 2);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 0, "huge penalty does not overflow");

        policy.setBonusBps(0);
        policy.setPenaltyBps(1_000);
        scores.set(7, 5, 2);
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 10_000, 10_000);
        assertEq(sellerPoints, 8_000, "penalty applies with the bonus off");

        vm.prank(address(0xBAD));
        vm.expectRevert();
        policy.setPenaltyBps(0);
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
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);

        scores.setReverts(false);
        accounting.setSellerPools(address(0));
        (sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_000);
    }

    function test_bonusIsCappedAndOwnerOnly() public {
        vm.expectRevert(AntseedKbfVerificationPointsPolicy.InvalidValue.selector);
        policy.setBonusBps(5_001);
        policy.setBonusBps(5_000);
        _verify(1);
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, 1_000, 1_000);
        assertEq(sellerPoints, 1_500);

        vm.prank(address(0xBAD));
        vm.expectRevert();
        policy.setBonusBps(0);
    }

    function testFuzz_pointsMatchFormula(uint128 points_, uint16 count, uint16 diffs, uint16 bonus, uint32 penalty)
        public
    {
        bonus = uint16(bound(bonus, 0, 5_000));
        policy.setBonusBps(bonus);
        policy.setPenaltyBps(penalty);
        scores.set(7, count, diffs);
        (uint256 sellerPoints,) = policy.points(bytes32(0), buyer, seller, points_, 1);
        uint256 total = uint256(count) * bonus;
        if (total > 5_000) total = 5_000;
        uint256 minus = uint256(diffs) * penalty;
        uint256 multiplier = 10_000 + total > minus ? 10_000 + total - minus : 0;
        assertEq(sellerPoints, (uint256(points_) * multiplier) / 10_000);
    }

    function test_washTradingZeroStaysZeroInTheRegistryChain() public {
        WashStatusForVerificationPoints wash = new WashStatusForVerificationPoints();
        AntseedPointsPolicyRegistry registry = new AntseedPointsPolicyRegistry(address(this));
        registry.registerPolicy(address(policy));
        registry.registerPolicy(address(new AntseedWashTradingPointsPolicy(address(wash))));
        _verify(25);

        (uint256 sellerPoints, uint256 buyerPoints) = registry.points(bytes32(0), buyer, seller, 1_000);
        assertEq(sellerPoints, 1_250);
        assertEq(buyerPoints, 1_000);

        wash.set(seller, true);
        (sellerPoints, buyerPoints) = registry.points(bytes32(0), buyer, seller, 1_000);
        assertEq(sellerPoints, 0);
        assertEq(buyerPoints, 0);
    }

    function _verify(uint16 verifiedCount) private {
        scores.set(7, verifiedCount, 0);
    }
}
