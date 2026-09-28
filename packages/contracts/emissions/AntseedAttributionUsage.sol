// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import {IAntseedUsageAccounting} from "../interfaces/IAntseedUsageAccounting.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

interface IAntseedAttributionUsageAccounting is IAntseedUsageAccounting {
    function firstRewardedEpoch() external view returns (uint256);
}

interface IAntseedAttributionReferrals {
    function referrerOf(address buyer) external view returns (address);
}

interface IAntseedAttributionDeposits {
    function getOperator(address buyer) external view returns (address);
}

/**
 * @title AntseedAttributionUsage
 * @notice Recognized usage attributed per epoch to (a) the client software
 *         that produced it and (b) the wallet that referred the buyer.
 *         Clients are ERC-8004 agent ids; referrers are wallets bound in
 *         AntseedReferrals. Reward controllers split their epoch buckets by
 *         these points.
 *
 *         Points here are the same weighted points AntseedUsageAccounting
 *         records for the buyer — policy-scaled and pool-weighted, so wash
 *         exclusion and verification shaping are already applied. USDC
 *         volume and token counts never enter.
 *
 *         How it stays exact without touching the accounting ledger: every
 *         settlement calls AntseedStatsV2 before the accounting records that
 *         settlement's points, and the buyer's metadata (signed by the buyer)
 *         names the client that produced it. On each callback this contract
 *         reads the buyer's cumulative weighted points; the growth since the
 *         previous callback is exactly the points of the settlements in
 *         between. They are credited to the client and epoch recorded at that
 *         previous callback, and to the buyer's referrer (fixed once bound)
 *         for the same epoch. Then the cursor moves to the current client and
 *         epoch. A buyer's most recent settlement is credited at the buyer's
 *         next settlement, or by anyone via `flush`.
 *
 *         Invariant relied upon: AntseedChannels invokes the stats sink
 *         before `IAntseedEmissions.accrue*Points`. Settlements whose
 *         metadata carries no client id advance the cursor and land in the
 *         unattributed client bucket, so they never leak to another client.
 *
 *         Epoch finality: the reward controllers freeze an epoch's total at
 *         its first claim and read each claimant's points live, so a credit
 *         landing after that freeze would pay one claimant out of the others'
 *         shares. Credits therefore only ever land in epochs the controllers
 *         still treat as open (see `CREDIT_GRACE_EPOCHS`); anything observed
 *         later rolls forward into the oldest open epoch.
 */
contract AntseedAttributionUsage is Ownable2Step, Pausable {
    /// @dev One slot per buyer: last observed cumulative weighted points, the
    ///      client of the most recent settlement, and the epoch it settled in.
    struct Cursor {
        uint128 weightedPoints;
        uint64 clientAgentId;
        uint32 epoch;
        bool initialized;
    }

    /// @notice Epochs that stay open for late credits after they end. Equals
    ///         `AntseedEpochShareRewards.SETTLEMENT_GRACE_EPOCHS`: an epoch is
    ///         claimable (and its total frozen) once this many further epochs
    ///         have fully elapsed, so no credit may land there afterwards.
    uint256 public constant CREDIT_GRACE_EPOCHS = 1;

    IAntseedAttributionUsageAccounting public immutable usageAccounting;
    IERC8004Registry public immutable identityRegistry;
    IAntseedAttributionDeposits public immutable deposits;

    /// @notice Contract allowed to report settlements (AntseedStatsV2).
    address public recorder;
    /// @notice Referral bindings source (zero disables referrer credits).
    IAntseedAttributionReferrals public referrals;

    mapping(address buyer => Cursor) private _cursors;

    mapping(uint256 epoch => mapping(uint256 clientAgentId => uint256 points)) public clientEpochPoints;
    mapping(uint256 epoch => uint256 points) public totalClientPointsByEpoch;
    mapping(uint256 epoch => uint256 points) public unattributedClientPointsByEpoch;
    mapping(uint256 clientAgentId => uint256 points) public clientTotalPoints;

    mapping(uint256 epoch => mapping(address referrer => uint256 points)) public referrerEpochPoints;
    mapping(uint256 epoch => uint256 points) public totalReferrerPointsByEpoch;
    mapping(address referrer => uint256 points) public referrerTotalPoints;

    event ClientUsageCredited(uint256 indexed epoch, uint256 indexed clientAgentId, address indexed buyer, uint256 points);
    event UnattributedClientUsage(uint256 indexed epoch, address indexed buyer, uint256 points);
    event ReferrerUsageCredited(uint256 indexed epoch, address indexed referrer, address indexed buyer, uint256 points);
    event RecorderUpdated(address indexed recorder);
    event ReferralsUpdated(address indexed referrals);

    error InvalidAddress();
    error NotRecorder();

    constructor(address _usageAccounting, address _identityRegistry, address _deposits, address _recorder)
        Ownable(msg.sender)
    {
        if (_usageAccounting == address(0) || _identityRegistry == address(0) || _deposits == address(0)) {
            revert InvalidAddress();
        }
        usageAccounting = IAntseedAttributionUsageAccounting(_usageAccounting);
        identityRegistry = IERC8004Registry(_identityRegistry);
        deposits = IAntseedAttributionDeposits(_deposits);
        recorder = _recorder;
    }

    // ─── Recording ───────────────────────────────────────────────────

    /// @notice Called by the recorder on every settlement, before the
    ///         accounting records it. `clientAgentId` is zero when the
    ///         buyer's metadata named no client, or an unregistered one.
    function record(address buyer, uint256 clientAgentId) external whenNotPaused {
        if (msg.sender != recorder || recorder == address(0)) revert NotRecorder();
        if (buyer == address(0)) revert InvalidAddress();

        Cursor storage cursor = _cursors[buyer];
        _credit(buyer, cursor);

        cursor.clientAgentId = uint64(_registeredClient(clientAgentId));
        cursor.epoch = uint32(_accountingEpoch());
        cursor.initialized = true;
    }

    /// @notice Credit points that landed after each buyer's latest settlement.
    ///         Permissionless; a no-op for buyers with nothing outstanding.
    function flush(address[] calldata buyers) external whenNotPaused {
        for (uint256 i = 0; i < buyers.length; i++) {
            Cursor storage cursor = _cursors[buyers[i]];
            if (cursor.initialized) _credit(buyers[i], cursor);
        }
    }

    // ─── Views ───────────────────────────────────────────────────────

    /// @notice Recipient of a client's rewards: the ERC-8004 agent owner.
    function clientRecipient(uint256 clientAgentId) external view returns (address) {
        return identityRegistry.ownerOf(clientAgentId);
    }

    /// @notice Weighted points recorded for the buyer but not yet credited
    ///         (the buyer's latest settlement), with the client and epoch
    ///         they would be credited to if flushed now.
    function pendingCredit(address buyer) external view returns (uint256 points, uint256 clientAgentId, uint256 epoch) {
        Cursor storage cursor = _cursors[buyer];
        if (!cursor.initialized) return (0, 0, 0);
        uint256 current = usageAccounting.buyerUsageTotal(buyer).weightedPoints;
        points = current > cursor.weightedPoints ? current - cursor.weightedPoints : 0;
        return (points, cursor.clientAgentId, _creditEpoch(cursor.epoch));
    }

    /// @notice Oldest epoch that can still receive credits.
    function oldestOpenEpoch() public view returns (uint256) {
        uint256 current = usageAccounting.currentEpoch();
        uint256 open = current > CREDIT_GRACE_EPOCHS ? current - CREDIT_GRACE_EPOCHS : 0;
        uint256 first = usageAccounting.firstRewardedEpoch();
        return open < first ? first : open;
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Credit growth since the cursor's last observation to the cursor's
    ///      client and epoch and to the buyer's referrer, then move the
    ///      observation forward. The first observation only sets the baseline:
    ///      usage before attribution existed is not credited to anyone.
    function _credit(address buyer, Cursor storage cursor) internal {
        uint256 current = usageAccounting.buyerUsageTotal(buyer).weightedPoints;
        uint256 baseline = cursor.weightedPoints;
        // Cursor packs into uint128; the accounting's cumulative weighted points
        // stay far below that, but never revert a settlement over it.
        if (current > type(uint128).max) current = type(uint128).max;
        cursor.weightedPoints = uint128(current);
        if (!cursor.initialized || current <= baseline) return;

        uint256 delta = current - baseline;
        uint256 epoch = _creditEpoch(cursor.epoch);
        _creditClient(buyer, cursor.clientAgentId, epoch, delta);
        _creditReferrer(buyer, epoch, delta);
    }

    /// @dev The cursor's epoch, unless the controllers already treat it as
    ///      final: a trailing settlement flushed that late rolls forward into
    ///      the oldest open epoch instead of moving a frozen denominator.
    function _creditEpoch(uint256 cursorEpoch) internal view returns (uint256) {
        uint256 open = oldestOpenEpoch();
        return cursorEpoch < open ? open : cursorEpoch;
    }

    function _creditClient(address buyer, uint256 client, uint256 epoch, uint256 delta) internal {
        if (client == 0) {
            unattributedClientPointsByEpoch[epoch] += delta;
            emit UnattributedClientUsage(epoch, buyer, delta);
            return;
        }
        clientEpochPoints[epoch][client] += delta;
        totalClientPointsByEpoch[epoch] += delta;
        clientTotalPoints[client] += delta;
        emit ClientUsageCredited(epoch, client, buyer, delta);
    }

    /// @dev A referrer who is the buyer's own operator earns nothing: the
    ///      operator is usually unset when the binding lands, so the
    ///      self-referral guard has to be re-applied here.
    function _creditReferrer(address buyer, uint256 epoch, uint256 delta) internal {
        IAntseedAttributionReferrals source = referrals;
        if (address(source) == address(0)) return;
        address referrer = source.referrerOf(buyer);
        if (referrer == address(0) || referrer == deposits.getOperator(buyer)) return;
        referrerEpochPoints[epoch][referrer] += delta;
        totalReferrerPointsByEpoch[epoch] += delta;
        referrerTotalPoints[referrer] += delta;
        emit ReferrerUsageCredited(epoch, referrer, buyer, delta);
    }

    /// @dev Zero unless the agent id fits the cursor and has an owner.
    function _registeredClient(uint256 clientAgentId) internal view returns (uint256) {
        if (clientAgentId == 0 || clientAgentId > type(uint64).max) return 0;
        try identityRegistry.ownerOf(clientAgentId) returns (address owner) {
            return owner == address(0) ? 0 : clientAgentId;
        } catch {
            return 0;
        }
    }

    /// @dev The epoch the accounting will record this settlement under.
    function _accountingEpoch() internal view returns (uint256) {
        uint256 epoch = usageAccounting.currentEpoch();
        uint256 first = usageAccounting.firstRewardedEpoch();
        return epoch < first ? first : epoch;
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function setRecorder(address _recorder) external onlyOwner {
        recorder = _recorder;
        emit RecorderUpdated(_recorder);
    }

    function setReferrals(address _referrals) external onlyOwner {
        referrals = IAntseedAttributionReferrals(_referrals);
        emit ReferralsUpdated(_referrals);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
