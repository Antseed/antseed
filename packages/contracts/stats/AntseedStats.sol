// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedStats} from "../interfaces/IAntseedStats.sol";

interface IAntseedStatsReferralBinder {
    function bindReferral(address buyer, address referrer) external;
}

/**
 * @title AntseedStats
 * @notice Optional external stats sink keyed by ERC-8004 agentId.
 *         Authorized writers (Channels, FreeUsage) submit the buyer-signed
 *         cumulative per-channel metadata, which is decoded, delta-accounted,
 *         and aggregated.
 *
 *         Metadata may carry an attribution tail — `address referrer,
 *         bytes32 clientId` appended after the services array. The tail is
 *         covered by the buyer's SpendingAuth / FreeUsageAuth signature
 *         (metadataHash), so neither the seller nor a relayer can forge it.
 *         On the first settlement that carries a referrer, Stats forwards the
 *         binding to AntseedReferrals (best effort; a rejected binding never
 *         blocks settlement). Per-client usage totals feed builder incentives.
 */
contract AntseedStats is IAntseedStats, Ownable {

    // ─── Structs ────────────────────────────────────────────────────
    struct ChannelMetadataSnapshot {
        uint256 inputTokens;
        uint256 outputTokens;
        uint256 requestCount;
    }

    struct ClientUsageStats {
        uint256 totalInputTokens;
        uint256 totalOutputTokens;
        uint256 totalRequestCount;
        uint64 lastUpdatedAt;
    }

    // ─── Constants ──────────────────────────────────────────────────
    /// @dev SpendingAuth metadata v3 head: version, in, out, requests, images.
    uint256 private constant METADATA_V3 = 3;
    uint256 private constant V3_STATIC_WORDS = 5;
    /// @dev v1/v2 (and FreeUsage v1) head: version, in, out, requests.
    uint256 private constant LEGACY_STATIC_WORDS = 4;

    // ─── State Variables ────────────────────────────────────────────
    mapping(address => bool) public writers;
    /// @notice AntseedReferrals sink for buyer-signed referrer bindings (zero disables).
    address public referrals;

    mapping(uint256 => mapping(address => BuyerMetadataStats)) private _buyerMetadataStats;
    mapping(bytes32 => ChannelMetadataSnapshot) private _channelSnapshots;
    mapping(bytes32 => ClientUsageStats) private _clientUsageStats;
    /// @notice Last client id seen per buyer (zero when never attributed).
    mapping(address => bytes32) public buyerClient;

    // ─── Events ─────────────────────────────────────────────────────
    event MetadataRecorded(
        uint256 indexed agentId,
        address indexed buyer,
        bytes32 indexed channelId,
        bytes32 metadataHash,
        uint256 inputTokens,
        uint256 outputTokens,
        uint256 requestCount
    );
    event ClientUsageRecorded(
        bytes32 indexed clientId,
        address indexed buyer,
        uint256 indexed agentId,
        uint256 inputTokens,
        uint256 outputTokens,
        uint256 requestCount
    );
    event ReferralForwarded(address indexed buyer, address indexed referrer, bool bound);
    event ReferralsUpdated(address indexed referrals);

    // ─── Custom Errors ──────────────────────────────────────────────
    error InvalidAddress();
    error NotAuthorized();

    // ─── Constructor ────────────────────────────────────────────────
    constructor() Ownable(msg.sender) {}

    // ─── Views ──────────────────────────────────────────────────────
    function getBuyerMetadataStats(uint256 agentId, address buyer) external view returns (BuyerMetadataStats memory) {
        return _buyerMetadataStats[agentId][buyer];
    }

    function getClientUsageStats(bytes32 clientId) external view returns (ClientUsageStats memory) {
        return _clientUsageStats[clientId];
    }

    /// @notice Decode the optional attribution tail. Returns zeros when absent.
    function decodeAttribution(bytes calldata metadata) external pure returns (address referrer, bytes32 clientId) {
        return _decodeAttribution(metadata);
    }

    // ─── Core ───────────────────────────────────────────────────────
    function recordMetadata(
        uint256 agentId,
        address buyer,
        bytes32 channelId,
        bytes calldata metadata
    ) external {
        if (!writers[msg.sender]) revert NotAuthorized();
        if (buyer == address(0)) revert InvalidAddress();

        (uint256 cumulativeInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount) = _decodeMetadata(metadata);

        ChannelMetadataSnapshot storage snapshot = _channelSnapshots[channelId];
        if (
            cumulativeInputTokens < snapshot.inputTokens
                || cumulativeOutputTokens < snapshot.outputTokens
                || cumulativeRequestCount < snapshot.requestCount
        ) {
            return; // non-monotonic metadata — skip silently
        }

        uint256 inputDelta = cumulativeInputTokens - snapshot.inputTokens;
        uint256 outputDelta = cumulativeOutputTokens - snapshot.outputTokens;
        uint256 requestDelta = cumulativeRequestCount - snapshot.requestCount;

        snapshot.inputTokens = cumulativeInputTokens;
        snapshot.outputTokens = cumulativeOutputTokens;
        snapshot.requestCount = cumulativeRequestCount;

        BuyerMetadataStats storage stats = _buyerMetadataStats[agentId][buyer];
        stats.totalInputTokens += inputDelta;
        stats.totalOutputTokens += outputDelta;
        stats.totalRequestCount += requestDelta;
        stats.lastUpdatedAt = uint64(block.timestamp);

        emit MetadataRecorded(
            agentId,
            buyer,
            channelId,
            keccak256(metadata),
            inputDelta,
            outputDelta,
            requestDelta
        );

        (address referrer, bytes32 clientId) = _decodeAttribution(metadata);
        if (clientId != bytes32(0)) {
            _recordClientUsage(clientId, buyer, agentId, inputDelta, outputDelta, requestDelta);
        }
        if (referrer != address(0)) {
            _forwardReferral(buyer, referrer);
        }
    }

    // ─── Internal Helpers ───────────────────────────────────────────
    function _decodeMetadata(bytes calldata metadata)
        internal
        pure
        returns (uint256 cumulativeInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount)
    {
        (, cumulativeInputTokens, cumulativeOutputTokens, cumulativeRequestCount) =
            abi.decode(metadata, (uint256, uint256, uint256, uint256));
    }

    /**
     * @dev The attribution tail grows the ABI head by exactly two words, so
     *      its presence is detected from the services-array offset: the offset
     *      equals (staticWords + 1) * 32 without a tail and
     *      (staticWords + 3) * 32 with one. Offsets are absolute, so decoders
     *      that stop at the services array read identical values either way.
     */
    function _decodeAttribution(bytes calldata metadata) internal pure returns (address referrer, bytes32 clientId) {
        if (metadata.length < 32) return (address(0), bytes32(0));
        uint256 version = uint256(bytes32(metadata[0:32]));
        uint256 staticWords = version == METADATA_V3 ? V3_STATIC_WORDS : LEGACY_STATIC_WORDS;
        uint256 offsetWord = staticWords * 32;
        if (metadata.length < offsetWord + 96) return (address(0), bytes32(0));
        uint256 servicesOffset = uint256(bytes32(metadata[offsetWord:offsetWord + 32]));
        if (servicesOffset != (staticWords + 3) * 32) return (address(0), bytes32(0));
        uint256 referrerWord = uint256(bytes32(metadata[offsetWord + 32:offsetWord + 64]));
        if (referrerWord >> 160 != 0) return (address(0), bytes32(0)); // not a clean address word
        referrer = address(uint160(referrerWord));
        clientId = bytes32(metadata[offsetWord + 64:offsetWord + 96]);
    }

    function _recordClientUsage(
        bytes32 clientId,
        address buyer,
        uint256 agentId,
        uint256 inputDelta,
        uint256 outputDelta,
        uint256 requestDelta
    ) internal {
        ClientUsageStats storage stats = _clientUsageStats[clientId];
        stats.totalInputTokens += inputDelta;
        stats.totalOutputTokens += outputDelta;
        stats.totalRequestCount += requestDelta;
        stats.lastUpdatedAt = uint64(block.timestamp);
        buyerClient[buyer] = clientId;
        emit ClientUsageRecorded(clientId, buyer, agentId, inputDelta, outputDelta, requestDelta);
    }

    /// @dev Best effort: a rejected binding (already bound, prior usage,
    ///      self-referral, paused) must never block settlement.
    function _forwardReferral(address buyer, address referrer) internal {
        address sink = referrals;
        if (sink == address(0)) return;
        try IAntseedStatsReferralBinder(sink).bindReferral(buyer, referrer) {
            emit ReferralForwarded(buyer, referrer, true);
        } catch {
            emit ReferralForwarded(buyer, referrer, false);
        }
    }

    // ─── Admin Functions ────────────────────────────────────────────
    function setWriter(address writer, bool allowed) external onlyOwner {
        if (writer == address(0)) revert InvalidAddress();
        writers[writer] = allowed;
    }

    /// @notice Point at the AntseedReferrals contract (zero disables forwarding).
    function setReferrals(address _referrals) external onlyOwner {
        referrals = _referrals;
        emit ReferralsUpdated(_referrals);
    }
}
