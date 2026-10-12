// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISP1Verifier } from "../../interfaces/ISP1Verifier.sol";
import { IAntseedWashTradingRegistry } from "../../interfaces/IAntseedWashTradingRegistry.sol";

contract WashTradingDevelopmentBlockhashStore {
    mapping(uint256 blockNumber => bytes32 blockHash) private blockHashes;

    function setBlockhashes(uint64[] calldata blockNumbers, bytes32[] calldata hashes) external {
        require(blockNumbers.length == hashes.length, "length mismatch");
        for (uint256 index; index < blockNumbers.length; ++index) {
            blockHashes[blockNumbers[index]] = hashes[index];
        }
    }

    function getBlockhash(uint256 blockNumber) external view returns (bytes32) {
        return blockHashes[blockNumber];
    }
}

contract WashTradingDevelopmentVerifier is ISP1Verifier {
    /// @dev Sentinel identity for the digest-pinned development verifier.
    bytes32 public constant VERIFIER_HASH = keccak256("antseed-wash-trading-development-verifier-v1");
    bytes32 public immutable expectedDigest;

    constructor(bytes32 programVKey, bytes32 publicValuesDigest, bytes32 proofDigest) {
        expectedDigest = keccak256(abi.encode(programVKey, publicValuesDigest, proofDigest));
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view {
        require(
            keccak256(abi.encode(programVKey, keccak256(publicValues), keccak256(proofBytes))) == expectedDigest,
            "unexpected development proof"
        );
    }
}

contract WashTradingLocalBatchAuthenticator {
    function authenticateChunks(
        IAntseedWashTradingRegistry registry,
        bytes32 proofId,
        uint32[] calldata chunkIndexes,
        IAntseedWashTradingRegistry.BlockRef[][] calldata chunkReferences,
        bytes32[][] calldata chunkProofs
    ) external {
        require(
            chunkIndexes.length == chunkReferences.length && chunkIndexes.length == chunkProofs.length,
            "length mismatch"
        );
        for (uint256 chunk; chunk < chunkIndexes.length; ++chunk) {
            registry.authenticateBlockReferences(
                proofId, chunkIndexes[chunk], chunkReferences[chunk], chunkProofs[chunk]
            );
        }
    }
}
