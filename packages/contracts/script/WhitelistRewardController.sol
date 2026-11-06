// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/console.sol";

interface IRewardControllerToken {
    function owner() external view returns (address);
    function transfersEnabled() external view returns (bool);
    function setTransferWhitelist(address account, bool allowed) external;
}

interface IRewardControllerPools {
    function antsToken() external view returns (address);
}

/// @dev Staking a reward moves ANTS out of the controller, which ANTS refuses
///      until transfers are enabled unless the controller is whitelisted. Plain
///      claims mint and are unaffected. Call inside a broadcast by `deployer`.
function whitelistRewardController(address sellerPools, address controller, address deployer) {
    IRewardControllerToken token = IRewardControllerToken(IRewardControllerPools(sellerPools).antsToken());
    if (token.transfersEnabled()) return;
    if (token.owner() == deployer) {
        token.setTransferWhitelist(controller, true);
    } else {
        console.log("ANTS owner must call setTransferWhitelist(controller, true) before stakes work:", controller);
    }
}
