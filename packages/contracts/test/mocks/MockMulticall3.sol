// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The `aggregate3` read surface of Multicall3, for local chains that lack the canonical deployment.
contract MockMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory data) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "Multicall3: call failed");
            returnData[i] = Result(success, data);
        }
    }
}
