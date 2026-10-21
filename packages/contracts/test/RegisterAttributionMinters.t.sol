// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { IAttributionMintersGate, RegisterAttributionMinters } from "../script/RegisterAttributionMinters.s.sol";

contract RegisterAttributionMintersTest is Test, RegisterAttributionMinters {
    address private verificationWallet = address(0x7E21);
    address private referrals = address(0x8EF);
    address private clientRewards = address(0xC11E);

    AntseedEmissionsGate private gate;

    function setUp() public {
        vm.warp(1_775_728_461 + 3 days);
        gate = new AntseedEmissionsGate(address(0x7EA), address(0x8E5), 15_000, 15_000);
        gate.setMinter(VERIFICATION_MINTER_ID, verificationWallet, 10_000, true);
    }

    function test_splitsVerificationIntoFourFourTwoFromTheNextEpoch() public {
        uint256 epoch = gate.currentEpoch();
        uint32 totalBefore = gate.totalMinterShareBps();
        uint256 verificationBudget = gate.minterEpochBudget(VERIFICATION_MINTER_ID, epoch + 1);

        _register(IAttributionMintersGate(address(gate)), referrals, clientRewards);

        assertEq(gate.totalMinterShareBps(), totalBefore); // carved out of verification, nothing else moves
        (address controller, uint32 share, bool editable) = gate.minters(VERIFICATION_MINTER_ID);
        assertEq(controller, verificationWallet);
        assertEq(share, 4_000);
        assertTrue(editable);
        (controller, share,) = gate.minters(CLIENT_REWARDS_MINTER_ID);
        assertEq(controller, clientRewards);
        assertEq(share, 4_000);
        (controller, share,) = gate.minters(REFERRALS_MINTER_ID);
        assertEq(controller, referrals);
        assertEq(share, 2_000);

        // Builders and verification get the same budget, referrals half of it,
        // and the three sum to the old verification bucket.
        uint256 next = epoch + 1;
        uint256 builders = gate.controllerEpochBudget(clientRewards, next);
        assertEq(gate.minterEpochBudget(VERIFICATION_MINTER_ID, next), builders);
        assertEq(gate.controllerEpochBudget(referrals, next), builders / 2);
        assertApproxEqAbs(builders * 2 + builders / 2, verificationBudget, 2);
        assertEq(gate.controllerEpochBudget(clientRewards, epoch), 0);
    }

    function test_refusesToRunTwiceOrOnAnUnexpectedShare() public {
        _register(IAttributionMintersGate(address(gate)), referrals, clientRewards);
        vm.expectRevert(bytes("unexpected verification share"));
        this.registerExternally();
    }

    function registerExternally() external {
        _register(IAttributionMintersGate(address(gate)), referrals, clientRewards);
    }
}
