// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedUsageAccounting} from "../interfaces/IAntseedUsageAccounting.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

/**
 * @title AntseedClientRewards
 * @notice Emission-funded rewards for client software (Desktop, CLI,
 *         third-party apps), paid to each client's ERC-8004 agent owner. A
 *         client earns the bucket in proportion to its share of all recognized
 *         buyer usage: producing 5% of an epoch's weighted buyer points earns
 *         5% of the bucket. The part of the bucket no client earned is never
 *         minted.
 *
 *         Attribution: every settlement calls AntseedStatsV2 before the
 *         accounting records that settlement's points, and the buyer-signed
 *         metadata names the client that produced it. On each callback this
 *         contract reads the buyer's cumulative weighted points; the growth
 *         since the previous callback is exactly the points of the settlements
 *         in between, and goes to the client and epoch noted at that previous
 *         callback. A buyer's most recent settlement is credited at the buyer's
 *         next one, or by anyone via `flush`. Points are the accounting's, so
 *         wash exclusion and verification shaping are already applied.
 *
 *         Finality: an epoch is claimable once `SETTLEMENT_GRACE_EPOCHS`
 *         further epochs have elapsed. Credits never land in a claimable epoch;
 *         anything observed later rolls forward into the oldest open one.
 *
 *         The denominator is the accounting's epoch total, or the credited
 *         total when that is larger: credits rolled forward into a quiet epoch
 *         can exceed the usage settled in it, and the larger number keeps
 *         every share within the bucket.
 */
contract AntseedClientRewards is Ownable2Step, Pausable, ReentrancyGuard {
    /// @dev One slot per buyer: last observed cumulative weighted points, the
    ///      client of the most recent settlement, and the epoch it settled in.
    struct Cursor {
        uint128 weightedPoints;
        uint64 clientAgentId;
        uint32 epoch;
        bool initialized;
    }

    /// @notice Epochs that must fully elapse after `epoch` before it is claimable.
    uint256 public constant SETTLEMENT_GRACE_EPOCHS = 1;

    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedUsageAccounting public immutable usageAccounting;
    IERC8004Registry public immutable identityRegistry;

    /// @notice Contract allowed to report settlements (AntseedStatsV2).
    address public recorder;

    mapping(address buyer => Cursor) private _cursors;

    mapping(uint256 epoch => mapping(uint256 clientAgentId => uint256 points)) public clientEpochPoints;
    mapping(uint256 epoch => uint256 points) public totalClientPointsByEpoch;

    mapping(uint256 clientAgentId => mapping(uint256 epoch => bool)) public claimed;

    event ClientUsageCredited(uint256 indexed epoch, uint256 indexed clientAgentId, address indexed buyer, uint256 points);
    event ClientRewardClaimed(
        uint256 indexed epoch,
        uint256 indexed clientAgentId,
        address indexed recipient,
        uint256 points,
        uint256 totalPoints,
        uint256 amount
    );
    event RecorderUpdated(address indexed recorder);

    error InvalidAddress();
    error NotRecorder();
    error EpochNotClaimable();
    error AlreadyClaimed();
    error NothingToClaim();

    constructor(address _emissionsGate, address _usageAccounting, address _identityRegistry, address _recorder)
        Ownable(msg.sender)
    {
        if (_emissionsGate == address(0) || _usageAccounting == address(0) || _identityRegistry == address(0)) {
            revert InvalidAddress();
        }
        // `ownerOf` is wrapped in try/catch, but a call to an address without
        // code succeeds with empty return data and the caller-side ABI decode
        // then reverts outside the catch. That would make every `record` with
        // a client id and every claim revert, so a mis-set registry must fail here.
        if (_identityRegistry.code.length == 0) revert InvalidAddress();
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        identityRegistry = IERC8004Registry(_identityRegistry);
        recorder = _recorder;
    }

    // ─── Recording ───────────────────────────────────────────────────

    /// @notice Called by the recorder on every settlement, before the
    ///         accounting records it. `clientAgentId` is zero when the buyer's
    ///         metadata named no client. Not pausable: the accounting keeps
    ///         accruing regardless, and a skipped callback would hand the
    ///         backlog to a stale client.
    function record(address buyer, uint256 clientAgentId) external {
        if (msg.sender != recorder) revert NotRecorder();
        Cursor storage cursor = _cursors[buyer];
        _creditGrowth(buyer, cursor);
        cursor.clientAgentId = uint64(_registeredClient(clientAgentId));
        cursor.epoch = uint32(emissionsGate.currentEpoch());
        cursor.initialized = true;
    }

    /// @notice Credit points that landed after each buyer's latest settlement.
    ///         Permissionless; a no-op for buyers with nothing outstanding.
    function flush(address[] calldata buyers) external {
        for (uint256 i = 0; i < buyers.length; i++) {
            Cursor storage cursor = _cursors[buyers[i]];
            if (cursor.initialized) _creditGrowth(buyers[i], cursor);
        }
    }

    // ─── Rewards ─────────────────────────────────────────────────────

    function isClaimable(uint256 epoch) public view returns (bool) {
        return epoch + SETTLEMENT_GRACE_EPOCHS < emissionsGate.currentEpoch();
    }

    /// @notice Mint a client's share of an epoch's bucket to the agent owner.
    ///         Permissionless: anyone may trigger it; funds only ever go to
    ///         `identityRegistry.ownerOf(clientAgentId)`.
    function claim(uint256 clientAgentId, uint256 epoch) external nonReentrant whenNotPaused {
        if (!isClaimable(epoch)) revert EpochNotClaimable();
        if (claimed[clientAgentId][epoch]) revert AlreadyClaimed();
        address recipient = _agentOwner(clientAgentId);
        if (recipient == address(0)) revert InvalidAddress();

        uint256 points = clientEpochPoints[epoch][clientAgentId];
        uint256 total = _epochTotal(epoch);
        uint256 amount = _share(epoch, points, total);
        if (amount == 0) revert NothingToClaim();

        claimed[clientAgentId][epoch] = true;
        emissionsGate.claim(epoch, recipient, amount);
        emit ClientRewardClaimed(epoch, clientAgentId, recipient, points, total, amount);
    }

    /// @notice What a client would receive for an epoch right now.
    function pendingReward(uint256 clientAgentId, uint256 epoch) external view returns (uint256) {
        if (!isClaimable(epoch) || claimed[clientAgentId][epoch]) return 0;
        return _share(epoch, clientEpochPoints[epoch][clientAgentId], _epochTotal(epoch));
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Move the observation forward and credit the growth to the cursor's
    ///      client and epoch. The first observation only sets the baseline:
    ///      usage before the contract existed is credited to nobody.
    function _creditGrowth(address buyer, Cursor storage cursor) internal {
        uint256 current = usageAccounting.buyerUsageTotal(buyer).weightedPoints;
        // Far below uint128 in practice, but never revert a settlement over it.
        if (current > type(uint128).max) current = type(uint128).max;
        uint256 previous = cursor.weightedPoints;
        cursor.weightedPoints = uint128(current);

        uint256 client = cursor.clientAgentId;
        if (!cursor.initialized || client == 0 || current <= previous) return;

        uint256 epoch = cursor.epoch;
        if (isClaimable(epoch)) epoch = emissionsGate.currentEpoch() - SETTLEMENT_GRACE_EPOCHS;
        uint256 delta = current - previous;
        clientEpochPoints[epoch][client] += delta;
        totalClientPointsByEpoch[epoch] += delta;
        emit ClientUsageCredited(epoch, client, buyer, delta);
    }

    /// @dev Never below the credited total, so client shares sum to at most the bucket.
    function _epochTotal(uint256 epoch) internal view returns (uint256) {
        return Math.max(usageAccounting.totalWeightedBuyerPointsByEpoch(epoch), totalClientPointsByEpoch[epoch]);
    }

    function _share(uint256 epoch, uint256 points, uint256 total) internal view returns (uint256) {
        if (points == 0 || total == 0) return 0;
        return Math.mulDiv(emissionsGate.controllerEpochBudget(address(this), epoch), points, total);
    }

    /// @dev Zero unless the agent id fits the cursor and has an owner.
    function _registeredClient(uint256 clientAgentId) internal view returns (uint256) {
        if (clientAgentId == 0 || clientAgentId > type(uint64).max) return 0;
        return _agentOwner(clientAgentId) == address(0) ? 0 : clientAgentId;
    }

    /// @dev ERC-721 registries revert for unknown ids; treat that as no owner.
    function _agentOwner(uint256 clientAgentId) internal view returns (address) {
        try identityRegistry.ownerOf(clientAgentId) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setRecorder(address _recorder) external onlyOwner {
        recorder = _recorder;
        emit RecorderUpdated(_recorder);
    }

    /// @notice Stops claims. Recording keeps running.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
