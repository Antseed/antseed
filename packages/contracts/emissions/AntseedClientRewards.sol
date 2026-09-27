// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IERC8004Registry} from "../interfaces/IERC8004Registry.sol";

interface IAntseedClientUsageLedger {
    function clientEpochPoints(uint256 epoch, uint256 clientAgentId) external view returns (uint256);
    function totalClientPointsByEpoch(uint256 epoch) external view returns (uint256);
}

/**
 * @title AntseedClientRewards
 * @notice Emission-funded rewards for client software (Desktop, CLI,
 *         third-party apps), distributed by recognized usage. An
 *         AntseedEmissionsGate controller: an epoch's bucket is split among
 *         clients pro rata to `AntseedClientUsage.clientEpochPoints`, and paid
 *         to each client's ERC-8004 agent owner.
 *
 *         Client usage for an epoch keeps being credited for a while after the
 *         epoch ends (each buyer's trailing settlement lands at its next
 *         settlement or via `flush`), so an epoch becomes claimable only once
 *         a full further epoch has passed, and the epoch total is frozen at
 *         the first claim so every client is paid from the same denominator.
 */
contract AntseedClientRewards is Ownable2Step, Pausable, ReentrancyGuard {
    /// @notice Epochs that must fully elapse after `epoch` before it is claimable.
    uint256 public constant SETTLEMENT_GRACE_EPOCHS = 1;

    IAntseedEmissionsGate public immutable emissionsGate;
    IAntseedClientUsageLedger public immutable clientUsage;
    IERC8004Registry public immutable identityRegistry;

    mapping(uint256 epoch => uint256 points) public frozenTotalPoints;
    mapping(uint256 epoch => bool frozen) public epochFrozen;
    mapping(uint256 epoch => mapping(uint256 clientAgentId => bool claimed)) public claimed;
    mapping(uint256 epoch => uint256 amount) public epochMinted;

    event ClientRewardClaimed(
        uint256 indexed epoch,
        uint256 indexed clientAgentId,
        address indexed recipient,
        uint256 points,
        uint256 totalPoints,
        uint256 amount
    );
    event EpochTotalFrozen(uint256 indexed epoch, uint256 totalPoints);

    error InvalidAddress();
    error EpochNotClaimable();
    error AlreadyClaimed();
    error NothingToClaim();

    constructor(address _emissionsGate, address _clientUsage, address _identityRegistry) Ownable(msg.sender) {
        if (_emissionsGate == address(0) || _clientUsage == address(0) || _identityRegistry == address(0)) {
            revert InvalidAddress();
        }
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
        clientUsage = IAntseedClientUsageLedger(_clientUsage);
        identityRegistry = IERC8004Registry(_identityRegistry);
    }

    // ─── Claims ──────────────────────────────────────────────────────

    /// @notice Mint a client's share of an epoch's bucket to the agent owner.
    ///         Permissionless: anyone may trigger it; funds only ever go to
    ///         `identityRegistry.ownerOf(clientAgentId)`.
    function claim(uint256 clientAgentId, uint256 epoch) external nonReentrant whenNotPaused {
        if (!isClaimable(epoch)) revert EpochNotClaimable();
        if (claimed[epoch][clientAgentId]) revert AlreadyClaimed();
        address recipient = _agentOwner(clientAgentId);
        if (recipient == address(0)) revert InvalidAddress();

        uint256 total = _freezeTotal(epoch);
        uint256 points = clientUsage.clientEpochPoints(epoch, clientAgentId);
        uint256 amount = _share(epoch, points, total);
        if (amount == 0) revert NothingToClaim();

        claimed[epoch][clientAgentId] = true;
        epochMinted[epoch] += amount;
        emissionsGate.claim(epoch, recipient, amount);
        emit ClientRewardClaimed(epoch, clientAgentId, recipient, points, total, amount);
    }

    // ─── Views ───────────────────────────────────────────────────────

    function isClaimable(uint256 epoch) public view returns (bool) {
        return epoch + SETTLEMENT_GRACE_EPOCHS < emissionsGate.currentEpoch();
    }

    /// @notice What a client would receive for an epoch right now.
    function pendingReward(uint256 clientAgentId, uint256 epoch) external view returns (uint256) {
        if (!isClaimable(epoch) || claimed[epoch][clientAgentId]) return 0;
        uint256 total = epochFrozen[epoch] ? frozenTotalPoints[epoch] : clientUsage.totalClientPointsByEpoch(epoch);
        return _share(epoch, clientUsage.clientEpochPoints(epoch, clientAgentId), total);
    }

    // ─── Internal ────────────────────────────────────────────────────

    /// @dev ERC-721 registries revert for unknown ids; treat that as no owner.
    function _agentOwner(uint256 clientAgentId) internal view returns (address) {
        try identityRegistry.ownerOf(clientAgentId) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }

    function _freezeTotal(uint256 epoch) internal returns (uint256 total) {
        if (epochFrozen[epoch]) return frozenTotalPoints[epoch];
        total = clientUsage.totalClientPointsByEpoch(epoch);
        frozenTotalPoints[epoch] = total;
        epochFrozen[epoch] = true;
        emit EpochTotalFrozen(epoch, total);
    }

    function _share(uint256 epoch, uint256 points, uint256 total) internal view returns (uint256) {
        if (points == 0 || total == 0) return 0;
        uint256 budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        uint256 amount = (budget * points) / total;
        uint256 remaining = budget > epochMinted[epoch] ? budget - epochMinted[epoch] : 0;
        return amount < remaining ? amount : remaining;
    }

    // ─── Admin ───────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
