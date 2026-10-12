// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice SP1 verifier interface used by the wash-trading registry.
/// @dev The registry must be pointed at a concrete `SP1VerifierGroth16`
///      deployment, never at the upgradeable `SP1VerifierGateway`. The
///      gateway owner can add routes for new proof selectors, which would
///      let a foreign verifier accept "proofs" against the registry's
///      immutable program vkeys. A concrete verifier is immutable and
///      exposes `VERIFIER_HASH()`, which the registry pins at deployment.
interface ISP1Verifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

/// @notice Identity surface exposed by concrete SP1 verifier deployments
///         (`SP1VerifierGroth16` / `SP1VerifierPlonk`). The gateway does
///         not implement it.
interface ISP1VerifierWithHash is ISP1Verifier {
    function VERIFIER_HASH() external pure returns (bytes32);
}
