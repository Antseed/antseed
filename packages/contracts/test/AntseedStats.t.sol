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

contract StatsReferralBinderMock {
    address public lastBuyer;
    address public lastReferrer;
    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function bindReferral(address buyer, address referrer) external {
        if (shouldRevert) revert("nope");
        lastBuyer = buyer;
        lastReferrer = referrer;
    }
}

contract AntseedStatsAttributionTest is Test {
    AntseedStats public stats;
    StatsReferralBinderMock public binder;

    address public writer = address(0x2);
    address public buyer = address(0x3);
    address public referrer = address(0xA11CE);
    bytes32 public clientId = bytes32("antseed-desktop");
    uint256 public agentId = 7;

    function setUp() public {
        stats = new AntseedStats();
        binder = new StatsReferralBinderMock();
        stats.setWriter(writer, true);
        stats.setReferrals(address(binder));
    }

    /// v3 SpendingAuth metadata: 5 static words + services array (+ optional tail).
    function _v3(uint256 inTok, uint256 outTok, uint256 req, bool withTail) internal view returns (bytes memory) {
        uint256[] memory services = new uint256[](0);
        if (!withTail) return abi.encode(uint256(3), inTok, outTok, req, uint256(0), services);
        return abi.encode(uint256(3), inTok, outTok, req, uint256(0), services, referrer, clientId);
    }

    /// FreeUsage v1 metadata: 4 static words + services array (+ optional tail).
    function _free(uint256 inTok, uint256 outTok, uint256 req, bool withTail) internal view returns (bytes memory) {
        uint256[] memory services = new uint256[](1);
        services[0] = 42;
        if (!withTail) return abi.encode(uint256(1), inTok, outTok, req, services);
        return abi.encode(uint256(1), inTok, outTok, req, services, referrer, clientId);
    }

    function test_decodeAttribution_detectsTailOnBothLayouts() public view {
        (address r, bytes32 c) = stats.decodeAttribution(_v3(1, 2, 3, true));
        assertEq(r, referrer);
        assertEq(c, clientId);
        (r, c) = stats.decodeAttribution(_free(1, 2, 3, true));
        assertEq(r, referrer);
        assertEq(c, clientId);
    }

    function test_decodeAttribution_zeroWithoutTail() public view {
        (address r, bytes32 c) = stats.decodeAttribution(_v3(1, 2, 3, false));
        assertEq(r, address(0));
        assertEq(c, bytes32(0));
        (r, c) = stats.decodeAttribution(_free(1, 2, 3, false));
        assertEq(r, address(0));
        assertEq(c, bytes32(0));
        (r, c) = stats.decodeAttribution(abi.encode(uint256(1), uint256(1), uint256(2), uint256(3)));
        assertEq(r, address(0));
        assertEq(c, bytes32(0));
    }

    function test_recordMetadata_forwardsReferralAndTracksClientUsage() public {
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _free(100, 40, 2, true));
        assertEq(binder.lastBuyer(), buyer);
        assertEq(binder.lastReferrer(), referrer);
        assertEq(stats.buyerClient(buyer), clientId);

        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-2"), _v3(50, 10, 1, true));
        AntseedStats.ClientUsageStats memory usage = stats.getClientUsageStats(clientId);
        assertEq(usage.totalInputTokens, 150);
        assertEq(usage.totalOutputTokens, 50);
        assertEq(usage.totalRequestCount, 3);

        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 150);
    }

    function test_recordMetadata_rejectedBindingDoesNotRevert() public {
        binder.setShouldRevert(true);
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(100, 40, 2, true));
        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 100);
        assertEq(binder.lastBuyer(), address(0));
    }

    function test_recordMetadata_noReferralsSinkIsNoop() public {
        stats.setReferrals(address(0));
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(100, 40, 2, true));
        assertEq(binder.lastBuyer(), address(0));
        assertEq(stats.buyerClient(buyer), clientId);
    }
}
