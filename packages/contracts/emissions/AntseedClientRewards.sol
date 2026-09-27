// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AntseedEpochShareRewards} from "./AntseedEpochShareRewards.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

interface IAntseedClientUsageLedger {
    function clientEpochPoints(uint256 epoch, uint256 clientAgentId) external view returns (uint256);
    function totalClientPointsByEpoch(uint256 epoch) external view returns (uint256);
}

/**
 * @title AntseedClientRewards
 * @notice Emission-funded rewards for client software (Desktop, CLI,
 *         third-party apps), distributed by recognized usage. An epoch's
 *         bucket is split among clients pro rata to
 *         `AntseedAttributionUsage.clientEpochPoints`, and paid to each
 *         client's ERC-8004 agent owner.
 */
contract AntseedClientRewards is AntseedEpochShareRewards {
    IAntseedClientUsageLedger public immutable attributionUsage;
    IERC8004Registry public immutable identityRegistry;

    event ClientRewardClaimed(
        uint256 indexed epoch,
        uint256 indexed clientAgentId,
        address indexed recipient,
        uint256 points,
        uint256 totalPoints,
        uint256 amount
    );

    constructor(address _emissionsGate, address _attributionUsage, address _identityRegistry)
        AntseedEpochShareRewards(_emissionsGate)
    {
        if (_attributionUsage == address(0) || _identityRegistry == address(0)) revert InvalidAddress();
        attributionUsage = IAntseedClientUsageLedger(_attributionUsage);
        identityRegistry = IERC8004Registry(_identityRegistry);
    }

    /// @notice Mint a client's share of an epoch's bucket to the agent owner.
    ///         Permissionless: anyone may trigger it; funds only ever go to
    ///         `identityRegistry.ownerOf(clientAgentId)`.
    function claim(uint256 clientAgentId, uint256 epoch) external nonReentrant whenNotPaused {
        address recipient = _agentOwner(clientAgentId);
        if (recipient == address(0)) revert InvalidAddress();
        uint256 points = attributionUsage.clientEpochPoints(epoch, clientAgentId);
        (uint256 amount, uint256 total) = _claimShare(epoch, bytes32(clientAgentId), points, recipient);
        emit ClientRewardClaimed(epoch, clientAgentId, recipient, points, total, amount);
    }

    function claimed(uint256 epoch, uint256 clientAgentId) external view returns (bool) {
        return _isClaimed(epoch, bytes32(clientAgentId));
    }

    /// @notice What a client would receive for an epoch right now.
    function pendingReward(uint256 clientAgentId, uint256 epoch) external view returns (uint256) {
        return _pending(epoch, bytes32(clientAgentId), attributionUsage.clientEpochPoints(epoch, clientAgentId));
    }

    function _ledgerTotal(uint256 epoch) internal view override returns (uint256) {
        return attributionUsage.totalClientPointsByEpoch(epoch);
    }

    /// @dev ERC-721 registries revert for unknown ids; treat that as no owner.
    function _agentOwner(uint256 clientAgentId) internal view returns (address) {
        try identityRegistry.ownerOf(clientAgentId) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }
}
