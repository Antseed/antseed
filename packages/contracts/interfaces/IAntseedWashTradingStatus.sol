// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal read surface a seller claim policy needs from a wash-trading
///         source. Matches `AntseedWashTradingRegistry.isProvenWashTrader` so
///         the ZK registry can be plugged in directly once it is deployed.
interface IAntseedWashTradingStatus {
    function isProvenWashTrader(address seller) external view returns (bool);
}
