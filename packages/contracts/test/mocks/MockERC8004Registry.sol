// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC8004Registry} from "../../interfaces/IERC8004Registry.sol";

/**
 * @title MockERC8004Registry
 * @notice Minimal mock of the ERC-8004 IdentityRegistry for local testing.
 *         NOT for production — use the real deployed registry on mainnet.
 */
contract MockERC8004Registry is IERC8004Registry {
    uint256 private _nextId = 1;

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => mapping(string => bytes)) private _metadata;

    event Registered(uint256 indexed agentId, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string key, bytes value);
    event Transferred(uint256 indexed agentId, address indexed from, address indexed to);

    function register() external returns (uint256 agentId) {
        agentId = _nextId++;
        _owners[agentId] = msg.sender;
        _balances[msg.sender]++;
        emit Registered(agentId, msg.sender);
    }

    function register(string calldata /* uri */) external returns (uint256 agentId) {
        agentId = _nextId++;
        _owners[agentId] = msg.sender;
        _balances[msg.sender]++;
        emit Registered(agentId, msg.sender);
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = _owners[agentId];
        require(owner != address(0), "ERC721: invalid token ID");
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external {
        require(_owners[agentId] == msg.sender, "Not owner");
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, value);
    }

    function getMetadata(uint256 agentId, string calldata key) external view returns (bytes memory) {
        return _metadata[agentId][key];
    }

    function transferAgent(uint256 agentId, address to) external {
        require(to != address(0), "Invalid recipient");
        address from = _owners[agentId];
        require(from == msg.sender, "Not owner");
        _owners[agentId] = to;
        _balances[from]--;
        _balances[to]++;
        emit Transferred(agentId, from, to);
    }

    function setOwner(uint256 agentId, address owner) external {
        require(agentId != 0, "Invalid token ID");
        require(owner != address(0), "Invalid owner");

        address previousOwner = _owners[agentId];
        if (previousOwner != address(0)) {
            _balances[previousOwner]--;
        }

        _owners[agentId] = owner;
        _balances[owner]++;
        emit Transferred(agentId, previousOwner, owner);
    }
}
