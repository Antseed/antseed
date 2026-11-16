// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { MockUSDC } from "./mocks/MockUSDC.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedDeposits } from "../payments/AntseedDeposits.sol";
import { AntseedStaking } from "../staking/AntseedStaking.sol";
import { AntseedChannels } from "../payments/AntseedChannels.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { AntseedSellerUnlockPolicy } from "../policies/AntseedSellerUnlockPolicy.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";
import { AntseedColonyPool } from "../staking/AntseedColonyPool.sol";

/// @dev Shared buyer plumbing for colony pools on other contract stacks.
abstract contract ColonyPoolStackBase is Test {
    uint256 constant OWNER_PK = 0x0A;
    uint256 constant OPERATOR_PK = 0x0B;
    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant EPOCH_DURATION = 1 weeks;

    bytes32 constant SPENDING_AUTH_TYPEHASH =
        keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)");
    bytes32 constant RESERVE_AUTH_TYPEHASH = keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");
    bytes32 constant MAGIC = keccak256("antseed:worker-attribution:v1");

    address owner;
    address operator;
    address buyer;
    address buyerOperator = address(0xAA);
    address workerA = address(0x1000);

    MockUSDC usdc;
    ANTSToken ants;
    MockERC8004Registry identityRegistry;
    AntseedRegistry antseedRegistry;
    AntseedDeposits deposits;
    AntseedChannels channels;
    AntseedColonyPool pool;

    function _deployCore() internal {
        owner = vm.addr(OWNER_PK);
        operator = vm.addr(OPERATOR_PK);
        buyer = vm.addr(BUYER_PK);
        vm.warp(1_700_000_000);

        usdc = new MockUSDC();
        ants = new ANTSToken();
        identityRegistry = new MockERC8004Registry();
        antseedRegistry = new AntseedRegistry();
        deposits = new AntseedDeposits(address(usdc));
        channels = new AntseedChannels(address(antseedRegistry));

        antseedRegistry.setChannels(address(channels));
        antseedRegistry.setDeposits(address(deposits));
        antseedRegistry.setAntsToken(address(ants));
        antseedRegistry.setIdentityRegistry(address(identityRegistry));
        antseedRegistry.setProtocolReserve(address(0xFEE));
        antseedRegistry.setTeamWallet(address(0xBEEF));
        deposits.setRegistry(address(antseedRegistry));
        ants.setRegistry(address(antseedRegistry));
        channels.setFirstSignCap(10_000_000_000);

        vm.prank(owner);
        pool = new AntseedColonyPool(address(antseedRegistry), operator);
        ants.setTransferWhitelist(address(pool), true);
    }

    function _reserve(bytes32 salt, uint128 maxAmount) internal returns (bytes32 channelId) {
        vm.prank(buyer);
        identityRegistry.register();
        deposits.setCreditLimitOverride(buyer, type(uint256).max);
        uint256 nonce = deposits.getOperatorNonce(buyer);
        bytes32 opHash = keccak256(abi.encode(deposits.SET_OPERATOR_TYPEHASH(), buyerOperator, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(BUYER_PK, keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), opHash)));
        deposits.setOperator(buyer, buyerOperator, nonce, abi.encodePacked(r, s, v));
        usdc.mint(buyerOperator, maxAmount);
        vm.startPrank(buyerOperator);
        usdc.approve(address(deposits), maxAmount);
        deposits.deposit(buyer, maxAmount);
        vm.stopPrank();

        channelId = channels.computeChannelId(buyer, address(pool), salt);
        uint256 deadline = block.timestamp + 1 days;
        (v, r, s) = vm.sign(
            BUYER_PK, _digest(keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, channelId, maxAmount, deadline)))
        );
        vm.prank(operator);
        pool.reserve(buyer, salt, maxAmount, deadline, abi.encodePacked(r, s, v));
    }

    function _settle(bytes32 channelId, uint128 cumulative, address worker) internal {
        bytes memory metadata = abi.encodePacked(
            abi.encode(uint256(4), cumulative, cumulative / 2, uint256(1), uint256(0), uint256(0), uint256(0), uint256(0)),
            worker,
            cumulative,
            uint8(1),
            MAGIC
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            BUYER_PK,
            _digest(keccak256(abi.encode(SPENDING_AUTH_TYPEHASH, channelId, uint256(cumulative), keccak256(metadata))))
        );
        vm.prank(operator);
        pool.settle(channelId, cumulative, metadata, abi.encodePacked(r, s, v));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
    }

    function _epochs1(uint256 e) internal pure returns (uint256[] memory a) {
        a = new uint256[](1);
        a[0] = e;
    }
}

/// @dev Seller-pool era: registry.staking() is AntseedSellerRegistry, which
///      only lets the seller itself register, and eligibility needs ANTS stake.
contract AntseedColonyPoolSellerRegistryTest is ColonyPoolStackBase {
    AntseedSellerPools sellerPools;
    AntseedSellerRegistry sellerRegistry;
    uint256 genesis;

    /// @dev Stands in for the emissions gate's epoch clock.
    function currentEpoch() external view returns (uint256) {
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function setUp() public {
        _deployCore();
        genesis = block.timestamp;
        sellerPools = new AntseedSellerPools(address(ants), address(this), address(identityRegistry), address(0));
        ants.setTransferWhitelist(address(sellerPools), true);
        sellerRegistry = new AntseedSellerRegistry(address(identityRegistry), address(sellerPools), address(0));
        sellerPools.setStakingSource(address(sellerRegistry));
        antseedRegistry.setStaking(address(sellerRegistry));
    }

    function test_poolRegistersItselfAndReservesWithAntsStake() public {
        vm.startPrank(owner);
        uint256 agentId = pool.registerAgent("ipfs://colony-pool");
        pool.registerSeller(agentId);
        vm.stopPrank();
        assertEq(sellerRegistry.getAgentId(address(pool)), agentId);
        assertFalse(sellerRegistry.isStakedAboveMin(address(pool)), "no stake yet");

        address staker = address(0x57A);
        deal(address(ants), staker, 100 ether);
        ants.setTransferWhitelist(staker, true);
        vm.startPrank(staker);
        ants.approve(address(sellerPools), 100 ether);
        sellerPools.stake(agentId, 100 ether, 4);
        vm.stopPrank();
        vm.warp(block.timestamp + EPOCH_DURATION);
        assertTrue(sellerRegistry.isStakedAboveMin(address(pool)));

        bytes32 ch = _reserve(bytes32(uint256(1)), 100e6);
        (, address seller,,,,,,,) = channels.channels(ch);
        assertEq(seller, address(pool));
        _settle(ch, 50e6, workerA);
        assertGt(pool.usdcBalance(workerA), 0);
    }

    function test_registerSellerRejectsAgentThePoolDoesNotOwn() public {
        uint256 agentId = identityRegistry.register();
        vm.prank(owner);
        vm.expectRevert(AntseedColonyPool.NotAgentOwner.selector);
        pool.registerSeller(agentId);
    }
}

/// @dev Legacy AntseedEmissionsV2 locks a seller's reward in its rewards pool
///      unless the unlock policy lets that seller claim directly.
contract AntseedColonyPoolEmissionsV2Test is ColonyPoolStackBase {
    AntseedEmissions legacyEmissions;
    AntseedEmissionsV2 emissions;
    AntseedSellerRewardsPool rewardsPool;
    AntseedSellerUnlockPolicy unlockPolicy;

    function setUp() public {
        _deployCore();
        AntseedStaking staking = new AntseedStaking(address(usdc), address(antseedRegistry));
        antseedRegistry.setStaking(address(staking));
        legacyEmissions = new AntseedEmissions(address(antseedRegistry), 1000 ether, EPOCH_DURATION);
        antseedRegistry.setEmissions(address(legacyEmissions));
        rewardsPool = new AntseedSellerRewardsPool(address(antseedRegistry));
        unlockPolicy = new AntseedSellerUnlockPolicy();
        emissions = new AntseedEmissionsV2(address(antseedRegistry), address(legacyEmissions), address(rewardsPool));
        emissions.setSellerUnlockPolicy(address(unlockPolicy));
        antseedRegistry.setEmissions(address(emissions));

        vm.prank(address(pool));
        uint256 agentId = identityRegistry.register();
        usdc.mint(address(this), 10_000_000);
        usdc.approve(address(staking), 10_000_000);
        staking.stakeFor(address(pool), agentId, 10_000_000);
    }

    function test_lockedClaimRevertsWithoutConsumingTheEpoch() public {
        uint256 e0 = emissions.currentEpoch();
        _settle(_reserve(bytes32(uint256(2)), 100e6), 100e6, workerA);
        vm.warp(block.timestamp + EPOCH_DURATION);

        vm.expectRevert(AntseedColonyPool.EmissionsLocked.selector);
        pool.claimEpochEmissions(_epochs1(e0));
        assertFalse(emissions.sellerEpochClaimed(address(pool), e0), "epoch still claimable upstream");
        assertEq(rewardsPool.lockedRewards(address(pool)), 0);

        // Once the policy lets the pool claim unlocked, the same epoch pays out.
        unlockPolicy.setSellerEligibility(address(pool), true);
        pool.claimEpochEmissions(_epochs1(e0));
        assertGt(pool.epochAnts(e0), 0);
        vm.prank(workerA);
        pool.claimAnts(_epochs1(e0));
        assertGt(ants.balanceOf(workerA), 0);
    }
}
