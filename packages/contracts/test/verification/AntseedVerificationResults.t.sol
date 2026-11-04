// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { Test, Vm } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { IAntseedVerificationResults } from "../../interfaces/IAntseedVerificationResults.sol";
import { AntseedVerificationResults } from "../../verification/AntseedVerificationResults.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockVerificationEmissionsGate } from "../mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationAudit } from "../mocks/MockVerificationAudit.sol";

/// @dev The results layer on its own, written to by two mock audits (e.g. KBF and a probe method).
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
    MockVerificationAudit private auditA;
    MockVerificationAudit private auditB;
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
        results = new AntseedVerificationResults(address(gate));
        auditA = new MockVerificationAudit(address(results));
        auditB = new MockVerificationAudit(address(results));
        results.setAudit(address(auditA), true);
        results.setAudit(address(auditB), true);
        vm.prank(seller);
        agentId = identity.register();
    }

    // ── wiring ───────────────────────────────────────────────────────

    function test_defaults() public view {
        assertEq(address(results.emissionsGate()), address(gate));
        assertEq(results.MAX_VERDICT_EPOCHS(), 52, "about a year of weekly epochs");
        assertEq(results.totalAuditShareBps(), 0);
        assertEq(results.owner(), address(this));
        assertEq(results.auditCount(), 2);
        assertEq(results.rewardsStartEpoch(address(auditA)), type(uint64).max, "rewards off");
        assertEq(results.maxAuditorShareBps(address(auditA)), 2_000);
        assertEq(results.maxCreditsPerAuditorPerEpoch(address(auditA)), 100);
    }

    function test_settingsNeedAListedAuditAndStayPerAudit() public {
        vm.expectRevert(AntseedVerificationResults.UnknownAudit.selector);
        results.setAuditShareBps(address(0xBEEF), 1);
        vm.expectRevert(AntseedVerificationResults.UnknownAudit.selector);
        results.setRewardsStartEpoch(address(0xBEEF), 0);
        vm.expectRevert(AntseedVerificationResults.UnknownAudit.selector);
        results.setMaxAuditorShareBps(address(0xBEEF), 1);
        vm.expectRevert(AntseedVerificationResults.UnknownAudit.selector);
        results.setMaxCreditsPerAuditorPerEpoch(address(0xBEEF), 1);

        results.setMaxAuditorShareBps(address(auditA), 5_000);
        results.setMaxCreditsPerAuditorPerEpoch(address(auditA), 7);
        results.setRewardsStartEpoch(address(auditA), 3);
        assertEq(results.maxAuditorShareBps(address(auditB)), 2_000, "B keeps its own caps");
        assertEq(results.maxCreditsPerAuditorPerEpoch(address(auditB)), 100);
        assertEq(results.rewardsStartEpoch(address(auditB)), type(uint64).max);

        results.setAudit(address(auditA), false);
        results.setAudit(address(auditA), true);
        assertEq(results.maxAuditorShareBps(address(auditA)), 5_000, "re-approval keeps the settings");
        assertEq(results.auditCount(), 2, "and lists it once");

        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxAuditorShareBps(address(auditA), 0);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxAuditorShareBps(address(auditA), 10_001);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.setMaxCreditsPerAuditorPerEpoch(address(auditA), 0);
    }

    function test_atMostMaxAuditsAreListed() public {
        for (uint256 i = results.auditCount(); i < results.MAX_AUDITS(); i++) {
            results.setAudit(address(new MockVerificationAudit(address(results))), true);
        }
        address extra = address(new MockVerificationAudit(address(results)));
        vm.expectRevert(AntseedVerificationResults.TooManyAudits.selector);
        results.setAudit(extra, true);
    }

    function test_currentEpochIsTheGates() public {
        assertEq(results.currentEpoch(), EPOCH);
        gate.setCurrentEpoch(EPOCH + 7);
        assertEq(results.currentEpoch(), EPOCH + 7);
    }

    function test_setAuditIsOwnerOnlyAndNeedsAContract() public {
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AuditSet(address(auditA), false);
        results.setAudit(address(auditA), false);
        assertFalse(results.isAudit(address(auditA)));
        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        results.setAudit(address(0x1234), true);
        vm.prank(verifierA);
        vm.expectRevert();
        results.setAudit(address(auditA), true);
        vm.prank(verifierA);
        vm.expectRevert();
        results.setAuditShareBps(address(auditA), 1);
        vm.expectRevert(AntseedVerificationResults.UnknownAudit.selector);
        results.setAuditShareBps(address(0), 1);
    }

    // ── audits ──────────────────────────────────────────────────────

    function test_recordRejectsNonAudits() public {
        vm.expectRevert(AntseedVerificationResults.NotAudit.selector);
        results.record(agentId, SERVICE_A, MODEL_A, SAME, EPOCH + 2);
    }

    function test_creditRejectsNonAudits() public {
        vm.expectRevert(AntseedVerificationResults.NotAudit.selector);
        results.credit(verifierA, 1);
    }

    function test_removedAuditStopsWritingButEarnedCreditsStayClaimable() public {
        _enable(address(auditA), 10_000);
        results.setMaxAuditorShareBps(address(auditA), 10_000);
        gate.setBudget(address(results), EPOCH, 500 ether);
        assertEq(auditA.credit(verifierA, 2), 2);
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);

        results.setAudit(address(auditA), false);
        vm.expectRevert(AntseedVerificationResults.NotAudit.selector);
        auditA.record(agentId, SERVICE_A, MODEL_A, DIFF);
        vm.expectRevert(AntseedVerificationResults.NotAudit.selector);
        auditA.credit(verifierA, 1);
        assertTrue(results.isVerified(agentId), "its live verdicts stay until they expire");

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(_claim(address(auditA), verifierA, EPOCH), 500 ether, "credits it granted stay claimable");
        assertEq(results.auditShareBps(address(auditA)), 10_000, "a removed audit keeps its share setting");
    }

    function test_recordValidatesItsInput() public {
        vm.startPrank(address(auditA));
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.record(agentId, bytes32(0), MODEL_A, SAME, EPOCH + 2);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.record(agentId, SERVICE_A, bytes32(0), SAME, EPOCH + 2);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.record(agentId, SERVICE_A, MODEL_A, NONE, EPOCH + 2);
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.record(agentId, SERVICE_A, MODEL_A, SAME, EPOCH); // must count at least this epoch
        vm.expectRevert(AntseedVerificationResults.InvalidValue.selector);
        results.record(agentId, SERVICE_A, MODEL_A, SAME, EPOCH + 53); // at most MAX_VERDICT_EPOCHS
        results.record(agentId, SERVICE_A, MODEL_A, SAME, EPOCH + 52);
        assertTrue(results.isVerified(agentId));
        gate.setCurrentEpoch(EPOCH + 51);
        assertTrue(results.isVerified(agentId), "still counting in its last epoch, a year on");
        gate.setCurrentEpoch(EPOCH + 52);
        assertFalse(results.isVerified(agentId));
        vm.stopPrank();
    }

    function test_recordLeavesAgentChecksToTheAudit() public {
        auditA.record(999, SERVICE_A, MODEL_A, SAME);
        assertTrue(results.isVerified(999), "the registry does not judge which agents exist");
    }

    // ── verdicts ─────────────────────────────────────────────────────

    function test_statusChangesCarryTheAudit() public {
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(agentId, SERVICE_A, MODEL_A, NONE, SAME, address(auditA), gate.currentEpoch(), gate.currentEpoch() + 2);
        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AgentStatusChanged(agentId, 1, 0);
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);

        IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(status.modelHash, MODEL_A);
        assertEq(uint8(status.verdict), uint8(SAME));
        assertEq(status.epoch, EPOCH);
        assertEq(status.updatedAt, block.timestamp);
        assertEq(status.audit, address(auditA));
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_A)), uint8(SAME));

        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(agentId, SERVICE_A, MODEL_A, SAME, NONE, address(0), gate.currentEpoch(), 0);
        _clear(agentId, SERVICE_A);
        status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(NONE));
        assertEq(status.audit, address(0), "no audit after a clear");
        assertEq(status.epoch, 0);
    }

    function test_aRepeatInTheSameEpochChangesNothingNotEvenTheAudit() public {
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);
        vm.recordLogs();
        auditB.record(agentId, SERVICE_A, MODEL_A, SAME);
        assertEq(vm.getRecordedLogs().length, 0, "same verdict, same epoch: nothing changes");
        assertEq(results.serviceStatus(agentId, SERVICE_A).audit, address(auditA), "attribution stays");
        assertEq(results.agentStatus(agentId).verifiedCount, 1);
    }

    function test_aRepeatFromAnotherAuditLaterMovesTheAuditWithAnEvent() public {
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        vm.recordLogs();
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);
        // The same audit refreshing its verdict moves the expiry, which is reported (ServiceStatusChanged
        // and AgentStatusChanged), but the verdict itself is unchanged.
        assertEq(vm.getRecordedLogs().length, 2, "a refresh reports the new expiry");
        assertEq(results.serviceStatus(agentId, SERVICE_A).epoch, EPOCH + 1);
        assertEq(results.serviceStatus(agentId, SERVICE_A).validUntilEpoch, EPOCH + 3);

        gate.setCurrentEpoch(EPOCH + 2);
        uint256 updatedAt = results.serviceStatus(agentId, SERVICE_A).updatedAt;
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, SAME, SAME, address(auditB), gate.currentEpoch(), gate.currentEpoch() + 2
        );
        auditB.record(agentId, SERVICE_A, MODEL_A, SAME);
        IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(status.audit, address(auditB));
        assertEq(status.updatedAt, updatedAt, "the verdict itself did not change");
        assertEq(results.agentStatus(agentId).verifiedCount, 1);
    }

    function test_theLatestRecordFromAnyAuditWins() public {
        auditA.record(agentId, SERVICE_A, MODEL_A, DIFF);
        assertEq(results.agentStatus(agentId).diffCount, 1);

        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, DIFF, SAME, address(auditB), gate.currentEpoch(), gate.currentEpoch() + 2
        );
        auditB.record(agentId, SERVICE_A, MODEL_A, SAME);
        IAntseedVerificationResults.ServiceStatus memory status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(SAME), "no lock: consensus is the audit's business");
        assertEq(status.audit, address(auditB));
        assertTrue(results.isVerified(agentId));

        auditA.record(agentId, SERVICE_A, MODEL_B, UNDETERMINED);
        status = results.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(UNDETERMINED));
        assertEq(status.modelHash, MODEL_B);
        assertEq(status.audit, address(auditA));
        assertEq(results.agentStatus(agentId).verifiedCount, 0);
    }

    function test_aNewModelResetsTheServiceFirst() public {
        auditA.record(agentId, SERVICE_A, MODEL_A, DIFF);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, DIFF, NONE, address(auditA), gate.currentEpoch(), 0
        );
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_B, NONE, DIFF, address(auditA), gate.currentEpoch(), gate.currentEpoch() + 2
        );
        auditA.record(agentId, SERVICE_A, MODEL_B, DIFF);
        assertEq(results.agentStatus(agentId).diffCount, 1, "counted once");
    }

    function test_verdictsExpireAfterTheValidityWindow() public {
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        assertTrue(results.isVerified(agentId), "live through the next epoch");
        gate.setCurrentEpoch(EPOCH + 2);
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_A)), uint8(NONE));
        assertFalse(results.isVerified(agentId));

        assertEq(results.serviceStatus(agentId, SERVICE_A).validUntilEpoch, EPOCH + 2);
    }

    function test_eachAuditChoosesHowLongItsVerdictsCount() public {
        auditA.recordUntil(agentId, SERVICE_A, MODEL_A, SAME, EPOCH + 1); // this epoch only
        auditB.recordUntil(agentId, SERVICE_B, MODEL_B, DIFF, EPOCH + 4); // four epochs
        IAntseedVerificationResults.AgentStatus memory status = results.agentStatus(agentId);
        assertEq(status.verifiedCount, 1);
        assertEq(status.diffCount, 1);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_A)), uint8(NONE), "A's verdict expired");
        assertEq(uint8(results.liveVerdict(agentId, SERVICE_B)), uint8(DIFF));
        status = results.agentStatus(agentId);
        assertEq(status.verifiedCount, 0);
        assertEq(status.diffCount, 1);

        gate.setCurrentEpoch(EPOCH + 3);
        assertEq(results.agentStatus(agentId).diffCount, 1, "still counting in its last epoch");
        gate.setCurrentEpoch(EPOCH + 4);
        assertEq(results.agentStatus(agentId).diffCount, 0, "gone once it expired");
    }

    function test_aRepeatInALaterEpochReportsTheNewExpiry() public {
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);
        gate.setCurrentEpoch(EPOCH + 1);
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceStatusChanged(
            agentId, SERVICE_A, MODEL_A, SAME, SAME, address(auditA), EPOCH + 1, EPOCH + 3
        );
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);
        assertEq(results.serviceStatus(agentId, SERVICE_A).validUntilEpoch, EPOCH + 3);
    }

    function test_aLongUndeterminedDoesNotLengthenTheStatusSum() public {
        auditA.recordUntil(agentId, SERVICE_A, MODEL_A, UNDETERMINED, EPOCH + 52);
        uint256 gasBefore = gasleft();
        results.agentStatus(agentId);
        uint256 shortSum = gasBefore - gasleft();
        assertLt(shortSum, 20_000, "an UNDETERMINED counts nothing, so it adds no epochs to walk");
        assertEq(results.agentStatus(agentId).verifiedCount, 0);

        auditB.recordUntil(agentId, SERVICE_B, MODEL_B, SAME, EPOCH + 52);
        gate.setCurrentEpoch(EPOCH + 51);
        assertEq(results.agentStatus(agentId).verifiedCount, 1, "a long SAME still counts to its expiry");
    }

    function test_noCreditsInAnEpochWithoutAShare() public {
        results.setRewardsStartEpoch(address(auditA), 0);
        results.setAuditShareBps(address(auditA), 10_000); // applies from EPOCH + 1
        vm.recordLogs();
        assertEq(auditA.credit(verifierA, 1), 0, "no share of this epoch: nothing could pay it");
        assertEq(vm.getRecordedLogs().length, 0, "and no Credited event");
        assertEq(results.auditorEpochCredits(address(auditA), EPOCH, verifierA), 0);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(auditA.credit(verifierA, 1), 1, "credited once the share applies");
    }

    function test_aNewVerdictMovesTheServiceToItsExpiry() public {
        auditA.recordUntil(agentId, SERVICE_A, MODEL_A, SAME, EPOCH + 4);
        auditA.recordUntil(agentId, SERVICE_A, MODEL_A, SAME, EPOCH + 1); // same verdict, shorter
        assertEq(results.serviceStatus(agentId, SERVICE_A).validUntilEpoch, EPOCH + 1);
        assertEq(results.agentStatus(agentId).verifiedCount, 1, "counted once");
        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(results.agentStatus(agentId).verifiedCount, 0, "the old, longer expiry no longer counts");
    }

    function test_agentStatusSumsEveryService() public {
        auditA.record(agentId, SERVICE_A, MODEL_A, SAME);
        auditB.record(agentId, SERVICE_B, MODEL_B, DIFF);
        IAntseedVerificationResults.AgentStatus memory status = results.agentStatus(agentId);
        assertEq(status.verifiedCount, 1);
        assertEq(status.diffCount, 1);
        assertFalse(results.isVerified(agentId));
        _clear(agentId, SERVICE_B);
        assertTrue(results.isVerified(agentId));
    }

    // ── shares ───────────────────────────────────────────────────────

    function test_sharesSumToAtMostTheWholeBucket() public {
        results.setAuditShareBps(address(auditA), 6_000);
        vm.expectRevert(AntseedVerificationResults.SharesExceedBps.selector);
        results.setAuditShareBps(address(auditB), 4_001);
        results.setAuditShareBps(address(auditB), 4_000);
        assertEq(results.totalAuditShareBps(), 10_000);

        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AuditShareBpsSet(address(auditA), 5_000, EPOCH + 1);
        results.setAuditShareBps(address(auditA), 5_000);
        results.setAuditShareBps(address(auditB), 5_000); // lowering A freed room for B
        assertEq(results.totalAuditShareBps(), 10_000);
        results.setAuditShareBps(address(auditA), 0);
        assertEq(results.totalAuditShareBps(), 5_000);
    }

    // ── credits ──────────────────────────────────────────────────────

    function test_creditIsANoOpBeforeTheAuditsRewardsStart() public {
        assertEq(auditA.credit(verifierA, 5), 0, "off by default");
        results.setRewardsStartEpoch(address(auditA), uint64(EPOCH + 1));
        assertEq(auditA.credit(verifierA, 5), 0);
        assertEq(results.epochCredits(address(auditA), EPOCH), 0);
        _enable(address(auditB), 5_000);
        assertEq(auditB.credit(verifierA, 1), 1, "each audit starts on its own");
        results.setAuditShareBps(address(auditA), 5_000); // applies from EPOCH + 1
        gate.setCurrentEpoch(EPOCH + 1);
        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.Credited(address(auditA), EPOCH + 1, verifierA, 5);
        assertEq(auditA.credit(verifierA, 5), 5);
    }

    function test_creditClampsToTheAuditsVerifierCap() public {
        _enable(address(auditA), 5_000);
        _enable(address(auditB), 5_000);
        results.setMaxCreditsPerAuditorPerEpoch(address(auditA), 3);
        assertEq(auditA.credit(verifierA, 2), 2);
        assertEq(auditA.credit(verifierA, 2), 1, "clamped to what is left");
        assertEq(auditA.credit(verifierA, 1), 0, "nothing left");
        assertEq(results.auditorEpochCredits(address(auditA), EPOCH, verifierA), 3);
        assertEq(results.epochCredits(address(auditA), EPOCH), 3, "only what was credited counts");
        assertEq(auditB.credit(verifierA, 50), 50, "B has its own cap");
        assertEq(auditA.credit(verifierB, 0), 0);
        vm.prank(address(auditA));
        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        results.credit(address(0), 1);
    }

    // ── claims ───────────────────────────────────────────────────────

    function test_eachAuditPaysFromItsOwnShareAndCredits() public {
        _enable(address(auditA), 6_000);
        _enable(address(auditB), 4_000);
        results.setMaxAuditorShareBps(address(auditA), 10_000);
        results.setMaxAuditorShareBps(address(auditB), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        auditA.credit(verifierA, 3);
        auditA.credit(verifierB, 1);
        auditB.credit(verifierA, 1);

        gate.setCurrentEpoch(EPOCH + 1);
        assertEq(results.auditBudget(address(auditA), EPOCH), 600 ether);
        assertEq(results.pendingAuditorReward(address(auditA), verifierA, EPOCH), 450 ether, "600 * 3/4");
        assertEq(results.pendingAuditorReward(address(auditA), verifierB, EPOCH), 150 ether, "600 * 1/4");
        assertEq(results.pendingAuditorReward(address(auditB), verifierA, EPOCH), 400 ether, "400 * 1/1");
        assertEq(results.pendingAuditorReward(address(auditB), verifierB, EPOCH), 0);

        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.AuditorRewardClaimed(
            address(auditA), EPOCH, verifierA, 3, 4, 450 ether, 450 ether, 0
        );
        assertEq(_claim(address(auditA), verifierA, EPOCH), 450 ether);
        assertEq(_claim(address(auditB), verifierA, EPOCH), 400 ether, "claims are per audit");
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerificationResults.AlreadyClaimed.selector);
        results.claimAuditorReward(address(auditA), EPOCH);
        assertTrue(results.auditorEpochClaimed(address(auditA), EPOCH, verifierA));
        assertFalse(results.auditorEpochClaimed(address(auditA), EPOCH, verifierB));
        assertEq(gate.minted(verifierA), 850 ether);
    }

    function test_rewardAboveTheVerifierCapGoesToTheReserve() public {
        _enable(address(auditA), 10_000);
        results.setMaxAuditorShareBps(address(auditA), 2_000);
        gate.setBudget(address(results), EPOCH, 1_000_000 ether);
        auditA.credit(verifierA, 1);
        auditA.credit(verifierB, 1);
        gate.setCurrentEpoch(EPOCH + 1);

        assertEq(results.pendingAuditorReward(address(auditA), verifierA, EPOCH), 200_000 ether, "capped at 20%");
        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.AuditorRewardClaimed(
            address(auditA), EPOCH, verifierA, 1, 2, 500_000 ether, 200_000 ether, 300_000 ether
        );
        assertEq(_claim(address(auditA), verifierA, EPOCH), 200_000 ether);
        assertEq(_claim(address(auditA), verifierB, EPOCH), 200_000 ether);
        assertEq(gate.minted(reserve), 600_000 ether, "the capped part is not stranded");
        assertEq(gate.epochMinted(EPOCH), 1_000_000 ether, "the whole budget is accounted for");
    }

    function test_withoutAReserveACappedClaimReverts() public {
        gate.setEmissionsReserve(address(0));
        _enable(address(auditA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        auditA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerificationResults.InvalidAddress.selector);
        results.claimAuditorReward(address(auditA), EPOCH);

        results.setMaxAuditorShareBps(address(auditA), 10_000);
        assertEq(_claim(address(auditA), verifierA, EPOCH), 1_000 ether, "an uncapped claim needs no reserve");
    }

    function test_clearingAServiceBumpsItsClearCount() public {
        _enable(address(auditA), 10_000);
        assertEq(results.serviceClears(agentId, SERVICE_A), 0);
        // No live verdict: no ServiceStatusChanged, but ServiceCleared still reports every bump.
        vm.recordLogs();
        _clear(agentId, SERVICE_A);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only ServiceCleared for a service with no verdict");
        assertEq(logs[0].topics[0], AntseedVerificationResults.ServiceCleared.selector);
        assertEq(logs[0].topics[1], bytes32(agentId));
        assertEq(logs[0].topics[2], SERVICE_A);
        assertEq(logs[0].data, abi.encode(EPOCH, uint256(1)));
        vm.expectEmit(true, true, false, true, address(results));
        emit AntseedVerificationResults.ServiceCleared(agentId, SERVICE_A, EPOCH, 2);
        _clear(agentId, SERVICE_A);
        assertEq(results.serviceClears(agentId, SERVICE_A), 2);
        assertEq(results.serviceClears(agentId, SERVICE_B), 0, "other services are untouched");
    }

    function test_claimsOnlyFinalizedEpochs() public {
        _enable(address(auditA), 10_000);
        auditA.credit(verifierA, 1);
        assertEq(results.pendingAuditorReward(address(auditA), verifierA, EPOCH), 0, "current epoch is not final");
        vm.prank(verifierA);
        vm.expectRevert(AntseedVerificationResults.EpochNotFinalized.selector);
        results.claimAuditorReward(address(auditA), EPOCH);
    }

    function test_unfundedBucketStaysClaimable() public {
        _enable(address(auditA), 10_000);
        auditA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        _expectNothingToClaim(address(auditA), verifierA, EPOCH);
        assertFalse(results.auditorEpochClaimed(address(auditA), EPOCH, verifierA));
        gate.setBudget(address(results), EPOCH, 100 ether);
        assertEq(_claim(address(auditA), verifierA, EPOCH), 20 ether);
    }

    // ── share checkpoints ────────────────────────────────────────────

    function test_shareChangesApplyFromTheNextEpoch() public {
        _enable(address(auditA), 10_000);
        results.setMaxAuditorShareBps(address(auditA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        gate.setBudget(address(results), EPOCH + 1, 1_000 ether);
        gate.setBudget(address(results), EPOCH + 2, 1_000 ether);
        auditA.credit(verifierA, 1);
        auditA.credit(verifierB, 1);
        gate.setCurrentEpoch(EPOCH + 1);

        vm.expectEmit(true, false, false, true, address(results));
        emit AntseedVerificationResults.AuditShareBpsSet(address(auditA), 2_000, EPOCH + 2);
        results.setAuditShareBps(address(auditA), 2_000);
        results.setAuditShareBps(address(auditB), 8_000);
        assertEq(results.auditShareBps(address(auditA)), 2_000, "the latest setting");
        assertEq(results.auditShareBpsAt(address(auditA), EPOCH), 10_000);
        assertEq(results.auditShareBpsAt(address(auditA), EPOCH + 1), 10_000, "the running epoch keeps its split");
        assertEq(results.auditShareBpsAt(address(auditA), EPOCH + 2), 2_000);
        assertEq(results.auditBudget(address(auditA), EPOCH), 1_000 ether, "a finished epoch keeps its split");
        assertEq(results.auditBudget(address(auditB), EPOCH), 0);
        assertEq(results.auditBudget(address(auditA), EPOCH + 2), 200 ether);

        assertEq(_claim(address(auditA), verifierA, EPOCH), 500 ether);
        results.setAuditShareBps(address(auditA), 0);
        assertEq(_claim(address(auditA), verifierB, EPOCH), 500 ether, "B is paid as A was");
    }

    function test_settingAShareTwiceInOneEpochKeepsTheLast() public {
        results.setAuditShareBps(address(auditA), 3_000);
        results.setAuditShareBps(address(auditA), 4_000);
        assertEq(results.auditShareBpsAt(address(auditA), EPOCH), 0, "nothing for the running epoch");
        assertEq(results.auditShareBpsAt(address(auditA), EPOCH + 1), 4_000);
        assertEq(results.totalAuditShareBps(), 4_000);
    }

    function test_aClaimWithoutCreditsReverts() public {
        _enable(address(auditA), 10_000);
        gate.setBudget(address(results), EPOCH, 100 ether);
        auditA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        _expectNothingToClaim(address(auditA), verifierB, EPOCH);
        _expectNothingToClaim(address(auditB), verifierA, EPOCH);
        assertFalse(results.auditorEpochClaimed(address(auditA), EPOCH, verifierB));
    }

    function test_eachEpochIsClaimedOnce() public {
        _enable(address(auditA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        auditA.credit(verifierA, 1);
        auditA.credit(verifierB, 3);
        gate.setCurrentEpoch(EPOCH + 1);

        vm.expectEmit(true, true, true, true, address(results));
        emit AntseedVerificationResults.AuditorRewardClaimed(
            address(auditA), EPOCH, verifierA, 1, 4, 250 ether, 200 ether, 50 ether
        );
        assertEq(_claim(address(auditA), verifierA, EPOCH), 200 ether, "20% cap");
        assertEq(gate.minted(reserve), 50 ether, "the part above the cap goes to the reserve");
        assertTrue(results.auditorEpochClaimed(address(auditA), EPOCH, verifierA));
        assertEq(results.pendingAuditorReward(address(auditA), verifierA, EPOCH), 0, "claimed");

        vm.prank(verifierA);
        vm.expectRevert(AntseedVerificationResults.AlreadyClaimed.selector);
        results.claimAuditorReward(address(auditA), EPOCH);
    }

    function test_claimsStopWhilePaused() public {
        _enable(address(auditA), 10_000);
        gate.setBudget(address(results), EPOCH, 1_000 ether);
        auditA.credit(verifierA, 1);
        gate.setCurrentEpoch(EPOCH + 1);
        results.pause();
        vm.prank(verifierA);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        results.claimAuditorReward(address(auditA), EPOCH);
        results.unpause();
        assertEq(_claim(address(auditA), verifierA, EPOCH), 200 ether);
    }

    /// @dev However credits are spread and in whatever order auditors claim, nobody gets more than
    ///      the cap, and the auditors plus the reserve never get more than the audit's budget.
    function testFuzz_claimsNeverExceedTheBudget(uint8 creditsA, uint8 creditsB, uint8 creditsC, uint16 capBps)
        public
    {
        capBps = uint16(bound(capBps, 1, 10_000));
        _enable(address(auditA), 10_000);
        results.setMaxAuditorShareBps(address(auditA), capBps);
        uint256 budget = 1_000 ether + 7;
        gate.setBudget(address(results), EPOCH, budget);
        address[3] memory auditors = [verifierA, verifierB, seller];
        uint8[3] memory credits = [creditsA, creditsB, creditsC];
        for (uint256 i = 0; i < 3; i++) {
            if (credits[i] != 0) auditA.credit(auditors[i], credits[i]);
        }
        gate.setCurrentEpoch(EPOCH + 1);
        uint256 cap = (budget * capBps) / 10_000;
        for (uint256 i = 0; i < 3; i++) {
            if (credits[i] == 0) continue;
            uint256 pending = results.pendingAuditorReward(address(auditA), auditors[i], EPOCH);
            uint256 gross = (budget * credits[i]) / results.epochCredits(address(auditA), EPOCH);
            if (gross == 0) continue;
            assertEq(_claim(address(auditA), auditors[i], EPOCH), pending, "pays what pending showed");
            assertLe(pending, cap);
        }
        assertLe(gate.epochMinted(EPOCH), budget);
    }

    function test_onlyOwnerConfigures() public {
        vm.startPrank(verifierA);
        vm.expectRevert();
        results.clearServiceStatuses(new uint256[](0), new bytes32[](0));
        vm.expectRevert();
        results.setRewardsStartEpoch(address(auditA), 0);
        vm.expectRevert();
        results.setMaxAuditorShareBps(address(auditA), 5_000);
        vm.expectRevert();
        results.setMaxCreditsPerAuditorPerEpoch(address(auditA), 5);
        vm.expectRevert();
        results.pause();
        vm.expectRevert();
        results.unpause();
        vm.stopPrank();
    }

    // ── helpers ──────────────────────────────────────────────────────

    /// @dev Gives `audit` a share for the current epoch on (set during the previous one, since a
    ///      share applies from the next epoch) and turns its rewards on from epoch 0.
    function _enable(address audit, uint16 shareBps) private {
        uint256 epoch = gate.currentEpoch();
        gate.setCurrentEpoch(epoch - 1);
        results.setAuditShareBps(audit, shareBps);
        gate.setCurrentEpoch(epoch);
        results.setRewardsStartEpoch(audit, 0);
    }

    /// @dev Claims `verifier`'s reward from `audit` for `epoch` and returns what it received.
    function _claim(address audit, address verifier, uint256 epoch) private returns (uint256) {
        uint256 before = gate.minted(verifier);
        vm.prank(verifier);
        results.claimAuditorReward(audit, epoch);
        return gate.minted(verifier) - before;
    }

    function _expectNothingToClaim(address audit, address verifier, uint256 epoch) private {
        vm.prank(verifier);
        vm.expectRevert(AntseedVerificationResults.NothingToClaim.selector);
        results.claimAuditorReward(audit, epoch);
    }

    function _clear(uint256 agent, bytes32 service) private {
        uint256[] memory agents = new uint256[](1);
        bytes32[] memory services = new bytes32[](1);
        agents[0] = agent;
        services[0] = service;
        results.clearServiceStatuses(agents, services);
    }
}
