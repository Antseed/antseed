// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { AntseedFreeTierTerms } from "../../sellers/AntseedFreeTierTerms.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import {
    FreeTierTermsBuilder as B,
    FreeTierGateMock,
    FreeTierSellerRegistryMock,
    FreeTierOperatorOwner,
    FreeTierGasBurnerOwner,
    FreeTierLongReturnOwner,
    FreeTierHugeReturnOwner,
    FreeTierShortReturnOwner,
    FreeTierRevertingOwner,
    FreeTierWrongTypeOwner
} from "./FreeTierFixtures.sol";

contract AntseedFreeTierTermsTest is Test {
    FreeTierGateMock gate;
    FreeTierSellerRegistryMock sellers;
    MockERC8004Registry identity;
    AntseedFreeTierTerms board;

    uint256 constant AGENT = 7;
    address seller = address(0x5E11E7);
    address owner = address(0x0A11E7);
    bytes32 model = keccak256("example/free-model");

    function setUp() public {
        gate = new FreeTierGateMock();
        gate.setCurrentEpoch(10);
        sellers = new FreeTierSellerRegistryMock();
        identity = new MockERC8004Registry();
        AntseedRegistry registry = new AntseedRegistry();
        registry.setStaking(address(sellers));
        board = new AntseedFreeTierTerms(address(registry), address(gate), address(identity));
        sellers.setAgent(seller, AGENT);
        identity.setOwner(AGENT, owner);
    }

    // ─── Start rules ─────────────────────────────────────────────────

    function test_aFirstPromiseStartsNextEpoch() public {
        AntseedFreeTierTerms.Terms memory terms = B.simple(5, model);
        vm.expectEmit(address(board));
        emit AntseedFreeTierTerms.TermsScheduled(AGENT, 11, keccak256(abi.encode(terms)), seller, terms);
        assertEq(_set(terms), 11);
        (bool promised,) = board.promisedThrough(AGENT);
        assertFalse(promised, "nothing active yet");
        (uint256 fromEpoch,,) = board.termsAt(AGENT, 10);
        assertEq(fromEpoch, 0, "no terms before the start");
        gate.setCurrentEpoch(11);
        uint256 through;
        (promised, through) = board.promisedThrough(AGENT);
        assertTrue(promised);
        assertEq(through, 15, "current + notice - 1");
    }

    function test_aPendingFirstEntrySetsTheNoticeOfTheNextWrite() public {
        _set(B.simple(4, model)); // from 11, pending
        assertEq(_set(B.simple(2, keccak256("other"))), 14, "10 + the pending entry's notice (4)");
        (, bytes32 hash,) = board.termsAt(AGENT, 13);
        assertEq(hash, keccak256(abi.encode(B.simple(4, model))));
        assertEq(board.scheduleLength(AGENT), 2);
    }

    function test_anEmptyFirstEntryStillCountsAsHistory() public {
        assertEq(_set(B.empty(3)), 11);
        gate.setCurrentEpoch(11);
        (bool promised,) = board.promisedThrough(AGENT);
        assertFalse(promised, "no programs, no promise");
        assertEq(board.entryAt(AGENT, 0).programCount, 0);
        assertEq(_set(B.simple(2, model)), 14, "not a first promise any more");
    }

    function test_aLongNoticeTailAfterAShortEarlierNotice() public {
        _set(B.simple(2, model)); // A from 11, notice 2
        gate.setCurrentEpoch(11);
        assertEq(_set(B.simple(10, keccak256("b"))), 13, "B: 11 + A's notice");
        gate.setCurrentEpoch(12);
        assertEq(_set(B.simple(3, keccak256("c"))), 14, "still A's notice: appended after B");
        gate.setCurrentEpoch(13);
        assertEq(_set(B.simple(3, keccak256("d"))), 23, "B (notice 10) is active now");
        assertEq(board.scheduleLength(AGENT), 4);
    }

    function test_anEqualStartReplacesTheTail() public {
        _set(B.simple(2, model));
        gate.setCurrentEpoch(11);
        uint256 first = _set(B.simple(2, keccak256("b")));
        AntseedFreeTierTerms.Terms memory replacement = B.simple(2, keccak256("c"));
        assertEq(_set(replacement), first);
        assertEq(board.scheduleLength(AGENT), 2, "replaced, not appended");
        (, bytes32 hash,) = board.termsAt(AGENT, first);
        assertEq(hash, keccak256(abi.encode(replacement)));
    }

    function test_theActiveNoticeSetsTheStartAndTheViewsFollow() public {
        _set(B.simple(6, model));
        gate.setCurrentEpoch(20);
        assertEq(_set(B.simple(2, keccak256("b"))), 26);
        (bool promised, uint256 through) = board.promisedThrough(AGENT);
        assertTrue(promised);
        assertEq(through, 25, "the earliest pending change, minus one");
        (bool exists, uint256 fromEpoch, bytes32 hash) = board.nextChangeAfter(AGENT, 20);
        assertTrue(exists);
        assertEq(fromEpoch, 26);
        assertEq(hash, keccak256(abi.encode(B.simple(2, keccak256("b")))));
        (exists,,) = board.nextChangeAfter(AGENT, 26);
        assertFalse(exists);
        (exists, fromEpoch,) = board.nextChangeAfter(AGENT, 5);
        assertEq(fromEpoch, 11, "the first entry for an epoch before it");
    }

    function test_aStartLaterThanTheWriterAgreedToReverts() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(AntseedFreeTierTerms.StartsTooLate.selector, 11));
        board.setTerms(AGENT, B.simple(2, model), 10);
        vm.prank(seller);
        assertEq(board.setTerms(AGENT, B.simple(2, model), 11), 11);
    }

    function test_termsAtReturnsTheStoredTermsAndProgramForFindsTheModel() public {
        AntseedFreeTierTerms.Terms memory terms = B.simple(2, model);
        _set(terms);
        (uint256 fromEpoch, bytes32 hash, AntseedFreeTierTerms.Terms memory stored) = board.termsAt(AGENT, 50);
        assertEq(fromEpoch, 11);
        assertEq(keccak256(abi.encode(stored)), hash);
        assertEq(hash, keccak256(abi.encode(terms)));
        (bool found, AntseedFreeTierTerms.Program memory program, uint8 kind) = board.programFor(AGENT, 11, model);
        assertTrue(found);
        assertEq(kind, 1);
        assertEq(program.tiers[1].requests, 50);
        (found,,) = board.programFor(AGENT, 10, model);
        assertFalse(found, "before the start");
        (found,,) = board.programFor(AGENT, 11, keccak256("other"));
        assertFalse(found);
    }

    // ─── Writers ─────────────────────────────────────────────────────

    function test_theSellerTheOwnerAndAnOperatorCanWrite() public {
        vm.prank(seller);
        board.setTerms(AGENT, B.simple(2, model), type(uint256).max);
        vm.prank(owner);
        board.setTerms(AGENT, B.simple(2, model), type(uint256).max);

        FreeTierOperatorOwner proxy = new FreeTierOperatorOwner();
        address operator = address(0x0BE7);
        proxy.setOperator(operator, true);
        identity.setOwner(AGENT, address(proxy));
        vm.prank(operator);
        board.setTerms(AGENT, B.simple(2, model), type(uint256).max);
        proxy.setOperator(operator, false);
        vm.prank(operator);
        vm.expectRevert(AntseedFreeTierTerms.NotWriter.selector);
        board.setTerms(AGENT, B.simple(2, model), type(uint256).max);
    }

    function test_strangersAndAgentZeroCannotWrite() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(AntseedFreeTierTerms.NotWriter.selector);
        board.setTerms(AGENT, B.simple(2, model), type(uint256).max);
        vm.prank(seller);
        vm.expectRevert(AntseedFreeTierTerms.InvalidAgent.selector);
        board.setTerms(0, B.simple(2, model), type(uint256).max);
        vm.expectRevert(AntseedFreeTierTerms.InvalidAgent.selector);
        board.isWriter(0, seller);
        assertFalse(board.isWriter(99, address(0xBAD)), "an agent nobody owns");
    }

    function test_hostileOwnerContractsFailClosed() public {
        address[6] memory hostile = [
            address(new FreeTierGasBurnerOwner()),
            address(new FreeTierLongReturnOwner()),
            address(new FreeTierHugeReturnOwner()),
            address(new FreeTierShortReturnOwner()),
            address(new FreeTierRevertingOwner()),
            address(new FreeTierWrongTypeOwner())
        ];
        for (uint256 i = 0; i < hostile.length; ++i) {
            identity.setOwner(AGENT, hostile[i]);
            assertFalse(board.isWriter(AGENT, address(0x0BE7)), "fails closed");
            vm.prank(address(0x0BE7));
            vm.expectRevert(AntseedFreeTierTerms.NotWriter.selector);
            board.setTerms{ gas: 2_000_000 }(AGENT, B.simple(2, model), type(uint256).max);
            assertTrue(board.isWriter(AGENT, seller), "the registered seller still writes");
        }
    }

    // ─── Bounds ──────────────────────────────────────────────────────

    function test_everyBoundIsEnforced() public {
        AntseedFreeTierTerms.Terms memory t = B.simple(1, model);
        _expectInvalid(t, 1);
        t.noticeEpochs = 105;
        _expectInvalid(t, 1);

        t = B.simple(2, model);
        t.programs = new AntseedFreeTierTerms.Program[](17);
        for (uint256 i = 0; i < 17; ++i) {
            bytes32 scope = bytes32(i + 1);
            t.programs[i] = B.program(scope, B.one(scope), 1, 1);
        }
        _expectInvalid(t, 2);

        (bytes32 a, bytes32 b) = (bytes32(uint256(1)), bytes32(uint256(2)));
        t.programs = new AntseedFreeTierTerms.Program[](2);
        t.programs[0] = B.program(b, B.one(b), 1, 1);
        t.programs[1] = B.program(a, B.one(a), 1, 1);
        _expectInvalid(t, 3);
        t.programs[1] = B.program(b, B.one(b), 1, 1);
        _expectInvalid(t, 3);

        t = B.simple(2, model);
        t.programs[0].windowSecs = 59;
        _expectInvalid(t, 4);
        t.programs[0].windowSecs = 30 days + 1;
        _expectInvalid(t, 4);

        t = B.simple(2, model);
        t.programs[0].models = new AntseedFreeTierTerms.Model[](0);
        _expectInvalid(t, 5);
        t.programs[0].models = new AntseedFreeTierTerms.Model[](33);
        for (uint256 i = 0; i < 33; ++i) {
            t.programs[0].models[i] = AntseedFreeTierTerms.Model(bytes32(i + 1), 1);
        }
        _expectInvalid(t, 5);
        t.programs[0].models = new AntseedFreeTierTerms.Model[](2);
        t.programs[0].models[0] = AntseedFreeTierTerms.Model(b, 1);
        t.programs[0].models[1] = AntseedFreeTierTerms.Model(a, 1);
        _expectInvalid(t, 6);
        t.programs[0].models[0] = AntseedFreeTierTerms.Model(bytes32(0), 1);
        t.programs[0].models[1] = AntseedFreeTierTerms.Model(a, 1);
        _expectInvalid(t, 6);
        t.programs[0].models = new AntseedFreeTierTerms.Model[](1);
        t.programs[0].models[0] = AntseedFreeTierTerms.Model(a, 3);
        _expectInvalid(t, 7);
        t.programs[0].models[0] = AntseedFreeTierTerms.Model(a, 0);
        _expectInvalid(t, 7);

        // A model's own program lists exactly that model, and the seller-wide one does not.
        t = B.simple(2, model);
        t.programs[0] = B.program(a, B.one(b), 1, 1);
        _expectInvalid(t, 8);
        t.programs = new AntseedFreeTierTerms.Program[](2);
        t.programs[0] = B.program(bytes32(0), B.one(a), 1, 1);
        t.programs[1] = B.program(a, B.one(a), 1, 1);
        _expectInvalid(t, 9);

        t = B.simple(2, model);
        t.programs[0].tiers = new AntseedFreeTierTerms.Tier[](0);
        _expectInvalid(t, 10);
        t.programs[0].tiers = new AntseedFreeTierTerms.Tier[](5);
        for (uint256 i = 0; i < 5; ++i) {
            t.programs[0].tiers[i] = AntseedFreeTierTerms.Tier(uint64(i + 1), uint32(i + 1));
        }
        _expectInvalid(t, 10);
        t = B.simple(2, model);
        t.programs[0].tiers[0].minPowerAnts = 0;
        _expectInvalid(t, 11);
        t = B.simple(2, model);
        t.programs[0].tiers[1].minPowerAnts = 2 ** 53;
        _expectInvalid(t, 11);
        t = B.simple(2, model);
        t.programs[0].tiers[0].requests = 0;
        _expectInvalid(t, 12);
        t = B.simple(2, model);
        t.programs[0].tiers[1].requests = 2 ** 31 + 1;
        _expectInvalid(t, 12);
        t = B.simple(2, model);
        t.programs[0].tiers[0].requests = type(uint32).max;
        _expectInvalid(t, 13);
        t = B.simple(2, model);
        t.programs[0].tiers[1].minPowerAnts = 10;
        _expectInvalid(t, 14);
        t = B.simple(2, model);
        t.programs[0].tiers[1].requests = 5;
        _expectInvalid(t, 14);
    }

    function test_theLargestTermsAreAcceptedAndStored() public {
        AntseedFreeTierTerms.Terms memory t;
        t.noticeEpochs = 104;
        t.programs = new AntseedFreeTierTerms.Program[](16);
        bytes32[] memory models = new bytes32[](32);
        for (uint256 i = 0; i < 32; ++i) {
            models[i] = bytes32(i + 1);
        }
        t.programs[0] = _fourTiers(B.program(bytes32(0), models, 1, 1));
        for (uint256 i = 1; i < 16; ++i) {
            bytes32 scope = bytes32(1_000 + i);
            t.programs[i] = _fourTiers(B.program(scope, B.one(scope), 1, 1));
        }
        vm.prank(seller);
        vm.startSnapshotGas("free-tier-terms", "set-terms-16-programs-47-models-4-tiers");
        board.setTerms(AGENT, t, type(uint256).max);
        vm.stopSnapshotGas();
        (, bytes32 hash, AntseedFreeTierTerms.Terms memory stored) = board.termsAt(AGENT, 11);
        assertEq(hash, keccak256(abi.encode(t)));
        assertEq(stored.programs.length, 16);
    }

    function test_aSmallPromiseGas() public {
        vm.prank(seller);
        vm.startSnapshotGas("free-tier-terms", "set-terms-1-program-1-model-2-tiers");
        board.setTerms(AGENT, B.simple(2, model), type(uint256).max);
        vm.stopSnapshotGas();
    }

    // ─── Shared vectors ──────────────────────────────────────────────

    /// @notice The vectors from `packages/protocol/src/free-tier-terms.test.ts`: the same encoding,
    ///         hash, bounds and lookup in both languages.
    function test_sharedVectors() public {
        string memory json = vm.readFile("test/vectors/free-tier-terms.json");
        uint256 count = vm.parseJsonUint(json, ".termsCount");
        assertGt(count, 20);
        for (uint256 i = 0; i < count; ++i) {
            string memory key = string.concat(".terms[", vm.toString(i), "]");
            bytes memory encoded = vm.parseJsonBytes(json, string.concat(key, ".hex"));
            assertEq(keccak256(encoded), vm.parseJsonBytes32(json, string.concat(key, ".hash")));
            AntseedFreeTierTerms.Terms memory terms = abi.decode(encoded, (AntseedFreeTierTerms.Terms));
            assertEq(abi.encode(terms), encoded, "one encoding");
            uint256 code = vm.parseJsonUint(json, string.concat(key, ".code"));
            if (code != 0) {
                vm.expectRevert(abi.encodeWithSelector(AntseedFreeTierTerms.InvalidTerms.selector, uint8(code)));
                board.validate(terms);
                continue;
            }
            uint256 agentId = 1_000 + i;
            sellers.setAgent(seller, agentId);
            vm.prank(seller);
            board.setTerms(agentId, terms, type(uint256).max);
            (, bytes32 hash,) = board.termsAt(agentId, 11);
            assertEq(hash, keccak256(encoded), "the contract records the TS hash");
        }

        count = vm.parseJsonUint(json, ".lookupsCount");
        for (uint256 i = 0; i < count; ++i) {
            string memory key = string.concat(".lookups[", vm.toString(i), "]");
            uint256 agentId = 1_000 + vm.parseJsonUint(json, string.concat(key, ".terms"));
            (bool found, AntseedFreeTierTerms.Program memory program, uint8 kind) =
                board.programFor(agentId, 11, vm.parseJsonBytes32(json, string.concat(key, ".modelHash")));
            assertEq(found, vm.parseJsonBool(json, string.concat(key, ".found")), key);
            if (!found) continue;
            assertEq(program.scope, vm.parseJsonBytes32(json, string.concat(key, ".scope")), key);
            assertEq(kind, vm.parseJsonUint(json, string.concat(key, ".kind")), key);
            assertEq(program.windowSecs, vm.parseJsonUint(json, string.concat(key, ".windowSecs")), key);
        }

        count = vm.parseJsonUint(json, ".tiersCount");
        for (uint256 i = 0; i < count; ++i) {
            string memory key = string.concat(".tiers[", vm.toString(i), "]");
            uint256 agentId = 1_000 + vm.parseJsonUint(json, string.concat(key, ".terms"));
            (, AntseedFreeTierTerms.Program memory program,) =
                board.programFor(agentId, 11, vm.parseJsonBytes32(json, string.concat(key, ".modelHash")));
            assertEq(
                _tierFor(program, vm.parseJsonUint(json, string.concat(key, ".power"))),
                vm.parseJsonUint(json, string.concat(key, ".tier")),
                key
            );
        }
    }

    // ─── Fuzz ────────────────────────────────────────────────────────

    mapping(uint256 epoch => bytes32) private _promised;
    mapping(uint256 epoch => bool) private _seen;

    /// @notice Terms for any epoch up to `promisedThrough` never change, whatever writers do.
    function testFuzz_promisedTermsNeverChange(uint8[32] calldata ops) public {
        uint256 epoch = 10;
        uint256 maxEpoch;
        for (uint256 step = 0; step < ops.length; ++step) {
            uint8 op = ops[step];
            uint256 action = op % 4;
            if (action == 0) {
                epoch += 1 + (op >> 6);
                gate.setCurrentEpoch(epoch);
            } else if (action == 3) {
                _set(B.empty(uint16(2 + (op >> 4) % 6)));
            } else {
                _set(B.simple(uint16(2 + (op >> 2) % 12), keccak256(abi.encode(step))));
            }
            for (uint256 e = 0; e <= maxEpoch; ++e) {
                if (!_seen[e]) continue;
                (, bytes32 hash,) = board.termsAt(AGENT, e);
                assertEq(hash, _promised[e], "promised terms changed");
            }
            (bool promised, uint256 through) = board.promisedThrough(AGENT);
            if (!promised) continue;
            assertGe(through, epoch);
            for (uint256 e = epoch; e <= through; ++e) {
                (, bytes32 hash,) = board.termsAt(AGENT, e);
                if (_seen[e]) assertEq(hash, _promised[e]);
                _seen[e] = true;
                _promised[e] = hash;
            }
            if (through > maxEpoch) maxEpoch = through;
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    function _set(AntseedFreeTierTerms.Terms memory terms) internal returns (uint256) {
        vm.prank(seller);
        return board.setTerms(AGENT, terms, type(uint256).max);
    }

    function _expectInvalid(AntseedFreeTierTerms.Terms memory terms, uint8 code) internal {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(AntseedFreeTierTerms.InvalidTerms.selector, code));
        board.setTerms(AGENT, terms, type(uint256).max);
    }

    function _fourTiers(AntseedFreeTierTerms.Program memory p)
        internal
        pure
        returns (AntseedFreeTierTerms.Program memory)
    {
        p.tiers = new AntseedFreeTierTerms.Tier[](4);
        p.tiers[0] = AntseedFreeTierTerms.Tier(1, 1);
        p.tiers[1] = AntseedFreeTierTerms.Tier(2, 2);
        p.tiers[2] = AntseedFreeTierTerms.Tier(3, 3);
        p.tiers[3] = AntseedFreeTierTerms.Tier(2 ** 53 - 1, type(uint32).max);
        return p;
    }

    /// @dev The rule `tierFor` in TS implements: the highest tier whose threshold, in whole
    ///      ANTS-epochs, the power reaches.
    function _tierFor(AntseedFreeTierTerms.Program memory program, uint256 power) internal pure returns (uint256) {
        for (uint256 t = program.tiers.length; t > 0; --t) {
            if (power / 1e18 >= program.tiers[t - 1].minPowerAnts) return t;
        }
        return 0;
    }
}
