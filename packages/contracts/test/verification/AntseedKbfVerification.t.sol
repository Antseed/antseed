// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {AntseedRegistry} from "../../core/AntseedRegistry.sol";
import {IAntseedKbfVerification} from "../../interfaces/IAntseedKbfVerification.sol";
import {AntseedKbfVerification} from "../../verification/AntseedKbfVerification.sol";
import {AntseedKbfVerificationPointsPolicy} from "../../policies/AntseedKbfVerificationPointsPolicy.sol";
import {MockERC8004Registry} from "../mocks/MockERC8004Registry.sol";
import {MockVerificationEmissionsGate} from "../mocks/MockVerificationEmissionsGate.sol";
import {MockVerificationSellerPools} from "../mocks/MockVerificationSellerPools.sol";

/// @dev Builds Merkle roots and proofs the way OpenZeppelin's MerkleProof verifies them: sorted
///      pairs, an odd node moves up unchanged.
library TestMerkle {
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        bytes32[] memory layer = leaves;
        while (layer.length > 1) {
            bytes32[] memory next = new bytes32[]((layer.length + 1) / 2);
            for (uint256 i = 0; i < next.length; i++) {
                uint256 left = i * 2;
                next[i] = left + 1 < layer.length ? _hashPair(layer[left], layer[left + 1]) : layer[left];
            }
            layer = next;
        }
        return layer[0];
    }

    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory) {
        bytes32[] memory path = new bytes32[](32);
        uint256 length;
        bytes32[] memory layer = leaves;
        while (layer.length > 1) {
            uint256 sibling = index ^ 1;
            if (sibling < layer.length) path[length++] = layer[sibling];
            bytes32[] memory next = new bytes32[]((layer.length + 1) / 2);
            for (uint256 i = 0; i < next.length; i++) {
                uint256 left = i * 2;
                next[i] = left + 1 < layer.length ? _hashPair(layer[left], layer[left + 1]) : layer[left];
            }
            layer = next;
            index /= 2;
        }
        bytes32[] memory out = new bytes32[](length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = path[i];
        }
        return out;
    }
}

contract VerificationPointsAccounting {
    address public immutable sellerPools;

    constructor(address pools) {
        sellerPools = pools;
    }
}

contract AntseedKbfVerificationTest is Test {
    uint256 private constant EPOCH = 5;
    uint256 private constant EPOCH_START = 1_800_000_000;
    string private constant MODEL_A_ID = "model-a";
    string private constant MODEL_B_ID = "model-b";
    bytes32 private constant MODEL_A = keccak256("model-a");
    bytes32 private constant MODEL_B = keccak256("model-b");
    bytes32 private constant SERVICE_A = bytes32(uint256(1));
    bytes32 private constant SERVICE_B = bytes32(uint256(2));
    bytes32 private constant BANK_KEY = keccak256("bank-key");
    string private constant URI = "ipfs://bafy";

    IAntseedKbfVerification.Verdict private constant SAME = IAntseedKbfVerification.Verdict.SAME;
    IAntseedKbfVerification.Verdict private constant DIFF = IAntseedKbfVerification.Verdict.DIFF;
    IAntseedKbfVerification.Verdict private constant NONE = IAntseedKbfVerification.Verdict.NONE;
    IAntseedKbfVerification.Verdict private constant UNDETERMINED = IAntseedKbfVerification.Verdict.UNDETERMINED;

    address private publisher = address(0xB0B);
    address private verifierA = address(0xA1);
    address private verifierB = address(0xB2);
    address private verifierC = address(0xC3);
    address private seller = address(0x5E1);

    AntseedRegistry private registry;
    AntseedKbfVerification private verification;
    MockERC8004Registry private identityRegistry;
    MockVerificationEmissionsGate private gate;
    MockVerificationSellerPools private pools;
    uint256 private agentId;
    mapping(uint256 epoch => bytes32[] leaves) private _allLeaves;
    mapping(uint256 epoch => bool finalized) private _allFinalized;

    function setUp() public {
        registry = new AntseedRegistry();
        identityRegistry = new MockERC8004Registry();
        gate = new MockVerificationEmissionsGate();
        pools = new MockVerificationSellerPools();
        gate.setSchedule(EPOCH_START - EPOCH * 7 days, 7 days);
        gate.setCurrentEpoch(EPOCH);
        vm.warp(EPOCH_START + 1 hours);
        vm.roll(1_000);
        registry.setIdentityRegistry(address(identityRegistry));
        registry.setEmissions(address(gate));
        verification = new AntseedKbfVerification(address(registry), address(pools));
        verification.setPublisher(publisher);
        verification.setVerifier(verifierA, true);
        verification.setVerifier(verifierB, true);
        verification.setVerifier(verifierC, true);
        verification.setModels(_models());
        verification.setRewardsStartEpoch(0);
        gate.setBudget(address(verification), EPOCH, 1_000 ether);
        vm.prank(seller);
        agentId = identityRegistry.register();
    }

    // ── round ────────────────────────────────────────────────────────

    function test_fullRoundAppliesMajorityResults() public {
        _openAndSeed(EPOCH);
        IAntseedKbfVerification.EpochInfo memory info = verification.epochInfo(EPOCH);
        assertTrue(info.seed != bytes32(0));
        assertEq(info.verifierCount, 3);
        assertEq(info.modelsVersion, 1);
        assertEq(info.startedAt, EPOCH_START);
        assertEq(verification.threshold(EPOCH), 2);

        _commitPlan(EPOCH);
        vm.prank(verifierA);
        verification.commitSlices(EPOCH, keccak256("slices-a"), URI);
        _toReveal(EPOCH);

        (bytes32 root, bytes32[] memory leaves, IAntseedKbfVerification.ServiceResult[] memory results) =
            _resultsRoot(EPOCH, SAME);
        vm.prank(verifierA);
        verification.attest(EPOCH, root, URI);
        assertEq(verification.epochInfo(EPOCH).finalizedRoot, bytes32(0), "one of three is not a majority");
        vm.prank(verifierB);
        verification.attest(EPOCH, root, URI);
        assertEq(verification.epochInfo(EPOCH).finalizedRoot, root);

        _apply(EPOCH, results, leaves);
        IAntseedKbfVerification.ServiceStatus memory status = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(SAME));
        assertEq(status.modelHash, MODEL_A);
        assertEq(status.epoch, EPOCH);
        assertTrue(verification.isVerified(agentId));
    }

    function test_dissentingRootNeverFinalizesWithoutMajority() public {
        _openAndSeed(EPOCH);
        _commitPlan(EPOCH);
        _toReveal(EPOCH);
        (bytes32 sameRoot,,) = _resultsRoot(EPOCH, SAME);
        (bytes32 diffRoot,,) = _resultsRoot(EPOCH, DIFF);
        vm.prank(verifierA);
        verification.attest(EPOCH, sameRoot, URI);
        vm.prank(verifierB);
        verification.attest(EPOCH, diffRoot, URI);
        assertEq(verification.epochInfo(EPOCH).finalizedRoot, bytes32(0));
        vm.prank(verifierC);
        verification.attest(EPOCH, diffRoot, URI);
        assertEq(verification.epochInfo(EPOCH).finalizedRoot, diffRoot);
        assertEq(verification.rootVotes(EPOCH, diffRoot), 2);
    }

    function test_attestationIsOncePerVerifier() public {
        _openAndSeed(EPOCH);
        _commitPlan(EPOCH);
        _toReveal(EPOCH);
        (bytes32 root,,) = _resultsRoot(EPOCH, SAME);
        vm.startPrank(verifierA);
        verification.attest(EPOCH, root, URI);
        vm.expectRevert(AntseedKbfVerification.AlreadyAttested.selector);
        verification.attest(EPOCH, keccak256("other"), URI);
        vm.stopPrank();
    }

    function test_phasesAreEnforced() public {
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.openEpoch(EPOCH);

        vm.expectRevert(AntseedKbfVerification.NotPublisher.selector);
        verification.commitBank(EPOCH, keccak256("bank"), _keyHash(), URI);
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.WrongEpoch.selector);
        verification.commitBank(EPOCH + 2, keccak256("bank"), _keyHash(), URI);

        _commitBank(EPOCH);
        vm.expectRevert(AntseedKbfVerification.WrongEpoch.selector);
        verification.openEpoch(EPOCH + 1);
        verification.openEpoch(EPOCH);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.openEpoch(EPOCH);
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitBank(EPOCH, keccak256("bank-2"), _keyHash(), URI);

        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.fixSeed(EPOCH);
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitPlan(EPOCH, keccak256("plan"), URI);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitSlices(EPOCH, keccak256("slices"), URI);

        vm.roll(block.number + 5);
        verification.fixSeed(EPOCH);
        _commitPlan(EPOCH);

        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.revealBankKey(EPOCH, BANK_KEY);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.attest(EPOCH, keccak256("root"), URI);

        vm.warp(EPOCH_START + 4 days);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.revealBankKey(EPOCH, keccak256("wrong"));
        verification.revealBankKey(EPOCH, BANK_KEY);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitSlices(EPOCH, keccak256("late"), URI);

        vm.warp(EPOCH_START + 5 days);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.attest(EPOCH, keccak256("root"), URI);
    }

    function test_openingIsTooLateAfterCollection() public {
        _commitBank(EPOCH);
        vm.warp(EPOCH_START + 3 days);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.openEpoch(EPOCH);
    }

    function test_bankForNextEpochCanBeCommittedEarly() public {
        _commitBank(EPOCH + 1);
        assertEq(verification.epochInfo(EPOCH + 1).bankHash, keccak256(abi.encode("bank", EPOCH + 1)));
    }

    function test_seedRearmsWhenItsBlockHashIsGone() public {
        _commitBank(EPOCH);
        verification.openEpoch(EPOCH);
        uint64 first = verification.epochInfo(EPOCH).seedBlock;
        vm.roll(first + 300);
        verification.fixSeed(EPOCH);
        IAntseedKbfVerification.EpochInfo memory info = verification.epochInfo(EPOCH);
        assertEq(info.seed, bytes32(0));
        assertEq(info.seedBlock, uint64(block.number) + verification.SEED_DELAY_BLOCKS());
        vm.roll(info.seedBlock + 1);
        verification.fixSeed(EPOCH);
        assertTrue(verification.epochInfo(EPOCH).seed != bytes32(0));
    }

    function test_seedDependsOnBlockHashEpochAndBank() public {
        _openAndSeed(EPOCH);
        IAntseedKbfVerification.EpochInfo memory info = verification.epochInfo(EPOCH);
        assertEq(info.seed, keccak256(abi.encode(blockhash(info.seedBlock), EPOCH, info.bankHash)));
    }

    function test_epochUsesTheVerifierSnapshot() public {
        address late = address(0xD4);
        _openAndSeed(EPOCH);
        verification.setVerifier(late, true);
        verification.setVerifier(verifierC, false);
        _commitPlan(EPOCH);

        vm.prank(late);
        vm.expectRevert(AntseedKbfVerification.NotVerifier.selector);
        verification.commitSlices(EPOCH, keccak256("slices"), URI);
        vm.prank(verifierC);
        verification.commitSlices(EPOCH, keccak256("slices"), URI);

        assertEq(verification.epochVerifiers(EPOCH).length, 3);
        assertEq(verification.verifiers().length, 3);
        assertFalse(verification.isVerifier(verifierC));
        assertTrue(verification.isVerifier(late));
    }

    function test_sliceCommitsAreBackupsAfterTheCommitDeadline() public {
        _openAndSeed(EPOCH);
        _commitPlan(EPOCH);
        vm.expectEmit(true, true, false, true);
        emit AntseedKbfVerification.SlicesCommitted(EPOCH, verifierA, false, keccak256("p"), URI);
        vm.prank(verifierA);
        verification.commitSlices(EPOCH, keccak256("p"), URI);

        // Backups need no publisher step: the plan already sealed them to their verifiers.
        vm.warp(EPOCH_START + 3 days);
        vm.expectEmit(true, true, false, true);
        emit AntseedKbfVerification.SlicesCommitted(EPOCH, verifierB, true, keccak256("b"), URI);
        vm.prank(verifierB);
        verification.commitSlices(EPOCH, keccak256("b"), URI);
    }

    function test_sliceCommitsAreCapped() public {
        _openAndSeed(EPOCH);
        _commitPlan(EPOCH);
        vm.startPrank(verifierA);
        for (uint256 i = 0; i < verification.MAX_SLICE_COMMITS(); i++) {
            verification.commitSlices(EPOCH, keccak256(abi.encode(i)), URI);
        }
        vm.expectRevert(AntseedKbfVerification.TooManyCommits.selector);
        verification.commitSlices(EPOCH, keccak256("one more"), URI);
        vm.stopPrank();
    }

    function test_plansAreFrozenOnceCommitted() public {
        _openAndSeed(EPOCH);
        _commitPlan(EPOCH);
        bytes32 plan = keccak256(abi.encode("plan", EPOCH));
        // The same plan again is a no-op; a different one would void slices already bought.
        vm.recordLogs();
        vm.prank(publisher);
        verification.commitPlan(EPOCH, plan, URI);
        assertEq(vm.getRecordedLogs().length, 0);
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.PlanAlreadyCommitted.selector);
        verification.commitPlan(EPOCH, keccak256("other plan"), URI);
        assertEq(verification.epochInfo(EPOCH).planHash, plan);
    }

    function test_urisMustBeIpfs() public {
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.InvalidUri.selector);
        verification.commitBank(EPOCH, keccak256("bank"), _keyHash(), "https://x");
    }

    // ── publisher fallback ───────────────────────────────────────────

    function test_verifierTakesOverAnEpochWithoutABank() public {
        bytes32 bank = keccak256("verifier bank");
        bytes32 keyHash = _keyHash();
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.takeOverBank(EPOCH, bank, keyHash, URI);

        vm.warp(EPOCH_START + verification.publisherGraceSeconds());
        vm.prank(address(0xBAD));
        vm.expectRevert(AntseedKbfVerification.NotVerifier.selector);
        verification.takeOverBank(EPOCH, bank, keyHash, URI);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongEpoch.selector);
        verification.takeOverBank(EPOCH + 1, bank, keyHash, URI);

        vm.expectEmit(true, true, false, false);
        emit AntseedKbfVerification.EpochTakenOver(EPOCH, verifierA);
        vm.prank(verifierA);
        verification.takeOverBank(EPOCH, bank, keyHash, URI);
        IAntseedKbfVerification.EpochInfo memory info = verification.epochInfo(EPOCH);
        assertEq(info.publisher, verifierA);
        assertEq(info.bankHash, bank);
        assertEq(info.takenOverAt, block.timestamp);

        // The original publisher can no longer replace the bank or run the epoch.
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitBank(EPOCH, keccak256("late bank"), keyHash, URI);
        verification.openEpoch(EPOCH);
        vm.roll(verification.epochInfo(EPOCH).seedBlock + 1);
        verification.fixSeed(EPOCH);
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.NotPublisher.selector);
        verification.commitPlan(EPOCH, keccak256("plan"), URI);

        vm.prank(verifierA);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
        vm.prank(verifierA);
        verification.commitPlan(EPOCH, keccak256("plan"), URI);
        _accept(EPOCH);
        vm.prank(verifierB);
        verification.commitSlices(EPOCH, keccak256("slices"), URI);
        vm.warp(EPOCH_START + 4 days);
        verification.revealBankKey(EPOCH, BANK_KEY);
        (bytes32 root,,) = _resultsRoot(EPOCH, SAME);
        _attestMajority(EPOCH, root);
        assertEq(verification.epochInfo(EPOCH).finalizedRoot, root);
    }

    function test_takeoverOfAnOpenedEpochRedrawsTheSeed() public {
        _openAndSeed(EPOCH);
        bytes32 oldSeed = verification.epochInfo(EPOCH).seed;
        bytes32 keyHash = _keyHash();
        vm.warp(EPOCH_START + 6 hours);

        address late = address(0xD4);
        verification.setVerifier(late, true);
        vm.prank(late);
        vm.expectRevert(AntseedKbfVerification.NotVerifier.selector);
        verification.takeOverBank(EPOCH, keccak256("late"), keyHash, URI);

        vm.prank(verifierB);
        verification.takeOverBank(EPOCH, keccak256("b bank"), keyHash, URI);
        IAntseedKbfVerification.EpochInfo memory info = verification.epochInfo(EPOCH);
        assertEq(info.seed, bytes32(0), "the seed is bound to the bank");
        assertEq(info.seedBlock, uint64(block.number) + verification.SEED_DELAY_BLOCKS());
        assertEq(info.verifierCount, 3, "the snapshot stays");

        vm.prank(verifierC);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.takeOverBank(EPOCH, keccak256("c bank"), keyHash, URI);
        vm.warp(block.timestamp + 6 hours);
        vm.prank(verifierC);
        verification.takeOverBank(EPOCH, keccak256("c bank"), keyHash, URI);
        assertEq(verification.epochInfo(EPOCH).publisher, verifierC);

        vm.roll(verification.epochInfo(EPOCH).seedBlock + 1);
        verification.fixSeed(EPOCH);
        assertTrue(verification.epochInfo(EPOCH).seed != oldSeed);
        vm.prank(verifierC);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
        vm.prank(verifierC);
        verification.commitPlan(EPOCH, keccak256("plan"), URI);
        _accept(EPOCH);
        vm.warp(block.timestamp + 6 hours);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.takeOverBank(EPOCH, keccak256("a bank"), keyHash, URI);
    }

    function test_takeoverEndsWithTheCollectionWindow() public {
        _commitBank(EPOCH);
        vm.warp(EPOCH_START + 3 days);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.takeOverBank(EPOCH, keccak256("bank"), _keyHash(), URI);
    }

    function test_publisherGraceIsOwnerSet() public {
        verification.setPublisherGraceSeconds(1 hours);
        assertEq(verification.publisherGraceSeconds(), 1 hours);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setPublisherGraceSeconds(0);
        vm.prank(verifierA);
        vm.expectRevert();
        verification.setPublisherGraceSeconds(2 hours);
    }

    function test_keySharesRevealTheKeyWhenThePublisherDisappears() public {
        _commitBank(EPOCH);
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
        verification.openEpoch(EPOCH);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.NotPublisher.selector);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
        vm.prank(publisher);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
        assertEq(verification.epochInfo(EPOCH).keySharesHash, keccak256("shares"));
        vm.roll(verification.epochInfo(EPOCH).seedBlock + 1);
        verification.fixSeed(EPOCH);
        _commitPlan(EPOCH);
        // The publisher disappears here.

        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.revealKeyShare(EPOCH, hex"01aa");
        vm.warp(EPOCH_START + 4 days);
        vm.prank(address(0xBAD));
        vm.expectRevert(AntseedKbfVerification.NotVerifier.selector);
        verification.revealKeyShare(EPOCH, hex"01aa");
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.revealKeyShare(EPOCH, "");

        vm.expectEmit(true, true, false, true);
        emit AntseedKbfVerification.KeyShareRevealed(EPOCH, verifierA, hex"01aa");
        vm.prank(verifierA);
        verification.revealKeyShare(EPOCH, hex"01aa");
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.AlreadyRevealed.selector);
        verification.revealKeyShare(EPOCH, hex"01aa");
        vm.prank(verifierB);
        verification.revealKeyShare(EPOCH, hex"02bb");
        assertTrue(verification.keyShareRevealed(EPOCH, verifierB));

        // Off-chain, anyone combines the shares; the contract only checks the key's hash.
        vm.prank(address(0xBAD));
        verification.revealBankKey(EPOCH, BANK_KEY);
        vm.prank(verifierC);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.revealKeyShare(EPOCH, hex"03cc");

        (bytes32 root,,) = _resultsRoot(EPOCH, SAME);
        _attestMajority(EPOCH, root);
        assertEq(verification.epochInfo(EPOCH).finalizedRoot, root);
    }

    function test_takeoverDropsTheOldKeyShares() public {
        _openAndSeed(EPOCH);
        vm.prank(publisher);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
        vm.warp(EPOCH_START + 6 hours);
        vm.prank(verifierA);
        verification.takeOverBank(EPOCH, keccak256("a bank"), _keyHash(), URI);
        assertEq(verification.epochInfo(EPOCH).keySharesHash, bytes32(0));
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.NotPublisher.selector);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
    }

    function test_planNeedsEscrowedKeySharesWhichThenStayFixed() public {
        _openAndSeed(EPOCH);
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.KeyNotEscrowed.selector);
        verification.commitPlan(EPOCH, keccak256("plan"), URI);

        vm.prank(publisher);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
        vm.prank(publisher);
        verification.commitPlan(EPOCH, keccak256("plan"), URI);
        _accept(EPOCH);
        // Verifiers rely on these shares from here on: the publisher cannot swap them.
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitKeyShares(EPOCH, keccak256("other shares"), URI);
        assertEq(verification.epochInfo(EPOCH).keySharesHash, keccak256("shares"));
    }

    function test_aPlanTakesEffectOnceVerifiersOtherThanThePublisherAcceptIt() public {
        _openAndSeed(EPOCH);
        bytes32 shares = keccak256("shares");
        bytes32 plan = keccak256("plan");
        vm.prank(publisher);
        verification.commitKeyShares(EPOCH, shares, URI);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.acceptPlan(EPOCH, 1, shares, plan);
        vm.prank(publisher);
        verification.commitPlan(EPOCH, plan, URI);
        assertFalse(verification.epochInfo(EPOCH).planActive, "proposed, not in effect");
        assertEq(verification.requiredPlanAcceptances(EPOCH), 2, "the threshold of three verifiers");

        // Nothing runs on a plan that is not in effect.
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitSlices(EPOCH, keccak256("slices"), URI);

        vm.prank(address(0xBAD));
        vm.expectRevert(AntseedKbfVerification.NotVerifier.selector);
        verification.acceptPlan(EPOCH, 1, shares, plan);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.acceptPlan(EPOCH, 1, keccak256("other shares"), plan);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.acceptPlan(EPOCH, 1, shares, keccak256("other plan"));

        vm.expectEmit(true, true, false, true);
        emit AntseedKbfVerification.PlanAccepted(EPOCH, verifierA, 1, shares, plan);
        vm.prank(verifierA);
        verification.acceptPlan(EPOCH, 1, shares, plan);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.AlreadyAccepted.selector);
        verification.acceptPlan(EPOCH, 1, shares, plan);
        assertEq(verification.planAcceptances(EPOCH), 1);
        assertTrue(verification.hasAcceptedPlan(EPOCH, verifierA));

        // A new plan (or new shares) needs accepting again.
        vm.prank(publisher);
        verification.commitPlan(EPOCH, keccak256("new plan"), URI);
        assertEq(verification.planAcceptances(EPOCH), 0);
        assertFalse(verification.hasAcceptedPlan(EPOCH, verifierA));
        vm.prank(verifierB);
        verification.acceptPlan(EPOCH, 1, shares, keccak256("new plan"));
        vm.prank(verifierC);
        vm.expectEmit(true, false, false, true);
        emit AntseedKbfVerification.PlanActivated(EPOCH, keccak256("new plan"));
        verification.acceptPlan(EPOCH, 1, shares, keccak256("new plan"));
        assertTrue(verification.epochInfo(EPOCH).planActive);

        // In effect: final.
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.PlanAlreadyCommitted.selector);
        verification.commitPlan(EPOCH, plan, URI);
        vm.prank(publisher);
        verification.commitPlan(EPOCH, keccak256("new plan"), URI);
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.commitKeyShares(EPOCH, keccak256("late shares"), URI);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.acceptPlan(EPOCH, 1, shares, keccak256("new plan"));
        vm.prank(verifierA);
        verification.commitSlices(EPOCH, keccak256("slices"), URI);
    }

    function test_aTakeoverVerifierCannotFreezeTheRoundWithAPlanNobodyAccepts() public {
        _openAndSeed(EPOCH);
        vm.warp(EPOCH_START + 6 hours);
        // A takes the epoch over, escrows and proposes a plan the others cannot use (unfetchable,
        // malformed, or with bogus shares): nobody accepts it.
        vm.prank(verifierA);
        verification.takeOverBank(EPOCH, keccak256("a bank"), _keyHashOf(0xA11CE), URI);
        vm.roll(verification.epochInfo(EPOCH).seedBlock + 1);
        verification.fixSeed(EPOCH);
        vm.prank(verifierA);
        verification.commitKeyShares(EPOCH, keccak256("bogus shares"), URI);
        vm.prank(verifierA);
        verification.commitPlan(EPOCH, keccak256("unusable plan"), URI);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.NotVerifier.selector);
        verification.acceptPlan(EPOCH, 2, keccak256("bogus shares"), keccak256("unusable plan"));
        assertEq(verification.requiredPlanAcceptances(EPOCH), 2, "two of the other verifiers");
        assertFalse(verification.epochInfo(EPOCH).planActive);

        // With no plan in effect, the honest majority takes the epoch over again and completes it.
        vm.warp(block.timestamp + 6 hours);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.takeOverBank(EPOCH, keccak256("a bank again"), _keyHash(), URI);
        vm.prank(verifierB);
        verification.takeOverBank(EPOCH, keccak256("b bank"), _keyHash(), URI);
        assertEq(verification.epochInfo(EPOCH).planHash, bytes32(0), "the unaccepted plan goes with its bank");
        vm.roll(verification.epochInfo(EPOCH).seedBlock + 1);
        verification.fixSeed(EPOCH);
        // Commitments name the epoch publisher that made them, so A's stay A's after the takeover.
        vm.expectEmit(true, true, false, true);
        emit AntseedKbfVerification.KeySharesCommitted(EPOCH, verifierB, keccak256("b shares"), URI);
        vm.prank(verifierB);
        verification.commitKeyShares(EPOCH, keccak256("b shares"), URI);
        vm.expectEmit(true, true, false, true);
        emit AntseedKbfVerification.PlanCommitted(EPOCH, verifierB, keccak256("plan"), URI);
        vm.prank(verifierB);
        verification.commitPlan(EPOCH, keccak256("plan"), URI);
        _accept(EPOCH);
        assertFalse(verification.hasAcceptedPlan(EPOCH, verifierB));
        vm.warp(EPOCH_START + 4 days);
        verification.revealBankKey(EPOCH, BANK_KEY);
        (bytes32 root,,) = _resultsRoot(EPOCH, SAME);
        _attestMajority(EPOCH, root);
        assertEq(verification.epochInfo(EPOCH).finalizedRoot, root);
    }

    function test_acceptancesDoNotCarryOverToAReplacedBank() public {
        _openAndSeed(EPOCH);
        bytes32 shares = keccak256("shares");
        bytes32 plan = keccak256("plan");
        vm.prank(publisher);
        verification.commitKeyShares(EPOCH, shares, URI);
        vm.prank(publisher);
        verification.commitPlan(EPOCH, plan, URI);
        vm.prank(verifierB);
        verification.acceptPlan(EPOCH, 1, shares, plan);
        assertEq(verification.planAcceptances(EPOCH), 1);

        // A takes the epoch over with another key and re-commits the very same shares and plan
        // hashes: B checked them against the old key, so they need accepting again.
        vm.warp(EPOCH_START + 6 hours);
        vm.prank(verifierA);
        verification.takeOverBank(EPOCH, keccak256("a bank"), _keyHashOf(0xA11CE), URI);
        vm.roll(verification.epochInfo(EPOCH).seedBlock + 1);
        verification.fixSeed(EPOCH);
        vm.prank(verifierA);
        verification.commitKeyShares(EPOCH, shares, URI);
        vm.prank(verifierA);
        verification.commitPlan(EPOCH, plan, URI);
        assertEq(verification.planAcceptances(EPOCH), 0);
        assertFalse(verification.hasAcceptedPlan(EPOCH, verifierB));
        // C checked the first bank's round and its acceptance lands only now: it names generation 1.
        assertEq(verification.epochInfo(EPOCH).bankGeneration, 2);
        vm.prank(verifierC);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.acceptPlan(EPOCH, 1, shares, plan);
        vm.prank(verifierC);
        verification.acceptPlan(EPOCH, 2, shares, plan);
        assertFalse(verification.epochInfo(EPOCH).planActive, "one fresh acceptance of two");
        vm.prank(verifierB);
        verification.acceptPlan(EPOCH, 2, shares, plan);
        assertTrue(verification.epochInfo(EPOCH).planActive);
    }

    function test_aVerifierTakesOneEpochOverAtMostTwiceAndNeverTwiceInARow() public {
        _openAndSeed(EPOCH);
        verification.setPublisherGraceSeconds(1 hours);
        vm.warp(EPOCH_START + 1 hours);
        vm.prank(verifierA);
        verification.takeOverBank(EPOCH, keccak256("a1"), _keyHash(), URI);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.takeOverBank(EPOCH, keccak256("a again"), _keyHash(), URI);
        vm.prank(verifierB);
        verification.takeOverBank(EPOCH, keccak256("b1"), _keyHash(), URI);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(verifierA);
        verification.takeOverBank(EPOCH, keccak256("a2"), _keyHash(), URI);
        assertEq(verification.takeovers(EPOCH, verifierA), 2);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(verifierB);
        verification.takeOverBank(EPOCH, keccak256("b2"), _keyHash(), URI);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.WrongPhase.selector);
        verification.takeOverBank(EPOCH, keccak256("a3"), _keyHash(), URI);
        vm.prank(verifierC);
        verification.takeOverBank(EPOCH, keccak256("c1"), _keyHash(), URI);
    }

    function test_aLoneOtherVerifierIsEnoughWhenThePublisherCouldBlockAnyway() public {
        verification.setVerifier(verifierC, false);
        _openAndSeed(EPOCH);
        vm.warp(EPOCH_START + 6 hours);
        vm.prank(verifierA);
        verification.takeOverBank(EPOCH, keccak256("a bank"), _keyHash(), URI);
        vm.roll(verification.epochInfo(EPOCH).seedBlock + 1);
        verification.fixSeed(EPOCH);
        vm.prank(verifierA);
        verification.commitKeyShares(EPOCH, keccak256("shares"), URI);
        vm.prank(verifierA);
        verification.commitPlan(EPOCH, keccak256("plan"), URI);
        // Threshold 2 of 2, but A must attest for any root to finalize: B's check is all that counts.
        assertEq(verification.requiredPlanAcceptances(EPOCH), 1);
        vm.prank(verifierB);
        verification.acceptPlan(EPOCH, 2, keccak256("shares"), keccak256("plan"));
        assertTrue(verification.epochInfo(EPOCH).planActive);
    }

    function test_theBankKeyMustMatchItsCommittedPoint() public {
        vm.prank(publisher);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.commitBank(EPOCH, keccak256("bank"), keccak256(abi.encode(BANK_KEY)), URI);
        _openAndSeed(EPOCH);
        _commitPlan(EPOCH);
        vm.warp(EPOCH_START + 4 days);
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.revealBankKey(EPOCH, keccak256("another key"));
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.revealBankKey(EPOCH, bytes32(0));
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.revealBankKey(EPOCH, bytes32(type(uint256).max));
        verification.revealBankKey(EPOCH, BANK_KEY);
        assertEq(verification.epochInfo(EPOCH).bankKey, BANK_KEY);
    }

    function testFuzz_keyAddressMatchesTheKeysPoint(uint256 key) public {
        key = bound(key, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.prank(publisher);
        verification.commitBank(EPOCH, keccak256("bank"), _keyHashOf(key), URI);
        verification.openEpoch(EPOCH);
        vm.roll(verification.epochInfo(EPOCH).seedBlock + 1);
        verification.fixSeed(EPOCH);
        _commitPlan(EPOCH);
        vm.warp(EPOCH_START + 4 days);
        verification.revealBankKey(EPOCH, bytes32(key));
    }

    // ── results ──────────────────────────────────────────────────────

    function test_applyRejectsBadProofsAndSkipsRepeats() public {
        (IAntseedKbfVerification.ServiceResult[] memory results, bytes32[] memory leaves) = _finalize(EPOCH, SAME);
        IAntseedKbfVerification.ServiceResult[] memory forged = new IAntseedKbfVerification.ServiceResult[](1);
        forged[0] = _result(agentId, SERVICE_A, MODEL_A, DIFF);
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = TestMerkle.proof(leaves, 0);
        vm.expectRevert(AntseedKbfVerification.InvalidProof.selector);
        verification.applyResults(EPOCH, forged, proofs);

        _apply(EPOCH, results, leaves);
        _apply(EPOCH, results, leaves);
        assertEq(verification.agentStatus(agentId).verifiedCount, 1, "applied once");
    }

    function test_applyNeedsAFinalizedRoot() public {
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](1);
        results[0] = _result(agentId, SERVICE_A, MODEL_A, SAME);
        bytes32[][] memory proofs = new bytes32[][](1);
        vm.expectRevert(AntseedKbfVerification.EpochNotFinalized.selector);
        verification.applyResults(EPOCH, results, proofs);
    }

    function test_unknownAgentsAreSkipped() public {
        _openAndSeed(EPOCH);
        _commitPlan(EPOCH);
        _toReveal(EPOCH);
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](2);
        results[0] = _result(agentId, SERVICE_A, MODEL_A, SAME);
        results[1] = _result(999, SERVICE_A, MODEL_A, DIFF);
        bytes32[] memory leaves = _leaves(EPOCH, results);
        bytes32 root = TestMerkle.root(leaves);
        _attestMajority(EPOCH, root);
        vm.expectEmit(true, true, false, false);
        emit AntseedKbfVerification.UnknownAgentSkipped(999, EPOCH);
        _apply(EPOCH, results, leaves);
        assertTrue(verification.isVerified(agentId));
    }

    function test_lateApplyNeverOverwritesANewerEpoch() public {
        (IAntseedKbfVerification.ServiceResult[] memory oldResults, bytes32[] memory oldLeaves) = _finalize(EPOCH, DIFF);
        _advance();
        gate.setBudget(address(verification), EPOCH + 1, 1_000 ether);
        (IAntseedKbfVerification.ServiceResult[] memory newResults, bytes32[] memory newLeaves) =
            _finalize(EPOCH + 1, SAME);
        _apply(EPOCH + 1, newResults, newLeaves);
        _apply(EPOCH, oldResults, oldLeaves);
        IAntseedKbfVerification.ServiceStatus memory status = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(SAME));
        assertEq(status.epoch, EPOCH + 1);
        assertTrue(verification.isVerified(agentId));
    }

    function test_voidedEpochAppliesAndPaysNothing() public {
        (IAntseedKbfVerification.ServiceResult[] memory results, bytes32[] memory leaves) = _finalize(EPOCH, SAME);
        verification.voidEpoch(EPOCH);
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = TestMerkle.proof(leaves, 0);
        vm.expectRevert(AntseedKbfVerification.EpochVoidedError.selector);
        verification.applyResults(EPOCH, results, proofs);
        _advance();
        assertEq(verification.pendingReward(verifierA, EPOCH, 0, 0, new bytes32[](0)), 0);
    }

    function test_verdictsExpireAndFeedThePointsPolicy() public {
        AntseedKbfVerificationPointsPolicy policy = _pointsPolicy();
        (IAntseedKbfVerification.ServiceResult[] memory results, bytes32[] memory leaves) = _finalize(EPOCH, SAME);
        _apply(EPOCH, results, leaves);
        assertEq(_sellerPoints(policy), 110, "+10% for one verified model");
        _advance();
        assertTrue(verification.isVerified(agentId), "still live in the next epoch");
        _advance();
        assertFalse(verification.isVerified(agentId));
        assertEq(_sellerPoints(policy), 100);
    }

    function test_ownerCanClearAVerdict() public {
        (IAntseedKbfVerification.ServiceResult[] memory results, bytes32[] memory leaves) = _finalize(EPOCH, DIFF);
        _apply(EPOCH, results, leaves);
        assertEq(verification.agentStatus(agentId).diffCount, 1);
        uint256[] memory agents = new uint256[](1);
        bytes32[] memory services = new bytes32[](1);
        agents[0] = agentId;
        services[0] = SERVICE_A;
        verification.clearServiceStatuses(agents, services);
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        assertEq(uint8(verification.serviceStatus(agentId, SERVICE_A).verdict), uint8(NONE));
    }

    function test_clearedServiceIgnoresUnappliedOlderResults() public {
        // Epoch N's DIFF finalizes but nobody applies it; N+1's SAME is applied, then cleared.
        (IAntseedKbfVerification.ServiceResult[] memory oldResults, bytes32[] memory oldLeaves) = _finalize(EPOCH, DIFF);
        _advance();
        gate.setBudget(address(verification), EPOCH + 1, 1_000 ether);
        (IAntseedKbfVerification.ServiceResult[] memory newResults, bytes32[] memory newLeaves) =
            _finalize(EPOCH + 1, SAME);
        _apply(EPOCH + 1, newResults, newLeaves);
        _clear(agentId, SERVICE_A);
        assertEq(verification.serviceResultsFrom(agentId, SERVICE_A), EPOCH + 2);

        // The unused older proof must not bring the DIFF back.
        vm.expectEmit(true, true, true, true);
        emit AntseedKbfVerification.ClearedResultSkipped(agentId, SERVICE_A, EPOCH);
        _apply(EPOCH, oldResults, oldLeaves);
        IAntseedKbfVerification.ServiceStatus memory status = verification.serviceStatus(agentId, SERVICE_A);
        assertEq(uint8(status.verdict), uint8(NONE));
        assertEq(verification.agentStatus(agentId).diffCount, 0);

        // Results after the clearing epoch apply as usual.
        _advance();
        gate.setBudget(address(verification), EPOCH + 2, 1_000 ether);
        (IAntseedKbfVerification.ServiceResult[] memory later, bytes32[] memory laterLeaves) = _finalize(EPOCH + 2, SAME);
        _apply(EPOCH + 2, later, laterLeaves);
        assertTrue(verification.isVerified(agentId));
    }

    function test_undeterminedCountsAsNeither() public {
        (IAntseedKbfVerification.ServiceResult[] memory results, bytes32[] memory leaves) =
            _finalize(EPOCH, UNDETERMINED);
        _apply(EPOCH, results, leaves);
        IAntseedKbfVerification.AgentStatus memory status = verification.agentStatus(agentId);
        assertEq(status.verifiedCount, 0);
        assertEq(status.diffCount, 0);
    }

    // ── rewards ──────────────────────────────────────────────────────

    function test_rewardsSplitAttestersAndCollectors() public {
        verification.setMaxVerifierShareBps(10_000);
        (bytes32[] memory leaves,) = _finalizeWithCredits(EPOCH);
        _advance();
        // Budget 1000: attester pool 200 shared by A and B; collector pool 800 split 3:1 between A and C.
        uint256 a = _claim(verifierA, 3, 4, TestMerkle.proof(leaves, 1));
        uint256 b = _claim(verifierB, 0, 0, new bytes32[](0));
        uint256 c = _claim(verifierC, 1, 4, TestMerkle.proof(leaves, 2));
        assertEq(a, 100 ether + 600 ether);
        assertEq(b, 100 ether);
        assertEq(c, 200 ether, "C attested another root, so only its slices pay");
        assertEq(gate.minted(verifierA), a);
    }

    function test_rewardsAreCappedPerVerifier() public {
        (bytes32[] memory leaves,) = _finalizeWithCredits(EPOCH);
        _advance();
        assertEq(_claim(verifierA, 3, 4, TestMerkle.proof(leaves, 1)), 200 ether, "20% cap");
    }

    function test_rewardsNeedAValidCreditProofAndPayOnce() public {
        verification.setMaxVerifierShareBps(10_000);
        (bytes32[] memory leaves,) = _finalizeWithCredits(EPOCH);
        bytes32[] memory proof = TestMerkle.proof(leaves, 1);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.EpochNotFinalized.selector);
        verification.claimRewards(EPOCH, 3, 4, proof);
        _advance();
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.InvalidProof.selector);
        verification.claimRewards(EPOCH, 4, 4, proof);
        _claim(verifierA, 3, 4, proof);
        vm.prank(verifierA);
        vm.expectRevert(AntseedKbfVerification.AlreadyClaimed.selector);
        verification.claimRewards(EPOCH, 3, 4, proof);
    }

    function test_rewardSplitIsFixedWhenTheEpochOpens() public {
        verification.setMaxVerifierShareBps(10_000);
        (bytes32[] memory leaves,) = _finalizeWithCredits(EPOCH);
        _advance();
        uint256 a = _claim(verifierA, 3, 4, TestMerkle.proof(leaves, 1));
        // Changing the split after collectors claimed must not raise later entitlements.
        verification.setAttestRewardBps(10_000);
        verification.setMaxVerifierShareBps(1_000);
        assertEq(verification.pendingReward(verifierB, EPOCH, 0, 0, new bytes32[](0)), 100 ether);
        uint256 b = _claim(verifierB, 0, 0, new bytes32[](0));
        uint256 c = _claim(verifierC, 1, 4, TestMerkle.proof(leaves, 2));
        assertEq(a, 700 ether);
        assertEq(b, 100 ether);
        assertEq(c, 200 ether);
        assertLe(a + b + c, 1_000 ether, "never more than the budget");
    }

    function test_noRewardsBeforeTheStartEpoch() public {
        verification.setRewardsStartEpoch(EPOCH + 1);
        (bytes32[] memory leaves,) = _finalizeWithCredits(EPOCH);
        _advance();
        assertEq(verification.pendingReward(verifierA, EPOCH, 3, 4, TestMerkle.proof(leaves, 1)), 0);
    }

    function test_turningRewardsOffKeepsEarnedRewardsClaimable() public {
        verification.setMaxVerifierShareBps(10_000);
        (bytes32[] memory leaves,) = _finalizeWithCredits(EPOCH);
        // Rewards off for new epochs, before anyone claimed the finished one.
        verification.setRewardsStartEpoch(type(uint256).max);
        _advance();
        assertEq(verification.pendingReward(verifierB, EPOCH, 0, 0, new bytes32[](0)), 100 ether);
        assertEq(_claim(verifierA, 3, 4, TestMerkle.proof(leaves, 1)), 700 ether);
        // Moving the start later (a restart) does not take earned rewards back either.
        verification.setRewardsStartEpoch(EPOCH + 5);
        assertEq(_claim(verifierB, 0, 0, new bytes32[](0)), 100 ether);
    }

    // ── admin ────────────────────────────────────────────────────────

    function test_modelListIsValidatedAndVersioned() public {
        IAntseedKbfVerification.Model[] memory list = new IAntseedKbfVerification.Model[](1);
        list[0] = IAntseedKbfVerification.Model({modelHash: keccak256("other"), service: MODEL_A_ID});
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setModels(list);

        IAntseedKbfVerification.Model[] memory dup = new IAntseedKbfVerification.Model[](2);
        dup[0] = IAntseedKbfVerification.Model({modelHash: MODEL_A, service: MODEL_A_ID});
        dup[1] = dup[0];
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setModels(dup);

        list[0] = IAntseedKbfVerification.Model({modelHash: MODEL_B, service: MODEL_B_ID});
        verification.setModels(list);
        assertEq(verification.modelsVersion(), 2);
        assertEq(verification.models(1).length, 2);
        assertEq(verification.models(2)[0].service, MODEL_B_ID);
    }

    function test_scheduleMustFitTheEpoch() public {
        IAntseedKbfVerification.Schedule memory schedule = verification.schedule();
        schedule.collectSeconds = 6 days;
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setSchedule(schedule);
        schedule.collectSeconds = 2 days;
        schedule.slicesPerService = 0;
        vm.expectRevert(AntseedKbfVerification.InvalidValue.selector);
        verification.setSchedule(schedule);
    }

    function test_onlyVerifiersSetEncryptionKeys() public {
        vm.expectRevert(AntseedKbfVerification.NotVerifier.selector);
        verification.setEncryptionKey(keccak256("key"));
        vm.prank(verifierA);
        verification.setEncryptionKey(keccak256("key"));
        assertEq(verification.encryptionKeys(verifierA), keccak256("key"));
    }

    function test_verifierSetAddsAndRemoves() public {
        verification.setVerifier(verifierA, false);
        address[] memory set = verification.verifiers();
        assertEq(set.length, 2);
        assertFalse(verification.isVerifier(verifierA));
        verification.setVerifier(verifierA, true);
        verification.setVerifier(verifierA, true);
        assertEq(verification.verifiers().length, 3);
    }

    function test_adminIsOwnerOnly() public {
        vm.startPrank(verifierA);
        vm.expectRevert();
        verification.setVerifier(verifierA, true);
        vm.expectRevert();
        verification.setPublisher(verifierA);
        vm.expectRevert();
        verification.voidEpoch(EPOCH);
        vm.stopPrank();
    }

    // ── invariants ───────────────────────────────────────────────────

    /// @dev Live counts, `isVerified` and seller points always match what the stored service
    ///      statuses imply, across verdict changes, model changes, late applies of older epochs,
    ///      expiry, clearing and validity-window changes.
    function testFuzz_liveCountsMatchServiceStatusesAcrossEpochs(uint8[32] calldata steps) public {
        AntseedKbfVerificationPointsPolicy policy = _pointsPolicy();
        policy.setPenaltyBps(1_000);
        bytes32[3] memory services = [SERVICE_A, SERVICE_B, bytes32(uint256(3))];
        for (uint256 i = 0; i < steps.length; i++) {
            uint8 step = steps[i];
            uint256 serviceIndex = (step >> 3) % 3;
            uint256 current = gate.currentEpoch();
            if (step % 7 == 0) {
                _advance();
            } else if (step % 7 == 1) {
                _clear(agentId, services[serviceIndex]);
            } else if (step % 7 == 2) {
                verification.setValidityEpochs(uint8(1 + (step >> 5) % 4));
            } else {
                // Step 3 applies a result of the previous epoch late, when that epoch finalized.
                uint256 epoch = step % 7 == 3 && _allFinalized[current - 1] ? current - 1 : current;
                if (!_allFinalized[epoch]) _finalizeAll(epoch);
                uint256 index = serviceIndex * 9 + ((step >> 5) % 3) * 3 + step % 3;
                _applyOne(epoch, index);
            }
            _assertCountsMatch(policy, services);
        }
    }

    function test_lateApplyOfAnExpiredEpochCountsNothing() public {
        AntseedKbfVerificationPointsPolicy policy = _pointsPolicy();
        policy.setPenaltyBps(1_000);
        bytes32[3] memory services = [SERVICE_A, SERVICE_B, bytes32(uint256(3))];
        _finalizeAll(EPOCH);
        _applyOne(EPOCH, 0 * 9 + 0 * 3 + 0); // SERVICE_A SAME
        _advance();
        _advance();
        _applyOne(EPOCH, 1 * 9 + 1 * 3 + 1); // SERVICE_B DIFF, already expired
        _assertCountsMatch(policy, services);
        assertEq(verification.agentStatus(agentId).diffCount, 0);
        verification.setValidityEpochs(3);
        _assertCountsMatch(policy, services);
        assertEq(verification.agentStatus(agentId).diffCount, 1, "a longer window revives it");
        _clear(agentId, SERVICE_B);
        _clear(agentId, SERVICE_B);
        _assertCountsMatch(policy, services);
    }

    // ── helpers ──────────────────────────────────────────────────────

    /// @dev Finalizes `epoch` with one leaf per (service, model, verdict): 3 x 3 x 3.
    function _finalizeAll(uint256 epoch) private {
        bytes32[3] memory services = [SERVICE_A, SERVICE_B, bytes32(uint256(3))];
        bytes32[3] memory modelHashes = [MODEL_A, MODEL_B, keccak256("model-c")];
        IAntseedKbfVerification.Verdict[3] memory verdicts = [SAME, DIFF, UNDETERMINED];
        bytes32[] memory leaves = new bytes32[](27);
        for (uint256 s = 0; s < 3; s++) {
            for (uint256 m = 0; m < 3; m++) {
                for (uint256 v = 0; v < 3; v++) {
                    leaves[s * 9 + m * 3 + v] = this.leafOf(epoch, _result(agentId, services[s], modelHashes[m], verdicts[v]));
                }
            }
        }
        _allLeaves[epoch] = leaves;
        uint256 time = block.timestamp;
        _openAndSeed(epoch);
        _commitPlan(epoch);
        _toReveal(epoch);
        _attestMajority(epoch, TestMerkle.root(leaves));
        _allFinalized[epoch] = true;
        if (time > block.timestamp) vm.warp(time);
    }

    function _applyOne(uint256 epoch, uint256 index) private {
        bytes32[3] memory services = [SERVICE_A, SERVICE_B, bytes32(uint256(3))];
        bytes32[3] memory modelHashes = [MODEL_A, MODEL_B, keccak256("model-c")];
        IAntseedKbfVerification.Verdict[3] memory verdicts = [SAME, DIFF, UNDETERMINED];
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](1);
        results[0] = _result(agentId, services[index / 9], modelHashes[(index / 3) % 3], verdicts[index % 3]);
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = TestMerkle.proof(_allLeaves[epoch], index);
        verification.applyResults(epoch, results, proofs);
    }

    function _assertCountsMatch(AntseedKbfVerificationPointsPolicy policy, bytes32[3] memory services) private view {
        uint256 current = gate.currentEpoch();
        uint256 window = verification.validityEpochs();
        uint256 verified;
        uint256 diffs;
        for (uint256 j = 0; j < services.length; j++) {
            IAntseedKbfVerification.ServiceStatus memory status = verification.serviceStatus(agentId, services[j]);
            if (status.verdict == NONE || current >= status.epoch + window) continue;
            if (status.verdict == SAME) verified += 1;
            else if (status.verdict == DIFF) diffs += 1;
        }
        IAntseedKbfVerification.AgentStatus memory agent = verification.agentStatus(agentId);
        assertEq(agent.verifiedCount, verified, "verified count");
        assertEq(agent.diffCount, diffs, "diff count");
        assertEq(verification.isVerified(agentId), verified > 0 && diffs == 0);
        uint256 multiplier = 100 + 10 * verified;
        assertEq(_sellerPoints(policy), multiplier > 10 * diffs ? multiplier - 10 * diffs : 0, "seller points");
    }

    function _clear(uint256 agent, bytes32 service) private {
        uint256[] memory agents = new uint256[](1);
        bytes32[] memory services = new bytes32[](1);
        agents[0] = agent;
        services[0] = service;
        verification.clearServiceStatuses(agents, services);
    }

    function _models() private pure returns (IAntseedKbfVerification.Model[] memory list) {
        list = new IAntseedKbfVerification.Model[](2);
        list[0] = IAntseedKbfVerification.Model({modelHash: MODEL_A, service: MODEL_A_ID});
        list[1] = IAntseedKbfVerification.Model({modelHash: MODEL_B, service: MODEL_B_ID});
    }

    function _commitBank(uint256 epoch) private {
        vm.prank(publisher);
        verification.commitBank(epoch, keccak256(abi.encode("bank", epoch)), _keyHash(), URI);
    }

    function _openAndSeed(uint256 epoch) private {
        _commitBank(epoch);
        verification.openEpoch(epoch);
        vm.roll(verification.epochInfo(epoch).seedBlock + 1);
        verification.fixSeed(epoch);
    }

    function _commitPlan(uint256 epoch) private {
        if (verification.epochInfo(epoch).keySharesHash == bytes32(0)) {
            vm.prank(publisher);
            verification.commitKeyShares(epoch, keccak256(abi.encode("shares", epoch)), URI);
        }
        vm.prank(publisher);
        verification.commitPlan(epoch, keccak256(abi.encode("plan", epoch)), URI);
        _accept(epoch);
    }

    /// @dev Snapshot verifiers other than the epoch publisher accept the current plan until it is in effect.
    function _accept(uint256 epoch) private {
        address[] memory members = verification.epochVerifiers(epoch);
        for (uint256 i = 0; i < members.length; i++) {
            IAntseedKbfVerification.EpochInfo memory info = verification.epochInfo(epoch);
            if (info.planActive) return;
            if (members[i] == info.publisher || verification.hasAcceptedPlan(epoch, members[i])) continue;
            vm.prank(members[i]);
            verification.acceptPlan(epoch, info.bankGeneration, info.keySharesHash, info.planHash);
        }
        assertTrue(verification.epochInfo(epoch).planActive, "the plan is in effect");
    }

    /// @dev The committed form of `BANK_KEY`: the address of `BANK_KEY·G`, left-padded.
    function _keyHash() private pure returns (bytes32) {
        return _keyHashOf(uint256(BANK_KEY));
    }

    function _keyHashOf(uint256 key) private pure returns (bytes32) {
        return bytes32(uint256(uint160(vm.addr(key))));
    }

    function _toReveal(uint256 epoch) private {
        vm.warp(_start(epoch) + 4 days);
        verification.revealBankKey(epoch, BANK_KEY);
    }

    function _start(uint256 epoch) private pure returns (uint256) {
        return EPOCH_START + (epoch - EPOCH) * 7 days;
    }

    function _result(uint256 id, bytes32 service, bytes32 model, IAntseedKbfVerification.Verdict verdict)
        private
        pure
        returns (IAntseedKbfVerification.ServiceResult memory)
    {
        return IAntseedKbfVerification.ServiceResult({agentId: id, serviceHash: service, modelHash: model, verdict: verdict});
    }

    function _leaves(uint256 epoch, IAntseedKbfVerification.ServiceResult[] memory results)
        private
        view
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](results.length);
        for (uint256 i = 0; i < results.length; i++) {
            leaves[i] = this.leafOf(epoch, results[i]);
        }
    }

    /// @dev External so the calldata-typed `serviceLeaf` can be called with memory results.
    function leafOf(uint256 epoch, IAntseedKbfVerification.ServiceResult calldata result)
        external
        view
        returns (bytes32)
    {
        return verification.serviceLeaf(epoch, result);
    }

    function _resultsRoot(uint256 epoch, IAntseedKbfVerification.Verdict verdict)
        private
        view
        returns (bytes32 root, bytes32[] memory leaves, IAntseedKbfVerification.ServiceResult[] memory results)
    {
        results = new IAntseedKbfVerification.ServiceResult[](1);
        results[0] = _result(agentId, SERVICE_A, MODEL_A, verdict);
        leaves = _leaves(epoch, results);
        root = TestMerkle.root(leaves);
    }

    function _attestMajority(uint256 epoch, bytes32 root) private {
        vm.prank(verifierA);
        verification.attest(epoch, root, URI);
        vm.prank(verifierB);
        verification.attest(epoch, root, URI);
    }

    function _finalize(uint256 epoch, IAntseedKbfVerification.Verdict verdict)
        private
        returns (IAntseedKbfVerification.ServiceResult[] memory results, bytes32[] memory leaves)
    {
        _openAndSeed(epoch);
        _commitPlan(epoch);
        _toReveal(epoch);
        bytes32 root;
        (root, leaves, results) = _resultsRoot(epoch, verdict);
        _attestMajority(epoch, root);
    }

    /// @dev Root with one service result and collector credits A=3, C=1 of 4. A and B attest it,
    ///      C attests something else.
    function _finalizeWithCredits(uint256 epoch) private returns (bytes32[] memory leaves, bytes32 root) {
        _openAndSeed(epoch);
        _commitPlan(epoch);
        _toReveal(epoch);
        IAntseedKbfVerification.ServiceResult[] memory results = new IAntseedKbfVerification.ServiceResult[](1);
        results[0] = _result(agentId, SERVICE_A, MODEL_A, SAME);
        leaves = new bytes32[](3);
        leaves[0] = this.leafOf(epoch, results[0]);
        leaves[1] = verification.collectorLeaf(epoch, verifierA, 3, 4);
        leaves[2] = verification.collectorLeaf(epoch, verifierC, 1, 4);
        root = TestMerkle.root(leaves);
        _attestMajority(epoch, root);
        vm.prank(verifierC);
        verification.attest(epoch, keccak256("other root"), URI);
    }

    function _apply(uint256 epoch, IAntseedKbfVerification.ServiceResult[] memory results, bytes32[] memory leaves)
        private
    {
        bytes32[][] memory proofs = new bytes32[][](results.length);
        for (uint256 i = 0; i < results.length; i++) {
            proofs[i] = TestMerkle.proof(leaves, i);
        }
        verification.applyResults(epoch, results, proofs);
    }

    function _claim(address verifier, uint32 slices, uint32 total, bytes32[] memory proof) private returns (uint256) {
        vm.prank(verifier);
        return verification.claimRewards(EPOCH, slices, total, proof);
    }

    /// @dev Moves to the next epoch and its start time.
    function _advance() private {
        uint256 next = gate.currentEpoch() + 1;
        gate.setCurrentEpoch(next);
        vm.warp(_start(next) + 1 hours);
    }

    function _pointsPolicy() private returns (AntseedKbfVerificationPointsPolicy policy) {
        pools.setSeller(seller, agentId);
        policy = new AntseedKbfVerificationPointsPolicy(
            address(verification), address(new VerificationPointsAccounting(address(pools))), 1_000, address(this)
        );
    }

    function _sellerPoints(AntseedKbfVerificationPointsPolicy policy) private view returns (uint256 points) {
        (points,) = policy.points(bytes32(0), address(0x123), seller, 100, 100);
    }
}
