// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { IAntseedVerificationResults } from "../../interfaces/IAntseedVerificationResults.sol";
import { AntseedVerificationResults } from "../../verification/AntseedVerificationResults.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockVerificationEmissionsGate } from "../mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSource } from "../mocks/MockVerificationSource.sol";

/// @dev The results layer on its own, written to by two mock sources (e.g. KBF and a probe method).
///      KBF-specific behaviour through the results layer is covered in `AntseedKbfAudits.t.sol`.
contract AntseedVerificationResultsTest is Test {
    uint256 private constant EPOCH = 5;
    bytes32 private constant MODEL_A = keccak256("model-a");
    bytes32 private constant MODEL_B = keccak256("model-b");
    bytes32 private constant SERVICE_A = bytes32(uint256(1));
    bytes32 private constant SERVICE_B = bytes32(uint256(2));

    IAntseedVerificationResults.Verdict private constant NONE = IAntseedVerificationResults.Verdict.NONE;
    IAntseedVerificationResults.Verdict private constant SAME = IAntseedVerificationResults.Verdict.SAME;
    IAntseedVerificationResults.Verdict private constant DIFF = IAntseedVerificationResults.Verdict.DIFF;
    IAntseedVerificationResults.Verdict private constant UNDETERMINED =
    IAntseedVerificationResults.Verdict.UNDETERMINED;

    address private verifierA = address(0xA1);
    address private verifierB = address(0xB2);
    address private seller = address(0x5E1);
    address private reserve = address(0x5E5E);

    AntseedRegistry private registry;
    MockERC8004Registry private identity;
    MockVerificationEmissionsGate private gate;
    AntseedVerificationResults private results;
    MockVerificationSource private sourceA;
    MockVerificationSource private sourceB;
    uint256 private agentId;

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new AntseedRegistry();
        identity = new MockERC8004Registry();
        gate = new MockVerificationEmissionsGate();
        registry.setIdentityRegistry(address(identity));
        registry.setEmissions(address(gate));
        gate.setCurrentEpoch(EPOCH);
        gate.setEmissionsReserve(reserve);
        results = new AntseedVerificationResults(address(registry));
        sourceA = new MockVerificationSource(address(results));
        sourceB = new MockVerificationSource(address(results));
        results.setSource(address(sourceA), true);
        results.setSource(address(sourceB), true);
        vm.prank(seller);
        agentId = identity.register();
    }

    // ── wiring ───────────────────────────────────────────────────────

    function test_defaults() public view {
        assertEq(address(results.registry()), address(registry));
        assertEq(address(results.emissionsGate()), address(gate));
        assertEq(results.validityEpochs(), 2);
        assertEq(results.totalSourceShareBps(), 0);
        assertEq(results.owner(), address(this));
        assertEq(results.sourceCount(), 2);
        assertEq(results.rewardsStartEpoch(address(sourceA)), type(uint64).max, "rewards off");
        assertEq(results.maxAuditorShareBps(address(sourceA)), 2_000);
        assertEq(results.maxCreditsPerAuditorPerEpoch(address(sourceA)), 100);
    }

    function test_settingsNeedAListedSourceAndStayPerSource() public {
        vm.expectRevert(AntseedVerificationResults.UnknownSource.selector);
        results.setSourceShareBps(address(0xBEEF), 1);
        vm.expectRevert(AntseedVerificationResults.UnknownSource.selector);
        results.setRewardsStartEpoch(address(0xBEEF), 0);
        vm.expectRevert(AntseedVerificationResults.UnknownSource.selector);
        results.setMaxAuditorShareBps(address(0xBEEF), 1);
        vm.expectRevert(AntseedVerificationResults.UnknownSource.selector);
        results.setMaxCreditsPerAuditorPerEpoch(address(0xBEEF), 1);

        results.setMaxAuditorShareBps(address(sourceA), 5_000);
        results.setMaxCreditsPerAuditorPerEpoch(address(sourceA), 7);
        results.setRewardsStartEpoch(address(sourceA), 3);
        assertEq(results.maxAuditorShareBps(address(sourceB)), 2_000, "B keeps its own caps");
        assertEq(results.maxCreditsPerAuditorPerEpoch(address(sourceB)), 100);
        assertEq(results.rewardsStartEpoch(address(sourceB)), type(uint64).max);

        results.setSource(address(sourceA), false);
        results.setSource(address(sourceA), true);
        assertEq(results.maxAuditorShareBps(address(sourceA)), 5_000, "re-approval keeps the settings");
        assertEq(results.sourceCount(), 2, "and lists it once");

        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxAuditorShareBps(address(sourceA), 0);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxAuditorShareBps(address(sourceA), 10_001);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxCreditsPerAuditorPerEpoch(address(sourceA), 0);
    }

    function test_atMostMaxSourcesAreListed() public {
        for (uint256 i = results.sourceCount(); i < results.MAX_SOURCES(); i++) {
            results.setSource(address(new MockVerificationSource(address(results))), true);
        }
        address extra = address(new MockVerificationSource(address(results)));
        vm.expectRevert(AntseedVerificationResults.TooManySources.selector);
        results.setSource(extra, true);
    }

    function test_currentEpochIsTheGates() public {
        assertEq(results.currentEpoch(), EPOCH);
        gate.setCurrentEpoch(EPOCH + 7);
        assertEq(results.currentEpoch(), EPOCH + 7);
    }

    function test_setSourceIsOwnerOnlyAndNeedsAContract() public {
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.SourceSet(address(sourceA), false);
        results.setSource(address(sourceA), false);
        assertFalse(results.isSource(address(sourceA)));
        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        results.setSource(address(0x1234), true);
        vm.prank(verifierA);
        vm.expectRevert();
        results.setSource(address(sourceA), true);
        vm.prank(verifierA);
        vm.expectRevert();
        results.setSourceShareBps(address(sourceA), 1);
        vm.expectRevert(AntseedVerificationResults.UnknownSource.selector);
        results.setSourceShareBps(address(0), 1);
    }

    // ── sources ──────────────────────────────────────────────────────

    function test_recordRejectsNonSources() public {
        vm.expectRevert(AntseedVerificationResults.NotSource.selector);
        results.record(agentId, SERVICE_A, MODEL_A, SAME, bytes32(0));
    }

    function test_creditRejectsNonSources() public {
        vm.expectRevert(AntseedVerificationResults.NotSource.selector);
        results.credit(verifierA, 1);
    }

    function test_removedSourceStopsWritingButEarnedCreditsStayClaimable() public {
        _enable(address(sourceA), 10_000);
        results.setMaxAuditorShareBps(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 500 ether);
        assertEq(sourceA.credit(verifierA, 2), 2);
        sourceA.record(agentId, SERVICE_A, MODEL_A, SAME);

        results.setSource(address(sourceA), false);
        vm.expectRevert(AntseedVerificationResults.NotSource.selector);
        sourceA.record(agentId, SERVICE_A, MODEL_A, DIFF);
        vm.expectRevert(AntseedVerificationResults.NotSource.selector);
        sourceA.credit(verifierA, 1);
        assertTrue(results.isVerified(agentId), "its live verdicts stay until they expire");

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 500 ether, "credits it granted stay claimable");
        assertEq(results.sourceShareBps(address(sourceA)), 10_000, "a removed source keeps its share setting");
    }

    function test_recordValidatesItsInput() public {
        vm.startPrank(address(sourceA));
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.record(agentId, bytes32(0), MODEL_A, SAME, bytes32(0));
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.record(agentId, SERVICE_A, bytes32(0), SAME, bytes32(0));
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.record(agentId, SERVICE_A, MODEL_A, NONE, bytes32(0));
        vm.stopPrank();
    }

    function test_recordLeavesAgentChecksToTheSource() public {
        sourceA.record(999, SERVICE_A, MODEL_A, SAME);
        assertTrue(results.isVerified(999), "the registry does not judge which agents exist");
    }

    // ── verdicts ─────────────────────────────────────────────────────

    function test_statusChangesCarryTheSourceAndEvidence() public {
        bytes32 evidence = sourceA.EVIDENCE();
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, NONE, SAME, address(sourceA), evidence
        );
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(agentId, 1, 0);
        sourceA.record(agentId, SERVICE_A, MODEL_A, SAME);

        IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(status.modelHash, MODEL_A);
        assertEq(uint8(status.verdict), uint8(SAME));
        assertEq(status.epoch, EPOCH);
        assertEq(status.updatedAt, block.timestamp);
        assertEq(status.source, address(sourceA));
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_A)), uint8(SAME));

        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(agentId, SERVICE_A, MODEL_A, SAME, NONE, address(0), 0);
        _clear(agentId, SERVICE_A);
        status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(NONE));
        assertEq(status.source, address(0), "no source after a clear");
        assertEq(status.epoch, 0);
    }

    function test_aRepeatFromAnotherSourceMovesTheSource() public {
        sourceA.record(agentId, SERVICE_A, MODEL_A, SAME);
        vm.recordLogs();
        sourceB.record(agentId, SERVICE_A, MODEL_A, SAME);
        assertEq(vm.getRecordedLogs().length, 0, "same verdict, same epoch: no change to report");
        assertEq(results.serviceStatus(agentId, SERVICE_A).source, address(sourceB));
        assertEq(results.agentStatus(agentId).verifiedCount, 1);
    }

    function test_theLatestRecordFromAnySourceWins() public {
        sourceA.record(agentId, SERVICE_A, MODEL_A, DIFF);
        assertEq(results.agentStatus(agentId).diffCount, 1);

        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, DIFF, SAME, address(sourceB), sourceB.EVIDENCE()
        );
        sourceB.record(agentId, SERVICE_A, MODEL_A, SAME);
        IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(SAME), "no lock: consensus is the source's business");
        assertEq(status.source, address(sourceB));
        assertTrue(results.isVerified(agentId));

        sourceA.record(agentId, SERVICE_A, MODEL_B, UNDETERMINED);
        status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(UNDETERMINED));
        assertEq(status.modelHash, MODEL_B);
        assertEq(status.source, address(sourceA));
        assertEq(results.agentStatus(agentId).verifiedCount, 0);
    }

    function test_aNewModelResetsTheServiceFirst() public {
        sourceA.record(agentId, SERVICE_A, MODEL_A, DIFF);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, DIFF, NONE, address(sourceA), sourceA.EVIDENCE()
        );
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_B, NONE, DIFF, address(sourceA), sourceA.EVIDENCE()
        );
        sourceA.record(agentId, SERVICE_A, MODEL_B, DIFF);
        assertEq(results.agentStatus(agentId).diffCount, 1, "counted once");
    }

    function test_verdictsExpireAfterTheValidityWindow() public {
        sourceA.record(agentId, SERVICE_A, MODEL_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        assertTrue(results.isVerified(agentId), "live through the next epoch");
        gate.setCurrentEpoch(EPOCH + 2);
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_A)), uint8(NONE));
        assertFalse(results.isVerified(agentId));

        results.setValidityEpochs(3);
        assertTrue(results.isVerified(agentId), "a longer window applies to existing verdicts");
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setValidityEpochs(0);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setValidityEpochs(5);
    }

    function test_agentStatusSumsEveryService() public {
        sourceA.record(agentId, SERVICE_A, MODEL_A, SAME);
        sourceB.record(agentId, SERVICE_B, MODEL_B, DIFF);
        IAntseedVerificationResults.AgentStatus memory status = results.agentStatus(agentId);
        assertEq(status.verifiedCount, 1);
        assertEq(status.diffCount, 1);
        assertFalse(results.isVerified(agentId));
        _clear(agentId, SERVICE_B);
        assertTrue(results.isVerified(agentId));
    }

    // ── shares ───────────────────────────────────────────────────────

    function test_sharesSumToAtMostTheWholeBucket() public {
        results.setSourceShareBps(address(sourceA), 6_000);
        vm.expectRevert(AntseedVerificationResults.SharesExceedBps.selector);
        results.setSourceShareBps(address(sourceB), 4_001);
        results.setSourceShareBps(address(sourceB), 4_000);
        assertEq(results.totalSourceShareBps(), 10_000);

        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.SourceShareBpsSet(address(sourceA), 5_000);
        results.setSourceShareBps(address(sourceA), 5_000);
        results.setSourceShareBps(address(sourceB), 5_000); // lowering A freed room for B
        assertEq(results.totalSourceShareBps(), 10_000);
        results.setSourceShareBps(address(sourceA), 0);
        assertEq(results.totalSourceShareBps(), 5_000);
    }

    // ── credits ──────────────────────────────────────────────────────

    function test_creditIsANoOpBeforeTheSourcesRewardsStart() public {
        assertEq(sourceA.credit(verifierA, 5), 0, "off by default");
        results.setRewardsStartEpoch(address(sourceA), uint64(EPOCH + 1));
        assertEq(sourceA.credit(verifierA, 5), 0);
        assertEq(results.epochCredits(address(sourceA), EPOCH), 0);
        results.setRewardsStartEpoch(address(sourceB), 0);
        assertEq(sourceB.credit(verifierA, 1), 1, "each source starts on its own");
        gate.setCurrentEpoch(EPOCH + 1);
        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.Credited(address(sourceA), EPOCH + 1, verifierA, 5);
        assertEq(sourceA.credit(verifierA, 5), 5);
    }

    function test_creditClampsToTheSourcesVerifierCap() public {
        results.setRewardsStartEpoch(address(sourceA), 0);
        results.setRewardsStartEpoch(address(sourceB), 0);
        results.setMaxCreditsPerAuditorPerEpoch(address(sourceA), 3);
        assertEq(sourceA.credit(verifierA, 2), 2);
        assertEq(sourceA.credit(verifierA, 2), 1, "clamped to what is left");
        assertEq(sourceA.credit(verifierA, 1), 0, "nothing left");
        assertEq(results.auditorEpochCredits(address(sourceA), EPOCH, verifierA), 3);
        assertEq(results.epochCredits(address(sourceA), EPOCH), 3, "only what was credited counts");
        assertEq(sourceB.credit(verifierA, 50), 50, "B has its own cap");
        assertEq(sourceA.credit(verifierB, 0), 0);
        vm.prank(address(sourceA));
        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        results.credit(address(0), 1);
    }

    // ── claims ───────────────────────────────────────────────────────

    function test_eachSourcePaysFromItsOwnShareAndCredits() public {
        _enable(address(sourceA), 6_000);
        _enable(address(sourceB), 4_000);
        results.setMaxAuditorShareBps(address(sourceA), 10_000);
        results.setMaxAuditorShareBps(address(sourceB), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        sourceA.credit(verifierA, 3);
        sourceA.credit(verifierB, 1);
        sourceB.credit(verifierA, 1);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(results.sourceBudget(address(sourceA), EPOCH), 600 ether);
        assertEq(results.pendingReward(address(sourceA), verifierA, EPOCH), 450 ether, "600 * 3/4");
        assertEq(results.pendingReward(address(sourceA), verifierB, EPOCH), 150 ether, "600 * 1/4");
        assertEq(results.pendingReward(address(sourceB), verifierA, EPOCH), 400 ether, "400 * 1/1");
        assertEq(results.pendingReward(address(sourceB), verifierB, EPOCH), 0);

        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.RewardClaimed(address(sourceA), EPOCH, verifierA, 450 ether, 0);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 450 ether);
        assertEq(_claim(address(sourceB), verifierA, EPOCH), 400 ether, "claims are per source");
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 0, "once per source");
        assertTrue(results.auditorEpochClaimed(address(sourceA), EPOCH, verifierA));
        assertFalse(results.auditorEpochClaimed(address(sourceA), EPOCH, verifierB));
        assertEq(gate.minted(verifierA), 850 ether);
    }

    function test_rewardAboveTheVerifierCapGoesToTheReserve() public {
        _enable(address(sourceA), 10_000);
        results.setMaxAuditorShareBps(address(sourceA), 2_000);
        gate.setBudget(address(results), EPOCH, 1_000_000 ether);
        sourceA.credit(verifierA, 1);
        sourceA.credit(verifierB, 1);
        gate.setCurrentEpoch(EPOCH + 1);

        assertEq(results.pendingReward(address(sourceA), verifierA, EPOCH), 200_000 ether, "capped at 20%");
        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.RewardClaimed(address(sourceA), EPOCH, verifierA, 200_000 ether, 300_000 ether);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 200_000 ether);
        assertEq(_claim(address(sourceA), verifierB, EPOCH), 200_000 ether);
        assertEq(gate.minted(reserve), 600_000 ether, "the capped part is not stranded");
        assertEq(gate.epochMinted(EPOCH), 1_000_000 ether, "the whole budget is accounted for");
    }

    function test_withoutAReserveTheOverflowIsNotMinted() public {
        gate.setEmissionsReserve(address(0));
        _enable(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        sourceA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 200 ether, "claims still work");
        assertEq(gate.epochMinted(EPOCH), 200 ether);
    }

    function test_claimsOnlyFinalizedEpochs() public {
        _enable(address(sourceA), 10_000);
        sourceA.credit(verifierA, 1);
        assertEq(results.pendingReward(address(sourceA), verifierA, EPOCH), 0, "current epoch is not final");
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerificationResults.EpochNotFinalized.selector);
        results.claimRewards(address(sourceA), epochs);
    }

    function test_unfundedBucketStaysClaimable() public {
        _enable(address(sourceA), 10_000);
        sourceA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 0);
        assertFalse(results.auditorEpochClaimed(address(sourceA), EPOCH, verifierA));
        gate.setBudget(address(results), EPOCH, 100 ether);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 20 ether);
    }

    // ── freezing ─────────────────────────────────────────────────────

    function test_sharesFreezeOnTheFirstClaim() public {
        _enable(address(sourceA), 10_000);
        results.setMaxAuditorShareBps(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        sourceA.credit(verifierA, 1);
        sourceA.credit(verifierB, 1);
        gate.setCurrentEpoch(EPOCH + 1);

        results.setSourceShareBps(address(sourceA), 8_000);
        assertEq(results.sourceBudget(address(sourceA), EPOCH), 800 ether, "not frozen yet: live share");
        results.setSourceShareBps(address(sourceA), 10_000);

        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.EpochSharesFrozen(EPOCH);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 500 ether);
        assertTrue(results.epochSharesFrozen(EPOCH));

        results.setSourceShareBps(address(sourceA), 2_000);
        results.setSourceShareBps(address(sourceB), 8_000);
        assertEq(results.sourceBudget(address(sourceA), EPOCH), 1_000 ether, "a frozen epoch keeps its split");
        assertEq(results.sourceBudget(address(sourceB), EPOCH), 0);
        assertEq(_claim(address(sourceA), verifierB, EPOCH), 500 ether, "B is paid as A was");
        gate.setBudget(address(results), EPOCH + 1, 1_000 ether);
        assertEq(results.sourceBudget(address(sourceA), EPOCH + 1), 200 ether, "later epochs use the new split");
    }

    function test_anEmptyClaimDoesNotFreeze() public {
        _enable(address(sourceA), 10_000);
        sourceA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 0, "no budget yet");
        assertFalse(results.epochSharesFrozen(EPOCH));
    }

    function test_voidingNeverLetsEarlierClaimsOverspend() public {
        _enable(address(sourceA), 10_000);
        results.setMaxAuditorShareBps(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 900 ether);
        sourceA.credit(verifierA, 1);
        sourceA.credit(verifierB, 1);
        sourceA.credit(seller, 1);
        gate.setCurrentEpoch(EPOCH + 1);

        assertEq(_claim(address(sourceA), verifierA, EPOCH), 300 ether);
        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.CreditsVoided(address(sourceA), EPOCH, seller, 1);
        results.voidCredits(address(sourceA), EPOCH, seller);
        assertEq(_claim(address(sourceA), verifierB, EPOCH), 450 ether, "voiding raises the others' shares");
        assertEq(gate.epochMinted(EPOCH), 750 ether, "never more than the source's budget");
        vm.expectRevert(AntseedVerificationResults.AlreadyClaimed.selector);
        results.voidCredits(address(sourceA), EPOCH, verifierA);
        results.voidCredits(address(sourceA), EPOCH, seller); // nothing left: no-op
    }

    // ── remainder ────────────────────────────────────────────────────

    function test_remainderSweepsUncreditedSourcesAndUnassignedBudget() public {
        _enable(address(sourceA), 5_000);
        _enable(address(sourceB), 3_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        sourceA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);

        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.EpochRemainderSettled(EPOCH, 500 ether, 0, 500 ether);
        vm.prank(seller); // anyone may settle
        (uint256 burned, uint256 reserved) = results.settleEpochRemainder(EPOCH);
        assertEq(burned + reserved, 500 ether, "B's 300 with no credits plus the unassigned 200");
        assertEq(gate.remainderClaimed(EPOCH), 500 ether);
        assertTrue(results.epochRemainderSettled(EPOCH));
        vm.expectRevert(AntseedVerificationResults.AlreadySettled.selector);
        results.settleEpochRemainder(EPOCH);

        results.setMaxAuditorShareBps(address(sourceA), 10_000);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 500 ether, "A's verifiers still claim theirs");
        assertEq(gate.epochMinted(EPOCH), 1_000 ether);
    }

    function test_anEpochWithoutCreditsSettlesInFull() public {
        _enable(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        gate.setCurrentEpoch(EPOCH + 1);
        (, uint256 reserved) = results.settleEpochRemainder(EPOCH);
        assertEq(reserved, 1_000 ether);
    }

    function test_remainderOnlyForFinalizedEpochsWithSomethingLeft() public {
        _enable(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        vm.expectRevert(AntseedVerificationResults.EpochNotFinalized.selector);
        results.settleEpochRemainder(EPOCH);

        sourceA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        vm.expectRevert(AntseedVerificationResults.NothingToSettle.selector);
        results.settleEpochRemainder(EPOCH);
    }

    function test_settlingFreezesTheSplit() public {
        _enable(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        gate.setCurrentEpoch(EPOCH + 1);
        results.settleEpochRemainder(EPOCH);
        assertTrue(results.epochSharesFrozen(EPOCH));
        results.setSourceShareBps(address(sourceA), 0);
        assertEq(results.sourceBudget(address(sourceA), EPOCH), 1_000 ether);
    }

    function test_onlyOwnerConfigures() public {
        vm.startPrank(verifierA);
        vm.expectRevert();
        results.setValidityEpochs(3);
        vm.expectRevert();
        results.clearServiceStatuses(new uint256[](0), new bytes32[](0));
        vm.expectRevert();
        results.setRewardsStartEpoch(address(sourceA), 0);
        vm.expectRevert();
        results.setMaxAuditorShareBps(address(sourceA), 5_000);
        vm.expectRevert();
        results.setMaxCreditsPerAuditorPerEpoch(address(sourceA), 5);
        vm.expectRevert();
        results.voidCredits(address(sourceA), EPOCH, verifierB);
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────

    /// @dev Gives `source` a share and turns its rewards on from epoch 0.
    function _enable(address source, uint16 shareBps) private {
        results.setSourceShareBps(source, shareBps);
        results.setRewardsStartEpoch(source, 0);
    }

    function _claim(address source, address verifier, uint256 epoch) private returns (uint256) {
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = epoch;
        vm.prank(verifier);
        return results.claimRewards(source, epochs);
    }

    function _clear(uint256 agent, bytes32 service) private {
        uint256[] memory agents = new uint256[](1);
        bytes32[] memory services = new bytes32[](1);
        agents[0] = agent;
        services[0] = service;
        results.clearServiceStatuses(agents, services);
    }
}
