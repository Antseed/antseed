// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../stats/AntseedStatsV2.sol";

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

contract StatsClientUsageMock {
    address public lastBuyer;
    uint256 public lastClient;
    uint256 public calls;

    function record(address buyer, uint256 clientAgentId) external {
        lastBuyer = buyer;
        lastClient = clientAgentId;
        calls++;
    }
}

contract AntseedStatsV2Test is Test {
    AntseedStatsV2 public stats;
    StatsReferralBinderMock public binder;
    StatsClientUsageMock public clientUsage;

    address public writer = address(0x2);
    address public buyer = address(0x3);
    address public referrer = address(0xA11CE);
    bytes32 public clientId = bytes32(uint256(42)); // ERC-8004 agent id of the client
    uint256 public agentId = 7;

    function setUp() public {
        stats = new AntseedStatsV2();
        binder = new StatsReferralBinderMock();
        clientUsage = new StatsClientUsageMock();
        stats.setWriter(writer, true);
        stats.setReferrals(address(binder));
        stats.setClientUsage(address(clientUsage));
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

    function test_recordMetadata_forwardsReferralAndClient() public {
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _free(100, 40, 2, true));
        assertEq(binder.lastBuyer(), buyer);
        assertEq(binder.lastReferrer(), referrer);
        assertEq(clientUsage.lastBuyer(), buyer);
        assertEq(clientUsage.lastClient(), 42);

        // A settlement without a tail is still reported (client zero) so the
        // client ledger's cursor stays exact.
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-2"), _v3(50, 10, 1, false));
        assertEq(clientUsage.calls(), 2);
        assertEq(clientUsage.lastClient(), 0);

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

    function test_recordMetadata_unsetSinksAreNoops() public {
        stats.setReferrals(address(0));
        stats.setClientUsage(address(0));
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(100, 40, 2, true));
        assertEq(binder.lastBuyer(), address(0));
        assertEq(clientUsage.calls(), 0);
    }
}
