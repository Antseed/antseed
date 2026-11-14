// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { DeployTokenizerAudits } from "../script/DeployTokenizerAudits.s.sol";
import { AntseedKbfAudits } from "../verification/AntseedKbfAudits.sol";
import { AntseedTokenizerAudits } from "../verification/AntseedTokenizerAudits.sol";
import { AntseedVerificationResults } from "../verification/AntseedVerificationResults.sol";
import { MockERC8004Registry } from "./mocks/MockERC8004Registry.sol";
import { MockVerificationEmissionsGate } from "./mocks/MockVerificationEmissionsGate.sol";
import { MockVerificationSellerPools } from "./mocks/MockVerificationSellerPools.sol";

contract DeployTokenizerAuditsTest is Test {
    AntseedVerificationResults private results;
    AntseedKbfAudits private kbf;
    MockVerificationSellerPools private pools;
    MockERC8004Registry private identity;
    DeployTokenizerAudits private script;
    address private owner = address(0xA11CE);

    function setUp() public {
        identity = new MockERC8004Registry();
        pools = new MockVerificationSellerPools();
        results = new AntseedVerificationResults(address(new MockVerificationEmissionsGate()));
        kbf = new AntseedKbfAudits(address(results), address(pools), address(identity));
        script = new DeployTokenizerAudits();
    }

    function _config() private view returns (DeployTokenizerAudits.Config memory) {
        return DeployTokenizerAudits.Config({
            expectedChainId: block.chainid,
            kbfAudits: address(kbf),
            owner: owner
        });
    }

    function test_deploysNextToKbfWithoutTouchingResults() public {
        (AntseedTokenizerAudits audits, bytes32[] memory shapeIds) = script.runWith(_config());
        assertEq(audits.owner(), owner);
        assertEq(address(audits.results()), address(results));
        assertEq(address(audits.sellerPools()), address(pools));
        assertEq(address(audits.identityRegistry()), address(identity));
        assertEq(audits.shapeIds(), shapeIds);
        assertEq(shapeIds.length, 3);
        assertEq(string(audits.shape(shapeIds[0]).path), "/v1/chat/completions");
        assertEq(string(audits.shape(shapeIds[1]).path), "/v1/messages");
        assertEq(string(audits.shape(shapeIds[2]).path), "/v1/responses");
        for (uint256 i = 0; i < shapeIds.length; i++) assertTrue(audits.shape(shapeIds[i]).active);
        assertFalse(results.isAudit(address(audits)), "registering the audit is the results owner's call");
    }

    function test_rejectsWrongChain() public {
        DeployTokenizerAudits.Config memory config = _config();
        config.expectedChainId = block.chainid + 1;
        vm.expectRevert(bytes("tokenizer: wrong chain"));
        script.runWith(config);
    }
}
