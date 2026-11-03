// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IAntseedVerificationResults } from "../../interfaces/IAntseedVerificationResults.sol";

/// @notice Stands in for a verification method other than KBF: forwards `record` and `credit` to the
///         results layer as its own source, with no consensus or reward rules of its own.
contract MockVerificationSource {
    bytes32 public constant EVIDENCE = keccak256("mock-source-evidence");

    IAntseedVerificationResults public immutable results;

    constructor(address results_) {
        results = IAntseedVerificationResults(results_);
    }

    function record(
        uint256 agentId,
        bytes32 serviceHash,
        bytes32 modelHash,
        IAntseedVerificationResults.Verdict verdict
    ) external {
        results.record(agentId, serviceHash, modelHash, verdict, EVIDENCE);
    }

    function credit(address auditor, uint256 credits) external returns (uint256) {
        return results.credit(auditor, credits);
    }
}
