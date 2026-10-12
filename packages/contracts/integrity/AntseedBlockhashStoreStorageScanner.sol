// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only helper used through an eth_call state override on Chainlink's BlockhashStore.
/// @dev This contract must not be deployed. Replacing the target's code for eth_call preserves its storage,
///      allowing the caller to enumerate non-zero entries in s_blockhashes without sending transactions.
contract AntseedBlockhashStoreStorageScanner {
    function scan(uint256 startBlock, uint256 count) external view returns (bytes memory bitmap, uint256 found) {
        bitmap = new bytes((count + 7) / 8);
        for (uint256 index; index < count; ++index) {
            bytes32 value;
            bytes32 slot = keccak256(abi.encode(startBlock + index, uint256(0)));
            assembly {
                value := sload(slot)
            }
            if (value == bytes32(0)) continue;

            uint256 byteIndex = index >> 3;
            uint256 bitIndex = index & 7;
            assembly {
                let location := add(add(bitmap, 32), byteIndex)
                mstore8(location, or(byte(0, mload(location)), shl(bitIndex, 1)))
            }
            ++found;
        }
    }

    function read(uint256[] calldata blockNumbers) external view returns (bytes32[] memory blockHashes) {
        blockHashes = new bytes32[](blockNumbers.length);
        for (uint256 index; index < blockNumbers.length; ++index) {
            bytes32 slot = keccak256(abi.encode(blockNumbers[index], uint256(0)));
            assembly {
                mstore(add(add(blockHashes, 32), mul(index, 32)), sload(slot))
            }
        }
    }
}
