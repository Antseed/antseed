// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AntseedLegacyRewardsPoolRegistry
 * @notice Pinned registry facade for the deployed AntseedSellerRewardsPool.
 *
 *         The pool reads exactly two things from its registry: `emissions()`
 *         (the `recordLockedReward` authorization) and `antsToken()` (the
 *         claim payout token). Both should be constants for that contract —
 *         its whole remaining purpose is legacy locked rewards — but through
 *         the live AntseedRegistry the first one moves to
 *         AntseedUsageAccounting at cutover, which would make legacy
 *         EmissionsV2's locked-path claims (mint-to-pool + recordLockedReward)
 *         revert forever after the flip.
 *
 *         Re-pointing the pool at this facade pins both answers, so locked
 *         legacy claims keep working with no pointer-restore window and no
 *         dependency on any registry's ownership. Deliberately minimal: the
 *         deployed pool bytecode calls nothing else on its registry.
 */
contract AntseedLegacyRewardsPoolRegistry {
    address public immutable legacyEmissions;
    address public immutable ants;

    error InvalidAddress();

    constructor(address _legacyEmissions, address _ants) {
        if (_legacyEmissions == address(0) || _ants == address(0)) revert InvalidAddress();
        legacyEmissions = _legacyEmissions;
        ants = _ants;
    }

    function emissions() external view returns (address) {
        return legacyEmissions;
    }

    function antsToken() external view returns (address) {
        return ants;
    }
}
