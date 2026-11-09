// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAntseedRegistry} from "../interfaces/IAntseedRegistry.sol";
import {IAntseedStats} from "../interfaces/IAntseedStats.sol";
import {IAntseedUsageAccounting} from "../interfaces/IAntseedUsageAccounting.sol";

interface IAntseedMiddlewareReferrals {
    function bindReferral(address buyer, uint256 issuedEpoch, uint256 index, bytes32 r, bytes32 vs) external;
}

interface IAntseedMiddlewareClientRewards {
    function creditClientUsage(uint256 clientAgentId, address buyer, uint256 points) external;
}

/**
 * @title AntseedChannelsMiddleware
 * @notice Sits between the payment contracts and the rest of the protocol, so
 *         attribution lands inside a settlement without changing any deployed
 *         contract. AntseedChannels and AntseedFreeUsage are pointed here with
 *         `setRegistry`. This contract answers `stats()` and `emissions()` with
 *         itself and every other registry getter from the main registry, which
 *         stays untouched for everything else that reads it.
 *
 *         A paid settlement then runs:
 *           1. `recordMetadata`: decode the buyer-signed attribution tail, note
 *              the client for this transaction, forward any invite to
 *              AntseedReferrals, and forward the metadata to the live Stats.
 *           2. `accrueSellerPoints`: forward to AntseedUsageAccounting.
 *           3. `accrueBuyerPoints`: forward to AntseedUsageAccounting, and credit
 *              the growth in the buyer's weighted points to the noted client.
 *
 *         Points are the accounting's, so wash exclusion and verification
 *         shaping are already applied, and every credit lands in the epoch that
 *         settled it. Free usage earns no points: it only forwards invites.
 *
 *         Forwards to Stats, Referrals and Client Rewards are best effort. They
 *         must never block a settlement. Only the forwards to the accounting
 *         can revert, exactly as they do when Channels calls it directly.
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
 *         where S is the number of static head words before the offset (8 for
 *         SpendingAuth metadata v5, 7 for v4, 5 for v3, 4 for v1/v2 and
 *         FreeUsage v1). In ABI terms the metadata is `abi.encode(<head words>,
 *         uint256[] services, bytes32 clientId, uint256 inviteEpoch,
 *         uint256 inviteIndex, bytes32 inviteR, bytes32 inviteVs)`. The invite is
 *         absent when both `inviteR` and `inviteVs` are zero. The tail is covered
 *         by the buyer's signature (metadataHash), so neither the seller nor a
 *         relayer can forge or strip it. Any other tail shape is ignored.
 *
 *         Nothing here is configurable. To change anything, deploy a new
 *         middleware and call `setRegistry` again; `setRegistry` back to the main
 *         registry removes it. That includes moving the accounting:
 *         `mainRegistry.setEmissions` no longer reaches Channels while it is
 *         routed through this contract.
 */
contract AntseedChannelsMiddleware is IAntseedRegistry {
    struct Attribution {
        bytes32 clientId;
        uint256 inviteEpoch;
        uint256 inviteIndex;
        bytes32 inviteR;
        bytes32 inviteVs;
    }

    /// @dev SpendingAuth metadata v5 head: the v4 head plus input characters.
    uint256 private constant METADATA_V5 = 5;
    uint256 private constant V5_STATIC_WORDS = 8;
    /// @dev SpendingAuth metadata v4 head: version, in, out, requests, images, video generations, video seconds.
    uint256 private constant METADATA_V4 = 4;
    uint256 private constant V4_STATIC_WORDS = 7;
    /// @dev SpendingAuth metadata v3 head: version, in, out, requests, images.
    uint256 private constant METADATA_V3 = 3;
    uint256 private constant V3_STATIC_WORDS = 5;
    /// @dev v1/v2 (and FreeUsage v1) head: version, in, out, requests.
    uint256 private constant LEGACY_STATIC_WORDS = 4;
    /// @dev Attribution tail: clientId, inviteEpoch, inviteIndex, inviteR, inviteVs.
    uint256 private constant TAIL_WORDS = 5;

    /// @dev Transient slot holding the client between `recordMetadata` and
    ///      `accrueBuyerPoints`. Both run in one transaction, one settlement at
    ///      a time, so one slot is enough and it can never outlive the settlement.
    bytes32 private constant PENDING_CLIENT_SLOT = keccak256("antseed.channelsMiddleware.pendingClient");

    IAntseedRegistry public immutable mainRegistry;
    IAntseedUsageAccounting public immutable usageAccounting;
    IAntseedMiddlewareClientRewards public immutable clientRewards;
    IAntseedMiddlewareReferrals public immutable referrals;
    address public immutable channelsContract;
    address public immutable freeUsageContract;

    /// @notice An invite was forwarded for binding; `reason` is the Referrals
    ///         error selector when it was rejected (zero when bound).
    event InviteForwarded(address indexed buyer, uint256 inviteEpoch, uint256 inviteIndex, bool bound, bytes4 reason);
    /// @notice Client Rewards refused a credit. The settlement went through.
    event ClientCreditFailed(address indexed buyer, uint256 indexed clientAgentId, uint256 points);

    error InvalidAddress();
    error NotAuthorized();

    constructor(
        address _mainRegistry,
        address _usageAccounting,
        address _clientRewards,
        address _referrals,
        address _channels,
        address _freeUsage
    ) {
        // A call to an address without code reverts outside a try/catch, which
        // would block settlements, so every collaborator must exist up front.
        if (
            _mainRegistry.code.length == 0 || _usageAccounting.code.length == 0 || _clientRewards.code.length == 0
                || _referrals.code.length == 0
        ) revert InvalidAddress();
        if (_channels == address(0) || _freeUsage == address(0)) revert InvalidAddress();
        mainRegistry = IAntseedRegistry(_mainRegistry);
        usageAccounting = IAntseedUsageAccounting(_usageAccounting);
        clientRewards = IAntseedMiddlewareClientRewards(_clientRewards);
        referrals = IAntseedMiddlewareReferrals(_referrals);
        channelsContract = _channels;
        freeUsageContract = _freeUsage;
    }

    // ─── Stats and emissions, as Channels and FreeUsage see them ─────

    function stats() external view returns (address) {
        return address(this);
    }

    function emissions() external view returns (address) {
        return address(this);
    }

    /// @notice Same interface as AntseedStats. Channels and FreeUsage call it
    ///         inside a try/catch.
    function recordMetadata(uint256 agentId, address buyer, bytes32 channelId, bytes calldata metadata) external {
        bool paid = msg.sender == channelsContract;
        if (!paid && msg.sender != freeUsageContract) revert NotAuthorized();

        Attribution memory attribution = _decodeAttribution(metadata);
        if (attribution.inviteR != bytes32(0) || attribution.inviteVs != bytes32(0)) {
            _forwardInvite(buyer, attribution);
        }
        // AntseedFreeUsage is not a writer on the live Stats, so free usage adds
        // no token stats today, and this keeps it that way.
        if (!paid) return;

        _setPendingClient(uint256(attribution.clientId));
        address liveStats = mainRegistry.stats();
        if (liveStats == address(0)) return;
        try IAntseedStats(liveStats).recordMetadata(agentId, buyer, channelId, metadata) {} catch {}
    }

    function accrueSellerPoints(address seller, uint256 pointsDelta) external {
        if (msg.sender != channelsContract) revert NotAuthorized();
        usageAccounting.accrueSellerPoints(seller, pointsDelta);
    }

    function accrueBuyerPoints(address buyer, uint256 pointsDelta) external {
        if (msg.sender != channelsContract) revert NotAuthorized();

        uint256 client = _pendingClient();
        if (client == 0) {
            usageAccounting.accrueBuyerPoints(buyer, pointsDelta);
            return;
        }
        _setPendingClient(0);

        uint256 before = usageAccounting.buyerUsageTotal(buyer).weightedPoints;
        usageAccounting.accrueBuyerPoints(buyer, pointsDelta);
        uint256 current = usageAccounting.buyerUsageTotal(buyer).weightedPoints;
        if (current <= before) return;

        uint256 points = current - before;
        try clientRewards.creditClientUsage(client, buyer, points) {}
        catch {
            emit ClientCreditFailed(buyer, client, points);
        }
    }

    /// @notice Decode the optional attribution tail. Returns zeros when absent.
    function decodeAttribution(bytes calldata metadata) external pure returns (Attribution memory) {
        return _decodeAttribution(metadata);
    }

    // ─── Everything else is the main registry's answer ───────────────

    function channels() external view returns (address) {
        return mainRegistry.channels();
    }

    function deposits() external view returns (address) {
        return mainRegistry.deposits();
    }

    function staking() external view returns (address) {
        return mainRegistry.staking();
    }

    function antsToken() external view returns (address) {
        return mainRegistry.antsToken();
    }

    function identityRegistry() external view returns (address) {
        return mainRegistry.identityRegistry();
    }

    function protocolReserve() external view returns (address) {
        return mainRegistry.protocolReserve();
    }

    function teamWallet() external view returns (address) {
        return mainRegistry.teamWallet();
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev Words before the services-array offset in each known metadata version's ABI head.
    function _metadataStaticWords(uint256 version) private pure returns (uint256) {
        if (version == METADATA_V5) return V5_STATIC_WORDS;
        if (version == METADATA_V4) return V4_STATIC_WORDS;
        if (version == METADATA_V3) return V3_STATIC_WORDS;
        return LEGACY_STATIC_WORDS;
    }

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
        // A future version has an unknown head, so a tail cannot be located in it.
        if (version > METADATA_V5) return a;
        uint256 staticWords = _metadataStaticWords(version);
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
        try referrals.bindReferral(buyer, a.inviteEpoch, a.inviteIndex, a.inviteR, a.inviteVs) {
            emit InviteForwarded(buyer, a.inviteEpoch, a.inviteIndex, true, bytes4(0));
        } catch (bytes memory reason) {
            emit InviteForwarded(buyer, a.inviteEpoch, a.inviteIndex, false, reason.length >= 4 ? bytes4(reason) : bytes4(0));
        }
    }

    function _setPendingClient(uint256 client) private {
        bytes32 slot = PENDING_CLIENT_SLOT;
        assembly ("memory-safe") {
            tstore(slot, client)
        }
    }

    function _pendingClient() private view returns (uint256 client) {
        bytes32 slot = PENDING_CLIENT_SLOT;
        assembly ("memory-safe") {
            client := tload(slot)
        }
    }
}
