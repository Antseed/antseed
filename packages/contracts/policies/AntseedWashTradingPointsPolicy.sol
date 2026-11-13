pragma solidity ^0.8.24;

import { IAntseedPointsModifier } from "../interfaces/IAntseedPointsModifier.sol";
import { IAntseedWashTradingStatus } from "../interfaces/IAntseedWashTradingStatus.sol";

contract AntseedWashTradingPointsPolicy is IAntseedPointsModifier {
    IAntseedWashTradingStatus public immutable washTradingRegistry;

    error InvalidAddress();

    constructor(address registry) {
        if (registry == address(0)) revert InvalidAddress();
        washTradingRegistry = IAntseedWashTradingStatus(registry);
    }

    function points(bytes32, address, address seller, uint256 sellerPoints, uint256 buyerPoints)
        external
        view
        returns (uint256 adjustedSellerPoints, uint256 adjustedBuyerPoints)
    {
        if (washTradingRegistry.isProvenWashTrader(seller)) return (0, 0);
        return (sellerPoints, buyerPoints);
    }
}
