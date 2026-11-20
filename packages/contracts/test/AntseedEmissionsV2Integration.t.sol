// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedChannels } from "../payments/AntseedChannels.sol";
import { AntseedDeposits } from "../payments/AntseedDeposits.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { AntseedSellerUnlockPolicy } from "../policies/AntseedSellerUnlockPolicy.sol";
import { AntseedStaking } from "../staking/AntseedStaking.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";


contract AntseedEmissionsV2IntegrationTest is Test {
    uint256 constant BUYER_PK = 0xA11CE;
    uint256 constant SELLER_PK = 0xB0B;
    uint256 constant OWNER_PK = 0x0A;

    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint256 constant STAKE_AMOUNT = 10_000_000;
    uint256 constant METADATA_VERSION = 1;

    bytes32 constant SET_OPERATOR_TYPEHASH = keccak256("SetOperator(address operator,uint256 nonce)");
    bytes32 constant SPENDING_AUTH_TYPEHASH =
        keccak256("SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)");
    bytes32 constant RESERVE_AUTH_TYPEHASH =
        keccak256("ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)");

    address buyer;
    address seller;
    address buyerOperator = address(0xAA);
    address protocolReserve = address(0xFEE);
    address teamWallet = address(0xBEEF);
    address owner;

    MockUSDC usdc;
    ANTSToken ants;
    MockERC8004Registry identityRegistry;
    AntseedRegistry antseedRegistry;
    AntseedDeposits deposits;
    AntseedStaking staking;
    AntseedChannels channels;
    AntseedEmissions legacyEmissions;
    AntseedEmissionsV2 emissionsV2;
    AntseedSellerRewardsPool rewardsPool;
    AntseedSellerUnlockPolicy unlockPolicy;

    function setUp() public {
        buyer = vm.addr(BUYER_PK);
        seller = vm.addr(SELLER_PK);
        owner = vm.addr(OWNER_PK);

        vm.warp(1_700_000_000);

        usdc = new MockUSDC();
        ants = new ANTSToken();
        identityRegistry = new MockERC8004Registry();
        antseedRegistry = new AntseedRegistry();
        deposits = new AntseedDeposits(address(usdc));
        staking = new AntseedStaking(address(usdc), address(antseedRegistry));
        channels = new AntseedChannels(address(antseedRegistry));
        legacyEmissions = new AntseedEmissions(address(antseedRegistry), INITIAL_EMISSION, EPOCH_DURATION);

        antseedRegistry.setChannels(address(channels));
        antseedRegistry.setDeposits(address(deposits));
        antseedRegistry.setStaking(address(staking));
        antseedRegistry.setEmissions(address(legacyEmissions));
        antseedRegistry.setAntsToken(address(ants));
        antseedRegistry.setIdentityRegistry(address(identityRegistry));
        antseedRegistry.setProtocolReserve(protocolReserve);
        antseedRegistry.setTeamWallet(teamWallet);

        deposits.setRegistry(address(antseedRegistry));
        ants.setRegistry(address(antseedRegistry));
        channels.setFirstSignCap(10_000_000_000);

        // Mirror the real upgrade condition: deploy V2 during an already-touched legacy epoch.
        vm.warp(legacyEmissions.genesis() + EPOCH_DURATION * 4 + 1);
        vm.prank(address(channels));
        legacyEmissions.accrueSellerPoints(address(0xDEAD), 1);
        vm.prank(address(channels));
        legacyEmissions.accrueBuyerPoints(address(0xBEEF), 1);

        rewardsPool = new AntseedSellerRewardsPool(address(antseedRegistry));
        unlockPolicy = new AntseedSellerUnlockPolicy();
        emissionsV2 = new AntseedEmissionsV2(address(antseedRegistry), address(legacyEmissions), address(rewardsPool));
        emissionsV2.setSellerUnlockPolicy(address(unlockPolicy));
        antseedRegistry.setEmissions(address(emissionsV2));
    }

    function test_channelsSettlementAccruesIntoEmissionsV2() public {
        _createBuyer(500e6);
        _createSeller(seller);

        bytes32 channelId = _reserve(seller, bytes32(uint256(1)), 500e6);
        _settle(seller, channelId, 300e6);

        assertEq(emissionsV2.userSellerPoints(seller, 4), 300e6);
        assertEq(emissionsV2.userBuyerPoints(buyer, 4), 300e6);

        vm.warp(legacyEmissions.genesis() + EPOCH_DURATION * 5 + 1);

        vm.prank(seller);
        emissionsV2.claimSellerEmissions(_epochList(4));
        assertGt(rewardsPool.lockedRewards(seller), 0, "seller emissions are locked by default");

        vm.prank(buyerOperator);
        emissionsV2.claimBuyerEmissions(buyer, _epochList(4));
        assertGt(ants.balanceOf(buyerOperator), 0, "buyer operator receives buyer emissions");
    }

    function _createBuyer(uint256 depositAmount) internal {
        vm.prank(buyer);
        identityRegistry.register();

        deposits.setCreditLimitOverride(buyer, type(uint256).max);

        uint256 nonce = deposits.getOperatorNonce(buyer);
        bytes32 structHash = keccak256(abi.encode(SET_OPERATOR_TYPEHASH, buyerOperator, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", deposits.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, digest);
        deposits.setOperator(buyer, buyerOperator, nonce, abi.encodePacked(r, s, v));

        usdc.mint(buyerOperator, depositAmount);
        vm.startPrank(buyerOperator);
        usdc.approve(address(deposits), depositAmount);
        deposits.deposit(buyer, depositAmount);
        vm.stopPrank();
    }

    function _createSeller(address sellerAddress) internal {
        vm.prank(sellerAddress);
        uint256 agentId = identityRegistry.register();

        usdc.mint(sellerAddress, STAKE_AMOUNT);
        vm.startPrank(sellerAddress);
        usdc.approve(address(staking), STAKE_AMOUNT);
        staking.stake(agentId, STAKE_AMOUNT);
        vm.stopPrank();
    }

    function _reserve(address sellerAddress, bytes32 salt, uint128 maxAmount) internal returns (bytes32 channelId) {
        channelId = channels.computeChannelId(buyer, sellerAddress, salt);
        uint256 deadline = block.timestamp + 1 days;
        bytes memory reserveSig = _signReserveAuth(channelId, maxAmount, deadline);
        vm.prank(sellerAddress);
        channels.reserve(buyer, salt, maxAmount, deadline, reserveSig);
    }

    function _settle(address sellerAddress, bytes32 channelId, uint128 cumulativeAmount) internal {
        bytes memory metadata = _encodeMetadata(cumulativeAmount, 0);
        bytes memory sig = _signSpendingAuth(channelId, cumulativeAmount, metadata);
        vm.prank(sellerAddress);
        channels.settle(channelId, cumulativeAmount, metadata, sig);
    }

    function _signReserveAuth(bytes32 channelId, uint128 maxAmount, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(RESERVE_AUTH_TYPEHASH, channelId, maxAmount, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, _hashTypedDataChannels(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _signSpendingAuth(bytes32 channelId, uint256 cumulativeAmount, bytes memory metadata)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(SPENDING_AUTH_TYPEHASH, channelId, cumulativeAmount, keccak256(metadata)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_PK, _hashTypedDataChannels(structHash));
        return abi.encodePacked(r, s, v);
    }

    function _hashTypedDataChannels(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", channels.domainSeparator(), structHash));
    }

    function _encodeMetadata(uint256 inputTokens, uint256 outputTokens) internal pure returns (bytes memory) {
        return abi.encode(METADATA_VERSION, inputTokens, outputTokens, uint256(0));
    }

    function _epochList(uint256 epoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }
}
