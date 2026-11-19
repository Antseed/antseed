// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedStaking } from "../interfaces/IAntseedStaking.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

/// @notice The staked free-tier promise board. A seller publishes, per agent, the free tier it promises
///         to stakers and how much notice it gives before changing it. It holds no funds, no keys and
///         has no owner; it only records promises.
///
///         Schedule: a first promise starts next epoch. A later change starts at
///         `max(current + max(2, liveNotice), tail.fromEpoch)`, where `liveNotice` is the active
///         entry's notice, or the earliest pending entry's when none is active. A start equal to the
///         tail's replaces the tail. So the terms for any epoch up to `promisedThrough` never change.
///
///         Writers: the agent's registered seller, its ERC-8004 owner, or an operator of an owner
///         contract (a gas-capped `isOperator` call; any unexpected answer fails closed).
contract AntseedFreeTierTerms {
    struct Tier {
        uint64 minPowerAnts; // whole ANTS-epochs of stake power
        uint32 requests; // per window; UNLIMITED for no limit
    }

    struct Model {
        bytes32 modelHash; // keccak256 of the service id
        uint8 kind; // 1 = free model, 2 = free allowance on a priced model
    }

    struct Program {
        bytes32 scope; // 0 = seller-wide, else the hash of the one model it covers
        uint32 windowSecs;
        bool buyerLimitsApplyToStakers;
        Tier[] tiers;
        Model[] models;
    }

    struct Terms {
        uint16 noticeEpochs;
        Program[] programs; // empty: no promise
    }

    struct Entry {
        uint64 fromEpoch;
        uint16 noticeEpochs;
        uint8 programCount;
        bytes32 termsHash;
    }

    uint256 public constant MIN_NOTICE_EPOCHS = 2;
    uint256 public constant MAX_NOTICE_EPOCHS = 104;
    uint256 public constant MAX_PROGRAMS = 16;
    uint256 public constant MAX_TIERS = 4;
    uint256 public constant MAX_MODELS = 32;
    uint256 public constant MIN_WINDOW_SECS = 60;
    uint256 public constant MAX_WINDOW_SECS = 30 days;
    uint256 public constant MAX_MIN_POWER_ANTS = 2 ** 53 - 1;
    uint256 public constant MAX_FINITE_REQUESTS = 2 ** 31;
    uint32 public constant UNLIMITED = type(uint32).max;
    uint256 private constant OPERATOR_GAS = 30_000;

    IAntseedRegistry public immutable registry;
    IAntseedEmissionsGate public immutable gate;
    IERC8004Registry public immutable identity;

    mapping(uint256 agentId => Entry[]) private _schedule;
    mapping(bytes32 termsHash => bytes) private _terms;

    event TermsScheduled(
        uint256 indexed agentId, uint256 fromEpoch, bytes32 indexed termsHash, address writer, Terms terms
    );

    error InvalidAddress();
    error InvalidAgent();
    error NotWriter();
    error StartsTooLate(uint256 fromEpoch);
    /// @dev `code` names the broken rule; `packages/protocol/src/free-tier-terms.ts` uses the same codes.
    error InvalidTerms(uint8 code);

    constructor(address registry_, address gate_, address identity_) {
        if (registry_.code.length == 0 || gate_.code.length == 0 || identity_.code.length == 0) {
            revert InvalidAddress();
        }
        registry = IAntseedRegistry(registry_);
        gate = IAntseedEmissionsGate(gate_);
        identity = IERC8004Registry(identity_);
    }

    /// @notice Schedules `terms` for `agentId` and returns the epoch they start in. Reverts when that
    ///         start is later than `maxFromEpoch`, the latest start the writer agreed to.
    function setTerms(uint256 agentId, Terms calldata terms, uint256 maxFromEpoch)
        external
        returns (uint256 fromEpoch)
    {
        if (!isWriter(agentId, msg.sender)) revert NotWriter();
        validate(terms);
        bytes memory encoded = abi.encode(terms);
        bytes32 termsHash = keccak256(encoded);
        if (_terms[termsHash].length == 0) _terms[termsHash] = encoded;

        Entry[] storage schedule = _schedule[agentId];
        uint256 current = gate.currentEpoch();
        uint256 count = schedule.length;
        if (count == 0) {
            fromEpoch = current + 1;
        } else {
            uint256 active = _lastAtOrBefore(schedule, current);
            // With nothing active, the earliest pending entry sets the notice.
            uint256 liveNotice = schedule[active == 0 ? 0 : active - 1].noticeEpochs;
            if (liveNotice < MIN_NOTICE_EPOCHS) liveNotice = MIN_NOTICE_EPOCHS;
            fromEpoch = current + liveNotice;
            if (fromEpoch < schedule[count - 1].fromEpoch) fromEpoch = schedule[count - 1].fromEpoch;
        }
        if (fromEpoch > maxFromEpoch) revert StartsTooLate(fromEpoch);
        Entry memory entry = Entry({
            fromEpoch: uint64(fromEpoch),
            noticeEpochs: terms.noticeEpochs,
            programCount: uint8(terms.programs.length),
            termsHash: termsHash
        });
        if (count != 0 && schedule[count - 1].fromEpoch == fromEpoch) schedule[count - 1] = entry;
        else schedule.push(entry);
        emit TermsScheduled(agentId, fromEpoch, termsHash, msg.sender, terms);
    }

    /// @notice Reverts with `InvalidTerms(code)` unless `terms` keep every bound.
    function validate(Terms calldata terms) public pure {
        uint256 notice = terms.noticeEpochs;
        if (notice < MIN_NOTICE_EPOCHS || notice > MAX_NOTICE_EPOCHS) revert InvalidTerms(1);
        Program[] calldata programs = terms.programs;
        if (programs.length > MAX_PROGRAMS) revert InvalidTerms(2);
        for (uint256 p = 0; p < programs.length; ++p) {
            Program calldata program = programs[p];
            // Ascending scopes put the seller-wide program (scope 0) first.
            if (p > 0 && program.scope <= programs[p - 1].scope) revert InvalidTerms(3);
            if (program.windowSecs < MIN_WINDOW_SECS || program.windowSecs > MAX_WINDOW_SECS) revert InvalidTerms(4);
            _validateTiers(program.tiers);
            Model[] calldata models = program.models;
            if (models.length == 0 || models.length > MAX_MODELS) revert InvalidTerms(5);
            for (uint256 m = 0; m < models.length; ++m) {
                if (models[m].modelHash == bytes32(0) || (m > 0 && models[m].modelHash <= models[m - 1].modelHash)) {
                    revert InvalidTerms(6);
                }
                if (models[m].kind != 1 && models[m].kind != 2) revert InvalidTerms(7);
            }
            if (program.scope != bytes32(0)) {
                // A model's own program lists exactly that model, which the seller-wide one must not.
                if (models.length != 1 || models[0].modelHash != program.scope) revert InvalidTerms(8);
                if (programs[0].scope == bytes32(0) && _lists(programs[0].models, program.scope)) {
                    revert InvalidTerms(9);
                }
            }
        }
    }

    // ─── Views ───────────────────────────────────────────────────────

    /// @notice The terms in force for `agentId` in `epoch`; `fromEpoch` 0 when there are none.
    function termsAt(uint256 agentId, uint256 epoch)
        external
        view
        returns (uint256 fromEpoch, bytes32 termsHash, Terms memory terms)
    {
        Entry[] storage schedule = _schedule[agentId];
        uint256 index = _lastAtOrBefore(schedule, epoch);
        if (index == 0) return (0, bytes32(0), terms);
        Entry storage entry = schedule[index - 1];
        return (entry.fromEpoch, entry.termsHash, abi.decode(_terms[entry.termsHash], (Terms)));
    }

    /// @notice The program that covers `modelHash` for `agentId` in `epoch`: the program whose scope is
    ///         the model, else the seller-wide program if it lists the model. `kind` is the model's.
    function programFor(uint256 agentId, uint256 epoch, bytes32 modelHash)
        external
        view
        returns (bool found, Program memory program, uint8 kind)
    {
        Entry[] storage schedule = _schedule[agentId];
        uint256 index = _lastAtOrBefore(schedule, epoch);
        if (index == 0 || modelHash == bytes32(0)) return (false, program, 0);
        Terms memory terms = abi.decode(_terms[schedule[index - 1].termsHash], (Terms));
        for (uint256 p = 0; p < terms.programs.length; ++p) {
            Program memory candidate = terms.programs[p];
            if (candidate.scope != modelHash && candidate.scope != bytes32(0)) continue;
            for (uint256 m = 0; m < candidate.models.length; ++m) {
                if (candidate.models[m].modelHash == modelHash) return (true, candidate, candidate.models[m].kind);
            }
        }
    }

    /// @notice The earliest entry that starts strictly after `epoch`.
    function nextChangeAfter(uint256 agentId, uint256 epoch)
        external
        view
        returns (bool exists, uint256 fromEpoch, bytes32 termsHash)
    {
        Entry[] storage schedule = _schedule[agentId];
        uint256 index = _lastAtOrBefore(schedule, epoch);
        if (index >= schedule.length) return (false, 0, bytes32(0));
        return (true, schedule[index].fromEpoch, schedule[index].termsHash);
    }

    /// @notice The last epoch (inclusive) whose terms can no longer change: the epoch before the
    ///         earliest pending change, else the current epoch plus the active notice, minus one.
    ///         `promised` is false when nothing is active or the active terms list no program.
    function promisedThrough(uint256 agentId) external view returns (bool promised, uint256 throughEpoch) {
        Entry[] storage schedule = _schedule[agentId];
        uint256 current = gate.currentEpoch();
        uint256 index = _lastAtOrBefore(schedule, current);
        if (index == 0 || schedule[index - 1].programCount == 0) return (false, 0);
        if (index < schedule.length) return (true, uint256(schedule[index].fromEpoch) - 1);
        return (true, current + schedule[index - 1].noticeEpochs - 1);
    }

    function scheduleLength(uint256 agentId) external view returns (uint256) {
        return _schedule[agentId].length;
    }

    function entryAt(uint256 agentId, uint256 index) external view returns (Entry memory) {
        return _schedule[agentId][index];
    }

    /// @notice Whether `who` may set terms for `agentId`. Reverts for agent 0.
    function isWriter(uint256 agentId, address who) public view returns (bool) {
        if (agentId == 0) revert InvalidAgent();
        try IAntseedStaking(registry.staking()).getAgentId(who) returns (uint256 registered) {
            if (registered == agentId) return true;
        } catch { }
        address owner;
        try identity.ownerOf(agentId) returns (address found) {
            owner = found;
        } catch {
            return false;
        }
        if (owner == address(0)) return false;
        if (owner == who) return true;
        if (owner.code.length == 0) return false;
        // The owner contract is not trusted: capped gas, exactly one clean bool word back.
        bytes memory query = abi.encodeWithSignature("isOperator(address)", who);
        bool ok;
        uint256 answer;
        assembly ("memory-safe") {
            ok := staticcall(OPERATOR_GAS, owner, add(query, 32), mload(query), 0, 0)
            if and(ok, eq(returndatasize(), 32)) {
                returndatacopy(0, 0, 32)
                answer := mload(0)
            }
            if iszero(eq(returndatasize(), 32)) { ok := 0 }
        }
        return ok && answer == 1;
    }

    // ─── Internals ───────────────────────────────────────────────────

    function _validateTiers(Tier[] calldata tiers) private pure {
        if (tiers.length == 0 || tiers.length > MAX_TIERS) revert InvalidTerms(10);
        for (uint256 t = 0; t < tiers.length; ++t) {
            uint256 minPower = tiers[t].minPowerAnts;
            uint256 requests = tiers[t].requests;
            if (minPower == 0 || minPower > MAX_MIN_POWER_ANTS) revert InvalidTerms(11);
            if (requests == 0 || (requests > MAX_FINITE_REQUESTS && requests != UNLIMITED)) revert InvalidTerms(12);
            if (requests == UNLIMITED && t != tiers.length - 1) revert InvalidTerms(13);
            if (t > 0 && (minPower <= tiers[t - 1].minPowerAnts || requests <= tiers[t - 1].requests)) {
                revert InvalidTerms(14);
            }
        }
    }

    function _lists(Model[] calldata models, bytes32 modelHash) private pure returns (bool) {
        for (uint256 m = 0; m < models.length; ++m) {
            if (models[m].modelHash == modelHash) return true;
        }
        return false;
    }

    /// @dev How many entries start at or before `epoch` (so the last of them is at index result - 1).
    function _lastAtOrBefore(Entry[] storage schedule, uint256 epoch) private view returns (uint256) {
        uint256 low = 0;
        uint256 high = schedule.length;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            if (schedule[middle].fromEpoch <= epoch) low = middle + 1;
            else high = middle;
        }
        return low;
    }
}
