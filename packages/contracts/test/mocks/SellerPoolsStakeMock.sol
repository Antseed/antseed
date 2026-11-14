// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Seller pools stand-in for reward stake paths: pulls the stake and records it.
contract SellerPoolsStakeMock {
    IERC20 public immutable antsToken;
    address public lastStaker;
    uint256 public lastAgentId;
    uint256 public lastAmount;
    uint256 public lastEpochs;

    constructor(IERC20 token) {
        antsToken = token;
    }

    function stakeFor(address staker, uint256 agentId, uint256 amount, uint256 stakeEpochs)
        external
        returns (uint256)
    {
        antsToken.transferFrom(msg.sender, address(this), amount);
        lastStaker = staker;
        lastAgentId = agentId;
        lastAmount = amount;
        lastEpochs = stakeEpochs;
        return 7;
    }
}
