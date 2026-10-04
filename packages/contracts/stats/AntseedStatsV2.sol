// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedStats} from "../interfaces/IAntseedStats.sol";

interface IAntseedStatsReferralBinder {
    function bindReferral(address buyer, uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs) external;
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
 *         Metadata may carry an attribution tail of five static words in
 *         the ABI head, between the services-array offset word and the
 *         services array itself:
 *
 *           head word S+0  services offset = (S + 6) * 32   (S + 1 without a tail)
 *           head word S+1  bytes32 clientId     ERC-8004 agent id of the client (0: none)
 *           head word S+2  uint256 inviteEpoch  invite issuedEpoch
 *           head word S+3  uint256 inviteIndex  invite index
 *           head word S+4  bytes32 inviteR      EIP-2098 compact signature r
 *           head word S+5  bytes32 inviteVs     EIP-2098 compact signature vs
 *           then the services array (length word + elements)
 *
 *         where S is the number of static head words before the offset (5 for
 *         SpendingAuth metadata v3, 4 for v1/v2 and FreeUsage v1). In ABI
 *         terms the metadata is `abi.encode(<head words>, uint256[] services,
 *         bytes32 clientId, uint256 inviteEpoch, uint256 inviteIndex,
 *         bytes32 inviteR, bytes32 inviteVs)`. The invite is absent when both
 *         `inviteR` and `inviteVs` are zero; a bound buyer's client sends
 *         zeros there (and may keep the tail for clientId attribution).
 *
 *         The tail is covered by the buyer's SpendingAuth / FreeUsageAuth
 *         signature (metadataHash), so neither the seller nor a relayer can
 *         forge or strip it. Stats forwards a present invite to
 *         AntseedReferrals (which recovers the referrer and binds) and every
 *         settlement to AntseedAttributionUsage, which credits the buyer's
 *         recognized points to the client that produced it and to the
 *         buyer's referral. Both are best effort: a rejected forward never
 *         blocks settlement. Any other tail shape (including the retired
 *         two-word referrer/clientId tail) is ignored entirely.
 */
contract AntseedStatsV2 is IAntseedStats, Ownable {

    // ─── Structs ────────────────────────────────────────────────────
    struct Attribution {
        bytes32 clientId;
        uint256 inviteEpoch;
        uint256 inviteIndex;
        bytes32 inviteR;
        bytes32 inviteVs;
    }

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
    /// @dev Attribution tail: clientId, inviteEpoch, inviteIndex, inviteR, inviteVs.
    uint256 private constant TAIL_WORDS = 5;

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
    /// @notice An invite was forwarded for binding; `reason` is the
    ///         Referrals error selector when it was rejected (zero when bound).
    event InviteForwarded(
        address indexed buyer, uint256 inviteEpoch, uint256 inviteIndex, bool bound, bytes4 reason
    );
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
    function decodeAttribution(bytes calldata metadata) external pure returns (Attribution memory) {
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
        Attribution memory attribution = _decodeAttribution(metadata);
        _forwardClient(buyer, uint256(attribution.clientId));
        if (attribution.inviteR != bytes32(0) || attribution.inviteVs != bytes32(0)) {
            _forwardInvite(buyer, attribution);
        }

        // Token stats: a blob too short for the four legacy head words is
        // malformed for stats purposes (the writer's try/catch would swallow
        // a revert here, but only after the forwards above have landed).
        if (metadata.length < LEGACY_STATIC_WORDS * 32) return;
        (, uint256 cumulativeInputTokens, uint256 cumulativeOutputTokens, uint256 cumulativeRequestCount) =
            abi.decode(metadata, (uint256, uint256, uint256, uint256));

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
    /**
     * @dev The attribution tail grows the ABI head by exactly TAIL_WORDS
     *      words, so its presence is detected from the services-array offset:
     *      the offset equals (staticWords + 1) * 32 without a tail and
     *      (staticWords + 1 + TAIL_WORDS) * 32 with one. Offsets are absolute,
     *      so decoders that stop at the services array read identical values
     *      either way.
     */
    function _decodeAttribution(bytes calldata metadata) internal pure returns (Attribution memory a) {
        if (metadata.length < 32) return a;
        uint256 version = uint256(bytes32(metadata[0:32]));
        uint256 staticWords = version == METADATA_V3 ? V3_STATIC_WORDS : LEGACY_STATIC_WORDS;
        uint256 offsetWord = staticWords * 32;
        // Head (with tail) plus the services length word.
        if (metadata.length < offsetWord + (TAIL_WORDS + 2) * 32) return a;
        uint256 servicesOffset = uint256(bytes32(metadata[offsetWord:offsetWord + 32]));
        if (servicesOffset != (staticWords + 1 + TAIL_WORDS) * 32) return a;
        uint256 t = offsetWord + 32;
        a.clientId = bytes32(metadata[t:t + 32]);
        a.inviteEpoch = uint256(bytes32(metadata[t + 32:t + 64]));
        a.inviteIndex = uint256(bytes32(metadata[t + 64:t + 96]));
        a.inviteR = bytes32(metadata[t + 96:t + 128]);
        a.inviteVs = bytes32(metadata[t + 128:t + 160]);
    }

    /// @dev Best effort: a rejected invite (bad signature, expired, over
    ///      quota, used, already bound, self-referral, not a new buyer,
    ///      paused) must never block settlement.
    function _forwardInvite(address buyer, Attribution memory a) internal {
        address sink = referrals;
        if (sink == address(0)) return;
        try IAntseedStatsReferralBinder(sink).bindReferral(buyer, a.inviteEpoch, a.inviteIndex, a.inviteR, a.inviteVs) {
            emit InviteForwarded(buyer, a.inviteEpoch, a.inviteIndex, true, bytes4(0));
        } catch (bytes memory reason) {
            emit InviteForwarded(buyer, a.inviteEpoch, a.inviteIndex, false, reason.length >= 4 ? bytes4(reason) : bytes4(0));
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
