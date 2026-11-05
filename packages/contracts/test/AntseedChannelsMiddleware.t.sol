// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedClientRewards } from "../emissions/AntseedClientRewards.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { AntseedChannelsMiddleware } from "../payments/AntseedChannelsMiddleware.sol";
import { IAntseedStats } from "../interfaces/IAntseedStats.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { AntseedStats } from "../stats/AntseedStats.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedChannels } from "../payments/AntseedChannels.sol";
import { AntseedDeposits } from "../payments/AntseedDeposits.sol";
import { AntseedFreeUsage } from "../payments/AntseedFreeUsage.sol";
import { AntseedStaking } from "../staking/AntseedStaking.sol";
import { activateChannelsMiddleware } from "../script/ActivateChannelsMiddleware.s.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

contract MiddlewareBinderMock {
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

contract MiddlewareClientRewardsMock {
    address public lastBuyer;
    uint256 public lastClient;
    uint256 public lastPoints;
    uint256 public calls;
    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function creditClientUsage(uint256 clientAgentId, address buyer, uint256 points) external {
        require(!shouldRevert, "nope");
        lastClient = clientAgentId;
        lastBuyer = buyer;
        lastPoints = points;
        calls++;
    }
}

/// Makes the calls of one settlement inside a single call, as AntseedChannels does,
/// so the transient client survives between them under test isolation.
contract MiddlewareChannelsCaller {
    struct Call {
        uint256 agentId;
        address buyer;
        bytes32 channelId;
        bytes metadata;
        bool hasMetadata;
        address seller;
        uint256 delta;
    }

    function settle(AntseedChannelsMiddleware middleware, Call[] calldata calls) external {
        for (uint256 i = 0; i < calls.length; i++) {
            Call calldata c = calls[i];
            if (c.hasMetadata) middleware.recordMetadata(c.agentId, c.buyer, c.channelId, c.metadata);
            middleware.accrueSellerPoints(c.seller, c.delta);
            middleware.accrueBuyerPoints(c.buyer, c.delta);
        }
    }
}

/// Weights buyer points by 3, like a pool weight, and can skip an accrual as a pause does.
contract MiddlewareAccountingMock {
    mapping(address => uint256) private _weighted;
    address public pendingSeller;
    address public lastSeller;
    uint256 public buyerAccruals;
    bool public skip;
    bool public shouldRevert;

    function setSkip(bool value) external {
        skip = value;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function accrueSellerPoints(address seller, uint256) external {
        pendingSeller = seller;
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external {
        require(!shouldRevert, "accounting reverted");
        buyerAccruals++;
        lastSeller = pendingSeller;
        if (!skip) _weighted[buyer] += pointsDelta * 3;
    }

    function buyerUsageTotal(address buyer) external view returns (IAntseedUsageAccounting.BuyerUsage memory usage) {
        usage.weightedPoints = _weighted[buyer];
    }
}

contract MiddlewareRegistryMock {
    address public channels = address(0xC1);
    address public stats;
    address public deposits = address(0xC2);
    address public staking = address(0xC3);
    address public emissions;
    address public antsToken = address(0xC4);
    address public identityRegistry = address(0xC5);
    address public protocolReserve = address(0xC6);
    address public teamWallet = address(0xC7);

    function setStats(address value) external {
        stats = value;
    }

    function setEmissions(address value) external {
        emissions = value;
    }
}

// Fixed invite vector (see AntseedReferralsTest.test_inviteSignatureVector).
bytes32 constant INVITE_VECTOR_R = 0xd802ee5a16750afbabae3b72ff1d3fd4b0e020078f532d083845ef4abd2c8eda;
bytes32 constant INVITE_VECTOR_VS = 0x446c5c2a3057d6654b49e84d192c62a787ff15082d4748ae083e366b78e80755;
bytes32 constant METADATA_VECTOR_HASH = 0x60bd1b80e739efcf89d9cbd9a1c0e8fe9b562dbcbfb8434e12f799cb1d272d1e;

contract AntseedChannelsMiddlewareTest is Test {
    AntseedChannelsMiddleware public middleware;
    MiddlewareRegistryMock public registry;
    MiddlewareAccountingMock public accounting;
    MiddlewareBinderMock public binder;
    MiddlewareClientRewardsMock public clientUsage;
    AntseedStats public liveStats;

    MiddlewareChannelsCaller public caller;
    address public channels;
    address public freeUsage = address(0xF0);
    address public seller = address(0x5E);
    address public buyer = address(0x3);
    bytes32 public clientId = bytes32(uint256(42)); // ERC-8004 agent id of the client
    uint256 public inviteEpoch = 42;
    uint256 public inviteIndex = 7;
    bytes32 public inviteR = bytes32(uint256(0x1234));
    bytes32 public inviteVs = bytes32(uint256(0x5678));
    uint256 public agentId = 7;

    function setUp() public {
        caller = new MiddlewareChannelsCaller();
        channels = address(caller);
        registry = new MiddlewareRegistryMock();
        accounting = new MiddlewareAccountingMock();
        binder = new MiddlewareBinderMock();
        clientUsage = new MiddlewareClientRewardsMock();
        liveStats = new AntseedStats();
        registry.setStats(address(liveStats));
        registry.setEmissions(address(accounting));
        middleware = new AntseedChannelsMiddleware(
            address(registry), address(accounting), address(clientUsage), address(binder), channels, freeUsage
        );
        liveStats.setWriter(address(middleware), true);
    }

    /// One paid settlement, in the order AntseedChannels makes these calls.
    function _settle(bytes32 channelId, bytes memory metadata, uint256 delta) internal {
        caller.settle(middleware, _one(channelId, metadata, true, delta));
    }

    function _one(bytes32 channelId, bytes memory metadata, bool hasMetadata, uint256 delta)
        internal
        view
        returns (MiddlewareChannelsCaller.Call[] memory calls)
    {
        calls = new MiddlewareChannelsCaller.Call[](1);
        calls[0] = MiddlewareChannelsCaller.Call(agentId, buyer, channelId, metadata, hasMetadata, seller, delta);
    }

    /// v3 SpendingAuth metadata: 5 static words + services array (+ optional tail).
    function _v3(uint256 inTok, uint256 outTok, uint256 req, bool withTail) internal view returns (bytes memory) {
        uint256[] memory services = new uint256[](0);
        if (!withTail) return abi.encode(uint256(3), inTok, outTok, req, uint256(0), services);
        return abi.encode(
            uint256(3), inTok, outTok, req, uint256(0), services, clientId, inviteEpoch, inviteIndex, inviteR, inviteVs
        );
    }

    /// v4 SpendingAuth metadata: 7 static words (adds the video counters) + services array (+ optional tail).
    function _v4(uint256 inTok, uint256 outTok, uint256 req, bool withTail) internal view returns (bytes memory) {
        uint256[] memory services = new uint256[](0);
        if (!withTail) return abi.encode(uint256(4), inTok, outTok, req, uint256(0), uint256(0), uint256(0), services);
        return abi.encode(
            uint256(4), inTok, outTok, req, uint256(0), uint256(0), uint256(0), services,
            clientId, inviteEpoch, inviteIndex, inviteR, inviteVs
        );
    }

    /// v5 SpendingAuth metadata: 8 static words (adds input characters) + services array (+ optional tail).
    function _v5(uint256 inTok, uint256 outTok, uint256 req, bool withTail) internal view returns (bytes memory) {
        uint256[] memory services = new uint256[](0);
        if (!withTail) {
            return abi.encode(uint256(5), inTok, outTok, req, uint256(0), uint256(0), uint256(0), uint256(0), services);
        }
        return abi.encode(
            uint256(5), inTok, outTok, req, uint256(0), uint256(0), uint256(0), uint256(0), services,
            clientId, inviteEpoch, inviteIndex, inviteR, inviteVs
        );
    }

    /// FreeUsage v1 metadata: 4 static words + services array (+ optional tail).
    function _free(uint256 inTok, uint256 outTok, uint256 req, bool withTail) internal view returns (bytes memory) {
        uint256[] memory services = new uint256[](1);
        services[0] = 42;
        if (!withTail) return abi.encode(uint256(1), inTok, outTok, req, services);
        return abi.encode(uint256(1), inTok, outTok, req, services, clientId, inviteEpoch, inviteIndex, inviteR, inviteVs);
    }

    function _assertTail(AntseedChannelsMiddleware.Attribution memory a) internal view {
        assertEq(a.clientId, clientId);
        assertEq(a.inviteEpoch, inviteEpoch);
        assertEq(a.inviteIndex, inviteIndex);
        assertEq(a.inviteR, inviteR);
        assertEq(a.inviteVs, inviteVs);
    }

    function _assertEmpty(AntseedChannelsMiddleware.Attribution memory a) internal pure {
        assertEq(a.clientId, bytes32(0));
        assertEq(a.inviteEpoch, 0);
        assertEq(a.inviteIndex, 0);
        assertEq(a.inviteR, bytes32(0));
        assertEq(a.inviteVs, bytes32(0));
    }

    function test_decodeAttribution_detectsTailOnBothLayouts() public view {
        _assertTail(middleware.decodeAttribution(_v4(1, 2, 3, true)));
        _assertTail(middleware.decodeAttribution(_v5(1, 2, 3, true)));
        _assertTail(middleware.decodeAttribution(_v3(1, 2, 3, true)));
        _assertTail(middleware.decodeAttribution(_free(1, 2, 3, true)));
    }

    function test_decodeAttribution_zeroWithoutTail() public view {
        _assertEmpty(middleware.decodeAttribution(_v4(1, 2, 3, false)));
        _assertEmpty(middleware.decodeAttribution(_v5(1, 2, 3, false)));
        _assertEmpty(middleware.decodeAttribution(_v3(1, 2, 3, false)));
        _assertEmpty(middleware.decodeAttribution(_free(1, 2, 3, false)));
        _assertEmpty(middleware.decodeAttribution(abi.encode(uint256(1), uint256(1), uint256(2), uint256(3))));
    }

    function test_decodeAttribution_ignoresTheRetiredReferrerTail() public view {
        uint256[] memory services = new uint256[](0);
        bytes memory retired =
            abi.encode(uint256(3), uint256(1), uint256(2), uint256(3), uint256(0), services, address(0xA11CE), clientId);
        _assertEmpty(middleware.decodeAttribution(retired));
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
        AntseedChannelsMiddleware.Attribution memory a = middleware.decodeAttribution(metadata);
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

    function test_answersStatsAndEmissionsItselfAndTheRestFromTheMainRegistry() public view {
        assertEq(middleware.stats(), address(middleware));
        assertEq(middleware.emissions(), address(middleware));
        assertEq(middleware.channels(), registry.channels());
        assertEq(middleware.deposits(), registry.deposits());
        assertEq(middleware.staking(), registry.staking());
        assertEq(middleware.antsToken(), registry.antsToken());
        assertEq(middleware.identityRegistry(), registry.identityRegistry());
        assertEq(middleware.protocolReserve(), registry.protocolReserve());
        assertEq(middleware.teamWallet(), registry.teamWallet());
    }

    function test_constructorRejectsCollaboratorsWithoutCode() public {
        address none = address(0xDEAD);
        vm.expectRevert(AntseedChannelsMiddleware.InvalidAddress.selector);
        new AntseedChannelsMiddleware(none, address(accounting), address(clientUsage), address(binder), channels, freeUsage);
        vm.expectRevert(AntseedChannelsMiddleware.InvalidAddress.selector);
        new AntseedChannelsMiddleware(address(registry), none, address(clientUsage), address(binder), channels, freeUsage);
        vm.expectRevert(AntseedChannelsMiddleware.InvalidAddress.selector);
        new AntseedChannelsMiddleware(address(registry), address(accounting), none, address(binder), channels, freeUsage);
        vm.expectRevert(AntseedChannelsMiddleware.InvalidAddress.selector);
        new AntseedChannelsMiddleware(address(registry), address(accounting), address(clientUsage), none, channels, freeUsage);
        vm.expectRevert(AntseedChannelsMiddleware.InvalidAddress.selector);
        new AntseedChannelsMiddleware(address(registry), address(accounting), address(clientUsage), address(binder), address(0), freeUsage);
        vm.expectRevert(AntseedChannelsMiddleware.InvalidAddress.selector);
        new AntseedChannelsMiddleware(address(registry), address(accounting), address(clientUsage), address(binder), channels, address(0));
    }

    function test_onlyThePaymentContractsCanCallIn() public {
        vm.expectRevert(AntseedChannelsMiddleware.NotAuthorized.selector);
        middleware.recordMetadata(agentId, buyer, bytes32("chan-1"), _v3(1, 1, 1, true));
        vm.expectRevert(AntseedChannelsMiddleware.NotAuthorized.selector);
        middleware.accrueSellerPoints(seller, 1);
        vm.expectRevert(AntseedChannelsMiddleware.NotAuthorized.selector);
        middleware.accrueBuyerPoints(buyer, 1);
        vm.startPrank(freeUsage);
        vm.expectRevert(AntseedChannelsMiddleware.NotAuthorized.selector);
        middleware.accrueSellerPoints(seller, 1);
        vm.expectRevert(AntseedChannelsMiddleware.NotAuthorized.selector);
        middleware.accrueBuyerPoints(buyer, 1);
        vm.stopPrank();
    }

    function test_creditsTheSettlementsGrowthToItsClientInTheSameCall() public {
        _settle(bytes32("chan-1"), _v3(100, 40, 2, true), 10);
        assertEq(accounting.lastSeller(), seller);
        assertEq(clientUsage.calls(), 1);
        assertEq(clientUsage.lastClient(), 42);
        assertEq(clientUsage.lastBuyer(), buyer);
        assertEq(clientUsage.lastPoints(), 30); // the accounting's weighted points, not the raw delta

        // Only this settlement's growth, even with points already on the buyer.
        _settle(bytes32("chan-2"), _v3(100, 40, 2, true), 5);
        assertEq(clientUsage.lastPoints(), 15);
    }

    function test_eachSettlementCreditsItsOwnClient() public {
        _settle(bytes32("chan-1"), _v3(1, 1, 1, true), 10);
        clientId = bytes32(uint256(43));
        _settle(bytes32("chan-2"), _v3(1, 1, 1, true), 1);
        assertEq(clientUsage.lastClient(), 43);
        assertEq(clientUsage.lastPoints(), 3);
    }

    function test_aSettlementWithoutAClientCreditsNobody() public {
        // Two settlements in one transaction: the old client's must not inherit the first's.
        MiddlewareChannelsCaller.Call[] memory calls = new MiddlewareChannelsCaller.Call[](2);
        calls[0] = _one(bytes32("chan-1"), _v3(1, 1, 1, true), true, 10)[0];
        calls[1] = _one(bytes32("chan-2"), _v3(1, 1, 1, false), true, 10)[0];
        caller.settle(middleware, calls);
        assertEq(clientUsage.calls(), 1);
        assertEq(accounting.buyerAccruals(), 2);
    }

    function test_theClientNeverOutlivesItsSettlement() public {
        // Same transaction, second accrual has no metadata: nothing left to credit.
        MiddlewareChannelsCaller.Call[] memory calls = new MiddlewareChannelsCaller.Call[](2);
        calls[0] = _one(bytes32("chan-1"), _v3(1, 1, 1, true), true, 1)[0];
        calls[1] = _one(bytes32("chan-2"), "", false, 1)[0];
        caller.settle(middleware, calls);
        assertEq(clientUsage.calls(), 1);
        assertEq(accounting.buyerAccruals(), 2);
    }

    function test_noGrowthCreditsNothing() public {
        accounting.setSkip(true); // accounting paused, or the seller's pool has no power
        _settle(bytes32("chan-1"), _v3(1, 1, 1, true), 10);
        assertEq(clientUsage.calls(), 0);
    }

    function test_aFailedCreditDoesNotBlockTheSettlement() public {
        clientUsage.setShouldRevert(true);
        bytes memory metadata = _v3(1, 1, 1, true);
        vm.expectEmit(true, true, false, true, address(middleware));
        emit AntseedChannelsMiddleware.ClientCreditFailed(buyer, 42, 30);
        _settle(bytes32("chan-1"), metadata, 10);
        assertEq(accounting.buyerAccruals(), 1);
    }

    function test_aRevertingAccountingStillReverts() public {
        // Same as Channels calling the accounting directly.
        accounting.setShouldRevert(true);
        vm.expectRevert("accounting reverted");
        vm.prank(channels);
        middleware.accrueBuyerPoints(buyer, 1);
    }

    function test_freeUsageForwardsTheInviteButNoClientOrTokenStats() public {
        vm.prank(freeUsage);
        middleware.recordMetadata(agentId, buyer, bytes32("chan-1"), _free(100, 40, 2, true));
        assertEq(binder.lastBuyer(), buyer);
        assertEq(binder.lastEpoch(), inviteEpoch);
        assertEq(binder.lastIndex(), inviteIndex);
        assertEq(binder.lastR(), inviteR);
        assertEq(binder.lastVs(), inviteVs);
        assertEq(liveStats.getBuyerMetadataStats(agentId, buyer).totalInputTokens, 0);

        // Free usage in the same transaction leaves nothing for a paid accrual.
        vm.prank(channels);
        middleware.accrueBuyerPoints(buyer, 1);
        assertEq(clientUsage.calls(), 0);
    }

    function test_paidMetadataReachesTheLiveStatsOnEveryLayout() public {
        _settle(bytes32("chan-1"), _v3(100, 10, 1, true), 1);
        _settle(bytes32("chan-2"), _v4(100, 10, 1, true), 1);
        _settle(bytes32("chan-3"), _v5(100, 10, 1, true), 1);
        _settle(bytes32("chan-4"), _v5(100, 10, 1, false), 1);
        IAntseedStats.BuyerMetadataStats memory buyerStats = liveStats.getBuyerMetadataStats(agentId, buyer);
        assertEq(buyerStats.totalInputTokens, 400);
        assertEq(buyerStats.totalOutputTokens, 40);
        assertEq(buyerStats.totalRequestCount, 4);
    }

    function test_aRevertingLiveStatsKeepsTheAttribution() public {
        // The live Stats has no overflow guard: fill the buyer's total, then overflow it.
        _settle(bytes32("chan-1"), _v3(type(uint256).max, 1, 1, false), 1);
        _settle(bytes32("chan-2"), _v3(1, 1, 1, true), 1);
        assertEq(clientUsage.lastClient(), 42);
        assertEq(binder.lastBuyer(), buyer);
        assertEq(liveStats.getBuyerMetadataStats(agentId, buyer).totalRequestCount, 1);

        // So does a blob too short for the live Stats to decode.
        _settle(bytes32("chan-3"), abi.encode(uint256(1), uint256(2), uint256(3)), 1);
        assertEq(accounting.buyerAccruals(), 3);
    }

    function test_tailWithoutInviteForwardsOnlyTheClient() public {
        inviteR = bytes32(0);
        inviteVs = bytes32(0);
        _settle(bytes32("chan-1"), _v3(100, 40, 2, true), 1);
        assertEq(binder.calls(), 0);
        assertEq(clientUsage.lastClient(), 42);
    }

    function test_rejectedBindingDoesNotRevert() public {
        binder.setShouldRevert(true);
        bytes memory metadata = _v3(100, 40, 2, true);
        vm.expectEmit(true, false, false, true, address(middleware));
        emit AntseedChannelsMiddleware.InviteForwarded(buyer, inviteEpoch, inviteIndex, false, MiddlewareBinderMock.Nope.selector);
        _settle(bytes32("chan-1"), metadata, 1);
        assertEq(liveStats.getBuyerMetadataStats(agentId, buyer).totalInputTokens, 100);
        assertEq(clientUsage.lastClient(), 42);
    }
}

contract MiddlewareSellerPoolsMock {
    mapping(address => uint256) public agentIdForSeller;

    function setAgent(address seller, uint256 agentId) external {
        agentIdForSeller[seller] = agentId;
    }

    function poolWeightAtEpoch(uint256, uint256) external pure returns (uint256) {
        return 7;
    }
}

/// The real settlement path: AntseedChannels, AntseedUsageAccounting, the live
/// AntseedStats and AntseedClientRewards, wired by the real activation order.
contract AntseedChannelsMiddlewareIntegrationTest is Test {
    uint256 private constant BUYER_PK = 0xA11CE;
    uint256 private constant SELLER_PK = 0xB0B;
    bytes32 private constant SPENDING_AUTH_TYPEHASH =
        keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)");
    bytes32 private constant RESERVE_AUTH_TYPEHASH = keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");
    uint256 private constant USDC = 1_000_000;

    MockUSDC private usdc;
    MockERC8004Registry private identity;
    AntseedRegistry private registry;
    AntseedStaking private staking;
    AntseedDeposits private deposits;
    AntseedChannels private channels;
    AntseedFreeUsage private freeUsage;
    AntseedStats private stats;
    AntseedEmissionsGate private gate;
    AntseedUsageAccounting private accounting;
    AntseedClientRewards private clientRewards;
    AntseedChannelsMiddleware private middleware;
    MiddlewareSellerPoolsMock private pools;
    MiddlewareBinderMock private referrals;

    address private buyer = vm.addr(BUYER_PK);
    address private seller = vm.addr(SELLER_PK);
    address private operator = address(0xAA);
    uint256 private sellerAgent;
    uint256 private desktop;
    uint256 private cli;
    bytes32 private channelId;
    uint256 private cumulative;

    function setUp() public {
        vm.warp(1_775_728_461 + 3 weeks);
        usdc = new MockUSDC();
        identity = new MockERC8004Registry();
        registry = new AntseedRegistry();
        staking = new AntseedStaking(address(usdc), address(registry));
        deposits = new AntseedDeposits(address(usdc));
        channels = new AntseedChannels(address(registry));
        freeUsage = new AntseedFreeUsage(address(registry));
        stats = new AntseedStats();
        gate = new AntseedEmissionsGate(address(0xA11CE), address(0xB0B), 15_000, 15_000);
        pools = new MiddlewareSellerPoolsMock();
        accounting = new AntseedUsageAccounting(address(pools), address(channels), address(gate));
        vm.warp(block.timestamp + 7 days); // past the accounting's first rewarded epoch, as on mainnet
        clientRewards = new AntseedClientRewards(address(gate), address(accounting), address(identity), address(0));
        referrals = new MiddlewareBinderMock();

        registry.setChannels(address(channels));
        registry.setDeposits(address(deposits));
        registry.setStaking(address(staking));
        registry.setIdentityRegistry(address(identity));
        registry.setProtocolReserve(address(0xFEE));
        registry.setStats(address(stats));
        registry.setEmissions(address(accounting));
        deposits.setRegistry(address(registry));
        stats.setWriter(address(channels), true);

        middleware = new AntseedChannelsMiddleware(
            address(registry), address(accounting), address(clientRewards), address(referrals), address(channels), address(freeUsage)
        );
        clientRewards.setRecorder(address(middleware));

        vm.prank(address(0xD1));
        desktop = identity.register();
        vm.prank(address(0xC1));
        cli = identity.register();

        vm.startPrank(seller);
        sellerAgent = identity.register();
        usdc.mint(seller, 10 * USDC);
        usdc.approve(address(staking), 10 * USDC);
        staking.stake(sellerAgent, 10 * USDC);
        vm.stopPrank();
        pools.setAgent(seller, sellerAgent);

        deposits.setCreditLimitOverride(buyer, type(uint256).max);
        uint256 nonce = deposits.getOperatorNonce(buyer);
        bytes32 structHash = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), operator, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash)));
        deposits.setOperator(buyer, operator, nonce, abi.encodePacked(r, s, v));
        usdc.mint(operator, 100 * USDC);
        vm.startPrank(operator);
        usdc.approve(address(deposits), 100 * USDC);
        deposits.deposit(buyer, 100 * USDC);
        vm.stopPrank();

        activateChannelsMiddleware(middleware);

        channels.setFirstSignCap(10 * USDC);

        // Reserving reads staking and deposits through the middleware too.
        bytes32 salt = keccak256("session");
        channelId = channels.computeChannelId(buyer, seller, salt);
        uint256 deadline = block.timestamp + 1 hours;
        structHash = keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, channelId, uint128(10 * USDC), deadline));
        (v, r, s) = vm.sign(BUYER_PK, keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash)));
        vm.prank(seller);
        channels.reserve(buyer, salt, uint128(10 * USDC), deadline, abi.encodePacked(r, s, v));
    }

    function _settle(uint256 client, uint256 delta) private {
        cumulative += delta;
        uint256[] memory services = new uint256[](0);
        bytes memory metadata = abi.encode(
            uint256(3), cumulative, cumulative, cumulative, uint256(0), services,
            bytes32(client), uint256(0), uint256(0), bytes32(0), bytes32(0)
        );
        bytes32 structHash = keccak256(abi.encode(SPENDING_AUTH_TYPEHASH, channelId, cumulative, keccak256(metadata)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash)));
        vm.prank(seller);
        channels.settle(channelId, uint128(cumulative), metadata, abi.encodePacked(r, s, v));
    }

    function test_activationRoutesOnlyThePaymentContracts() public view {
        assertEq(address(channels.registry()), address(middleware));
        assertEq(address(freeUsage.registry()), address(middleware));
        assertEq(registry.emissions(), address(accounting)); // the main registry is untouched
        assertEq(registry.stats(), address(stats));
        assertTrue(accounting.usageRecorders(address(channels))); // kept for rollback
        assertTrue(accounting.usageRecorders(address(middleware)));
    }

    function test_aSettlementCreditsItsClientInTheSameTransaction() public {
        uint256 epoch = gate.currentEpoch();
        _settle(desktop, USDC);
        assertEq(clientRewards.clientEpochPoints(epoch, desktop), USDC * 7); // raw delta times the pool weight
        assertEq(accounting.buyerUsageTotal(buyer).weightedPoints, USDC * 7);
        assertEq(accounting.totalWeightedBuyerPointsByEpoch(epoch), USDC * 7);
        assertEq(accounting.weightedPoolPointsByEpoch(epoch, sellerAgent), USDC * 7); // the seller still earns
        assertEq(stats.getBuyerMetadataStats(sellerAgent, buyer).totalInputTokens, USDC); // token stats too
        assertEq(accounting.pendingSellerAccrual(), address(0));

        _settle(cli, 2 * USDC);
        assertEq(clientRewards.clientEpochPoints(epoch, desktop), USDC * 7);
        assertEq(clientRewards.clientEpochPoints(epoch, cli), 2 * USDC * 7);
        assertEq(accounting.totalWeightedBuyerPointsByEpoch(epoch), 3 * USDC * 7);
    }

    function test_theCreditLandsInTheEpochThatSettledIt() public {
        uint256 epoch = gate.currentEpoch();
        _settle(desktop, USDC);
        vm.warp(block.timestamp + 7 days);
        assertTrue(clientRewards.isClaimable(epoch)); // final, with nothing left to credit
        _settle(desktop, USDC);
        assertEq(clientRewards.clientEpochPoints(epoch, desktop), USDC * 7);
        assertEq(clientRewards.clientEpochPoints(epoch + 1, desktop), USDC * 7);
    }

    function test_noClientAndUnregisteredClientCreditNobodyButStillAccrue() public {
        uint256 epoch = gate.currentEpoch();
        _settle(0, USDC);
        _settle(999, USDC);
        assertEq(clientRewards.clientEpochPoints(epoch, 999), 0);
        assertEq(accounting.buyerUsageTotal(buyer).weightedPoints, 2 * USDC * 7);
    }

    function test_aPausedAccountingStillSettlesAndCreditsNothing() public {
        uint256 epoch = gate.currentEpoch();
        accounting.pause();
        _settle(desktop, USDC);
        assertEq(clientRewards.clientEpochPoints(epoch, desktop), 0);
        (,,, uint128 settled,,,,,) = channels.channels(channelId);
        assertEq(settled, USDC);
    }

    function test_rollbackRestoresTheDirectPath() public {
        uint256 epoch = gate.currentEpoch();
        channels.setRegistry(address(registry));
        freeUsage.setRegistry(address(registry));
        _settle(desktop, USDC);
        assertEq(accounting.buyerUsageTotal(buyer).weightedPoints, USDC * 7);
        assertEq(stats.getBuyerMetadataStats(sellerAgent, buyer).totalInputTokens, USDC);
        assertEq(clientRewards.clientEpochPoints(epoch, desktop), 0);
    }
}
