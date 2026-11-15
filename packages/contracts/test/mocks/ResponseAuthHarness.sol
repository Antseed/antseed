// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AntseedResponseAuth } from "../../verification/AntseedResponseAuth.sol";

/// @dev Exposes the ResponseAuth digest, so tests sign receipts exactly as sellers do.
contract ResponseAuthHarness {
    function digest(AntseedResponseAuth.Receipt calldata receipt) external pure returns (bytes32) {
        return AntseedResponseAuth.digest(receipt);
    }
}
