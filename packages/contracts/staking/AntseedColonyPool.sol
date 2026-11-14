// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { AntseedSellerDelegation } from "./AntseedSellerDelegation.sol";
import { IAntseedEmissions } from "../interfaces/IAntseedEmissions.sol";
import { IERC8004Registry } from "../interfaces/IERC8004Registry.sol";

/// @dev The ERC-8004 IdentityRegistry's minting entry point.
interface IERC8004AgentRegistration {
    function register(string calldata agentURI) external returns (uint256 agentId);
}

/// @dev AntseedSellerRegistry (registry.staking() in the seller-pool era).
interface IAntseedSellerRegistration {
    function registerSeller(uint256 agentId) external;
}

/// @dev AntseedUsageAccounting accounts settlements made before the gate's
///      effective epoch under that epoch.
interface IAntseedRewardedEpochFloor {
    function firstRewardedEpoch() external view returns (uint256);
}

/// @dev AntseedEmissionsV2 mints a seller's reward into a rewards pool,
///      locked, unless its unlock policy lets the seller claim directly.
/// @dev AntseedChannels' public `channels` getter, for a channel's status (1 = Active).
interface IAntseedChannelState {
    function channels(bytes32 channelId)
        external
        view
        returns (address, address, uint128, uint128, bytes32, uint256, uint256, uint256, uint8);
}

/// @dev ANTSToken's transfer gate: before `transfersEnabled`, only whitelisted senders may transfer.
interface IAntsTransferGate {
    function transfersEnabled() external view returns (bool);
    function transferWhitelist(address account) external view returns (bool);
}

interface IAntseedLockingEmissions {
    function sellerRewardsPool() external view returns (address);
}

interface IAntseedLockedSellerRewards {
    function lockedRewards(address seller) external view returns (uint256);
}

/**
 * @title AntseedColonyPool
 * @notice Seller façade for a colony pool: one staked Antseed seller that
 *         serves buyers from many worker machines. The pool settles through
 *         the same `settle` / `close` / `topUp` surface as any seller
 *         delegation, then splits each payout between workers using the
 *         per-worker cumulative amounts the buyer appends to the metadata it
 *         signs in every SpendingAuth (see docs/protocol/colony-pool.md).
 *
 *         Worker tail, read from the END of `metadata`:
 *
 *             abi.encode(v4 fields…) ‖ entries ‖ uint8 count ‖ bytes32 WORKER_TAIL_MAGIC
 *             entry = address worker (20 bytes) ‖ uint128 cumulativeAmount (16 bytes, big-endian)
 *
 *         The tail is only trusted when AntseedChannels actually settled a new
 *         amount in this call, i.e. when it verified the buyer's EIP-712
 *         signature over `keccak256(metadata)`. Any malformation attributes
 *         nothing; tail contents never revert settlement.
 *
 *         USDC: each worker is credited `net × workerDelta / delta`; the rest
 *         (unattributed requests and rounding) is credited to
 *         `remainderRecipient`. Everything is pull-based (`claimUsdc`).
 *
 *         ANTS: every USDC credit also adds weight for the emissions epoch
 *         that rewards the settlement: the current epoch, or the emissions
 *         contract's `firstRewardedEpoch` when settling before it (the gate
 *         cutover). Once an epoch is finalized, anyone can pull the pool's
 *         seller emissions for it (`claimEpochEmissions`) and each account
 *         claims its weight-proportional share (`claimAnts`).
 *
 *         Setup on the seller-pool stack: the owner mints the pool's agent
 *         (`registerAgent`, or transfers one to the pool) and binds it
 *         (`registerSeller`); ANTS stake for that agent then makes the pool
 *         channel-eligible.
 */
contract AntseedColonyPool is AntseedSellerDelegation, Pausable {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────
    /// @notice Marker closing a worker-attribution tail.
    bytes32 public constant WORKER_TAIL_MAGIC = keccak256("antseed:worker-attribution:v1");

    /// @notice Maximum worker entries in a tail (bounds settlement gas).
    uint256 public constant MAX_WORKERS_PER_CHANNEL = 8;

    /// @notice Domain tag of the worker payout authorization digest.
    bytes32 public constant PAYOUT_TAG = keccak256("antseed-worker-payout/v1");

    /// @notice Maximum epochs per `claimEpochEmissions` / `claimAnts` call.
    uint256 public constant MAX_EPOCHS_PER_CLAIM = 32;

    /// @dev ABI v4 metadata head is at least 8 words.
    uint256 private constant _MIN_HEAD_BYTES = 256;
    /// @dev uint8 count + bytes32 magic.
    uint256 private constant _TAIL_TRAILER_BYTES = 33;
    /// @dev address (20) + uint128 (16).
    uint256 private constant _ENTRY_BYTES = 36;

    // ─── Attribution state ──────────────────────────────────────────
    /// @dev Keyed by `keccak256(abi.encode(channelsContract, channelId))`:
    ///      channel IDs do not include the channels address, so a swapped
    ///      channels contract must not inherit a previous contract's cursor.
    mapping(bytes32 => uint128) internal _channelCumulative;
    mapping(bytes32 => mapping(address => uint128)) internal _workerCumulative;

    /// @dev Settled value no worker was attributed yet: `gross` channel units
    ///      and the `net` USDC they paid, from settlements in reward `epoch`.
    struct HeldChunk {
        uint128 gross;
        uint128 net;
        uint64 epoch;
        bool hasEpoch;
    }

    /// @dev Per channel, what settled unattributed, oldest first, held while
    ///      the channel is active: a buyer may sign headroom first and attribute
    ///      it to a worker only after that headroom settled, and later tails are
    ///      paid from it. `close` (or `releaseHeld`, once the channel is no longer
    ///      active) gives what is left to `remainderRecipient`. `_heldHead` skips
    ///      used-up chunks; `_heldUnits` is the gross still held.
    mapping(bytes32 => HeldChunk[]) internal _held;
    mapping(bytes32 => uint256) internal _heldHead;
    mapping(bytes32 => uint256) internal _heldUnits;
    /// @notice Net USDC held for channels' later tails (never swept as orphaned).
    uint256 public totalUsdcHeld;
    /// @notice Per epoch, the weight of held USDC settled in it. It counts in
    ///         `epochTotalWeight` from the settlement on, so that epoch's ANTS
    ///         are reserved for it, and moves to whoever the USDC is credited
    ///         to; nobody can claim it while it is held.
    mapping(uint256 => uint256) public epochHeldWeight;

    /// @notice The operator fee's ANTS, kept here rather than sent when emissions
    ///         are pulled, so a pull never needs ANTS to be transferable; the
    ///         recipient takes them with `claimAntsFee`.
    mapping(address => uint256) public antsFeeOwed;

    // ─── Worker payout addresses ────────────────────────────────────
    /// @notice Where a worker's credits go (zero = the worker itself).
    mapping(address => address) public payoutOf;

    /// @notice Next nonce a worker's payout authorization must carry.
    mapping(address => uint256) public payoutNonce;

    // ─── USDC balances ──────────────────────────────────────────────
    /// @notice Recipient of unattributed USDC and rounding dust.
    address public remainderRecipient;

    /// @notice Claimable USDC per account.
    mapping(address => uint256) public usdcBalance;

    /// @notice Sum of all claimable USDC balances.
    uint256 public totalUsdcOwed;

    // ─── ANTS emissions ─────────────────────────────────────────────
    mapping(uint256 => mapping(address => uint256)) public epochWeight;
    mapping(uint256 => uint256) public epochTotalWeight;
    /// @notice Net ANTS (after operator fee) pulled into the pool per epoch.
    mapping(uint256 => uint256) public epochAnts;
    mapping(uint256 => mapping(address => uint256)) public antsClaimed;

    // ─── Events ─────────────────────────────────────────────────────
    event RemainderRecipientSet(address indexed recipient);
    event ChannelAttributed(
        bytes32 indexed channelId, uint256 delta, uint256 netPayout, uint256 workerCount, bool tailValid
    );
    event WorkerCumulativeUpdated(bytes32 indexed channelId, address indexed worker, uint128 cumulativeAmount);
    event UsdcCredited(address indexed account, bytes32 indexed channelId, uint256 indexed epoch, uint256 amount);
    event UsdcClaimed(address indexed account, uint256 amount);
    event EpochEmissionsClaimed(uint256 indexed epoch, uint256 antsAmount);
    event AntsClaimed(address indexed account, uint256[] epochs, uint256 amount);
    event AntsFeeClaimed(address indexed recipient, uint256 amount);
    event AntsClaimedFor(address indexed worker, address indexed payout, uint256[] epochs, uint256 amount);
    event OrphanUsdcSwept(address indexed recipient, uint256 amount);
    event UnattributedHeld(bytes32 indexed channelId, uint256 gross, uint256 net);
    event HeldReleased(bytes32 indexed channelId, uint256 net);
    event PayoutSet(address indexed worker, address indexed payout, uint256 nonce);
    event EarningsMoved(address indexed from, address indexed to, uint256 usdcAmount);
    event AgentRegistered(uint256 indexed agentId);
    event SellerRegistered(uint256 indexed agentId);

    // ─── Errors ─────────────────────────────────────────────────────
    error NothingToClaim();
    error InvalidEpochs();
    error EpochNotFinalized();
    error SignatureExpired();
    error InvalidSignature();
    error NotAgentOwner();
    error EmissionsLocked();
    error NoPayout();
    error ChannelStillActive();
    error AntsNotTransferableYet();

    /// @param _registry AntSeed address book.
    /// @param initialOperator First operator; also the initial operator-fee
    ///        recipient and `remainderRecipient`.
    constructor(address _registry, address initialOperator) AntseedSellerDelegation(_registry, initialOperator) {
        remainderRecipient = initialOperator;
        emit RemainderRecipientSet(initialOperator);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CHANNEL OVERRIDES
    // ═══════════════════════════════════════════════════════════════════

    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) public override nonReentrant whenNotPaused returns (uint256 netPayout) {
        netPayout = super.topUp(channelId, cumulativeAmount, metadata, spendingSig, newMaxAmount, deadline, reserveSig);
        _attribute(channelId, cumulativeAmount, metadata, netPayout);
    }

    function settle(bytes32 channelId, uint128 cumulativeAmount, bytes calldata metadata, bytes calldata buyerSig)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 netPayout)
    {
        netPayout = super.settle(channelId, cumulativeAmount, metadata, buyerSig);
        _attribute(channelId, cumulativeAmount, metadata, netPayout);
    }

    function close(bytes32 channelId, uint128 finalAmount, bytes calldata metadata, bytes calldata buyerSig)
        public
        override
        nonReentrant
        whenNotPaused
        returns (uint256 netPayout)
    {
        netPayout = super.close(channelId, finalAmount, metadata, buyerSig);
        _attribute(channelId, finalAmount, metadata, netPayout);
        // Closed: no later tail can claim what the channel held.
        _releaseHeld(channelId, _channelKey(channelId));
    }

    /// @notice Release what a channel that is no longer active (timed out and
    ///         withdrawn by its buyer, say) still holds for a later tail to
    ///         `remainderRecipient`. Callable by anyone.
    function releaseHeld(bytes32 channelId) external nonReentrant {
        _releaseHeldFrom(address(_channels()), channelId);
    }

    /// @notice `releaseHeld` for a channel of `channelsContract`, which may be a
    ///         Channels contract the registry has since replaced. Only a contract
    ///         this pool settled through ever has anything held under it.
    function releaseHeldFrom(address channelsContract, bytes32 channelId) external nonReentrant {
        _releaseHeldFrom(channelsContract, channelId);
    }

    function _releaseHeldFrom(address channelsContract, bytes32 channelId) internal {
        bytes32 key = keccak256(abi.encode(channelsContract, channelId));
        if (_heldUnits[key] == 0 && _heldHead[key] >= _held[key].length) return;
        (,,,,,,,, uint8 status) = IAntseedChannelState(channelsContract).channels(channelId);
        if (status == 1) revert ChannelStillActive();
        _releaseHeld(channelId, key);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CLAIMS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Transfer the caller's claimable USDC.
    /// @dev Intentionally not pausable: the owner cannot freeze credited funds.
    function claimUsdc() external nonReentrant {
        uint256 amount = usdcBalance[msg.sender];
        if (amount == 0) revert NothingToClaim();
        usdcBalance[msg.sender] = 0;
        totalUsdcOwed -= amount;
        _sellerPayoutToken().safeTransfer(msg.sender, amount);
        emit UsdcClaimed(msg.sender, amount);
    }

    /// @notice Pull the pool's seller emissions for finalized `epochs` into
    ///         this contract. Callable by anyone, and more than once per
    ///         epoch (later pulls accumulate).
    function claimEpochEmissions(uint256[] calldata epochs) external nonReentrant whenNotPaused {
        uint256 len = epochs.length;
        if (len == 0 || len > MAX_EPOCHS_PER_CLAIM) revert InvalidEpochs();
        uint256 current = _currentEmissionsEpoch();
        uint256[] memory single = new uint256[](1);
        for (uint256 i = 0; i < len; i++) {
            uint256 epoch = epochs[i];
            // Weights for an epoch are only final once it has ended, and every
            // emissions implementation refuses the current epoch anyway.
            if (epoch >= current) revert EpochNotFinalized();
            single[0] = epoch;
            uint256 antsAmount = _claimUnlockedSellerEmissions(single);
            if (antsAmount == 0) continue;
            if (epochTotalWeight[epoch] == 0) {
                // ANTS for an epoch with no credited USDC would otherwise be
                // stranded; give it to the remainder recipient.
                epochWeight[epoch][remainderRecipient] = 1;
                epochTotalWeight[epoch] = 1;
            }
            epochAnts[epoch] += antsAmount;
            emit EpochEmissionsClaimed(epoch, antsAmount);
        }
    }

    /// @notice Whether this pool can send ANTS now: once the token enables
    ///         transfers (or whitelists the pool). Until then, ANTS claims revert
    ///         with `AntsNotTransferableYet` and what is owed stays recorded.
    function antsTransferable() public view returns (bool) {
        address token = registry.antsToken();
        try IAntsTransferGate(token).transfersEnabled() returns (bool enabled) {
            if (enabled) return true;
        } catch {
            return true; // a token with no transfer gate
        }
        try IAntsTransferGate(token).transferWhitelist(address(this)) returns (bool whitelisted) {
            return whitelisted;
        } catch {
            return false;
        }
    }

    /// @notice Claim the operator fee's ANTS credited to the caller by emissions pulls.
    function claimAntsFee() external nonReentrant {
        uint256 amount = antsFeeOwed[msg.sender];
        if (amount == 0) revert NothingToClaim();
        if (!antsTransferable()) revert AntsNotTransferableYet();
        antsFeeOwed[msg.sender] = 0;
        IERC20(registry.antsToken()).safeTransfer(msg.sender, amount);
        emit AntsFeeClaimed(msg.sender, amount);
    }

    /// @notice Claim the caller's ANTS share of funded `epochs`.
    /// @dev Intentionally not pausable: the owner cannot freeze credited funds.
    function claimAnts(uint256[] calldata epochs) external nonReentrant {
        if (!antsTransferable()) revert AntsNotTransferableYet();
        uint256 total = _markAntsClaimed(msg.sender, epochs);
        IERC20(registry.antsToken()).safeTransfer(msg.sender, total);
        emit AntsClaimed(msg.sender, epochs, total);
    }

    /// @notice Pay a linked `worker`'s own ANTS share of funded `epochs` to its
    ///         payout wallet: the shares `setPayout` left with the worker key
    ///         (epochs older than its migration window). Callable by anyone,
    ///         since the ANTS only ever go where the worker itself linked.
    /// @dev Intentionally not pausable, like `claimAnts`.
    function claimAntsFor(address worker, uint256[] calldata epochs) external nonReentrant {
        address payout = payoutOf[worker];
        if (payout == address(0) || payout == worker) revert NoPayout();
        if (!antsTransferable()) revert AntsNotTransferableYet();
        uint256 total = _markAntsClaimed(worker, epochs);
        IERC20(registry.antsToken()).safeTransfer(payout, total);
        emit AntsClaimedFor(worker, payout, epochs, total);
    }

    /// @dev Records `account`'s pending ANTS for `epochs` as claimed and returns
    ///      the total (checks and effects before the caller's transfer).
    function _markAntsClaimed(address account, uint256[] calldata epochs) internal returns (uint256 total) {
        uint256 len = epochs.length;
        if (len == 0 || len > MAX_EPOCHS_PER_CLAIM) revert InvalidEpochs();
        for (uint256 i = 0; i < len; i++) {
            uint256 epoch = epochs[i];
            uint256 owed = _pendingAnts(account, epoch);
            if (owed == 0) continue;
            antsClaimed[epoch][account] += owed;
            total += owed;
        }
        if (total == 0) revert NothingToClaim();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        WORKER PAYOUT
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Route `worker`'s credits to `payout`. Callable by anyone;
    ///         authorized solely by the worker's EIP-191 (personal_sign)
    ///         signature over `payoutDigest(worker, payout, deadline)`, which
    ///         binds chain id, this contract, and the worker's current nonce.
    ///         What the worker earned before the change moves to `payout`
    ///         too: its unclaimed USDC, and its ANTS share of the current
    ///         epoch and the `MAX_EPOCHS_PER_CLAIM` before it. Older ANTS
    ///         shares stay with the worker key: it claims them itself, or
    ///         anyone sends them to `payout` with `claimAntsFor`.
    function setPayout(address worker, address payout, uint256 deadline, bytes calldata signature) external {
        if (worker == address(0) || payout == address(0)) revert InvalidAddress();
        if (block.timestamp > deadline) revert SignatureExpired();

        uint256 nonce = payoutNonce[worker];
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(_payoutDigest(worker, payout, nonce, deadline));
        // tryRecover rejects malleable (high-s) and malformed signatures.
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(ethHash, signature);
        if (err != ECDSA.RecoverError.NoError || signer != worker) revert InvalidSignature();

        payoutNonce[worker] = nonce + 1;
        payoutOf[worker] = payout;
        emit PayoutSet(worker, payout, nonce);
        _moveEarnings(worker, payout);
    }

    /// @dev Moves unclaimed USDC and recent epoch shares. Moving weight and
    ///      claimed amounts together keeps pending ANTS non-negative, and the
    ///      merged floor never exceeds the two exact shares, so totals hold.
    function _moveEarnings(address from, address to) internal {
        if (from == to) return;
        uint256 usdc = usdcBalance[from];
        if (usdc > 0) {
            usdcBalance[from] = 0;
            usdcBalance[to] += usdc;
            emit EarningsMoved(from, to, usdc);
        }
        (bool hasEpoch, uint256 current) = _tryCurrentEpoch();
        if (!hasEpoch) return;
        uint256 oldest = current > MAX_EPOCHS_PER_CLAIM ? current - MAX_EPOCHS_PER_CLAIM : 0;
        // Weights recorded during the gate cutover sit in the first rewarded
        // epoch, ahead of the current one; move those too.
        (, uint256 newest) = _tryRewardEpoch();
        if (newest < current) newest = current;
        for (uint256 epoch = oldest; epoch <= newest; epoch++) {
            uint256 weight = epochWeight[epoch][from];
            if (weight == 0) continue;
            epochWeight[epoch][from] = 0;
            epochWeight[epoch][to] += weight;
            uint256 claimed = antsClaimed[epoch][from];
            if (claimed > 0) {
                antsClaimed[epoch][from] = 0;
                antsClaimed[epoch][to] += claimed;
            }
        }
    }

    /// @notice Raw (pre-EIP-191-prefix) digest the worker signs to set
    ///         `payout`, using the worker's current nonce.
    function payoutDigest(address worker, address payout, uint256 deadline) external view returns (bytes32) {
        return _payoutDigest(worker, payout, payoutNonce[worker], deadline);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Mint an ERC-8004 agent owned by this pool, for `registerSeller`.
    function registerAgent(string calldata agentURI) external onlyOwner returns (uint256 agentId) {
        agentId = IERC8004AgentRegistration(registry.identityRegistry()).register(agentURI);
        emit AgentRegistered(agentId);
    }

    /// @notice Bind this pool to `agentId` in the seller registry
    ///         (registry.staking()), which only the seller itself can do. The
    ///         pool must own the agent.
    function registerSeller(uint256 agentId) external onlyOwner {
        if (IERC8004Registry(registry.identityRegistry()).ownerOf(agentId) != address(this)) revert NotAgentOwner();
        IAntseedSellerRegistration(registry.staking()).registerSeller(agentId);
        emit SellerRegistered(agentId);
    }

    /// @notice Accept ERC-8004 agents minted with `_safeMint` or transferred in.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function setRemainderRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        remainderRecipient = recipient;
        emit RemainderRecipientSet(recipient);
    }

    /// @notice Pause settlement and emissions pulls. Claims stay open.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Recover USDC held above the sum of claimable balances (e.g.
    ///         a stray transfer). Never touches credited funds.
    function sweepOrphanUsdc(address recipient) external nonReentrant onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        IERC20 usdc = _sellerPayoutToken();
        uint256 balance = usdc.balanceOf(address(this));
        uint256 owed = totalUsdcOwed + totalUsdcHeld;
        if (balance <= owed) return;
        uint256 amount = balance - owed;
        usdc.safeTransfer(recipient, amount);
        emit OrphanUsdcSwept(recipient, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        VIEWS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Last channel cumulative amount recorded for `channelId` on
    ///         the current channels contract.
    function channelCumulative(bytes32 channelId) external view returns (uint128) {
        return _channelCumulative[_channelKey(channelId)];
    }

    /// @notice What `channelId` settled unattributed and still holds for later
    ///         tails (channel units, and the net USDC they paid).
    function heldUnattributed(bytes32 channelId) external view returns (uint256 gross, uint256 net) {
        bytes32 key = _channelKey(channelId);
        HeldChunk[] storage chunks = _held[key];
        for (uint256 i = _heldHead[key]; i < chunks.length; i++) net += chunks[i].net;
        return (_heldUnits[key], net);
    }

    /// @notice What this pool settled on `channelId` and paid `worker` there, read
    ///         together so a worker never compares the two across a settlement.
    function workerCredit(bytes32 channelId, address worker) external view returns (uint128 settled, uint128 credited) {
        bytes32 key = _channelKey(channelId);
        return (_channelCumulative[key], _workerCumulative[key][worker]);
    }

    /// @notice How much of the buyer's attribution to `worker` on `channelId`
    ///         (current channels contract) settlements have paid. It trails the
    ///         buyer-signed amount only while a settlement's delta could not
    ///         cover it; the next settlement pays the rest first.
    function workerCumulative(bytes32 channelId, address worker) external view returns (uint128) {
        return _workerCumulative[_channelKey(channelId)][worker];
    }

    /// @notice ANTS `account` can claim now for funded `epochs`.
    function pendingAnts(address account, uint256[] calldata epochs) external view returns (uint256 total) {
        for (uint256 i = 0; i < epochs.length; i++) {
            total += _pendingAnts(account, epochs[i]);
        }
    }

    /// @notice Parse the worker tail of `metadata`. Returns an empty array
    ///         when the tail is absent or malformed (exactly what settlement
    ///         would attribute).
    function parseWorkerTail(bytes calldata metadata)
        external
        pure
        returns (address[] memory workers, uint128[] memory amounts)
    {
        uint256 n = _validTailCount(metadata);
        workers = new address[](n);
        amounts = new uint128[](n);
        // Shorter metadata than a trailer would underflow the offset below.
        if (n == 0) return (workers, amounts);
        uint256 base = metadata.length - _TAIL_TRAILER_BYTES - _ENTRY_BYTES * n;
        for (uint256 i = 0; i < n; i++) {
            (workers[i], amounts[i]) = _readEntry(metadata, base + _ENTRY_BYTES * i);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL
    // ═══════════════════════════════════════════════════════════════════

    function _attribute(bytes32 channelId, uint128 newCumulative, bytes calldata metadata, uint256 net) internal {
        bytes32 key = _channelKey(channelId);
        uint128 last = _channelCumulative[key];
        (bool hasEpoch, uint256 epoch) = _tryRewardEpoch();

        if (newCumulative <= last) {
            // AntseedChannels settled nothing new, so it did not verify the
            // buyer's signature over `metadata`: ignore the tail entirely.
            if (net > 0) _credit(remainderRecipient, channelId, net, hasEpoch, epoch);
            emit ChannelAttributed(channelId, 0, net, 0, false);
            return;
        }

        uint256 delta = uint256(newCumulative) - uint256(last);
        _channelCumulative[key] = newCumulative;

        // Attribution is paid from this settlement's delta first, then from what
        // earlier settlements on the channel left unattributed.
        Split memory split = Split({ fresh: delta, held: _heldUnits[key], creditedFresh: 0 });
        uint256 n = _validTailCount(metadata);
        if (n > 0) {
            uint256 base = metadata.length - _TAIL_TRAILER_BYTES - _ENTRY_BYTES * n;
            for (uint256 i = 0; i < n; i++) {
                (address worker, uint128 cumulative) = _readEntry(metadata, base + _ENTRY_BYTES * i);
                _payWorker(channelId, key, worker, cumulative, delta, net, split, hasEpoch, epoch);
            }
        }

        // This settlement's unattributed part is held for later tails (rounding
        // with no unattributed part left goes to the remainder now).
        uint256 freshLeft = net - split.creditedFresh;
        if (split.fresh > 0 && freshLeft > 0) {
            _hold(channelId, key, split.fresh, freshLeft, hasEpoch, epoch);
        } else if (freshLeft > 0) {
            _credit(remainderRecipient, channelId, freshLeft, hasEpoch, epoch);
        }

        emit ChannelAttributed(channelId, delta, net, n, n > 0);
    }

    /// @dev Attribution budget left in one settlement: its own delta (`fresh`)
    ///      and what the channel holds (`held`), in channel units, and the net
    ///      USDC credited from its own delta so far.
    struct Split {
        uint256 fresh;
        uint256 held;
        uint256 creditedFresh;
    }

    function _payWorker(
        bytes32 channelId,
        bytes32 key,
        address worker,
        uint128 cumulative,
        uint256 delta,
        uint256 net,
        Split memory split,
        bool hasEpoch,
        uint256 epoch
    ) internal {
        uint128 prev = _workerCumulative[key][worker];
        if (cumulative <= prev) return;
        uint256 workerDelta = uint256(cumulative) - uint256(prev);
        uint256 fromFresh = workerDelta < split.fresh ? workerDelta : split.fresh;
        uint256 rest = workerDelta - fromFresh;
        uint256 fromHeld = rest < split.held ? rest : split.held;
        if (fromFresh + fromHeld == 0) return;
        split.fresh -= fromFresh;
        split.held -= fromHeld;
        // Only what this settlement covered: attribution beyond it stays owed
        // and counts at the next settlement.
        uint128 paidCumulative = prev + uint128(fromFresh + fromHeld);
        _workerCumulative[key][worker] = paidCumulative;
        emit WorkerCumulativeUpdated(channelId, worker, paidCumulative);

        address payout = payoutOf[worker];
        address account = payout == address(0) ? worker : payout;
        // Σ floor(net·fᵢ/delta) ≤ net.
        uint256 amount = (net * fromFresh) / delta;
        split.creditedFresh += amount;
        if (amount > 0) _credit(account, channelId, amount, hasEpoch, epoch);
        if (fromHeld > 0) _drawHeld(channelId, key, account, fromHeld);
    }

    /// @dev Hold `gross` units settled unattributed (paid `net`) on a channel,
    ///      reserving their weight in the epoch they settled in.
    function _hold(bytes32 channelId, bytes32 key, uint256 gross, uint256 net, bool hasEpoch, uint256 epoch) internal {
        HeldChunk[] storage chunks = _held[key];
        uint256 len = chunks.length;
        if (len > _heldHead[key] && chunks[len - 1].hasEpoch == hasEpoch && chunks[len - 1].epoch == epoch) {
            chunks[len - 1].gross += uint128(gross);
            chunks[len - 1].net += uint128(net);
        } else {
            chunks.push(HeldChunk({ gross: uint128(gross), net: uint128(net), epoch: uint64(epoch), hasEpoch: hasEpoch }));
        }
        _heldUnits[key] += gross;
        totalUsdcHeld += net;
        if (hasEpoch) {
            epochHeldWeight[epoch] += net;
            epochTotalWeight[epoch] += net;
        }
        emit UnattributedHeld(channelId, gross, net);
    }

    /// @dev Credit `account` for `units` of a channel's held value, oldest first,
    ///      each part with the weight of the epoch it settled in.
    function _drawHeld(bytes32 channelId, bytes32 key, address account, uint256 units) internal {
        HeldChunk[] storage chunks = _held[key];
        uint256 head = _heldHead[key];
        _heldUnits[key] -= units;
        while (units > 0 && head < chunks.length) {
            HeldChunk storage chunk = chunks[head];
            uint256 take = units < chunk.gross ? units : chunk.gross;
            // A chunk taken whole gives all its net, so no rounding dust stays behind.
            uint256 amount = take == chunk.gross ? chunk.net : (uint256(chunk.net) * take) / chunk.gross;
            chunk.gross -= uint128(take);
            chunk.net -= uint128(amount);
            units -= take;
            _creditHeld(account, channelId, amount, chunk.hasEpoch, chunk.epoch);
            if (chunk.gross == 0) head++;
        }
        _heldHead[key] = head;
    }

    /// @dev Give what a channel still holds to the remainder: it can no longer get a tail.
    function _releaseHeld(bytes32 channelId, bytes32 key) internal {
        HeldChunk[] storage chunks = _held[key];
        uint256 released;
        for (uint256 i = _heldHead[key]; i < chunks.length; i++) {
            uint256 amount = chunks[i].net;
            released += amount;
            _creditHeld(remainderRecipient, channelId, amount, chunks[i].hasEpoch, chunks[i].epoch);
        }
        delete _held[key];
        delete _heldHead[key];
        delete _heldUnits[key];
        if (released > 0) emit HeldReleased(channelId, released);
    }

    /// @dev Credit held USDC: its weight, reserved in the epoch it settled in, moves to `account`.
    function _creditHeld(address account, bytes32 channelId, uint256 amount, bool hasEpoch, uint256 epoch) internal {
        if (amount == 0) return;
        usdcBalance[account] += amount;
        totalUsdcOwed += amount;
        totalUsdcHeld -= amount;
        if (hasEpoch) {
            epochHeldWeight[epoch] -= amount;
            epochWeight[epoch][account] += amount;
        }
        emit UsdcCredited(account, channelId, epoch, amount);
    }

    function _credit(address account, bytes32 channelId, uint256 amount, bool hasEpoch, uint256 epoch) internal {
        usdcBalance[account] += amount;
        totalUsdcOwed += amount;
        if (hasEpoch) {
            epochWeight[epoch][account] += amount;
            epochTotalWeight[epoch] += amount;
        }
        emit UsdcCredited(account, channelId, epoch, amount);
    }

    /// @dev Number of entries in a well-formed tail, or 0 if absent/malformed.
    ///      Never reverts.
    function _validTailCount(bytes calldata metadata) internal pure returns (uint256 n) {
        uint256 len = metadata.length;
        if (len < _MIN_HEAD_BYTES + _TAIL_TRAILER_BYTES + _ENTRY_BYTES) return 0;
        if (bytes32(metadata[len - 32:len]) != WORKER_TAIL_MAGIC) return 0;
        n = uint8(metadata[len - _TAIL_TRAILER_BYTES]);
        if (n == 0 || n > MAX_WORKERS_PER_CHANNEL) return 0;
        if (len < _MIN_HEAD_BYTES + _TAIL_TRAILER_BYTES + _ENTRY_BYTES * n) return 0;

        uint256 base = len - _TAIL_TRAILER_BYTES - _ENTRY_BYTES * n;
        address prevWorker;
        for (uint256 i = 0; i < n; i++) {
            (address worker,) = _readEntry(metadata, base + _ENTRY_BYTES * i);
            // Strictly ascending also rejects duplicates; prevWorker starts at
            // 0, so the first comparison rejects the zero address.
            if (worker <= prevWorker) return 0;
            prevWorker = worker;
        }
    }

    function _readEntry(bytes calldata metadata, uint256 offset)
        internal
        pure
        returns (address worker, uint128 cumulative)
    {
        worker = address(bytes20(metadata[offset:offset + 20]));
        cumulative = uint128(bytes16(metadata[offset + 20:offset + _ENTRY_BYTES]));
    }

    function _pendingAnts(address account, uint256 epoch) internal view returns (uint256) {
        uint256 totalWeight = epochTotalWeight[epoch];
        if (totalWeight == 0) return 0;
        uint256 weight = epochWeight[epoch][account];
        if (weight == 0) return 0;
        uint256 entitled = (epochAnts[epoch] * weight) / totalWeight;
        uint256 claimed = antsClaimed[epoch][account];
        return entitled > claimed ? entitled - claimed : 0;
    }

    function _payoutDigest(address worker, address payout, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(PAYOUT_TAG, block.chainid, address(this), worker, payout, nonce, deadline));
    }

    function _channelKey(bytes32 channelId) internal view returns (bytes32) {
        return keccak256(abi.encode(address(_channels()), channelId));
    }

    /// @dev Settlement must not revert if the registry has no emissions
    ///      contract (AntseedChannels tolerates that too): weights are then
    ///      simply not recorded.
    function _tryCurrentEpoch() internal view returns (bool ok, uint256 epoch) {
        address emissions = registry.emissions();
        if (emissions == address(0)) return (false, 0);
        try IAntseedEmissions(emissions).currentEpoch() returns (uint256 e) {
            return (true, e);
        } catch {
            return (false, 0);
        }
    }

    /// @dev The epoch whose emissions reward a settlement made now. Matches
    ///      AntseedUsageAccounting, which accounts usage settled before its
    ///      `firstRewardedEpoch` under that epoch; other emissions contracts
    ///      reward the current epoch.
    function _tryRewardEpoch() internal view returns (bool ok, uint256 epoch) {
        (ok, epoch) = _tryCurrentEpoch();
        if (!ok) return (ok, epoch);
        try IAntseedRewardedEpochFloor(registry.emissions()).firstRewardedEpoch() returns (uint256 first) {
            if (epoch < first) epoch = first;
        } catch { }
    }

    /// @dev Claim seller emissions, refusing a claim that AntseedEmissionsV2
    ///      would lock in its seller rewards pool: the epoch would be marked
    ///      claimed with nothing reaching this contract, and only the seller
    ///      itself could later release it. Reverting leaves the epoch
    ///      unclaimed upstream until the pool may claim it unlocked.
    function _claimUnlockedSellerEmissions(uint256[] memory epochs) internal returns (uint256 antsAmount) {
        (address lockPool, uint256 lockedBefore) = _lockedSellerRewards();
        // As `_claimSellerEmissions`, but the operator fee is credited, not sent:
        // a pull must work while ANTS transfers are still closed.
        IERC20 antsToken = IERC20(registry.antsToken());
        uint256 beforeBal = antsToken.balanceOf(address(this));
        IAntseedEmissions(registry.emissions()).claimSellerEmissions(epochs);
        uint256 gross = antsToken.balanceOf(address(this)) - beforeBal;
        uint256 fee = _operatorFeeAmount(gross);
        if (fee > 0) antsFeeOwed[operatorFeeRecipient] += fee;
        antsAmount = gross - fee;
        if (lockPool != address(0) && IAntseedLockedSellerRewards(lockPool).lockedRewards(address(this)) > lockedBefore) {
            revert EmissionsLocked();
        }
    }

    function _lockedSellerRewards() internal view returns (address lockPool, uint256 locked) {
        try IAntseedLockingEmissions(registry.emissions()).sellerRewardsPool() returns (address p) {
            if (p == address(0)) return (address(0), 0);
            try IAntseedLockedSellerRewards(p).lockedRewards(address(this)) returns (uint256 l) {
                return (p, l);
            } catch { }
        } catch { }
    }
}
