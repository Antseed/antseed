// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { IAntseedWashTradingRegistry } from "../interfaces/IAntseedWashTradingRegistry.sol";
import { ISP1Verifier } from "../interfaces/ISP1Verifier.sol";

contract MockSP1Verifier is ISP1Verifier {
    bytes32 public constant VERIFIER_HASH = keccak256("mock-sp1-verifier");
    bytes32 public expectedVKey;
    bytes32 public expectedValuesHash;
    bytes32 public expectedProofHash;

    function expect(bytes32 vKey, bytes memory values, bytes memory proof) external {
        expectedVKey = vKey;
        expectedValuesHash = keccak256(values);
        expectedProofHash = keccak256(proof);
    }

    function verifyProof(bytes32 vKey, bytes calldata values, bytes calldata proof) external view {
        require(
            vKey == expectedVKey && keccak256(values) == expectedValuesHash && keccak256(proof) == expectedProofHash,
            "unexpected proof"
        );
    }
}

/// @dev Shaped like the SP1VerifierGateway: verifies but has no VERIFIER_HASH().
contract MockSP1Gateway is ISP1Verifier {
    function verifyProof(bytes32, bytes calldata, bytes calldata) external view { }
}

/// @dev Mirrors Chainlink's BlockhashStore: unknown blocks revert with a string reason.
contract MockBlockhashStore {
    mapping(uint256 blockNumber => bytes32 blockHash) internal blockHashes;

    function set(uint64 blockNumber, bytes32 blockHash) external {
        blockHashes[blockNumber] = blockHash;
    }

    function getBlockhash(uint256 blockNumber) external view returns (bytes32 blockHash) {
        blockHash = blockHashes[blockNumber];
        require(blockHash != bytes32(0), "blockhash not found in store");
    }

    function storeVerifyHeader(uint256, bytes calldata) external { }
}

contract AntseedWashTradingRegistryTest is Test {
    struct SellerSettlement {
        bytes32 settlementId;
        uint128 amount;
    }

    bytes32 internal constant SELLER_VKEY = bytes32(uint256(11));
    bytes32 internal constant BLOCK_HASH_A = bytes32(uint256(44));
    bytes32 internal constant BLOCK_HASH_B = bytes32(uint256(55));
    uint64 internal constant BLOCK_A = 120;
    uint64 internal constant BLOCK_B = 150;
    address internal constant SELLER_A = address(0xA11CE);

    MockSP1Verifier internal verifier;
    MockBlockhashStore internal blockhashStore;
    AntseedWashTradingRegistry internal registry;

    function setUp() public {
        verifier = new MockSP1Verifier();
        blockhashStore = new MockBlockhashStore();
        blockhashStore.set(BLOCK_A, BLOCK_HASH_A);
        blockhashStore.set(BLOCK_B, BLOCK_HASH_B);
        registry = new AntseedWashTradingRegistry(
            address(verifier), verifier.VERIFIER_HASH(), address(blockhashStore), SELLER_VKEY, 100, 199
        );
        assertEq(registry.verifierHash(), verifier.VERIFIER_HASH());
        assertEq(registry.sellerProgramVKey(), SELLER_VKEY);
    }

    function test_rejectsZeroSellerProgramVKey() public {
        bytes32 expectedVerifierHash = verifier.VERIFIER_HASH();
        vm.expectRevert(AntseedWashTradingRegistry.InvalidConfiguration.selector);
        new AntseedWashTradingRegistry(
            address(verifier), expectedVerifierHash, address(blockhashStore), bytes32(0), 100, 199
        );
    }

    function test_rejectsGatewayAndMismatchedVerifierHash() public {
        MockSP1Gateway gateway = new MockSP1Gateway();
        bytes32 expectedHash = verifier.VERIFIER_HASH();
        vm.expectRevert(AntseedWashTradingRegistry.InvalidVerifier.selector);
        new AntseedWashTradingRegistry(address(gateway), expectedHash, address(blockhashStore), SELLER_VKEY, 100, 199);

        vm.expectRevert(AntseedWashTradingRegistry.InvalidVerifier.selector);
        new AntseedWashTradingRegistry(
            address(verifier), keccak256("other-release"), address(blockhashStore), SELLER_VKEY, 100, 199
        );

        vm.expectRevert(AntseedWashTradingRegistry.InvalidVerifier.selector);
        new AntseedWashTradingRegistry(address(verifier), bytes32(0), address(blockhashStore), SELLER_VKEY, 100, 199);
    }

    function test_blockAuthenticationLeafMatchesRustAbi() public pure {
        IAntseedWashTradingRegistry.BlockRef[] memory refs = new IAntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = IAntseedWashTradingRegistry.BlockRef(123, bytes32(uint256(type(uint256).max / 0xff * 0xaa)));
        assertEq(
            keccak256(abi.encode(uint32(0), refs)), 0x30527e2a947e958d4041ae91f69cf216b960961be3a4610a31d765da7989b11a
        );
    }

    /// @dev Vector shared with loop-proof `predicate/tests/seller.rs`
    ///      (`evidence_digest_matches_solidity_abi_encode`).
    function test_evidenceDigestMatchesRustAbi() public pure {
        SellerSettlement[] memory settlements = new SellerSettlement[](2);
        settlements[0] = SellerSettlement(bytes32(uint256(type(uint256).max / 0xff * 0x11)), 300);
        settlements[1] = SellerSettlement(bytes32(uint256(type(uint256).max / 0xff * 0x22)), 450);
        assertEq(
            keccak256(abi.encode(address(0xA11CE), uint64(100), uint64(199), settlements)),
            0x58e5f0d44d8fe5ba80ddbd5fca67cdc52460974d1658eadcfce9a1e830beba6c
        );
    }

    function test_permissionlessSellerProofStagesAuthenticatesAndFinalizes() public {
        bytes32 proofId = _stage(_journal(300, bytes32(uint256(71))));
        assertTrue(registry.proofStaged(proofId));
        assertFalse(registry.proofFinalized(proofId));
        assertEq(registry.provenWashVolume(SELLER_A), 0);

        _authenticate(proofId, 1, BLOCK_B, BLOCK_HASH_B, _leaf(0, BLOCK_A, BLOCK_HASH_A));
        vm.expectRevert(AntseedWashTradingRegistry.IncompleteBlockAuthentication.selector);
        registry.finalizeSellerProof(proofId);
        _authenticate(proofId, 0, BLOCK_A, BLOCK_HASH_A, _leaf(1, BLOCK_B, BLOCK_HASH_B));
        registry.finalizeSellerProof(proofId);

        assertTrue(registry.proofFinalized(proofId));
        assertEq(registry.proofAuthenticatedBlockReferenceCount(proofId), 2);
        assertEq(registry.proofAuthenticatedBlockChunkCount(proofId), 2);
        assertEq(registry.provenWashVolume(SELLER_A), 300);
        assertEq(registry.sellerEvidenceDigest(SELLER_A), bytes32(uint256(71)));
        assertTrue(registry.isProvenWashTrader(SELLER_A));
    }

    function test_onlyStrictlyStrongerVolumeCanReplaceSellerResult() public {
        _finalize(_journal(300, bytes32(uint256(71))));

        bytes32 weaker = _stage(_journal(299, bytes32(uint256(72))));
        _authenticateAll(weaker);
        vm.expectRevert(AntseedWashTradingRegistry.StrongerResultRequired.selector);
        registry.finalizeSellerProof(weaker);

        bytes32 equal = _stage(_journal(300, bytes32(uint256(73))));
        _authenticateAll(equal);
        vm.expectRevert(AntseedWashTradingRegistry.StrongerResultRequired.selector);
        registry.finalizeSellerProof(equal);

        bytes32 stronger = _stage(_journal(450, bytes32(uint256(74))));
        _authenticateAll(stronger);
        registry.finalizeSellerProof(stronger);
        assertEq(registry.provenWashVolume(SELLER_A), 450);
        assertEq(registry.sellerEvidenceDigest(SELLER_A), bytes32(uint256(74)));
    }

    function test_totalSellerVolumeIsRecordedAndExposedAsShare() public {
        _finalize(_journal(300, bytes32(uint256(71))));
        assertEq(registry.totalSellerVolume(SELLER_A), 1000);
        assertEq(registry.provenWashShareBps(SELLER_A), 3000);
        assertEq(registry.totalSellerVolume(address(0xB0B)), 0);
        assertEq(registry.provenWashShareBps(address(0xB0B)), 0);
    }

    function test_unprovenSellerIsNotWashTrader() public view {
        assertFalse(registry.isProvenWashTrader(SELLER_A));
        assertEq(registry.WASH_TRADING_THRESHOLD_BPS(), 2500);
    }

    function test_washTraderStatusRequiresTwentyFivePercentAndCanCrossThreshold() public {
        bytes32 below = _finalize(_journal(249, bytes32(uint256(71))));
        assertTrue(registry.proofFinalized(below));
        assertEq(registry.provenWashVolume(SELLER_A), 249);
        assertFalse(registry.isProvenWashTrader(SELLER_A));

        bytes32 boundary = _stage(_journal(250, bytes32(uint256(72))));
        _authenticateAll(boundary);
        assertFalse(registry.isProvenWashTrader(SELLER_A));
        registry.finalizeSellerProof(boundary);
        assertTrue(registry.isProvenWashTrader(SELLER_A));

        _finalize(_journal(251, bytes32(uint256(73))));
        assertTrue(registry.isProvenWashTrader(SELLER_A));
    }

    function test_washTraderThresholdDoesNotRoundRequiredVolumeDown() public {
        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(250, bytes32(uint256(71)));
        journal.totalSellerVolume = 1001;
        _finalize(journal);
        assertFalse(registry.isProvenWashTrader(SELLER_A));

        journal.provenWashVolume = 251;
        journal.evidenceDigest = bytes32(uint256(72));
        _finalize(journal);
        assertTrue(registry.isProvenWashTrader(SELLER_A));
    }

    function test_washTraderThresholdHandlesMaximumVolumes() public {
        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(type(uint128).max, bytes32(uint256(71)));
        journal.totalSellerVolume = type(uint128).max;
        _finalize(journal);
        assertTrue(registry.isProvenWashTrader(SELLER_A));
    }

    function testFuzz_washTraderStatusMatchesShare(uint128 washVolume, uint128 totalVolume) public {
        washVolume = uint128(bound(washVolume, 1, type(uint128).max));
        totalVolume = uint128(bound(totalVolume, 1, type(uint128).max));
        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(washVolume, bytes32(uint256(71)));
        journal.totalSellerVolume = totalVolume;
        _finalize(journal);
        assertEq(registry.isProvenWashTrader(SELLER_A), registry.provenWashShareBps(SELLER_A) >= 2500);
    }

    function test_rejectsConflictingTotalSellerVolume() public {
        _finalize(_journal(300, bytes32(uint256(71))));

        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(450, bytes32(uint256(72)));
        journal.totalSellerVolume = 999;
        bytes32 conflicting = _stage(journal);
        _authenticateAll(conflicting);
        vm.expectRevert(AntseedWashTradingRegistry.TotalVolumeMismatch.selector);
        registry.finalizeSellerProof(conflicting);
    }

    function test_rejectsZeroTotalSellerVolume() public {
        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(300, bytes32(uint256(71)));
        journal.totalSellerVolume = 0;
        _expectStageRevert(journal, AntseedWashTradingRegistry.InvalidSellerProof.selector);
    }

    function test_rejectsWrongProgramIdentityAndPeriod() public {
        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(300, bytes32(uint256(71)));
        journal.schemaVersion = 2;
        _expectStageRevert(journal, AntseedWashTradingRegistry.InvalidSellerProof.selector);

        journal = _journal(300, bytes32(uint256(72)));
        journal.periodEndBlock = 200;
        _expectStageRevert(journal, AntseedWashTradingRegistry.InvalidSellerProof.selector);
    }

    function test_rejectsNonCanonicalWrongChunkAndReplay() public {
        bytes32 proofId = _stage(_journal(300, bytes32(uint256(71))));
        bytes32[] memory proof = _proof(_leaf(1, BLOCK_B, BLOCK_HASH_B));
        IAntseedWashTradingRegistry.BlockRef[] memory refs = _refs(BLOCK_A, bytes32(uint256(999)));
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NonCanonicalBlock.selector, BLOCK_A));
        registry.authenticateBlockReferences(proofId, 0, refs, proof);

        // A block Chainlink does not hold reverts inside the store; the registry maps it to its own error.
        refs = _refs(BLOCK_A + 1, BLOCK_HASH_A);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.NonCanonicalBlock.selector, BLOCK_A + 1));
        registry.authenticateBlockReferences(proofId, 0, refs, proof);

        refs = _refs(BLOCK_A, BLOCK_HASH_A);
        proof[0] = bytes32(uint256(999));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidBlockAuthenticationChunk.selector);
        registry.authenticateBlockReferences(proofId, 0, refs, proof);

        _authenticate(proofId, 0, BLOCK_A, BLOCK_HASH_A, _leaf(1, BLOCK_B, BLOCK_HASH_B));
        vm.expectRevert(
            abi.encodeWithSelector(
                AntseedWashTradingRegistry.BlockAuthenticationChunkAlreadySubmitted.selector, proofId, 0
            )
        );
        registry.authenticateBlockReferences(
            proofId, 0, _refs(BLOCK_A, BLOCK_HASH_A), _proof(_leaf(1, BLOCK_B, BLOCK_HASH_B))
        );
    }

    function test_rejectsSameProofReplay() public {
        AntseedWashTradingRegistry.SellerJournal memory journal = _journal(300, bytes32(uint256(71)));
        bytes32 proofId = _stage(journal);
        (bytes memory values, bytes memory proof) = _submission(journal);
        vm.expectRevert(abi.encodeWithSelector(AntseedWashTradingRegistry.SellerProofAlreadyStaged.selector, proofId));
        registry.stageSellerProof(values, proof);
    }

    function _finalize(AntseedWashTradingRegistry.SellerJournal memory journal) internal returns (bytes32 proofId) {
        proofId = _stage(journal);
        _authenticateAll(proofId);
        registry.finalizeSellerProof(proofId);
    }

    function _stage(AntseedWashTradingRegistry.SellerJournal memory journal) internal returns (bytes32 proofId) {
        (bytes memory values, bytes memory proof) = _submission(journal);
        verifier.expect(SELLER_VKEY, values, proof);
        proofId = registry.stageSellerProof(values, proof);
        assertEq(proofId, keccak256(values));
    }

    function _expectStageRevert(AntseedWashTradingRegistry.SellerJournal memory journal, bytes4 selector) internal {
        (bytes memory values, bytes memory proof) = _submission(journal);
        verifier.expect(SELLER_VKEY, values, proof);
        vm.expectRevert(selector);
        registry.stageSellerProof(values, proof);
    }

    function _submission(AntseedWashTradingRegistry.SellerJournal memory journal)
        internal
        pure
        returns (bytes memory values, bytes memory proof)
    {
        values = abi.encode(journal);
        proof = hex"1234";
    }

    function _journal(uint128 washVolume, bytes32 evidenceDigest)
        internal
        pure
        returns (AntseedWashTradingRegistry.SellerJournal memory journal)
    {
        journal = AntseedWashTradingRegistry.SellerJournal({
            schemaVersion: 1,
            chainId: 8453,
            periodStartBlock: 100,
            periodEndBlock: 199,
            seller: SELLER_A,
            provenWashVolume: washVolume,
            totalSellerVolume: 1000,
            evidenceDigest: evidenceDigest,
            blockReferenceCount: 2,
            blockAuthenticationChunkSize: 1,
            blockAuthenticationChunkCount: 2,
            blockAuthenticationRoot: keccak256(abi.encode(_leaf(0, BLOCK_A, BLOCK_HASH_A), _leaf(1, BLOCK_B, BLOCK_HASH_B)))
        });
    }

    function _authenticateAll(bytes32 proofId) internal {
        _authenticate(proofId, 0, BLOCK_A, BLOCK_HASH_A, _leaf(1, BLOCK_B, BLOCK_HASH_B));
        _authenticate(proofId, 1, BLOCK_B, BLOCK_HASH_B, _leaf(0, BLOCK_A, BLOCK_HASH_A));
    }

    function _authenticate(bytes32 proofId, uint32 index, uint64 number, bytes32 blockHash, bytes32 sibling) internal {
        registry.authenticateBlockReferences(proofId, index, _refs(number, blockHash), _proof(sibling));
    }

    function _refs(uint64 number, bytes32 blockHash)
        internal
        pure
        returns (IAntseedWashTradingRegistry.BlockRef[] memory refs)
    {
        refs = new IAntseedWashTradingRegistry.BlockRef[](1);
        refs[0] = IAntseedWashTradingRegistry.BlockRef(number, blockHash);
    }

    function _proof(bytes32 sibling) internal pure returns (bytes32[] memory proof) {
        proof = new bytes32[](1);
        proof[0] = sibling;
    }

    function _leaf(uint32 index, uint64 number, bytes32 blockHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(index, _refs(number, blockHash)));
    }
}
