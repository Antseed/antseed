// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedDeposits } from "../payments/AntseedDeposits.sol";
import { AntseedStaking } from "../staking/AntseedStaking.sol";
import { AntseedChannels } from "../payments/AntseedChannels.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedColonyPool } from "../staking/AntseedColonyPool.sol";
import { AntseedSellerDelegation } from "../staking/AntseedSellerDelegation.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Channels stand-in that re-enters the pool while the pool is inside
///      its `settle` override.
contract ReentrantChannels {
    AntseedColonyPool public pool;
    uint8 public mode; // 0 = claimUsdc, 1 = settle, 2 = claimEpochEmissions

    function configure(AntseedColonyPool _pool, uint8 _mode) external {
        pool = _pool;
        mode = _mode;
    }

    function settle(bytes32 channelId, uint128 cumulativeAmount, bytes calldata metadata, bytes calldata sig) external {
        if (mode == 0) {
            pool.claimUsdc();
        } else if (mode == 1) {
            pool.settle(channelId, cumulativeAmount, metadata, sig);
        } else {
            uint256[] memory epochs = new uint256[](1);
            pool.claimEpochEmissions(epochs);
        }
    }
}

contract AntseedColonyPoolTest is Test {
    uint256 constant OWNER_PK = 0x0A;
    uint256 constant OPERATOR_PK = 0x0B;
    uint256 constant BUYER_PK = 0xA11CE;

    uint256 constant POOL_STAKE = 10_000_000; // MIN_SELLER_STAKE
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;

    bytes32 constant SPENDING_AUTH_TYPEHASH =
        keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)");
    bytes32 constant RESERVE_AUTH_TYPEHASH = keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");
    bytes32 constant MAGIC = keccak256("antseed:worker-attribution:v1");

    address owner;
    address operator;
    address buyer;
    address buyerOperator = address(0xAA);
    address protocolReserve = address(0xFEE);
    address teamWallet = address(0xBEEF);
    address remainderSink = address(0x5EED);

    // Ascending worker addresses.
    address workerA = address(0x1000);
    address workerB = address(0x2000);
    address workerC = address(0x3000);

    MockUSDC usdc;
    ANTSToken ants;
    MockERC8004Registry identityRegistry;
    AntseedRegistry antseedRegistry;
    AntseedDeposits deposits;
    AntseedStaking staking;
    AntseedChannels channels;
    AntseedEmissions emissions;

    AntseedColonyPool pool;
    uint256 poolAgentId;
    bool buyerReady;

    struct Entry {
        address worker;
        uint128 amount;
    }

    function setUp() public {
        owner = vm.addr(OWNER_PK);
        operator = vm.addr(OPERATOR_PK);
        buyer = vm.addr(BUYER_PK);

        vm.warp(1_700_000_000);

        usdc = new MockUSDC();
        ants = new ANTSToken();
        identityRegistry = new MockERC8004Registry();
        antseedRegistry = new AntseedRegistry();
        deposits = new AntseedDeposits(address(usdc));
        staking = new AntseedStaking(address(usdc), address(antseedRegistry));
        channels = new AntseedChannels(address(antseedRegistry));
        emissions = new AntseedEmissions(address(antseedRegistry), INITIAL_EMISSION, EPOCH_DURATION);

        antseedRegistry.setChannels(address(channels));
        antseedRegistry.setDeposits(address(deposits));
        antseedRegistry.setStaking(address(staking));
        antseedRegistry.setEmissions(address(emissions));
        antseedRegistry.setAntsToken(address(ants));
        antseedRegistry.setIdentityRegistry(address(identityRegistry));
        antseedRegistry.setProtocolReserve(protocolReserve);
        antseedRegistry.setTeamWallet(teamWallet);

        deposits.setRegistry(address(antseedRegistry));
        ants.setRegistry(address(antseedRegistry));
        channels.setFirstSignCap(10_000_000_000);

        vm.prank(owner);
        pool = new AntseedColonyPool(address(antseedRegistry), operator);

        vm.prank(owner);
        poolAgentId = pool.registerAgent("ipfs://colony-pool");

        usdc.mint(address(this), POOL_STAKE);
        usdc.approve(address(staking), POOL_STAKE);
        staking.stakeFor(address(pool), poolAgentId, POOL_STAKE);

        ants.setTransferWhitelist(address(pool), true);

        vm.prank(owner);
        pool.setRemainderRecipient(remainderSink);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _setupBuyer(uint256 depositAmount) internal {
        if (!buyerReady) {
            vm.prank(buyer);
            identityRegistry.register();
            deposits.setCreditLimitOverride(buyer, type(uint256).max);
            uint256 nonce = deposits.getOperatorNonce(buyer);
            bytes32 structHash = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), buyerOperator, nonce));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
            deposits.setOperator(buyer, buyerOperator, nonce, abi.encodePacked(r, s, v));
            buyerReady = true;
        }
        usdc.mint(buyerOperator, depositAmount);
        vm.startPrank(buyerOperator);
        usdc.approve(address(deposits), depositAmount);
        deposits.deposit(buyer, depositAmount);
        vm.stopPrank();
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
    }

    function _signReserve(bytes32 channelId, uint128 maxAmount, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(BUYER_PK, _digest(keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, channelId, maxAmount, deadline))));
        return abi.encodePacked(r, s, v);
    }

    function _signSpend(bytes32 channelId, uint256 cumulative, bytes memory metadata) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            BUYER_PK, _digest(keccak256(abi.encode(SPENDING_AUTH_TYPEHASH, channelId, cumulative, keccak256(metadata))))
        );
        return abi.encodePacked(r, s, v);
    }

    function _reserve(bytes32 salt, uint128 maxAmount) internal returns (bytes32 channelId) {
        _setupBuyer(maxAmount);
        channelId = channels.computeChannelId(buyer, address(pool), salt);
        bytes memory sig = _signReserve(channelId, maxAmount, block.timestamp + 1 days);
        vm.prank(operator);
        pool.reserve(buyer, salt, maxAmount, block.timestamp + 1 days, sig);
    }

    /// @dev ABI v4 head: 8 words.
    function _head(uint256 cumulative) internal pure returns (bytes memory) {
        return abi.encode(uint256(4), cumulative, cumulative / 2, uint256(1), uint256(0), uint256(0), uint256(0), uint256(0));
    }

    function _entries(Entry[] memory es) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < es.length; i++) {
            out = abi.encodePacked(out, es[i].worker, es[i].amount);
        }
    }

    function _tail(Entry[] memory es) internal pure returns (bytes memory) {
        return abi.encodePacked(_entries(es), uint8(es.length), MAGIC);
    }

    function _meta(uint256 cumulative, Entry[] memory es) internal pure returns (bytes memory) {
        return abi.encodePacked(_head(cumulative), _tail(es));
    }

    function _e1(address w, uint128 a) internal pure returns (Entry[] memory es) {
        es = new Entry[](1);
        es[0] = Entry(w, a);
    }

    function _e2(address w1, uint128 a1, address w2, uint128 a2) internal pure returns (Entry[] memory es) {
        es = new Entry[](2);
        es[0] = Entry(w1, a1);
        es[1] = Entry(w2, a2);
    }

    function _settleRaw(bytes32 channelId, uint128 cumulative, bytes memory metadata) internal returns (uint256 net) {
        bytes memory sig = _signSpend(channelId, cumulative, metadata);
        vm.prank(operator);
        net = pool.settle(channelId, cumulative, metadata, sig);
    }

    function _settle(bytes32 channelId, uint128 cumulative, Entry[] memory es) internal returns (uint256) {
        return _settleRaw(channelId, cumulative, _meta(cumulative, es));
    }

    function _epochs1(uint256 e) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = e;
    }

    function _epochs2(uint256 e0, uint256 e1) internal pure returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = e0;
        a[1] = e1;
    }

    function _assertSolvent() internal view {
        assertEq(usdc.balanceOf(address(pool)), pool.totalUsdcOwed(), "pool usdc == owed");
    }

    /// @dev Malformed tails must attribute nothing: the full net goes to the
    ///      remainder recipient and no worker cumulative moves.
    function _assertAllToRemainder(bytes memory metadata, address probe) internal {
        bytes32 ch = _reserve(keccak256(metadata), 100e6);
        uint256 remBefore = pool.usdcBalance(remainderSink);
        uint256 net = _settleRaw(ch, 100e6, metadata);
        assertGt(net, 0);
        assertEq(pool.usdcBalance(remainderSink) - remBefore, net, "all net to remainder");
        assertEq(pool.usdcBalance(probe), 0, "probe worker not credited");
        assertEq(pool.workerCumulative(ch, probe), 0, "probe cumulative untouched");
        assertEq(pool.channelCumulative(ch), 100e6);
        _assertSolvent();
    }

    // ─── Pro-rata split ─────────────────────────────────────────────

    function test_twoWorkers_proRata_acrossSettles() public {
        bytes32 ch = _reserve(bytes32(uint256(1)), 1000e6);

        uint256 net1 = _settle(ch, 100e6, _e2(workerA, 60e6, workerB, 30e6));
        assertEq(pool.usdcBalance(workerA), (net1 * 60e6) / 100e6);
        assertEq(pool.usdcBalance(workerB), (net1 * 30e6) / 100e6);
        assertEq(
            pool.usdcBalance(remainderSink),
            net1 - (net1 * 60e6) / 100e6 - (net1 * 30e6) / 100e6,
            "unattributed 10% + dust"
        );

        // Second settle: channel delta 100, A delta 40, B delta 60.
        uint256 a1 = pool.usdcBalance(workerA);
        uint256 b1 = pool.usdcBalance(workerB);
        uint256 r1 = pool.usdcBalance(remainderSink);
        uint256 net2 = _settle(ch, 200e6, _e2(workerA, 100e6, workerB, 90e6));
        assertEq(pool.usdcBalance(workerA) - a1, (net2 * 40e6) / 100e6);
        assertEq(pool.usdcBalance(workerB) - b1, (net2 * 60e6) / 100e6);
        assertEq(pool.usdcBalance(remainderSink) - r1, net2 - (net2 * 40e6) / 100e6 - (net2 * 60e6) / 100e6);

        assertEq(pool.workerCumulative(ch, workerA), 100e6);
        assertEq(pool.workerCumulative(ch, workerB), 90e6);
        assertEq(pool.channelCumulative(ch), 200e6);
        assertEq(pool.totalUsdcOwed(), net1 + net2);
        _assertSolvent();
    }

    function test_remainder_roundingDust() public {
        bytes32 ch = _reserve(bytes32(uint256(2)), 1000e6);
        Entry[] memory es = new Entry[](3);
        es[0] = Entry(workerA, 1);
        es[1] = Entry(workerB, 1);
        es[2] = Entry(workerC, 1);
        uint256 net = _settle(ch, 3, es);
        // delta 3 → platform fee 0 (floor), gross 3, operator fee 0 → net 3.
        assertEq(net, 3);
        assertEq(pool.usdcBalance(workerA), 1);
        assertEq(pool.usdcBalance(workerB), 1);
        assertEq(pool.usdcBalance(workerC), 1);
        assertEq(pool.usdcBalance(remainderSink), 0);

        // 7 units, A worth 1 of 3 → floor dust lands in remainder.
        uint256 net2 = _settle(ch, 1000, _e2(workerA, 333, workerB, 334));
        uint256 aGot = pool.usdcBalance(workerA) - 1;
        uint256 bGot = pool.usdcBalance(workerB) - 1;
        assertEq(aGot, (net2 * 332) / 997);
        assertEq(bGot, (net2 * 333) / 997);
        assertEq(pool.usdcBalance(remainderSink), net2 - aGot - bGot);
        assertGt(pool.usdcBalance(remainderSink), 0);
        _assertSolvent();
    }

    function test_noTail_allToRemainder() public {
        bytes32 ch = _reserve(bytes32(uint256(3)), 100e6);
        uint256 net = _settleRaw(ch, 50e6, _head(50e6));
        assertEq(pool.usdcBalance(remainderSink), net);
        _assertSolvent();
    }

    function test_operatorFee_appliedBeforeSplit() public {
        bytes32 ch = _reserve(bytes32(uint256(4)), 100e6);
        uint256 feeBefore = usdc.balanceOf(operator);
        uint256 net = _settle(ch, 100e6, _e1(workerA, 100e6));
        uint256 gross = 100e6 - (100e6 * channels.PLATFORM_FEE_BPS()) / 10_000;
        uint256 fee = (gross * pool.operatorFeeBps()) / 10_000;
        assertEq(usdc.balanceOf(operator) - feeBefore, fee, "operator fee paid out");
        assertEq(net, gross - fee);
        assertEq(pool.usdcBalance(workerA), net, "worker gets 100% of net");
        assertEq(pool.usdcBalance(remainderSink), 0);
        _assertSolvent();
    }

    function test_operatorFeeZero_workerGetsFullGross() public {
        vm.prank(owner);
        pool.setOperatorFee(0, address(0));
        bytes32 ch = _reserve(bytes32(uint256(5)), 100e6);
        uint256 net = _settle(ch, 100e6, _e1(workerA, 100e6));
        assertEq(net, 100e6 - (100e6 * channels.PLATFORM_FEE_BPS()) / 10_000);
        assertEq(pool.usdcBalance(workerA), net);
    }

    // ─── Clamping and monotonicity ──────────────────────────────────

    function test_sumExceedsDelta_clamped() public {
        bytes32 ch = _reserve(bytes32(uint256(6)), 1000e6);
        uint256 net = _settle(ch, 100e6, _e2(workerA, 80e6, workerB, 80e6));
        assertEq(pool.usdcBalance(workerA), (net * 80e6) / 100e6, "A full");
        assertEq(pool.usdcBalance(workerB), (net * 20e6) / 100e6, "B clamped to remaining 20");
        assertEq(pool.usdcBalance(remainderSink), net - (net * 80e6) / 100e6 - (net * 20e6) / 100e6);
        // B's stored value is what was paid, so the clamped 60 stays owed.
        assertEq(pool.workerCumulative(ch, workerB), 20e6);

        // The next settlement pays B's carried-over 60 from its delta of 100.
        uint256 b1 = pool.usdcBalance(workerB);
        uint256 net2 = _settle(ch, 200e6, _e2(workerA, 80e6, workerB, 80e6));
        assertEq(pool.usdcBalance(workerB) - b1, (net2 * 60e6) / 100e6, "carried over");
        assertEq(pool.workerCumulative(ch, workerB), 80e6);
        (uint128 settled, uint128 credited) = pool.workerCredit(ch, workerB);
        assertEq(settled, 200e6);
        assertEq(credited, 80e6);
        _assertSolvent();
    }

    function test_clampedAttributionNeverPaysTwice() public {
        bytes32 ch = _reserve(bytes32(uint256(61)), 1000e6);
        // Settled once with nothing for A, then A's 100 lands in a delta of 10.
        _settle(ch, 90e6, new Entry[](0));
        _settle(ch, 100e6, _e1(workerA, 100e6));
        assertEq(pool.workerCumulative(ch, workerA), 10e6);
        // Later deltas pay the remaining 90 and no more.
        uint256 a1 = pool.usdcBalance(workerA);
        uint256 net = _settle(ch, 300e6, _e1(workerA, 100e6));
        assertEq(pool.usdcBalance(workerA) - a1, (net * 90e6) / 200e6);
        assertEq(pool.workerCumulative(ch, workerA), 100e6);
        _assertSolvent();
    }

    function test_clampZeroesTrailingEntries() public {
        bytes32 ch = _reserve(bytes32(uint256(7)), 1000e6);
        Entry[] memory es = new Entry[](3);
        es[0] = Entry(workerA, 100e6);
        es[1] = Entry(workerB, 50e6);
        es[2] = Entry(workerC, 50e6);
        uint256 net = _settle(ch, 100e6, es);
        assertEq(pool.usdcBalance(workerA), net);
        assertEq(pool.usdcBalance(workerB), 0);
        assertEq(pool.usdcBalance(workerC), 0);
    }

    function test_decreasingWorkerCumulative_ignored() public {
        bytes32 ch = _reserve(bytes32(uint256(8)), 1000e6);
        _settle(ch, 100e6, _e2(workerA, 60e6, workerB, 40e6));
        uint256 a1 = pool.usdcBalance(workerA);
        uint256 b1 = pool.usdcBalance(workerB);

        // A goes "down" to 10 (ignored), B grows by 50.
        uint256 net = _settle(ch, 200e6, _e2(workerA, 10e6, workerB, 90e6));
        assertEq(pool.usdcBalance(workerA), a1, "A unchanged");
        assertEq(pool.workerCumulative(ch, workerA), 60e6, "A stored value never decreases");
        assertEq(pool.usdcBalance(workerB) - b1, (net * 50e6) / 100e6);
        assertEq(pool.workerCumulative(ch, workerB), 90e6);

        // A returns to 70: only the 10 above its high-water mark counts.
        uint256 a2 = pool.usdcBalance(workerA);
        uint256 net3 = _settle(ch, 300e6, _e2(workerA, 70e6, workerB, 90e6));
        assertEq(pool.usdcBalance(workerA) - a2, (net3 * 10e6) / 100e6);
        _assertSolvent();
    }

    function test_workerCumulativesArePerChannel() public {
        bytes32 ch1 = _reserve(bytes32(uint256(9)), 1000e6);
        bytes32 ch2 = _reserve(bytes32(uint256(10)), 1000e6);
        _settle(ch1, 100e6, _e1(workerA, 100e6));
        uint256 a1 = pool.usdcBalance(workerA);
        uint256 net = _settle(ch2, 50e6, _e1(workerA, 50e6));
        assertEq(pool.usdcBalance(workerA) - a1, net, "fresh channel starts from zero");
    }

    // ─── Malformed tails never revert ───────────────────────────────

    function test_malformed_badMagic() public {
        bytes memory m = abi.encodePacked(_head(100e6), _entries(_e1(workerA, 100e6)), uint8(1), keccak256("nope"));
        _assertAllToRemainder(m, workerA);
    }

    function test_malformed_countZero() public {
        bytes memory m = abi.encodePacked(_head(100e6), _entries(_e1(workerA, 100e6)), uint8(0), MAGIC);
        _assertAllToRemainder(m, workerA);
    }

    function test_malformed_countAboveMax() public {
        Entry[] memory es = new Entry[](9);
        for (uint256 i = 0; i < 9; i++) {
            es[i] = Entry(address(uint160(0x1000 + i)), 1e6);
        }
        _assertAllToRemainder(_meta(100e6, es), address(0x1000));
    }

    function test_malformed_countLargerThanEntries() public {
        // Claims 8 entries but only 1 present, and the head is too short to
        // hide the other 7 → length check fails.
        bytes memory m = abi.encodePacked(
            abi.encode(uint256(4), uint256(1), uint256(1), uint256(1)), _entries(_e1(workerA, 100e6)), uint8(8), MAGIC
        );
        _assertAllToRemainder(m, workerA);
    }

    function test_malformed_unsorted() public {
        _assertAllToRemainder(_meta(100e6, _e2(workerB, 50e6, workerA, 50e6)), workerA);
    }

    function test_malformed_duplicate() public {
        _assertAllToRemainder(_meta(100e6, _e2(workerA, 50e6, workerA, 50e6)), workerA);
    }

    function test_malformed_zeroAddress() public {
        _assertAllToRemainder(_meta(100e6, _e2(address(0), 50e6, workerA, 50e6)), workerA);
    }

    function test_malformed_headTooShort() public {
        // 4-word (legacy v1) head + valid-looking tail: below 256 + 33 + 36.
        bytes memory m =
            abi.encodePacked(abi.encode(uint256(1), uint256(1), uint256(1), uint256(1)), _tail(_e1(workerA, 100e6)));
        _assertAllToRemainder(m, workerA);
    }

    function test_malformed_tinyMetadata() public {
        _assertAllToRemainder(hex"01", workerA);
        _assertAllToRemainder(abi.encodePacked(MAGIC), workerA);
        _assertAllToRemainder("", workerA);
    }

    function test_parseWorkerTail_shortMetadataIsEmpty() public view {
        uint256[3] memory lengths = [uint256(0), 1, 32];
        for (uint256 i = 0; i < lengths.length; i++) {
            (address[] memory ws, uint128[] memory as_) = pool.parseWorkerTail(new bytes(lengths[i]));
            assertEq(ws.length, 0);
            assertEq(as_.length, 0);
        }
    }

    function test_parseWorkerTail() public view {
        (address[] memory ws, uint128[] memory as_) = pool.parseWorkerTail(_meta(1, _e2(workerA, 5, workerB, 7)));
        assertEq(ws.length, 2);
        assertEq(ws[0], workerA);
        assertEq(as_[1], 7);
        (ws,) = pool.parseWorkerTail(_meta(1, _e2(workerB, 5, workerA, 7)));
        assertEq(ws.length, 0);
    }

    // ─── close / topUp paths ────────────────────────────────────────

    function test_close_attributesFinalDelta() public {
        bytes32 ch = _reserve(bytes32(uint256(20)), 1000e6);
        _settle(ch, 100e6, _e2(workerA, 50e6, workerB, 50e6));
        uint256 a1 = pool.usdcBalance(workerA);
        uint256 b1 = pool.usdcBalance(workerB);

        bytes memory m = _meta(160e6, _e2(workerA, 110e6, workerB, 50e6));
        bytes memory sig = _signSpend(ch, 160e6, m);
        vm.prank(operator);
        uint256 net = pool.close(ch, 160e6, m, sig);
        assertEq(pool.usdcBalance(workerA) - a1, net, "A served all 60 of the final delta");
        assertEq(pool.usdcBalance(workerB), b1);
        _assertSolvent();
    }

    function test_close_atSettled_ignoresUnsignedTail() public {
        bytes32 ch = _reserve(bytes32(uint256(21)), 1000e6);
        _settle(ch, 100e6, _e1(workerA, 100e6));
        // finalAmount == settled: AntseedChannels verifies no signature, so the
        // operator could pass any metadata. It must not move worker cursors.
        bytes memory forged = _meta(100e6, _e2(workerA, 100e6, workerB, type(uint128).max));
        vm.prank(operator);
        uint256 net = pool.close(ch, 100e6, forged, "");
        assertEq(net, 0);
        assertEq(pool.workerCumulative(ch, workerB), 0);
        assertEq(pool.usdcBalance(workerB), 0);
    }

    function test_topUp_attributes() public {
        bytes32 ch = _reserve(bytes32(uint256(22)), 100e6);
        _setupBuyer(100e6);
        bytes memory m = _meta(90e6, _e2(workerA, 30e6, workerB, 60e6));
        bytes memory spendSig = _signSpend(ch, 90e6, m);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory reserveSig = _signReserve(ch, 200e6, deadline);
        vm.prank(operator);
        uint256 net = pool.topUp(ch, 90e6, m, spendSig, 200e6, deadline, reserveSig);
        assertGt(net, 0);
        assertEq(pool.usdcBalance(workerA), (net * 30e6) / 90e6);
        assertEq(pool.usdcBalance(workerB), (net * 60e6) / 90e6);
        assertEq(pool.channelCumulative(ch), 90e6);
        _assertSolvent();
    }

    function test_topUp_withoutNewSpend_ignoresTail() public {
        bytes32 ch = _reserve(bytes32(uint256(23)), 100e6);
        _settle(ch, 90e6, _e1(workerA, 90e6));
        _setupBuyer(100e6);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory reserveSig = _signReserve(ch, 200e6, deadline);
        // cumulativeAmount <= settled → spendingSig is ignored by channels.
        bytes memory forged = _meta(90e6, _e2(workerA, 90e6, workerB, 1e30));
        vm.prank(operator);
        uint256 net = pool.topUp(ch, 90e6, forged, "", 200e6, deadline, reserveSig);
        assertEq(net, 0);
        assertEq(pool.workerCumulative(ch, workerB), 0);
    }

    // ─── Access control ─────────────────────────────────────────────

    function test_nonOperator_cannotSettle() public {
        bytes32 ch = _reserve(bytes32(uint256(30)), 100e6);
        bytes memory m = _meta(10e6, _e1(workerA, 10e6));
        bytes memory sig = _signSpend(ch, 10e6, m);
        vm.prank(workerA);
        vm.expectRevert(AntseedSellerDelegation.NotOperator.selector);
        pool.settle(ch, 10e6, m, sig);
        vm.prank(workerA);
        vm.expectRevert(AntseedSellerDelegation.NotOperator.selector);
        pool.close(ch, 10e6, m, sig);
    }

    function test_forgedTail_rejectedByChannelsSignature() public {
        bytes32 ch = _reserve(bytes32(uint256(31)), 100e6);
        bytes memory signedMeta = _meta(10e6, _e1(workerA, 10e6));
        bytes memory sig = _signSpend(ch, 10e6, signedMeta);
        bytes memory forged = _meta(10e6, _e1(workerB, 10e6));
        vm.prank(operator);
        vm.expectRevert();
        pool.settle(ch, 10e6, forged, sig);
    }

    function test_onlyOwner_admin() public {
        vm.prank(operator);
        vm.expectRevert();
        pool.setRemainderRecipient(operator);
        vm.prank(owner);
        vm.expectRevert(AntseedSellerDelegation.InvalidAddress.selector);
        pool.setRemainderRecipient(address(0));
        vm.prank(operator);
        vm.expectRevert();
        pool.pause();
    }

    function test_pause_blocksSettlement_notClaims() public {
        bytes32 ch = _reserve(bytes32(uint256(32)), 100e6);
        _settle(ch, 10e6, _e1(workerA, 10e6));
        vm.prank(owner);
        pool.pause();
        bytes memory m = _meta(20e6, _e1(workerA, 20e6));
        bytes memory sig = _signSpend(ch, 20e6, m);
        vm.prank(operator);
        vm.expectRevert();
        pool.settle(ch, 20e6, m, sig);
        vm.prank(workerA);
        pool.claimUsdc();
    }

    // ─── USDC claims ────────────────────────────────────────────────

    function test_claimUsdc() public {
        bytes32 ch = _reserve(bytes32(uint256(40)), 100e6);
        uint256 net = _settle(ch, 100e6, _e2(workerA, 70e6, workerB, 30e6));
        uint256 owedA = pool.usdcBalance(workerA);
        assertEq(owedA, (net * 70e6) / 100e6);

        vm.prank(workerA);
        pool.claimUsdc();
        assertEq(usdc.balanceOf(workerA), owedA);
        assertEq(pool.usdcBalance(workerA), 0);
        _assertSolvent();

        vm.prank(workerA);
        vm.expectRevert(AntseedColonyPool.NothingToClaim.selector);
        pool.claimUsdc();

        if (pool.usdcBalance(remainderSink) > 0) {
            vm.prank(remainderSink);
            pool.claimUsdc();
        }
        vm.prank(workerB);
        pool.claimUsdc();
        assertEq(pool.totalUsdcOwed(), 0);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    function test_sweepOrphanUsdc_onlyExcess() public {
        bytes32 ch = _reserve(bytes32(uint256(41)), 100e6);
        _settle(ch, 100e6, _e1(workerA, 100e6));
        usdc.mint(address(pool), 5e6);
        vm.prank(owner);
        pool.sweepOrphanUsdc(owner);
        assertEq(usdc.balanceOf(owner), 5e6);
        _assertSolvent();
    }

    // ─── Emissions ──────────────────────────────────────────────────

    function test_emissions_splitAcrossEpochs_andDoubleClaim() public {
        uint256 e0 = emissions.currentEpoch();
        bytes32 ch = _reserve(bytes32(uint256(50)), 1000e6);
        // Epoch e0: A 75%, B 25% of net (no remainder: amounts divide evenly).
        _settle(ch, 100e6, _e2(workerA, 75e6, workerB, 25e6));
        uint256 wA0 = pool.epochWeight(e0, workerA);
        uint256 wB0 = pool.epochWeight(e0, workerB);
        uint256 t0 = pool.epochTotalWeight(e0);
        assertEq(wA0 + wB0 + pool.epochWeight(e0, remainderSink), t0);

        // Cannot pull the current epoch.
        vm.expectRevert(AntseedColonyPool.EpochNotFinalized.selector);
        pool.claimEpochEmissions(_epochs1(e0));

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 e1 = emissions.currentEpoch();
        assertEq(e1, e0 + 1);
        // Epoch e1: only B.
        _settle(ch, 200e6, _e2(workerA, 75e6, workerB, 125e6));
        assertEq(pool.epochWeight(e1, workerA), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256 antsBefore = ants.balanceOf(address(pool));
        vm.prank(address(0xCAFE)); // anyone
        pool.claimEpochEmissions(_epochs2(e0, e1));
        uint256 pot0 = pool.epochAnts(e0);
        uint256 pot1 = pool.epochAnts(e1);
        assertGt(pot0, 0);
        assertGt(pot1, 0);
        assertEq(ants.balanceOf(address(pool)) - antsBefore, pot0 + pot1);

        // Calling again pulls nothing new and doesn't revert.
        pool.claimEpochEmissions(_epochs2(e0, e1));
        assertEq(pool.epochAnts(e0), pot0);

        vm.prank(workerA);
        pool.claimAnts(_epochs2(e0, e1));
        assertEq(ants.balanceOf(workerA), (pot0 * wA0) / t0);

        uint256 t1 = pool.epochTotalWeight(e1);
        uint256 wB1 = pool.epochWeight(e1, workerB);
        uint256[] memory both = _epochs2(e0, e1);
        assertEq(pool.pendingAnts(workerB, both), (pot0 * wB0) / t0 + (pot1 * wB1) / t1);
        vm.prank(workerB);
        pool.claimAnts(both);
        assertEq(ants.balanceOf(workerB), (pot0 * wB0) / t0 + (pot1 * wB1) / t1);

        // Double claim.
        vm.prank(workerA);
        vm.expectRevert(AntseedColonyPool.NothingToClaim.selector);
        pool.claimAnts(_epochs2(e0, e1));

        // Pool never pays out more than it received.
        assertLe(ants.balanceOf(workerA) + ants.balanceOf(workerB), pot0 + pot1);
    }

    function test_emissions_duplicateEpochInOneClaimPaysOnce() public {
        uint256 e0 = emissions.currentEpoch();
        bytes32 ch = _reserve(bytes32(uint256(52)), 100e6);
        _settle(ch, 100e6, _e2(workerA, 60e6, workerB, 40e6));
        vm.warp(block.timestamp + EPOCH_DURATION);
        pool.claimEpochEmissions(_epochs1(e0));

        uint256 expected = pool.pendingAnts(workerA, _epochs1(e0));
        assertGt(expected, 0, "worker has an unclaimed share");
        vm.prank(workerA);
        pool.claimAnts(_epochs2(e0, e0));
        assertEq(ants.balanceOf(workerA), expected, "paid exactly one epoch share");
        assertEq(pool.pendingAnts(workerA, _epochs1(e0)), 0);
    }

    /// @dev AntseedUsageAccounting rewards usage settled before the gate's
    ///      effective epoch under that epoch; worker weights must land there.
    function test_emissions_gateCutover_weightsUnderFirstRewardedEpoch() public {
        bytes32 ch = _reserve(bytes32(uint256(53)), 200e6);
        AntseedEmissionsGate gate = new AntseedEmissionsGate(teamWallet, protocolReserve, 15_000, 15_000);
        vm.warp(gate.GENESIS() + 2 * gate.EPOCH_DURATION() + 1);
        gate = new AntseedEmissionsGate(teamWallet, protocolReserve, 15_000, 15_000);
        AntseedUsageAccounting accounting = new AntseedUsageAccounting(address(0), address(channels), address(gate));
        antseedRegistry.setEmissions(address(accounting));
        uint256 cutover = accounting.currentEpoch();
        uint256 rewarded = accounting.firstRewardedEpoch();
        assertEq(rewarded, cutover + 1);

        address mac = vm.addr(MAC_PK);
        _settle(ch, 100e6, _e1(mac, 100e6));
        assertGt(pool.epochWeight(rewarded, mac), 0, "weight in the rewarded epoch");
        assertEq(pool.epochWeight(cutover, mac), 0, "nothing in the cutover epoch");
        assertEq(pool.epochTotalWeight(cutover), 0);

        // A payout change during the cutover moves that weight too.
        address wallet = address(0x9A1);
        _setPayout(wallet, block.timestamp + 1 days);
        assertEq(pool.epochWeight(rewarded, mac), 0);
        assertGt(pool.epochWeight(rewarded, wallet), 0);

        // The rewarded epoch can't be pulled before it ends.
        vm.expectRevert(AntseedColonyPool.EpochNotFinalized.selector);
        pool.claimEpochEmissions(_epochs1(rewarded));
    }

    // ─── Seller registration ────────────────────────────────────────

    function test_registerSeller_onlyOwnerAndOwnedAgent() public {
        uint256 foreign = identityRegistry.register();
        vm.prank(owner);
        vm.expectRevert(AntseedColonyPool.NotAgentOwner.selector);
        pool.registerSeller(foreign);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        pool.registerSeller(poolAgentId);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        pool.registerAgent("ipfs://pool");

        vm.prank(owner);
        uint256 minted = pool.registerAgent("ipfs://pool");
        assertEq(identityRegistry.ownerOf(minted), address(pool));
    }

    function test_emissions_operatorFeeTakenOnAnts() public {
        uint256 e0 = emissions.currentEpoch();
        bytes32 ch = _reserve(bytes32(uint256(51)), 100e6);
        _settle(ch, 100e6, _e1(workerA, 100e6));
        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256[] memory ids = _epochs1(e0);
        (uint256 gross,) = emissions.pendingEmissions(address(pool), ids);
        uint256 opBefore = ants.balanceOf(operator);
        pool.claimEpochEmissions(ids);
        uint256 fee = (gross * pool.operatorFeeBps()) / 10_000;
        assertEq(ants.balanceOf(operator) - opBefore, fee);
        assertEq(pool.epochAnts(e0), gross - fee);
    }

    function test_emissions_invalidInputs() public {
        vm.expectRevert(AntseedColonyPool.InvalidEpochs.selector);
        pool.claimEpochEmissions(new uint256[](0));
        vm.expectRevert(AntseedColonyPool.InvalidEpochs.selector);
        pool.claimAnts(new uint256[](33));
        vm.expectRevert(AntseedColonyPool.NothingToClaim.selector);
        pool.claimAnts(_epochs1(0));
    }

    // ─── Reentrancy ─────────────────────────────────────────────────

    function test_reentrancy_fromChannelsDuringSettle_blocked() public {
        ReentrantChannels evil = new ReentrantChannels();
        antseedRegistry.setChannels(address(evil));
        vm.prank(owner);
        pool.setOperator(address(evil), true);

        for (uint8 mode = 0; mode < 3; mode++) {
            evil.configure(pool, mode);
            vm.prank(operator);
            vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            pool.settle(bytes32(uint256(1)), 1, "", "");
        }
    }

    function test_creditsAfterSuper_noPartialStateOnRevert() public {
        bytes32 ch = _reserve(bytes32(uint256(60)), 100e6);
        bytes memory m = _meta(200e6, _e1(workerA, 200e6)); // exceeds deposit
        bytes memory sig = _signSpend(ch, 200e6, m);
        vm.prank(operator);
        vm.expectRevert();
        pool.settle(ch, 200e6, m, sig);
        assertEq(pool.channelCumulative(ch), 0);
        assertEq(pool.workerCumulative(ch, workerA), 0);
        assertEq(pool.totalUsdcOwed(), 0);
    }

    // ─── Worker payout addresses ────────────────────────────────────

    uint256 constant MAC_PK = 0x3AC;
    uint256 constant OTHER_PK = 0x0DD;

    function _signPayout(uint256 pk, address worker, address payout, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encode(
                keccak256("antseed-worker-payout/v1"), block.chainid, address(pool), worker, payout, nonce, deadline
            )
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _setPayout(address payout, uint256 deadline) internal {
        address mac = vm.addr(MAC_PK);
        bytes memory sig = _signPayout(MAC_PK, mac, payout, pool.payoutNonce(mac), deadline);
        vm.prank(address(0xD00D)); // any third party may submit
        pool.setPayout(mac, payout, deadline, sig);
    }

    function test_payoutDigest_matchesEncoding() public view {
        address mac = vm.addr(MAC_PK);
        bytes32 expected = keccak256(
            abi.encode(keccak256("antseed-worker-payout/v1"), block.chainid, address(pool), mac, owner, uint256(0), 123)
        );
        assertEq(pool.payoutDigest(mac, owner, 123), expected);
    }

    function test_setPayout_thirdPartySubmits_redirectsUsdcAndWeight() public {
        address mac = vm.addr(MAC_PK);
        address wallet = address(0xAB0);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPayout(MAC_PK, mac, wallet, 0, deadline);

        vm.expectEmit(true, true, false, true, address(pool));
        emit AntseedColonyPool.PayoutSet(mac, wallet, 0);
        vm.prank(address(0xD00D));
        pool.setPayout(mac, wallet, deadline, sig);
        assertEq(pool.payoutOf(mac), wallet);
        assertEq(pool.payoutNonce(mac), 1);

        uint256 e0 = emissions.currentEpoch();
        bytes32 ch = _reserve(bytes32(uint256(70)), 100e6);
        uint256 net = _settle(ch, 100e6, _e1(mac, 100e6));
        assertEq(pool.usdcBalance(wallet), net, "credit goes to payout");
        assertEq(pool.usdcBalance(mac), 0);
        assertEq(pool.workerCumulative(ch, mac), 100e6, "cursor keyed by worker");
        assertEq(pool.epochWeight(e0, wallet), net, "weight goes to payout");
        assertEq(pool.epochWeight(e0, mac), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);
        pool.claimEpochEmissions(_epochs1(e0));
        vm.prank(wallet);
        pool.claimAnts(_epochs1(e0));
        assertEq(ants.balanceOf(wallet), pool.epochAnts(e0));
        vm.prank(wallet);
        pool.claimUsdc();
        assertEq(usdc.balanceOf(wallet), net);
    }

    function test_setPayout_movesEarlierEarnings() public {
        address mac = vm.addr(MAC_PK);
        address wallet = address(0xAB0);
        bytes32 ch = _reserve(bytes32(uint256(71)), 1000e6);
        uint256 e0 = emissions.currentEpoch();
        uint256 net1 = _settle(ch, 100e6, _e1(mac, 100e6));

        // e0 is funded and the Mac already claimed its ANTS for it.
        vm.warp(block.timestamp + EPOCH_DURATION);
        pool.claimEpochEmissions(_epochs1(e0));
        vm.prank(mac);
        pool.claimAnts(_epochs1(e0));
        uint256 macAnts = ants.balanceOf(mac);
        uint256 e1 = emissions.currentEpoch();
        uint256 net2 = _settle(ch, 200e6, _e1(mac, 200e6));

        vm.expectEmit(true, true, false, true, address(pool));
        emit AntseedColonyPool.EarningsMoved(mac, wallet, net1 + net2);
        _setPayout(wallet, block.timestamp + 1 hours);
        assertEq(pool.usdcBalance(mac), 0);
        assertEq(pool.usdcBalance(wallet), net1 + net2, "unclaimed USDC moves");
        assertEq(pool.epochWeight(e1, wallet), net2, "current epoch share moves");
        assertEq(pool.epochWeight(e0, mac), 0);
        assertEq(pool.pendingAnts(wallet, _epochs1(e0)), 0, "claimed ANTS is not paid twice");

        vm.warp(block.timestamp + EPOCH_DURATION);
        pool.claimEpochEmissions(_epochs1(e1));
        vm.prank(wallet);
        pool.claimAnts(_epochs1(e1));
        assertEq(ants.balanceOf(wallet), pool.epochAnts(e1));
        assertEq(ants.balanceOf(mac), macAnts);
        vm.prank(wallet);
        pool.claimUsdc();
        assertEq(usdc.balanceOf(wallet), net1 + net2);
        _assertSolvent();
    }

    function test_setPayout_olderEpochSharesStayWithWorker() public {
        address mac = vm.addr(MAC_PK);
        address wallet = address(0xAB0);
        bytes32 ch = _reserve(bytes32(uint256(72)), 1000e6);
        uint256 e0 = emissions.currentEpoch();
        uint256 net = _settle(ch, 100e6, _e1(mac, 100e6));
        vm.warp(block.timestamp + (pool.MAX_EPOCHS_PER_CLAIM() + 2) * EPOCH_DURATION);

        _setPayout(wallet, block.timestamp + 1 hours);
        assertEq(pool.usdcBalance(wallet), net, "USDC always moves");
        assertEq(pool.epochWeight(e0, mac), net, "share outside the window stays claimable by the worker");
        assertEq(pool.epochWeight(e0, wallet), 0);
    }

    function test_claimAntsFor_paysOlderWorkerSharesToPayout() public {
        address mac = vm.addr(MAC_PK);
        address wallet = address(0xAB0);
        bytes32 ch = _reserve(bytes32(uint256(73)), 1000e6);
        uint256 e0 = emissions.currentEpoch();
        _settle(ch, 100e6, _e1(mac, 100e6));
        vm.warp(block.timestamp + (pool.MAX_EPOCHS_PER_CLAIM() + 2) * EPOCH_DURATION);
        pool.claimEpochEmissions(_epochs1(e0));
        _setPayout(wallet, block.timestamp + 1 hours);
        uint256 owed = pool.pendingAnts(mac, _epochs1(e0));
        assertGt(owed, 0, "the share outside the window stays with the worker");

        vm.expectEmit(true, true, false, true, address(pool));
        emit AntseedColonyPool.AntsClaimedFor(mac, wallet, _epochs1(e0), owed);
        vm.prank(address(0xD00D));
        pool.claimAntsFor(mac, _epochs1(e0));
        assertEq(ants.balanceOf(wallet), owed, "paid to the linked wallet");
        assertEq(ants.balanceOf(address(0xD00D)), 0);
        assertEq(ants.balanceOf(mac), 0);
        assertEq(pool.pendingAnts(mac, _epochs1(e0)), 0);

        // Paid once: neither path pays it again.
        vm.expectRevert(AntseedColonyPool.NothingToClaim.selector);
        pool.claimAntsFor(mac, _epochs1(e0));
        vm.prank(mac);
        vm.expectRevert(AntseedColonyPool.NothingToClaim.selector);
        pool.claimAnts(_epochs1(e0));
    }

    function test_claimAntsFor_requiresALinkedPayout() public {
        address mac = vm.addr(MAC_PK);
        bytes32 ch = _reserve(bytes32(uint256(74)), 1000e6);
        uint256 e0 = emissions.currentEpoch();
        _settle(ch, 100e6, _e1(mac, 100e6));
        vm.warp(block.timestamp + EPOCH_DURATION);
        pool.claimEpochEmissions(_epochs1(e0));
        vm.expectRevert(AntseedColonyPool.NoPayout.selector);
        pool.claimAntsFor(mac, _epochs1(e0));
    }

    function test_setPayout_replayFails() public {
        address mac = vm.addr(MAC_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPayout(MAC_PK, mac, owner, 0, deadline);
        pool.setPayout(mac, owner, deadline, sig);
        vm.expectRevert(AntseedColonyPool.InvalidSignature.selector);
        pool.setPayout(mac, owner, deadline, sig);
    }

    function test_setPayout_expiredFails() public {
        address mac = vm.addr(MAC_PK);
        uint256 deadline = block.timestamp - 1;
        bytes memory sig = _signPayout(MAC_PK, mac, owner, 0, deadline);
        vm.expectRevert(AntseedColonyPool.SignatureExpired.selector);
        pool.setPayout(mac, owner, deadline, sig);
        // deadline == now is still valid
        sig = _signPayout(MAC_PK, mac, owner, 0, block.timestamp);
        pool.setPayout(mac, owner, block.timestamp, sig);
    }

    function test_setPayout_wrongSignerFails() public {
        address mac = vm.addr(MAC_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPayout(OTHER_PK, mac, owner, 0, deadline);
        vm.expectRevert(AntseedColonyPool.InvalidSignature.selector);
        pool.setPayout(mac, owner, deadline, sig);
        // Signature for a different payout doesn't transfer.
        sig = _signPayout(MAC_PK, mac, owner, 0, deadline);
        vm.expectRevert(AntseedColonyPool.InvalidSignature.selector);
        pool.setPayout(mac, operator, deadline, sig);
        // Garbage signature.
        vm.expectRevert(AntseedColonyPool.InvalidSignature.selector);
        pool.setPayout(mac, owner, deadline, hex"1234");
    }

    function test_setPayout_malleableSigRejected() public {
        address mac = vm.addr(MAC_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPayout(MAC_PK, mac, owner, 0, deadline);
        bytes32 r;
        bytes32 s_;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s_ := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s_)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(AntseedColonyPool.InvalidSignature.selector);
        pool.setPayout(mac, owner, deadline, flipped);
    }

    function test_setPayout_zeroPayoutFails() public {
        address mac = vm.addr(MAC_PK);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPayout(MAC_PK, mac, address(0), 0, deadline);
        vm.expectRevert(AntseedSellerDelegation.InvalidAddress.selector);
        pool.setPayout(mac, address(0), deadline, sig);
    }

    function test_setPayout_changeAgainWithNewNonce() public {
        address mac = vm.addr(MAC_PK);
        _setPayout(address(0xAB0), block.timestamp + 1 hours);
        _setPayout(address(0xAB1), block.timestamp + 1 hours);
        assertEq(pool.payoutOf(mac), address(0xAB1));
        assertEq(pool.payoutNonce(mac), 2);

        bytes32 ch = _reserve(bytes32(uint256(72)), 100e6);
        uint256 net = _settle(ch, 100e6, _e1(mac, 100e6));
        assertEq(pool.usdcBalance(address(0xAB1)), net);
        assertEq(pool.usdcBalance(address(0xAB0)), 0);
    }

    // ─── Fuzz ───────────────────────────────────────────────────────

    function testFuzz_totalCreditedEqualsNet(
        uint8 rawCount,
        uint256 seed,
        uint8 corruption,
        uint64 firstCum,
        uint64 secondCum
    ) public {
        uint256 count = bound(rawCount, 0, 10);
        uint128 cum1 = uint128(bound(firstCum, 1, 400e6));
        uint128 cum2 = uint128(bound(secondCum, cum1 + 1, 1000e6));

        bytes32 ch = _reserve(bytes32(seed), 1000e6);
        address[] memory accounts = new address[](count + 1);
        accounts[count] = remainderSink;

        for (uint256 round = 0; round < 2; round++) {
            uint128 cum = round == 0 ? cum1 : cum2;
            Entry[] memory es = new Entry[](count);
            for (uint256 i = 0; i < count; i++) {
                // Ascending, non-zero by construction; amounts arbitrary
                // (may exceed delta, decrease, etc.).
                address w = address(uint160(0x10000 + i * 0x100 + (uint256(keccak256(abi.encode(seed, i))) % 0x100)));
                accounts[i] = w;
                es[i] = Entry(w, uint128(uint256(keccak256(abi.encode(seed, i, round))) % (uint256(cum) * 2 + 1)));
            }
            bytes memory tail = _tail(es);
            uint8 c = corruption % 6;
            if (c == 1 && tail.length > 0) tail[tail.length - 1] ^= 0x01; // bad magic
            if (c == 2 && count >= 2) {
                // swap first two addresses → unsorted
                (es[0].worker, es[1].worker) = (es[1].worker, es[0].worker);
                tail = _tail(es);
            }
            if (c == 3 && count >= 1) {
                es[0].worker = address(0);
                tail = _tail(es);
            }
            bytes memory m = abi.encodePacked(_head(cum), tail);

            uint256 owedBefore = pool.totalUsdcOwed();
            uint256 sumBefore;
            for (uint256 i = 0; i < accounts.length; i++) {
                sumBefore += pool.usdcBalance(accounts[i]);
            }
            uint256 net = _settleRaw(ch, cum, m);
            uint256 sumAfter;
            for (uint256 i = 0; i < accounts.length; i++) {
                sumAfter += pool.usdcBalance(accounts[i]);
            }
            // Duplicate addresses are impossible (distinct high bytes), so
            // the per-account sum is exact.
            if (c != 3) assertEq(sumAfter - sumBefore, net, "sum of credits == net");
            assertEq(pool.totalUsdcOwed() - owedBefore, net, "owed grows by net");
            _assertSolvent();
        }
    }

    // Metadata produced by the TypeScript encoder (protocol package encodeMetadata
    // with two workers given out of order); the contract must read the same block.
    function test_parsesTypeScriptEncodedMetadata() public view {
        bytes memory metadata = hex"000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000100000000000000000000000000000bb8200000000000000000000000000000000000000200000000000000000000000000001b58028648a71dd010296ef21e85b13e8b14728f74bae957239f6c65e28db02dfe64e0";
        (address[] memory workers, uint128[] memory amounts) = pool.parseWorkerTail(metadata);
        assertEq(workers.length, 2);
        assertEq(workers[0], 0x1000000000000000000000000000000000000001);
        assertEq(amounts[0], 3000);
        assertEq(workers[1], 0x2000000000000000000000000000000000000002);
        assertEq(amounts[1], 7000);
    }
}
