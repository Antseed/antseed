// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal seller pools for verification tests: settable pool power per agent and epoch,
///         and a settable seller-to-agent binding.
contract MockVerificationSellerPools {
    mapping(uint256 agentId => mapping(uint256 epoch => uint256 weight)) private _power;
    mapping(address seller => uint256 agentId) public agentIdForSeller;
    bool public reverts;

    function setPower(uint256 agentId, uint256 epoch, uint256 weight) external {
        _power[agentId][epoch] = weight;
    }

    function setSeller(address seller, uint256 agentId) external {
        agentIdForSeller[seller] = agentId;
    }

    function setReverts(bool value) external {
        reverts = value;
    }

    function poolWeightAtEpoch(uint256 agentId, uint256 epoch) external view returns (uint256) {
        if (reverts) revert("pools down");
        return _power[agentId][epoch];
    }
}
