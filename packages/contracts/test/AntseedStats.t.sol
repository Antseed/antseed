// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../stats/AntseedStats.sol";
import "../core/AntseedRegistry.sol";
import "./mocks/MockERC8004Registry.sol";

contract AntseedStatsTest is Test {
    AntseedRegistry public registry;
    MockERC8004Registry public identityRegistry;
    AntseedStats public stats;

    address public tokenOwner = address(0x1);
    address public writer = address(0x2);
    address public buyer = address(0x3);

    uint256 public tokenId;

    function setUp() public {
        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        stats = new AntseedStats();
        registry.setIdentityRegistry(address(identityRegistry));

        vm.prank(tokenOwner);
        tokenId = identityRegistry.register();
    }

    function test_recordMetadata_tracksBuyerScopedDeltas() public {
        stats.setWriter(writer, true);

        vm.prank(writer);
        stats.recordMetadata(tokenId, buyer, bytes32("chan-1"), abi.encode(uint256(1), uint256(100), uint256(40), uint256(2)));

        vm.prank(writer);
        stats.recordMetadata(tokenId, buyer, bytes32("chan-1"), abi.encode(uint256(1), uint256(175), uint256(90), uint256(5)));

        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(tokenId, buyer);
        assertEq(buyerStats.totalInputTokens, 175);
        assertEq(buyerStats.totalOutputTokens, 90);
        assertEq(buyerStats.totalRequestCount, 5);
        assertGt(buyerStats.lastUpdatedAt, 0);
    }

    function test_recordMetadata_revert_notAuthorized() public {
        vm.expectRevert();
        stats.recordMetadata(tokenId, buyer, bytes32("chan-1"), abi.encode(uint256(1), uint256(100), uint256(40), uint256(2)));
    }

    function test_recordMetadata_skipsNonMonotonicPerChannel() public {
        stats.setWriter(writer, true);

        vm.prank(writer);
        stats.recordMetadata(tokenId, buyer, bytes32("chan-1"), abi.encode(uint256(1), uint256(100), uint256(40), uint256(2)));

        // Non-monotonic update is silently ignored
        vm.prank(writer);
        stats.recordMetadata(tokenId, buyer, bytes32("chan-1"), abi.encode(uint256(1), uint256(90), uint256(10), uint256(1)));

        // Stats unchanged from first call
        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(tokenId, buyer);
        assertEq(buyerStats.totalInputTokens, 100);
        assertEq(buyerStats.totalOutputTokens, 40);
        assertEq(buyerStats.totalRequestCount, 2);
    }

    function test_recordMetadata_accumulatesAcrossChannels() public {
        stats.setWriter(writer, true);

        vm.prank(writer);
        stats.recordMetadata(tokenId, buyer, bytes32("chan-1"), abi.encode(uint256(1), uint256(100), uint256(40), uint256(2)));

        vm.prank(writer);
        stats.recordMetadata(tokenId, buyer, bytes32("chan-2"), abi.encode(uint256(1), uint256(175), uint256(90), uint256(5)));

        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(tokenId, buyer);
        assertEq(buyerStats.totalInputTokens, 275);
        assertEq(buyerStats.totalOutputTokens, 130);
        assertEq(buyerStats.totalRequestCount, 7);
    }

    function test_recordMetadata_revert_invalidShape() public {
        stats.setWriter(writer, true);

        vm.prank(writer);
        vm.expectRevert();
        stats.recordMetadata(tokenId, buyer, bytes32("chan-1"), abi.encode(uint256(100), uint256(40), uint256(2)));
    }

    function test_recordMetadata_acceptsTrailingFields() public {
        stats.setWriter(writer, true);

        vm.prank(writer);
        stats.recordMetadata(
            tokenId,
            buyer,
            bytes32("chan-1"),
            abi.encode(uint256(1), uint256(100), uint256(40), uint256(2), uint256(999))
        );

        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(tokenId, buyer);
        assertEq(buyerStats.totalInputTokens, 100);
        assertEq(buyerStats.totalOutputTokens, 40);
        assertEq(buyerStats.totalRequestCount, 2);
    }
}
