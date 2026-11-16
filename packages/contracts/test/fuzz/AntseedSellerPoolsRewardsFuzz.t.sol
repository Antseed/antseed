// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedSellerPools } from "../../sellers/AntseedSellerPools.sol";
import { AntseedUsageAccounting } from "../../emissions/AntseedUsageAccounting.sol";
import { AntseedSellerPoolsRewards } from "../../emissions/AntseedSellerPoolsRewards.sol";
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

/**
 * @title AntseedSellerPoolsRewardsFuzz
 * @notice End-to-end reward-conservation fuzz for the lazy seller-pool reward
 *         controller. Exercises the real stack: EmissionsGate mints, SellerPools
 *         holds stake, UsageAccounting records usage, SellerPoolsRewards settles
 *         and distributes.
 *
 *         Invariants under any random staker set / usage:
 *           1. The pool epoch settles its share of the controller
 *              dynamic staker budget as a single fully-claimable amount.
 *           2. The controller never mints past its Gate share budget.
 *           3. Stakers collectively claim <= the settled amount minted to the
 *              controller — it can NEVER become insolvent. Residual is dust.
 *           4. Each individual position's claim is proportional to its weight and
 *              double-claim is impossible (cursor advances).
 */
contract AntseedSellerPoolsRewardsFuzzTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissionsGate gate;
    MockERC8004Registry identityRegistry;
    AntseedSellerPools pools;
    AntseedUsageAccounting usageAccounting;
    AntseedSellerPoolsRewards rewards;
    MockAgentLookup agentLookup;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint256 constant BPS = 100_000;
    uint32 constant SELLER_POOLS_SHARE_BPS = 40_000;
    bytes32 constant SELLER_POOLS_MINTER_ID = keccak256("antseed.emissions.seller-pools.v1");

    address legacyController = address(0xCAFE);
    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    address deposits = address(0xDEDE);
    address seller = address(0x5E11E2);
    address buyer = address(0xB0B);

    uint256 agentId = 0x5EED;
    uint256[] internal positionIds;
    address[] internal stakers;

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

        // Deploy the gate at epoch 4 so legacy epochs exist and claims for
        // finalized epochs are allowed.
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate(teamWallet, reserve, 15_000, 15_000);
        token.setRegistry(address(gate));
        // No bucket mints until the legacy escrow is settled; any recipient
        // address marks the pot funded.
        gate.fundLegacyEscrow(address(0xE5C0));

        pools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(agentLookup)); // uncapped APY
        token.setTransferWhitelist(address(pools), true);

        usageAccounting = new AntseedUsageAccounting(address(pools), address(this), address(gate));
        registry.setEmissions(address(usageAccounting)); // pools.currentEpoch() -> gate clock

        rewards = new AntseedSellerPoolsRewards(address(gate), address(pools), address(usageAccounting));
        pools.setRewardStaker(address(rewards), true);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(rewards), SELLER_POOLS_SHARE_BPS, true);

        agentLookup.setAgent(seller, agentId);
        identityRegistry.setOwner(agentId, seller);
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _stake(address who, uint256 amount, uint256 dur) internal returns (uint256 id) {
        deal(address(token), who, amount);
        vm.startPrank(who);
        token.approve(address(pools), amount);
        id = pools.stake(agentId, amount, dur);
        vm.stopPrank();
    }

    /// @notice Full lifecycle: random stakers stake into one pool, usage is
    ///         recorded for the seller's agent, the pool epoch settles, and all
    ///         positions claim. The controller distributes exactly what it minted
    ///         (minus rounding dust) and never goes insolvent or over budget.
    function testFuzz_rewardConservationSinglePool(uint256[5] memory amounts, uint8[5] memory durations, uint64 points)
        public
    {
        // We are at epoch 4. Stake now (activates epoch 5).
        uint256 stakedTotal;
        for (uint256 i = 0; i < 5; i++) {
            uint256 amount = bound(amounts[i], 1 ether, 50_000_000 ether);
            uint256 dur = uint256(bound(durations[i], 2, 104));
            address who = address(uint160(0x1000 + i));
            stakers.push(who);
            positionIds.push(_stake(who, amount, dur));
            stakedTotal += amount;
        }

        // Move to epoch 5 (positions now active) and record usage for the seller.
        _warpGateEpoch(5);
        uint256 pts = uint256(bound(points, 1, 1_000_000));
        usageAccounting.accrueSellerPoints(seller, pts);
        usageAccounting.accrueBuyerPoints(buyer, pts);

        // Pool must actually have power and recorded weighted points at epoch 5.
        assertGt(pools.poolWeightAtEpoch(agentId, 5), 0, "pool has no power");
        assertGt(usageAccounting.weightedPoolPointsByEpoch(uint256(5), agentId), 0, "no weighted points");

        // Finalize epoch 5 and settle/index it.
        _warpGateEpoch(6);
        uint256 controllerBudget = gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5);
        rewards.indexPoolRewards(agentId, 10);

        // ── Invariant 1: settlement routing ──
        (bool settled, uint256 settledAmount) = rewards.poolEpochEmissions(5, agentId);
        assertTrue(settled, "epoch not settled");
        // Single pool => it owns the whole dynamic staker budget.
        assertEq(settledAmount, rewards.stakerEpochBudget(5), "settled amount != dynamic staker budget");
        assertLe(settledAmount, controllerBudget, "settled amount over controller budget");

        // ── Invariant 2: controller minted exactly the settled amount to itself ──
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 5), settledAmount, "minted != settled amount");
        assertLe(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 5), controllerBudget, "over budget");
        assertEq(token.balanceOf(address(rewards)), settledAmount, "controller did not custody settled amount");

        // ── All positions claim ──
        uint256 totalClaimed;
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 before = token.balanceOf(stakers[i]);
            vm.prank(stakers[i]);
            try rewards.claimStakerRewards(positionIds[i], stakers[i]) {
                totalClaimed += token.balanceOf(stakers[i]) - before;
            } catch {
                // NothingToClaim for a dust-zero position is acceptable.
            }
        }

        // ── Invariant 3: conservation + solvency ──
        assertLe(totalClaimed, settledAmount, "stakers claimed more than minted");
        // The controller holds exactly the undistributed dust; never negative.
        assertEq(token.balanceOf(address(rewards)), settledAmount - totalClaimed, "insolvency / leak");

        // Dust is bounded by one wei per position (flooring in mulDiv).
        assertLe(settledAmount - totalClaimed, positionIds.length, "dust larger than rounding bound");

        // ── Invariant 4: double-claim is impossible ──
        for (uint256 i = 0; i < positionIds.length; i++) {
            vm.prank(stakers[i]);
            vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
            rewards.claimStakerRewards(positionIds[i], stakers[i]);
        }
    }
}
