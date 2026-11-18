// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { IERC721Receiver } from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import { IERC721Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

contract PositionReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract MockLegacyStaking {
    mapping(address => uint256) public agentIds;
    mapping(address => bool) public staked;

    function setAgent(address seller, uint256 agentId) external {
        agentIds[seller] = agentId;
    }

    function setStaked(address seller, bool value) external {
        staked[seller] = value;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIds[seller];
    }

    function isStakedAboveMin(address seller) external view returns (bool) {
        return staked[seller];
    }
}

contract AntseedSellerPoolsTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    MockERC8004Registry identityRegistry;
    AntseedSellerPools pools;
    AntseedSellerRegistry sellerRegistry;

    address seller = address(0x100);
    address buyerSeller = address(0x200);
    address staker = address(0x300);
    address recipient = address(0x400);
    address newOwner = address(0x500);

    uint256 agentId;
    uint256 otherAgentId;
    uint256 genesis;
    uint256 constant EPOCH_DURATION = 1 weeks;

    function setUp() public {
        vm.warp(1_700_000_000);
        genesis = block.timestamp;
        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        token = new ANTSToken();
        token.setRegistry(address(registry));
        registry.setAntsToken(address(token));
        registry.setEmissions(address(this));
        registry.setIdentityRegistry(address(identityRegistry));

        pools = new AntseedSellerPools(address(token), address(this), address(identityRegistry), address(0));
        token.setTransferWhitelist(address(pools), true);
        sellerRegistry = new AntseedSellerRegistry(address(identityRegistry), address(pools), address(0));
        registry.setStaking(address(sellerRegistry));
        pools.setStakingSource(address(sellerRegistry));
        vm.prank(seller);
        agentId = identityRegistry.register();
        vm.prank(seller);
        sellerRegistry.registerSeller(agentId);

        vm.prank(buyerSeller);
        otherAgentId = identityRegistry.register();
        vm.prank(buyerSeller);
        sellerRegistry.registerSeller(otherAgentId);

        token.mint(staker, 1_000 ether);
        token.mint(address(pools), 10_000 ether);
    }

    function currentEpoch() external view returns (uint256) {
        if (block.timestamp <= genesis) return 0;
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function test_constructorRejectsZeroCoreAddresses() public {
        vm.expectRevert(IAntseedSellerPools.InvalidAddress.selector);
        new AntseedSellerPools(address(0), address(this), address(identityRegistry), address(0));

        vm.expectRevert(IAntseedSellerPools.InvalidAddress.selector);
        new AntseedSellerPools(address(token), address(0), address(identityRegistry), address(0));

        vm.expectRevert(IAntseedSellerPools.InvalidAddress.selector);
        new AntseedSellerPools(address(token), address(this), address(0), address(0));
    }

    function test_stakeActivatesNextEpochAndUsesAgentIdWeight() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        assertEq(pools.poolWeightAtEpoch(agentId, 0), 0);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 0), 0);
        assertEq(pools.positionWeightAtEpoch(positionId, 0), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 100 ether);
        assertEq(pools.poolWeightAtEpoch(seller, 1), 400 ether);
    }

    function test_stakeActivationDelayControlsNewStakeStartEpoch() public {
        pools.setPoolConfig(1, 2, 5_000, 500);

        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            pools.positions(positionId);
        assertEq(amount, 100 ether);
        assertEq(weightAmount, 100 ether);
        assertEq(startEpoch, 2);
        assertEq(stakeEndEpoch, 6);

        assertEq(pools.positionWeightAtEpoch(positionId, 1), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 0);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 0);

        assertEq(pools.positionWeightAtEpoch(positionId, 2), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 2), 100 ether);
    }

    function test_stakeForPullsFromCallerAndGivesPositionToStaker() public {
        token.mint(recipient, 100 ether);
        token.setTransferWhitelist(recipient, true);

        vm.startPrank(recipient);
        token.approve(address(pools), 100 ether);
        uint256 positionId = pools.stakeFor(staker, agentId, 100 ether, 4);
        vm.stopPrank();

        (address owner, uint256 positionAgentId, uint256 amount, uint256 weightAmount, uint64 startEpoch,,,) =
            pools.positions(positionId);
        assertEq(owner, staker);
        assertEq(pools.ownerOf(positionId), staker);
        assertEq(positionAgentId, agentId);
        assertEq(amount, 100 ether);
        assertEq(weightAmount, 100 ether);
        assertEq(startEpoch, 1);
        assertEq(token.balanceOf(recipient), 0);
        assertEq(token.balanceOf(staker), 1_000 ether);
        assertEq(pools.stakerTotalActiveStake(staker), 100 ether);
        assertEq(pools.stakerTotalActiveStake(recipient), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);

        vm.prank(recipient);
        vm.expectRevert(IAntseedSellerPools.NotPositionOwner.selector);
        pools.moveStake(positionId, otherAgentId);

        vm.prank(staker);
        pools.moveStake(positionId, otherAgentId);
    }

    function test_stakeAndMoveRejectUnregisteredAgents() public {
        uint256 unregisteredAgentId = otherAgentId + 1_000;

        vm.startPrank(staker);
        token.approve(address(pools), 1 ether);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.stakeFor(staker, unregisteredAgentId, 1 ether, 1);
        vm.stopPrank();

        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.moveStake(positionId, unregisteredAgentId);

        (,,,,,, uint64 closedAtEpoch,) = pools.positions(positionId);
        assertEq(closedAtEpoch, 0);

        uint256[] memory positionIds = new uint256[](1);
        positionIds[0] = positionId;

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.moveStakes(positionIds, unregisteredAgentId);
    }

    function test_lantsReceiptTransfersPositionRights() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        pools.transferFrom(staker, recipient, positionId);

        assertEq(pools.ownerOf(positionId), recipient);
        (address owner,,,,,,,) = pools.positions(positionId);
        assertEq(owner, recipient);
        assertEq(pools.stakerPositionCount(staker), 0);
        assertEq(pools.stakerPositionCount(recipient), 1);
        assertEq(pools.stakerPositionIdAt(recipient, 0), positionId);
        assertEq(pools.stakerTotalActiveStake(staker), 0);
        assertEq(pools.stakerAgentActiveStake(staker, agentId), 0);
        assertEq(pools.stakerTotalActiveStake(recipient), 100 ether);
        assertEq(pools.stakerAgentActiveStake(recipient, agentId), 100 ether);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.NotPositionOwner.selector);
        pools.withdrawStake(positionId);

        vm.prank(recipient);
        pools.withdrawStake(positionId);
        assertEq(pools.stakerPositionCount(recipient), 0);
        assertEq(pools.stakerTotalActiveStake(recipient), 0);
    }

    function test_lantsReceiptTransferCarriesMoveRights() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        pools.transferFrom(staker, recipient, positionId);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.NotPositionOwner.selector);
        pools.moveStake(positionId, otherAgentId);

        vm.prank(recipient);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        assertEq(pools.ownerOf(newPositionId), recipient);
        assertEq(pools.stakerPositionCount(recipient), 1);
        assertEq(pools.stakerPositionIdAt(recipient, 0), newPositionId);
        assertEq(pools.stakerTotalActiveStake(recipient), 100 ether);
        assertEq(pools.stakerAgentActiveStake(recipient, agentId), 0);
        assertEq(pools.stakerAgentActiveStake(recipient, otherAgentId), 100 ether);
    }

    function test_sameTermPendingStakeCreatesSeparatePositionsAndIdsArePaged() public {
        uint256 firstPositionId = _stake(staker, agentId, 100 ether, 4);

        token.mint(staker, 50 ether);
        vm.startPrank(staker);
        token.approve(address(pools), 50 ether);
        uint256 secondPositionId = pools.stake(agentId, 50 ether, 4);
        vm.stopPrank();

        assertEq(secondPositionId, firstPositionId + 1);
        assertEq(pools.nextPositionId(), secondPositionId + 1);
        assertEq(pools.stakerPositionCount(staker), 2);
        assertEq(pools.stakerPositionIdAt(staker, 0), firstPositionId);
        assertEq(pools.stakerPositionIdAt(staker, 1), secondPositionId);

        (,, uint256 amount, uint256 weightAmount,,,,) = pools.positions(firstPositionId);
        assertEq(amount, 100 ether);
        assertEq(weightAmount, 100 ether);

        (,, amount, weightAmount,,,,) = pools.positions(secondPositionId);
        assertEq(amount, 50 ether);
        assertEq(weightAmount, 50 ether);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(firstPositionId, 1), 400 ether);
        assertEq(pools.positionWeightAtEpoch(secondPositionId, 1), 200 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 600 ether);

        uint256 thirdPositionId = _stake(staker, otherAgentId, 25 ether, 4);
        assertEq(thirdPositionId, secondPositionId + 1);
        assertEq(pools.stakerPositionCount(staker), 3);

        uint256[] memory firstPage = pools.stakerPositionIds(staker, 0, 2);
        assertEq(firstPage.length, 2);
        assertEq(firstPage[0], firstPositionId);
        assertEq(firstPage[1], secondPositionId);

        uint256[] memory secondPage = pools.stakerPositionIds(staker, 2, 10);
        assertEq(secondPage.length, 1);
        assertEq(secondPage[0], thirdPositionId);

        uint256[] memory emptyPage = pools.stakerPositionIds(staker, 3, 10);
        assertEq(emptyPage.length, 0);
    }

    function test_thousandStakersContributeLargePoolWeightExactly() public {
        uint256 stakerCount = 1_000;
        uint256 stakeAmount = 1_000 ether;

        for (uint256 i = 0; i < stakerCount; i++) {
            address account = address(uint160(0x10000 + i));
            _stake(account, agentId, stakeAmount, 52);
        }

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), stakerCount * stakeAmount);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), stakerCount * stakeAmount * 52);
    }

    function test_expiredMaxDurationStakeDoesNotCorruptHighEpochPower() public {
        _stake(staker, agentId, 1 ether, 52); // active on [1, 53)

        vm.warp(genesis + 53 * EPOCH_DURATION);
        _stake(recipient, agentId, 10 ether, 1); // active on [54, 55)

        assertEq(pools.poolActiveStakeAtEpoch(agentId, 54), 10 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 54), 10 ether);
        assertEq(pools.totalPowerWeightAtEpoch(54), 10 ether);
    }

    function test_rewardStakerCanStakeMintedRewardsIntoNewLockedPosition() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        pools.setRewardStaker(address(this), true);
        token.mint(address(pools), 400 ether);

        uint256 beforeBalance = token.balanceOf(staker);
        uint256 newPositionId = pools.stakeMintedReward(staker, positionId, 400 ether, 3);

        assertEq(token.balanceOf(staker), beforeBalance);

        (
            address owner,
            uint256 positionAgentId,
            uint256 amount,
            uint256 weightAmount,
            uint64 startEpoch,
            uint64 stakeEndEpoch,
            uint64 closedAtEpoch,
            bool withdrawn
        ) = pools.positions(newPositionId);
        assertEq(owner, staker);
        assertEq(positionAgentId, agentId);
        assertEq(amount, 400 ether);
        uint256 expectedBonusBps = (uint256(500) * 3) / 104;
        uint256 expectedWeightAmount = (uint256(400 ether) * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(weightAmount, expectedWeightAmount);
        assertEq(startEpoch, 1);
        assertEq(stakeEndEpoch, 4);
        assertEq(closedAtEpoch, 0);
        assertFalse(withdrawn);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 1), expectedWeightAmount * 3);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 100 ether + expectedWeightAmount);
    }

    function test_stakeActivationDelayControlsMintedRewardStartEpoch() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        pools.setRewardStaker(address(this), true);
        token.mint(address(pools), 400 ether);
        vm.warp(block.timestamp + EPOCH_DURATION);
        pools.setPoolConfig(1, 2, 5_000, 500);

        uint256 newPositionId = pools.stakeMintedReward(staker, positionId, 400 ether, 4);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            pools.positions(newPositionId);
        uint256 expectedBonusBps = (uint256(500) * 4) / 104;
        uint256 expectedWeightAmount = (uint256(400 ether) * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(amount, 400 ether);
        assertEq(weightAmount, expectedWeightAmount);
        assertEq(startEpoch, 3);
        assertEq(stakeEndEpoch, 7);

        assertEq(pools.positionWeightAtEpoch(newPositionId, 2), 0);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 2), 100 ether);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 3), expectedWeightAmount * 4);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 3), 100 ether + expectedWeightAmount);
    }

    function test_restakedRewardBonusReachesConfiguredRateAtMaxLock() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        pools.setRewardStaker(address(this), true);
        token.mint(address(pools), 400 ether);
        uint256 newPositionId = pools.stakeMintedReward(staker, positionId, 400 ether, 104);

        (,,, uint256 weightAmount,,,,) = pools.positions(newPositionId);
        assertEq(weightAmount, 420 ether);
    }

    function test_anyStakerCanMoveStakeBetweenAgentPools() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 1), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 0);
        assertEq(pools.poolActiveStakeAtEpoch(otherAgentId, 1), 100 ether);
    }

    function test_moveWeightPenaltyReducesMovedPowerButKeepsPrincipal() public {
        pools.setMoveWeightPenalty(2_000);
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.prank(staker);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            pools.positions(newPositionId);
        assertEq(amount, 100 ether);
        assertEq(weightAmount, 80 ether);
        assertEq(startEpoch, 1);
        assertEq(stakeEndEpoch, 5);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 0);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 1), 320 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 0);
        assertEq(pools.poolWeightAtEpoch(otherAgentId, 1), 320 ether);
        assertEq(pools.stakerTotalActiveStake(staker), 100 ether);
        assertEq(pools.stakerAgentActiveStake(staker, agentId), 0);
        assertEq(pools.stakerAgentActiveStake(staker, otherAgentId), 100 ether);
    }

    function test_extendLockOnlyChangesFutureEpochPower() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 400 ether);
        assertEq(pools.positionWeightAtEpoch(positionId, 2), 300 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 300 ether);

        vm.prank(staker);
        pools.extendLock(positionId, 3);

        (,,,,, uint64 stakeEndEpoch,,) = pools.positions(positionId);
        assertEq(stakeEndEpoch, 8);

        assertEq(pools.positionWeightAtEpoch(positionId, 1), 400 ether);
        assertEq(pools.positionWeightAtEpoch(positionId, 2), 600 ether);
        assertEq(pools.positionWeightAtEpoch(positionId, 7), 100 ether);
        assertEq(pools.positionWeightAtEpoch(positionId, 8), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 600 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 7), 100 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 8), 0);
    }

    function test_extendLockCapsAtMaxDurationAndRejectsInvalidStates() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        vm.prank(staker);
        pools.extendLock(positionId, 0);

        vm.prank(staker);
        pools.extendLock(positionId, 100);

        (,,,,, uint64 stakeEndEpoch,,) = pools.positions(positionId);
        assertEq(stakeEndEpoch, 105);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 10_400 ether);

        vm.expectRevert(IAntseedSellerPools.StakeDurationOutOfBounds.selector);
        vm.prank(staker);
        pools.extendLock(positionId, 1);

        uint256 maxLockPositionId = _stake(staker, otherAgentId, 100 ether, 4);
        vm.warp(block.timestamp + EPOCH_DURATION);
        vm.prank(staker);
        pools.enableMaxLock(maxLockPositionId);

        vm.expectRevert(IAntseedSellerPools.PositionClosed.selector);
        vm.prank(staker);
        pools.extendLock(maxLockPositionId, 1);
    }

    function test_batchMoveCreatesPortfolioPositions() public {
        uint256 firstPositionId = _stake(staker, agentId, 100 ether, 4);
        uint256 secondPositionId = _stake(staker, agentId, 50 ether, 3);

        uint256[] memory positionIds = new uint256[](2);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;

        vm.prank(staker);
        uint256[] memory newPositionIds = pools.moveStakes(positionIds, otherAgentId);

        assertEq(newPositionIds.length, 2);
        assertEq(pools.stakerPositionCount(staker), 2);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 0);
        assertEq(pools.poolActiveStakeAtEpoch(otherAgentId, 1), 150 ether);
        assertEq(pools.positionWeightAtEpoch(newPositionIds[0], 1), 400 ether);
        assertEq(pools.positionWeightAtEpoch(newPositionIds[1], 1), 150 ether);
    }

    function test_sellerCanStakeAndMoveLikeAnyOtherStaker() public {
        uint256 positionId = _stake(seller, agentId, 100 ether, 4);

        vm.prank(seller);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(newPositionId, 1), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(otherAgentId, 1), 100 ether);
    }

    function test_earlyWithdrawClosesInExitEpochAndSlashes() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        // Withdrawing during epoch 1 means no epoch was ever served in full,
        // so the whole term is unserved and the slash is at the max rate.
        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 expectedSlashBps = pools.earlyExitSlashBps(positionId);
        assertEq(expectedSlashBps, 5_000);

        vm.prank(staker);
        pools.withdrawStake(positionId);

        assertEq(pools.positionWeightAtEpoch(positionId, 1), 0);
        assertEq(pools.positionWeightAtEpoch(positionId, 2), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 0);

        uint256 expectedSlash = (100 ether * expectedSlashBps) / 10_000;
        assertEq(token.balanceOf(pools.DEAD_ADDRESS()), expectedSlash);
        assertEq(token.balanceOf(staker), 1_000 ether + (100 ether - expectedSlash));
    }

    function test_withdrawRevertsWhileScheduledMaxLockIsPending() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        vm.warp(genesis + EPOCH_DURATION);

        vm.prank(staker);
        pools.enableMaxLock(positionId);

        // The max lock only takes effect next epoch; withdrawing now would
        // leave its scheduled pool power behind with no position backing it.
        vm.expectRevert(IAntseedSellerPools.PositionChangePending.selector);
        vm.prank(staker);
        pools.withdrawStake(positionId);

        // Once live, the normal max-lock rule applies.
        vm.warp(genesis + 2 * EPOCH_DURATION);
        vm.expectRevert(IAntseedSellerPools.PositionClosed.selector);
        vm.prank(staker);
        pools.withdrawStake(positionId);
    }

    function test_withdrawRevertsWhileScheduledExtensionIsPending() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        vm.warp(genesis + EPOCH_DURATION);

        vm.prank(staker);
        pools.extendLock(positionId, 4);

        vm.expectRevert(IAntseedSellerPools.PositionChangePending.selector);
        vm.prank(staker);
        pools.withdrawStake(positionId);

        // Next epoch the extension is live and withdrawal removes it in full.
        vm.warp(genesis + 2 * EPOCH_DURATION);
        vm.prank(staker);
        pools.withdrawStake(positionId);

        assertEq(pools.poolWeightAtEpoch(agentId, 2), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 6), 0);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 2), 0);
    }

    function test_maxLockedPositionMustDisableBeforeWithdrawAndThenSlashesFreshCountdown() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        vm.warp(block.timestamp + EPOCH_DURATION);
        vm.prank(staker);
        pools.enableMaxLock(positionId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.PositionClosed.selector);
        pools.withdrawStake(positionId);
        assertEq(pools.earlyExitSlashBps(positionId), pools.maxSlashBps());

        vm.prank(staker);
        pools.disableMaxLock(positionId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 expectedSlashBps = pools.earlyExitSlashBps(positionId);
        assertEq(expectedSlashBps, pools.maxSlashBps());

        vm.prank(staker);
        pools.withdrawStake(positionId);

        uint256 expectedSlash = (100 ether * expectedSlashBps) / 10_000;
        assertEq(pools.positionWeightAtEpoch(positionId, 3), 0);
        assertEq(pools.positionWeightAtEpoch(positionId, 4), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 3), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 4), 0);
        assertEq(token.balanceOf(pools.DEAD_ADDRESS()), expectedSlash);
        assertEq(token.balanceOf(staker), 1_000 ether + (100 ether - expectedSlash));
    }

    function test_batchWithdrawAggregatesTransfersAndSlashes() public {
        uint256 firstPositionId = _stake(staker, agentId, 100 ether, 4);
        uint256 secondPositionId = _stake(staker, otherAgentId, 50 ether, 3);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 firstSlashBps = pools.earlyExitSlashBps(firstPositionId);
        uint256 secondSlashBps = pools.earlyExitSlashBps(secondPositionId);

        uint256[] memory positionIds = new uint256[](2);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;

        vm.prank(staker);
        (uint256 returnedAmount, uint256 slashedAmount) = pools.withdrawStakes(positionIds);

        uint256 expectedSlash = ((100 ether * firstSlashBps) / 10_000) + ((50 ether * secondSlashBps) / 10_000);
        assertEq(slashedAmount, expectedSlash);
        assertEq(returnedAmount, 150 ether - expectedSlash);
        assertEq(token.balanceOf(pools.DEAD_ADDRESS()), expectedSlash);
        assertEq(token.balanceOf(staker), 1_000 ether + returnedAmount);
        assertEq(pools.positionWeightAtEpoch(firstPositionId, 2), 0);
        assertEq(pools.positionWeightAtEpoch(secondPositionId, 2), 0);
        assertEq(pools.stakerPositionCount(staker), 0);
    }

    function test_agentSaleMovesSellerResolutionButKeepsPoolStake() public {
        _stake(staker, agentId, 100 ether, 4);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(sellerRegistry.getStake(seller), 100 ether);

        vm.prank(seller);
        identityRegistry.transferAgent(agentId, newOwner);
        vm.prank(newOwner);
        sellerRegistry.registerSeller(agentId);

        assertEq(pools.agentIdForSeller(seller), 0);
        assertEq(pools.agentIdForSeller(newOwner), agentId);
        assertEq(sellerRegistry.getStake(seller), 0);
        assertEq(sellerRegistry.getStake(newOwner), 100 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);
    }

    function test_stakeForRevertsWhenContractRecipientCannotReceivePositions() public {
        token.setTransferWhitelist(staker, true);
        vm.startPrank(staker);
        token.approve(address(pools), 100 ether);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(token)));
        pools.stakeFor(address(token), agentId, 100 ether, 4);
        vm.stopPrank();
    }

    function test_stakeForMintsToContractImplementingReceiver() public {
        PositionReceiver receiverContract = new PositionReceiver();

        token.setTransferWhitelist(staker, true);
        vm.startPrank(staker);
        token.approve(address(pools), 100 ether);
        uint256 positionId = pools.stakeFor(address(receiverContract), agentId, 100 ether, 4);
        vm.stopPrank();

        assertEq(pools.ownerOf(positionId), address(receiverContract));
        assertEq(pools.stakerTotalActiveStake(address(receiverContract)), 100 ether);
    }

    function test_validationAndAdmin() public {
        vm.startPrank(staker);
        token.approve(address(pools), 1 ether);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.stake(0, 1 ether, 1);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.stake(agentId, 0, 1);
        vm.expectRevert(IAntseedSellerPools.StakeDurationOutOfBounds.selector);
        pools.stake(agentId, 1 ether, 0);
        vm.expectRevert(IAntseedSellerPools.InvalidAddress.selector);
        pools.stakeFor(address(0), agentId, 1 ether, 1);
        vm.stopPrank();

        vm.expectRevert(IAntseedSellerPools.InvalidAddress.selector);
        pools.setRewardStaker(address(0), true);
        pools.setRewardStaker(recipient, true);
        assertTrue(pools.rewardStakers(recipient));

        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.setRestakedRewardWeightBonus(2_001);
        pools.setRestakedRewardWeightBonus(1_000);
        assertEq(pools.restakedRewardWeightBonusBps(), 1_000);

        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.setMoveWeightPenalty(10_001);
        pools.setMoveWeightPenalty(2_000);
        assertEq(pools.moveWeightPenaltyBps(), 2_000);
    }

    function test_stakeActivationDelayConfigValidation() public {
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.setPoolConfig(1, 0, 5_000, 500);

        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.setPoolConfig(1, 105, 5_000, 500);

        pools.setPoolConfig(1, 2, 5_000, 500);
        assertEq(pools.stakeActivationDelay(), 2);
    }

    function test_preActivationWithdrawDoesNotCorruptOtherStakersPower() public {
        // Victim stakes with the default delay of 1: power on epochs [1, 5).
        uint256 victimPositionId = _stake(staker, agentId, 1_000 ether, 4);

        // Raise the activation delay, then a second staker stakes (power on
        // epochs [2, 6)) and withdraws in the same epoch, before activation.
        pools.setPoolConfig(1, 2, 5_000, 500);
        uint256 earlyExitPositionId = _stake(recipient, agentId, 100 ether, 4);

        vm.prank(recipient);
        pools.withdrawStake(earlyExitPositionId);

        // The withdrawn position never had power at epoch 1; the victim's
        // power and active stake there must be untouched, and epochs from the
        // would-be activation onward only hold the victim's power.
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 4_000 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), 1_000 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 3_000 ether);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 2), 1_000 ether);

        // Full-remaining early exit slashes at the max rate.
        assertEq(token.balanceOf(recipient), 50 ether);

        // The victim can still exit later without an accounting underflow.
        vm.warp(block.timestamp + EPOCH_DURATION);
        vm.prank(staker);
        pools.withdrawStake(victimPositionId);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 0);
    }

    function test_preActivationMoveKeepsActivationEpochAndPower() public {
        pools.setPoolConfig(1, 2, 5_000, 500);
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);

        // Moving before activation must not start the new position earlier
        // than the original activation epoch (no activation-delay bypass) and
        // must remove exactly the power that was added.
        vm.prank(staker);
        uint256 newPositionId = pools.moveStake(positionId, otherAgentId);

        (,,,, uint64 startEpoch, uint64 stakeEndEpoch,,) = pools.positions(newPositionId);
        assertEq(startEpoch, 2);
        assertEq(stakeEndEpoch, 6);

        assertEq(pools.poolWeightAtEpoch(agentId, 1), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 0);
        assertEq(pools.poolWeightAtEpoch(otherAgentId, 1), 0);
        assertEq(pools.poolWeightAtEpoch(otherAgentId, 2), 400 ether);
        assertEq(pools.poolActiveStakeAtEpoch(otherAgentId, 2), 100 ether);
    }

    function test_stakeRejectsAboveFixedMaxStakeEpochs() public {
        token.mint(staker, 1 ether);
        token.setTransferWhitelist(staker, true);
        vm.startPrank(staker);
        token.approve(address(pools), 1 ether);
        vm.expectRevert(IAntseedSellerPools.StakeDurationOutOfBounds.selector);
        pools.stake(agentId, 1 ether, 105);
        vm.stopPrank();
    }

    function test_sellerRegistryLegacyStakeFallbackKeepsSellersEligible() public {
        MockLegacyStaking legacy = new MockLegacyStaking();
        AntseedSellerRegistry adapter =
            new AntseedSellerRegistry(address(identityRegistry), address(pools), address(legacy));

        legacy.setAgent(seller, agentId);
        legacy.setStaked(seller, true);

        // No seller pool exists, but the legacy USDC stake keeps the seller
        // channel-eligible during the migration window.
        assertEq(adapter.getStake(seller), 0);
        assertTrue(adapter.isStakedAboveMin(seller));

        adapter.setLegacyStakeEligibilityEnabled(false);
        assertFalse(adapter.isStakedAboveMin(seller));

        // Once the agent pool holds active ANTS stake, eligibility comes from
        // the pool with the fallback disabled.
        _stake(staker, agentId, 100 ether, 4);
        vm.warp(block.timestamp + EPOCH_DURATION);
        assertTrue(adapter.isStakedAboveMin(seller));
    }

    function test_sellerRegistryAgentHandoverSupersedesLegacyBinding() public {
        MockLegacyStaking legacy = new MockLegacyStaking();
        AntseedSellerRegistry adapter =
            new AntseedSellerRegistry(address(identityRegistry), address(pools), address(legacy));

        address oldSeller = address(0x600);
        vm.prank(oldSeller);
        uint256 soldAgentId = identityRegistry.register();
        legacy.setAgent(oldSeller, soldAgentId);
        assertEq(adapter.getAgentId(oldSeller), soldAgentId);

        // The agent changes hands and the new owner registers it. The legacy
        // binding must not keep the previous seller channel-eligible on the
        // new owner's pool stake.
        vm.prank(oldSeller);
        identityRegistry.transferAgent(soldAgentId, newOwner);
        vm.prank(newOwner);
        adapter.registerSeller(soldAgentId);
        pools.setStakingSource(address(adapter));

        assertEq(adapter.getAgentId(newOwner), soldAgentId);
        assertEq(adapter.getAgentId(oldSeller), 0);

        _stake(staker, soldAgentId, 100 ether, 4);
        vm.warp(block.timestamp + EPOCH_DURATION);
        assertTrue(adapter.isStakedAboveMin(newOwner));
        assertFalse(adapter.isStakedAboveMin(oldSeller));
    }

    function test_withdrawEndsRewardPowerInTheExitEpoch() public {
        uint256 amount = 100 ether;
        uint256 positionId = _stake(staker, agentId, amount, 1);
        uint256 startEpoch = pools.currentEpoch() + 1;

        // Enter the position's only powered epoch and withdraw immediately.
        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.currentEpoch(), startEpoch);
        assertGt(pools.positionWeightAtEpoch(positionId, startEpoch), 0);

        uint256 balanceBefore = token.balanceOf(staker);
        vm.prank(staker);
        pools.withdrawStake(positionId);

        // Exiting during the powered epoch is an early exit: it is slashed...
        assertLt(token.balanceOf(staker) - balanceBefore, amount);

        // ...but the exit epoch earns nothing: reward weight and the stake
        // metric both drop with the principal, so usage recorded after the
        // withdrawal cannot reward this position.
        assertEq(pools.positionWeightAtEpoch(positionId, startEpoch), 0);
        assertEq(pools.poolWeightAtEpoch(agentId, startEpoch), 0);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, startEpoch), 0);
    }

    function test_withdrawBeforeTermStillSlashesAndKeepsEarlierEpochs() public {
        uint256 amount = 100 ether;
        uint256 positionId = _stake(staker, agentId, amount, 4);
        uint256 startEpoch = pools.currentEpoch() + 1;

        // Serve two epochs, then exit early during the third.
        vm.warp(block.timestamp + 3 * EPOCH_DURATION);
        uint256 exitEpoch = pools.currentEpoch();
        assertEq(exitEpoch, startEpoch + 2);

        uint256 balanceBefore = token.balanceOf(staker);
        vm.prank(staker);
        pools.withdrawStake(positionId);

        // Early exit is still slashed.
        assertLt(token.balanceOf(staker) - balanceBefore, amount);

        // Epochs already served keep their weight; the exit epoch loses it.
        assertGt(pools.positionWeightAtEpoch(positionId, startEpoch), 0);
        assertGt(pools.positionWeightAtEpoch(positionId, startEpoch + 1), 0);
        assertEq(pools.positionWeightAtEpoch(positionId, exitEpoch), 0);
    }

    function test_splitStakeDividesPrincipalAndWeightWithoutChangingPoolPower() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        vm.warp(block.timestamp + EPOCH_DURATION);

        vm.prank(staker);
        (uint256 firstId, uint256 secondId) = pools.splitStake(positionId, 30 ether);

        // Source keeps its power through the split epoch and closes after.
        assertEq(pools.positionWeightAtEpoch(positionId, 1), 400 ether);
        assertEq(pools.positionWeightAtEpoch(positionId, 2), 0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, positionId));
        pools.ownerOf(positionId);

        // Parts carry the remaining window (end epoch 5) pro-rata.
        assertEq(pools.positionWeightAtEpoch(firstId, 2), 70 ether * 3);
        assertEq(pools.positionWeightAtEpoch(secondId, 2), 30 ether * 3);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 100 ether * 3);
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 2), 100 ether);
        assertEq(pools.stakerTotalActiveStake(staker), 100 ether);

        (,, uint256 firstAmount,,,,,) = pools.positions(firstId);
        (,, uint256 secondAmount,,,,,) = pools.positions(secondId);
        assertEq(firstAmount, 70 ether);
        assertEq(secondAmount, 30 ether);

        // Full principal comes back at term.
        vm.warp(block.timestamp + 5 * EPOCH_DURATION);
        uint256 balanceBefore = token.balanceOf(staker);
        uint256[] memory ids = new uint256[](2);
        ids[0] = firstId;
        ids[1] = secondId;
        vm.prank(staker);
        (uint256 returned, uint256 slashed) = pools.withdrawStakes(ids);
        assertEq(returned, 100 ether);
        assertEq(slashed, 0);
        assertEq(token.balanceOf(staker), balanceBefore + 100 ether);
    }

    function test_splitStakeCannotWithdrawBeforeEffectiveEpochAndPreservesSlashBasis() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 104);
        vm.warp(block.timestamp + 52 * EPOCH_DURATION);

        vm.prank(staker);
        (uint256 firstId,) = pools.splitStake(positionId, 40 ether);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.PositionChangePending.selector);
        pools.withdrawStake(firstId);
        vm.expectRevert(IAntseedSellerPools.PositionChangePending.selector);
        pools.earlyExitSlashBps(firstId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.earlyExitSlashBps(firstId), 2500);
        uint256 balanceBefore = token.balanceOf(staker);
        vm.prank(staker);
        pools.withdrawStake(firstId);

        assertEq(token.balanceOf(staker) - balanceBefore, 45 ether);
        assertEq(pools.positionWeightAtEpoch(positionId, 52), 100 ether * 53);
        assertEq(pools.positionWeightAtEpoch(firstId, 53), 0);
    }

    function test_moveStakeCannotWithdrawBeforeEffectiveEpochAndPreservesSlashBasis() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 104);
        vm.warp(block.timestamp + 52 * EPOCH_DURATION);

        vm.prank(staker);
        uint256 movedId = pools.moveStake(positionId, otherAgentId);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.PositionChangePending.selector);
        pools.withdrawStake(movedId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 balanceBefore = token.balanceOf(staker);
        vm.prank(staker);
        pools.withdrawStake(movedId);

        assertEq(token.balanceOf(staker) - balanceBefore, 75 ether);
        assertEq(pools.positionWeightAtEpoch(positionId, 52), 100 ether * 53);
        assertEq(pools.positionWeightAtEpoch(movedId, 53), 0);
    }

    function test_chainedSameEpochSplitPreservesPowerSlashBasisAndWithdrawalEpoch() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 104);
        assertEq(pools.positionWithdrawableEpoch(positionId), 0);
        vm.warp(block.timestamp + 52 * EPOCH_DURATION);

        vm.startPrank(staker);
        (uint256 firstId, uint256 untouchedId) = pools.splitStake(positionId, 40 ether);
        (uint256 chainedFirstId, uint256 chainedSecondId) = pools.splitStake(firstId, 20 ether);
        vm.stopPrank();

        assertEq(pools.positionWithdrawableEpoch(firstId), 53);
        assertEq(pools.positionWithdrawableEpoch(untouchedId), 53);
        assertEq(pools.positionWithdrawableEpoch(chainedFirstId), 53);
        assertEq(pools.positionWithdrawableEpoch(chainedSecondId), 53);
        assertEq(pools.positionWeightAtEpoch(positionId, 52), 100 ether * 53);
        assertEq(pools.positionWeightAtEpoch(firstId, 53), 0);
        assertEq(pools.positionWeightAtEpoch(untouchedId, 53), 40 ether * 52);
        assertEq(pools.positionWeightAtEpoch(chainedFirstId, 53), 40 ether * 52);
        assertEq(pools.positionWeightAtEpoch(chainedSecondId, 53), 20 ether * 52);
        assertEq(pools.poolWeightAtEpoch(agentId, 53), 100 ether * 52);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.PositionChangePending.selector);
        pools.withdrawStake(chainedFirstId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 balanceBefore = token.balanceOf(staker);
        vm.prank(staker);
        pools.withdrawStake(chainedFirstId);

        assertEq(token.balanceOf(staker) - balanceBefore, 30 ether);
        assertEq(pools.poolWeightAtEpoch(agentId, 53), 60 ether * 52);
    }

    function test_splitStakeRequiresDisablingMaxLockFirst() public {
        uint256 positionId = _stake(staker, agentId, 100 ether, 4);
        vm.warp(block.timestamp + EPOCH_DURATION);
        vm.prank(staker);
        pools.enableMaxLock(positionId);
        vm.warp(block.timestamp + EPOCH_DURATION);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.PositionClosed.selector);
        pools.splitStake(positionId, 40 ether);

        // Disable, split, and re-enable the parts within one epoch: max power
        // stays seamless because all of it takes effect at the same next epoch.
        vm.startPrank(staker);
        pools.disableMaxLock(positionId);
        (uint256 firstId, uint256 secondId) = pools.splitStake(positionId, 40 ether);
        pools.enableMaxLock(firstId);
        pools.enableMaxLock(secondId);
        vm.stopPrank();

        uint256 maxLockPower = 100 ether * pools.MAX_STAKE_EPOCHS();
        assertEq(pools.poolWeightAtEpoch(agentId, 2), maxLockPower);
        assertEq(pools.poolWeightAtEpoch(agentId, 3), maxLockPower);
        assertEq(pools.positionMaxLockPowerAtEpoch(firstId, 3), 60 ether * pools.MAX_STAKE_EPOCHS());
        assertEq(pools.positionMaxLockPowerAtEpoch(secondId, 3), 40 ether * pools.MAX_STAKE_EPOCHS());
        assertEq(pools.positionWeightAtEpoch(positionId, 3), 0);
        assertEq(pools.stakerTotalActiveStake(staker), 100 ether);
    }

    function test_mergeStakesCombinesSameTermPositions() public {
        uint256 firstId = _stake(staker, agentId, 60 ether, 4);
        uint256 secondId = _stake(staker, agentId, 40 ether, 4);
        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256[] memory ids = new uint256[](2);
        ids[0] = firstId;
        ids[1] = secondId;
        vm.prank(staker);
        uint256 mergedId = pools.mergeStakes(ids);

        // Sources keep the merge epoch, the merged position takes over after.
        assertEq(pools.positionWeightAtEpoch(firstId, 1), 60 ether * 4);
        assertEq(pools.positionWeightAtEpoch(firstId, 2), 0);
        assertEq(pools.positionWeightAtEpoch(mergedId, 2), 100 ether * 3);
        assertEq(pools.poolWeightAtEpoch(agentId, 2), 100 ether * 3);
        assertEq(pools.stakerTotalActiveStake(staker), 100 ether);

        vm.warp(block.timestamp + 5 * EPOCH_DURATION);
        uint256 balanceBefore = token.balanceOf(staker);
        vm.prank(staker);
        pools.withdrawStake(mergedId);
        assertEq(token.balanceOf(staker), balanceBefore + 100 ether);
    }

    function test_mergeStakesCannotWithdrawBeforeEffectiveEpochAndPreservesSlashBasis() public {
        uint256 firstId = _stake(staker, agentId, 60 ether, 104);
        uint256 secondId = _stake(staker, agentId, 40 ether, 104);
        vm.warp(block.timestamp + 52 * EPOCH_DURATION);

        uint256[] memory ids = new uint256[](2);
        ids[0] = firstId;
        ids[1] = secondId;
        vm.prank(staker);
        uint256 mergedId = pools.mergeStakes(ids);

        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.PositionChangePending.selector);
        pools.withdrawStake(mergedId);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 balanceBefore = token.balanceOf(staker);
        vm.prank(staker);
        pools.withdrawStake(mergedId);

        assertEq(token.balanceOf(staker) - balanceBefore, 75 ether);
        assertEq(pools.positionWeightAtEpoch(firstId, 52), 60 ether * 53);
        assertEq(pools.positionWeightAtEpoch(secondId, 52), 40 ether * 53);
        assertEq(pools.positionWeightAtEpoch(mergedId, 53), 0);
    }

    function test_mergeStakesRejectsDifferentSlashBases() public {
        uint256 firstId = _stake(staker, agentId, 60 ether, 104);
        vm.warp(block.timestamp + 52 * EPOCH_DURATION);
        uint256 secondId = _stake(staker, agentId, 40 ether, 52);
        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256[] memory ids = new uint256[](2);
        ids[0] = firstId;
        ids[1] = secondId;
        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.mergeStakes(ids);
    }

    function test_mergeStakesRequiresDisablingMaxLockFirst() public {
        uint256 firstId = _stake(staker, agentId, 60 ether, 4);
        uint256 secondId = _stake(staker, agentId, 40 ether, 8);
        vm.warp(block.timestamp + EPOCH_DURATION);
        vm.startPrank(staker);
        pools.enableMaxLock(firstId);
        pools.enableMaxLock(secondId);
        vm.stopPrank();
        vm.warp(block.timestamp + EPOCH_DURATION);

        uint256[] memory ids = new uint256[](2);
        ids[0] = firstId;
        ids[1] = secondId;
        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.PositionClosed.selector);
        pools.mergeStakes(ids);

        // Disabling both in the same epoch aligns their end epochs, so sources
        // with different original terms become mergeable.
        vm.startPrank(staker);
        pools.disableMaxLock(firstId);
        pools.disableMaxLock(secondId);
        uint256 mergedId = pools.mergeStakes(ids);
        pools.enableMaxLock(mergedId);
        vm.stopPrank();

        uint256 maxLockPower = 100 ether * pools.MAX_STAKE_EPOCHS();
        assertEq(pools.poolWeightAtEpoch(agentId, 3), maxLockPower);
        assertEq(pools.positionMaxLockPowerAtEpoch(mergedId, 3), maxLockPower);
        assertEq(pools.stakerTotalActiveStake(staker), 100 ether);
    }

    function test_splitAndMergeRejectInvalidRequests() public {
        uint256 firstId = _stake(staker, agentId, 60 ether, 4);
        uint256 shorterId = _stake(staker, agentId, 40 ether, 2);
        uint256 otherPoolId = _stake(staker, otherAgentId, 40 ether, 4);
        vm.warp(block.timestamp + EPOCH_DURATION);

        // Split: bad amounts and wrong owner.
        vm.startPrank(staker);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.splitStake(firstId, 0);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.splitStake(firstId, 60 ether);
        vm.stopPrank();
        vm.prank(recipient);
        vm.expectRevert(IAntseedSellerPools.NotPositionOwner.selector);
        pools.splitStake(firstId, 30 ether);

        // Merge: mismatched end epochs, mismatched pools, max-locked sources,
        // duplicates, and single-element arrays.
        uint256[] memory ids = new uint256[](2);
        ids[0] = firstId;
        ids[1] = shorterId;
        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.mergeStakes(ids);

        ids[1] = otherPoolId;
        vm.prank(staker);
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.mergeStakes(ids);

        uint256 sameTermId = _stake(staker, agentId, 40 ether, 3);
        vm.startPrank(staker);
        pools.enableMaxLock(sameTermId);
        ids[1] = sameTermId;
        vm.expectRevert(IAntseedSellerPools.PositionClosed.selector);
        pools.mergeStakes(ids);

        ids[1] = firstId;
        vm.expectRevert(IAntseedSellerPools.PositionClosed.selector);
        pools.mergeStakes(ids);

        uint256[] memory single = new uint256[](1);
        single[0] = firstId;
        vm.expectRevert(IAntseedSellerPools.InvalidValue.selector);
        pools.mergeStakes(single);
        vm.stopPrank();
    }

    function _stake(address staker_, uint256 agentId_, uint256 amount, uint256 stakeEpochs)
        internal
        returns (uint256 positionId)
    {
        token.mint(staker_, amount);
        token.setTransferWhitelist(staker_, true);
        vm.startPrank(staker_);
        token.approve(address(pools), amount);
        positionId = pools.stake(agentId_, amount, stakeEpochs);
        vm.stopPrank();
    }

    function _epochList(uint256 epoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }

    function test_agentTransferEndsSellerBindingWithoutNewOwnerRegistering() public {
        _stake(staker, agentId, 100 ether, 4);
        vm.warp(block.timestamp + EPOCH_DURATION);
        assertTrue(sellerRegistry.isStakedAboveMin(seller));

        // buyerSeller is already bound to otherAgentId, so it cannot register
        // the agent it just acquired.
        vm.prank(seller);
        identityRegistry.transferAgent(agentId, buyerSeller);
        vm.prank(buyerSeller);
        vm.expectRevert(AntseedSellerRegistry.AgentIdMismatch.selector);
        sellerRegistry.registerSeller(agentId);

        // The previous seller must still lose the binding, the pool stake it
        // no longer owns, and channel eligibility.
        assertEq(sellerRegistry.getAgentId(seller), 0);
        assertEq(sellerRegistry.getStake(seller), 0);
        assertFalse(sellerRegistry.isStakedAboveMin(seller));
        assertEq(pools.agentIdForSeller(seller), 0);

        // The pool itself is untouched and keeps paying its stakers.
        assertEq(pools.poolWeightAtEpoch(agentId, 1), 400 ether);
    }

    function test_agentTransferEndsLegacyBindingWithoutNewOwnerRegistering() public {
        MockLegacyStaking legacy = new MockLegacyStaking();
        AntseedSellerRegistry adapter =
            new AntseedSellerRegistry(address(identityRegistry), address(pools), address(legacy));

        address oldSeller = address(0x600);
        vm.prank(oldSeller);
        uint256 soldAgentId = identityRegistry.register();
        legacy.setAgent(oldSeller, soldAgentId);
        legacy.setStaked(oldSeller, true);
        assertEq(adapter.getAgentId(oldSeller), soldAgentId);
        assertTrue(adapter.isStakedAboveMin(oldSeller));

        vm.prank(oldSeller);
        identityRegistry.transferAgent(soldAgentId, newOwner);

        assertEq(adapter.getAgentId(oldSeller), 0);
        assertFalse(adapter.isStakedAboveMin(oldSeller));
    }

    function test_sellerCanRebindAfterSellingItsAgentButNotWhileHoldingTwo() public {
        vm.prank(seller);
        identityRegistry.transferAgent(agentId, newOwner);

        vm.prank(seller);
        uint256 freshAgentId = identityRegistry.register();
        vm.prank(seller);
        sellerRegistry.registerSeller(freshAgentId);
        assertEq(sellerRegistry.getAgentId(seller), freshAgentId);

        // One agent per seller address still holds for an owner of two.
        vm.prank(seller);
        uint256 secondAgentId = identityRegistry.register();
        vm.prank(seller);
        vm.expectRevert(AntseedSellerRegistry.AgentIdMismatch.selector);
        sellerRegistry.registerSeller(secondAgentId);
    }
}
