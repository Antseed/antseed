// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedChannelsMiddleware } from "../payments/AntseedChannelsMiddleware.sol";

interface IActivationStats {
    function writers(address writer) external view returns (bool);
    function setWriter(address writer, bool allowed) external;
}

interface IActivationAccounting {
    function usageRecorders(address recorder) external view returns (bool);
    function setUsageRecorder(address recorder, bool allowed) external;
}

interface IActivationPayments {
    function registry() external view returns (address);
    function setRegistry(address registry) external;
}

/// @dev The order is what matters: see ActivateChannelsMiddleware.
function activateChannelsMiddleware(AntseedChannelsMiddleware middleware) {
    address main = address(middleware.mainRegistry());
    IActivationPayments channels = IActivationPayments(middleware.channelsContract());
    IActivationPayments freeUsage = IActivationPayments(middleware.freeUsageContract());
    IActivationAccounting accounting = IActivationAccounting(address(middleware.usageAccounting()));
    IActivationStats liveStats = IActivationStats(middleware.mainRegistry().stats());

    require(channels.registry() == main, "Channels is not on the main registry");
    require(freeUsage.registry() == main, "FreeUsage is not on the main registry");
    require(middleware.mainRegistry().emissions() == address(accounting), "main registry emissions is not accounting");

    liveStats.setWriter(address(middleware), true);
    accounting.setUsageRecorder(address(middleware), true);
    require(liveStats.writers(address(middleware)), "middleware is not a Stats writer");
    require(accounting.usageRecorders(address(middleware)), "middleware is not a usage recorder");

    channels.setRegistry(address(middleware));
    freeUsage.setRegistry(address(middleware));
}

/**
 * @title ActivateChannelsMiddleware
 * @notice Routes AntseedChannels and AntseedFreeUsage through the middleware.
 *
 * The order is what matters. AntseedUsageAccounting silently skips callers that
 * are not usage recorders, so re-pointing Channels first would lose every seller
 * and buyer point in between, with settlements still succeeding. Channels stays
 * a recorder, so rollback is `setRegistry(<main registry>)` on both contracts.
 *
 * Run by the owner of AntseedStats, AntseedUsageAccounting, AntseedChannels and
 * AntseedFreeUsage.
 *
 * Required env:
 *   CHANNELS_MIDDLEWARE
 *   PROTOCOL_OWNER
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/ActivateChannelsMiddleware.s.sol --rpc-url $BASE_MAINNET_RPC_URL --account <owner> --broadcast
 */
contract ActivateChannelsMiddleware is Script {
    function run() external {
        AntseedChannelsMiddleware middleware = AntseedChannelsMiddleware(vm.envAddress("CHANNELS_MIDDLEWARE"));
        vm.startBroadcast(vm.envAddress("PROTOCOL_OWNER"));
        activateChannelsMiddleware(middleware);
        vm.stopBroadcast();
    }
}
