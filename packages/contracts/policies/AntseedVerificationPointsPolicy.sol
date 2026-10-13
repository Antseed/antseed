// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAntseedEmissionsGate } from "../interfaces/IAntseedEmissionsGate.sol";
import { IAntseedPointsModifier } from "../interfaces/IAntseedPointsModifier.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedVerification } from "../interfaces/IAntseedVerification.sol";

interface IAntseedSellerPoolsSource {
    function sellerPools() external view returns (IAntseedSellerPools);
}

/// @notice Scales seller points by the agent's verified and DIFF services:
///         sellerPoints * max(0, 1 + min(verifiedCount * bonusBps, MAX_BONUS_BPS) / BPS
///         - diffCount * penaltyBps / BPS). The penalty is uncapped. Applies only from
///         `pointsStartEpoch` on (off until the owner sets it). Buyer points pass through.
/// @dev A reverting points modifier zeroes every settlement in the registry chain, so
///      every external read here falls back to returning points unchanged.
contract AntseedVerificationPointsPolicy is IAntseedPointsModifier, Ownable2Step {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_BONUS_BPS = 5_000;

    IAntseedVerification public immutable verification;
    IAntseedSellerPoolsSource public immutable usageAccounting;
    uint256 public bonusBps;
    uint256 public penaltyBps;
    /// @notice First emissions epoch the bonus and penalty apply in; `type(uint256).max` keeps them off.
    uint256 public pointsStartEpoch = type(uint256).max;

    event BonusBpsSet(uint256 bonusBps);
    event PenaltyBpsSet(uint256 penaltyBps);
    event PointsStartEpochSet(uint256 epoch);

    error InvalidAddress();
    error InvalidValue();

    constructor(address verification_, address usageAccounting_, uint256 bonusBps_, address initialOwner)
        Ownable(initialOwner)
    {
        if (verification_.code.length == 0 || usageAccounting_.code.length == 0) revert InvalidAddress();
        if (bonusBps_ > MAX_BONUS_BPS) revert InvalidValue();
        verification = IAntseedVerification(verification_);
        usageAccounting = IAntseedSellerPoolsSource(usageAccounting_);
        bonusBps = bonusBps_;
        emit BonusBpsSet(bonusBps_);
    }

    function setBonusBps(uint256 bonusBps_) external onlyOwner {
        if (bonusBps_ > MAX_BONUS_BPS) revert InvalidValue();
        bonusBps = bonusBps_;
        emit BonusBpsSet(bonusBps_);
    }

    /// @notice Points removed per DIFF service, in bps of the seller's points. Uncapped; 0 disables it.
    function setPenaltyBps(uint256 penaltyBps_) external onlyOwner {
        penaltyBps = penaltyBps_;
        emit PenaltyBpsSet(penaltyBps_);
    }

    /// @notice The bonus and penalty apply to settlements from this emissions epoch on, read from
    ///         the verification contract's pinned gate. `type(uint256).max` turns them off again.
    function setPointsStartEpoch(uint256 epoch) external onlyOwner {
        pointsStartEpoch = epoch;
        emit PointsStartEpochSet(epoch);
    }

    function points(bytes32, address, address seller, uint256 sellerPoints, uint256 buyerPoints)
        external
        view
        returns (uint256 adjustedSellerPoints, uint256 adjustedBuyerPoints)
    {
        uint256 bonus = bonusBps;
        uint256 penalty = penaltyBps;
        if (sellerPoints == 0 || (bonus == 0 && penalty == 0) || !_started()) return (sellerPoints, buyerPoints);
        (uint256 verifiedModels, uint256 diffModels) = _modelCounts(seller);
        bonus *= verifiedModels;
        if (bonus > MAX_BONUS_BPS) bonus = MAX_BONUS_BPS;
        penalty = Math.saturatingMul(penalty, diffModels);
        if (bonus == 0 && penalty == 0) return (sellerPoints, buyerPoints);
        uint256 multiplier = Math.saturatingSub(BPS + bonus, penalty);
        return (Math.mulDiv(sellerPoints, multiplier, BPS), buyerPoints);
    }

    /// @dev False while off, or when the epoch cannot be read, so points pass through unchanged.
    function _started() private view returns (bool) {
        uint256 start = pointsStartEpoch;
        if (start == type(uint256).max) return false;
        try verification.emissionsGate() returns (IAntseedEmissionsGate gate) {
            try gate.currentEpoch() returns (uint256 epoch) {
                return epoch >= start;
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    /// @dev The agent's SAME and DIFF service counts; (0, 0) when unknown or unreadable.
    function _modelCounts(address seller) private view returns (uint256, uint256) {
        try usageAccounting.sellerPools() returns (IAntseedSellerPools pools) {
            if (address(pools).code.length == 0) return (0, 0);
            try pools.agentIdForSeller(seller) returns (uint256 agentId) {
                if (agentId == 0) return (0, 0);
                try verification.agentStatus(agentId) returns (IAntseedVerification.AgentStatus memory status) {
                    return (status.verifiedCount, status.diffCount);
                } catch {
                    return (0, 0);
                }
            } catch {
                return (0, 0);
            }
        } catch {
            return (0, 0);
        }
    }
}
