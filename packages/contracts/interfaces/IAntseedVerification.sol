// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAntseedRegistry} from "./IAntseedRegistry.sol";
import {IAntseedSellerPools} from "./IAntseedSellerPools.sol";

/// @notice Model-verification audits submitted by approved auditors.
/// @dev An agent is verified while its latest audit passed every audited service and has not
///      expired. Auditors are paid from the verification emission bucket in proportion to the
///      pool power of the agents they audit.
interface IAntseedVerification {
    /// @param serviceHash keccak256 of the service name in the seller's signed metadata.
    /// @param modelHash keccak256 of the lowercased model the service was audited as.
    /// @param passed True when the service answered as the claimed model.
    struct ServiceResult {
        bytes32 serviceHash;
        bytes32 modelHash;
        bool passed;
    }

    function registry() external view returns (IAntseedRegistry);
    function sellerPools() external view returns (IAntseedSellerPools);
    function approvedAuditors(address auditor) external view returns (bool);
    function setAuditor(address auditor, bool approved) external;

    /// @notice Records an audit of `agentId`. Reverts unless the caller is an approved auditor.
    ///         A fully passing audit verifies the agent; any failed service clears it.
    function submitAudit(
        uint256 agentId,
        ServiceResult[] calldata results,
        bytes32 evidenceHash,
        string calldata evidenceUri
    ) external;

    /// @notice Timestamp until which `agentId` counts as verified; 0 when never verified or cleared.
    function verifiedUntil(uint256 agentId) external view returns (uint64);
    function isVerified(uint256 agentId) external view returns (bool);

    /// @notice Claims the caller's auditor share of the verification emission bucket.
    function claimAuditorRewards(uint256[] calldata epochs) external returns (uint256 total);
    function pendingAuditorReward(address auditor, uint256 epoch) external view returns (uint256);
}
