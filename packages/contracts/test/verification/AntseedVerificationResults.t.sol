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

    function test_aRepeatInTheSameEpochChangesNothingNotEvenTheSource() public {
        sourceA.record(agentId, SERVICE_A, MODEL_A, SAME);
        vm.recordLogs();
        sourceB.record(agentId, SERVICE_A, MODEL_A, SAME);
        assertEq(vm.getRecordedLogs().length, 0, "same verdict, same epoch: nothing changes");
        assertEq(results.serviceStatus(agentId, SERVICE_A).source, address(sourceA), "attribution stays");
        assertEq(results.agentStatus(agentId).verifiedCount, 1);
    }

    function test_aRepeatFromAnotherSourceLaterMovesTheSourceWithAnEvent() public {
        sourceA.record(agentId, SERVICE_A, MODEL_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        vm.recordLogs();
        sourceA.record(agentId, SERVICE_A, MODEL_A, SAME);
        assertEq(vm.getRecordedLogs().length, 0, "the same source refreshing its verdict: nothing to report");
        assertEq(results.serviceStatus(agentId, SERVICE_A).epoch, EPOCH + 1);

        gate.setCurrentEpoch(EPOCH + 2);
        uint256 updatedAt = results.serviceStatus(agentId, SERVICE_A).updatedAt;
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, SAME, SAME, address(sourceB), MockVerificationSource(address(sourceB)).EVIDENCE()
        );
        sourceB.record(agentId, SERVICE_A, MODEL_A, SAME);
        IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(status.source, address(sourceB));
        assertEq(status.updatedAt, updatedAt, "the verdict itself did not change");
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
        emit AntseedVerificationResults.SourceShareBpsSet(address(sourceA), 5_000, EPOCH + 1);
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

    function test_withoutAReserveACappedClaimReverts() public {
        gate.setEmissionsReserve(address(0));
        _enable(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        sourceA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = EPOCH;
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        results.claimRewards(address(sourceA), epochs);

        results.setMaxAuditorShareBps(address(sourceA), 10_000);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 1_000 ether, "an uncapped claim needs no reserve");
    }

    function test_clearingAServiceBumpsItsClearCount() public {
        _enable(address(sourceA), 10_000);
        assertEq(results.serviceClears(agentId, SERVICE_A), 0);
        _clear(agentId, SERVICE_A);
        _clear(agentId, SERVICE_A);
        assertEq(results.serviceClears(agentId, SERVICE_A), 2);
        assertEq(results.serviceClears(agentId, SERVICE_B), 0, "other services are untouched");
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

    // ── share checkpoints ────────────────────────────────────────────

    function test_shareChangesApplyFromTheNextEpoch() public {
        _enable(address(sourceA), 10_000);
        results.setMaxAuditorShareBps(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        gate.setBudget(address(results), EPOCH + 1, 1_000 ether);
        gate.setBudget(address(results), EPOCH + 2, 1_000 ether);
        sourceA.credit(verifierA, 1);
        sourceA.credit(verifierB, 1);
        gate.setCurrentEpoch(EPOCH + 1);

        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.SourceShareBpsSet(address(sourceA), 2_000, EPOCH + 2);
        results.setSourceShareBps(address(sourceA), 2_000);
        results.setSourceShareBps(address(sourceB), 8_000);
        assertEq(results.sourceShareBps(address(sourceA)), 2_000, "the latest setting");
        assertEq(results.sourceShareBpsAt(address(sourceA), EPOCH), 10_000);
        assertEq(results.sourceShareBpsAt(address(sourceA), EPOCH + 1), 10_000, "the running epoch keeps its split");
        assertEq(results.sourceShareBpsAt(address(sourceA), EPOCH + 2), 2_000);
        assertEq(results.sourceBudget(address(sourceA), EPOCH), 1_000 ether, "a finished epoch keeps its split");
        assertEq(results.sourceBudget(address(sourceB), EPOCH), 0);
        assertEq(results.sourceBudget(address(sourceA), EPOCH + 2), 200 ether);

        assertEq(_claim(address(sourceA), verifierA, EPOCH), 500 ether);
        results.setSourceShareBps(address(sourceA), 0);
        assertEq(_claim(address(sourceA), verifierB, EPOCH), 500 ether, "B is paid as A was");
    }

    function test_settingAShareTwiceInOneEpochKeepsTheLast() public {
        results.setSourceShareBps(address(sourceA), 3_000);
        results.setSourceShareBps(address(sourceA), 4_000);
        assertEq(results.sourceShareBpsAt(address(sourceA), EPOCH), 0, "nothing for the running epoch");
        assertEq(results.sourceShareBpsAt(address(sourceA), EPOCH + 1), 4_000);
        assertEq(results.totalSourceShareBps(), 4_000);
    }

    function test_anEmptyClaimChangesNothing() public {
        _enable(address(sourceA), 10_000);
        sourceA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 0, "no budget yet");
        assertFalse(results.auditorEpochClaimed(address(sourceA), EPOCH, verifierA));
        assertEq(results.claimedCredits(address(sourceA), EPOCH), 0);
        gate.setBudget(address(results), EPOCH, 100 ether);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 20 ether, "claimable once funded");
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
        assertEq(results.settledRemainder(EPOCH), 500 ether);
        assertEq(results.unclaimableRemainder(EPOCH), 0);
        vm.expectRevert(AntseedVerificationResults.NothingToSettle.selector);
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

    function test_voidingAfterSettlementFreesTheBudgetAgain() public {
        _enable(address(sourceA), 5_000);
        _enable(address(sourceB), 5_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        sourceA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        results.settleEpochRemainder(EPOCH);
        assertEq(gate.remainderClaimed(EPOCH), 500 ether, "B's share");

        results.voidCredits(address(sourceA), EPOCH, verifierA);
        assertEq(results.unclaimableRemainder(EPOCH), 500 ether, "A's share is free now");
        results.settleEpochRemainder(EPOCH);
        assertEq(gate.epochMinted(EPOCH), 1_000 ether, "nothing is stranded");
        assertEq(results.settledRemainder(EPOCH), 1_000 ether);
    }

    function test_voidingAfterAPartialClaimSettlesTheRest() public {
        _enable(address(sourceA), 10_000);
        results.setMaxAuditorShareBps(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        sourceA.credit(verifierA, 1);
        sourceA.credit(verifierB, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(address(sourceA), verifierA, EPOCH), 500 ether);
        assertEq(results.claimedCredits(address(sourceA), EPOCH), 1);
        assertEq(results.paidRewards(address(sourceA), EPOCH), 500 ether);
        vm.expectRevert(AntseedVerificationResults.NothingToSettle.selector);
        results.settleEpochRemainder(EPOCH); // B's 500 is still reserved

        results.voidCredits(address(sourceA), EPOCH, verifierB);
        (, uint256 reserved) = results.settleEpochRemainder(EPOCH);
        assertEq(reserved, 500 ether, "what B can no longer claim");
        assertEq(gate.epochMinted(EPOCH), 1_000 ether);
    }

    function test_settlementIsCappedByWhatTheGateHasLeft() public {
        _enable(address(sourceA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        gate.setPriorMinted(EPOCH, 400 ether); // e.g. an earlier controller of the same minter id
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(results.unclaimableRemainder(EPOCH), 600 ether);
        (, uint256 reserved) = results.settleEpochRemainder(EPOCH);
        assertEq(reserved, 600 ether);
        vm.expectRevert(AntseedVerificationResults.NothingToSettle.selector);
        results.settleEpochRemainder(EPOCH);
    }

    /// @dev Any order of claims, voids and settlements stays inside the budget, and once everyone
    ///      claimed and everything is settled the budget is fully minted (up to rounding dust).
    function testFuzz_claimsVoidsAndSettlementsNeverOverspend(
        uint8 creditsA,
        uint8 creditsB,
        uint8 creditsC,
        uint16 shareA,
        uint16 capBps,
        uint8 order
    ) public {
        shareA = uint16(bound(shareA, 0, 10_000));
        capBps = uint16(bound(capBps, 1, 10_000));
        _enable(address(sourceA), shareA);
        _enable(address(sourceB), uint16(10_000 - shareA));
        results.setMaxAuditorShareBps(address(sourceA), capBps);
        uint256 budget = 1_000_003 ether + 7;
        gate.setBudget(address(results), EPOCH, budget);
        if (creditsA != 0) sourceA.credit(verifierA, creditsA);
        if (creditsB != 0) sourceA.credit(verifierB, creditsB);
        if (creditsC != 0) sourceA.credit(seller, creditsC);
        gate.setCurrentEpoch(EPOCH + 1);

        address[3] memory verifiers = [verifierA, verifierB, seller];
        for (uint256 step = 0; step < 6; step++) {
            uint256 action = (uint256(order) >> step) % 3;
            address verifier = verifiers[(uint256(order) + step) % 3];
            if (action == 0) {
                _claim(address(sourceA), verifier, EPOCH);
            } else if (action == 1 && !results.auditorEpochClaimed(address(sourceA), EPOCH, verifier)) {
                results.voidCredits(address(sourceA), EPOCH, verifier);
            } else if (results.unclaimableRemainder(EPOCH) != 0) {
                results.settleEpochRemainder(EPOCH);
            }
            assertLe(gate.epochMinted(EPOCH), budget);
        }
        for (uint256 i = 0; i < 3; i++) {
            _claim(address(sourceA), verifiers[i], EPOCH);
        }
        if (results.unclaimableRemainder(EPOCH) != 0) results.settleEpochRemainder(EPOCH);
        assertLe(gate.epochMinted(EPOCH), budget);
        assertGe(gate.epochMinted(EPOCH) + 10, budget, "everything but rounding dust is minted");
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

    /// @dev Gives `source` a share for the current epoch on (set during the previous one, since a
    ///      share applies from the next epoch) and turns its rewards on from epoch 0.
    function _enable(address source, uint16 shareBps) private {
        uint256 epoch = gate.currentEpoch();
        gate.setCurrentEpoch(epoch - 1);
        results.setSourceShareBps(source, shareBps);
        gate.setCurrentEpoch(epoch);
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
