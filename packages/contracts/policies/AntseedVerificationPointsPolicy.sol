// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedPointsModifier } from "../interfaces/IAntseedPointsModifier.sol";
import { IAntseedSellerPools } from "../interfaces/IAntseedSellerPools.sol";
import { IAntseedVerification } from "../interfaces/IAntseedVerification.sol";

interface IAntseedSellerPoolsSource {
    function sellerPools() external view returns (IAntseedSellerPools);
}

/// @notice Boosts seller points for verified agents: sellerPoints * (1 + bonusBps / BPS).
///         Buyer points pass through.
/// @dev A reverting points modifier zeroes every settlement in the registry chain, so
///      every external read here falls back to returning points unchanged.
contract AntseedVerificationPointsPolicy is IAntseedPointsModifier, Ownable2Step {
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_BONUS_BPS = 5_000;

    IAntseedVerification public immutable verification;
    IAntseedSellerPoolsSource public immutable usageAccounting;
    uint256 public bonusBps;

    event BonusBpsSet(uint256 bonusBps);

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

    function points(bytes32, address, address seller, uint256 sellerPoints, uint256 buyerPoints)
        external
        view
        returns (uint256 adjustedSellerPoints, uint256 adjustedBuyerPoints)
    {
        uint256 bonus = bonusBps;
        if (sellerPoints == 0 || bonus == 0 || !_isVerified(seller)) return (sellerPoints, buyerPoints);
        return (sellerPoints + (sellerPoints * bonus) / BPS, buyerPoints);
    }

    function _isVerified(address seller) private view returns (bool) {
        try usageAccounting.sellerPools() returns (IAntseedSellerPools pools) {
            if (address(pools).code.length == 0) return false;
            try pools.agentIdForSeller(seller) returns (uint256 agentId) {
                if (agentId == 0) return false;
                try verification.isVerified(agentId) returns (bool verified) {
                    return verified;
                } catch {
                    return false;
                }
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }
}
