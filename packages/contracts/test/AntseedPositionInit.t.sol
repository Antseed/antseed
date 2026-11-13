// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedPositionInit } from "../sellers/AntseedPositionInit.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

contract MockLegacySellerStaking {
    mapping(address => uint256) public sellerAgentId;
    mapping(address => bool) public stakedAboveMin;

    function setAgent(address seller, uint256 agentId) external {
        sellerAgentId[seller] = agentId;
    }

    function setStakedAboveMin(address seller, bool value) external {
        stakedAboveMin[seller] = value;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return sellerAgentId[seller];
    }

    function isStakedAboveMin(address seller) external view returns (bool) {
        return stakedAboveMin[seller];
    }
}

contract MockSellerOperatorsForInit {
    mapping(address => bool) public isOperator;

    function setOperator(address operator, bool enabled) external {
        isOperator[operator] = enabled;
    }
}

contract AntseedPositionInitTest is Test {
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint256 constant INIT_AMOUNT = 1 ether;
    uint256 constant INIT_END_EPOCH = 105;

    ANTSToken token;
    AntseedRegistry registry;
    MockERC8004Registry identityRegistry;
    MockLegacySellerStaking legacyStaking;
    AntseedSellerPools pools;
    AntseedSellerRegistry sellerRegistry;
    AntseedPositionInit positionInit;

    address seller = address(0x100);
    address otherSeller = address(0x200);
    address outsider = address(0x300);

    uint256 agentId;
    uint256 otherAgentId;
    uint256 genesis;

    function setUp() public {
        vm.warp(1_700_000_000);
        genesis = block.timestamp;
        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        legacyStaking = new MockLegacySellerStaking();
        token = new ANTSToken();
        token.setRegistry(address(registry));
        registry.setAntsToken(address(token));
        registry.setEmissions(address(this));
        registry.setIdentityRegistry(address(identityRegistry));

        pools = new AntseedSellerPools(address(token), address(this), address(identityRegistry), address(0));
        sellerRegistry = new AntseedSellerRegistry(address(identityRegistry), address(pools), address(legacyStaking));
        pools.setStakingSource(address(sellerRegistry));

        positionInit = new AntseedPositionInit(address(pools), address(legacyStaking), INIT_AMOUNT, INIT_END_EPOCH);

        token.setTransferWhitelist(address(pools), true);
        token.setTransferWhitelist(address(positionInit), true);
        token.mint(address(positionInit), 10 * INIT_AMOUNT);

        // Legacy sellers: agent registered in the identity registry and bound
        // with USDC stake in the legacy staking contract.
        agentId = _registerLegacySeller(seller);
        otherAgentId = _registerLegacySeller(otherSeller);
    }

    function currentEpoch() external view returns (uint256) {
        if (block.timestamp <= genesis) return 0;
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function _registerLegacySeller(address account) internal returns (uint256 id) {
        vm.prank(account);
        id = identityRegistry.register();
        legacyStaking.setAgent(account, id);
        legacyStaking.setStakedAboveMin(account, true);
    }

    function test_initCreatesPositionOwnedBySeller() public {
        assertFalse(token.transfersEnabled());

        vm.prank(seller);
        uint256 positionId = positionInit.initPosition();

        assertEq(pools.ownerOf(positionId), seller);
        (, uint256 positionAgentId, uint256 amount,,, uint64 stakeEndEpoch,,) = pools.positions(positionId);
        assertEq(positionAgentId, agentId);
        assertEq(amount, INIT_AMOUNT);
        assertEq(stakeEndEpoch, INIT_END_EPOCH);
        assertTrue(positionInit.agentInitialized(agentId));
        assertEq(token.balanceOf(address(positionInit)), 9 * INIT_AMOUNT);
        assertEq(positionInit.remainingInits(), 9);
    }

    function test_positionPowerActivatesAtNextEpoch() public {
        vm.prank(seller);
        uint256 positionId = positionInit.initPosition();

        assertEq(pools.poolWeightAtEpoch(agentId, 0), 0);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.positionWeightAtEpoch(positionId, 1), INIT_AMOUNT * (INIT_END_EPOCH - 1));
        assertEq(pools.poolWeightAtEpoch(agentId, 1), INIT_AMOUNT * (INIT_END_EPOCH - 1));
        assertEq(pools.poolActiveStakeAtEpoch(agentId, 1), INIT_AMOUNT);
    }

    function test_explicitSellerCanInitItself() public {
        vm.prank(seller);
        uint256 positionId = positionInit.initPosition(seller);
        assertEq(pools.ownerOf(positionId), seller);
        assertTrue(positionInit.agentInitialized(agentId));

        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.AlreadyInitialized.selector);
        positionInit.initPosition();
    }

    function test_operatorOwnsPositionInContractSellersPool() public {
        MockSellerOperatorsForInit proxy = new MockSellerOperatorsForInit();
        uint256 proxyAgentId = _registerLegacySeller(address(proxy));
        proxy.setOperator(outsider, true);

        vm.expectEmit(true, true, false, true, address(positionInit));
        emit AntseedPositionInit.PositionInitialized(
            address(proxy), proxyAgentId, pools.nextPositionId(), INIT_AMOUNT, 104
        );
        vm.prank(outsider);
        uint256 positionId = positionInit.initPosition(address(proxy));

        assertFalse(token.transfersEnabled());
        assertEq(pools.ownerOf(positionId), outsider);
        (, uint256 positionAgentId, uint256 amount,,,,,) = pools.positions(positionId);
        assertEq(positionAgentId, proxyAgentId);
        assertEq(amount, INIT_AMOUNT);
        assertTrue(positionInit.agentInitialized(proxyAgentId));
        assertEq(positionInit.remainingInits(), 9);

        vm.warp(block.timestamp + EPOCH_DURATION);
        assertEq(pools.poolActiveStakeAtEpoch(proxyAgentId, 1), INIT_AMOUNT);
        assertEq(pools.poolWeightAtEpoch(proxyAgentId, 1), INIT_AMOUNT * 104);
    }

    function test_differentOperatorsCannotClaimSameSellerTwice() public {
        MockSellerOperatorsForInit proxy = new MockSellerOperatorsForInit();
        _registerLegacySeller(address(proxy));
        proxy.setOperator(outsider, true);
        proxy.setOperator(otherSeller, true);
        vm.prank(outsider);
        positionInit.initPosition(address(proxy));

        vm.prank(otherSeller);
        vm.expectRevert(AntseedPositionInit.AlreadyInitialized.selector);
        positionInit.initPosition(address(proxy));
    }

    function test_unauthorizedAndRevokedOperatorsCannotInit() public {
        MockSellerOperatorsForInit proxy = new MockSellerOperatorsForInit();
        uint256 proxyAgentId = _registerLegacySeller(address(proxy));
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotOperator.selector);
        positionInit.initPosition(address(proxy));

        proxy.setOperator(outsider, true);
        proxy.setOperator(outsider, false);
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotOperator.selector);
        positionInit.initPosition(address(proxy));
        assertFalse(positionInit.agentInitialized(proxyAgentId));
        assertEq(positionInit.remainingInits(), 10);
    }

    function test_operatorCannotBypassSellerEligibility() public {
        MockSellerOperatorsForInit proxy = new MockSellerOperatorsForInit();
        uint256 proxyAgentId = _registerLegacySeller(address(proxy));
        proxy.setOperator(seller, true);
        legacyStaking.setStakedAboveMin(address(proxy), false);
        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition(address(proxy));

        assertFalse(positionInit.agentInitialized(proxyAgentId));
        assertEq(positionInit.remainingInits(), 10);
    }

    function test_otherEoaAndContractWithoutOperatorGetterReject() public {
        vm.startPrank(outsider);
        vm.expectRevert(AntseedPositionInit.NotOperator.selector);
        positionInit.initPosition(seller);
        vm.expectRevert(AntseedPositionInit.NotOperator.selector);
        positionInit.initPosition(address(legacyStaking));
        vm.stopPrank();
    }

    function test_revertingOrMalformedOperatorGetterRejects() public {
        MockSellerOperatorsForInit proxy = new MockSellerOperatorsForInit();
        bytes memory query = abi.encodeWithSignature("isOperator(address)", outsider);
        vm.mockCallRevert(address(proxy), query, abi.encode("unavailable"));
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotOperator.selector);
        positionInit.initPosition(address(proxy));
        vm.clearMockedCalls();

        vm.mockCall(address(proxy), query, hex"01");
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotOperator.selector);
        positionInit.initPosition(address(proxy));
        vm.mockCall(address(proxy), query, abi.encode(uint256(2)));
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotOperator.selector);
        positionInit.initPosition(address(proxy));
    }

    function test_zeroSellerRejects() public {
        vm.expectRevert(AntseedPositionInit.InvalidAddress.selector);
        positionInit.initPosition(address(0));
    }

    function test_latePositionNeverOutweighsEarlyPosition() public {
        vm.prank(seller);
        uint256 earlyPositionId = positionInit.initPosition();

        // Ten epochs later another seller claims; both positions share the
        // same end epoch, so from the late position's activation onward their
        // power is identical at every epoch.
        vm.warp(block.timestamp + 10 * EPOCH_DURATION);
        vm.prank(otherSeller);
        uint256 latePositionId = positionInit.initPosition();

        (,,,,, uint64 lateEndEpoch,,) = pools.positions(latePositionId);
        assertEq(lateEndEpoch, INIT_END_EPOCH);

        vm.warp(block.timestamp + EPOCH_DURATION);
        uint256 epoch = 11;
        uint256 expectedWeight = INIT_AMOUNT * (INIT_END_EPOCH - epoch);
        assertEq(pools.positionWeightAtEpoch(earlyPositionId, epoch), expectedWeight);
        assertEq(pools.positionWeightAtEpoch(latePositionId, epoch), expectedWeight);
    }

    function test_initsExpireAtEndEpoch() public {
        // Last claimable epoch: activation (currentEpoch + 1) must stay
        // below the shared end epoch.
        vm.warp(genesis + (INIT_END_EPOCH - 2) * EPOCH_DURATION);
        vm.prank(seller);
        uint256 positionId = positionInit.initPosition();
        (,,,, uint64 startEpoch, uint64 stakeEndEpoch,,) = pools.positions(positionId);
        assertEq(startEpoch, INIT_END_EPOCH - 1);
        assertEq(stakeEndEpoch, INIT_END_EPOCH);

        vm.warp(genesis + (INIT_END_EPOCH - 1) * EPOCH_DURATION);
        vm.prank(otherSeller);
        vm.expectRevert(AntseedPositionInit.InitExpired.selector);
        positionInit.initPosition();
    }

    function test_oneInitPerAgent() public {
        vm.prank(seller);
        positionInit.initPosition();

        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.AlreadyInitialized.selector);
        positionInit.initPosition();
    }

    function test_unknownSellerReverts() public {
        vm.prank(outsider);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition();
    }

    function test_sellerBelowLegacyMinStakeReverts() public {
        legacyStaking.setStakedAboveMin(seller, false);

        vm.prank(seller);
        vm.expectRevert(AntseedPositionInit.NotLegacySeller.selector);
        positionInit.initPosition();
    }

    function test_depletedPotBlocksInitsUntilRefunded() public {
        AntseedPositionInit smallInit =
            new AntseedPositionInit(address(pools), address(legacyStaking), INIT_AMOUNT, INIT_END_EPOCH);
        token.setTransferWhitelist(address(smallInit), true);
        token.mint(address(smallInit), INIT_AMOUNT);

        vm.prank(seller);
        smallInit.initPosition();
        assertEq(smallInit.remainingInits(), 0);

        vm.prank(otherSeller);
        vm.expectRevert(AntseedPositionInit.InitDepleted.selector);
        smallInit.initPosition();

        token.mint(address(smallInit), INIT_AMOUNT);
        vm.prank(otherSeller);
        smallInit.initPosition();
        assertTrue(smallInit.agentInitialized(otherAgentId));
    }

    function test_initRevertsWithoutTransferWhitelist() public {
        AntseedPositionInit unlisted =
            new AntseedPositionInit(address(pools), address(legacyStaking), INIT_AMOUNT, INIT_END_EPOCH);
        token.mint(address(unlisted), INIT_AMOUNT);

        vm.prank(seller);
        vm.expectRevert(ANTSToken.TransfersNotEnabled.selector);
        unlisted.initPosition();
    }

    function test_constructorValidation() public {
        vm.expectRevert(AntseedPositionInit.InvalidAddress.selector);
        new AntseedPositionInit(address(0), address(legacyStaking), INIT_AMOUNT, INIT_END_EPOCH);

        vm.expectRevert(AntseedPositionInit.InvalidAddress.selector);
        new AntseedPositionInit(address(pools), address(0), INIT_AMOUNT, INIT_END_EPOCH);

        vm.expectRevert(AntseedPositionInit.InvalidValue.selector);
        new AntseedPositionInit(address(pools), address(legacyStaking), 0, INIT_END_EPOCH);

        // End epoch must be in the future relative to the pools' clock.
        vm.warp(genesis + 5 * EPOCH_DURATION);
        vm.expectRevert(AntseedPositionInit.InvalidValue.selector);
        new AntseedPositionInit(address(pools), address(legacyStaking), INIT_AMOUNT, 5);
    }
}
