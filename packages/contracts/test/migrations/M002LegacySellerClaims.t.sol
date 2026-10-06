// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedEmissions } from "../../legacy/AntseedEmissions.sol";
import { AntseedEmissionsV2 } from "../../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerRewardsPool } from "../../rewards/AntseedSellerRewardsPool.sol";
import { AntseedLegacyRewardsPoolRegistry } from "../../rewards/AntseedLegacyRewardsPoolRegistry.sol";
import { AntseedLegacySellerClaimPolicy } from "../../policies/AntseedLegacySellerClaimPolicy.sol";
import { M002InstallLegacySellerClaims } from "../../script/migrations/M002LegacySellerClaims/Install.s.sol";

contract MockDepositsForM002 {
    function getOperator(address buyer) external pure returns (address) {
        return buyer;
    }
}

contract MockWashRegistryForM002 {
    mapping(address => bool) public wash;

    function set(address seller, bool value) external {
        wash[seller] = value;
    }

    function isProvenWashTrader(address seller) external view returns (bool) {
        return wash[seller];
    }
}

/// @dev Stand-ins for the M001 stack: only the reads M002 performs.
contract MockEmissionsGateForM002 {
    uint256 public effectiveEpoch;

    constructor(uint256 effectiveEpoch_) {
        effectiveEpoch = effectiveEpoch_;
    }
}

contract MockUsageAccountingForM002 {
    address public emissionsGate;

    constructor(address gate) {
        emissionsGate = gate;
    }
}

/**
 * Drives Install.s.sol against a local V1 -> V2 -> pool stack in the state
 * M001 leaves behind: registry.emissions() flipped to UsageAccounting, the
 * pool pinned to its registry facade, and the pool NOT whitelisted on ANTS.
 */
contract M002LegacySellerClaimsTest is Test {
    uint256 constant INITIAL_EMISSION = 1000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint256 constant EFFECTIVE_EPOCH = 6;

    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissions legacy;
    AntseedEmissionsV2 v2;
    AntseedSellerRewardsPool pool;
    MockWashRegistryForM002 washRegistry;
    MockUsageAccountingForM002 usageAccounting;
    M002InstallLegacySellerClaims script;

    address tokenOwner = address(0xA0);
    address poolOwner = address(0xA1);
    address seller = address(0x10);
    address washSeller = address(0x11);

    function setUp() public {
        vm.warp(1_700_000_000);

        token = new ANTSToken();
        registry = new AntseedRegistry();
        registry.setChannels(address(this));
        registry.setDeposits(address(new MockDepositsForM002()));
        registry.setAntsToken(address(token));
        registry.setProtocolReserve(address(0x50));
        registry.setTeamWallet(address(0x51));

        legacy = new AntseedEmissions(address(registry), INITIAL_EMISSION, EPOCH_DURATION);
        registry.setEmissions(address(legacy));
        token.setRegistry(address(registry));

        // V2 migrates at epoch 4; sellers earn in epoch 4 and claim (locked) in epoch 6.
        _warpToEpoch(4);
        pool = new AntseedSellerRewardsPool(address(registry));
        v2 = new AntseedEmissionsV2(address(registry), address(legacy), address(pool));
        registry.setEmissions(address(v2));

        v2.accrueSellerPoints(seller, 100);
        v2.accrueSellerPoints(washSeller, 100);
        _warpToEpoch(EFFECTIVE_EPOCH);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 4;
        vm.prank(seller);
        v2.claimSellerEmissions(epochs);
        vm.prank(washSeller);
        v2.claimSellerEmissions(epochs);
        assertGt(pool.lockedRewards(seller), 0, "rewards locked into the pool");

        // M001 cutover: pin the pool at its facade, then flip registry.emissions().
        pool.setRegistry(address(new AntseedLegacyRewardsPoolRegistry(address(v2), address(token))));
        usageAccounting = new MockUsageAccountingForM002(address(new MockEmissionsGateForM002(EFFECTIVE_EPOCH)));
        registry.setEmissions(address(usageAccounting));

        pool.transferOwnership(poolOwner);
        token.transferOwnership(tokenOwner);

        washRegistry = new MockWashRegistryForM002();
        washRegistry.set(washSeller, true);

        script = new M002InstallLegacySellerClaims();
    }

    function _warpToEpoch(uint256 epoch) internal {
        vm.warp(legacy.genesis() + EPOCH_DURATION * epoch + 1);
    }

    function _cfg() internal view returns (M002InstallLegacySellerClaims.Config memory) {
        return M002InstallLegacySellerClaims.Config({
            tokenOwner: tokenOwner,
            poolOwner: poolOwner,
            registry: address(registry),
            antsToken: address(token),
            legacyEmissionsV2: address(v2),
            usageAccounting: address(usageAccounting),
            washTradingRegistry: address(washRegistry),
            lastEpochOverride: 0,
            releaseBps: 1000
        });
    }

    function _policy() internal view returns (AntseedLegacySellerClaimPolicy) {
        return AntseedLegacySellerClaimPolicy(address(pool.sellerClaimPolicy()));
    }

    // ─────────────────────────────────────────────────────────────────────

    function test_poolIsFrozenBeforeM002() public {
        // No policy: claim reverts before touching the token.
        vm.prank(seller);
        vm.expectRevert(AntseedSellerRewardsPool.NoSellerClaimPolicy.selector);
        pool.claim(seller);

        // Policy alone is not enough: the pool cannot send ANTS while transfers are disabled.
        AntseedLegacySellerClaimPolicy policy =
            new AntseedLegacySellerClaimPolicy(address(v2), 5, 1000, address(washRegistry));
        vm.prank(poolOwner);
        pool.setSellerClaimPolicy(address(policy));
        vm.prank(seller);
        vm.expectRevert(ANTSToken.TransfersNotEnabled.selector);
        pool.claim(seller);
    }

    function test_installsPolicyAndWhitelistsPool() public {
        assertEq(script.DEFAULT_RELEASE_BPS(), 1000);
        address policyAddress = script.runWith(_cfg());

        AntseedLegacySellerClaimPolicy policy = _policy();
        assertEq(address(policy), policyAddress);
        assertEq(address(policy.v2()), address(v2));
        assertEq(address(policy.v1()), address(legacy), "v1 derived from v2");
        assertEq(policy.migrationEpoch(), 4);
        assertEq(policy.lastEpoch(), EFFECTIVE_EPOCH - 1, "last epoch = effective - 1");
        assertEq(policy.releaseBps(), 1000);
        assertEq(address(policy.washTradingRegistry()), address(washRegistry));
        assertTrue(token.transferWhitelist(address(pool)), "pool whitelisted on ANTS");
    }

    function test_honestSellerClaimsReleasedShare_washTraderGetsNothing() public {
        script.runWith(_cfg());

        uint256 locked = pool.lockedRewards(seller);
        uint256 expected = locked / 10;
        vm.prank(seller);
        pool.claim(seller);
        assertEq(token.balanceOf(seller), expected, "released share paid out");
        assertEq(pool.lockedRewards(seller), locked - expected);

        // Nothing more this epoch: cumulative - locked == released.
        vm.prank(seller);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(seller);

        vm.prank(washSeller);
        vm.expectRevert(AntseedSellerRewardsPool.NothingToClaim.selector);
        pool.claim(washSeller);
        assertEq(pool.lockedRewards(washSeller), locked, "wash trader's rewards stay locked");
    }

    function test_rerunIsNoOp() public {
        address first = script.runWith(_cfg());
        address second = script.runWith(_cfg());
        assertEq(second, first, "rerun keeps the installed policy");
        assertEq(address(pool.sellerClaimPolicy()), first);
    }

    function test_resumesWhenOnlyWhitelistLanded() public {
        vm.prank(tokenOwner);
        token.setTransferWhitelist(address(pool), true);
        address policyAddress = script.runWith(_cfg());
        assertEq(address(pool.sellerClaimPolicy()), policyAddress);
    }

    function test_resumesWhenOnlyPolicyLanded() public {
        AntseedLegacySellerClaimPolicy policy =
            new AntseedLegacySellerClaimPolicy(address(v2), 5, 1000, address(washRegistry));
        vm.prank(poolOwner);
        pool.setSellerClaimPolicy(address(policy));

        address result = script.runWith(_cfg());
        assertEq(result, address(policy), "existing policy kept");
        assertTrue(token.transferWhitelist(address(pool)));
    }

    function test_skipsWhitelistWhenTransfersEnabled() public {
        vm.prank(tokenOwner);
        token.enableTransfers();
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.tokenOwner = address(0xDEAD); // never used when transfers are enabled
        script.runWith(cfg);
        assertFalse(token.transferWhitelist(address(pool)));
        assertTrue(address(pool.sellerClaimPolicy()) != address(0));
    }

    function test_rejectsBeforeM001Activation() public {
        registry.setEmissions(address(v2));
        vm.expectRevert("M001 has not activated: registry.emissions() is not UsageAccounting");
        script.runWith(_cfg());
    }

    function test_rejectsWrongPoolOwner() public {
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.poolOwner = address(0xB0B);
        vm.expectRevert("SELLER_REWARDS_POOL_OWNER is not the pool owner");
        script.runWith(cfg);
    }

    function test_rejectsWrongTokenOwner() public {
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.tokenOwner = address(0xB0B);
        vm.expectRevert("DEPLOYER is not the ANTSToken owner");
        script.runWith(cfg);
    }

    function test_rejectsWrongAntsToken() public {
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.antsToken = address(new ANTSToken());
        vm.expectRevert("EXPECTED_ANTS_TOKEN is not the registry's ANTS token");
        script.runWith(cfg);
    }

    function test_rejectsLastEpochBeforeMigration() public {
        // A gate whose effective epoch equals the V2 migration epoch leaves no lockable epoch.
        usageAccounting = new MockUsageAccountingForM002(address(new MockEmissionsGateForM002(4)));
        registry.setEmissions(address(usageAccounting));
        vm.expectRevert("last locked epoch precedes the V2 migration epoch");
        script.runWith(_cfg());
    }

    function test_rejectsLastEpochOverrideAtOrPastEffective() public {
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.lastEpochOverride = EFFECTIVE_EPOCH;
        vm.expectRevert("LAST_LOCKED_EPOCH must precede the gate's effective epoch");
        script.runWith(cfg);
    }

    function test_rejectsWashRegistryMissingOrWithoutCode() public {
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.washTradingRegistry = address(0);
        vm.expectRevert("WASH_TRADING_REGISTRY not set");
        script.runWith(cfg);

        cfg.washTradingRegistry = address(0xDEAD);
        vm.expectRevert("WASH_TRADING_REGISTRY has no code");
        script.runWith(cfg);
    }

    function test_rejectsLastEpochOverrideThatOmitsLockedEpochs() public {
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.lastEpochOverride = EFFECTIVE_EPOCH - 2;
        vm.expectRevert("LAST_LOCKED_EPOCH must equal the gate's effective epoch minus one");
        script.runWith(cfg);
        assertEq(address(pool.sellerClaimPolicy()), address(0));
        assertFalse(token.transferWhitelist(address(pool)));
    }

    function test_acceptsExactLastEpochOverride() public {
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.lastEpochOverride = EFFECTIVE_EPOCH - 1;
        script.runWith(cfg);
        assertEq(_policy().lastEpoch(), EFFECTIVE_EPOCH - 1);
    }

    function test_optionalReleaseOverride() public {
        M002InstallLegacySellerClaims.Config memory cfg = _cfg();
        cfg.releaseBps = 5000;
        cfg.lastEpochOverride = EFFECTIVE_EPOCH - 1;
        script.runWith(cfg);
        AntseedLegacySellerClaimPolicy policy = _policy();
        assertEq(policy.releaseBps(), 5000);
        assertEq(policy.lastEpoch(), EFFECTIVE_EPOCH - 1);
    }
}
