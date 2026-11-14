// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedTokenizerAudits } from "../../interfaces/IAntseedTokenizerAudits.sol";
import { IAntseedVerificationResults } from "../../interfaces/IAntseedVerificationResults.sol";
import { AntseedTokenizerAudits } from "../../verification/AntseedTokenizerAudits.sol";
import { AntseedVerificationResults } from "../../verification/AntseedVerificationResults.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockVerificationAudit } from "../mocks/MockVerificationAudit.sol";
import { MockVerificationEmissionsGate } from "../mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "../mocks/MockVerificationSellerPools.sol";
import { DeployTokenizerAudits } from "../../script/DeployTokenizerAudits.s.sol";
import { TokenizerProofFixture } from "../fixtures/tokenizer-proof/TokenizerProofFixture.sol";

/// @dev Rounds signed by the TypeScript seller code and encoded by the prover's client prove on-chain.
///      Regenerate the fixture with `node packages/contracts/test/fixtures/tokenizer-proof/generate.mjs`.
contract AntseedTokenizerAuditsFixtureTest is Test {
    AntseedVerificationResults private results;
    AntseedTokenizerAudits private audits;
    MockVerificationAudit private kbf;
    MockVerificationSellerPools private pools;
    MockERC8004Registry private identityRegistry;
    uint256 private suspectAgent;
    bytes32 private serviceHash = keccak256(bytes(TokenizerProofFixture.SERVICE));
    bytes32 private modelHash = keccak256(bytes(TokenizerProofFixture.SERVICE));

    function setUp() public {
        identityRegistry = new MockERC8004Registry();
        MockVerificationEmissionsGate gate = new MockVerificationEmissionsGate();
        pools = new MockVerificationSellerPools();
        gate.setCurrentEpoch(1);
        results = new AntseedVerificationResults(address(gate));
        audits = new AntseedTokenizerAudits(address(results), address(pools), address(identityRegistry));
        kbf = new MockVerificationAudit(address(results));
        results.setAudit(address(audits), true);
        results.setAudit(address(kbf), true);

        suspectAgent = _register(TokenizerProofFixture.SUSPECT);
        address[3] memory refs =
            [TokenizerProofFixture.REFERENCE_0, TokenizerProofFixture.REFERENCE_1, TokenizerProofFixture.REFERENCE_2];
        for (uint256 i = 0; i < 3; i++) {
            kbf.record(_register(refs[i]), serviceHash, modelHash, IAntseedVerificationResults.Verdict.SAME);
        }
        DeployTokenizerAudits.ShapeBytes[] memory shapes = new DeployTokenizerAudits().standardShapes();
        for (uint256 i = 0; i < shapes.length; i++) {
            audits.setShape(shapes[i].path, shapes[i].head, shapes[i].mid, shapes[i].tail, true);
        }
    }

    function test_typescriptSignedRoundsVerify() public view {
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds();
        for (uint256 i = 0; i < rounds.length; i++) {
            _assertSigned(rounds[i].suspect, TokenizerProofFixture.SUSPECT);
            for (uint256 k = 0; k < rounds[i].references.length; k++) {
                _assertSigned(rounds[i].references[k], rounds[i].references[k].base.seller);
            }
        }
    }

    function test_provesTypescriptRounds() public {
        bytes32[] memory services = new bytes32[](1);
        services[0] = serviceHash;
        audits.setServiceModels(services, modelHash);
        IAntseedTokenizerAudits.Round[] memory rounds = _rounds();
        audits.proveTokenizerMismatch(modelHash, rounds);
        assertEq(uint8(results.liveVerdict(suspectAgent, serviceHash)), uint8(IAntseedVerificationResults.Verdict.DIFF));
    }

    function _register(address owner) private returns (uint256 id) {
        vm.prank(owner);
        id = identityRegistry.register();
        pools.setSeller(owner, id);
    }

    function _rounds() private pure returns (IAntseedTokenizerAudits.Round[] memory) {
        return abi.decode(TokenizerProofFixture.ENCODED_ROUNDS, (IAntseedTokenizerAudits.Round[]));
    }

    function _assertSigned(IAntseedTokenizerAudits.ProbePair memory pair, address seller) private view {
        (uint8 v, bytes32 r, bytes32 s) = _split(pair.base.signature);
        assertEq(ecrecover(audits.receiptDigest(pair.base), v, r, s), seller);
        (v, r, s) = _split(pair.probed.signature);
        assertEq(ecrecover(audits.receiptDigest(pair.probed), v, r, s), seller);
    }

    function _split(bytes memory signature) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
    }
}
