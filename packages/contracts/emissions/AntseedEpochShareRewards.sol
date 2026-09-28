// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IAntseedEmissionsGate} from "../interfaces/IAntseedEmissionsGate.sol";

/**
 * @title AntseedEpochShareRewards
 * @notice Base for AntseedEmissionsGate controllers that split each epoch's
 *         bucket pro rata to points read from an attribution ledger.
 *
 *         Ledger points for an epoch keep being credited for a while after the
 *         epoch ends (each buyer's trailing settlement lands at its next
 *         settlement or via `flush`), so an epoch becomes claimable only once
 *         a full further epoch has passed, and the epoch total is frozen at
 *         the first claim so every claimant is paid from the same denominator.
 *         The ledger (`AntseedAttributionUsage.CREDIT_GRACE_EPOCHS`) stops
 *         crediting an epoch at exactly that point, so a claimant's live
 *         points can never grow against the frozen total.
 */
abstract contract AntseedEpochShareRewards is Ownable2Step, Pausable, ReentrancyGuard {
    /// @notice Epochs that must fully elapse after `epoch` before it is claimable.
    uint256 public constant SETTLEMENT_GRACE_EPOCHS = 1;

    IAntseedEmissionsGate public immutable emissionsGate;

    mapping(uint256 epoch => uint256 points) public frozenTotalPoints;
    mapping(uint256 epoch => bool frozen) public epochFrozen;
    mapping(uint256 epoch => mapping(bytes32 key => bool claimed)) private _claimed;
    mapping(uint256 epoch => uint256 amount) public epochMinted;
    mapping(uint256 epoch => bool settled) public epochRemainderSettled;

    event EpochTotalFrozen(uint256 indexed epoch, uint256 totalPoints);
    event EpochRemainderSettled(uint256 indexed epoch, uint256 unallocatedAmount, uint256 burnedAmount, uint256 reserveAmount);

    error InvalidAddress();
    error EpochNotClaimable();
    error AlreadyClaimed();
    error NothingToClaim();

    constructor(address _emissionsGate) Ownable(msg.sender) {
        if (_emissionsGate == address(0)) revert InvalidAddress();
        emissionsGate = IAntseedEmissionsGate(_emissionsGate);
    }

    function isClaimable(uint256 epoch) public view returns (bool) {
        return epoch + SETTLEMENT_GRACE_EPOCHS < emissionsGate.currentEpoch();
    }

    /// @dev Total points for the epoch: frozen once any claim happened.
    function _epochTotal(uint256 epoch) internal view returns (uint256) {
        return epochFrozen[epoch] ? frozenTotalPoints[epoch] : _ledgerTotal(epoch);
    }

    /// @dev What `points` of `total` would mint now for the epoch.
    function _share(uint256 epoch, uint256 points, uint256 total) internal view returns (uint256) {
        if (points == 0 || total == 0) return 0;
        uint256 budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        uint256 amount = (budget * points) / total;
        uint256 remaining = budget > epochMinted[epoch] ? budget - epochMinted[epoch] : 0;
        return amount < remaining ? amount : remaining;
    }

    function _pending(uint256 epoch, bytes32 key, uint256 points) internal view returns (uint256) {
        if (!isClaimable(epoch) || _claimed[epoch][key]) return 0;
        return _share(epoch, points, _epochTotal(epoch));
    }

    /// @dev Freeze the epoch total on first use, then mint the claimant's share.
    function _claimShare(uint256 epoch, bytes32 key, uint256 points, address recipient)
        internal
        returns (uint256 amount, uint256 total)
    {
        if (!isClaimable(epoch)) revert EpochNotClaimable();
        if (_claimed[epoch][key]) revert AlreadyClaimed();
        if (recipient == address(0)) revert InvalidAddress();

        total = _freezeEpochTotal(epoch);
        amount = _share(epoch, points, total);
        if (amount == 0) revert NothingToClaim();

        _claimed[epoch][key] = true;
        epochMinted[epoch] += amount;
        emissionsGate.claim(epoch, recipient, amount);
    }

    /// @notice Route an epoch's bucket to the gate's burn / reserve split when
    ///         nobody can ever claim it: the ledger recorded no points for the
    ///         epoch, so every share is zero and the bucket would otherwise
    ///         stay un-minted forever (the other controllers sweep the same
    ///         way). Epochs with claimants keep their bucket for those claims.
    ///         Permissionless; only claimable (hence final) epochs qualify.
    function settleEpochRemainder(uint256 epoch)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 burnedAmount, uint256 reserveAmount)
    {
        if (epochRemainderSettled[epoch]) revert AlreadyClaimed();
        if (!isClaimable(epoch)) revert EpochNotClaimable();
        if (_freezeEpochTotal(epoch) != 0) revert NothingToClaim();
        uint256 budget = emissionsGate.controllerEpochBudget(address(this), epoch);
        if (budget == 0) revert NothingToClaim();

        epochRemainderSettled[epoch] = true;
        (burnedAmount, reserveAmount) = emissionsGate.claimRemainder(epoch, _emissionsReserve(), budget);
        emit EpochRemainderSettled(epoch, budget, burnedAmount, reserveAmount);
    }

    /// @dev Freeze the epoch's ledger total on first use. Kept as an explicit
    ///      flag rather than `frozenTotalPoints != 0` so a frozen zero (an
    ///      epoch settled as remainder) is distinguishable from unset.
    function _freezeEpochTotal(uint256 epoch) internal returns (uint256 total) {
        if (!epochFrozen[epoch]) {
            frozenTotalPoints[epoch] = _ledgerTotal(epoch);
            epochFrozen[epoch] = true;
            emit EpochTotalFrozen(epoch, frozenTotalPoints[epoch]);
        }
        return frozenTotalPoints[epoch];
    }

    function _emissionsReserve() internal view returns (address reserve) {
        reserve = emissionsGate.emissionsReserve();
        if (reserve == address(0)) revert InvalidAddress();
    }

    function _isClaimed(uint256 epoch, bytes32 key) internal view returns (bool) {
        return _claimed[epoch][key];
    }

    /// @dev Live epoch total from the attribution ledger.
    function _ledgerTotal(uint256 epoch) internal view virtual returns (uint256);

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
