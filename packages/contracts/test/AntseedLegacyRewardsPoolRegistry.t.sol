// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedLegacyRewardsPoolRegistry } from "../rewards/AntseedLegacyRewardsPoolRegistry.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";

contract MockFullClaimPolicy is IAntseedSellerClaimPolicy {
    function claimableSellerRewards(address, uint256 locked) external pure returns (uint256) {
        return locked;
    }
}

/// @notice The pinned facade exists for one scenario: the deployed
///         AntseedSellerRewardsPool authorizes recordLockedReward against its
///         registry's LIVE emissions() pointer, so the cutover flip
///         (registry.setEmissions -> UsageAccounting) would break every
///         locked-path legacy claim. These tests drive the real pool through
///         that exact sequence.
contract AntseedLegacyRewardsPoolRegistryTest is Test {
    ANTSToken internal token;
    AntseedRegistry internal registry;
    AntseedSellerRewardsPool internal pool;
    AntseedLegacyRewardsPoolRegistry internal facade;

    address internal legacyEmissions = address(0xE1);
    address internal newEmissions = address(0xE2);
    address internal seller = address(0x10);

    function setUp() public {
        token = new ANTSToken();
        registry = new AntseedRegistry();
        registry.setAntsToken(address(token));
        registry.setEmissions(legacyEmissions);
        token.setRegistry(address(registry));

        pool = new AntseedSellerRewardsPool(address(registry));
        facade = new AntseedLegacyRewardsPoolRegistry(legacyEmissions, address(token));
    }

    function test_constructor_revert_zeroAddresses() public {
        vm.expectRevert(AntseedLegacyRewardsPoolRegistry.InvalidAddress.selector);
        new AntseedLegacyRewardsPoolRegistry(address(0), address(token));
        vm.expectRevert(AntseedLegacyRewardsPoolRegistry.InvalidAddress.selector);
        new AntseedLegacyRewardsPoolRegistry(legacyEmissions, address(0));
    }

    function test_pinnedGetters() public view {
        assertEq(facade.emissions(), legacyEmissions);
        assertEq(facade.antsToken(), address(token));
    }

    function test_cutoverBreaksLockedPath_withoutFacade() public {
        registry.setEmissions(newEmissions);

        vm.prank(legacyEmissions);
        vm.expectRevert(AntseedSellerRewardsPool.NotEmissionsContract.selector);
        pool.recordLockedReward(seller, 1 ether);
    }

    function test_facadeKeepsLockedPathWorking_afterCutover() public {
        pool.setRegistry(address(facade));
        registry.setEmissions(newEmissions);

        vm.prank(legacyEmissions);
        pool.recordLockedReward(seller, 1 ether);
        assertEq(pool.lockedRewards(seller), 1 ether);

        // The pinned auth must not transfer to the new emissions endpoint.
        vm.prank(newEmissions);
        vm.expectRevert(AntseedSellerRewardsPool.NotEmissionsContract.selector);
        pool.recordLockedReward(seller, 1 ether);
    }

    function test_claimPaysAntsThroughFacade_afterCutover() public {
        // Legacy mints the locked reward into the pool while it is still the
        // live emissions endpoint (the pre-cutover flow), then the pool is
        // pinned and the network flips.
        vm.startPrank(legacyEmissions);
        token.mint(address(pool), 5 ether);
        pool.recordLockedReward(seller, 5 ether);
        vm.stopPrank();

        pool.setRegistry(address(facade));
        registry.setEmissions(newEmissions);

        pool.setSellerClaimPolicy(address(new MockFullClaimPolicy()));
        token.setTransferWhitelist(address(pool), true);

        vm.prank(seller);
        pool.claim(seller);

        assertEq(token.balanceOf(seller), 5 ether);
        assertEq(pool.lockedRewards(seller), 0);
        assertEq(pool.totalLockedRewards(), 0);
    }
}
