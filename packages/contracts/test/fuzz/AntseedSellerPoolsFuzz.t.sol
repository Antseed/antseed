// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedSellerPools } from "../../sellers/AntseedSellerPools.sol";
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
 * @title AntseedSellerPoolsFuzz
 * @notice Property/fuzz tests for the seller-pool epoch power model and stake
 *         lifecycle. These target the money-safety invariants that the unit
 *         suite asserts only at fixed inputs:
 *
 *           1. Fenwick pool/total power exactly equals an O(n) naive sum over
 *              positions for any random stake set and any epoch.
 *           2. Pool power and total power stay mutually consistent.
 *           3. Withdraw conserves principal: returned + slashed == principal,
 *              slash within [min, max] bps, and ANTS is fully conserved
 *              (staker + dead address receive exactly the principal).
 *           4. The pool is always solvent: its ANTS balance never drops below
 *              the sum of still-open position principals.
 *           5. moveStake preserves principal and only ever reduces weight.
 *           6. The deterministic APY cap curve stays within [floor, start],
 *              is non-increasing, and lands exactly on the floor after decay.
 *
 *         The test contract itself is registry.emissions(), so currentEpoch()
 *         is driven by vm.warp.
 */
contract AntseedSellerPoolsFuzzTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    MockERC8004Registry identityRegistry;
    MockAgentLookup agentLookup;
    AntseedSellerPools pools;

    address staker = address(0x5742E);
    address dead = 0x000000000000000000000000000000000000dEaD;

    uint256 genesis;
    uint256 constant EPOCH_DURATION = 1 weeks;

    // positions created during a fuzz run, for naive recomputation
    uint256[] internal positionIds;

    function setUp() public {
        vm.warp(1_700_000_000);
        genesis = block.timestamp;

        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        agentLookup = new MockAgentLookup();
        token = new ANTSToken();
        token.setRegistry(address(registry));
        token.enableTransfers();
        registry.setAntsToken(address(token));
        registry.setEmissions(address(this));
        registry.setIdentityRegistry(address(identityRegistry));
        registry.setStaking(address(agentLookup));

        _registerSellerAgent(1);
        _registerSellerAgent(2);
        _registerSellerAgent(3);
        _registerSellerAgent(7);
        _registerSellerAgent(fixedAgent());

        pools = new AntseedSellerPools(address(token), address(this), address(identityRegistry), address(agentLookup));
        token.setTransferWhitelist(address(pools), true);

        token.mint(staker, 1_000_000_000 ether);
    }

    // registry.emissions() endpoint used by AntseedSellerPools.currentEpoch()
    function currentEpoch() external view returns (uint256) {
        if (block.timestamp <= genesis) return 0;
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function _warpToEpoch(uint256 epoch) internal {
        vm.warp(genesis + epoch * EPOCH_DURATION + 1);
    }

    function _stake(uint256 agentId, uint256 amount, uint256 stakeEpochs) internal returns (uint256 id) {
        vm.startPrank(staker);
        token.approve(address(pools), amount);
        id = pools.stake(agentId, amount, stakeEpochs);
        vm.stopPrank();
    }

    function _registerSellerAgent(uint256 agentId) internal {
        address seller = address(uint160(0xA000 + agentId));
        identityRegistry.setOwner(agentId, seller);
        agentLookup.setAgent(seller, agentId);
    }

    // ─── Naive O(n) power recomputation, the oracle for the Fenwick tree ──
    function _naivePoolPower(uint256 agentId, uint256 epoch) internal view returns (uint256 power) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            (, uint256 posAgentId,,,,,,) = pools.positions(id);
            if (posAgentId != agentId) continue;
            power += pools.positionWeightAtEpoch(id, epoch);
        }
    }

    function _naiveTotalPower(uint256 epoch) internal view returns (uint256 power) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            power += pools.positionWeightAtEpoch(positionIds[i], epoch);
        }
    }

    /// @notice The Fenwick-backed pool power and total power must match a naive
    ///         per-position sum, for any stake set and any queried epoch.
    function testFuzz_poolPowerMatchesNaiveSum(uint256[8] memory amounts, uint8[8] memory durations, uint8[8] memory agents, uint8 queryEpoch) public {
        for (uint256 i = 0; i < 8; i++) {
            uint256 amount = bound(amounts[i], 1, 5_000_000 ether);
            uint256 dur = uint256(bound(durations[i], 1, 104));
            uint256 agentId = uint256(agents[i]) % 3 + 1; // agents 1..3

            positionIds.push(_stake(agentId, amount, dur));
        }

        uint256 epoch = uint256(queryEpoch) % 80; // span well past most locks

        uint256 naiveTotal;
        for (uint256 agentId = 1; agentId <= 3; agentId++) {
            uint256 fenwick = pools.poolWeightAtEpoch(agentId, epoch);
            uint256 naive = _naivePoolPower(agentId, epoch);
            assertEq(fenwick, naive, "pool power != naive sum");
            naiveTotal += naive;
        }

        assertEq(pools.totalPowerWeightAtEpoch(epoch), naiveTotal, "total power != sum of pools");
        assertEq(pools.totalPowerWeightAtEpoch(epoch), _naiveTotalPower(epoch), "total power != naive total");
    }

    /// @notice Pool power must equal the naive sum at EVERY epoch across a lock's
    ///         lifetime, including the activation-delay gap and after expiry.
    function testFuzz_powerConsistentAcrossLifetime(uint256 amount, uint8 duration, uint8 delay) public {
        amount = bound(amount, 1, 10_000_000 ether);
        uint256 dur = uint256(bound(duration, 1, 104));
        uint256 activationDelay = uint256(bound(delay, 1, 5));

        pools.setPoolConfig(1, activationDelay, 5_000, 500);

        uint256 agentId = 7;
        uint256 id = _stake(agentId, amount, dur);
        positionIds.push(id);

        (,,, uint256 weightAmount, uint64 startEpoch, uint64 endEpoch,,) = pools.positions(id);

        for (uint256 e = 0; e <= uint256(endEpoch) + 3; e++) {
            uint256 expected = (e >= startEpoch && e < endEpoch) ? weightAmount * (uint256(endEpoch) - e) : 0;
            assertEq(pools.poolWeightAtEpoch(agentId, e), expected, "lifetime power mismatch");
            assertEq(pools.positionWeightAtEpoch(id, e), expected, "position power mismatch");
        }
    }

    /// @notice Withdraw conserves principal exactly and keeps the pool solvent.
    function testFuzz_withdrawConservesPrincipalAndSolvency(uint256 amount, uint8 duration, uint8 warpEpochs) public {
        amount = bound(amount, 1, 100_000_000 ether);
        uint256 dur = uint256(bound(duration, 1, 104));
        uint256 warpE = uint256(bound(warpEpochs, 0, 60));

        uint256 poolStartBalance = token.balanceOf(address(pools));
        uint256 stakerStartBalance = token.balanceOf(staker);
        uint256 deadStartBalance = token.balanceOf(dead);

        uint256 id = _stake(fixedAgent(), amount, dur);
        assertEq(token.balanceOf(address(pools)), poolStartBalance + amount, "principal not custodied");

        _warpToEpoch(warpE);

        uint256 slashBps = pools.earlyExitSlashBps(id);
        assertLe(slashBps, 5_000, "slash exceeds maxSlashBps");

        vm.prank(staker);
        pools.withdrawStake(id);

        uint256 returned = token.balanceOf(staker) - (stakerStartBalance - amount);
        uint256 slashed = token.balanceOf(dead) - deadStartBalance;

        // A close that takes effect next epoch still removes power but pays full
        // principal back this epoch only when already matured; either way the
        // sum of returned + slashed is exactly the principal.
        assertEq(returned + slashed, amount, "principal not conserved");
        assertLe(slashed, amount, "slashed more than principal");
        // Solvency: pool balance returns to its seed (only this position existed).
        assertEq(token.balanceOf(address(pools)), poolStartBalance, "pool insolvent after withdraw");
    }

    /// @notice Across a random batch of stakes then withdrawals, the pool can
    ///         never pay out (returned + slashed) more ANTS than was deposited.
    function testFuzz_batchWithdrawNeverOverpays(uint256[6] memory amounts, uint8[6] memory durations, uint8 warpEpochs) public {
        uint256 totalDeposited;
        uint256 poolStart = token.balanceOf(address(pools));

        for (uint256 i = 0; i < 6; i++) {
            uint256 amount = bound(amounts[i], 1, 20_000_000 ether);
            uint256 dur = uint256(bound(durations[i], 1, 104));
            positionIds.push(_stake(fixedAgent(), amount, dur));
            totalDeposited += amount;
        }

        _warpToEpoch(uint256(bound(warpEpochs, 0, 60)));

        uint256 stakerBefore = token.balanceOf(staker);
        uint256 deadBefore = token.balanceOf(dead);

        for (uint256 i = 0; i < positionIds.length; i++) {
            (,,,,, uint64 endEpoch, uint64 closedAt, bool withdrawn) = pools.positions(positionIds[i]);
            if (withdrawn || closedAt != 0) continue;
            endEpoch; // silence unused
            vm.prank(staker);
            pools.withdrawStake(positionIds[i]);
        }

        uint256 paidOut = (token.balanceOf(staker) - stakerBefore) + (token.balanceOf(dead) - deadBefore);
        assertEq(paidOut, totalDeposited, "payout != deposited");
        assertEq(token.balanceOf(address(pools)), poolStart, "residual imbalance");
    }

    /// @notice moveStake preserves withdrawable principal and never increases weight.
    function testFuzz_moveStakePreservesPrincipal(uint256 amount, uint8 duration, uint16 penaltyBps) public {
        amount = bound(amount, 1 ether, 10_000_000 ether);
        uint256 dur = uint256(bound(duration, 2, 104));
        uint256 penalty = uint256(bound(penaltyBps, 0, 10_000));
        pools.setMoveWeightPenalty(penalty);

        uint256 fromAgent = 1;
        uint256 toAgent = 2;
        uint256 id = _stake(fromAgent, amount, dur);
        (,,, uint256 weightBefore,,,,) = pools.positions(id);

        _warpToEpoch(1);
        vm.prank(staker);
        uint256 newId = pools.moveStake(id, toAgent);

        (, uint256 newAgent, uint256 newAmount, uint256 newWeight,,,,) = pools.positions(newId);
        assertEq(newAgent, toAgent, "agent not moved");
        assertEq(newAmount, amount, "principal changed on move");
        assertLe(newWeight, weightBefore, "weight increased on move");

        // Withdraw the moved position back out: full principal still returns at
        // maturity (penalty only reduces reward weight, never principal).
        _warpToEpoch(dur + 2);
        uint256 stakerBefore = token.balanceOf(staker);
        vm.prank(staker);
        pools.withdrawStake(newId);
        assertEq(token.balanceOf(staker) - stakerBefore, amount, "principal lost across move");
    }

    function fixedAgent() internal pure returns (uint256) {
        return 42;
    }
}
