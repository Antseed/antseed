// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AntseedLegacyEmissionsRegistry
 * @notice Ownerless, immutable registry for the deployed legacy
 *         AntseedEmissionsV2, so it can never accrue new points.
 *
 *         EmissionsV2 accepts points only from `registry.channels()`. Its
 *         current registry, AntseedLegacyEmissionsEscrow, forwards that getter
 *         to the live AntseedRegistry, which leaves the gate in the hands of
 *         whoever owns that registry or AntseedChannels: either can make the
 *         live Channels address report volume to EmissionsV2 again.
 *
 *         Re-pointing EmissionsV2 here answers `channels()` with
 *         `address(0)`, so every accrual reverts, while claims for epochs
 *         already earned keep working:
 *           - `antsToken()` is the escrow, which pays claims from its
 *             pre-minted balance;
 *           - `deposits()` is the Deposits contract that answers buyer
 *             operators for `claimBuyerEmissions`.
 *         `protocolReserve()` and `teamWallet()` answer `address(0)`, so the
 *         owner-only reserve and team flushes can never pay out either.
 *
 *         EmissionsV2 calls nothing else on its registry. Every answer is
 *         fixed at deployment and there is no owner, so once EmissionsV2
 *         renounces its own ownership, its point totals are final.
 */
contract AntseedLegacyEmissionsRegistry {
    address public immutable escrow;
    address public immutable buyerDeposits;

    error InvalidAddress();

    constructor(address _escrow, address _buyerDeposits) {
        if (_escrow == address(0) || _buyerDeposits == address(0)) revert InvalidAddress();
        escrow = _escrow;
        buyerDeposits = _buyerDeposits;
    }

    /// @notice No caller can ever pass EmissionsV2's `onlyChannels` check.
    function channels() external pure returns (address) {
        return address(0);
    }

    function antsToken() external view returns (address) {
        return escrow;
    }

    function deposits() external view returns (address) {
        return buyerDeposits;
    }

    function protocolReserve() external pure returns (address) {
        return address(0);
    }

    function teamWallet() external pure returns (address) {
        return address(0);
    }
}
