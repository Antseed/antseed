// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

import {IAntseedStats} from "../interfaces/IAntseedStats.sol";

/**
 * @title AntseedStats
 * @notice Optional external stats sink keyed by ERC-8004 agentId.
 *         Authorized writers can submit cumulative per-channel metadata per buyer,
 *         which is decoded, delta-accounted, and aggregated.
 */
contract AntseedStats is IAntseedStats, Ownable {

    // ─── Structs ────────────────────────────────────────────────────
    struct ChannelMetadataSnapshot {
        uint256 inputTokens;
        uint256 outputTokens;
        uint256 requestCount;
    }

    // ─── State Variables ────────────────────────────────────────────
    mapping(address => bool) public writers;

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

    // ─── Custom Errors ──────────────────────────────────────────────
    error InvalidAddress();
    error NotAuthorized();

    // ─── Constructor ────────────────────────────────────────────────
    constructor() Ownable(msg.sender) {}

    // ─── Views ──────────────────────────────────────────────────────
    function getBuyerMetadataStats(uint256 agentId, address buyer) external view returns (BuyerMetadataStats memory) {
        return _buyerMetadataStats[agentId][buyer];
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

    // ─── Admin Functions ────────────────────────────────────────────
    function setWriter(address writer, bool allowed) external onlyOwner {
        if (writer == address(0)) revert InvalidAddress();
        writers[writer] = allowed;
    }
}
