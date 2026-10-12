// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAntseedWashTradingRegistry {
    struct BlockRef {
        uint64 number;
        bytes32 blockHash;
    }

    function stageSellerProof(bytes calldata publicValues, bytes calldata proofBytes)
        external
        returns (bytes32 proofId);
    function authenticateBlockReferences(
        bytes32 proofId,
        uint32 chunkIndex,
        BlockRef[] calldata references,
        bytes32[] calldata proof
    ) external;
    function finalizeSellerProof(bytes32 proofId) external;

    function verifierHash() external view returns (bytes32);
    function sellerProgramVKey() external view returns (bytes32);
    function periodStartBlock() external view returns (uint64);
    function periodEndBlock() external view returns (uint64);
    function proofStaged(bytes32 proofId) external view returns (bool);
    function proofFinalized(bytes32 proofId) external view returns (bool);
    function proofAuthenticatedBlockReferenceCount(bytes32 proofId) external view returns (uint32);
    function proofAuthenticatedBlockChunkCount(bytes32 proofId) external view returns (uint32);
    function proofBlockChunkAuthenticated(bytes32 proofId, uint32 chunkIndex) external view returns (bool);
    function provenWashVolume(address seller) external view returns (uint128);
    function totalSellerVolume(address seller) external view returns (uint128);
    function provenWashShareBps(address seller) external view returns (uint256);
    function sellerEvidenceDigest(address seller) external view returns (bytes32);
    function isProvenWashTrader(address seller) external view returns (bool);
}
