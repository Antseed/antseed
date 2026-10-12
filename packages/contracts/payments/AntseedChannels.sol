// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedDeposits} from "../interfaces/IAntseedDeposits.sol";
import {IAntseedStaking} from "../interfaces/IAntseedStaking.sol";
import {IAntseedEmissions} from "../interfaces/IAntseedEmissions.sol";
import {IAntseedStats} from "../interfaces/IAntseedStats.sol";

/**
 * @title AntseedChannels
 * @notice Channel lifecycle with built-in cumulative payment channels.
 *         USDC stays in AntseedDeposits — this contract holds none.
 *
 *         The buyer signs a single EIP-712 SpendingAuth on every request:
 *         - cumulativeAmount: total USDC authorized so far
 *         - metadataHash: hash of buyer metadata bytes. Current metadata starts
 *           with (version, cumulativeInputTokens, cumulativeOutputTokens,
 *           cumulativeRequestCount) and may append off-chain indexer fields.
 *
 *         Money flow:
 *           reserve:  Deposits locks buyer funds
 *           settle:   Deposits charges buyer, credits seller earnings
 *           close:    Deposits charges buyer, credits seller, releases remaining
 *           timeout:  Deposits releases locked funds back to buyer
 *
 *         Contract is swappable: deploy a new version and re-point via AntseedRegistry.
 */
contract AntseedChannels is EIP712, Pausable, Ownable, ReentrancyGuard {

    // ─── EIP-712 ─────────────────────────────────────────────────────
    bytes32 public constant SPENDING_AUTH_TYPEHASH = keccak256(
        "SpendingAuth(bytes32 channelId,uint256 cumulativeAmount,bytes32 metadataHash)"
    );

    bytes32 public constant RESERVE_AUTH_TYPEHASH = keccak256(
        "ReserveAuth(bytes32 channelId,uint128 maxAmount,uint256 deadline)"
    );

    // ─── Configurable Constants ─────────────────────────────────────
    uint256 public FIRST_SIGN_CAP = 1_000_000;
    uint256 public PLATFORM_FEE_BPS = 200;
    uint256 public MAX_PLATFORM_FEE_BPS = 1000;
    uint256 public TIMEOUT_GRACE_PERIOD = 15 minutes;
    uint256 public TOP_UP_SETTLED_THRESHOLD_BPS = 8500;

    // ─── Enums & Structs ────────────────────────────────────────────
    enum ChannelStatus { None, Active, Settled, TimedOut }

    struct Channel {
        address buyer;
        address seller;
        uint128 deposit;              // total USDC locked in Deposits for this channel
        uint128 settled;              // last settled cumulative amount
        bytes32 metadataHash;         // latest metadata hash (for auditability)
        uint256 deadline;
        uint256 settledAt;
        uint256 closeRequestedAt;     // timestamp when timeout was requested (0 = not requested)
        ChannelStatus status;
    }

    // ─── Agent Stats ─────────────────────────────────────────────────
    struct AgentStats {
        uint64 channelCount;
        uint64 ghostCount;
        uint256 totalVolumeUsdc;
        uint64 lastSettledAt;
    }

    // ─── State Variables ────────────────────────────────────────────
    IAntseedRegistry public registry;

    mapping(bytes32 => Channel) public channels;
    mapping(address => uint256) public activeChannelCount;
    mapping(uint256 => AgentStats) private _agentStats;

    // ─── Events ─────────────────────────────────────────────────────
    event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount);
    event ChannelSettled(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 cumulativeAmount, uint128 delta, uint128 totalSettled, uint256 platformFee, bytes metadata);
    event ChannelClosed(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 settledAmount, uint128 refund);
    event ChannelTopUp(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 additionalAmount, uint128 newDeposit);
    event CloseRequested(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint256 gracePeriodEnd);
    event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 refund);

    // ─── Custom Errors ──────────────────────────────────────────────
    error InvalidAddress();
    error InvalidAmount();
    error InvalidSignature();
    error ChannelExists();
    error ChannelNotActive();
    error ChannelExpired();
    error NotAuthorized();
    error InvalidFee();
    error FirstSignCapExceeded();
    error SellerNotStaked();
    error FinalAmountBelowSettled();
    error CloseNotReady();
    error CloseAlreadyRequested();
    error TopUpThresholdNotMet();
    error TopUpAmountTooLow();

    // ─── Constructor ────────────────────────────────────────────────
    constructor(address _registry)
        EIP712("AntseedChannels", "1")
        Ownable(msg.sender)
    {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    // ─── Domain Separator Helper ────────────────────────────────────
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── Channel ID computation ─────────────────────────────────────
    function computeChannelId(
        address buyer,
        address seller,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(buyer, seller, salt));
    }

    function getAgentStats(uint256 agentId) external view returns (AgentStats memory) {
        return _agentStats[agentId];
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — RESERVE
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Open a payment channel. Seller calls this.
     *         USDC is pulled from buyer's Deposits balance into this contract.
     *
     * @param buyer        The buyer's address (signs ReserveAuth off-chain)
     * @param salt         Random salt for deterministic channel ID
     * @param maxAmount    USDC amount to lock
     * @param deadline     Channel deadline (for timeout protection)
     * @param buyerSig     Buyer's EIP-712 ReserveAuth signature over
     *                     (bytes32 channelId, uint128 maxAmount, uint256 deadline)
     */
    function reserve(
        address buyer,
        bytes32 salt,
        uint128 maxAmount,
        uint256 deadline,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        if (block.timestamp > deadline) revert ChannelExpired();
        if (!IAntseedStaking(registry.staking()).isStakedAboveMin(msg.sender)) revert SellerNotStaked();
        if (maxAmount == 0) revert InvalidAmount();

        bytes32 channelId = computeChannelId(buyer, msg.sender, salt);

        if (channels[channelId].status != ChannelStatus.None) revert ChannelExists();
        if (maxAmount > FIRST_SIGN_CAP) revert FirstSignCapExceeded();

        // Verify buyer's ReserveAuth signature — binds channelId, maxAmount, deadline
        _verifyReserveAuth(channelId, maxAmount, deadline, buyer, buyerSig);

        channels[channelId] = Channel({
            buyer: buyer,
            seller: msg.sender,
            deposit: maxAmount,
            settled: 0,
            metadataHash: bytes32(0),
            deadline: deadline,
            settledAt: 0,
            closeRequestedAt: 0,
            status: ChannelStatus.Active
        });

        activeChannelCount[msg.sender]++;

        // External call last (checks-effects-interactions)
        IAntseedDeposits(registry.deposits()).lockForChannel(buyer, maxAmount);

        emit Reserved(channelId, buyer, msg.sender, maxAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — TOP UP (extend reserve)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Top up an active channel by increasing the reserve ceiling.
     *         Seller calls this when the buyer's cumulative spending approaches
     *         the current deposit. Requires at least 85% of the current deposit
     *         to be settled (proven via SpendingAuth) before allowing more funds.
     *         Accepts the latest SpendingAuth to settle before raising the ceiling.
     *
     * @param channelId        Channel ID
     * @param cumulativeAmount Current cumulative spend (0 if nothing to settle)
     * @param metadata         ABI-encoded metadata for the SpendingAuth
     * @param spendingSig      Buyer's SpendingAuth signature (ignored if cumulativeAmount <= settled)
     * @param newMaxAmount     New deposit ceiling (must be > current deposit)
     * @param deadline         New deadline for the channel
     * @param reserveSig       Buyer's ReserveAuth signature for the new ceiling
     */
    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) external nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        if (msg.sender != channel.seller) revert NotAuthorized();
        if (channel.closeRequestedAt != 0) revert CloseAlreadyRequested();
        if (block.timestamp > deadline) revert ChannelExpired();
        if (newMaxAmount <= channel.deposit) revert TopUpAmountTooLow();

        // Settle current spend if there's a new delta
        if (cumulativeAmount > channel.settled) {
            if (cumulativeAmount > channel.deposit) revert InvalidAmount();
            _settleSpend(channelId, channel, cumulativeAmount, metadata, spendingSig);
        }

        // Require at least 85% of current deposit to be settled before topping up
        uint256 threshold = (uint256(channel.deposit) * TOP_UP_SETTLED_THRESHOLD_BPS) / 10000;
        if (channel.settled < threshold) revert TopUpThresholdNotMet();

        // Verify buyer's ReserveAuth signature for the new ceiling
        _verifyReserveAuth(channelId, newMaxAmount, deadline, channel.buyer, reserveSig);

        // Lock the additional amount in Deposits
        uint128 additionalAmount = newMaxAmount - channel.deposit;
        IAntseedDeposits(registry.deposits()).lockForChannel(channel.buyer, additionalAmount);

        // Update channel
        channel.deposit = newMaxAmount;
        channel.deadline = deadline;

        emit ChannelTopUp(channelId, channel.buyer, channel.seller, additionalAmount, newMaxAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — SETTLE (mid-channel checkpoint)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Settle partial payment. Seller submits buyer's SpendingAuth signature.
     *         The delta USDC is distributed to seller (minus platform fee).
     *         Channel stays active for more requests.
     */
    function settle(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        if (msg.sender != channel.seller) revert NotAuthorized();
        if (cumulativeAmount <= channel.settled) revert InvalidAmount();
        if (cumulativeAmount > channel.deposit) revert InvalidAmount();

        _settleSpend(channelId, channel, cumulativeAmount, metadata, buyerSig);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CORE — CLOSE (final settle + refund)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Close the channel with a final settlement.
     *         If finalAmount == channel.settled, no signature is required —
     *         the seller can close without a new SpendingAuth (forfeiting
     *         any unproven spend). Otherwise a buyer SpendingAuth is verified.
     */
    function close(
        bytes32 channelId,
        uint128 finalAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) external nonReentrant whenNotPaused {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        if (msg.sender != channel.seller) revert NotAuthorized();
        if (finalAmount < channel.settled) revert FinalAmountBelowSettled();
        if (finalAmount > channel.deposit) revert InvalidAmount();

        // Settle any new spend
        if (finalAmount > channel.settled) {
            _settleSpend(channelId, channel, finalAmount, metadata, buyerSig);
        }

        uint128 unsettled = channel.deposit - channel.settled;

        channel.status = ChannelStatus.Settled;
        activeChannelCount[channel.seller]--;

        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
        if (agentId > 0) {
            _agentStats[agentId].channelCount++;
        }

        // Release remaining reserved funds back to buyer
        if (unsettled > 0) {
            IAntseedDeposits(registry.deposits()).releaseLock(channel.buyer, unsettled);
        }

        emit ChannelClosed(channelId, channel.buyer, channel.seller, channel.settled, unsettled);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        REQUEST CLOSE + WITHDRAW
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @notice Request channel close. Buyer-only, callable anytime.
     *         Starts a grace period during which the seller can still
     *         call settle() or close() with the latest SpendingAuth.
     *         After the grace period, the buyer can withdraw remaining funds.
     */
    function requestClose(bytes32 channelId) external {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        _requireOperator(channel.buyer);
        if (channel.closeRequestedAt != 0) revert CloseAlreadyRequested();

        channel.closeRequestedAt = block.timestamp;
        emit CloseRequested(channelId, channel.buyer, channel.seller, block.timestamp + TIMEOUT_GRACE_PERIOD);
    }

    /**
     * @notice Withdraw remaining funds after close grace period.
     *         Returns unspent USDC to buyer's Deposits balance.
     *         Buyer-only, after TIMEOUT_GRACE_PERIOD has elapsed since requestClose.
     */
    function withdraw(bytes32 channelId) external nonReentrant {
        Channel storage channel = channels[channelId];
        if (channel.status != ChannelStatus.Active) revert ChannelNotActive();
        _requireOperator(channel.buyer);
        if (channel.closeRequestedAt == 0) revert CloseNotReady();
        if (block.timestamp < channel.closeRequestedAt + TIMEOUT_GRACE_PERIOD) revert CloseNotReady();

        uint128 remainingReserved = channel.deposit - channel.settled;

        channel.status = ChannelStatus.TimedOut;
        activeChannelCount[channel.seller]--;

        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
        if (agentId > 0) {
            if (channel.settled == 0) {
                _agentStats[agentId].ghostCount++;
            } else {
                _agentStats[agentId].channelCount++;
            }
        }

        // External call last (checks-effects-interactions)
        if (remainingReserved > 0) {
            IAntseedDeposits(registry.deposits()).releaseLock(channel.buyer, remainingReserved);
        }

        emit ChannelWithdrawn(channelId, channel.buyer, channel.seller, remainingReserved);
    }




    /// @dev Check that msg.sender is the buyer's authorized operator (stored in Deposits).
    function _requireOperator(address buyer) internal view {
        if (msg.sender != IAntseedDeposits(registry.deposits()).getOperator(buyer)) revert NotAuthorized();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════

    /**
     * @dev Shared settle logic: verify SpendingAuth, charge delta, update state, record stats.
     *      Used by settle(), close(), and topUp().
     */
    function _settleSpend(
        bytes32 channelId,
        Channel storage channel,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata buyerSig
    ) internal {
        bytes32 metadataHash = keccak256(metadata);
        _verifySpendingAuth(channelId, cumulativeAmount, metadataHash, channel.buyer, buyerSig);

        uint128 delta = cumulativeAmount - channel.settled;

        if (delta == 0) return;

        uint256 platformFee = (uint256(delta) * PLATFORM_FEE_BPS) / 10000;

        channel.settled = cumulativeAmount;
        channel.metadataHash = metadataHash;
        channel.settledAt = block.timestamp;

        uint256 agentId = IAntseedStaking(registry.staking()).getAgentId(channel.seller);
        if (agentId > 0) {
            AgentStats storage s = _agentStats[agentId];
            s.totalVolumeUsdc += delta;
            s.lastSettledAt = uint64(block.timestamp);
            _syncExternalMetadata(agentId, channel.buyer, channelId, metadata);
        }

        address _emissions = registry.emissions();
        if (_emissions != address(0)) {
            IAntseedEmissions(_emissions).accrueSellerPoints(channel.seller, delta);
            IAntseedEmissions(_emissions).accrueBuyerPoints(channel.buyer, delta);
        }

        // External calls last (checks-effects-interactions)
        IAntseedDeposits(registry.deposits()).chargeAndCreditPayouts(
            channel.buyer,
            channel.seller,
            delta,
            platformFee
        );

        emit ChannelSettled(channelId, channel.buyer, channel.seller, cumulativeAmount, delta, channel.settled, platformFee, metadata);
    }

    function _syncExternalMetadata(
        uint256 agentId,
        address buyer,
        bytes32 channelId,
        bytes calldata metadata
    ) internal {
        address statsContract = registry.stats();
        if (statsContract == address(0)) return;
        try IAntseedStats(statsContract).recordMetadata(agentId, buyer, channelId, metadata) {}
        catch {}
    }

    function _verifyReserveAuth(
        bytes32 channelId,
        uint128 maxAmount,
        uint256 deadline,
        address buyer,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                RESERVE_AUTH_TYPEHASH,
                channelId,
                maxAmount,
                deadline
            )
        );
        _verifySignature(structHash, signature, buyer);
    }

    function _verifySpendingAuth(
        bytes32 channelId,
        uint256 cumulativeAmount,
        bytes32 metadataHash,
        address buyer,
        bytes calldata signature
    ) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                SPENDING_AUTH_TYPEHASH,
                channelId,
                cumulativeAmount,
                metadataHash
            )
        );
        _verifySignature(structHash, signature, buyer);
    }

    function _verifySignature(
        bytes32 structHash,
        bytes calldata signature,
        address signer
    ) internal view {
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != signer) revert InvalidSignature();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
    }

    function setFirstSignCap(uint256 value) external onlyOwner {
        FIRST_SIGN_CAP = value;
    }

    function setPlatformFeeBps(uint256 value) external onlyOwner {
        if (value > MAX_PLATFORM_FEE_BPS) revert InvalidFee();
        PLATFORM_FEE_BPS = value;
    }

    function setTopUpSettledThresholdBps(uint256 value) external onlyOwner {
        if (value > 10000) revert InvalidAmount();
        TOP_UP_SETTLED_THRESHOLD_BPS = value;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
