// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Seller-facing surface of AntseedUsageRewards used by the
///         registry-emissions adapter to serve deployed seller delegation
///         contracts (e.g. DiemStakingProxy).
interface IAntseedUsageRewards {
    function agentEpochClaimed(uint256 agentId, uint256 epoch) external view returns (bool);
    function pendingAgentReward(uint256 agentId, uint256 epoch) external view returns (uint256 amount);
    function rewardRecipient(uint256 agentId) external view returns (address);
    function claimAgentRewardFor(address seller, uint256 agentId, uint256 epoch) external;
}
