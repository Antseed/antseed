// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../core/ANTSToken.sol";
import { AntseedEmissions } from "../legacy/AntseedEmissions.sol";
import { AntseedUsageRewards } from "../emissions/AntseedUsageRewards.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedLegacyEmissionsEscrow } from "../emissions/AntseedLegacyEmissionsEscrow.sol";
import { AntseedEmissionsV2 } from "../legacy/AntseedEmissionsV2.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerPoolsRewards } from "../emissions/AntseedSellerPoolsRewards.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { IAntseedUsageAccounting } from "../interfaces/IAntseedUsageAccounting.sol";
import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";
import { IAntseedPoolWeightPolicy } from "../interfaces/IAntseedPoolWeightPolicy.sol";
import { AntseedSellerRewardsPool } from "../rewards/AntseedSellerRewardsPool.sol";
import { AntseedSellerDelegation } from "../staking/AntseedSellerDelegation.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";

contract MockDepositsForEmissionsGate {
    mapping(address => address) private _operators;

    function setOperator(address buyer, address operator) external {
        _operators[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return _operators[buyer];
    }
}

contract MockUsagePointsPolicy is IAntseedPointsPolicy {
    mapping(address => uint256) public sellerWeightBps;
    uint256 public buyerWeightBps = 10_000;

    function setSellerWeightBps(address seller, uint256 weightBps) external {
        sellerWeightBps[seller] = weightBps;
    }

    function setBuyerWeightBps(uint256 weightBps) external {
        buyerWeightBps = weightBps;
    }

    function points(bytes32, address, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        sellerPoints = (rawPoints * sellerWeightBps[seller]) / 10_000;
        buyerPoints = (rawPoints * buyerWeightBps) / 10_000;
    }
}

contract MockAllowAllSellerUnlockPolicy {
    function canClaimSellerUnlocked(address) external pure returns (bool) {
        return true;
    }
}

contract MockSellerAgentLookup {
    mapping(address => uint256) public agentIdBySeller;

    function setAgent(address seller, uint256 agentId) external {
        agentIdBySeller[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIdBySeller[seller];
    }
}


// Test-only wrapper around the real delegation base class. The deployed
// DiemStakingProxy inherits this same (unchanged) code, so exposing the
// internal helpers here hits the exact call path the live proxy uses against
// registry.emissions().
contract SellerDelegationHarness is AntseedSellerDelegation {
    constructor(address registry_, address operator_) AntseedSellerDelegation(registry_, operator_) { }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function pendingSellerEmissions(address account, uint256[] memory epochs) external view returns (uint256) {
        return _pendingSellerEmissions(account, epochs);
    }

    function claimSellerEmissions(uint256[] memory epochs) external returns (uint256) {
        return _claimSellerEmissions(epochs);
    }

    function currentEmissionsEpoch() external view returns (uint256) {
        return _currentEmissionsEpoch();
    }
}

contract MockCappedPoolWeightPolicy is IAntseedPoolWeightPolicy {
    uint256 public immutable cap;

    constructor(uint256 cap_) {
        cap = cap_;
    }

    function poolWeight(uint256, uint256, uint256 poolPower) external view returns (uint256) {
        return poolPower > cap ? cap : poolPower;
    }
}

contract MockRevertingPoolWeightPolicy is IAntseedPoolWeightPolicy {
    function poolWeight(uint256, uint256, uint256) external pure returns (uint256) {
        revert("broken policy");
    }
}

contract MockHugePoolWeightPolicy is IAntseedPoolWeightPolicy {
    function poolWeight(uint256, uint256, uint256) external pure returns (uint256) {
        return type(uint256).max;
    }
}

contract AntseedEmissionsGateTest is Test {
    struct StressRun {
        uint256 firstPositionId;
        uint256 washPositionId;
        uint256 expectedTotalWeightedPoints;
        uint256 firstWeightedPoints;
        uint256 washWeightedPoints;
        uint256 firstClaimable;
        uint256 washClaimable;
    }

    ANTSToken token;
    AntseedRegistry realRegistry;
    MockDepositsForEmissionsGate deposits;
    AntseedEmissions legacyV1;
    AntseedEmissionsV2 legacyV2;
    AntseedLegacyEmissionsEscrow legacyEscrow;
    AntseedEmissionsGate gate;
    AntseedSellerPools sellerPools;
    AntseedUsageRewards usageRewards;
    AntseedSellerPoolsRewards sellerPoolsRewards;
    AntseedUsageAccounting usageAccounting;
    MockSellerAgentLookup sellerAgentLookup;
    MockERC8004Registry identityRegistry;

    address seller = address(0x10);
    address buyer = address(0x20);
    address operator = address(0x30);
    address otherSeller = address(0x40);
    address staker = address(0x50);
    address reserveDest = address(0x70);
    address teamWallet = address(0x80);
    address verificationWallet = address(0x90);
    address emissionsReserveDest = address(0xA1);

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;
    uint256 constant INITIAL_EMISSION = 1_000 ether;
    uint256 constant EPOCH_DURATION = 1 weeks;
    uint32 constant SELLER_POOLS_SHARE_BPS = 40_000;
    uint32 constant USAGE_SHARE_BPS = 20_000;
    uint32 constant TEAM_SHARE_BPS = 15_000;
    uint32 constant RESERVE_SHARE_BPS = 15_000;
    uint32 constant VERIFICATION_SHARE_BPS = 10_000;
    bytes32 constant TEAM_MINTER_ID = keccak256("antseed.emissions.team.v1");
    bytes32 constant RESERVE_MINTER_ID = keccak256("antseed.emissions.reserve.v1");
    bytes32 constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    bytes32 constant SELLER_POOLS_MINTER_ID = keccak256("antseed.emissions.seller-pools.v1");
    bytes32 constant USAGE_MINTER_ID = keccak256("antseed.emissions.usage.v1");
    bytes32 constant CUSTOM_MINTER_ID = keccak256("antseed.emissions.custom.v1");
    bytes32 constant LOCKED_MINTER_ID = keccak256("antseed.emissions.locked.v1");

    function setUp() public {
        vm.warp(1_700_000_000);

        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);
        realRegistry = new AntseedRegistry();
        deposits = new MockDepositsForEmissionsGate();

        realRegistry.setChannels(address(this));
        realRegistry.setDeposits(address(deposits));
        realRegistry.setAntsToken(address(token));
        realRegistry.setProtocolReserve(reserveDest);
        realRegistry.setTeamWallet(teamWallet);
        identityRegistry = new MockERC8004Registry();
        realRegistry.setIdentityRegistry(address(identityRegistry));
        sellerAgentLookup = new MockSellerAgentLookup();
        realRegistry.setStaking(address(sellerAgentLookup));
        realRegistry.setEmissions(address(this));
        token.setRegistry(address(realRegistry));
        token.enableTransfers();
        token.mint(staker, 1_000 ether);

        legacyV1 = new AntseedEmissions(address(realRegistry), INITIAL_EMISSION, EPOCH_DURATION);
        realRegistry.setEmissions(address(legacyV1));
        legacyV1.accrueSellerPoints(seller, 50);
        legacyV1.accrueBuyerPoints(buyer, 50);

        vm.warp(legacyV1.genesis() + EPOCH_DURATION * 2 + 1);
        AntseedSellerRewardsPool v2RewardsPool = new AntseedSellerRewardsPool(address(realRegistry));
        legacyV2 = new AntseedEmissionsV2(address(realRegistry), address(legacyV1), address(v2RewardsPool));
        realRegistry.setEmissions(address(legacyV2));

        deposits.setOperator(buyer, operator);
        legacyV2.accrueSellerPoints(seller, 100);
        legacyV2.accrueBuyerPoints(buyer, 100);
    }

    function _deployGate(uint256 warpEpoch) internal {
        _deployGate(warpEpoch, address(0), address(0));
    }

    /// @dev Deploys the gate at epoch `warpEpoch - 1` (effectiveEpoch ==
    ///      warpEpoch) and configures the given seller-pools / usage minters
    ///      (skipping address(0)) in that same deploy epoch — exactly like the
    ///      production deploy broadcast — so they are active from warpEpoch
    ///      onward. Minter shares only apply from the NEXT epoch after they
    ///      are set, so tests that claim/assert epoch `warpEpoch` must wire
    ///      their minters here rather than after the warp.
    function _deployGate(uint256 warpEpoch, address sellerPoolsMinter, address usageMinter) internal {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * (warpEpoch - 1) + 1);
        gate = new AntseedEmissionsGate(teamWallet, reserveDest, TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        // Minters checkpoint from the NEXT epoch, so configure them in the
        // deploy epoch (mirroring the production broadcast) to have them
        // active from effectiveEpoch onward.
        _setVerificationMinter(verificationWallet);
        if (sellerPoolsMinter != address(0)) _setSellerPoolsMinter(sellerPoolsMinter);
        if (usageMinter != address(0)) _setUsageMinter(usageMinter);
        _warpGateEpoch(warpEpoch);
        token.setRegistry(address(gate));

        // Production cutover mirror: fund the legacy escrow with the full
        // pre-effective backlog and re-point the legacy emissions contract at
        // it, so its unchanged mint() claims draw from the pot.
        legacyEscrow = new AntseedLegacyEmissionsEscrow(address(realRegistry), address(legacyV2));
        gate.fundLegacyEscrow(address(legacyEscrow));
        legacyV2.setRegistry(address(legacyEscrow));

        usageAccounting = new AntseedUsageAccounting(address(0), address(this), address(gate));
        realRegistry.setEmissions(address(usageAccounting));
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _shareBudget(uint32 shareBps, uint256 epoch) internal view returns (uint256) {
        return (gate.getEpochEmission(epoch) * shareBps) / 100_000;
    }

    function _setVerificationMinter(address verification) internal {
        gate.setMinter(VERIFICATION_MINTER_ID, verification, VERIFICATION_SHARE_BPS, true);
    }

    function _setEmissionMinters(address sellerPoolsMinter, address usageMinter) internal {
        _setSellerPoolsMinter(sellerPoolsMinter);
        _setUsageMinter(usageMinter);
    }

    function _setSellerPoolsMinter(address minter) internal {
        gate.setMinter(SELLER_POOLS_MINTER_ID, minter, SELLER_POOLS_SHARE_BPS, true);
    }

    function _setUsageMinter(address minter) internal {
        gate.setMinter(USAGE_MINTER_ID, minter, USAGE_SHARE_BPS, true);
    }

    function _configuredMinter(bytes32 id) internal view returns (address minter) {
        (minter,,) = gate.minters(id);
    }

    function _claim(bytes32 id, address caller, uint256 epoch) internal {
        uint256 amount = gate.minterEpochBudget(id, epoch) - gate.minterEpochMinted(id, epoch);
        vm.prank(caller);
        gate.claim(epoch, caller, amount);
    }

    function _epochList(uint256 epoch) internal pure returns (uint256[] memory epochs) {
        epochs = new uint256[](1);
        epochs[0] = epoch;
    }

    function _agentId(address seller_) internal pure returns (uint256) {
        return uint160(seller_);
    }

    function _createSellerPool(AntseedSellerPools pools_, address seller_, uint16, bytes32)
        internal
        returns (address poolSeller)
    {
        deal(address(token), seller_, token.balanceOf(seller_) + 1 ether);
        _stakeAgentPool(pools_, seller_, 1 ether, 4);
        poolSeller = seller_;
    }

    function _stakeAgentPool(AntseedSellerPools pools_, address seller_, uint256 amount, uint256 stakeEpochs)
        internal
        returns (uint256 positionId)
    {
        sellerAgentLookup.setAgent(seller_, _agentId(seller_));
        identityRegistry.setOwner(_agentId(seller_), seller_);
        vm.startPrank(seller_);
        token.approve(address(pools_), amount);
        positionId = pools_.stake(_agentId(seller_), amount, stakeEpochs);
        vm.stopPrank();
    }

    function test_preEffectiveEpochsAreNeverMintableByBuckets() public {
        _deployGate(5, address(this), address(0));

        // Every epoch before effectiveEpoch belongs to the legacy escrow and
        // is settled in full at funding time — no bucket, no flag, no window.
        vm.expectRevert(AntseedEmissionsGate.PreEffectiveEpoch.selector);
        gate.claim(2, buyer, 1 ether);
        vm.expectRevert(AntseedEmissionsGate.PreEffectiveEpoch.selector);
        gate.claim(4, buyer, 1 ether);

        _warpGateEpoch(6);
        gate.claim(5, buyer, 1 ether);
        assertEq(token.balanceOf(buyer), 1 ether);
    }

    function test_fundLegacyEscrowMintsExactBacklogOnce() public {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 3 + 1);
        AntseedEmissionsGate freshGate =
            new AntseedEmissionsGate(teamWallet, reserveDest, TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        token.setRegistry(address(freshGate));

        AntseedLegacyEmissionsEscrow escrow =
            new AntseedLegacyEmissionsEscrow(address(realRegistry), address(legacyV2));

        uint256 supplyBefore = token.totalSupply();
        uint256 scheduled = freshGate.cumulativeEmissionThrough(freshGate.effectiveEpoch());
        uint256 funded = freshGate.fundLegacyEscrow(address(escrow));

        assertEq(funded, scheduled - supplyBefore);
        assertEq(token.balanceOf(address(escrow)), funded);
        // Post-funding invariant: supply equals the schedule through the
        // effective epoch — past epochs are settled in full.
        assertEq(token.totalSupply(), scheduled);
        assertEq(freshGate.legacyEscrow(), address(escrow));

        vm.expectRevert(AntseedEmissionsGate.LegacyEscrowAlreadyFunded.selector);
        freshGate.fundLegacyEscrow(address(escrow));
    }

    function test_legacyV2HasNoPendingEmissionsForPostCutoverUsageEpoch() public {
        _deployGate(4);

        _warpGateEpoch(5);
        AntseedUsageAccounting(realRegistry.emissions()).accrueSellerPoints(seller, 1_000);
        AntseedUsageAccounting(realRegistry.emissions()).accrueBuyerPoints(buyer, 1_000);

        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(legacyV2.epochTotalSellerPoints(5), 0);
        assertEq(legacyV2.epochTotalBuyerPoints(5), 0);
        assertEq(legacyV2.userSellerPoints(seller, 5), 0);
        assertEq(legacyV2.userBuyerPoints(buyer, 5), 0);

        (uint256 sellerPendingSeller, uint256 sellerPendingBuyer) = legacyV2.pendingEmissions(seller, _epochList(5));
        (uint256 buyerPendingSeller, uint256 buyerPendingBuyer) = legacyV2.pendingEmissions(buyer, _epochList(5));
        assertEq(sellerPendingSeller, 0);
        assertEq(sellerPendingBuyer, 0);
        assertEq(buyerPendingSeller, 0);
        assertEq(buyerPendingBuyer, 0);
    }

    function test_legacyV2ClaimsPayFromEscrowWithoutMinting() public {
        _deployGate(4);
        legacyV2.setSellerUnlockPolicy(address(new MockAllowAllSellerUnlockPolicy()));

        uint256[] memory epochs = _epochList(2);
        (uint256 sellerPending,) = legacyV2.pendingEmissions(seller, epochs);
        assertGt(sellerPending, 0);

        uint256 supplyBefore = token.totalSupply();
        uint256 escrowBefore = token.balanceOf(address(legacyEscrow));

        vm.prank(seller);
        legacyV2.claimSellerEmissions(epochs);

        // The legacy claim is a transfer from the pot, not a mint: supply is
        // untouched and no gate epoch bookkeeping moves.
        assertEq(token.balanceOf(seller), sellerPending);
        assertEq(token.totalSupply(), supplyBefore);
        assertEq(token.balanceOf(address(legacyEscrow)), escrowBefore - sellerPending);
        assertEq(gate.epochMinted(gate.effectiveEpoch() - 1), 0);

        // The legacy contract has no standing on the gate at all.
        vm.prank(address(legacyV2));
        vm.expectRevert(AntseedEmissionsGate.NotEmissionMinter.selector);
        gate.claim(2, buyer, 1 ether);
    }

    function test_legacyV2FlushesPayTeamAndReserveFromEscrow() public {
        _deployGate(4);
        legacyV2.setSellerUnlockPolicy(address(new MockAllowAllSellerUnlockPolicy()));

        // A claim populates the legacy team/reserve accumulators.
        vm.prank(seller);
        legacyV2.claimSellerEmissions(_epochList(2));

        uint256 teamAccumulated = legacyV2.teamAccumulated();
        uint256 reserveAccumulated = legacyV2.reserveAccumulated();
        assertGt(teamAccumulated, 0);
        assertGt(reserveAccumulated, 0);

        uint256 teamBefore = token.balanceOf(teamWallet);
        uint256 reserveBefore = token.balanceOf(reserveDest);

        // The escrow answers the registry getters the flushes read, so the
        // accumulated legacy team/reserve emissions stay claimable forever.
        legacyV2.flushTeam();
        legacyV2.flushReserve();

        assertEq(token.balanceOf(teamWallet), teamBefore + teamAccumulated);
        assertEq(token.balanceOf(reserveDest), reserveBefore + reserveAccumulated);
    }

    function test_legacyEscrowMintAuthAndSweep() public {
        _deployGate(4);

        vm.prank(buyer);
        vm.expectRevert(AntseedLegacyEmissionsEscrow.NotLegacyEmissions.selector);
        legacyEscrow.mint(buyer, 1 ether);

        // Zero-amount legacy mints (e.g. flushing an empty accumulator) are a
        // harmless no-op.
        vm.prank(address(legacyV2));
        legacyEscrow.mint(buyer, 0);
        assertEq(token.balanceOf(buyer), 0);

        uint256 remainder = token.balanceOf(address(legacyEscrow));
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", buyer));
        legacyEscrow.sweep(buyer);

        uint256 swept = legacyEscrow.sweep(reserveDest);
        assertEq(swept, remainder);
        assertEq(token.balanceOf(reserveDest), remainder);
        assertEq(token.balanceOf(address(legacyEscrow)), 0);
    }

    function test_removeMinterKeepsInFlightEpochShareAndSortedCheckpoints() public {
        // The seller-pools minter was configured in the deploy epoch, so its
        // share is active for the in-flight epoch 5.
        _deployGate(5, address(this), address(0));

        // Rotate the bucket mid-epoch 5: removal must not zero the in-flight
        // epoch's share, and the re-add must keep the checkpoint array sorted.
        gate.removeMinter(SELLER_POOLS_MINTER_ID);
        address newController = address(0xACE);
        gate.setMinter(SELLER_POOLS_MINTER_ID, newController, SELLER_POOLS_SHARE_BPS, true);

        _warpGateEpoch(6);
        uint256 budget = gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5);
        assertEq(budget, _shareBudget(SELLER_POOLS_SHARE_BPS, 5));

        vm.prank(newController);
        gate.claim(5, newController, budget);
        assertEq(token.balanceOf(newController), budget);
    }

    function _setupUsagePool() internal returns (uint256 agentId) {
        return _setupUsagePool(seller);
    }

    function _setupUsagePool(address poolSeller_) internal returns (uint256 agentId) {
        agentId = _setupUsagePoolNoWarp(poolSeller_);
        _warpGateEpoch(5);
    }

    /// @dev Same as _setupUsagePool but stays in the deploy epoch 4 so the
    ///      caller can wire additional minters that must be active at epoch 5
    ///      (minter shares only apply from the NEXT epoch) before warping.
    function _setupUsagePoolNoWarp(address poolSeller_) internal returns (uint256 agentId) {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));

        address poolSeller = _createSellerPool(sellerPools, poolSeller_, 5_000, keccak256("terms"));
        agentId = _agentId(poolSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        sellerPools.stake(agentId, 100 ether, 4);
        vm.stopPrank();
    }

    function _setupDelegationUsageRewards()
        internal
        returns (SellerDelegationHarness delegation, uint256 agentId)
    {
        // The delegation contract is the on-chain seller, exactly like the
        // deployed DiemStakingProxy: it owns the agent and earns the usage.
        delegation = new SellerDelegationHarness(address(realRegistry), operator);
        agentId = _setupUsagePoolNoWarp(address(delegation));

        // The usage minter is wired during epoch 4 — one epoch before the
        // usage it rewards — because its share only applies from the NEXT
        // epoch after setMinter.
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        usageRewards.setSellerPools(address(sellerPools));
        _setUsageMinter(address(usageRewards));

        // Mirrors DeployRecognizedUsage.s.sol adapter wiring.
        usageAccounting.setUsageRewards(address(usageRewards));
        usageRewards.setClaimForwarder(address(usageAccounting));

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(address(delegation), 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);
        _warpGateEpoch(6);
    }

    function test_emissionsReserveReceivesAntsReserveFlowsWhenReserveControllerRotates() public {
        (SellerDelegationHarness delegation, uint256 agentId) = _setupDelegationUsageRewards();
        gate.setMinterController(RESERVE_MINTER_ID, emissionsReserveDest);

        (address reserveController,,) = gate.minters(RESERVE_MINTER_ID);
        assertEq(reserveController, emissionsReserveDest);
        assertEq(gate.emissionsReserve(), emissionsReserveDest);

        // A single dominant agent overflows the 5% per-agent cap; the
        // overflow must land on the reserve minter controller.
        uint256 claimable = usageRewards.pendingAgentReward(agentId, 5);
        uint256 sellerBudget = usageRewards.sellerEpochBudget(5);
        assertGt(sellerBudget, claimable);
        delegation.claimSellerEmissions(_epochList(5));

        assertEq(token.balanceOf(emissionsReserveDest), sellerBudget - claimable);
        assertEq(token.balanceOf(reserveDest), 0);

        // Rotating the reserve minter controller sends later reserve flows to
        // the new controller.
        gate.setMinterController(RESERVE_MINTER_ID, reserveDest);
        usageAccounting.accrueSellerPoints(address(delegation), 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);
        _warpGateEpoch(7);
        delegation.claimSellerEmissions(_epochList(6));
        assertGt(token.balanceOf(reserveDest), 0);
    }

    function test_deployedSellerDelegationClaimsUsageRewardsViaRegistryEmissions() public {
        (SellerDelegationHarness delegation, uint256 agentId) = _setupDelegationUsageRewards();

        // The deployed delegation bytecode resolves the emissions clock and
        // seller emission claims through registry.emissions().
        assertEq(delegation.currentEmissionsEpoch(), gate.currentEpoch());

        uint256 claimable = usageRewards.pendingAgentReward(agentId, 5);
        assertGt(claimable, 0);

        uint256[] memory epochs = _epochList(5);
        (uint256 adapterSeller, uint256 adapterBuyer) =
            usageAccounting.pendingEmissions(address(delegation), epochs);
        assertEq(adapterSeller, claimable);
        assertEq(adapterBuyer, 0);
        assertEq(delegation.pendingSellerEmissions(address(delegation), epochs), (claimable * 9_000) / 10_000);

        uint256 netPayout = delegation.claimSellerEmissions(epochs);

        assertEq(netPayout, (claimable * 9_000) / 10_000);
        assertEq(token.balanceOf(address(delegation)), netPayout);
        assertEq(token.balanceOf(operator), claimable - netPayout);

        // The claimed epoch is masked and a repeat claim is a harmless no-op.
        assertEq(delegation.pendingSellerEmissions(address(delegation), epochs), 0);
        assertEq(delegation.claimSellerEmissions(epochs), 0);
        assertEq(token.balanceOf(address(delegation)), netPayout);
    }

    function test_usageRewardsClaimForwarderIsAuthenticated() public {
        (SellerDelegationHarness delegation, uint256 agentId) = _setupDelegationUsageRewards();

        // Only the configured forwarder may initiate owner-destined claims.
        vm.prank(operator);
        vm.expectRevert(AntseedUsageRewards.NotClaimForwarder.selector);
        usageRewards.claimAgentRewardFor(address(delegation), agentId, 5);

        // The forwarder cannot divert rewards: the claimant must still be the
        // agent owner.
        vm.prank(address(usageAccounting));
        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimAgentRewardFor(operator, agentId, 5);

        // With the forwarder cleared, adapter claims stop working.
        usageRewards.setClaimForwarder(address(0));
        vm.expectRevert(AntseedUsageRewards.NotClaimForwarder.selector);
        delegation.claimSellerEmissions(_epochList(5));
    }

    function test_registryEmissionsAdapterHandlesUnsetAndUnknownSellers() public {
        (SellerDelegationHarness delegation,) = _setupDelegationUsageRewards();
        uint256[] memory epochs = _epochList(5);

        // A seller without a pool agent binding sees zero pending and claims
        // are a silent no-op, mirroring the legacy no-points behavior.
        (uint256 pendingUnknown,) = usageAccounting.pendingEmissions(otherSeller, epochs);
        assertEq(pendingUnknown, 0);
        vm.prank(otherSeller);
        usageAccounting.claimSellerEmissions(epochs);
        assertEq(token.balanceOf(otherSeller), 0);

        // With no rewards controller configured the adapter reports zero and
        // claims revert loudly instead of silently stranding rewards.
        usageAccounting.setUsageRewards(address(0));
        assertEq(delegation.pendingSellerEmissions(address(delegation), epochs), 0);
        vm.expectRevert(IAntseedUsageAccounting.UsageRewardsNotSet.selector);
        delegation.claimSellerEmissions(epochs);
    }

    function _setupStakerRewardsFixture() internal returns (uint256 positionId) {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        positionId = sellerPools.nextPositionId() - 1;
        _warpGateEpoch(5);
    }

    function test_dynamicStakerConfigAppliesFromNextEpoch() public {
        _setupStakerRewardsFixture();
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);
        _warpGateEpoch(6);

        // Epoch 5 has elapsed but nothing has touched it — budget unfrozen.
        uint256 budgetBefore = sellerPoolsRewards.stakerEpochBudget(5);
        assertGt(budgetBefore, 0);

        sellerPoolsRewards.setDynamicStakerConfig(2_000, 40_000, 1);

        assertEq(sellerPoolsRewards.stakerEpochBudget(5), budgetBefore);
        assertEq(sellerPoolsRewards.dynamicStakerConfigAt(5).stakeShareTarget, 400_000_000e18);
        assertEq(sellerPoolsRewards.dynamicStakerConfigAt(gate.currentEpoch() + 1).stakeShareTarget, 1);
    }

    function test_stakerShareTargetScalesWithEmissionHalving() public {
        _setupStakerRewardsFixture();

        // 1 ether staked vs a 3-ether target: share = 2000 + 38000/4 = 11_500.
        sellerPoolsRewards.setDynamicStakerConfig(2_000, 40_000, 3 ether);
        _warpGateEpoch(7);
        assertEq(sellerPoolsRewards.stakerEpochBudget(6), _shareBudget(11_500, 6));

        // Past the halving the target scales to 1.5 ether with the emission,
        // so the same stake earns share = 2000 + 38000/2.5 = 17_200.
        _warpGateEpoch(103);
        deal(address(token), seller, token.balanceOf(seller) + 1 ether);
        _stakeAgentPool(sellerPools, seller, 1 ether, 4);
        _warpGateEpoch(106);
        assertEq(sellerPoolsRewards.stakerEpochBudget(105), _shareBudget(17_200, 105));
    }

    function test_stakerEpochBudgetFreezesAtFirstSettlementUse() public {
        uint256 positionId = _setupStakerRewardsFixture();
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);
        _warpGateEpoch(6);

        uint256 budgetBefore = sellerPoolsRewards.stakerEpochBudget(5);
        sellerPoolsRewards.settleEpochRemainder(5);

        // A later config change must not retroactively resize the settled
        // epoch's budget: remainder and lazy pool settlement share one gate
        // bucket, and a resize would over-commit it.
        sellerPoolsRewards.setDynamicStakerConfig(2_000, 40_000, 1);
        assertGt(_shareBudget(40_000, 5), budgetBefore);
        assertEq(sellerPoolsRewards.stakerEpochBudget(5), budgetBefore);

        sellerPoolsRewards.indexPoolRewards(_agentId(seller), 10);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);
        assertEq(token.balanceOf(seller), budgetBefore);
    }

    function test_rewardsFollowPinnedPoolsTokenAfterRegistryRepoint() public {
        uint256 positionId = _setupStakerRewardsFixture();
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);
        _warpGateEpoch(6);

        // The registry is repointed at a different token after deployment.
        ANTSToken decoyToken = new ANTSToken();
        realRegistry.setAntsToken(address(decoyToken));

        uint256 budget = sellerPoolsRewards.stakerEpochBudget(5);
        assertGt(budget, 0);
        sellerPoolsRewards.indexPoolRewards(_agentId(seller), 10);

        // Rewards must still pay the ANTS the gate mints and pools holds.
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);
        assertEq(token.balanceOf(seller), budget);
        assertEq(decoyToken.balanceOf(seller), 0);
    }

    function test_usageRewardRestakeFollowsPinnedPoolsTokenAfterRegistryRepoint() public {
        uint256 agentId = _setupUsagePoolNoWarp(seller);
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        usageRewards.setSellerPools(address(sellerPools));
        sellerPools.setRewardStaker(address(usageRewards), true);
        _setUsageMinter(address(usageRewards));

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);
        _warpGateEpoch(6);

        ANTSToken decoyToken = new ANTSToken();
        realRegistry.setAntsToken(address(decoyToken));

        uint256 pending = usageRewards.pendingAgentReward(agentId, 5);
        assertGt(pending, 0);

        // The restake path approves and transfers through sellerPools, so it
        // must use the token pools pulls, not the registry's new one.
        vm.prank(seller);
        uint256 newPositionId = usageRewards.stakeAgentReward(agentId, 5, 4);
        (,, uint256 amount,,,,,) = sellerPools.positions(newPositionId);
        assertEq(amount, pending);
    }

    function test_zeroUsageEpochRoutesFullStakerBucketToRemainder() public {
        _setupStakerRewardsFixture();
        // Stake is active in epoch 5 but no usage is recorded.
        _warpGateEpoch(6);

        assertGt(sellerPoolsRewards.stakerEpochBudget(5), 0);

        // No pool can ever mint from a zero-usage epoch, so its entire bucket
        // is remainder — nothing may be stranded outside burn/reserve routing.
        uint256 maxBudget = gate.controllerEpochBudget(address(sellerPoolsRewards), 5);
        (uint256 burnedAmount, uint256 reserveAmount) = sellerPoolsRewards.settleEpochRemainder(5);
        assertEq(burnedAmount + reserveAmount, maxBudget);

        vm.expectRevert(AntseedSellerPoolsRewards.AlreadyClaimed.selector);
        sellerPoolsRewards.settleEpochRemainder(5);
    }

    function test_dynamicUsageConfigAppliesFromNextEpoch() public {
        _setupDelegationUsageRewards();

        // Epoch 5 has elapsed but nothing has touched it — budgets unfrozen.
        uint256 budgetBefore = usageRewards.sellerEpochBudget(5);
        assertGt(budgetBefore, 0);

        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1);

        assertEq(usageRewards.sellerEpochBudget(5), budgetBefore);
        assertEq(usageRewards.dynamicUsageConfigAt(5).volumeShareTarget, 1_000_000e6);
        assertEq(usageRewards.dynamicUsageConfigAt(gate.currentEpoch() + 1).volumeShareTarget, 1);
    }

    function test_usageEpochBudgetsFreezeAtFirstClaim() public {
        (SellerDelegationHarness delegation,) = _setupDelegationUsageRewards();

        uint256 budgetBefore = usageRewards.sellerEpochBudget(5);
        assertGt(budgetBefore, 0);
        delegation.claimSellerEmissions(_epochList(5));

        // A later config change must not resize the epoch's budgets under
        // remaining claimants or the remainder settlement.
        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1);
        assertEq(usageRewards.sellerEpochBudget(5), budgetBefore);
    }

    function test_registryEmissionsAdapterSkipsStaleAgentBinding() public {
        (SellerDelegationHarness delegation, uint256 agentId) = _setupDelegationUsageRewards();

        // The agent NFT moves to a new owner while the seller→agent binding
        // still resolves to the delegation contract. The adapter must degrade
        // to a no-op — a revert would brick the deployed proxy's batched
        // claims.
        identityRegistry.setOwner(agentId, otherSeller);

        uint256[] memory epochs = _epochList(5);
        (uint256 pending,) = usageAccounting.pendingEmissions(address(delegation), epochs);
        assertEq(pending, 0);
        assertEq(delegation.claimSellerEmissions(epochs), 0);
        assertEq(token.balanceOf(address(delegation)), 0);
        assertFalse(usageRewards.agentEpochClaimed(agentId, 5));
    }

    function test_registryEmissionsAdapterSkipsPreEffectiveEpochs() public {
        (SellerDelegationHarness delegation, uint256 agentId) = _setupDelegationUsageRewards();

        // Pre-effective epochs belong to the legacy stack (escrow-settled);
        // the adapter must skip them instead of forwarding a claim the gate
        // refuses.
        uint256[] memory epochs = new uint256[](2);
        epochs[0] = gate.effectiveEpoch() - 1;
        epochs[1] = 5;

        uint256 claimable = usageRewards.pendingAgentReward(agentId, 5);
        (uint256 pending,) = usageAccounting.pendingEmissions(address(delegation), epochs);
        assertEq(pending, claimable);

        uint256 netPayout = delegation.claimSellerEmissions(epochs);
        assertEq(netPayout, (claimable * 9_000) / 10_000);
        assertEq(token.balanceOf(address(delegation)), netPayout);
    }

    function test_poolWeightPolicyDefaultsToLinearPoolPower() public {
        uint256 agentId = _setupUsagePool();

        uint256 poolPower = sellerPools.poolWeightAtEpoch(agentId, 5);
        assertGt(poolPower, 0);

        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 100 * poolPower);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 100 * poolPower);
    }

    function test_poolWeightPolicyConvertsRawPoolPowerToEffectiveWeight() public {
        uint256 agentId = _setupUsagePool();

        uint256 poolPower = sellerPools.poolWeightAtEpoch(agentId, 5);
        uint256 cappedWeight = 7;
        assertGt(poolPower, cappedWeight);
        usageAccounting.setPoolWeightPolicy(address(new MockCappedPoolWeightPolicy(cappedWeight)));

        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        // Raw points are unaffected; only the pool multiplier changes.
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 100);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 100 * cappedWeight);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 100 * cappedWeight);
    }

    function test_poolWeightPolicyClearedRestoresLinearWeighting() public {
        uint256 agentId = _setupUsagePool();

        usageAccounting.setPoolWeightPolicy(address(new MockCappedPoolWeightPolicy(7)));
        usageAccounting.setPoolWeightPolicy(address(0));

        uint256 poolPower = sellerPools.poolWeightAtEpoch(agentId, 5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 100 * poolPower);
    }

    function test_revertingPoolWeightPolicySkipsAccrualWithoutBlockingSettlement() public {
        uint256 agentId = _setupUsagePool();

        usageAccounting.setPoolWeightPolicy(address(new MockRevertingPoolWeightPolicy()));

        // The settlement-facing accrual path must not revert even when the
        // policy is broken; the usage record is skipped instead.
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 0);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 0);
    }

    function test_overflowingPoolWeightPolicyReverts() public {
        _setupUsagePool();

        usageAccounting.setPoolWeightPolicy(address(new MockHugePoolWeightPolicy()));

        // Owner-trust boundary: a policy returning an absurd weight overflows
        // the points * weight multiply and reverts. No defensive guard — the
        // owner sets the policy, and any real policy returns a bounded weight.
        usageAccounting.accrueSellerPoints(seller, 100);
        vm.expectRevert();
        usageAccounting.accrueBuyerPoints(buyer, 100);
    }

    function test_sellerPoolsRewardsUsePostMigrationBucketAndPools() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;
        uint256 pendingReward = sellerPoolsRewards.pendingStakerReward(positionId, 5);
        assertEq(pendingReward, expectedStakerClaim);

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);
        assertEq(token.balanceOf(staker), 900 ether + expectedStakerClaim);
    }

    function test_lantsTransferCarriesUnclaimedStakerRewards() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        sellerPools.transferFrom(staker, operator, positionId);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        vm.expectRevert(AntseedSellerPoolsRewards.NotPositionOwner.selector);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);

        vm.prank(operator);
        sellerPoolsRewards.claimStakerRewards(positionId, operator);
        assertEq(token.balanceOf(operator), expectedStakerClaim);
    }

    function test_burnedLantsPositionKeepsPastRewardClaimRightsAfterWithdraw() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;

        vm.prank(staker);
        sellerPools.withdrawStake(positionId);

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);
        // Epoch 5 was served in full and still pays out; only the exit epoch
        // is forfeited, and the deeper slash reflects the extra unserved epoch.
        assertEq(token.balanceOf(staker), 900 ether + 62.5 ether + expectedStakerClaim);
    }

    function test_burnedLantsPositionKeepsPastRewardClaimRightsAfterMove() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;

        vm.prank(staker);
        sellerPools.moveStake(positionId, _agentId(otherSeller));

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);
        assertEq(token.balanceOf(staker), 900 ether + expectedStakerClaim);
    }

    function test_burnedLantsPositionKeepsRestructureEpochRewardClaimRightsAfterSplit() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(6);
        vm.prank(staker);
        sellerPools.splitStake(positionId, 40 ether);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(7);
        uint256 expectedStakerClaim = (sellerPoolsRewards.stakerEpochBudget(6) * 300 ether) / 303 ether;

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);

        assertEq(token.balanceOf(staker), 900 ether + expectedStakerClaim);
    }

    function test_sellerPoolMaxLockKeepsPowerAtMaxUntilDisabled() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        uint256 agentId = _agentId(seller);
        sellerAgentLookup.setAgent(seller, agentId);
        identityRegistry.setOwner(agentId, seller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(agentId, 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 5), 400 ether);

        vm.prank(staker);
        sellerPools.enableMaxLock(positionId);

        assertEq(sellerPools.positionWeightAtEpoch(positionId, 5), 400 ether);
        assertEq(sellerPools.positionMaxLockPowerAtEpoch(positionId, 6), 10_400 ether);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 6), 10_400 ether);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 20), 10_400 ether);
        assertEq(sellerPools.poolWeightAtEpoch(agentId, 6), 10_400 ether);
        assertEq(sellerPools.poolActiveStakeAtEpoch(agentId, 6), 100 ether);
        assertEq(sellerPools.totalPowerWeightAtEpoch(6), 10_400 ether);

        _warpGateEpoch(7);
        vm.prank(staker);
        sellerPools.disableMaxLock(positionId);

        assertEq(sellerPools.positionWeightAtEpoch(positionId, 7), 10_400 ether);
        assertEq(sellerPools.positionMaxLockPowerAtEpoch(positionId, 8), 0);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 8), 10_400 ether);
        assertEq(sellerPools.positionWeightAtEpoch(positionId, 9), 10_300 ether);
        assertEq(sellerPools.poolWeightAtEpoch(agentId, 9), 10_300 ether);
    }

    function test_sellerPoolsRewardsUseMaxLockPowerForEpochShare() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        uint256 agentId = _agentId(seller);
        sellerAgentLookup.setAgent(seller, agentId);
        identityRegistry.setOwner(agentId, seller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 200 ether);
        uint256 maxLockedPositionId = sellerPools.stake(agentId, 100 ether, 4);
        uint256 normalPositionId = sellerPools.stake(agentId, 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        vm.prank(staker);
        sellerPools.enableMaxLock(maxLockedPositionId);

        _warpGateEpoch(6);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(7);
        uint256 expectedBudget = sellerPoolsRewards.stakerEpochBudget(6);
        uint256 maxLockPower = 10_400 ether;
        uint256 normalPower = 300 ether;
        uint256 maxLockedGross = sellerPoolsRewards.pendingStakerReward(maxLockedPositionId, 6);
        uint256 normalGross = sellerPoolsRewards.pendingStakerReward(normalPositionId, 6);

        assertEq(maxLockedGross, (expectedBudget * maxLockPower) / (maxLockPower + normalPower));
        assertEq(normalGross, (expectedBudget * normalPower) / (maxLockPower + normalPower));
    }

    function test_sellerPoolsRewardsIndexedClaimUsesCursor() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        vm.startPrank(staker);
        token.approve(address(sellerPools), 100 ether);
        uint256 positionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256 expectedClaim = (sellerPoolsRewards.stakerEpochBudget(5) * 400 ether) / 404 ether;

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        assertEq(sellerPoolsRewards.poolRewardIndexNextEpoch(_agentId(poolSeller)), 6);
        assertEq(sellerPoolsRewards.pendingIndexedStakerReward(positionId), expectedClaim);

        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);

        assertEq(token.balanceOf(staker), 900 ether + expectedClaim);
        assertEq(sellerPoolsRewards.positionClaimCursor(positionId), 6);

        vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(positionId, staker);
    }

    function test_sellerPoolsRewardsIndexedClaimUsesExtendedLockSegments() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        uint256 agentId = _agentId(seller);
        sellerAgentLookup.setAgent(seller, agentId);
        identityRegistry.setOwner(agentId, seller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 200 ether);
        uint256 extendedPositionId = sellerPools.stake(agentId, 100 ether, 4);
        uint256 normalPositionId = sellerPools.stake(agentId, 100 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        vm.prank(staker);
        sellerPools.extendLock(extendedPositionId, 3);

        _warpGateEpoch(6);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(7);
        sellerPoolsRewards.indexPoolRewards(agentId, 10);

        uint256 epoch5Budget = sellerPoolsRewards.stakerEpochBudget(5);
        uint256 epoch6Budget = sellerPoolsRewards.stakerEpochBudget(6);
        uint256 expectedClaim = (epoch5Budget * 400 ether) / 800 ether + (epoch6Budget * 600 ether) / 900 ether;

        assertEq(sellerPoolsRewards.pendingIndexedStakerReward(extendedPositionId), expectedClaim);

        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewards(extendedPositionId, staker);

        assertEq(token.balanceOf(staker), 800 ether + expectedClaim);
        assertEq(sellerPoolsRewards.positionClaimCursor(extendedPositionId), 7);

        uint256 normalEpoch5Gross = sellerPoolsRewards.pendingStakerReward(normalPositionId, 5);
        uint256 normalEpoch6Gross = sellerPoolsRewards.pendingStakerReward(normalPositionId, 6);
        assertEq(normalEpoch5Gross, (epoch5Budget * 400 ether) / 800 ether);
        assertEq(normalEpoch6Gross, (epoch6Budget * 300 ether) / 900 ether);
    }

    function test_sellerPoolsRewardsDoNotClaimWithoutWeightedPoints() public {
        _deployGate(5);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;

        vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);
    }

    function test_gateFixedCurveAndAdminValidation() public {
        // Seller-pools and usage minters are wired in the deploy epoch so
        // their shares are active at epoch 4 (== effectiveEpoch).
        _deployGate(4, address(this), address(0xBEEF));
        assertEq(gate.emissions(), address(gate));
        assertEq(gate.controllerMinterIds(address(legacyV2)), bytes32(0));
        assertEq(_configuredMinter(TEAM_MINTER_ID), teamWallet);
        assertEq(_configuredMinter(RESERVE_MINTER_ID), reserveDest);
        assertEq(gate.genesis(), 1_775_728_461);
        assertEq(gate.epochDuration(), 7 days);
        assertEq(gate.HALVING_INTERVAL(), 104);
        assertEq(gate.INITIAL_EMISSION(), 5_000_000 ether);
        assertEq(gate.effectiveEpoch(), 4);
        assertEq(gate.currentEmissionRate(), gate.INITIAL_EMISSION() / gate.epochDuration());
        assertEq(gate.SHARE_DENOMINATOR(), 100_000);
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(USAGE_MINTER_ID, 4), _shareBudget(USAGE_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(TEAM_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.minterEpochBudget(RESERVE_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.minterEpochBudget(VERIFICATION_MINTER_ID, 4), _shareBudget(VERIFICATION_SHARE_BPS, 4));

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        _setVerificationMinter(address(0));

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        _setSellerPoolsMinter(address(0));

        vm.expectRevert(AntseedEmissionsGate.InvalidMinterId.selector);
        gate.setMinter(bytes32(0), address(this), 1, true);

        vm.expectRevert(AntseedEmissionsGate.InvalidMinterId.selector);
        gate.removeMinter(bytes32(0));

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(TEAM_MINTER_ID, address(0xB0B), TEAM_SHARE_BPS, true);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.removeMinter(RESERVE_MINTER_ID);

        address newTeamWallet = address(0xB0B);
        gate.setMinterController(TEAM_MINTER_ID, newTeamWallet);
        assertEq(_configuredMinter(TEAM_MINTER_ID), newTeamWallet);
        assertEq(gate.minterEpochBudget(TEAM_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.controllerMinterIds(teamWallet), bytes32(0));
        assertEq(gate.controllerMinterIds(newTeamWallet), TEAM_MINTER_ID);

        _setSellerPoolsMinter(address(this));
        assertEq(_configuredMinter(SELLER_POOLS_MINTER_ID), address(this));
        assertEq(gate.controllerMinterIds(address(this)), SELLER_POOLS_MINTER_ID);

        vm.expectRevert(AntseedEmissionsGate.InvalidMinterId.selector);
        gate.setMinter(CUSTOM_MINTER_ID, address(this), 1, true);

        address newMinter = address(0xCAFE);
        gate.removeMinter(SELLER_POOLS_MINTER_ID);
        _setSellerPoolsMinter(newMinter);
        assertEq(_configuredMinter(SELLER_POOLS_MINTER_ID), newMinter);

        assertEq(_configuredMinter(TEAM_MINTER_ID), newTeamWallet);
        assertEq(_configuredMinter(RESERVE_MINTER_ID), reserveDest);
        assertEq(_configuredMinter(VERIFICATION_MINTER_ID), verificationWallet);
    }

    function test_gateCanRenounceEmissionAdminControl() public {
        // A fresh gate without a funded escrow cannot be renounced: the
        // backlog settlement is part of the required wiring.
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 3 + 1);
        AntseedEmissionsGate freshGate =
            new AntseedEmissionsGate(teamWallet, reserveDest, TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        freshGate.setMinter(VERIFICATION_MINTER_ID, verificationWallet, VERIFICATION_SHARE_BPS, true);
        freshGate.setMinter(SELLER_POOLS_MINTER_ID, address(this), SELLER_POOLS_SHARE_BPS, true);
        freshGate.setMinter(USAGE_MINTER_ID, address(0xBEEF), USAGE_SHARE_BPS, true);
        vm.expectRevert(AntseedEmissionsGate.LegacyEscrowNotFunded.selector);
        freshGate.renounceOwnership();

        _deployGate(4, address(this), address(0xBEEF));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));

        gate.renounceOwnership();
        assertEq(gate.owner(), address(0));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.currentEmissionRate(), gate.INITIAL_EMISSION() / gate.epochDuration());

        vm.expectRevert();
        _setSellerPoolsMinter(address(this));

        _warpGateEpoch(5);
        gate.claim(4, address(this), 1 ether);
        assertEq(token.balanceOf(address(this)), 1 ether);
    }

    function test_gatePairsLegacySellerBuyerAccruals() public {
        _deployGate(5);

        usageAccounting.accrueSellerPoints(seller, 123);
        assertEq(usageAccounting.pendingSellerAccrual(), seller);

        usageAccounting.accrueBuyerPoints(buyer, 123);
        assertEq(usageAccounting.pendingSellerAccrual(), address(0));

        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
    }

    function test_gateAccrualValidationAndFutureChannelIdPath() public {
        _deployGate(5);

        // Non-recorder accruals are skipped, not reverted, so settlement
        // through a revoked recorder keeps working without emissions.
        vm.prank(seller);
        usageAccounting.accrueSellerPoints(seller, 1);
        assertEq(usageAccounting.pendingSellerAccrual(), address(0));

        vm.expectRevert(IAntseedUsageAccounting.InvalidAddress.selector);
        usageAccounting.accrueSellerPoints(address(0), 1);

        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.accrueSellerPoints(seller, 0);

        usageAccounting.accrueSellerPoints(seller, 10);
        // A repeated seller accrual is a plain overwrite, never a revert:
        // this runs inline in the Channels settle path.
        usageAccounting.accrueSellerPoints(seller, 10);

        // Completing the pair clears the slot (no pools set, so nothing is
        // recorded); the buyer leg's delta is used, unchecked against the
        // seller leg.
        usageAccounting.accrueBuyerPoints(buyer, 9);
        vm.expectRevert(IAntseedUsageAccounting.NoPendingSellerAccrual.selector);
        usageAccounting.accrueBuyerPoints(buyer, 10);

        usageAccounting.accruePoints(bytes32(0), buyer, seller, 1);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);

        bytes32 channelId = keccak256("ignored-channel-id");
        usageAccounting.accruePoints(channelId, buyer, seller, 77);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 0);
    }

    function test_usageAccountingTracksBuyerAgentRatiosByEpoch() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));
        _createSellerPool(sellerPools, otherSeller, 5_000, keccak256("other-seller"));

        address secondBuyer = address(0x21);
        uint256 sellerAgentId = _agentId(seller);
        uint256 otherAgentId = _agentId(otherSeller);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("buyer-seller-1"), buyer, seller, 10);
        usageAccounting.accruePoints(keccak256("buyer-seller-2"), buyer, seller, 20);
        usageAccounting.accruePoints(keccak256("buyer-other-seller"), buyer, otherSeller, 30);
        usageAccounting.accruePoints(keccak256("second-buyer-seller"), secondBuyer, seller, 40);

        IAntseedUsageAccounting.BuyerUsage memory buyerUsage = usageAccounting.buyerEpochUsage(5, buyer);
        assertEq(buyerUsage.points, 60);
        assertEq(buyerUsage.weightedPoints, usageAccounting.weightedBuyerPointsByEpoch(5, buyer));

        IAntseedUsageAccounting.BuyerUsage memory buyerSellerUsage =
            usageAccounting.buyerAgentEpochUsage(5, buyer, sellerAgentId);
        assertEq(buyerSellerUsage.points, 30);
        assertEq((buyerSellerUsage.points * 10_000) / buyerUsage.points, 5_000);

        IAntseedUsageAccounting.BuyerUsage memory buyerTotalUsage = usageAccounting.buyerUsageTotal(buyer);
        assertEq(buyerTotalUsage.points, 60);

        IAntseedUsageAccounting.BuyerUsage memory buyerSellerTotalUsage =
            usageAccounting.buyerAgentUsageTotal(buyer, sellerAgentId);
        assertEq(buyerSellerTotalUsage.points, 30);
        assertEq((buyerSellerTotalUsage.points * 10_000) / buyerTotalUsage.points, 5_000);

        IAntseedUsageAccounting.BuyerUsage memory buyerOtherSellerUsage =
            usageAccounting.buyerAgentEpochUsage(5, buyer, otherAgentId);
        assertEq(buyerOtherSellerUsage.points, 30);
        assertEq((buyerOtherSellerUsage.points * 10_000) / buyerUsage.points, 5_000);

        IAntseedUsageAccounting.SellerUsage memory sellerAgentUsage = usageAccounting.agentEpochUsage(5, sellerAgentId);
        assertEq(sellerAgentUsage.points, 70);
        assertEq(sellerAgentUsage.weightedPoints, usageAccounting.weightedPoolPointsByEpoch(5, sellerAgentId));
        assertEq(usageAccounting.sellerAgentIdByEpoch(5, seller), sellerAgentId);

        IAntseedUsageAccounting.UsageTotals memory epochUsage = usageAccounting.epochUsage(5);
        assertEq(epochUsage.buyers.points, 100);
        assertEq(epochUsage.sellers.points, 100);

        IAntseedUsageAccounting.UsageTotals memory totalUsage = usageAccounting.totalUsage();
        assertEq(totalUsage.buyers.points, 100);
        assertEq(totalUsage.sellers.points, 100);
    }

    function test_usageAccountingRequiresMinimumAccountedPoolPower() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));

        uint256 agentId = _agentId(seller);

        _warpGateEpoch(5);
        uint256 poolPower = sellerPools.poolWeightAtEpoch(agentId, 5);
        assertGt(poolPower, 0);
        assertEq(usageAccounting.minimumAccountedPoolPower(), 1);

        usageAccounting.setMinimumAccountedPoolPower(poolPower + 1);
        usageAccounting.accruePoints(keccak256("below-minimum"), buyer, seller, 10);

        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 0);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), 0);

        usageAccounting.setMinimumAccountedPoolPower(poolPower);
        usageAccounting.accruePoints(keccak256("at-minimum"), buyer, seller, 10);

        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 10);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 10 * poolPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 10 * poolPower);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), 10 * poolPower);

        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.setMinimumAccountedPoolPower(0);
    }

    /// @dev Gas snapshots for this group live in AntseedUsageAccountingGas.t.sol.
    ///      This case keeps the ordering assertions without writing the shared
    ///      "usage-accounting" group, which two writers would make run-order dependent.
    function test_usageAccountingRecordUsageCaseOrdering() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("seller"));
        _createSellerPool(sellerPools, otherSeller, 5_000, keccak256("other-seller"));

        address secondBuyer = address(0x21);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("warm-pair"), buyer, seller, 10);

        uint256 gasBefore = gasleft();
        usageAccounting.accruePoints(keccak256("repeat-pair"), buyer, seller, 10);
        uint256 repeatedGas = gasBefore - gasleft();

        gasBefore = gasleft();
        usageAccounting.accruePoints(keccak256("new-buyer"), secondBuyer, seller, 10);
        uint256 newBuyerGas = gasBefore - gasleft();

        gasBefore = gasleft();
        usageAccounting.accruePoints(keccak256("new-agent"), buyer, otherSeller, 10);
        uint256 newAgentGas = gasBefore - gasleft();

        assertGt(repeatedGas, 0);
        assertGt(newBuyerGas, repeatedGas);
        assertGt(newAgentGas, repeatedGas);
    }

    function test_sellerPoolsRewardsRecordsWeightedPoolPoints() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 10);
        assertGt(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);

        _warpGateEpoch(6);
        uint256 positionId = sellerPools.nextPositionId() - 1;
        uint256 pendingReward = sellerPoolsRewards.pendingStakerReward(positionId, 5);
        assertEq(pendingReward, sellerPoolsRewards.stakerEpochBudget(5));

        assertEq(token.balanceOf(seller), 0);
    }

    function test_pointsPolicyCanZeroOrScaleSellerPoolPoints() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        MockUsagePointsPolicy policy = new MockUsagePointsPolicy();
        usageAccounting.setPointsPolicy(address(policy));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("unverified"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.poolPointsByEpoch(5, poolSeller), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);

        policy.setSellerWeightBps(seller, 5_000);
        uint256 poolPower = sellerPools.poolWeightAtEpoch(poolSeller, 5);
        usageAccounting.accruePoints(keccak256("verified-half"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 5);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 20);
        assertEq(usageAccounting.poolPointsByEpoch(5, poolSeller), 5);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, seller), poolPower * 5);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), poolPower * 5);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), poolPower * 5);
    }

    function test_poolWeightedPointsAreSavedUncapped() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));

        uint256 honestStake = 1_000_000 ether;
        uint256 washStake = 100 ether;
        deal(address(token), seller, honestStake);
        deal(address(token), otherSeller, washStake);

        vm.startPrank(seller);
        token.approve(address(sellerPools), honestStake);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        sellerPools.stake(_agentId(seller), honestStake, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), washStake);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        sellerPools.stake(_agentId(otherSeller), washStake, 52);
        vm.stopPrank();

        address honestSeller = seller;
        address washSeller = otherSeller;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("honest"), buyer, seller, 1_000);
        usageAccounting.accruePoints(keccak256("wash"), address(0x21), otherSeller, 1_000_000);

        uint256 honestPower = sellerPools.poolWeightAtEpoch(honestSeller, 5);
        uint256 washPower = sellerPools.poolWeightAtEpoch(washSeller, 5);

        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washSeller), 1_000_000 * washPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, honestSeller), 1_000 * honestPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washSeller), 1_000_000 * washPower);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), (1_000 * honestPower) + (1_000_000 * washPower));
    }

    function test_stakerDynamicBudgetDistributesHighVolumeReward() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        deal(address(token), seller, 1_000_000 ether);
        deal(address(token), otherSeller, 100 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 1_000_000 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        uint256 honestPositionId = sellerPools.stake(_agentId(seller), 1_000_000 ether, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        uint256 washPositionId = sellerPools.stake(_agentId(otherSeller), 100 ether, 52);
        vm.stopPrank();

        address honestSeller = seller;
        address washSeller = otherSeller;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("honest"), buyer, seller, 1_000);
        usageAccounting.accruePoints(keccak256("wash"), address(0x21), otherSeller, 1_000_000);

        uint256 honestPoints = usageAccounting.weightedPoolPointsByEpoch(5, honestSeller);
        uint256 washPoints = usageAccounting.weightedPoolPointsByEpoch(5, washSeller);
        uint256 totalPoints = usageAccounting.totalWeightedPoolPointsByEpoch(5);

        _warpGateEpoch(6);
        uint256 stakerBudget = sellerPoolsRewards.stakerEpochBudget(5);
        uint256 expectedHonestReward = (stakerBudget * honestPoints) / totalPoints;
        uint256 expectedWashReward = (stakerBudget * washPoints) / totalPoints;
        uint256 honestReward = sellerPoolsRewards.pendingStakerReward(honestPositionId, 5);
        uint256 washReward = sellerPoolsRewards.pendingStakerReward(washPositionId, 5);
        assertEq(honestReward, expectedHonestReward);
        assertEq(washReward, expectedWashReward);
    }

    function test_stakerRemainderRoutesThroughGateBurnCapToReserve() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        deal(address(token), otherSeller, 100 ether);
        uint256 positionId = _stakeAgentPool(sellerPools, otherSeller, 100 ether, 52);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("wash"), buyer, otherSeller, 1_000_000_000);

        _warpGateEpoch(6);
        uint256 maxBudget = gate.controllerEpochBudget(address(sellerPoolsRewards), 5);
        uint256 allocatedBudget = sellerPoolsRewards.stakerEpochBudget(5);
        uint256 unallocated = maxBudget - allocatedBudget;
        uint256 burnCap = gate.getEpochEmission(5) * gate.BURN_CAP_BPS() / gate.SHARE_DENOMINATOR();

        sellerPoolsRewards.indexPoolRewards(_agentId(otherSeller), 10);
        sellerPoolsRewards.settleEpochRemainder(5);
        uint256 indexedClaimableReward = sellerPoolsRewards.pendingIndexedStakerReward(positionId);
        vm.prank(otherSeller);
        sellerPoolsRewards.claimStakerRewards(positionId, otherSeller);

        assertEq(token.balanceOf(otherSeller), indexedClaimableReward);
        assertEq(token.balanceOf(gate.DEAD_ADDRESS()), unallocated < burnCap ? unallocated : burnCap);
        assertEq(token.balanceOf(reserveDest), unallocated > burnCap ? unallocated - burnCap : 0);
        assertEq(gate.epochBurnedAmount(5), unallocated < burnCap ? unallocated : burnCap);
        (bool settled, uint256 settledAmount) = sellerPoolsRewards.poolEpochEmissions(5, _agentId(otherSeller));
        assertTrue(settled);
        assertApproxEqAbs(settledAmount, indexedClaimableReward, 1);
    }

    function test_stressWashTradingBuyerRewardRemainsCappedAfterStakerApyCapRemoval() public {
        address washBuyer = address(0x9999);
        StressRun memory run;

        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));
        _setUsageMinter(address(usageRewards));

        deal(address(token), seller, 1_000_000 ether);
        deal(address(token), otherSeller, 100 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 1_000_000 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        run.firstPositionId = sellerPools.stake(_agentId(seller), 1_000_000 ether, 52);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        run.washPositionId = sellerPools.stake(_agentId(otherSeller), 100 ether, 52);
        vm.stopPrank();

        {
            uint256 honestBuyerCount = 1_000;
            uint256 honestBuyerVolume = 1_000;
            uint256 honestTotalVolume = honestBuyerCount * honestBuyerVolume;
            uint256 washVolume = 100_000_000_000;

            _warpGateEpoch(5);
            for (uint256 i = 0; i < honestBuyerCount; i++) {
                address honestBuyer = address(uint160(0x20000 + i));
                usageAccounting.accruePoints(
                    keccak256(abi.encodePacked("honest", i)), honestBuyer, seller, honestBuyerVolume
                );
            }
            usageAccounting.accruePoints(keccak256("wash"), washBuyer, otherSeller, washVolume);

            uint256 honestAgentId = _agentId(seller);
            uint256 washAgentId = _agentId(otherSeller);
            uint256 honestPower = sellerPools.poolWeightAtEpoch(honestAgentId, 5);
            uint256 washPower = sellerPools.poolWeightAtEpoch(washAgentId, 5);
            run.firstWeightedPoints = honestTotalVolume * honestPower;
            run.washWeightedPoints = washVolume * washPower;
            run.expectedTotalWeightedPoints = run.firstWeightedPoints + run.washWeightedPoints;

            assertEq(usageAccounting.agentPoolPointsByEpoch(5, honestAgentId), honestTotalVolume);
            assertEq(usageAccounting.agentPoolPointsByEpoch(5, washAgentId), washVolume);
            assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), washVolume * washPower);
            assertEq(usageAccounting.weightedPoolPointsByEpoch(5, honestAgentId), run.firstWeightedPoints);
            assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), run.washWeightedPoints);
            assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), run.expectedTotalWeightedPoints);

            assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, washBuyer), run.washWeightedPoints);
            assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), run.expectedTotalWeightedPoints);
        }

        _warpGateEpoch(6);
        {
            uint256 sellerPoolsBudget = sellerPoolsRewards.stakerEpochBudget(5);
            uint256 honestReward = sellerPoolsRewards.pendingStakerReward(run.firstPositionId, 5);
            uint256 washReward = sellerPoolsRewards.pendingStakerReward(run.washPositionId, 5);
            run.firstClaimable = honestReward;
            run.washClaimable = washReward;
            assertEq(honestReward, (sellerPoolsBudget * run.firstWeightedPoints) / run.expectedTotalWeightedPoints);
            assertEq(washReward, (sellerPoolsBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints);
        }

        {
            uint256 buyerSideBudget = usageRewards.buyerEpochBudget(5);
            uint256 expectedWashBuyerReward =
                (buyerSideBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints;
            uint256 washBuyerCap =
                (buyerSideBudget * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
            uint256 cappedWashBuyerReward =
                expectedWashBuyerReward < washBuyerCap ? expectedWashBuyerReward : washBuyerCap;
            assertEq(usageRewards.pendingBuyerReward(washBuyer, 5), cappedWashBuyerReward);
            assertLt(usageRewards.pendingBuyerReward(washBuyer, 5), expectedWashBuyerReward);
        }

        assertGt(run.washWeightedPoints, run.firstWeightedPoints);
        assertGt(run.washClaimable, run.firstClaimable);
        assertLe(run.washClaimable, sellerPoolsRewards.stakerEpochBudget(5));
    }

    function test_stressThousandAgentsAndBuyersClaimFromSavedTotals() public {
        uint256 agentCount = 1_000;
        uint256 honestVolume = 1_000;
        uint256 washVolume = 1_000_000_000;
        address firstSeller = address(uint160(0x30000));
        address firstBuyer = address(uint160(0x40000));
        address washSeller = address(uint160(0x30000 + agentCount - 1));
        address washBuyer = address(uint160(0x40000 + agentCount - 1));
        StressRun memory run;

        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));
        _setUsageMinter(address(usageRewards));

        vm.pauseGasMetering();
        for (uint256 i = 0; i < agentCount; i++) {
            address seller_ = address(uint160(0x30000 + i));
            uint256 stakeAmount = seller_ == washSeller ? 100 ether : 1_000 ether;
            deal(address(token), seller_, stakeAmount);
            uint256 positionId = _stakeAgentPool(sellerPools, seller_, stakeAmount, 52);
            if (seller_ == firstSeller) run.firstPositionId = positionId;
            if (seller_ == washSeller) run.washPositionId = positionId;
        }
        vm.resumeGasMetering();

        _warpGateEpoch(5);
        for (uint256 i = 0; i < agentCount; i++) {
            address seller_ = address(uint160(0x30000 + i));
            address buyer_ = address(uint160(0x40000 + i));
            uint256 volume = seller_ == washSeller ? washVolume : honestVolume;

            usageAccounting.accruePoints(keccak256(abi.encodePacked("stress", i)), buyer_, seller_, volume);

            uint256 weightedPoints = volume * sellerPools.poolWeightAtEpoch(_agentId(seller_), 5);
            run.expectedTotalWeightedPoints += weightedPoints;
            if (seller_ == firstSeller) run.firstWeightedPoints = weightedPoints;
            if (seller_ == washSeller) run.washWeightedPoints = weightedPoints;
        }

        uint256 firstAgentId = _agentId(firstSeller);
        uint256 washAgentId = _agentId(washSeller);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), run.expectedTotalWeightedPoints);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), run.expectedTotalWeightedPoints);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, firstAgentId), run.firstWeightedPoints);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, washAgentId), run.washWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, firstBuyer), run.firstWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, washBuyer), run.washWeightedPoints);

        _warpGateEpoch(6);
        {
            uint256 sellerPoolsBudget = sellerPoolsRewards.stakerEpochBudget(5);
            uint256 expectedFirstGross = (sellerPoolsBudget * run.firstWeightedPoints) / run.expectedTotalWeightedPoints;
            uint256 expectedWashGross = (sellerPoolsBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints;

            uint256 firstReward = sellerPoolsRewards.pendingStakerReward(run.firstPositionId, 5);
            uint256 washReward = sellerPoolsRewards.pendingStakerReward(run.washPositionId, 5);
            run.firstClaimable = firstReward;
            run.washClaimable = washReward;
            assertEq(firstReward, expectedFirstGross);
            assertEq(washReward, expectedWashGross);
        }

        sellerPoolsRewards.indexPoolRewards(firstAgentId, 10);
        run.firstClaimable = sellerPoolsRewards.pendingIndexedStakerReward(run.firstPositionId);
        vm.prank(firstSeller);
        sellerPoolsRewards.claimStakerRewards(run.firstPositionId, firstSeller);
        sellerPoolsRewards.indexPoolRewards(washAgentId, 10);
        run.washClaimable = sellerPoolsRewards.pendingIndexedStakerReward(run.washPositionId);
        vm.prank(washSeller);
        sellerPoolsRewards.claimStakerRewards(run.washPositionId, washSeller);
        assertEq(token.balanceOf(firstSeller), run.firstClaimable);
        assertEq(token.balanceOf(washSeller), run.washClaimable);
        assertEq(token.balanceOf(gate.DEAD_ADDRESS()), 0);
        assertEq(gate.epochBurnedAmount(5), 0);

        {
            uint256 buyerSideBudget = usageRewards.buyerEpochBudget(5);
            uint256 washBuyerGross = (buyerSideBudget * run.washWeightedPoints) / run.expectedTotalWeightedPoints;
            uint256 washBuyerCap =
                (buyerSideBudget * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
            uint256 washBuyerClaimable = washBuyerGross < washBuyerCap ? washBuyerGross : washBuyerCap;
            assertEq(usageRewards.pendingBuyerReward(washBuyer, 5), washBuyerClaimable);

            address washOperator = address(0x50000);
            deposits.setOperator(washBuyer, washOperator);
            vm.prank(washOperator);
            usageRewards.claimBuyerReward(washBuyer, 5);
            assertEq(token.balanceOf(washBuyer), 0);
            assertEq(token.balanceOf(washOperator), washBuyerClaimable);
        }
    }

    function test_stakeCreatedDuringEpochDoesNotEarnUntilNextEpoch() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        usageAccounting.accruePoints(keccak256("same-epoch"), buyer, seller, 10);
        assertEq(usageAccounting.sellerPointsByEpoch(4, seller), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(4, buyer), 0);
        assertEq(usageAccounting.poolPointsByEpoch(4, poolSeller), 0);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(4, poolSeller), 0);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("next-epoch"), buyer, seller, 10);
        assertGt(usageAccounting.weightedPoolPointsByEpoch(5, poolSeller), 0);
    }

    function test_buyerRewardsRequirePoolWeightedBuyerPoints() public {
        address secondBuyer = address(0x21);
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        MockUsagePointsPolicy policy = new MockUsagePointsPolicy();
        policy.setSellerWeightBps(seller, 0);
        policy.setBuyerWeightBps(0);
        usageAccounting.setPointsPolicy(address(policy));

        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        _setUsageMinter(address(usageRewards));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("buyer-one"), buyer, seller, 10);
        usageAccounting.accruePoints(keccak256("buyer-two"), secondBuyer, seller, 30);

        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.buyerPointsByEpoch(5, secondBuyer), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 0);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), 0);

        _warpGateEpoch(6);
        assertEq(usageRewards.pendingBuyerReward(buyer, 5), 0);
        assertEq(usageRewards.pendingBuyerReward(secondBuyer, 5), 0);
    }

    function test_usageDynamicBudgetsFollowSameEpochVolume() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1_000);
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(4);
        assertEq(usageRewards.buyerEpochBudget(4), 0);
        assertEq(usageRewards.sellerEpochBudget(4), 0);
        assertEq(usageRewards.allocatedEpochBudget(4), 0);

        usageAccounting.accruePoints(keccak256("same-epoch-volume"), buyer, seller, 1_000);

        uint256 expectedSideBudget = _shareBudget(7_500, 4);
        assertEq(usageRewards.buyerEpochBudget(4), expectedSideBudget);
        assertEq(usageRewards.sellerEpochBudget(4), expectedSideBudget);
        assertEq(usageRewards.allocatedEpochBudget(4), expectedSideBudget * 2);
        assertLt(usageRewards.allocatedEpochBudget(4), gate.controllerEpochBudget(address(usageRewards), 4));
    }

    function test_usageDynamicBudgetsScaleDownToGateBucket() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1_000);
        _setUsageMinter(address(usageRewards));
        gate.setMinter(USAGE_MINTER_ID, address(usageRewards), 10_000, true);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(4);
        usageAccounting.accruePoints(keccak256("same-epoch-volume"), buyer, seller, 1_000);

        uint256 maxBudget = gate.controllerEpochBudget(address(usageRewards), 4);
        assertEq(usageRewards.allocatedEpochBudget(4), maxBudget);
        assertEq(usageRewards.buyerEpochBudget(4), maxBudget / 2);
        assertEq(usageRewards.sellerEpochBudget(4), maxBudget - maxBudget / 2);
    }

    function test_usageRemainderRoutesThroughGlobalBurnCap() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1_000);
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        _warpGateEpoch(4);
        usageAccounting.accruePoints(keccak256("same-epoch-volume"), buyer, seller, 1_000);

        _warpGateEpoch(5);
        uint256 maxBudget = gate.controllerEpochBudget(address(usageRewards), 4);
        uint256 allocatedBudget = usageRewards.allocatedEpochBudget(4);
        uint256 unallocated = maxBudget - allocatedBudget;

        (uint256 burnedAmount, uint256 reserveAmount) = usageRewards.settleEpochRemainder(4);
        assertEq(burnedAmount, unallocated);
        assertEq(reserveAmount, 0);
        assertEq(token.balanceOf(gate.DEAD_ADDRESS()), burnedAmount);
        assertEq(gate.epochBurnedAmount(4), burnedAmount);

        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.settleEpochRemainder(4);
    }

    function test_unclaimableSideBudgetRoutesToRemainder() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        usageRewards.setDynamicUsageConfig(5_000, 10_000, 5_000, 10_000, 1_000);
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        // Buyer-only policy: the mock's seller weight defaults to zero, so an
        // entire epoch accrues buyer points and no seller points.
        MockUsagePointsPolicy policy = new MockUsagePointsPolicy();
        usageAccounting.setPointsPolicy(address(policy));

        _warpGateEpoch(4);
        usageAccounting.accruePoints(keccak256("buyer-only-volume"), buyer, seller, 1_000);

        _warpGateEpoch(5);
        uint256 maxBudget = gate.controllerEpochBudget(address(usageRewards), 4);
        uint256 buyerBudget = usageRewards.buyerEpochBudget(4);
        uint256 sellerBudget = usageRewards.sellerEpochBudget(4);
        assertGt(sellerBudget, 0);

        // The seller budget has no possible claimant ...
        vm.prank(seller);
        vm.expectRevert(AntseedUsageRewards.NothingToClaim.selector);
        usageRewards.claimAgentReward(_agentId(seller), 4);

        // ... so it must reach a terminal destination through the remainder.
        (uint256 burnedAmount, uint256 reserveAmount) = usageRewards.settleEpochRemainder(4);
        assertEq(burnedAmount + reserveAmount, maxBudget - buyerBudget);
    }

    function test_usageRewardsUsePoolWeightedShareAndOperatorRecipient() public {
        address secondBuyer = address(0x21);
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));

        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        _setUsageMinter(address(usageRewards));

        deal(address(token), seller, 100 ether);
        deal(address(token), otherSeller, 10 ether);

        vm.startPrank(seller);
        token.approve(address(sellerPools), 100 ether);
        sellerAgentLookup.setAgent(seller, _agentId(seller));
        identityRegistry.setOwner(_agentId(seller), seller);
        sellerPools.stake(_agentId(seller), 100 ether, 4);
        vm.stopPrank();

        vm.startPrank(otherSeller);
        token.approve(address(sellerPools), 10 ether);
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);
        sellerPools.stake(_agentId(otherSeller), 10 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(4);
        usageAccounting.accruePoints(keccak256("high-power"), buyer, seller, 100);
        usageAccounting.accruePoints(keccak256("low-power"), secondBuyer, otherSeller, 100);

        uint256 highPower = sellerPools.poolWeightAtEpoch(seller, 4);
        uint256 lowPower = sellerPools.poolWeightAtEpoch(otherSeller, 4);
        uint256 buyerWeightedPoints = 100 * highPower;
        uint256 secondBuyerWeightedPoints = 100 * lowPower;
        uint256 totalWeightedPoints = buyerWeightedPoints + secondBuyerWeightedPoints;

        assertEq(usageAccounting.weightedBuyerPointsByEpoch(4, buyer), buyerWeightedPoints);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(4, secondBuyer), secondBuyerWeightedPoints);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(4), totalWeightedPoints);

        _warpGateEpoch(5);

        uint256 buyerSideBudget = usageRewards.buyerEpochBudget(4);
        uint256 grossBuyerReward = (buyerSideBudget * buyerWeightedPoints) / totalWeightedPoints;
        uint256 grossSecondBuyerReward = (buyerSideBudget * secondBuyerWeightedPoints) / totalWeightedPoints;
        uint256 buyerReward = usageRewards.pendingBuyerReward(buyer, 4);
        uint256 secondBuyerReward = usageRewards.pendingBuyerReward(secondBuyer, 4);
        uint256 buyerCap = (buyerSideBudget * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        assertEq(buyerReward, buyerCap);
        assertEq(secondBuyerReward, grossSecondBuyerReward < buyerCap ? grossSecondBuyerReward : buyerCap);

        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimBuyerReward(buyer, 4);

        vm.prank(operator);
        usageRewards.claimBuyerReward(buyer, 4);
        assertEq(token.balanceOf(operator), buyerReward);
        assertEq(token.balanceOf(reserveDest), grossBuyerReward - buyerReward);

        // A buyer without a resolvable Deposits operator can never be paid
        // directly: the claim reverts (and stays claimable) until an operator
        // is registered.
        vm.expectRevert(AntseedUsageRewards.RewardRecipientUnavailable.selector);
        usageRewards.claimBuyerReward(secondBuyer, 4);
        assertEq(token.balanceOf(secondBuyer), 0);

        address secondOperator = address(0x22);
        deposits.setOperator(secondBuyer, secondOperator);
        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimBuyerReward(secondBuyer, 4);

        vm.prank(secondOperator);
        usageRewards.claimBuyerReward(secondBuyer, 4);
        assertEq(token.balanceOf(secondBuyer), 0);
        assertEq(token.balanceOf(secondOperator), secondBuyerReward);
        assertEq(
            token.balanceOf(reserveDest),
            (grossBuyerReward - buyerReward) + (grossSecondBuyerReward - secondBuyerReward)
        );

        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimBuyerReward(buyer, 4);
    }

    function test_buyerRewardsCanStakeAsBuyerThroughOperatorViaStakeFor() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        usageRewards.setSellerPools(address(sellerPools));
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        uint256 buyerStakeAgentId = _agentId(buyer);
        uint256 otherStakeAgentId = _agentId(otherSeller);
        identityRegistry.setOwner(buyerStakeAgentId, buyer);
        sellerAgentLookup.setAgent(otherSeller, otherStakeAgentId);
        identityRegistry.setOwner(otherStakeAgentId, otherSeller);

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("buyer-stake-direct"), buyer, seller, 100);

        uint256 grossReward = usageRewards.buyerEpochBudget(5);
        uint256 expectedReward = (grossReward * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        _warpGateEpoch(6);

        vm.prank(buyer);
        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.stakeBuyerReward(buyer, 5, buyerStakeAgentId, 4);

        vm.prank(operator);
        uint256 newPositionId = usageRewards.stakeBuyerReward(buyer, 5, otherStakeAgentId, 4);

        (address owner, uint256 positionAgentId, uint256 amount, uint256 weightAmount, uint64 startEpoch,,,) =
            sellerPools.positions(newPositionId);
        assertEq(owner, operator);
        assertEq(sellerPools.ownerOf(newPositionId), operator);
        assertEq(positionAgentId, otherStakeAgentId);
        assertEq(amount, expectedReward);
        assertEq(weightAmount, expectedReward);
        assertEq(startEpoch, 7);
        assertEq(token.balanceOf(buyer), 0);
        assertEq(token.balanceOf(address(usageRewards)), 0);
        assertEq(token.balanceOf(operator), 0);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);
        assertEq(sellerPools.stakerAgentActiveStake(buyer, buyerStakeAgentId), 0);
        assertEq(sellerPools.stakerAgentActiveStake(operator, otherStakeAgentId), expectedReward);
        assertTrue(usageRewards.buyerEpochClaimed(buyer, 5));

        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimBuyerReward(buyer, 5);
    }

    function test_usageRewardsValidationAndPause() public {
        _deployGate(4);

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        new AntseedUsageRewards(address(0), address(usageAccounting), address(identityRegistry), address(deposits));

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        new AntseedUsageRewards(address(gate), address(0), address(identityRegistry), address(deposits));

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        new AntseedUsageRewards(address(gate), address(usageAccounting), address(0), address(deposits));

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(0));

        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        _setUsageMinter(address(usageRewards));
        assertEq(usageRewards.dynamicUsageConfigAt(0).volumeShareTarget, 1_000_000e6);

        vm.expectRevert(AntseedUsageRewards.InvalidAddress.selector);
        usageRewards.claimBuyerReward(address(0), 4);

        vm.expectRevert(AntseedUsageRewards.NothingToClaim.selector);
        usageRewards.claimBuyerReward(buyer, 4);

        usageRewards.pause();
        assertTrue(usageRewards.paused());
        vm.expectRevert();
        usageRewards.claimBuyerReward(buyer, 4);
        usageRewards.unpause();
        assertFalse(usageRewards.paused());
    }

    function test_sellerOperatorRewardsPaySellerDirectly() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct"), buyer, seller, 100);

        uint256 grossReward = usageRewards.sellerEpochBudget(5);
        uint256 expectedReward = (grossReward * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        uint256 agentId = _agentId(seller);
        _warpGateEpoch(6);
        assertEq(usageRewards.pendingAgentReward(agentId, 5), expectedReward);

        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimAgentReward(agentId, 5);

        vm.prank(seller);
        usageRewards.claimAgentReward(agentId, 5);
        assertEq(token.balanceOf(seller), expectedReward);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);

        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimAgentReward(agentId, 5);
    }

    function test_sellerOperatorRewardsCanStakeInsteadOfClaimingViaStakeFor() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        usageRewards.setSellerPools(address(sellerPools));
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-stake-direct"), buyer, seller, 100);

        uint256 grossReward = usageRewards.sellerEpochBudget(5);
        uint256 expectedReward = (grossReward * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        uint256 rewardAgentId = _agentId(seller);
        _warpGateEpoch(6);

        vm.prank(otherSeller);
        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.stakeAgentReward(rewardAgentId, 5, 4);

        vm.prank(seller);
        uint256 newPositionId = usageRewards.stakeAgentReward(rewardAgentId, 5, 4);

        (address owner, uint256 positionAgentId, uint256 amount, uint256 weightAmount, uint64 startEpoch,,,) =
            sellerPools.positions(newPositionId);
        assertEq(owner, seller);
        assertEq(sellerPools.ownerOf(newPositionId), seller);
        assertEq(positionAgentId, rewardAgentId);
        assertEq(amount, expectedReward);
        assertEq(weightAmount, expectedReward);
        assertEq(startEpoch, 7);
        assertEq(token.balanceOf(seller), 0);
        assertEq(token.balanceOf(address(usageRewards)), 0);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);
        assertEq(sellerPools.stakerAgentActiveStake(seller, rewardAgentId), 1 ether + expectedReward);
        assertTrue(usageRewards.agentEpochClaimed(rewardAgentId, 5));

        vm.prank(seller);
        vm.expectRevert(AntseedUsageRewards.AlreadyClaimed.selector);
        usageRewards.claimAgentReward(rewardAgentId, 5);
    }

    function test_sellerOperatorRewardsPayCurrentAgentOwner() public {
        address newOwner = address(0x1111);
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        _setUsageMinter(address(usageRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct-sold-agent"), buyer, seller, 100);

        uint256 agentId = _agentId(seller);
        vm.prank(seller);
        identityRegistry.transferAgent(agentId, newOwner);

        uint256 grossReward = usageRewards.sellerEpochBudget(5);
        uint256 expectedReward = (grossReward * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        _warpGateEpoch(6);
        assertEq(usageRewards.rewardRecipient(agentId), newOwner);
        assertEq(usageRewards.pendingAgentReward(agentId, 5), expectedReward);

        vm.expectRevert(AntseedUsageRewards.NotRewardRecipient.selector);
        usageRewards.claimAgentReward(agentId, 5);

        vm.prank(newOwner);
        usageRewards.claimAgentReward(agentId, 5);
        assertEq(token.balanceOf(newOwner), expectedReward);
        assertEq(token.balanceOf(seller), 0);
        assertEq(token.balanceOf(reserveDest), grossReward - expectedReward);
    }

    function test_sellerOperatorRewardsAreSeparateFromPoolRewards() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        usageRewards = new AntseedUsageRewards(address(gate), address(usageAccounting), address(identityRegistry), address(deposits));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setUsageMinter(address(usageRewards));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;

        _warpGateEpoch(5);
        usageAccounting.accruePoints(keccak256("seller-direct-and-pool"), buyer, seller, 100);

        _warpGateEpoch(6);
        vm.prank(seller);
        usageRewards.claimAgentReward(_agentId(seller), 5);
        sellerPoolsRewards.indexPoolRewards(_agentId(seller), 10);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);

        uint256 expectedOperatorReward =
            (usageRewards.sellerEpochBudget(5) * usageRewards.MAX_REWARD_SHARE_BPS()) / usageRewards.BPS_DENOMINATOR();
        assertEq(token.balanceOf(seller), expectedOperatorReward + sellerPoolsRewards.stakerEpochBudget(5));
        assertEq(token.balanceOf(reserveDest), usageRewards.sellerEpochBudget(5) - expectedOperatorReward);
    }

    function test_gateMintValidationAndPause() public {
        _deployGate(4, address(this), address(0));

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        gate.claim(4, address(0), 1 ether);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        gate.claim(4, address(this), 0);

        vm.expectRevert(AntseedEmissionsGate.EpochNotFinalized.selector);
        gate.claim(5, address(this), 1 ether);

        _warpGateEpoch(5);
        vm.prank(seller);
        vm.expectRevert(AntseedEmissionsGate.NotEmissionMinter.selector);
        gate.claim(4, seller, 1 ether);

        uint256 bucketBudget = _shareBudget(SELLER_POOLS_SHARE_BPS, 4);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(4, address(this), bucketBudget + 1);

        gate.claim(4, address(this), 1 ether);
    }

    function test_gateRemainderUsesGlobalBurnCapAndRejectsOverBucketClaims() public {
        _deployGate(4, address(this), address(0));

        _warpGateEpoch(5);
        uint256 budget = gate.controllerEpochBudget(address(this), 4);
        uint256 burnCap = _shareBudget(uint32(gate.BURN_CAP_BPS()), 4);

        vm.expectRevert(AntseedEmissionsGate.InvalidAddress.selector);
        gate.claimRemainder(4, address(0xBEEF), 1);

        (uint256 burnedAmount, uint256 reserveAmount) = gate.claimRemainder(4, reserveDest, budget);

        assertEq(burnedAmount, burnCap);
        assertEq(reserveAmount, budget - burnCap);
        assertEq(token.balanceOf(gate.DEAD_ADDRESS()), burnCap);
        assertEq(token.balanceOf(reserveDest), budget - burnCap);
        assertEq(gate.epochBurnedAmount(4), burnCap);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 4), budget);

        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claimRemainder(4, reserveDest, 1);
    }

    function test_fixedBucketSharesSumToPostMigrationEpochBudget() public {
        _deployGate(5, address(this), address(0xBEEF));

        uint256 totalBudget = gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5)
            + gate.minterEpochBudget(USAGE_MINTER_ID, 5) + gate.minterEpochBudget(TEAM_MINTER_ID, 5)
            + gate.minterEpochBudget(RESERVE_MINTER_ID, 5) + gate.minterEpochBudget(VERIFICATION_MINTER_ID, 5);
        assertEq(totalBudget, gate.getEpochEmission(5));

        assertEq(gate.minterEpochBudget(USAGE_MINTER_ID, 5), _shareBudget(USAGE_SHARE_BPS, 5));
    }

    function test_gateCapsTotalBucketMintsByEpochEmission() public {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 3 + 1);
        gate = new AntseedEmissionsGate(teamWallet, reserveDest, TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        _setVerificationMinter(verificationWallet);
        address usageMinter = address(0xBEEF);
        _setEmissionMinters(address(this), usageMinter);
        token.setRegistry(address(gate));
        AntseedLegacyEmissionsEscrow escrow = new AntseedLegacyEmissionsEscrow(address(realRegistry), address(legacyV2));
        gate.fundLegacyEscrow(address(escrow));
        _warpGateEpoch(5);

        uint256 epochEmission = gate.getEpochEmission(4);
        uint256 sellerPoolsBudget = _shareBudget(SELLER_POOLS_SHARE_BPS, 4);
        uint256 usageBudget = _shareBudget(USAGE_SHARE_BPS, 4);
        gate.claim(4, address(this), sellerPoolsBudget);
        vm.prank(usageMinter);
        gate.claim(4, address(this), usageBudget);
        _claim(TEAM_MINTER_ID, teamWallet, 4);
        _claim(RESERVE_MINTER_ID, reserveDest, 4);
        _claim(VERIFICATION_MINTER_ID, verificationWallet, 4);
        assertEq(gate.epochMinted(4), epochEmission);

        vm.prank(usageMinter);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(4, address(this), 1);
    }

    function test_ownerCanUpdateUsageMinterDirectly() public {
        // Wired in the deploy epoch so the usage share is active at epoch 4.
        _deployGate(4, address(0), address(this));

        assertEq(_configuredMinter(USAGE_MINTER_ID), address(this));
        assertEq(gate.minterEpochBudget(USAGE_MINTER_ID, 4), _shareBudget(USAGE_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(USAGE_MINTER_ID, 7), _shareBudget(USAGE_SHARE_BPS, 7));

        _warpGateEpoch(5);
        gate.claim(4, address(this), _shareBudget(USAGE_SHARE_BPS, 4));
        assertEq(token.balanceOf(address(this)), _shareBudget(USAGE_SHARE_BPS, 4));

        address newMinter = address(0xBEEF);
        gate.setMinter(USAGE_MINTER_ID, newMinter, USAGE_SHARE_BPS, true);
        assertEq(_configuredMinter(USAGE_MINTER_ID), newMinter);
        assertEq(gate.minterEpochMinted(USAGE_MINTER_ID, 4), _shareBudget(USAGE_SHARE_BPS, 4));
        assertEq(gate.controllerMinterIds(address(this)), bytes32(0));
        assertEq(gate.controllerMinterIds(newMinter), USAGE_MINTER_ID);

        _warpGateEpoch(6);
        uint256 epoch5Budget = _shareBudget(USAGE_SHARE_BPS, 5);
        vm.expectRevert(AntseedEmissionsGate.NotEmissionMinter.selector);
        gate.claim(5, address(this), epoch5Budget);

        vm.prank(newMinter);
        gate.claim(5, newMinter, epoch5Budget);
        assertEq(token.balanceOf(newMinter), epoch5Budget);
    }

    function test_ownerCanUpdateControllerMinterShare() public {
        _deployGate(4, address(this), address(0));
        assertEq(gate.totalMinterShareBps(), 80_000);

        // A share edit during epoch 4 keeps the in-flight epoch's share and
        // only applies from epoch 5.
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(this), 10_000, true);
        assertEq(gate.totalMinterShareBps(), 50_000);
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5), _shareBudget(10_000, 5));
    }

    function test_ownerCanConfigureCustomMinterShare() public {
        _deployGate(4);

        address customMinter = address(0xCAFE);
        gate.setMinter(CUSTOM_MINTER_ID, customMinter, 7_000, true);

        (address configuredMinter, uint32 shareBps, bool editable) = gate.minters(CUSTOM_MINTER_ID);
        assertEq(configuredMinter, customMinter);
        assertEq(shareBps, 7_000);
        assertTrue(editable);
        assertEq(gate.totalMinterShareBps(), 47_000);
        // A first-time add during epoch 4 has zero budget for epoch 4; its
        // share applies from epoch 5 onward.
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 4), 0);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 5), _shareBudget(7_000, 5));

        _warpGateEpoch(6);
        uint256 budget = _shareBudget(7_000, 5);
        vm.prank(customMinter);
        gate.claim(5, customMinter, budget);
        assertEq(gate.minterEpochMinted(CUSTOM_MINTER_ID, 5), budget);
        assertEq(token.balanceOf(customMinter), budget);

        vm.prank(customMinter);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(5, customMinter, 1);

        gate.removeMinter(CUSTOM_MINTER_ID);
        assertEq(gate.totalMinterShareBps(), 40_000);
        // Removal only zeroes the share from the next epoch; epoch 5 keeps its
        // checkpointed budget, which this minter has already drained in full.
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 5), budget);

        vm.prank(customMinter);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(5, customMinter, 1);
    }

    function test_removedMinterCanStillClaimFinalizedEpochsEarnedBeforeRemoval() public {
        _deployGate(4, address(this), address(0));
        address customMinter = address(0xCAFE);
        gate.setMinter(CUSTOM_MINTER_ID, customMinter, 7_000, true);

        _warpGateEpoch(5);
        uint256 budget = _shareBudget(7_000, 5);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 5), budget);

        // Epoch 5 finalizes with nothing claimed, then the owner removes the
        // minter. Budget already earned in a finalized epoch must survive.
        _warpGateEpoch(6);
        gate.removeMinter(CUSTOM_MINTER_ID);

        vm.prank(customMinter);
        gate.claim(5, customMinter, budget);
        assertEq(token.balanceOf(customMinter), budget);

        // Epoch 6 was in flight when removal landed, so it keeps its share;
        // epoch 7 is the first the removal zeroes.
        _warpGateEpoch(8);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 6), budget);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 7), 0);
        vm.prank(customMinter);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(7, customMinter, 1);
    }

    function test_ownerCanChangeNamedMinterShare() public {
        _deployGate(4, address(this), address(0));

        // The share edit during epoch 4 applies from epoch 5; the in-flight
        // epoch keeps the share configured in the deploy epoch.
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(this), 30_000, true);

        assertEq(gate.totalMinterShareBps(), 70_000);
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5), _shareBudget(30_000, 5));

        _warpGateEpoch(5);
        uint256 budget = _shareBudget(SELLER_POOLS_SHARE_BPS, 4);
        gate.claim(4, address(this), budget);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 4), budget);
    }

    function test_shareEditsDoNotRewriteFinalizedEpochBudgets() public {
        _deployGate(4, address(this), address(0));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));

        _warpGateEpoch(5);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(this), 30_000, true);

        assertEq(gate.totalMinterShareBps(), 70_000);
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 4), _shareBudget(SELLER_POOLS_SHARE_BPS, 4));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 5), _shareBudget(SELLER_POOLS_SHARE_BPS, 5));
        assertEq(gate.minterEpochBudget(SELLER_POOLS_MINTER_ID, 6), _shareBudget(30_000, 6));

        uint256 epoch4Budget = _shareBudget(SELLER_POOLS_SHARE_BPS, 4);
        gate.claim(4, address(this), epoch4Budget);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 4), epoch4Budget);

        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(4, address(this), 1);

        _warpGateEpoch(6);
        uint256 epoch5Budget = _shareBudget(SELLER_POOLS_SHARE_BPS, 5);
        gate.claim(5, address(this), epoch5Budget);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 5), epoch5Budget);

        _warpGateEpoch(7);
        uint256 epoch6Budget = _shareBudget(30_000, 6);
        gate.claim(6, address(this), epoch6Budget);
        assertEq(gate.minterEpochMinted(SELLER_POOLS_MINTER_ID, 6), epoch6Budget);
    }

    function test_lockedMinterCannotBeEditedOrRemoved() public {
        _deployGate(4);

        address lockedMinter = address(0xCAFE);
        gate.setMinter(LOCKED_MINTER_ID, lockedMinter, 7_000, false);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(LOCKED_MINTER_ID, lockedMinter, 6_000, true);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.removeMinter(LOCKED_MINTER_ID);

        address newLockedMinter = address(0xBEEF);
        gate.setMinterController(LOCKED_MINTER_ID, newLockedMinter);
        assertEq(_configuredMinter(LOCKED_MINTER_ID), newLockedMinter);
        // The first-time add during epoch 4 earns nothing for epoch 4; its
        // share applies from epoch 5. The controller move is immediate.
        assertEq(gate.minterEpochBudget(LOCKED_MINTER_ID, 4), 0);
        assertEq(gate.minterEpochBudget(LOCKED_MINTER_ID, 5), _shareBudget(7_000, 5));
        assertEq(gate.controllerMinterIds(lockedMinter), bytes32(0));
        assertEq(gate.controllerMinterIds(newLockedMinter), LOCKED_MINTER_ID);

        _warpGateEpoch(6);
        uint256 budget = _shareBudget(7_000, 5);
        vm.prank(newLockedMinter);
        gate.claim(5, newLockedMinter, budget);
        assertEq(token.balanceOf(newLockedMinter), budget);
    }

    function test_gateRejectsOverAllocatedMinterShares() public {
        _deployGate(4);

        _setEmissionMinters(address(this), address(0xBEEF));
        assertEq(gate.totalMinterShareBps(), 100_000);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        gate.setMinter(CUSTOM_MINTER_ID, address(0xCAFE), 1, true);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(this), 45_001, true);
    }

    function test_teamAndReserveBucketsAreFixedRecipientClaims() public {
        _deployGate(4);
        _warpGateEpoch(5);

        uint256 teamBudget = _shareBudget(15_000, 4);
        uint256 reserveBudget = _shareBudget(15_000, 4);

        _claim(TEAM_MINTER_ID, teamWallet, 4);
        assertEq(token.balanceOf(teamWallet), teamBudget);

        _claim(RESERVE_MINTER_ID, reserveDest, 4);
        assertEq(token.balanceOf(reserveDest), reserveBudget);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        vm.prank(teamWallet);
        gate.claim(4, teamWallet, 0);
    }

    function test_registryBackedBucketSharesAreLockedButControllersCanMove() public {
        _deployGate(4);

        address newTeamWallet = address(0xB0B);
        address newReserveWallet = address(0xB0C);
        address newVerificationWallet = address(0xB0D);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(TEAM_MINTER_ID, newTeamWallet, TEAM_SHARE_BPS, true);

        vm.expectRevert(AntseedEmissionsGate.MinterNotEditable.selector);
        gate.setMinter(RESERVE_MINTER_ID, newReserveWallet, RESERVE_SHARE_BPS, true);

        gate.setMinterController(TEAM_MINTER_ID, newTeamWallet);
        gate.setMinterController(RESERVE_MINTER_ID, newReserveWallet);

        _setVerificationMinter(newVerificationWallet);

        assertEq(_configuredMinter(TEAM_MINTER_ID), newTeamWallet);
        assertEq(_configuredMinter(RESERVE_MINTER_ID), newReserveWallet);
        assertEq(_configuredMinter(VERIFICATION_MINTER_ID), newVerificationWallet);
        assertEq(gate.minterEpochBudget(TEAM_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.minterEpochBudget(RESERVE_MINTER_ID, 4), _shareBudget(15_000, 4));
        assertEq(gate.controllerMinterIds(teamWallet), bytes32(0));
        assertEq(gate.controllerMinterIds(reserveDest), bytes32(0));
        assertEq(gate.controllerMinterIds(newTeamWallet), TEAM_MINTER_ID);
        assertEq(gate.controllerMinterIds(newReserveWallet), RESERVE_MINTER_ID);
        assertEq(gate.controllerMinterIds(verificationWallet), bytes32(0));
        assertEq(gate.controllerMinterIds(newVerificationWallet), VERIFICATION_MINTER_ID);

        _warpGateEpoch(5);
        _claim(TEAM_MINTER_ID, newTeamWallet, 4);
        _claim(RESERVE_MINTER_ID, newReserveWallet, 4);
        uint256 verificationBudgetEpoch4 = _shareBudget(VERIFICATION_SHARE_BPS, 4);
        _claim(VERIFICATION_MINTER_ID, newVerificationWallet, 4);
        assertEq(token.balanceOf(newVerificationWallet), verificationBudgetEpoch4);
        assertEq(token.balanceOf(newTeamWallet), _shareBudget(15_000, 4));
        assertEq(token.balanceOf(newReserveWallet), _shareBudget(15_000, 4));
    }

    function test_verificationBucketFitsDefaultSplitAndPaysItsWallet() public {
        _deployGate(4);
        _warpGateEpoch(5);

        uint256 verificationBudget = _shareBudget(VERIFICATION_SHARE_BPS, 4);

        _claim(VERIFICATION_MINTER_ID, verificationWallet, 4);
        assertEq(token.balanceOf(verificationWallet), verificationBudget);

        vm.expectRevert(AntseedEmissionsGate.InvalidValue.selector);
        vm.prank(verificationWallet);
        gate.claim(4, verificationWallet, 0);
    }

    function test_sellerPoolsRewardsDistributionValidation() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        uint256 positionId = sellerPools.nextPositionId() - 1;
        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);

        _warpGateEpoch(6);
        sellerPoolsRewards.indexPoolRewards(_agentId(seller), 10);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);
        assertEq(token.balanceOf(seller), sellerPoolsRewards.stakerEpochBudget(5));

        vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
        vm.prank(seller);
        sellerPoolsRewards.claimStakerRewards(positionId, seller);

        vm.expectRevert(AntseedSellerPoolsRewards.InvalidValue.selector);
        sellerPoolsRewards.pendingStakerReward(0, 5);
    }

    function test_stakerDynamicBudgetFollowsActiveStakeSmoothly() public {
        _deployGate(3);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPoolsRewards.setDynamicStakerConfig(2_000, 40_000, 1 ether);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        assertEq(sellerPoolsRewards.stakerEpochBudget(4), 0);

        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        _warpGateEpoch(4);

        assertEq(sellerPools.totalActiveStakeAtEpoch(4), 1 ether);
        assertEq(sellerPoolsRewards.stakerEpochBudget(4), _shareBudget(21_000, 4));
        assertLt(sellerPoolsRewards.stakerEpochBudget(4), gate.controllerEpochBudget(address(sellerPoolsRewards), 4));
    }

    function test_stakerDynamicBudgetTargetsAmountAndClampsAfterHalving() public {
        _deployGate(102);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        uint256 stakeAmount = 500_000_000 ether;
        deal(address(token), seller, stakeAmount);
        _stakeAgentPool(sellerPools, seller, stakeAmount, 52);

        AntseedSellerPoolsRewards.DynamicStakerConfig memory stakerConfig = sellerPoolsRewards.dynamicStakerConfigAt(103);
        uint256 shareBpsAtStake = stakerConfig.minShareBps
            + (uint256(stakerConfig.maxShareBps - stakerConfig.minShareBps) * stakeAmount)
                / (stakeAmount + stakerConfig.stakeShareTarget);
        uint256 desiredBudget = (gate.getEpochEmission(103) * shareBpsAtStake) / gate.SHARE_DENOMINATOR();
        // Past the halving the target scales down with the emission, so the
        // same stake earns a larger share of the smaller epoch budget.
        uint256 postHalvingShareBps = stakerConfig.minShareBps
            + (uint256(stakerConfig.maxShareBps - stakerConfig.minShareBps) * stakeAmount)
                / (stakeAmount + stakerConfig.stakeShareTarget / 2);
        uint256 postHalvingDesiredBudget =
            (gate.getEpochEmission(104) * postHalvingShareBps) / gate.SHARE_DENOMINATOR();

        assertEq(sellerPools.totalActiveStakeAtEpoch(103), stakeAmount);
        assertEq(sellerPoolsRewards.stakerEpochBudget(103), desiredBudget);
        assertLt(desiredBudget, gate.controllerEpochBudget(address(sellerPoolsRewards), 103));

        uint256 postHalvingMaxBudget = gate.controllerEpochBudget(address(sellerPoolsRewards), 104);
        assertLt(postHalvingDesiredBudget, postHalvingMaxBudget);
        assertEq(sellerPoolsRewards.stakerEpochBudget(104), postHalvingDesiredBudget);
    }

    function test_sellerPoolsRewardsBatchClaimUsesPositionLogic() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 175 ether);
        uint256 firstPositionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        uint256 secondPositionId = sellerPools.stake(_agentId(poolSeller), 50 ether, 3);
        uint256 noRewardPositionId = sellerPools.stake(_agentId(otherSeller), 25 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256[] memory positionIds = new uint256[](3);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;
        positionIds[2] = noRewardPositionId;

        uint256 firstGross = sellerPoolsRewards.pendingStakerReward(firstPositionId, 5);
        uint256 secondGross = sellerPoolsRewards.pendingStakerReward(secondPositionId, 5);

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewardsBatch(positionIds, staker);

        assertEq(token.balanceOf(staker), 825 ether + firstGross + secondGross);
        assertEq(sellerPoolsRewards.positionClaimCursor(firstPositionId), 6);
        assertEq(sellerPoolsRewards.positionClaimCursor(secondPositionId), 6);
        assertEq(sellerPoolsRewards.positionClaimCursor(noRewardPositionId), 0);

        vm.expectRevert(AntseedSellerPoolsRewards.NothingToClaim.selector);
        vm.prank(staker);
        sellerPoolsRewards.claimStakerRewardsBatch(positionIds, staker);
    }

    function test_sellerPoolsRewardsBatchRestakeUsesPositionLogicAndCreatesSeparatePositions() public {
        _deployGate(4);

        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        _setSellerPoolsMinter(address(sellerPoolsRewards));

        address poolSeller = _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));
        sellerAgentLookup.setAgent(otherSeller, _agentId(otherSeller));
        identityRegistry.setOwner(_agentId(otherSeller), otherSeller);

        vm.startPrank(staker);
        token.approve(address(sellerPools), 175 ether);
        uint256 firstPositionId = sellerPools.stake(_agentId(poolSeller), 100 ether, 4);
        uint256 secondPositionId = sellerPools.stake(_agentId(poolSeller), 50 ether, 3);
        uint256 noRewardPositionId = sellerPools.stake(_agentId(otherSeller), 25 ether, 4);
        vm.stopPrank();

        _warpGateEpoch(5);
        usageAccounting.accrueSellerPoints(seller, 100);
        usageAccounting.accrueBuyerPoints(buyer, 100);

        _warpGateEpoch(6);
        uint256[] memory positionIds = new uint256[](3);
        positionIds[0] = firstPositionId;
        positionIds[1] = secondPositionId;
        positionIds[2] = noRewardPositionId;

        uint256 firstGross = sellerPoolsRewards.pendingStakerReward(firstPositionId, 5);
        uint256 secondGross = sellerPoolsRewards.pendingStakerReward(secondPositionId, 5);

        sellerPoolsRewards.indexPoolRewards(_agentId(poolSeller), 10);
        vm.prank(staker);
        uint256[] memory newPositionIds = sellerPoolsRewards.restakeStakerRewardsBatch(positionIds, 2);

        assertEq(newPositionIds.length, 3);
        assertNotEq(newPositionIds[0], newPositionIds[1]);
        assertEq(newPositionIds[2], 0);
        assertEq(token.balanceOf(staker), 825 ether);
        assertEq(sellerPools.stakerPositionCount(staker), 5);

        (,, uint256 amount, uint256 weightAmount, uint64 startEpoch, uint64 stakeEndEpoch,,) =
            sellerPools.positions(newPositionIds[0]);
        uint256 expectedBonusBps = (uint256(500) * 2) / 104;
        uint256 expectedFirstWeightAmount = (firstGross * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(amount, firstGross);
        assertEq(weightAmount, expectedFirstWeightAmount);
        assertEq(startEpoch, 7);
        assertEq(stakeEndEpoch, 9);

        (,, amount, weightAmount, startEpoch, stakeEndEpoch,,) = sellerPools.positions(newPositionIds[1]);
        uint256 expectedSecondWeightAmount = (secondGross * (10_000 + expectedBonusBps)) / 10_000;
        assertEq(amount, secondGross);
        assertEq(weightAmount, expectedSecondWeightAmount);
        assertEq(startEpoch, 7);
        assertEq(stakeEndEpoch, 9);
    }

    function test_sellerPoolsRewardsAdminAndPause() public {
        _deployGate(5);
        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));

        vm.expectRevert(AntseedSellerPoolsRewards.InvalidAddress.selector);
        new AntseedSellerPoolsRewards(address(0), address(sellerPools), address(usageAccounting));

        vm.expectRevert(AntseedSellerPoolsRewards.InvalidAddress.selector);
        new AntseedSellerPoolsRewards(address(gate), address(0), address(usageAccounting));

        vm.expectRevert(AntseedSellerPoolsRewards.InvalidAddress.selector);
        new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(0));

        _setSellerPoolsMinter(address(sellerPoolsRewards));
        sellerPoolsRewards.pause();
        assertTrue(sellerPoolsRewards.paused());
        vm.expectRevert();
        sellerPoolsRewards.claimStakerRewards(1, seller);
        sellerPoolsRewards.unpause();
        assertFalse(sellerPoolsRewards.paused());
    }

    function test_gateEffectiveEpochIsCurrentEpochPlusOneAtDeployment() public {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 10 + 1);
        AntseedEmissionsGate deployedGate =
            new AntseedEmissionsGate(teamWallet, reserveDest, TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        assertEq(deployedGate.currentEpoch(), 10);
        assertEq(deployedGate.effectiveEpoch(), 11);
    }

    function test_bucketsCannotMintBeforeLegacyEscrowFunded() public {
        // The escrow pot is sized as `schedule − totalSupply` at funding
        // time; a bucket mint landing first would inflate supply and
        // underfund pre-effective legacy claims.
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 3 + 1);
        gate = new AntseedEmissionsGate(teamWallet, reserveDest, TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        _setSellerPoolsMinter(address(this));
        token.setRegistry(address(gate));
        _warpGateEpoch(5);

        vm.expectRevert(AntseedEmissionsGate.LegacyEscrowNotFunded.selector);
        gate.claim(4, address(this), 1 ether);

        vm.expectRevert(AntseedEmissionsGate.LegacyEscrowNotFunded.selector);
        gate.claimRemainder(4, reserveDest, 1 ether);

        AntseedLegacyEmissionsEscrow escrow =
            new AntseedLegacyEmissionsEscrow(address(realRegistry), address(legacyV2));
        gate.fundLegacyEscrow(address(escrow));
        gate.claim(4, address(this), 1 ether);
        assertEq(token.balanceOf(address(this)), 1 ether);
    }

    function test_newMinterEarnsOnlyFromNextEpoch() public {
        _deployGate(4);
        _warpGateEpoch(6); // epochs 4 and 5 finalize with unclaimed emission

        // A first-time minter id gets no retroactive budget over finalized
        // epochs and none for the in-flight add epoch either — its share
        // applies strictly from the NEXT epoch onward.
        gate.setMinter(CUSTOM_MINTER_ID, address(this), 10_000, true);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 4), 0);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 5), 0);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 6), 0);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 7), _shareBudget(10_000, 7));

        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(5, address(this), 1);

        _warpGateEpoch(7);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(6, address(this), 1);

        _warpGateEpoch(8);
        gate.claim(7, address(this), _shareBudget(10_000, 7));
        assertEq(token.balanceOf(address(this)), _shareBudget(10_000, 7));
    }

    function test_newMinterWaitsOutEpochWhoseShareWasFreedThisEpoch() public {
        _deployGate(4);
        _setSellerPoolsMinter(address(0xF00D));
        _warpGateEpoch(6);

        // Removal keeps the removed id's in-flight-epoch share checkpointed
        // (a same-epoch re-add of that id resurrects it). The replacement id
        // starts next epoch like every first-time add, so it can never also
        // earn the epoch whose share the removal freed.
        gate.removeMinter(SELLER_POOLS_MINTER_ID);
        gate.setMinter(CUSTOM_MINTER_ID, address(this), SELLER_POOLS_SHARE_BPS, true);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 6), 0);
        assertEq(gate.minterEpochBudget(CUSTOM_MINTER_ID, 7), _shareBudget(SELLER_POOLS_SHARE_BPS, 7));

        _warpGateEpoch(7);
        vm.expectRevert(AntseedEmissionsGate.BucketBudgetExceeded.selector);
        gate.claim(6, address(this), 1);

        _warpGateEpoch(8);
        gate.claim(7, address(this), _shareBudget(SELLER_POOLS_SHARE_BPS, 7));
        assertEq(token.balanceOf(address(this)), _shareBudget(SELLER_POOLS_SHARE_BPS, 7));
    }

    function test_cutoverEpochUsageAccruesToFirstRewardedEpoch() public {
        // Mirror the production cutover: gate + usage stack go live mid-epoch
        // 3 while effectiveEpoch is 4. Usage settled during the rest of epoch
        // 3 must land in epoch 4 — the gate refuses pre-effective epochs
        // forever, so epoch-3 bookkeeping would be permanently unclaimable.
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 3 + 1);
        gate = new AntseedEmissionsGate(teamWallet, reserveDest, TEAM_SHARE_BPS, RESERVE_SHARE_BPS);
        token.setRegistry(address(gate));
        legacyEscrow = new AntseedLegacyEmissionsEscrow(address(realRegistry), address(legacyV2));
        gate.fundLegacyEscrow(address(legacyEscrow));
        usageAccounting = new AntseedUsageAccounting(address(0), address(this), address(gate));
        realRegistry.setEmissions(address(usageAccounting));
        sellerPools = new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));
        _createSellerPool(sellerPools, seller, 5_000, keccak256("terms"));

        assertEq(gate.currentEpoch(), 3);
        assertEq(usageAccounting.firstRewardedEpoch(), 4);

        usageAccounting.accruePoints(bytes32(0), buyer, seller, 100);

        assertEq(usageAccounting.totalSellerPointsByEpoch(3), 0);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(3), 0);
        assertEq(usageAccounting.totalSellerPointsByEpoch(4), 100);
        assertEq(usageAccounting.buyerPointsByEpoch(4, buyer), 100);
    }

}
