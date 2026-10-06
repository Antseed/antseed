// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedEmissionsGate } from "../../emissions/AntseedEmissionsGate.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedSellerPools } from "../../sellers/AntseedSellerPools.sol";
import { AntseedUsageAccounting } from "../../emissions/AntseedUsageAccounting.sol";
import { IAntseedPointsPolicy } from "../../interfaces/IAntseedPointsPolicy.sol";
import { IAntseedUsageAccounting } from "../../interfaces/IAntseedUsageAccounting.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";

contract MockSellerAgentLookupForUsageAccountingGas {
    mapping(address => uint256) public agentIdBySeller;

    function setAgent(address seller, uint256 agentId) external {
        agentIdBySeller[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentIdBySeller[seller];
    }
}

contract MockUsagePointsPolicyForUsageAccountingGas is IAntseedPointsPolicy {
    uint256 public sellerWeightBps = 10_000;
    uint256 public buyerWeightBps = 10_000;

    function setWeights(uint256 sellerWeightBps_, uint256 buyerWeightBps_) external {
        sellerWeightBps = sellerWeightBps_;
        buyerWeightBps = buyerWeightBps_;
    }

    function points(bytes32, address, address, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        sellerPoints = (rawPoints * sellerWeightBps) / 10_000;
        buyerPoints = (rawPoints * buyerWeightBps) / 10_000;
    }
}

contract AntseedUsageAccountingGasTest is Test {
    ANTSToken token;
    AntseedRegistry registry;
    AntseedEmissionsGate gate;
    AntseedSellerPools sellerPools;
    AntseedUsageAccounting usageAccounting;
    MockERC8004Registry identityRegistry;
    MockSellerAgentLookupForUsageAccountingGas sellerAgentLookup;

    address seller = address(0x10);
    address otherSeller = address(0x20);
    address buyer = address(0x30);
    address secondBuyer = address(0x40);

    address constant KNOWN_ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    uint256 constant GATE_GENESIS = 1_775_728_461;
    uint256 constant GATE_EPOCH_DURATION = 7 days;

    function setUp() public {
        vm.warp(GATE_GENESIS + GATE_EPOCH_DURATION * 4 + 1);

        deployCodeTo("ANTSToken.sol:ANTSToken", KNOWN_ANTS_TOKEN);
        token = ANTSToken(KNOWN_ANTS_TOKEN);

        registry = new AntseedRegistry();
        registry.setAntsToken(address(token));
        identityRegistry = new MockERC8004Registry();
        registry.setIdentityRegistry(address(identityRegistry));
        sellerAgentLookup = new MockSellerAgentLookupForUsageAccountingGas();
        registry.setStaking(address(sellerAgentLookup));
        registry.setEmissions(address(this));
        registry.setProtocolReserve(address(0x70));
        registry.setTeamWallet(address(0x80));

        token.setRegistry(address(registry));
        token.enableTransfers();

        gate = new AntseedEmissionsGate(address(0x80), address(0x70), 15_000, 15_000);
        usageAccounting = new AntseedUsageAccounting(address(0), address(this), address(gate));
        registry.setEmissions(address(usageAccounting));

        sellerPools =
            new AntseedSellerPools(address(token), address(gate), address(identityRegistry), address(sellerAgentLookup));
        usageAccounting.setSellerPools(address(sellerPools));

        _stakeAgentPool(seller, 1 ether, 4);
        _stakeAgentPool(otherSeller, 1 ether, 4);
        _warpGateEpoch(5);
    }

    function _agentId(address seller_) internal pure returns (uint256) {
        return uint160(seller_);
    }

    function _warpGateEpoch(uint256 epoch) internal {
        vm.warp(gate.genesis() + gate.epochDuration() * epoch + 1);
    }

    function _stakeAgentPool(address seller_, uint256 amount, uint256 stakeEpochs) internal {
        sellerAgentLookup.setAgent(seller_, _agentId(seller_));
        identityRegistry.setOwner(_agentId(seller_), seller_);
        deal(address(token), seller_, amount);

        vm.startPrank(seller_);
        token.approve(address(sellerPools), amount);
        sellerPools.stake(_agentId(seller_), amount, stakeEpochs);
        vm.stopPrank();
    }

    function test_usageAccountingGasSnapshotsRecordUsageCases() public {
        usageAccounting.accruePoints(keccak256("warm-pair"), buyer, seller, 10);

        vm.startSnapshotGas("usage-accounting", "record-repeated-same-buyer-agent");
        usageAccounting.accruePoints(keccak256("repeat-pair"), buyer, seller, 10);
        uint256 repeatedGas = vm.stopSnapshotGas();

        vm.startSnapshotGas("usage-accounting", "record-new-buyer-existing-agent");
        usageAccounting.accruePoints(keccak256("new-buyer"), secondBuyer, seller, 10);
        uint256 newBuyerGas = vm.stopSnapshotGas();

        vm.startSnapshotGas("usage-accounting", "record-new-agent-in-epoch");
        usageAccounting.accruePoints(keccak256("new-agent"), buyer, otherSeller, 10);
        uint256 newAgentGas = vm.stopSnapshotGas();

        assertGt(repeatedGas, 0);
        assertGt(newBuyerGas, repeatedGas);
        assertGt(newAgentGas, repeatedGas);
    }

    function test_minimumAccountedPoolPowerFiltersUsage() public {
        uint256 agentId = _agentId(seller);
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

    function test_usageAccountingValidationAdminAndViews() public {
        address recorder = address(0x50);
        uint256 agentId = _agentId(seller);

        assertEq(usageAccounting.currentEpoch(), 5);

        // Non-recorder accruals are skipped, not reverted, so settlement
        // through a revoked recorder keeps working without emissions.
        vm.prank(recorder);
        usageAccounting.accrueSellerPoints(seller, 1);
        assertEq(usageAccounting.pendingSellerAccrual(), address(0));

        vm.expectRevert(IAntseedUsageAccounting.InvalidAddress.selector);
        usageAccounting.setUsageRecorder(address(0), true);

        usageAccounting.setUsageRecorder(recorder, true);
        assertTrue(usageAccounting.usageRecorders(recorder));

        vm.prank(recorder);
        vm.expectRevert(IAntseedUsageAccounting.InvalidAddress.selector);
        usageAccounting.accrueSellerPoints(address(0), 1);

        vm.prank(recorder);
        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.accrueSellerPoints(seller, 0);

        vm.prank(recorder);
        usageAccounting.accrueSellerPoints(seller, 10);
        assertEq(usageAccounting.pendingSellerAccrual(), seller);

        // A repeated seller accrual is a plain overwrite, never a revert:
        // this runs inline in the Channels settle path.
        vm.prank(recorder);
        usageAccounting.accrueSellerPoints(seller, 11);
        assertEq(usageAccounting.pendingSellerAccrual(), seller);

        vm.prank(recorder);
        vm.expectRevert(IAntseedUsageAccounting.InvalidAddress.selector);
        usageAccounting.accrueBuyerPoints(address(0), 10);

        vm.prank(recorder);
        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.accrueBuyerPoints(buyer, 0);

        // Completing the pair clears the slot (sellerPools unset, so nothing
        // is recorded); the buyer leg's delta is used, unchecked against the
        // seller leg.
        usageAccounting.setSellerPools(address(0));
        vm.prank(recorder);
        usageAccounting.accrueBuyerPoints(buyer, 9);
        usageAccounting.setSellerPools(address(sellerPools));
        assertEq(usageAccounting.pendingSellerAccrual(), address(0));

        vm.prank(recorder);
        vm.expectRevert(IAntseedUsageAccounting.NoPendingSellerAccrual.selector);
        usageAccounting.accrueBuyerPoints(buyer, 10);

        vm.expectRevert(IAntseedUsageAccounting.InvalidAddress.selector);
        usageAccounting.accruePoints(bytes32(0), address(0), seller, 1);
        vm.expectRevert(IAntseedUsageAccounting.InvalidAddress.selector);
        usageAccounting.accruePoints(bytes32(0), buyer, address(0), 1);
        vm.expectRevert(IAntseedUsageAccounting.InvalidValue.selector);
        usageAccounting.accruePoints(bytes32(0), buyer, seller, 0);

        usageAccounting.setSellerPools(address(0));
        usageAccounting.accruePoints(keccak256("no-pools"), buyer, seller, 10);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);

        usageAccounting.setSellerPools(address(sellerPools));
        usageAccounting.accruePoints(keccak256("no-agent"), buyer, address(0x9999), 10);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);

        MockUsagePointsPolicyForUsageAccountingGas policy = new MockUsagePointsPolicyForUsageAccountingGas();
        policy.setWeights(0, 0);
        usageAccounting.setPointsPolicy(address(policy));
        usageAccounting.accruePoints(keccak256("zero-policy"), buyer, seller, 10);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 0);

        policy.setWeights(5_000, 2_500);
        usageAccounting.accruePoints(keccak256("weighted-policy"), buyer, seller, 40);

        uint256 poolPower = sellerPools.poolWeightAtEpoch(agentId, 5);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), 10);
        assertEq(usageAccounting.totalSellerPointsByEpoch(5), 20);
        assertEq(usageAccounting.totalPoolPointsByEpoch(5), 20);
        assertEq(usageAccounting.totalWeightedBuyerPointsByEpoch(5), 10 * poolPower);
        assertEq(usageAccounting.totalWeightedPoolPointsByEpoch(5), 20 * poolPower);
        assertEq(usageAccounting.buyerPointsByEpoch(5, buyer), 10);
        assertEq(usageAccounting.sellerPointsByEpoch(5, seller), 20);
        assertEq(usageAccounting.weightedBuyerPointsByEpoch(5, buyer), 10 * poolPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, agentId), 20 * poolPower);
        assertEq(usageAccounting.weightedPoolPointsByEpoch(5, seller), 20 * poolPower);
        assertEq(usageAccounting.agentPoolPointsByEpoch(5, agentId), 20);
        assertEq(usageAccounting.poolPointsByEpoch(5, seller), 20);
        assertEq(usageAccounting.sellerAgentIdByEpoch(5, seller), agentId);

        IAntseedUsageAccounting.UsageTotals memory totalUsage = usageAccounting.totalUsage();
        IAntseedUsageAccounting.UsageTotals memory epochUsage = usageAccounting.epochUsage(5);
        IAntseedUsageAccounting.BuyerUsage memory buyerTotal = usageAccounting.buyerUsageTotal(buyer);
        IAntseedUsageAccounting.BuyerUsage memory buyerEpoch = usageAccounting.buyerEpochUsage(5, buyer);
        IAntseedUsageAccounting.BuyerUsage memory buyerAgentTotal = usageAccounting.buyerAgentUsageTotal(buyer, agentId);
        IAntseedUsageAccounting.BuyerUsage memory buyerAgentEpoch =
            usageAccounting.buyerAgentEpochUsage(5, buyer, agentId);
        IAntseedUsageAccounting.SellerUsage memory agentEpoch = usageAccounting.agentEpochUsage(5, agentId);
        assertEq(totalUsage.buyers.points, 10);
        assertEq(epochUsage.sellers.points, 20);
        assertEq(buyerTotal.weightedPoints, 10 * poolPower);
        assertEq(buyerEpoch.points, 10);
        assertEq(buyerAgentTotal.points, 10);
        assertEq(buyerAgentEpoch.weightedPoints, 10 * poolPower);
        assertEq(agentEpoch.weightedPoints, 20 * poolPower);

        usageAccounting.setUsageRecorder(recorder, false);
        assertFalse(usageAccounting.usageRecorders(recorder));
    }

    function test_usageAccountingPausedAccrualsAreSkippedNotReverted() public {
        // Pausing must not revert (the deployed AntseedChannels settle path
        // calls accruals with no try/catch); paused accruals are skipped.
        uint256 buyerPointsBefore = usageAccounting.totalBuyerPointsByEpoch(5);

        usageAccounting.pause();
        usageAccounting.accruePoints(keccak256("paused"), buyer, seller, 1);
        usageAccounting.accrueSellerPoints(seller, 1);
        assertEq(usageAccounting.pendingSellerAccrual(), address(0));
        usageAccounting.accrueBuyerPoints(buyer, 1);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), buyerPointsBefore);
        usageAccounting.unpause();

        // After unpausing the legacy pair records normally again.
        usageAccounting.accrueSellerPoints(seller, 7);
        usageAccounting.accrueBuyerPoints(buyer, 7);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), buyerPointsBefore + 7);
    }

    function test_revertingPointsPolicySkipsRecordingInsteadOfBlockingSettlement() public {
        uint256 buyerPointsBefore = usageAccounting.totalBuyerPointsByEpoch(5);

        usageAccounting.setPointsPolicy(address(new RevertingPointsPolicy()));

        // A broken policy must not bubble its revert into the Channels settle
        // path; the usage record is skipped instead.
        usageAccounting.accruePoints(keccak256("broken-policy"), buyer, seller, 10);
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), buyerPointsBefore);

        usageAccounting.setPointsPolicy(address(0));
        usageAccounting.accrueSellerPoints(seller, 10);
        usageAccounting.accrueBuyerPoints(buyer, 10);
        assertEq(usageAccounting.totalBuyerPointsByEpoch(5), buyerPointsBefore + 10);
    }
}

contract RevertingPointsPolicy is IAntseedPointsPolicy {
    function points(bytes32, address, address, uint256) external pure returns (uint256, uint256) {
        revert("policy broken");
    }
}
