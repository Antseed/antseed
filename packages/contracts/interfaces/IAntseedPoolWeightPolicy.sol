// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Converts a pool's raw epoch stake power into the effective weight
///         used when usage points are pool-weighted. Swappable so the pool
///         multiplier curve (linear, capped, square-root, log, ...) is policy
///         rather than a permanent property of the accounting contract.
interface IAntseedPoolWeightPolicy {
    function poolWeight(uint256 agentId, uint256 epoch, uint256 poolPower) external view returns (uint256);
}
