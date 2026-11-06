// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";
import {IAntseedSellerPools} from "../interfaces/IAntseedSellerPools.sol";

/**
 * @title AntseedRewardPayout
 * @notice How a reward controller pays out through the emissions gate: the
 *         claimable part to its recipient or into a seller pool, the capped-off
 *         part to the emissions reserve. Authorization, reward math, claimed
 *         state and events stay in each controller.
 */
library AntseedRewardPayout {
    using SafeERC20 for IERC20;

    error InvalidAddress();

    function mint(
        IAntseedEmissionsGate gate,
        uint256 epoch,
        address recipient,
        uint256 claimableAmount,
        uint256 reserveAmount
    ) internal {
        if (claimableAmount != 0) gate.claim(epoch, recipient, claimableAmount);
        if (reserveAmount != 0) {
            address reserve = gate.emissionsReserve();
            if (reserve == address(0)) revert InvalidAddress();
            gate.claim(epoch, reserve, reserveAmount);
        }
    }

    /// @notice Mint to the calling controller, then stake the claimable part for `staker`.
    function stake(
        IAntseedEmissionsGate gate,
        IAntseedSellerPools pools,
        address staker,
        uint256 stakeAgentId,
        uint256 stakeEpochs,
        uint256 epoch,
        uint256 claimableAmount,
        uint256 reserveAmount
    ) internal returns (uint256 newPositionId) {
        if (address(pools) == address(0)) revert InvalidAddress();

        mint(gate, epoch, address(this), claimableAmount, reserveAmount);

        IERC20 token = pools.antsToken();
        if (address(token) == address(0)) revert InvalidAddress();
        token.forceApprove(address(pools), claimableAmount);
        newPositionId = pools.stakeFor(staker, stakeAgentId, claimableAmount, stakeEpochs);
        token.forceApprove(address(pools), 0);
    }
}
