// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";

/**
 * @title AntseedLegacyEmissionsEscrow
 * @notice Fixed pot of pre-minted ANTS covering every emission epoch before
 *         the gate's effective epoch. The deployed legacy emissions contract
 *         is re-pointed at this contract as its registry: every registry
 *         getter forwards to the real legacy registry except `antsToken()`,
 *         which returns this contract, so the legacy contract's unchanged
 *         `token.mint(recipient, amount)` claims draw from the pot instead of
 *         minting new supply.
 *
 *         AntseedEmissionsGate funds the pot once with
 *         `cumulative schedule through effectiveEpoch − token.totalSupply()`
 *         — exactly what the schedule still owes for past epochs — so total
 *         supply conservation holds at every moment and the gate can refuse
 *         pre-effective epochs unconditionally.
 *
 *         Whatever the legacy contract never claims (rounding dust,
 *         zero-point epochs) is swept by the owner to a terminal destination
 *         once legacy claim activity has wound down.
 */
contract AntseedLegacyEmissionsEscrow is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IAntseedRegistry public immutable legacyRegistry;
    address public immutable legacyEmissions;
    IERC20 private immutable _token;

    event LegacyEmissionPaid(address indexed recipient, uint256 amount);
    event EscrowSwept(address indexed recipient, uint256 amount);

    error InvalidAddress();
    error NotLegacyEmissions();

    constructor(address legacyRegistry_, address legacyEmissions_) Ownable(msg.sender) {
        if (legacyRegistry_ == address(0) || legacyEmissions_ == address(0)) revert InvalidAddress();
        legacyRegistry = IAntseedRegistry(legacyRegistry_);
        legacyEmissions = legacyEmissions_;

        address token = IAntseedRegistry(legacyRegistry_).antsToken();
        if (token == address(0)) revert InvalidAddress();
        _token = IERC20(token);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                LEGACY EMISSIONS TOKEN SURFACE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice The legacy emissions contract's `token.mint` call, answered as
    ///         a claim from the pre-minted pot. Zero amounts are a no-op so a
    ///         legacy flush of an empty accumulator never reverts.
    function mint(address recipient, uint256 amount) external nonReentrant {
        if (msg.sender != legacyEmissions) revert NotLegacyEmissions();
        if (recipient == address(0)) revert InvalidAddress();
        if (amount == 0) return;
        _token.safeTransfer(recipient, amount);
        emit LegacyEmissionPaid(recipient, amount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                    REGISTRY FACADE (FORWARDED)
    // ═══════════════════════════════════════════════════════════════════

    /// @dev The one divergence from the legacy registry: the legacy emissions
    ///      contract must mint against this escrow, not the real token.
    function antsToken() external view returns (address) {
        return address(this);
    }

    function channels() external view returns (address) {
        return legacyRegistry.channels();
    }

    function stats() external view returns (address) {
        return legacyRegistry.stats();
    }

    function deposits() external view returns (address) {
        return legacyRegistry.deposits();
    }

    function staking() external view returns (address) {
        return legacyRegistry.staking();
    }

    function emissions() external view returns (address) {
        return legacyRegistry.emissions();
    }

    function identityRegistry() external view returns (address) {
        return legacyRegistry.identityRegistry();
    }

    function protocolReserve() external view returns (address) {
        return legacyRegistry.protocolReserve();
    }

    function teamWallet() external view returns (address) {
        return legacyRegistry.teamWallet();
    }

    // ═══════════════════════════════════════════════════════════════════
    //                          ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Sweep the never-claimed remainder of the pot once legacy claim
    ///         activity has wound down. Sweeping early strands legitimate
    ///         legacy claims, so this is an explicit owner decision.
    function sweep(address recipient) external onlyOwner nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert InvalidAddress();
        amount = _token.balanceOf(address(this));
        if (amount != 0) _token.safeTransfer(recipient, amount);
        emit EscrowSwept(recipient, amount);
    }
}
