// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { IAntseedKbfAudits } from "../interfaces/IAntseedKbfAudits.sol";
import { AntseedTokenizerAudits } from "../verification/AntseedTokenizerAudits.sol";

/// @title DeployTokenizerAudits
/// @notice Deploys `AntseedTokenizerAudits` next to an existing KBF audit, on the same results layer,
///         seller pools and identity registry, and registers the standard request shapes: one per API
///         `antseed verifier prove-tokenizer` probes in (Chat Completions, Anthropic Messages, Responses).
///
/// It never touches the results layer: the results owner then registers the audit
/// (`results.setAudit(tokenizerAudits, true)`), gives it a share (`setAuditShareBps`) and turns its
/// rewards on (`setRewardsStartEpoch`). Until `setAudit`, proofs revert, so nothing is recorded.
/// References come from sellers with a live SAME on the results layer, so nothing else is needed; the
/// owner may map never-audited service names to models (`setServiceModels`) and set the usage-flag
/// penalty (`setPenaltyBps`) before registering the contract as a points modifier.
///
/// Required environment:
///   EXPECTED_CHAIN_ID   Target chain ID.
///   KBF_AUDITS          Existing AntseedKbfAudits; the results layer, seller pools and identity
///                       registry are read from it.
///   TOKENIZER_OWNER     Wallet that will own the tokenizer audit.
///
/// Example dry run:
///   forge script script/DeployTokenizerAudits.s.sol --rpc-url "$RPC_URL" --sender "$TOKENIZER_OWNER"
contract DeployTokenizerAudits is Script {
    struct Config {
        uint256 expectedChainId;
        address kbfAudits;
        address owner;
    }

    struct ShapeBytes {
        bytes path;
        bytes head;
        bytes mid;
        bytes tail;
    }

    function run() external returns (AntseedTokenizerAudits, bytes32[] memory) {
        return runWith(
            Config({
                expectedChainId: vm.envUint("EXPECTED_CHAIN_ID"),
                kbfAudits: vm.envAddress("KBF_AUDITS"),
                owner: vm.envAddress("TOKENIZER_OWNER")
            })
        );
    }

    /// @notice One plain user message per API, so `antseed verifier prove-tokenizer` reaches every seller in an
    ///         API it speaks natively. The signed fixture (`test/fixtures/tokenizer-proof`) uses these shapes.
    function standardShapes() public pure returns (ShapeBytes[] memory shapes) {
        shapes = new ShapeBytes[](3);
        shapes[0] = ShapeBytes(
            "/v1/chat/completions", '{"model":"', '","messages":[{"role":"user","content":"', '"}],"max_tokens":64}'
        );
        shapes[1] = ShapeBytes(
            "/v1/messages", '{"model":"', '","max_tokens":64,"messages":[{"role":"user","content":"', '"}]}'
        );
        shapes[2] = ShapeBytes("/v1/responses", '{"model":"', '","max_output_tokens":64,"input":"', '"}');
    }

    function runWith(Config memory config) public returns (AntseedTokenizerAudits audits, bytes32[] memory shapeIds) {
        require(block.chainid == config.expectedChainId, "tokenizer: wrong chain");
        require(config.owner != address(0), "tokenizer: missing owner");
        require(config.kbfAudits.code.length != 0, "tokenizer: missing KBF audits");
        IAntseedKbfAudits kbf = IAntseedKbfAudits(config.kbfAudits);
        address results = address(kbf.results());
        address sellerPools = address(kbf.sellerPools());
        address identityRegistry = address(kbf.identityRegistry());
        ShapeBytes[] memory shapes = standardShapes();

        vm.startBroadcast(config.owner);
        audits = new AntseedTokenizerAudits(results, sellerPools, identityRegistry);
        shapeIds = new bytes32[](shapes.length);
        for (uint256 i = 0; i < shapes.length; i++) {
            shapeIds[i] = audits.setShape(shapes[i].path, shapes[i].head, shapes[i].mid, shapes[i].tail, true);
        }
        vm.stopBroadcast();

        require(audits.owner() == config.owner, "tokenizer: wrong owner");
        require(address(audits.results()) == results, "tokenizer: wrong results");
        require(address(audits.sellerPools()) == sellerPools, "tokenizer: wrong seller pools");
        require(address(audits.identityRegistry()) == identityRegistry, "tokenizer: wrong identity registry");

        console.log("=== Tokenizer audits deployed (not yet an audit on the results layer) ===");
        console.log("Owner:              ", config.owner);
        console.log("TokenizerAudits:    ", address(audits));
        console.log("VerificationResults:", results);
        console.log("SellerPools:        ", sellerPools);
        console.log("IdentityRegistry:   ", identityRegistry);
    }
}
