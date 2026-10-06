// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal emissions gate for verification reward tests: one controller budget per epoch.
contract MockVerificationEmissionsGate {
    uint256 public currentEpoch;
    mapping(address controller => mapping(uint256 epoch => uint256 budget)) public controllerEpochBudget;
    mapping(uint256 epoch => uint256 minted) public epochMinted;
    mapping(address recipient => uint256 amount) public minted;

    error EpochNotFinalized();
    error BucketBudgetExceeded();

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }

    function setBudget(address controller, uint256 epoch, uint256 budget) external {
        controllerEpochBudget[controller][epoch] = budget;
    }

    function claim(uint256 epoch, address recipient, uint256 amount) external {
        if (epoch >= currentEpoch) revert EpochNotFinalized();
        epochMinted[epoch] += amount;
        if (epochMinted[epoch] > controllerEpochBudget[msg.sender][epoch]) revert BucketBudgetExceeded();
        minted[recipient] += amount;
    }
}
