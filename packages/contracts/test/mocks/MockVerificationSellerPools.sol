// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal seller pools for verification tests: settable pool power per agent and epoch.
contract MockVerificationSellerPools {
    mapping(uint256 agentId => mapping(uint256 epoch => uint256 weight)) private _power;
    bool public reverts;

    function setPower(uint256 agentId, uint256 epoch, uint256 weight) external {
        _power[agentId][epoch] = weight;
    }

    function setReverts(bool value) external {
        reverts = value;
    }

    function poolWeightAtEpoch(uint256 agentId, uint256 epoch) external view returns (uint256) {
        if (reverts) revert("pools down");
        return _power[agentId][epoch];
    }
}
