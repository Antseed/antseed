// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { AntseedChannelsMiddleware } from "../payments/AntseedChannelsMiddleware.sol";

interface IActivationStats {
    function writers(address writer) external view returns (bool);
    function setWriter(address writer, bool allowed) external;
}

interface IActivationAccounting {
    function usageRecorders(address recorder) external view returns (bool);
    function setUsageRecorder(address recorder, bool allowed) external;
}

interface IActivationController {
    function emissionsGate() external view returns (IActivationGate);
}

interface IActivationGate {
    function currentEpoch() external view returns (uint256);
    function controllerEpochBudget(address controller, uint256 epoch) external view returns (uint256);
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

/// @dev Takes over a controller DeployChannelsMiddleware offered and checks it
///      has budget now: points credited in an epoch with no budget are never paid.
function acceptRewardController(address controller, address protocolOwner) {
    Ownable2Step owned = Ownable2Step(controller);
    if (owned.pendingOwner() == protocolOwner) owned.acceptOwnership();
    require(owned.owner() == protocolOwner, "controller is not owned by the protocol owner");

    IActivationGate gate = IActivationController(controller).emissionsGate();
    require(gate.controllerEpochBudget(controller, gate.currentEpoch()) != 0, "controller has no budget this epoch");
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
 * RegisterAttributionMinters' shares start in the epoch after it runs, so run this
 * from that epoch on. It refuses earlier, and it accepts ownership of both controllers.
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
        address protocolOwner = vm.envAddress("PROTOCOL_OWNER");
        vm.startBroadcast(protocolOwner);
        acceptRewardController(address(middleware.clientRewards()), protocolOwner);
        acceptRewardController(address(middleware.referrals()), protocolOwner);
        activateChannelsMiddleware(middleware);
        vm.stopBroadcast();
    }
}
