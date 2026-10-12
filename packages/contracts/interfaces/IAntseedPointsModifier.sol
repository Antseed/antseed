// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Transforms the current seller/buyer points in registration order.
///         A zeroed side cannot be restored by subsequent policies.
interface IAntseedPointsModifier {
    function points(bytes32 channelId, address buyer, address seller, uint256 sellerPoints, uint256 buyerPoints)
        external
        view
        returns (uint256 adjustedSellerPoints, uint256 adjustedBuyerPoints);
}
