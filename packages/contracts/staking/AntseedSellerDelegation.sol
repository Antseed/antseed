// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAntseedRegistry } from "../interfaces/IAntseedRegistry.sol";
import { IAntseedChannels } from "../interfaces/IAntseedChannels.sol";
import { IAntseedDeposits } from "../interfaces/IAntseedDeposits.sol";
import { IAntseedEmissions } from "../interfaces/IAntseedEmissions.sol";

interface IAntseedStakingSellerDelegation {
    function unstake() external;
}

/**
 * @title AntseedSellerDelegation
 * @notice Base contract for any seller façade that fronts an AntseedChannels
 *         channel on behalf of a pool / aggregator / multi-peer service.
 *
 *         Provides:
 *           - Multi-operator authorization (`isOperator`). Operators drive
 *             channel lifecycle actions on the contract's behalf. Buyers
 *             resolve the peer→sellerContract binding by calling
 *             `isOperator(peerAddress)` with no signature dance.
 *           - A byte-identical `reserve` / `topUp` / `settle` / `close`
 *             surface that forwards to `registry.channels()`. Channels is
 *             swappable at the registry level; derived contracts don't pin
 *             a specific channels address.
 *
 *         Derived contracts override the four lifecycle functions and wrap
 *         `super.X(...)` with any local bookkeeping (e.g. USDC inflow capture,
 *         reward streams, pool accounting).
 */
abstract contract AntseedSellerDelegation is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant DEFAULT_OPERATOR_FEE_BPS = 1000;
    uint256 public constant MAX_OPERATOR_FEE_BPS = 2000;
    uint256 internal constant _BPS = 10_000;

    /// @notice Central AntSeed address book. Resolves channels / deposits / etc.
    IAntseedRegistry public immutable registry;

    /// @notice Authorized operators for this contract.
    mapping(address => bool) public isOperator;

    uint256 public operatorFeeBps;
    address public operatorFeeRecipient;

    event OperatorSet(address indexed operator, bool enabled);
    event OperatorFeeSet(uint256 feeBps, address indexed recipient);
    event AntseedStakeWithdrawn(address indexed recipient, uint256 amount);

    error InvalidAddress();
    error NotOperator();
    error OperatorFeeTooLarge();

    modifier onlyOperator() {
        if (!isOperator[msg.sender]) revert NotOperator();
        _;
    }

    /// @param _registry AntSeed address book.
    /// @param initialOperator First authorized operator. Must be non-zero.
    constructor(address _registry, address initialOperator) Ownable(msg.sender) {
        if (_registry == address(0)) revert InvalidAddress();
        if (initialOperator == address(0)) revert InvalidAddress();
        registry = IAntseedRegistry(_registry);
        operatorFeeBps = DEFAULT_OPERATOR_FEE_BPS;
        operatorFeeRecipient = initialOperator;
        emit OperatorFeeSet(DEFAULT_OPERATOR_FEE_BPS, initialOperator);
        isOperator[initialOperator] = true;
        emit OperatorSet(initialOperator, true);
    }

    /// @notice Add or remove an operator.
    function setOperator(address op, bool enabled) external onlyOwner {
        if (op == address(0)) revert InvalidAddress();
        isOperator[op] = enabled;
        emit OperatorSet(op, enabled);
    }

    /// @notice Set the operator fee taken from delegated seller revenue streams.
    /// @dev `feeBps` may be zero. A non-zero fee requires a non-zero recipient.
    function setOperatorFee(uint256 feeBps, address recipient) external onlyOwner {
        if (feeBps > MAX_OPERATOR_FEE_BPS) revert OperatorFeeTooLarge();
        if (feeBps > 0 && recipient == address(0)) revert InvalidAddress();
        operatorFeeBps = feeBps;
        operatorFeeRecipient = recipient;
        emit OperatorFeeSet(feeBps, recipient);
    }

    /// @notice Withdraw this seller's AntSeed staking deposit to `recipient`.
    /// @dev Generic to seller delegation contracts: the actual staking contract
    ///      is resolved through the registry, and the payout token is resolved
    ///      from AntseedDeposits.
    function withdrawAntseedStake(address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert InvalidAddress();
        IERC20 payoutToken = _sellerPayoutToken();
        uint256 beforeBal = payoutToken.balanceOf(address(this));
        IAntseedStakingSellerDelegation(registry.staking()).unstake();
        uint256 payout = payoutToken.balanceOf(address(this)) - beforeBal;
        if (payout > 0) payoutToken.safeTransfer(recipient, payout);
        emit AntseedStakeWithdrawn(recipient, payout);
    }

    // ═══════════════════════════════════════════════════════════════════
    //                        CHANNEL LIFECYCLE FAÇADE
    // ═══════════════════════════════════════════════════════════════════

    // The four forwarders below intentionally carry `onlyOperator` but *not*
    // `nonReentrant`. AntseedChannels applies its own reentrancy guard on
    // every lifecycle entry point, so the delegation layer would only add a
    // redundant lock here. Derived contracts (e.g. DiemStakingProxy) that
    // need to wrap the super call with additional state updates — like
    // USDC-delta capture after `settle` — should apply a single
    // `nonReentrant` on the override so the override's extra work runs under
    // the same lock as the super forward, with no gap in between.

    /// @notice Forwarded `AntseedChannels.reserve`.
    function reserve(address buyer, bytes32 salt, uint128 maxAmount, uint256 deadline, bytes calldata buyerSig)
        public
        virtual
        onlyOperator
    {
        _channels().reserve(buyer, salt, maxAmount, deadline, buyerSig);
    }

    /// @notice Forwarded `AntseedChannels.topUp`.
    function topUp(
        bytes32 channelId,
        uint128 cumulativeAmount,
        bytes calldata metadata,
        bytes calldata spendingSig,
        uint128 newMaxAmount,
        uint256 deadline,
        bytes calldata reserveSig
    ) public virtual onlyOperator returns (uint256 netPayout) {
        IERC20 payoutToken = _sellerPayoutToken();
        uint256 beforeBal = payoutToken.balanceOf(address(this));
        _channels().topUp(channelId, cumulativeAmount, metadata, spendingSig, newMaxAmount, deadline, reserveSig);
        netPayout = _takeOperatorFee(payoutToken, payoutToken.balanceOf(address(this)) - beforeBal);
    }

    /// @notice Forwarded `AntseedChannels.settle`.
    function settle(bytes32 channelId, uint128 cumulativeAmount, bytes calldata metadata, bytes calldata buyerSig)
        public
        virtual
        onlyOperator
        returns (uint256 netPayout)
    {
        IERC20 payoutToken = _sellerPayoutToken();
        uint256 beforeBal = payoutToken.balanceOf(address(this));
        _channels().settle(channelId, cumulativeAmount, metadata, buyerSig);
        netPayout = _takeOperatorFee(payoutToken, payoutToken.balanceOf(address(this)) - beforeBal);
    }

    /// @notice Forwarded `AntseedChannels.close`.
    function close(bytes32 channelId, uint128 finalAmount, bytes calldata metadata, bytes calldata buyerSig)
        public
        virtual
        onlyOperator
        returns (uint256 netPayout)
    {
        IERC20 payoutToken = _sellerPayoutToken();
        uint256 beforeBal = payoutToken.balanceOf(address(this));
        _channels().close(channelId, finalAmount, metadata, buyerSig);
        netPayout = _takeOperatorFee(payoutToken, payoutToken.balanceOf(address(this)) - beforeBal);
    }

    /// @dev Resolve the current channels contract via the registry.
    function _channels() internal view returns (IAntseedChannels) {
        return IAntseedChannels(registry.channels());
    }

    function _sellerPayoutToken() internal view returns (IERC20) {
        return IERC20(IAntseedDeposits(registry.deposits()).usdc());
    }

    function _currentEmissionsEpoch() internal view returns (uint256) {
        return IAntseedEmissions(registry.emissions()).currentEpoch();
    }

    function _claimSellerEmissions(uint256[] memory epochs) internal returns (uint256 netPayout) {
        IERC20 antsToken = IERC20(registry.antsToken());
        uint256 beforeBal = antsToken.balanceOf(address(this));
        IAntseedEmissions(registry.emissions()).claimSellerEmissions(epochs);
        netPayout = _takeOperatorFee(antsToken, antsToken.balanceOf(address(this)) - beforeBal);
    }

    function _pendingSellerEmissions(address account, uint256[] memory epochs)
        internal
        view
        returns (uint256 netPendingSeller)
    {
        (uint256 grossPendingSeller,) = IAntseedEmissions(registry.emissions()).pendingEmissions(account, epochs);
        netPendingSeller = _operatorFeeNetAmount(grossPendingSeller);
    }

    function _operatorFeeAmount(uint256 grossAmount) internal view returns (uint256) {
        return (grossAmount * operatorFeeBps) / _BPS;
    }

    function _operatorFeeNetAmount(uint256 grossAmount) internal view returns (uint256) {
        return grossAmount - _operatorFeeAmount(grossAmount);
    }

    function _takeOperatorFee(IERC20 token, uint256 grossAmount) internal returns (uint256) {
        uint256 fee = _operatorFeeAmount(grossAmount);
        if (fee == 0) return grossAmount;
        token.safeTransfer(operatorFeeRecipient, fee);
        return grossAmount - fee;
    }

    /// @notice The underlying AntseedChannels contract. Client SDKs treat this
    ///         contract as the "channels address" for writes (so `onlyOperator`
    ///         and any derived-class logic applies), then call `channelsAddress`
    ///         at init to discover the real channels contract for reads + event
    ///         subscriptions. Reads are keyed on `address(this)` as the seller.
    function channelsAddress() external view returns (address) {
        return address(_channels());
    }
}
