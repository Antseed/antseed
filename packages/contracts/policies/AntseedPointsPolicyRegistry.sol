// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IAntseedPointsModifier } from "../interfaces/IAntseedPointsModifier.sol";
import { IAntseedPointsPolicy } from "../interfaces/IAntseedPointsPolicy.sol";

contract AntseedPointsPolicyRegistry is IAntseedPointsPolicy, Ownable2Step {
    uint256 public constant MAX_POLICIES = 8;
    address[] private _policies;
    mapping(address policy => uint256 indexPlusOne) private _policyIndexPlusOne;

    event PolicyRegistered(address indexed policy, uint256 indexed index);
    event PolicyRemoved(address indexed policy, uint256 indexed index);

    error InvalidPolicy();
    error PolicyAlreadyRegistered(address policy);
    error PolicyNotRegistered(address policy);
    error TooManyPolicies();

    constructor(address initialOwner) Ownable(initialOwner) { }

    function registerPolicy(address policy) external onlyOwner {
        if (policy == address(0) || policy == address(this) || policy.code.length == 0) revert InvalidPolicy();
        if (_policyIndexPlusOne[policy] != 0) revert PolicyAlreadyRegistered(policy);
        if (_policies.length == MAX_POLICIES) revert TooManyPolicies();

        uint256 index = _policies.length;
        _policies.push(policy);
        _policyIndexPlusOne[policy] = index + 1;
        emit PolicyRegistered(policy, index);
    }

    function removePolicy(address policy) external onlyOwner {
        uint256 indexPlusOne = _policyIndexPlusOne[policy];
        if (indexPlusOne == 0) revert PolicyNotRegistered(policy);

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = _policies.length - 1;
        for (uint256 current = index; current < lastIndex; ++current) {
            address shifted = _policies[current + 1];
            _policies[current] = shifted;
            _policyIndexPlusOne[shifted] = current + 1;
        }
        _policies.pop();
        delete _policyIndexPlusOne[policy];
        emit PolicyRemoved(policy, index);
    }

    function policyCount() external view returns (uint256) {
        return _policies.length;
    }

    function policyAt(uint256 index) external view returns (address) {
        return _policies[index];
    }

    function isPolicyRegistered(address policy) external view returns (bool) {
        return _policyIndexPlusOne[policy] != 0;
    }

    function points(bytes32 channelId, address buyer, address seller, uint256 rawPoints)
        external
        view
        returns (uint256 sellerPoints, uint256 buyerPoints)
    {
        if (rawPoints == 0) return (0, 0);
        buyerPoints = rawPoints;
        sellerPoints = rawPoints;
        uint256 count = _policies.length;
        for (uint256 index = 0; index < count; ++index) {
            (uint256 nextSellerPoints, uint256 nextBuyerPoints) =
                IAntseedPointsModifier(_policies[index]).points(channelId, buyer, seller, sellerPoints, buyerPoints);
            if (buyerPoints != 0) buyerPoints = nextBuyerPoints;
            if (sellerPoints != 0) sellerPoints = nextSellerPoints;
            if (buyerPoints == 0 && sellerPoints == 0) return (0, 0);
        }
    }
}
