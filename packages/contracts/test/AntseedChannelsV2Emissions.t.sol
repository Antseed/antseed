// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../payments/AntseedChannels.sol";
import "../payments/AntseedDeposits.sol";
import "../staking/AntseedStaking.sol";
import "./mocks/MockERC8004Registry.sol";
import "./mocks/MockUSDC.sol";
import "../core/AntseedRegistry.sol";
import "../stats/AntseedStats.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";

contract AntseedChannelsV2EmissionsTest is Test {
    MockUSDC public usdc;
    MockERC8004Registry public identityRegistry;
    AntseedRegistry public antseedRegistry;
    AntseedStats public externalStats;
    AntseedStaking public staking;
    AntseedDeposits public deposits;
    AntseedChannels public channels;
    AntseedEmissions public legacyEmissions;
    AntseedEmissionsV2 public emissionsV2;
    AntseedSellerRewardsPool public rewardsPool;

    // Deterministic private keys
    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant SELLER_PK = 0xB0B;
    uint256 constant RANDOM_PK = 0xDEAD;

    address public buyer;
    address public seller;
    address public randomUser;
    address public protocolReserve = address(0xFEE);
    address public buyerOperator = address(0xAA);

    // USDC amounts (6 decimals)
    uint128 constant USDC_100 = 100_000_000;
    uint128 constant USDC_50 = 50_000_000;
    uint128 constant USDC_30 = 30_000_000;
    uint128 constant USDC_60 = 60_000_000;
    uint128 constant USDC_10 = 10_000_000;
    uint128 constant USDC_150 = 150_000_000;

    uint256 constant STAKE_AMOUNT = 10_000_000; // MIN_SELLER_STAKE

    // AntSeed EIP-712 typehashes (must match contract)
    bytes32 constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );
    bytes32 constant RESERVE_AUTH_TYPEHASH = keccak256(
        "ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)"
    );

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);
        randomUser = vm.addr(RANDOM_PK);

        // Deploy contracts
        usdc = new MockUSDC();
        identityRegistry = new MockERC8004Registry();
        antseedRegistry = new AntseedRegistry();
        staking = new AntseedStaking(address(usdc), address(antseedRegistry));
        deposits = new AntseedDeposits(address(usdc));
        channels = new AntseedChannels(address(antseedRegistry));
        externalStats = new AntseedStats();

        // Wire registry
        antseedRegistry.setChannels(address(channels));
        antseedRegistry.setDeposits(address(deposits));
        antseedRegistry.setStaking(address(staking));
        antseedRegistry.setIdentityRegistry(address(identityRegistry));
        antseedRegistry.setProtocolReserve(protocolReserve);

        legacyEmissions = new AntseedEmissions(address(antseedRegistry), 1000 ether, 1 weeks);
        antseedRegistry.setEmissions(address(legacyEmissions));
        vm.prank(address(channels));
        legacyEmissions.accrueSellerPoints(address(0xDEAD), 0);
        vm.prank(address(channels));
        legacyEmissions.accrueBuyerPoints(address(0xBEEF), 0);
        rewardsPool = new AntseedSellerRewardsPool(address(antseedRegistry));
        emissionsV2 = new AntseedEmissionsV2(address(antseedRegistry), address(legacyEmissions), address(rewardsPool));
        antseedRegistry.setEmissions(address(emissionsV2));

        // Set registry on contracts that need it
        deposits.setRegistry(address(antseedRegistry));

        // Raise FIRST_SIGN_CAP for tests that need large reservations
        channels.setFirstSignCap(500_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        HELPERS
    // ═══════════════════════════════════════════════════════════════════

    function createBuyer(uint256 pk, uint256 depositAmount) internal {
        address addr = vm.addr(pk);

        // Register on MockERC8004Registry
        vm.prank(addr);
        identityRegistry.register();

        deposits.setCreditLimitOverride(addr, type(uint256).max);

        // Set operator via EIP-712 signature
        uint256 nonce = deposits.getOperatorNonce(addr);
        bytes32 structHash = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), buyerOperator, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        deposits.setOperator(addr, buyerOperator, nonce, abi.encodePacked(r, s, v));

        // Operator deposits USDC
        usdc.mint(buyerOperator, depositAmount);
        vm.startPrank(buyerOperator);
        usdc.approve(address(deposits), depositAmount);
        deposits.deposit(addr, depositAmount);
        vm.stopPrank();
    }

    function createSeller(uint256 pk) internal {
        address addr = vm.addr(pk);

        // Register on MockERC8004Registry and stake with agentId
        vm.prank(addr);
        uint256 agentId = identityRegistry.register();

        usdc.mint(addr, STAKE_AMOUNT);
        vm.startPrank(addr);
        usdc.approve(address(staking), STAKE_AMOUNT);
        staking.stake(agentId, STAKE_AMOUNT);
        vm.stopPrank();
    }

    /**
     * @dev Sign an AntSeed SpendingAuth (our EIP-712 domain, version "7")
     */
    function signSpendingAuth(
        uint256 pk,
        bytes32 channelId,
        uint256 cumulativeAmount,
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens
    ) internal view returns (bytes memory) {
        bytes32 metadataHash = keccak256(abi.encode(METADATA_VERSION, cumulativeInputTokens, cumulativeOutputTokens, uint256(0)));
        bytes32 structHash = keccak256(
            abi.encode(
                SPENDING_AUTH_TYPEHASH,
                channelId,
                cumulativeAmount,
                metadataHash
            )
        );
        bytes32 digest = _hashTypedDataChannels(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev Sign an AntSeed ReserveAuth (our EIP-712 domain, version "7")
     */
    function signReserveAuth(
        uint256 pk,
        bytes32 channelId,
        uint128 maxAmount,
        uint256 deadline
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                RESERVE_AUTH_TYPEHASH,
                channelId,
                maxAmount,
                deadline
            )
        );
        bytes32 digest = _hashTypedDataChannels(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    uint256 constant METADATA_VERSION = 1;

    function encodeMetadata(
        uint256 cumulativeInputTokens,
        uint256 cumulativeOutputTokens
    ) internal pure returns (bytes memory) {
        return abi.encode(METADATA_VERSION, cumulativeInputTokens, cumulativeOutputTokens, uint256(0));
    }

    function _hashTypedDataChannels(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
    }

    function _hashTypedDataDeposits(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
    }

    /**
     * @dev Compute the channelId: keccak256(abi.encode(buyer, seller, salt))
     */
    function computeChannelId(bytes32 salt) internal view returns (bytes32) {
        return channels.computeChannelId(buyer, seller, salt);
    }

    /**
     * @dev Full reserve helper: creates buyer+seller, computes channelId, signs, reserves.
     */
    function doReserve(
        bytes32 salt,
        uint128 maxAmount,
        uint256 buyerDeposit
    ) internal returns (bytes32 channelId) {
        createBuyer(BUYER_PK, buyerDeposit);
        createSeller(SELLER_PK);

        channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, maxAmount, deadline);

        vm.prank(seller);
        channels.reserve(buyer, salt, maxAmount, deadline, reserveSig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   RESERVE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_reserve_newChannel() public {
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Assert channel state
        (
            address sBuyer,
            address sSeller,
            uint128 sDeposit,
            uint128 sSettled,
            ,
            uint256 sDeadline,
            uint256 sSettledAt,
            ,
            AntseedChannels.ChannelStatus sStatus
        ) = channels.channels(channelId);

        assertEq(sBuyer, buyer);
        assertEq(sSeller, seller);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, 0);
        assertGt(sDeadline, 0);
        assertEq(sSettledAt, 0);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);

        // USDC stays in Deposits (locked via reserved)
        assertEq(usdc.balanceOf(address(channels)), 0);
        assertEq(usdc.balanceOf(address(deposits)), USDC_100);

        // Assert buyer's Deposits: reserved = maxAmount, available = 0
        (uint256 available, uint256 reserved,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, USDC_100);
        assertEq(available, 0); // all 100 USDC reserved in Deposits
    }

    function test_reserve_revert_sellerNotStaked() public {
        createBuyer(BUYER_PK, USDC_100);
        // Register seller but don't stake
        vm.prank(seller);
        identityRegistry.register();

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.SellerNotStaked.selector);
        channels.reserve(buyer, salt, USDC_50, deadline, reserveSig);
    }

    function test_reserve_revert_expiredDeadline() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 pastDeadline = block.timestamp - 1;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, pastDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelExpired.selector);
        channels.reserve(buyer, salt, USDC_50, pastDeadline, reserveSig);
    }

    function test_reserve_revert_invalidSignature() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        // Sign with wrong key
        bytes memory badSig = signReserveAuth(RANDOM_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.reserve(buyer, salt, USDC_50, deadline, badSig);
    }

    function test_reserve_revert_firstSignCapExceeded() public {
        channels.setFirstSignCap(1_000_000);

        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        uint128 overCap = 1_000_001;
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, overCap, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.FirstSignCapExceeded.selector);
        channels.reserve(buyer, salt, overCap, deadline, reserveSig);
    }

    function test_reserve_revert_channelExists() public {
        bytes32 salt = keccak256("session-1");
        bytes32 channelId = doReserve(salt, USDC_50, USDC_100);

        // Try to reserve again with same salt (same channelId)
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_30, deadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelExists.selector);
        channels.reserve(buyer, salt, USDC_30, deadline, reserveSig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   CLOSE TESTS (final settle)
    // ═══════════════════════════════════════════════════════════════════

    function test_close_partialAmount() public {
        bytes32 salt = keccak256("session-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 finalAmount = USDC_60;
        uint256 inputTokens = 5000;
        uint256 outputTokens = 2000;

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, inputTokens, outputTokens);

        vm.prank(seller);
        channels.close(channelId, finalAmount, encodeMetadata(inputTokens, outputTokens), metaSig);

        // Assert channel state
        (
            ,
            ,
            ,
            uint128 sSettled,
            ,
            ,
            uint256 sSettledAt,
            ,
            AntseedChannels.ChannelStatus sStatus
        ) = channels.channels(channelId);

        assertTrue(sStatus == AntseedChannels.ChannelStatus.Settled);
        assertEq(sSettled, USDC_60);
        assertGt(sSettledAt, 0);

        // Platform fee = 60 * 200 / 10000 = 3 USDC
        uint256 platformFee = (uint256(USDC_60) * 200) / 10000;
        uint256 sellerPayout = uint256(USDC_60) - platformFee;
        assertEq(usdc.balanceOf(seller), sellerPayout);

        // Protocol reserve got the fee
        assertEq(usdc.balanceOf(protocolReserve), platformFee);

        // Buyer: refund of 40 USDC credited back
        (uint256 available, uint256 reserved,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 0);
        assertEq(available, USDC_100 - USDC_100 + (USDC_100 - USDC_60)); // 0 + 40 = 40

        // Stats updated
        uint256 sellerAgentId = staking.getAgentId(seller);
        AntseedChannels.AgentStats memory s = channels.getAgentStats(sellerAgentId);
        assertEq(s.channelCount, 1);
        assertEq(s.totalVolumeUsdc, USDC_60);
    }

    function test_close_fullDeposit() public {
        bytes32 salt = keccak256("session-close-full");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 finalAmount = USDC_100;
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, 10000, 5000);

        vm.prank(seller);
        channels.close(channelId, finalAmount, encodeMetadata(10000, 5000), metaSig);

        (,,,uint128 sSettled,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertEq(sSettled, USDC_100);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Settled);

        // Buyer should have 0 available (no refund)
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 0);
    }

    function test_close_zeroAmount() public {
        bytes32 salt = keccak256("session-close-zero");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Close with 0 — full refund to buyer
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, 0, 0, 0);

        vm.prank(seller);
        channels.close(channelId, 0, encodeMetadata(0, 0), metaSig);

        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);

        assertEq(usdc.balanceOf(seller), 0);
    }

    function test_close_revert_notSeller() public {
        bytes32 salt = keccak256("session-close-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, USDC_60, 0, 0);

        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.close(channelId, USDC_60, encodeMetadata(0, 0), metaSig);
    }

    function test_close_revert_invalidMetadataSignature() public {
        bytes32 salt = keccak256("session-close-badsig");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Sign metadata with wrong key
        bytes memory badMetaSig = signSpendingAuth(RANDOM_PK, channelId, USDC_60, 0, 0);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.close(channelId, USDC_60, encodeMetadata(0, 0), badMetaSig);
    }

    function test_close_revert_doubleClose() public {
        bytes32 salt = keccak256("session-double-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, USDC_60, 0, 0);

        vm.prank(seller);
        channels.close(channelId, USDC_60, encodeMetadata(0, 0), metaSig);

        // Try again — channel already Settled
        bytes memory metaSig2 = signSpendingAuth(BUYER_PK, channelId, USDC_30, 0, 0);
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelNotActive.selector);
        channels.close(channelId, USDC_30, encodeMetadata(0, 0), metaSig2);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   SETTLE TESTS (mid-channel)
    // ═══════════════════════════════════════════════════════════════════

    function test_settle_midChannel() public {
        bytes32 salt = keccak256("session-settle");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 amount1 = USDC_30;
        bytes memory metaSig1 = signSpendingAuth(BUYER_PK, channelId, amount1, 1000, 500);

        vm.prank(seller);
        channels.settle(channelId, amount1, encodeMetadata(1000, 500), metaSig1);

        // Channel still active
        (,, uint128 sDeposit, uint128 sSettled,,,,, AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
        assertEq(sDeposit, USDC_100);
        assertEq(sSettled, USDC_30);

        // Seller payouts credited for first settle
        uint256 fee1 = (uint256(USDC_30) * 200) / 10000;
        uint256 payout1 = uint256(USDC_30) - fee1;
        assertEq(usdc.balanceOf(seller), payout1);
    }

    function test_settle_thenClose() public {
        bytes32 salt = keccak256("session-settle-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // First settle: 30 USDC
        uint128 amount1 = USDC_30;
        bytes memory metaSig1 = signSpendingAuth(BUYER_PK, channelId, amount1, 1000, 500);

        vm.prank(seller);
        channels.settle(channelId, amount1, encodeMetadata(1000, 500), metaSig1);

        // Then close: final cumulative = 60 USDC
        uint128 finalAmount = USDC_60;
        bytes memory metaSig2 = signSpendingAuth(BUYER_PK, channelId, finalAmount, 3000, 1500);

        vm.prank(seller);
        channels.close(channelId, finalAmount, encodeMetadata(3000, 1500), metaSig2);

        // Channel settled
        (,,,uint128 sSettled,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Settled);
        assertEq(sSettled, USDC_60);

        // Total seller payouts = payout from 30 (settle) + payout from delta 30 (close)
        // Each delta of 30 has its own fee: 30 * 500/10000 = 1.5 USDC per delta
        uint256 fee30 = (uint256(USDC_30) * 200) / 10000;
        uint256 expectedPayouts = (uint256(USDC_30) - fee30) * 2; // two deltas of 30
        assertEq(usdc.balanceOf(seller), expectedPayouts);

        // Buyer refund = 100 - 60 = 40
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100 - USDC_60);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   TIMEOUT TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_requestClose_and_withdraw() public {
        bytes32 salt = keccak256("session-close-req");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Operator can request close anytime — no deadline dependency
        vm.prank(buyerOperator);
        channels.requestClose(channelId);

        // Can't withdraw yet — need to wait for grace period (15 min)
        vm.prank(buyerOperator);
        vm.expectRevert(AntseedChannels.CloseNotReady.selector);
        channels.withdraw(channelId);

        // Warp past grace period
        vm.warp(block.timestamp + 15 minutes + 1);

        // Operator can withdraw after grace period
        vm.prank(buyerOperator);
        channels.withdraw(channelId);

        // Channel timed out (withdrawn)
        (,,,,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.TimedOut);

        // Full deposit returned to buyer
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);
    }

    function test_requestClose_revert_notBuyer() public {
        bytes32 salt = keccak256("session-close-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Seller can't request close
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(channelId);

        // Random user can't request close
        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(channelId);
    }

    function test_requestClose_revert_alreadyRequested() public {
        bytes32 salt = keccak256("session-close-dup");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        vm.prank(buyerOperator);
        channels.requestClose(channelId);

        vm.prank(buyerOperator);
        vm.expectRevert(AntseedChannels.CloseAlreadyRequested.selector);
        channels.requestClose(channelId);
    }

    function test_withdraw_revert_notOperator() public {
        bytes32 salt = keccak256("session-withdraw-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        vm.prank(buyerOperator);
        channels.requestClose(channelId);

        vm.warp(block.timestamp + 15 minutes + 1);

        // Seller can't withdraw
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.withdraw(channelId);
    }

    function test_withdraw_revert_withoutRequestClose() public {
        bytes32 salt = keccak256("session-withdraw-no-req");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // withdraw without calling requestClose first
        vm.prank(buyerOperator);
        vm.expectRevert(AntseedChannels.CloseNotReady.selector);
        channels.withdraw(channelId);
    }

    function test_sellerCanStillCloseDuringGracePeriod() public {
        bytes32 salt = keccak256("session-grace-settle");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Operator requests close
        vm.prank(buyerOperator);
        channels.requestClose(channelId);

        // Seller can still close with a SpendingAuth during grace period
        uint128 finalAmount = USDC_60;
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, 5000, 2000);

        vm.prank(seller);
        channels.close(channelId, finalAmount, encodeMetadata(5000, 2000), metaSig);

        (,,,uint128 sSettled,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Settled);
        assertEq(sSettled, USDC_60);

        // Buyer gets refund of 40 USDC
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100 - USDC_60);
    }

    function test_sellerCanSettleDuringGracePeriod() public {
        bytes32 salt = keccak256("session-grace-mid");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Operator requests close
        vm.prank(buyerOperator);
        channels.requestClose(channelId);

        // Seller can still settle mid-channel during grace period
        uint128 amount = USDC_30;
        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, amount, 1000, 500);

        vm.prank(seller);
        channels.settle(channelId, amount, encodeMetadata(1000, 500), metaSig);

        (,,, uint128 sSettled,,,,, AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
        assertEq(sSettled, USDC_30);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   PLATFORM FEE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_close_platformFeeCalculation() public {
        bytes32 salt = keccak256("session-fee");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint128 chargeAmount = USDC_60;
        uint256 expectedPlatformFee = (uint256(chargeAmount) * 200) / 10000; // 3 USDC
        uint256 expectedSellerPayout = uint256(chargeAmount) - expectedPlatformFee; // 57 USDC

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, chargeAmount, 0, 0);

        vm.prank(seller);
        channels.close(channelId, chargeAmount, encodeMetadata(0, 0), metaSig);

        assertEq(usdc.balanceOf(seller), expectedSellerPayout);
        assertEq(usdc.balanceOf(protocolReserve), expectedPlatformFee);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   STATS TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_close_statsUpdate() public {
        bytes32 salt = keccak256("session-rep");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        uint256 inputToks = 7500;
        uint256 outputToks = 3200;

        bytes memory metaSig = signSpendingAuth(BUYER_PK, channelId, USDC_50, inputToks, outputToks);

        vm.prank(seller);
        channels.close(channelId, USDC_50, encodeMetadata(inputToks, outputToks), metaSig);

        uint256 sellerAgentId = staking.getAgentId(seller);
        AntseedChannels.AgentStats memory s = channels.getAgentStats(sellerAgentId);
        assertEq(s.channelCount, 1);
        assertEq(s.totalVolumeUsdc, USDC_50);
    }

    function test_settle_writesExternalMetadataWhenConfiguredAndAuthorized() public {
        bytes32 salt = keccak256("session-ext-meta");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);
        uint256 sellerAgentId = staking.getAgentId(seller);

        antseedRegistry.setStats(address(externalStats));
        externalStats.setWriter(address(channels), true);

        bytes memory sig1 = signSpendingAuth(BUYER_PK, channelId, USDC_30, 4000, 1500);
        vm.prank(seller);
        channels.settle(channelId, USDC_30, encodeMetadata(4000, 1500), sig1);

        IAntseedStats.BuyerMetadataStats memory midStats = externalStats.getBuyerMetadataStats(sellerAgentId, buyer);
        assertEq(midStats.totalInputTokens, 4000);
        assertEq(midStats.totalOutputTokens, 1500);
        assertEq(midStats.totalRequestCount, 0);

        bytes memory sig2 = signSpendingAuth(BUYER_PK, channelId, USDC_60, 9000, 3500);
        vm.prank(seller);
        channels.close(channelId, USDC_60, encodeMetadata(9000, 3500), sig2);

        IAntseedStats.BuyerMetadataStats memory stats = externalStats.getBuyerMetadataStats(sellerAgentId, buyer);
        assertEq(stats.totalInputTokens, 9000);
        assertEq(stats.totalOutputTokens, 3500);
        assertEq(stats.totalRequestCount, 0);
        assertGt(stats.lastUpdatedAt, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   ADMIN TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_setFirstSignCap() public {
        channels.setFirstSignCap(2_000_000);
        assertEq(channels.FIRST_SIGN_CAP(), 2_000_000);
    }

    function test_setPlatformFeeBps() public {
        channels.setPlatformFeeBps(300);
        assertEq(channels.PLATFORM_FEE_BPS(), 300);
    }

    function test_setPlatformFeeBps_revert_aboveMax() public {
        vm.expectRevert(AntseedChannels.InvalidFee.selector);
        channels.setPlatformFeeBps(1001);
    }

    function test_setRegistry() public {
        AntseedRegistry newReg = new AntseedRegistry();
        channels.setRegistry(address(newReg));
        assertEq(address(channels.registry()), address(newReg));
    }

    function test_setRegistry_revert_zeroAddress() public {
        vm.expectRevert(AntseedChannels.InvalidAddress.selector);
        channels.setRegistry(address(0));
    }

    function test_setRegistry_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        channels.setRegistry(address(0x1234));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   PAUSE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_pause_blocksReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        channels.pause();

        bytes32 salt = keccak256("session-paused");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        vm.expectRevert();
        channels.reserve(buyer, salt, USDC_50, deadline, reserveSig);
    }

    function test_unpause_allowsReserve() public {
        createBuyer(BUYER_PK, USDC_100);
        createSeller(SELLER_PK);

        channels.pause();
        channels.unpause();

        bytes32 salt = keccak256("session-unpaused");
        bytes32 channelId = computeChannelId(salt);
        uint256 deadline = block.timestamp + 1 hours;

        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_50, deadline);

        vm.prank(seller);
        channels.reserve(buyer, salt, USDC_50, deadline, reserveSig);

        (,,,,,,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
    }

    function test_pause_revert_notOwner() public {
        vm.prank(randomUser);
        vm.expectRevert();
        channels.pause();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   TOP UP TESTS
    // ═══════════════════════════════════════════════════════════════════

    function test_topUp_settlesInlineAndLocks() public {
        bytes32 salt = keccak256("session-topup");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Top up with inline settle of 85 USDC (85% threshold met)
        uint128 settleAmount = 85_000_000;
        bytes memory spendingSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);

        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        channels.topUp(channelId, settleAmount, encodeMetadata(5000, 2000), spendingSig, newMax, newDeadline, reserveSig);

        // Verify channel state updated
        (,, uint128 sDeposit, uint128 sSettled,,uint256 sDeadline,,,AntseedChannels.ChannelStatus sStatus) = channels.channels(channelId);
        assertTrue(sStatus == AntseedChannels.ChannelStatus.Active);
        assertEq(sDeposit, USDC_150);
        assertEq(sSettled, settleAmount);
        assertEq(sDeadline, newDeadline);

        // reserved = 100 - 85 (settle freed) + 50 (topUp locked) = 65
        (, uint256 reserved,) = deposits.getBuyerBalance(buyer);
        assertEq(reserved, 65_000_000);

        // Seller received 85 USDC minus platform fee directly
        uint256 platformFee = (uint256(settleAmount) * 200) / 10000;
        assertEq(usdc.balanceOf(seller), settleAmount - platformFee);
    }

    function test_topUp_revert_thresholdNotMet() public {
        bytes32 salt = keccak256("session-topup-fail");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Only settle 50% (50 USDC out of 100) — below 85% threshold
        uint128 settleAmount = USDC_50;
        bytes memory spendingSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 3000, 1000);

        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.TopUpThresholdNotMet.selector);
        channels.topUp(channelId, settleAmount, encodeMetadata(3000, 1000), spendingSig, newMax, newDeadline, reserveSig);
    }

    function test_topUp_revert_newAmountNotHigher() public {
        bytes32 salt = keccak256("session-topup-low");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Settle 90%
        uint128 settleAmount = 90_000_000;
        bytes memory spendingSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);

        // Try topUp with same ceiling — should revert
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, USDC_100, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.TopUpAmountTooLow.selector);
        channels.topUp(channelId, settleAmount, encodeMetadata(5000, 2000), spendingSig, USDC_100, newDeadline, reserveSig);
    }

    function test_topUp_revert_notSeller() public {
        bytes32 salt = keccak256("session-topup-auth");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        uint128 settleAmount = 90_000_000;
        bytes memory spendingSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.topUp(channelId, settleAmount, encodeMetadata(5000, 2000), spendingSig, newMax, newDeadline, reserveSig);
    }

    function test_topUp_revert_expiredDeadline() public {
        bytes32 salt = keccak256("session-topup-expired");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        uint128 settleAmount = 90_000_000;
        bytes memory spendingSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        uint128 newMax = USDC_150;
        uint256 pastDeadline = block.timestamp - 1;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, newMax, pastDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.ChannelExpired.selector);
        channels.topUp(channelId, settleAmount, encodeMetadata(5000, 2000), spendingSig, newMax, pastDeadline, reserveSig);
    }

    function test_topUp_revert_invalidSignature() public {
        bytes32 salt = keccak256("session-topup-badsig");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        uint128 settleAmount = 90_000_000;
        bytes memory spendingSig = signSpendingAuth(BUYER_PK, channelId, settleAmount, 5000, 2000);
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory badSig = signReserveAuth(RANDOM_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        vm.expectRevert(AntseedChannels.InvalidSignature.selector);
        channels.topUp(channelId, settleAmount, encodeMetadata(5000, 2000), spendingSig, newMax, newDeadline, badSig);
    }

    function test_topUp_continueAndClose() public {
        bytes32 salt = keccak256("session-topup-then-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_150);

        // Top up with 90 USDC settle
        uint128 settleAmount1 = 90_000_000;
        bytes memory spendingSig1 = signSpendingAuth(BUYER_PK, channelId, settleAmount1, 5000, 2000);
        uint128 newMax = USDC_150;
        uint256 newDeadline = block.timestamp + 2 hours;
        bytes memory reserveSig = signReserveAuth(BUYER_PK, channelId, newMax, newDeadline);

        vm.prank(seller);
        channels.topUp(channelId, settleAmount1, encodeMetadata(5000, 2000), spendingSig1, newMax, newDeadline, reserveSig);

        // Continue settling up to 120 cumulative
        uint128 settleAmount2 = 120_000_000;
        bytes memory settleSig2 = signSpendingAuth(BUYER_PK, channelId, settleAmount2, 8000, 3500);
        vm.prank(seller);
        channels.settle(channelId, settleAmount2, encodeMetadata(8000, 3500), settleSig2);

        // Close at 130 cumulative
        uint128 finalAmount = 130_000_000;
        bytes memory closeSig = signSpendingAuth(BUYER_PK, channelId, finalAmount, 10000, 4000);
        vm.prank(seller);
        channels.close(channelId, finalAmount, encodeMetadata(10000, 4000), closeSig);

        (,,, uint128 sSettledFinal,,,,, AntseedChannels.ChannelStatus sStatusFinal) = channels.channels(channelId);
        assertTrue(sStatusFinal == AntseedChannels.ChannelStatus.Settled);
        assertEq(sSettledFinal, 130_000_000);

        // Buyer refund = 150 - 130 = 20 USDC
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, 20_000_000);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   DOMAIN SEPARATOR TEST
    // ═══════════════════════════════════════════════════════════════════

    function test_domainSeparator_nonZero() public view {
        bytes32 ds = channels.domainSeparator();
        assertTrue(ds != bytes32(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    //                   OPERATOR TESTS
    // ═══════════════════════════════════════════════════════════════════

    bytes32 constant SET_OPERATOR_TYPEHASH = keccak256(
        "SetOperator(address operator,uint256 nonce)"
    );

    function signSetOperator(
        uint256 buyerPk,
        address operator,
        uint256 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(SET_OPERATOR_TYPEHASH, operator, nonce)
        );
        bytes32 digest = _hashTypedDataDeposits(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    // NOTE: These are standalone operator tests — they don't use createBuyer/doReserve.
    // Operator is set via the first deposit() call.

    /// @dev Set operator and deposit for standalone operator tests.
    function _setOperatorAndDeposit(address op, uint256 buyerPk, uint256 nonce) internal {
        address addr = vm.addr(buyerPk);
        bytes memory sig = signSetOperator(buyerPk, op, nonce);
        deposits.setCreditLimitOverride(addr, type(uint256).max);
        deposits.setOperator(addr, op, nonce, sig);

        usdc.mint(op, USDC_100);
        vm.startPrank(op);
        usdc.approve(address(deposits), USDC_100);
        deposits.deposit(addr, USDC_100);
        vm.stopPrank();
    }

    function test_operatorSetViaDeposit() public {
        address op = address(0xABCDE1);
        _setOperatorAndDeposit(op, BUYER_PK, 0);
        assertEq(deposits.getOperator(buyer), op);
        assertEq(deposits.getOperatorNonce(buyer), 1);
    }

    function test_setOperator_revert_wrongNonce() public {
        address op = address(0xABCDE1);
        bytes memory sig = signSetOperator(BUYER_PK, op, 1); // nonce should be 0

        vm.expectRevert(AntseedDeposits.InvalidNonce.selector);
        deposits.setOperator(buyer, op, 1, sig);
    }

    function test_setOperator_revert_wrongSigner() public {
        address op = address(0xABCDE1);
        bytes memory sig = signSetOperator(RANDOM_PK, op, 0); // wrong signer

        vm.expectRevert(AntseedDeposits.InvalidSignature.selector);
        deposits.setOperator(buyer, op, 0, sig);
    }

    function test_setOperator_revert_alreadySet() public {
        _setOperatorAndDeposit(address(0xABCDE2), BUYER_PK, 0);

        address op2 = address(0xABCDE3);
        bytes memory sig2 = signSetOperator(BUYER_PK, op2, 1);
        vm.expectRevert(AntseedDeposits.OperatorAlreadySet.selector);
        deposits.setOperator(buyer, op2, 1, sig2);
    }

    function test_transferOperator() public {
        address op1 = address(0xABCDE2);
        address op2 = address(0xABCDE3);
        _setOperatorAndDeposit(op1, BUYER_PK, 0);

        vm.prank(op1);
        deposits.transferOperator(buyer, op2);
        assertEq(deposits.getOperator(buyer), op2);
    }

    function test_transferOperator_revoke() public {
        address op = address(0xABCDE1);
        _setOperatorAndDeposit(op, BUYER_PK, 0);

        vm.prank(op);
        deposits.transferOperator(buyer, address(0));
        assertEq(deposits.getOperator(buyer), address(0));
    }

    function test_transferOperator_revert_notOperator() public {
        address op = address(0xABCDE1);
        _setOperatorAndDeposit(op, BUYER_PK, 0);

        vm.prank(randomUser);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.transferOperator(buyer, address(0xBEEF));

        vm.prank(buyer);
        vm.expectRevert(AntseedDeposits.NotAuthorized.selector);
        deposits.transferOperator(buyer, address(0xBEEF));
    }

    function test_transferOperator_thenSetAgain() public {
        address op1 = address(0xABCDE2);
        address op2 = address(0xABCDE3);
        _setOperatorAndDeposit(op1, BUYER_PK, 0);

        // Revoke
        vm.prank(op1);
        deposits.transferOperator(buyer, address(0));

        // Set new operator (nonce 1)
        bytes memory sig2 = signSetOperator(BUYER_PK, op2, 1);
        deposits.setOperator(buyer, op2, 1, sig2);
        assertEq(deposits.getOperator(buyer), op2);
    }

    function test_operator_canRequestClose() public {
        bytes32 salt = keccak256("session-operator-close");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Operator calls requestClose
        vm.prank(buyerOperator);
        channels.requestClose(channelId);

        (,,,,,,,uint256 closeRequestedAt,) = channels.channels(channelId);
        assertTrue(closeRequestedAt > 0);
    }

    function test_operator_canWithdraw() public {
        bytes32 salt = keccak256("session-operator-withdraw");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Operator requests close
        vm.prank(buyerOperator);
        channels.requestClose(channelId);

        // Wait grace period
        vm.warp(block.timestamp + 15 minutes + 1);

        // Operator withdraws
        vm.prank(buyerOperator);
        channels.withdraw(channelId);

        // Funds returned to buyer's deposits balance
        (uint256 available,,) = deposits.getBuyerBalance(buyer);
        assertEq(available, USDC_100);
    }

    function test_operator_revert_randomUserCannotClose() public {
        bytes32 salt = keccak256("session-operator-random");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // buyerOperator already set via createBuyer

        // Random user cannot close
        vm.prank(randomUser);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(channelId);
    }

    function test_operator_revert_sellerCannotClose() public {
        bytes32 salt = keccak256("session-operator-seller");
        bytes32 channelId = doReserve(salt, USDC_100, USDC_100);

        // Seller is not the operator — should not be able to close
        vm.prank(seller);
        vm.expectRevert(AntseedChannels.NotAuthorized.selector);
        channels.requestClose(channelId);
    }

}
