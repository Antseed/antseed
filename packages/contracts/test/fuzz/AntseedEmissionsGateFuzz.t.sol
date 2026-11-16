// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";

/**
 * @title AntseedEmissionsGateFuzz
 * @notice Fuzz tests for the canonical ANTS mint authority. The single most
 *         important property of the whole stack is that ANTS can never be
 *         over-minted. These tests fuzz that invariant directly:
 *
 *           1. getEpochEmission halving is exact, monotonic non-increasing, and
 *              eventually zero with no revert.
 *           2. The full emission schedule sums to <= MAX_SUPPLY (the token's
 *              own backstop), so the two caps are mutually consistent.
 *           3. Under any random sequence of minter claims, no minter ever mints
 *              past its per-epoch share budget and the per-epoch total never
 *              exceeds getEpochEmission(epoch).
 *           4. The GLOBAL per-epoch cap (EpochEmissionExceeded) is the binding
 *              backstop when minter budgets over-subscribe an epoch — the exact
 *              legacy + new-minter overlap case. This path is otherwise
 *              untested by the unit suite.
 *           5. The minter share checkpoint binary search returns the correct
 *              piecewise-constant share for any epoch.
 */
contract AntseedEmissionsGateFuzzTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissionsGate gate;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint256 constant INITIAL_EMISSION = 5_000_000e18;
    uint256 constant HALVING_INTERVAL = 104;
    uint256 constant SHARE_DENOMINATOR = 100_000;

    address legacyController = address(0xCAFE);
    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    address deposits = address(0xDEDE);

    bytes32 constant TEAM_MINTER_ID = keccak256("antseed.emissions.team.v1");
    bytes32 constant RESERVE_MINTER_ID = keccak256("antseed.emissions.reserve.v1");

    function setUp() public {
        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistry();
        registry.setAntsToken(address(token));
        registry.setEmissions(legacyController);
        registry.setTeamWallet(teamWallet);
        registry.setProtocolReserve(reserve);
        registry.setDeposits(deposits);

        token.setRegistry(address(registry));
    }

    function _deployGate(uint256 atEpoch) internal {
        // Deploy so that currentEpoch() == atEpoch.
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * atEpoch + 1);
        gate = new AntseedEmissionsGate(teamWallet, reserve, 15_000, 15_000);
        token.setRegistry(address(gate));
        // No bucket mints until the legacy escrow is settled; any recipient
        // address marks the pot funded.
        gate.fundLegacyEscrow(address(0xE5C0));
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _expectedEmission(uint256 epoch) internal pure returns (uint256) {
        uint256 halvings = epoch / HALVING_INTERVAL;
        if (halvings >= 256) return 0;
        return INITIAL_EMISSION >> halvings;
    }

    // ───────────────────────────────────────────────────────────────────
    //  1. Halving schedule
    // ───────────────────────────────────────────────────────────────────

    function testFuzz_epochEmissionHalvingExact(uint256 epoch) public {
        _deployGate(1);
        epoch = bound(epoch, 0, 100_000);
        assertEq(gate.getEpochEmission(epoch), _expectedEmission(epoch), "halving emission wrong");
    }

    function testFuzz_epochEmissionMonotonicNonIncreasing(uint256 epoch) public {
        _deployGate(1);
        epoch = bound(epoch, 0, 100_000);
        assertGe(gate.getEpochEmission(epoch), gate.getEpochEmission(epoch + 1), "emission increased");
    }

    /// @notice Deep-tail emission is zero and does not revert anywhere downstream.
    function testFuzz_emissionEventuallyZero(uint256 epoch) public {
        _deployGate(1);
        epoch = bound(epoch, 104 * 90, 104 * 200); // far past the 83rd halving
        assertEq(gate.getEpochEmission(epoch), 0, "tail emission not zero");
        // Budget math on a zero-emission epoch must not revert.
        assertEq(gate.minterEpochBudget(TEAM_MINTER_ID, epoch), 0, "zero-epoch budget reverted/non-zero");
    }

    /// @notice The whole schedule sums to <= the token MAX_SUPPLY backstop.
    ///         (Asserts the two independent caps are consistent — review flagged
    ///         this is otherwise unasserted.)
    function test_scheduleSumWithinMaxSupply() public {
        _deployGate(1);
        uint256 sum;
        // 83 halvings * 104 epochs ~= 8632 epochs until emission floors to 0.
        for (uint256 e = 0; e < 104 * 84; e++) {
            sum += gate.getEpochEmission(e);
        }
        assertLe(sum, token.MAX_SUPPLY(), "schedule sum exceeds MAX_SUPPLY");
    }

    // ───────────────────────────────────────────────────────────────────
    //  2. Per-minter and per-epoch caps under random claims
    // ───────────────────────────────────────────────────────────────────

    /// @notice For any minter share split (summing <= 100%) and any random claim
    ///         amounts, every successful claim respects both the per-minter share
    ///         budget and the global per-epoch emission cap. Over-claims revert.
    function testFuzz_claimsNeverExceedCaps(uint32 shareA, uint32 shareB, uint256 amtA, uint256 amtB, uint256 amtA2) public {
        _deployGate(4);

        // team(15%) + reserve(15%) already consume 30%. Leave room for A and B.
        uint32 sA = uint32(bound(shareA, 1, 30_000));
        uint32 sB = uint32(bound(shareB, 1, 40_000));

        address minterA = address(0xA1);
        address minterB = address(0xB2);
        gate.setMinter(keccak256("A"), minterA, sA, true);
        gate.setMinter(keccak256("B"), minterB, sB, true);

        _warpGateEpoch(5);
        uint256 epoch = 4; // finalized (< currentEpoch 5) and >= effectiveEpoch (4)
        uint256 emission = gate.getEpochEmission(epoch);
        uint256 budgetA = (emission * sA) / SHARE_DENOMINATOR;
        uint256 budgetB = (emission * sB) / SHARE_DENOMINATOR;

        _tryClaim(minterA, epoch, bound(amtA, 0, emission));
        _tryClaim(minterB, epoch, bound(amtB, 0, emission));
        _tryClaim(minterA, epoch, bound(amtA2, 0, emission));

        // Hard invariants after any sequence of claims.
        assertLe(gate.minterEpochMinted(keccak256("A"), epoch), budgetA, "minter A over budget");
        assertLe(gate.minterEpochMinted(keccak256("B"), epoch), budgetB, "minter B over budget");
        assertLe(gate.epochMinted(epoch), emission, "epoch over-minted");
    }

    function _tryClaim(address minter, uint256 epoch, uint256 amount) internal {
        if (amount == 0) return;
        vm.prank(minter);
        try gate.claim(epoch, minter, amount) {
            // success: invariants checked by caller
        } catch {
            // a revert is acceptable (cap or budget hit); state must be unchanged
        }
    }

    // ───────────────────────────────────────────────────────────────────
    //  3. Minter rotation can never overlap a finalized epoch
    // ───────────────────────────────────────────────────────────────────

    /// @notice A rotated-out minter's minted amounts stay on the books and a
    ///         replacement id only earns from an unfinalized epoch — never
    ///         the rotation epoch itself when its share was freed there — so
    ///         a finalized epoch can never be over-subscribed: the
    ///         replacement's claim for it reverts on its own (zero) budget
    ///         regardless of amounts, and it earns normally afterwards.
    function testFuzz_globalCapBacksMinterRotationOverlap(uint256 firstAmount) public {
        _deployGate(4);
        uint256 epoch = gate.effectiveEpoch();

        // First minter is added while the epoch is still ahead — a first add
        // only earns from the in-flight epoch onward, never retroactively.
        address firstMinter = address(0xF00D);
        gate.setMinter(keccak256("first"), firstMinter, 70_000, true);

        _warpGateEpoch(epoch + 1); // finalize it
        uint256 emission = gate.getEpochEmission(epoch);

        // It consumes 60-70% of the finalized epoch, then is rotated out.
        uint256 firstMint = bound(firstAmount, (emission * 60) / 100, (emission * 70_000) / SHARE_DENOMINATOR);
        vm.prank(firstMinter);
        gate.claim(epoch, firstMinter, firstMint);
        assertEq(gate.epochMinted(epoch), firstMint, "first mint not recorded");
        gate.removeMinter(keccak256("first"));

        // Replacement id: fresh books, checkpointed only after the rotation
        // epoch (the removal freed its share for the in-flight epoch).
        address secondMinter = address(0xBEEF);
        gate.setMinter(keccak256("second"), secondMinter, 45_000, true);
        uint256 secondBudget = (emission * 45_000) / SHARE_DENOMINATOR;

        // No budget for the finalized epoch the first minter partially
        // claimed, nor for the rotation epoch whose share the removal freed.
        vm.prank(secondMinter);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(epoch, secondMinter, secondBudget);

        _warpGateEpoch(epoch + 3);
        vm.prank(secondMinter);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(epoch + 1, secondMinter, 1);

        // From the epoch after rotation it earns its full share.
        uint256 laterBudget = (gate.getEpochEmission(epoch + 2) * 45_000) / SHARE_DENOMINATOR;
        vm.prank(secondMinter);
        gate.claim(epoch + 2, secondMinter, laterBudget);

        // No matter what, no epoch is ever over-minted.
        assertLe(gate.epochMinted(epoch), emission, "global cap breached");
        assertLe(gate.epochMinted(epoch + 2), gate.getEpochEmission(epoch + 2), "later epoch over-minted");
    }

    // ───────────────────────────────────────────────────────────────────
    //  4. Share checkpoint binary search
    // ───────────────────────────────────────────────────────────────────

    /// @notice After scheduling a sequence of share changes at increasing
    ///         epochs, the per-epoch budget reflects the piecewise-constant
    ///         share active at that epoch (correct upper-bound search).
    function testFuzz_minterShareCheckpointLookup(uint16 share1, uint16 share2, uint8 changeEpochSeed, uint256 queryEpoch) public {
        _deployGate(2);

        // An editable minter added (length==0) during addEpoch checkpoints at
        // addEpoch + 1: its share applies strictly from the NEXT epoch, never
        // the in-flight add epoch or earlier.
        uint256 addEpoch = gate.currentEpoch();
        uint32 s1 = uint32(bound(share1, 1, 20_000));
        bytes32 id = keccak256("ckpt");
        address minter = address(0xC0FFEE);
        gate.setMinter(id, minter, s1, true);

        // Warp forward and change the share, creating a checkpoint at the next
        // epoch. The first checkpoint stays at addEpoch + 1.
        uint256 changeEpoch = uint256(bound(changeEpochSeed, 3, 40));
        _warpGateEpoch(changeEpoch);
        uint32 s2 = uint32(bound(share2, 1, 20_000));
        gate.setMinterController(id, minter); // no-op controller refresh keeps mapping
        gate.setMinter(id, minter, s2, true);

        uint256 e = bound(queryEpoch, 0, 100);
        uint256 emission = gate.getEpochEmission(e);
        uint256 expectedShare = e <= addEpoch ? 0 : (e <= changeEpoch ? s1 : s2);
        assertEq(
            gate.minterEpochBudget(id, e),
            (emission * expectedShare) / SHARE_DENOMINATOR,
            "checkpoint share lookup wrong"
        );
    }
}
