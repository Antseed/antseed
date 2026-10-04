// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../stats/AntseedStatsV2.sol";

contract StatsReferralBinderMock {
    error Nope();

    address public lastBuyer;
    uint256 public lastEpoch;
    uint256 public lastIndex;
    bytes32 public lastR;
    bytes32 public lastVs;
    uint256 public calls;
    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function bindReferral(address buyer, uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs) external {
        if (shouldRevert) revert Nope();
        lastBuyer = buyer;
        lastEpoch = issuedEpoch;
        lastIndex = index;
        lastR = r;
        lastVs = vs;
        calls++;
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

// Fixed invite vector (see AntseedReferralsTest.test_inviteSignatureVector).
bytes32 constant INVITE_VECTOR_R = 0xd802ee5a16750afbabae3b72ff1d3fd4b0e020078f532d083845ef4abd2c8eda;
bytes32 constant INVITE_VECTOR_VS = 0x446c5c2a3057d6654b49e84d192c62a787ff15082d4748ae083e366b78e80755;
bytes32 constant METADATA_VECTOR_HASH = 0x60bd1b80e739efcf89d9cbd9a1c0e8fe9b562dbcbfb8434e12f799cb1d272d1e;

contract AntseedStatsV2Test is Test {
    AntseedStatsV2 public stats;
    StatsReferralBinderMock public binder;
    StatsClientUsageMock public clientUsage;

    address public writer = address(0x2);
    address public buyer = address(0x3);
    bytes32 public clientId = bytes32(uint256(42)); // ERC-8004 agent id of the client
    uint256 public inviteEpoch = 42;
    uint256 public inviteIndex = 7;
    bytes32 public inviteR = bytes32(uint256(0x1234));
    bytes32 public inviteVs = bytes32(uint256(0x5678));
    uint256 public agentId = 7;

    function setUp() public {
        stats = new AntseedStatsV2();
        binder = new StatsReferralBinderMock();
        clientUsage = new StatsClientUsageMock();
        stats.setWriter(writer, true);
        stats.setReferrals(address(binder));
        stats.setAttributionUsage(address(clientUsage));
    }

    /// v3 SpendingAuth metadata: 5 static words + services array (+ optional tail).
    function _v3(uint256 inTok, uint256 outTok, uint256 req, bool withTail) internal view returns (bytes memory) {
        uint256[] memory services = new uint256[](0);
        if (!withTail) return abi.encode(uint256(3), inTok, outTok, req, uint256(0), services);
        return abi.encode(
            uint256(3), inTok, outTok, req, uint256(0), services, clientId, inviteEpoch, inviteIndex, inviteR, inviteVs
        );
    }

    /// FreeUsage v1 metadata: 4 static words + services array (+ optional tail).
    function _free(uint256 inTok, uint256 outTok, uint256 req, bool withTail) internal view returns (bytes memory) {
        uint256[] memory services = new uint256[](1);
        services[0] = 42;
        if (!withTail) return abi.encode(uint256(1), inTok, outTok, req, services);
        return abi.encode(uint256(1), inTok, outTok, req, services, clientId, inviteEpoch, inviteIndex, inviteR, inviteVs);
    }

    function _assertTail(AntseedStatsV2.Attribution memory a) internal view {
        assertEq(a.clientId, clientId);
        assertEq(a.inviteEpoch, inviteEpoch);
        assertEq(a.inviteIndex, inviteIndex);
        assertEq(a.inviteR, inviteR);
        assertEq(a.inviteVs, inviteVs);
    }

    function _assertEmpty(AntseedStatsV2.Attribution memory a) internal pure {
        assertEq(a.clientId, bytes32(0));
        assertEq(a.inviteEpoch, 0);
        assertEq(a.inviteIndex, 0);
        assertEq(a.inviteR, bytes32(0));
        assertEq(a.inviteVs, bytes32(0));
    }

    function test_decodeAttribution_detectsTailOnBothLayouts() public view {
        _assertTail(stats.decodeAttribution(_v3(1, 2, 3, true)));
        _assertTail(stats.decodeAttribution(_free(1, 2, 3, true)));
    }

    function test_decodeAttribution_zeroWithoutTail() public view {
        _assertEmpty(stats.decodeAttribution(_v3(1, 2, 3, false)));
        _assertEmpty(stats.decodeAttribution(_free(1, 2, 3, false)));
        _assertEmpty(stats.decodeAttribution(abi.encode(uint256(1), uint256(1), uint256(2), uint256(3))));
    }

    function test_decodeAttribution_ignoresTheRetiredReferrerTail() public view {
        uint256[] memory services = new uint256[](0);
        bytes memory retired =
            abi.encode(uint256(3), uint256(1), uint256(2), uint256(3), uint256(0), services, address(0xA11CE), clientId);
        _assertEmpty(stats.decodeAttribution(retired));
    }

    /// Fixed vector for packages/protocol: SpendingAuth v3 metadata with the
    /// invite from AntseedReferralsTest.test_inviteSignatureVector.
    function test_attributionTailVector() public view {
        uint256[] memory services = new uint256[](1);
        services[0] = 5;
        bytes memory metadata = abi.encode(
            uint256(3), uint256(1000), uint256(200), uint256(3), uint256(0), services,
            bytes32(uint256(42)), uint256(42), uint256(7), INVITE_VECTOR_R, INVITE_VECTOR_VS
        );
        assertEq(metadata.length, 13 * 32);
        assertEq(uint256(bytes32(this.slice(metadata, 5 * 32, 6 * 32))), 11 * 32); // services offset
        AntseedStatsV2.Attribution memory a = stats.decodeAttribution(metadata);
        assertEq(a.clientId, bytes32(uint256(42)));
        assertEq(a.inviteEpoch, 42);
        assertEq(a.inviteIndex, 7);
        assertEq(a.inviteR, INVITE_VECTOR_R);
        assertEq(a.inviteVs, INVITE_VECTOR_VS);
        assertEq(keccak256(metadata), METADATA_VECTOR_HASH);
    }

    function slice(bytes calldata data, uint256 start, uint256 end) external pure returns (bytes memory) {
        return data[start:end];
    }

    function test_recordMetadata_forwardsReferralAndClient() public {
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _free(100, 40, 2, true));
        assertEq(binder.lastBuyer(), buyer);
        assertEq(binder.lastEpoch(), inviteEpoch);
        assertEq(binder.lastIndex(), inviteIndex);
        assertEq(binder.lastR(), inviteR);
        assertEq(binder.lastVs(), inviteVs);
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

    function test_recordMetadata_forwardsSettlementsItSkipsForStats() public {
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(100, 50, 1, false));
        assertEq(clientUsage.calls(), 1);

        // Non-monotonic counters: no token delta, but Channels still accrues
        // this settlement's points, so the ledger must move its cursor.
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(90, 50, 2, true));
        assertEq(clientUsage.calls(), 2);
        assertEq(clientUsage.lastClient(), 42);
        assertEq(binder.lastBuyer(), buyer);
        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 100);
        assertEq(buyerStats.totalRequestCount, 1);

        // A blob too short for the legacy head is skipped for stats without
        // reverting, and still reported to the ledger with a zero client.
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-2"), abi.encode(uint256(1), uint256(2), uint256(3)));
        assertEq(clientUsage.calls(), 3);
        assertEq(clientUsage.lastClient(), 0);
        buyerStats = stats.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 100);
    }

    function test_recordMetadata_tailWithoutInviteForwardsOnlyTheClient() public {
        inviteR = bytes32(0);
        inviteVs = bytes32(0);
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(100, 40, 2, true));
        assertEq(binder.calls(), 0);
        assertEq(clientUsage.lastClient(), 42);
    }

    function test_recordMetadata_rejectedBindingDoesNotRevert() public {
        binder.setShouldRevert(true);
        vm.expectEmit(true, false, false, true, address(stats));
        emit AntseedStatsV2.InviteForwarded(buyer, inviteEpoch, inviteIndex, false, StatsReferralBinderMock.Nope.selector);
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(100, 40, 2, true));
        IAntseedStats.BuyerMetadataStats memory buyerStats = stats.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 100);
        assertEq(binder.lastBuyer(), address(0));
    }

    function test_recordMetadata_unsetSinksAreNoops() public {
        stats.setReferrals(address(0));
        stats.setAttributionUsage(address(0));
        vm.prank(writer);
        stats.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(100, 40, 2, true));
        assertEq(binder.lastBuyer(), address(0));
        assertEq(clientUsage.calls(), 0);
    }
}
