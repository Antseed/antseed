// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedSellerPools } from "../../sellers/AntseedSellerPools.sol";
import { AntseedUsageAccounting } from "../../emissions/AntseedUsageAccounting.sol";
import { AntseedUsageRewards } from "../../emissions/AntseedUsageRewards.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract MockAgentLookup {
    mapping(address => uint256) public agentIdBySeller;

    function setAgent(address seller, uint256 agentId) external {
        agentIdBySeller[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIdBySeller[seller];
    }
}

contract MockDeposits {
    mapping(address => address) public operatorOf;

    function setOperator(address buyer, address operator) external {
        operatorOf[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return operatorOf[buyer];
    }
}

/**
 * @title AntseedUsageRewardsFuzz
 * @notice Fuzz tests for the direct seller/operator + buyer usage reward
 *         controller. Invariants:
 *           1. Reward split conserves: claimable + reserve == gross, gross is
 *              capped at the dynamic usage side budget, claimable capped at 5%.
 *           2. The controller never mints past its Gate share budget across
 *              both the seller and buyer side.
 *           3. Double-claim is impossible per (agent/buyer, epoch).
 *           4. Buyer hot wallet NEVER receives funds — payout goes to the
 *              Deposits operator, and the claim reverts (rolling back the
 *              claimed flag) when no operator is set.
 */
contract AntseedUsageRewardsFuzzTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissionsGate gate;
    AntseedSellerPools pools;
    AntseedUsageAccounting usageAccounting;
    AntseedUsageRewards usageRewards;
    MockAgentLookup agentLookup;
    MockERC8004Registry identity;
    MockDeposits depositsMock;

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint256 constant BPS = 100_000;
    uint256 constant MAX_REWARD_SHARE_BPS = 500; // 5% in 1e4 bps
    uint32 constant USAGE_SHARE_BPS = 20_000;
    bytes32 constant USAGE_MINTER_ID = keccak256("antseed.emissions.usage.v1");

    address legacyController = address(0xCAFE);
    address teamWallet = address(0x7EA3);
    address reserve = address(0x5E5E);
    address seller = address(0x5E11E2);
    address buyer = address(0xB0B);
    address operator = address(0x09E7A);
    address stakerAddr = address(0x57A);

    uint256 agentId;

    function setUp() public {
        vm.warp(1_700_000_000);
        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistry();
        agentLookup = new MockAgentLookup();
        identity = new MockERC8004Registry();
        depositsMock = new MockDeposits();

        registry.setAntsToken(address(token));
        registry.setEmissions(legacyController);
        registry.setTeamWallet(teamWallet);
        registry.setProtocolReserve(reserve);
        registry.setDeposits(address(depositsMock));
        registry.setStaking(address(agentLookup));
        registry.setIdentityRegistry(address(identity));

        token.setRegistry(address(registry));
        token.enableTransfers();

        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);
        gate = new AntseedEmissionsGate(teamWallet, reserve, 15_000, 15_000);
        token.setRegistry(address(gate));
        // No bucket mints until the legacy escrow is settled; any recipient
        // address marks the pot funded.
        gate.fundLegacyEscrow(address(0xE5C0));

        pools = new AntseedSellerPools(address(token), address(gate), address(identity), address(agentLookup));
        token.setTransferWhitelist(address(pools), true);

        usageAccounting = new AntseedUsageAccounting(address(pools), address(this), address(gate));
        registry.setEmissions(address(usageAccounting));

        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identity), address(depositsMock));
        gate.setMinter(USAGE_MINTER_ID, address(usageRewards), USAGE_SHARE_BPS, true);

        // Register agent and seed pool power.
        agentId = identity.register(); // owner = this; reassign to seller below
        identity.setOwner(agentId, seller);
        agentLookup.setAgent(seller, agentId);

        deal(address(token), stakerAddr, 100_000_000 ether);
        vm.startPrank(stakerAddr);
        token.approve(address(pools), 100_000_000 ether);
        pools.stake(agentId, 100_000_000 ether, 52);
        vm.stopPrank();
        _warpGateEpoch(5);
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _usageSideBudget(uint256 epoch) internal view returns (uint256) {
        return usageRewards.sellerEpochBudget(epoch);
    }

    /// @notice Seller-side claim: split conserves, claimable capped at 5%, and
    ///         the controller never mints past its budget.
    function testFuzz_sellerRewardSplitConserves(uint64 points) public {
        uint256 pts = uint256(bound(points, 1, 1_000_000));
        usageAccounting.accruePoints(bytes32(uint256(1)), buyer, seller, pts);

        _warpGateEpoch(6);
        uint256 sideBudget = _usageSideBudget(5);
        uint256 cap = (sideBudget * MAX_REWARD_SHARE_BPS) / 10_000;

        uint256 sellerBefore = token.balanceOf(seller);
        uint256 reserveBefore = token.balanceOf(reserve);

        vm.prank(seller);
        usageRewards.claimAgentReward(agentId, 5);

        uint256 toSeller = token.balanceOf(seller) - sellerBefore;
        uint256 toReserve = token.balanceOf(reserve) - reserveBefore;

        // Single agent => gross == full side budget; claimable capped at 5%.
        assertLe(toSeller, cap, "claimable above 5% cap");
        assertEq(toSeller + toReserve, sideBudget, "split does not conserve gross");
        assertLe(
            gate.minterEpochMinted(USAGE_MINTER_ID, 5), gate.minterEpochBudget(USAGE_MINTER_ID, 5), "over minter budget"
        );

        // Double-claim impossible.
        vm.prank(seller);
        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimAgentReward(agentId, 5);
    }

    /// @notice Buyer hot wallet never receives funds: payout routes to operator,
    ///         and with no operator the claim reverts AND the claimed flag rolls
    ///         back so it can be retried.
    function testFuzz_buyerNeverReceivesAndFlagRollsBack(uint64 points, bool hasOperator) public {
        uint256 pts = uint256(bound(points, 1, 1_000_000));
        usageAccounting.accruePoints(bytes32(uint256(2)), buyer, seller, pts);
        _warpGateEpoch(6);

        if (!hasOperator) {
            // No operator set -> claim must revert and NOT mark claimed.
            vm.expectRevert(AntseedUsageRewards.RewardRecipientUnavailable.selector);
            usageRewards.claimBuyerReward(buyer, 5);
            assertEq(usageRewards.buyerEpochClaimed(buyer, 5), false, "claimed flag stuck after revert");
            assertEq(token.balanceOf(buyer), 0, "buyer hot wallet received funds");
            return;
        }

        depositsMock.setOperator(buyer, operator);
        uint256 buyerBefore = token.balanceOf(buyer);
        vm.prank(operator);
        usageRewards.claimBuyerReward(buyer, 5);

        assertEq(token.balanceOf(buyer), buyerBefore, "buyer hot wallet received funds");
        assertGt(token.balanceOf(operator), 0, "operator received nothing");
        assertEq(usageRewards.buyerEpochClaimed(buyer, 5), true, "claimed flag not set");
    }
}
