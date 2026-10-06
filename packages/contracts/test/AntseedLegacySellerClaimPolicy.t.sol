// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { AntseedSellerUnlockPolicy } from "../policies/AntseedSellerUnlockPolicy.sol";
import { AntseedLegacySellerClaimPolicy } from "../policies/AntseedLegacySellerClaimPolicy.sol";
import { IAntseedSellerClaimPolicy } from "../interfaces/IAntseedSellerClaimPolicy.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract MockWashTradingStatus is IAntseedWashTradingStatus {
    mapping(address => bool) public wash;

    function set(address seller, bool value) external {
        wash[seller] = value;
    }

    function isProvenWashTrader(address seller) external view returns (bool) {
        return wash[seller];
    }
}

contract MockDepositsForClaimPolicy {
    function getOperator(address buyer) external pure returns (address) {
        return buyer;
    }
}

contract AntseedLegacySellerClaimPolicyTest is Test {
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint256 constant RELEASE_BPS = 1000; // 10%

    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissions legacy;
    AntseedEmissionsV2 v2;
    AntseedSellerRewardsPool pool;
    AntseedSellerUnlockPolicy unlockPolicy;
    MockWashTradingStatus washRegistry;

    address seller1 = address(0x10);
    address seller2 = address(0x20);

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new ANTSToken();
        registry = new AntseedRegistry();
        registry.setChannels(address(this));
        registry.setDeposits(address(new MockDepositsForClaimPolicy()));
        registry.setAntsToken(address(token));
        registry.setProtocolReserve(address(0x50));
        registry.setTeamWallet(address(0x51));

        legacy = new AntseedEmissions(address(registry), INITIAL_EMISSION, EPOCH_DURATION);
        registry.setEmissions(address(legacy));
        token.setRegistry(address(registry));

        // V1 points in epoch 0 and in the migration epoch (4).
        legacy.accrueSellerPoints(seller1, 100);
        _warpToEpoch(4);
        legacy.accrueSellerPoints(seller1, 100);

        pool = new AntseedSellerRewardsPool(address(registry));
        unlockPolicy = new AntseedSellerUnlockPolicy();
        v2 = new AntseedEmissionsV2(address(registry), address(legacy), address(pool));
        v2.setSellerUnlockPolicy(address(unlockPolicy));
        registry.setEmissions(address(v2));
        token.setTransferWhitelist(address(pool), true);

        washRegistry = new MockWashTradingStatus();

        // V2 points in migration epoch and the next one.
        v2.accrueSellerPoints(seller1, 100);
        v2.accrueSellerPoints(seller2, 200);
        _warpToEpoch(5);
        v2.accrueSellerPoints(seller1, 300);
        v2.accrueSellerPoints(seller2, 100);
        _warpToEpoch(6);
    }

    function _warpToEpoch(uint256 epoch) internal {
        vm.warp(legacy.genesis() + EPOCH_DURATION * epoch + 1);
    }

    function _epochs(uint256 epoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }

    function _epochs(uint256 firstEpoch, uint256 secondEpoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](2);
        epochs[0] = firstEpoch;
        epochs[1] = secondEpoch;
    }

    function _deployPolicy(uint256 lastEpoch) internal returns (AntseedLegacySellerClaimPolicy policy) {
        policy = new AntseedLegacySellerClaimPolicy(address(v2), lastEpoch, RELEASE_BPS, address(washRegistry));
        pool.setSellerClaimPolicy(address(policy));
    }

    function _expectedReward(uint256 epoch, uint256 sellerPoints, uint256 totalSellerPoints)
        internal
        view
        returns (uint256)
    {
        (uint256 sellerShare,,,, uint256 maxSellerShare,,) = v2.epochParams(epoch);
        uint256 sellerBudget = (v2.getEpochEmission(epoch) * sellerShare) / 100;
        uint256 reward = (sellerPoints * sellerBudget) / totalSellerPoints;
        uint256 maxReward = (sellerBudget * maxSellerShare) / 100;
        return reward > maxReward ? maxReward : reward;
    }

    // ─────────────────────────────────────────────────────────────────────

    function test_cumulativeLockedMirrorsV2Claim() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));

        uint256 locked = pool.lockedRewards(seller1);
        assertGt(locked, 0);
        assertEq(policy.cumulativeLocked(seller1), locked, "policy must reproduce pool locked amount exactly");

        // migration epoch: V1 100 + V2 100 user, V1 100 + V2 300 total -> capped at 50%
        uint256 e4 = _expectedReward(4, 200, 400);
        uint256 e5 = _expectedReward(5, 300, 400);
        assertEq(locked, e4 + e5);
    }

    function test_claimReleasesConfiguredShareOnce() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10);
        assertEq(policy.entitledOf(1000 ether), 100 ether);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));
        uint256 locked = pool.lockedRewards(seller1);
        uint256 expected = locked / 10;

        assertEq(policy.claimableSellerRewards(seller1, locked), expected);

        vm.prank(seller1);
        pool.claim(seller1);
        assertEq(token.balanceOf(seller1), expected);
        assertEq(pool.lockedRewards(seller1), locked - expected);

        // Nothing more to claim: released == entitled.
        assertEq(policy.claimableSellerRewards(seller1, pool.lockedRewards(seller1)), 0);
        vm.prank(seller1);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(seller1);
    }

    function test_claimTracksNewlyLockedEpochs() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4));
        vm.prank(seller1);
        pool.claim(seller1);
        uint256 firstPaid = token.balanceOf(seller1);

        // Lock another epoch later; only its releaseBps share becomes claimable.
        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(5));
        uint256 e5 = _expectedReward(5, 300, 400);
        uint256 cumulative = policy.cumulativeLocked(seller1);
        uint256 entitled = (cumulative * RELEASE_BPS) / 10_000;
        assertEq(policy.claimableSellerRewards(seller1, pool.lockedRewards(seller1)), entitled - firstPaid);
        assertApproxEqAbs(entitled - firstPaid, (e5 * RELEASE_BPS) / 10_000, 1);
    }

    function test_provenWashTraderCannotClaim() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));
        uint256 locked = pool.lockedRewards(seller1);
        assertGt(policy.claimableSellerRewards(seller1, locked), 0);

        washRegistry.set(seller1, true);
        assertTrue(policy.isWashTrader(seller1));
        assertEq(policy.claimableSellerRewards(seller1, locked), 0);

        vm.prank(seller1);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(seller1);

        // Funds remain locked in the pool.
        assertEq(pool.lockedRewards(seller1), locked);
    }

    function test_preMigrationEpochClaimedThroughV2Counts() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(0));
        uint256 locked = pool.lockedRewards(seller1);
        assertGt(locked, 0);
        assertEq(policy.cumulativeLocked(seller1), locked);
    }

    function test_preMigrationOnlyRewardsCanBeWithdrawnExactlyOnce() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(5);
        uint256 deposited = _lockEpochAndMeasureDeposit(0);
        uint256 entitlement = (deposited * RELEASE_BPS) / 10_000;

        assertTrue(v2.sellerEpochClaimed(seller1, 0));
        assertFalse(legacy.sellerEpochClaimed(seller1, 0));
        assertEq(policy.cumulativeLocked(seller1), deposited);
        assertEq(policy.claimableSellerRewards(seller1, deposited), entitlement);

        vm.prank(seller1);
        pool.claim(seller1);
        _assertPoolPayout(deposited, entitlement);
        _assertNothingMoreToWithdraw(policy, seller1);

        _warpToEpoch(7);
        _assertNothingMoreToWithdraw(policy, seller2);
        assertEq(policy.cumulativeLocked(seller1), deposited);
        _assertPoolPayout(deposited, entitlement);
    }

    function test_preMigrationAndNewEpochBatchCannotBeWithdrawnTwice() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(5);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(0, 5));
        uint256 deposited = token.balanceOf(address(pool));
        uint256 entitlement = (deposited * RELEASE_BPS) / 10_000;

        assertGt(deposited, 0);
        assertEq(pool.lockedRewards(seller1), deposited);
        assertTrue(v2.sellerEpochClaimed(seller1, 0));
        assertTrue(v2.sellerEpochClaimed(seller1, 5));
        assertEq(policy.cumulativeLocked(seller1), deposited);

        vm.prank(seller1);
        pool.claim(seller2);
        assertEq(token.balanceOf(seller1), 0);
        assertEq(token.balanceOf(seller2), entitlement);
        assertEq(pool.lockedRewards(seller1), deposited - entitlement);
        assertEq(pool.totalLockedRewards(), deposited - entitlement);
        assertEq(token.balanceOf(address(pool)), deposited - entitlement);
        _assertNothingMoreToWithdraw(policy, seller1);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(0, 5));
        assertEq(policy.cumulativeLocked(seller1), deposited);
        _warpToEpoch(7);
        _assertNothingMoreToWithdraw(policy, seller2);
        assertEq(token.balanceOf(seller2), entitlement);
    }

    function test_oldEpochClaimedAfterWithdrawalReleasesOnlyItsAdditionalShare() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(5);
        uint256 firstDeposit = _lockEpochAndMeasureDeposit(5);
        uint256 firstEntitlement = (firstDeposit * RELEASE_BPS) / 10_000;

        vm.prank(seller1);
        pool.claim(seller1);
        _assertPoolPayout(firstDeposit, firstEntitlement);
        _assertNothingMoreToWithdraw(policy, seller1);

        uint256 oldEpochDeposit = _lockEpochAndMeasureDeposit(0);
        uint256 totalDeposited = firstDeposit + oldEpochDeposit;
        uint256 totalEntitlement = (totalDeposited * RELEASE_BPS) / 10_000;
        assertEq(policy.cumulativeLocked(seller1), totalDeposited);
        assertEq(
            policy.claimableSellerRewards(seller1, pool.lockedRewards(seller1)), totalEntitlement - firstEntitlement
        );

        vm.prank(seller1);
        pool.claim(seller1);
        _assertPoolPayout(totalDeposited, totalEntitlement);
        _assertNothingMoreToWithdraw(policy, seller1);
    }

    function test_migrationStartSketchOverpaysWithOnlyPreMigrationRewards() public {
        _assertMigrationStartSketchOverpays(false);
    }

    function test_migrationStartSketchOverpaysWithOldAndNewRewards() public {
        _assertMigrationStartSketchOverpays(true);
    }

    function _lockEpochAndMeasureDeposit(uint256 epoch) internal returns (uint256 deposited) {
        unlockPolicy.setSellerEligibility(seller1, false);
        uint256 poolBalanceBefore = token.balanceOf(address(pool));
        uint256 lockedBefore = pool.lockedRewards(seller1);
        uint256 totalLockedBefore = pool.totalLockedRewards();
        uint256 walletBefore = token.balanceOf(seller1);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(epoch));

        deposited = token.balanceOf(address(pool)) - poolBalanceBefore;
        assertGt(deposited, 0);
        assertEq(pool.lockedRewards(seller1) - lockedBefore, deposited);
        assertEq(pool.totalLockedRewards() - totalLockedBefore, deposited);
        assertEq(token.balanceOf(seller1), walletBefore);
    }

    function _assertPoolPayout(uint256 deposited, uint256 paid) internal view {
        assertEq(token.balanceOf(seller1), paid);
        assertEq(pool.lockedRewards(seller1), deposited - paid);
        assertEq(pool.totalLockedRewards(), deposited - paid);
        assertEq(token.balanceOf(address(pool)), deposited - paid);
    }

    function _assertNothingMoreToWithdraw(AntseedLegacySellerClaimPolicy policy, address recipient) internal {
        uint256 lockedBefore = pool.lockedRewards(seller1);
        uint256 totalLockedBefore = pool.totalLockedRewards();
        uint256 poolBalanceBefore = token.balanceOf(address(pool));
        uint256 recipientBalanceBefore = token.balanceOf(recipient);

        assertEq(policy.claimableSellerRewards(seller1, lockedBefore), 0);
        vm.prank(seller1);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(recipient);

        assertEq(pool.lockedRewards(seller1), lockedBefore);
        assertEq(pool.totalLockedRewards(), totalLockedBefore);
        assertEq(token.balanceOf(address(pool)), poolBalanceBefore);
        assertEq(token.balanceOf(recipient), recipientBalanceBefore);
    }

    function _assertMigrationStartSketchOverpays(bool includeNewEpoch) internal {
        MigrationStartClaimPolicyFixture sketch = new MigrationStartClaimPolicyFixture(v2, legacy, 5, RELEASE_BPS);
        pool.setSellerClaimPolicy(address(sketch));
        uint256 deposited = _lockEpochAndMeasureDeposit(0);
        uint256 newEpochDeposit = includeNewEpoch ? _lockEpochAndMeasureDeposit(5) : 0;
        deposited += newEpochDeposit;

        assertEq(sketch.cumulativeLocked(seller1), newEpochDeposit);
        uint256 entitlement = (deposited * RELEASE_BPS) / 10_000;
        vm.prank(seller1);
        pool.claim(seller1);
        _assertPoolPayout(deposited, entitlement);

        uint256 secondClaim = sketch.claimableSellerRewards(seller1, pool.lockedRewards(seller1));
        assertGt(secondClaim, 0, "migration-start sketch incorrectly allows another withdrawal");
        vm.prank(seller1);
        pool.claim(seller1);
        _assertPoolPayout(deposited, entitlement + secondClaim);
        assertGt(token.balanceOf(seller1), entitlement, "actual transfers exceed the configured release share");
    }

    function test_unlockedSellerNeverUnderCounts() public {
        // A seller eligible for direct mint has sellerEpochClaimed set but nothing in the pool.
        unlockPolicy.setSellerEligibility(seller2, true);
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10);

        vm.prank(seller2);
        v2.claimSellerEmissions(_epochs(4));
        assertEq(pool.lockedRewards(seller2), 0);
        assertGt(token.balanceOf(seller2), 0);
        assertEq(policy.claimableSellerRewards(seller2, 0), 0);

        uint256 deposited = _lockEpochAndMeasureDeposit(4);
        uint256 entitlement = (deposited * RELEASE_BPS) / 10_000;
        assertEq(policy.cumulativeLocked(seller1), deposited);
        vm.prank(seller1);
        pool.claim(seller1);
        _assertPoolPayout(deposited, entitlement);
        _assertNothingMoreToWithdraw(policy, seller1);
    }

    function test_mixedHistorySubtractsDirectRewardsFromAllowance() public {
        v2.accrueSellerPoints(seller1, 1);
        v2.accrueSellerPoints(seller2, 9999);
        _warpToEpoch(7);
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10);
        unlockPolicy.setSellerEligibility(seller1, true);

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(6));
        uint256 directReward = _expectedReward(6, 1, 10_000);
        assertGt(directReward, 0);
        assertEq(token.balanceOf(seller1), directReward);
        assertEq(pool.lockedRewards(seller1), 0);

        uint256 deposited = _lockEpochAndMeasureDeposit(5);
        uint256 cumulative = directReward + deposited;
        uint256 entitlement = (cumulative * RELEASE_BPS) / 10_000;
        assertGt(entitlement, directReward);
        uint256 expected = entitlement - directReward;
        assertTrue(v2.sellerEpochClaimed(seller1, 5));
        assertTrue(v2.sellerEpochClaimed(seller1, 6));
        assertEq(policy.cumulativeLocked(seller1), cumulative);
        assertEq(policy.claimableSellerRewards(seller1, deposited), expected);
        assertLt(expected, (deposited * RELEASE_BPS) / 10_000);

        vm.prank(seller1);
        pool.claim(seller1);
        assertEq(token.balanceOf(seller1), directReward + expected);
        assertEq(pool.lockedRewards(seller1), deposited - expected);
        assertEq(pool.totalLockedRewards(), deposited - expected);
        assertEq(token.balanceOf(address(pool)), deposited - expected);
        _assertNothingMoreToWithdraw(policy, seller1);
        _warpToEpoch(8);
        _assertNothingMoreToWithdraw(policy, seller2);
    }

    function test_mixedHistoryReturnsZeroWhenDirectRewardsExceedAllowance() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(10);
        unlockPolicy.setSellerEligibility(seller1, true);
        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4));
        uint256 directReward = _expectedReward(4, 200, 400);
        assertEq(token.balanceOf(seller1), directReward);
        assertEq(pool.lockedRewards(seller1), 0);

        uint256 deposited = _lockEpochAndMeasureDeposit(5);
        uint256 cumulative = directReward + deposited;
        assertGt(directReward, (cumulative * RELEASE_BPS) / 10_000);
        assertEq(policy.cumulativeLocked(seller1), cumulative);
        _assertNothingMoreToWithdraw(policy, seller1);
        assertEq(token.balanceOf(seller1), directReward);
        assertEq(pool.lockedRewards(seller1), deposited);
        assertEq(pool.totalLockedRewards(), deposited);
        assertEq(token.balanceOf(address(pool)), deposited);
    }

    function test_claimableNeverExceedsLocked() public {
        AntseedLegacySellerClaimPolicy policy =
            new AntseedLegacySellerClaimPolicy(address(v2), 10, 10_000, address(washRegistry));
        pool.setSellerClaimPolicy(address(policy));

        vm.prank(seller1);
        v2.claimSellerEmissions(_epochs(4, 5));
        uint256 locked = pool.lockedRewards(seller1);
        assertEq(policy.claimableSellerRewards(seller1, locked), locked);
        assertEq(policy.claimableSellerRewards(seller1, locked / 3), locked / 3);
    }

    function test_constructorValidation() public {
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidValue.selector);
        new AntseedLegacySellerClaimPolicy(address(v2), 10, 0, address(washRegistry));
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidValue.selector);
        new AntseedLegacySellerClaimPolicy(address(v2), 10, 10_001, address(washRegistry));
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidValue.selector);
        new AntseedLegacySellerClaimPolicy(address(v2), 3, 1000, address(washRegistry));
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidAddress.selector);
        new AntseedLegacySellerClaimPolicy(address(0), 10, 1000, address(washRegistry));
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidAddress.selector);
        new AntseedLegacySellerClaimPolicy(address(v2), 10, 1000, address(0));
        vm.expectRevert(AntseedLegacySellerClaimPolicy.InvalidAddress.selector);
        new AntseedLegacySellerClaimPolicy(address(v2), 10, 1000, address(0xDEAD));
    }

    function test_releaseDoesNotIncreaseWithTime() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(5);
        uint256 deposited = _lockEpochAndMeasureDeposit(4);
        uint256 entitled = deposited / 10;
        assertEq(policy.claimableSellerRewards(seller1, deposited), entitled);

        _warpToEpoch(100);
        assertEq(policy.claimableSellerRewards(seller1, deposited), entitled);
        vm.prank(seller1);
        pool.claim(seller1);
        _assertPoolPayout(deposited, entitled);

        _warpToEpoch(200);
        _assertNothingMoreToWithdraw(policy, seller1);
    }

    function test_policyHasNoAdministrativeSetters() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(5);
        (bool flagSucceeded,) =
            address(policy).call(abi.encodeWithSignature("setSellerFlagged(address,bool)", seller1, true));
        (bool registrySucceeded,) =
            address(policy).call(abi.encodeWithSignature("setWashTradingRegistry(address)", address(0)));
        (bool ownershipSucceeded,) =
            address(policy).call(abi.encodeWithSignature("transferOwnership(address)", seller1));
        assertFalse(flagSucceeded);
        assertFalse(registrySucceeded);
        assertFalse(ownershipSucceeded);
        assertEq(address(policy.washTradingRegistry()), address(washRegistry));
        assertFalse(policy.isWashTrader(seller1));
    }

    function test_registryFailureBlocksClaims() public {
        AntseedLegacySellerClaimPolicy policy = _deployPolicy(5);
        uint256 deposited = _lockEpochAndMeasureDeposit(4);
        vm.mockCallRevert(
            address(washRegistry),
            abi.encodeCall(IAntseedWashTradingStatus.isProvenWashTrader, (seller1)),
            abi.encodeWithSignature("Error(string)", "registry unavailable")
        );
        vm.prank(seller1);
        vm.expectRevert("registry unavailable");
        pool.claim(seller1);
        assertEq(address(policy.washTradingRegistry()), address(washRegistry));
        _assertPoolPayout(deposited, 0);
    }
}

contract MigrationStartClaimPolicyFixture is IAntseedSellerClaimPolicy {
    uint256 public constant BPS = 10_000;

    AntseedEmissionsV2 public immutable v2;
    AntseedEmissions public immutable v1;
    uint256 public immutable firstEpoch;
    uint256 public immutable lastEpoch;
    uint256 public immutable releaseBps;

    constructor(AntseedEmissionsV2 emissionsV2, AntseedEmissions emissionsV1, uint256 lastEpoch_, uint256 releaseBps_) {
        v2 = emissionsV2;
        v1 = emissionsV1;
        firstEpoch = v2.MIGRATION_EPOCH();
        lastEpoch = lastEpoch_;
        releaseBps = releaseBps_;
    }

    function cumulativeLocked(address seller) public view returns (uint256 total) {
        uint256 migration = firstEpoch;
        for (uint256 epoch = migration; epoch <= lastEpoch; epoch++) {
            if (!v2.sellerEpochClaimed(seller, epoch)) continue;
            uint256 userPoints = v2.userSellerPoints(seller, epoch);
            uint256 totalPoints = v2.epochTotalSellerPoints(epoch);
            if (epoch <= migration) {
                userPoints += v1.userSellerPoints(seller, epoch);
                totalPoints += v1.epochTotalSellerPoints(epoch);
            }
            if (userPoints == 0 || totalPoints == 0) continue;
            (uint256 sellerShare,,,, uint256 maxSellerShare,,) = v2.epochParams(epoch);
            uint256 sellerBudget = (v2.getEpochEmission(epoch) * sellerShare) / 100;
            uint256 reward = (userPoints * sellerBudget) / totalPoints;
            uint256 maxReward = (sellerBudget * maxSellerShare) / 100;
            total += reward > maxReward ? maxReward : reward;
        }
    }

    function claimableSellerRewards(address seller, uint256 locked) external view returns (uint256) {
        uint256 cumulative = cumulativeLocked(seller);
        if (cumulative < locked) cumulative = locked;
        uint256 released = cumulative - locked;

        uint256 entitled = (cumulative * releaseBps) / BPS;
        return entitled > released ? entitled - released : 0;
    }
}
