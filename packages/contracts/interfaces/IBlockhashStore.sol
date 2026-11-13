// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Subset of Chainlink's `BlockhashStore` used by the wash-trading registry
///         (Base mainnet: 0x78b69899C8cD252126cBB1A50171ec37286C3877).
/// @dev `getBlockhash` reverts with "blockhash not found in store" for unknown blocks.
///      `storeVerifyHeader` is permissionless and walks the parent-hash chain backwards.
interface IBlockhashStore {
    function getBlockhash(uint256 blockNumber) external view returns (bytes32);
    function storeVerifyHeader(uint256 blockNumber, bytes calldata header) external;
}
