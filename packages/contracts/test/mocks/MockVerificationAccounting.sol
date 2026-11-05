// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MockVerificationEmissionsGate } from "./MockVerificationEmissionsGate.sol";

/// @notice Stands in for `AntseedUsageAccounting` as `registry.emissions()`: exposes the gate behind it.
contract UsageAccountingFront {
    address public immutable emissionsGate;

    constructor(address gate) {
        emissionsGate = gate;
    }

    function currentEpoch() external view returns (uint256) {
        return MockVerificationEmissionsGate(emissionsGate).currentEpoch();
    }
}

/// @notice The usage-accounting surface the verification points policy reads: its seller pools.
contract VerificationPointsAccounting {
    address public immutable sellerPools;

    constructor(address pools) {
        sellerPools = pools;
    }
}
