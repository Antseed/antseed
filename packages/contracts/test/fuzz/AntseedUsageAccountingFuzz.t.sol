// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedSellerPools } from "../../sellers/AntseedSellerPools.sol";
import { AntseedUsageAccounting } from "../../emissions/AntseedUsageAccounting.sol";
import { IAntseedPointsPolicy } from "../../interfaces/IAntseedPointsPolicy.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract MockAgentLookup {
    mapping(address => uint256) public agentIdBySeller;

    function setAgent(address seller, uint256 agentId) external {
        agentIdBySeller[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIdBySeller[seller];
    }
}

/// @notice A points policy that can revert, return huge values, or behave
///         normally — to prove a misbehaving policy can never brick settlement.
contract HostilePointsPolicy is IAntseedPointsPolicy {
    enum Mode {
        Normal,
        Revert,
        Huge,
        Zero
    }

    Mode public mode;
    uint256 public hugeValue;

    function set(Mode m, uint256 huge) external {
        mode = m;
        hugeValue = huge;
    }

    function points(bytes32, address, address, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        if (mode == Mode.Revert) revert("policy boom");
        if (mode == Mode.Huge) return (hugeValue, hugeValue);
        if (mode == Mode.Zero) return (0, 0);
        return (rawPoints, rawPoints);
    }
}

/**
 * @title AntseedUsageAccountingFuzz
 * @notice The accrual entrypoints are invoked INLINE by AntseedChannels.settle()
 *         with NO try/catch. If they ever revert for a reason outside the
 *         channel's control, ALL USDC settlement bricks network-wide. These
 *         fuzz tests prove the defensive design holds: under any combination of
 *         pause state, missing pool, a reverting/huge/zero points policy, and
 *         realistic-scale points, the accrual calls NEVER revert.
 */
contract AntseedUsageAccountingFuzzTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissionsGate gate;
    MockERC8004Registry identityRegistry;
    AntseedSellerPools pools;
    AntseedUsageAccounting usageAccounting;
    MockAgentLookup agentLookup;
    HostilePointsPolicy policy;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;

    address legacyController = address(0xCAFE);
    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    address deposits = address(0xDEDE);
    address seller = address(0x5E11E2);
    address stakerAddr = address(0x57A);

    uint256 agentId = 0x5EED;

    function setUp() public {
        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        agentLookup = new MockAgentLookup();
        registry.setAntsToken(address(token));
        registry.setEmissions(legacyController);
        registry.setTeamWallet(teamWallet);
        registry.setProtocolReserve(reserve);
        registry.setDeposits(deposits);
        registry.setStaking(address(agentLookup));
        registry.setIdentityRegistry(address(identityRegistry));

        token.setRegistry(address(registry));
        token.enableTransfers();

        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate(teamWallet, reserve, 15_000, 15_000);
        token.setRegistry(address(gate));

        pools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(agentLookup));
        token.setTransferWhitelist(address(pools), true);

        usageAccounting = new AntseedUsageAccounting(address(pools), address(this), address(gate));
        registry.setEmissions(address(usageAccounting));

        policy = new HostilePointsPolicy();
        agentLookup.setAgent(seller, agentId);
        identityRegistry.setOwner(agentId, seller);

        // Seed a real pool with power so the weighted-points multiply path runs.
        deal(address(token), stakerAddr, 100_000_000 ether);
        vm.startPrank(stakerAddr);
        token.approve(address(pools), 100_000_000 ether);
        pools.stake(agentId, 100_000_000 ether, 104);
        vm.stopPrank();
        _warpGateEpoch(5); // pool now active
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _applyConditions(uint8 policyMode, uint256 hugePoints, bool paused, bool hasPool, uint256 minPower) internal {
        if (policyMode % 4 == 0) {
            usageAccounting.setPointsPolicy(address(0)); // passthrough
        } else {
            usageAccounting.setPointsPolicy(address(policy));
            policy.set(HostilePointsPolicy.Mode(policyMode % 4), hugePoints);
        }
        // Optionally point at a seller with no pool.
        usageAccounting.setMinimumAccountedPoolPower(minPower == 0 ? 1 : minPower);
        if (!hasPool) agentLookup.setAgent(seller, 0);
        if (paused) usageAccounting.pause();
    }

    /// @notice The one-call accrual path never reverts for any nonzero buyer/
    ///         seller/points under any external condition.
    function testFuzz_accruePointsNeverReverts(
        uint256 rawPoints,
        uint8 policyMode,
        uint256 hugePoints,
        bool paused,
        bool hasPool,
        uint256 minPower
    ) public {
        rawPoints = bound(rawPoints, 1, 1e30); // far above any realistic USDC settle delta
        hugePoints = bound(hugePoints, 0, 1e24);
        minPower = bound(minPower, 0, 1e60);
        _applyConditions(policyMode, hugePoints, paused, hasPool, minPower);

        // Must not revert regardless of conditions.
        usageAccounting.accruePoints(bytes32(uint256(1)), buyerAddr(), seller, rawPoints);
    }

    /// @notice The legacy two-call pairing never reverts and never leaves a
    ///         stuck pending accrual when seller/buyer deltas match.
    function testFuzz_legacyPairNeverRevertsOrSticks(
        uint256 rawPoints,
        uint8 policyMode,
        uint256 hugePoints,
        bool paused,
        bool hasPool
    ) public {
        rawPoints = bound(rawPoints, 1, 1e30);
        hugePoints = bound(hugePoints, 0, 1e24);
        _applyConditions(policyMode, hugePoints, paused, hasPool, 1);

        usageAccounting.accrueSellerPoints(seller, rawPoints);
        usageAccounting.accrueBuyerPoints(buyerAddr(), rawPoints);

        // After a matched pair the pending slot is always cleared.
        assertEq(usageAccounting.pendingSellerAccrual(), address(0), "pending accrual stuck after matched pair");
    }

    /// @notice Realistic-scale points * pool power never overflows on the settle
    ///         path. Pool power is bounded by total ANTS supply * 104 epochs;
    ///         points by any plausible USDC delta. (Documents the M2 bound.)
    function testFuzz_weightedPointsNoOverflowAtRealisticScale(uint256 rawPoints) public {
        rawPoints = bound(rawPoints, 1, 1e30);
        usageAccounting.setPointsPolicy(address(0));
        // 100M ANTS staked for 104 epochs => poolPower ~ 100M*104 ether. Times
        // points up to 1e30 stays well under 2^256.
        usageAccounting.accruePoints(bytes32(uint256(7)), buyerAddr(), seller, rawPoints);
        assertGt(usageAccounting.weightedPoolPointsByEpoch(uint256(5), agentId), 0, "no weighted points recorded");
    }

    /// @notice Owner-trust boundary: only a policy returning absurd (>~1e50)
    ///         point values can overflow the points * weight multiply. No
    ///         defensive guard exists — the owner sets the policy, and any
    ///         real policy returns USDC-scaled points that stay far under the
    ///         bound (see testFuzz_weightedPointsNoOverflowAtRealisticScale).
    function test_adversarialPolicyOverflowReverts() public {
        usageAccounting.setPointsPolicy(address(policy));
        policy.set(HostilePointsPolicy.Mode.Huge, 1e60); // absurd; no real policy does this

        // poolPower ~ 5.2e27; 1e60 * 5.2e27 overflows uint256.
        vm.expectRevert();
        usageAccounting.accruePoints(bytes32(uint256(9)), buyerAddr(), seller, 1_000);
    }

    function buyerAddr() internal pure returns (address) {
        return address(0xB0B);
    }
}
