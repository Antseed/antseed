// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal AntseedDeposits stand-in for verifier and policy tests.
contract MockDeposits {
    address public usdc;
    mapping(address buyer => address operator) private _operators;

    function setUsdc(address usdc_) external {
        usdc = usdc_;
    }

    function setOperator(address buyer, address operator) external {
        _operators[buyer] = operator;
    }

    function getOperator(address buyer) external view returns (address) {
        return _operators[buyer];
    }
}
