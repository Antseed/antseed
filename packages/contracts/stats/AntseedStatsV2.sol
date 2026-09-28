// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedStats} from "../interfaces/IAntseedStats.sol";

interface IAntseedStatsReferralBinder {
    function bindReferral(address buyer, address referrer) external;
}

interface IAntseedStatsAttributionUsage {
    function record(address buyer, uint256 clientAgentId) external;
}

/**
 * @title AntseedStatsV2
 * @notice Optional external stats sink keyed by ERC-8004 agentId. Supersedes
 *         AntseedStats: same writer interface (`registry.stats()` is simply
 *         re-pointed), plus decoding of the buyer-signed attribution tail.
 *         Authorized writers (Channels, FreeUsage) submit the buyer-signed
 *         cumulative per-channel metadata, which is decoded, delta-accounted,
 *         and aggregated.
 *
 *         Metadata may carry an attribution tail — `address referrer,
 *         bytes32 clientId` appended after the services array. The tail is
 *         covered by the buyer's SpendingAuth / FreeUsageAuth signature
 *         (metadataHash), so neither the seller nor a relayer can forge it.
 *         Stats forwards the referrer to AntseedReferrals (bound on the buyer's
 *         first settlement) and every settlement to AntseedAttributionUsage,
 *         which credits the buyer's recognized points to the client that
 *         produced it and to the buyer's referrer. Both are best effort: a
 *         rejected forward never blocks settlement.
 */
contract AntseedStatsV2 is IAntseedStats, Ownable {

    // ─── Structs ────────────────────────────────────────────────────
    struct ChannelMetadataSnapshot {
        uint256 inputTokens;
        uint256 outputTokens;
        uint256 requestCount;
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
    /// @notice AntseedAttributionUsage ledger for per-client / per-referrer recognized usage (zero disables).
    address public attributionUsage;

    mapping(uint256 => mapping(address => BuyerMetadataStats)) private _buyerMetadataStats;
    mapping(bytes32 => ChannelMetadataSnapshot) private _channelSnapshots;

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
    event ReferralForwarded(address indexed buyer, address indexed referrer, bool bound);
    event ClientForwarded(address indexed buyer, uint256 indexed clientAgentId, bool recorded);
    event ReferralsUpdated(address indexed referrals);
    event AttributionUsageUpdated(address indexed attributionUsage);

    // ─── Custom Errors ──────────────────────────────────────────────
    error InvalidAddress();
    error NotAuthorized();

    // ─── Constructor ────────────────────────────────────────────────
    constructor() Ownable(msg.sender) {}

    // ─── Views ──────────────────────────────────────────────────────
    function getBuyerMetadataStats(uint256 agentId, address buyer) external view returns (BuyerMetadataStats memory) {
        return _buyerMetadataStats[agentId][buyer];
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

        // Attribution first, unconditionally: Channels accrues this
        // settlement's points whatever the token counters say, so the ledger
        // must see every settlement to keep its per-buyer cursor exact. A
        // settlement skipped below for stats purposes would otherwise credit
        // its points to the previous cursor's client and epoch. Forwarded
        // even with a zero client for the same reason.
        (address referrer, bytes32 clientId) = _decodeAttribution(metadata);
        _forwardClient(buyer, uint256(clientId));
        if (referrer != address(0)) {
            _forwardReferral(buyer, referrer);
        }

        // Token stats: a blob too short for the four legacy head words is
        // malformed for stats purposes (the writer's try/catch would swallow
        // a revert here, but only after the forwards above have landed).
        if (metadata.length < LEGACY_STATIC_WORDS * 32) return;
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
        clientId = bytes32(metadata[offsetWord + 64:offsetWord + 96]); // ERC-8004 agent id of the client
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

    /// @dev Best effort: the attribution ledger reads the buyer's recognized
    ///      points and must never block settlement.
    function _forwardClient(address buyer, uint256 clientAgentId) internal {
        address sink = attributionUsage;
        if (sink == address(0)) return;
        try IAntseedStatsAttributionUsage(sink).record(buyer, clientAgentId) {
            emit ClientForwarded(buyer, clientAgentId, true);
        } catch {
            emit ClientForwarded(buyer, clientAgentId, false);
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

    /// @notice Point at the AntseedAttributionUsage ledger (zero disables forwarding).
    function setAttributionUsage(address _attributionUsage) external onlyOwner {
        attributionUsage = _attributionUsage;
        emit AttributionUsageUpdated(_attributionUsage);
    }
}
