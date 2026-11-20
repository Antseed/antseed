// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { AntseedFreeTierTerms } from "../../sellers/AntseedFreeTierTerms.sol";

/// @notice Builds `AntseedFreeTierTerms.Terms` in memory for tests.
library FreeTierTermsBuilder {
    function one(bytes32 a) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](1);
        list[0] = a;
    }

    /// @dev A program over `models` (ascending) with one tier: `minPowerAnts` buys `requests` an hour.
    function program(bytes32 scope, bytes32[] memory models, uint64 minPowerAnts, uint32 requests)
        internal
        pure
        returns (AntseedFreeTierTerms.Program memory p)
    {
        p.scope = scope;
        p.windowSecs = 3600;
        p.tiers = new AntseedFreeTierTerms.Tier[](1);
        p.tiers[0] = AntseedFreeTierTerms.Tier(minPowerAnts, requests);
        p.models = new AntseedFreeTierTerms.Model[](models.length);
        for (uint256 i = 0; i < models.length; ++i) {
            p.models[i] = AntseedFreeTierTerms.Model(models[i], 1);
        }
    }

    /// @dev Seller-wide over one model, two tiers: 10 ANTS-epochs -> 5 requests, 100 -> 50, per hour.
    function simple(uint16 notice, bytes32 model) internal pure returns (AntseedFreeTierTerms.Terms memory t) {
        t.noticeEpochs = notice;
        t.programs = new AntseedFreeTierTerms.Program[](1);
        t.programs[0] = program(bytes32(0), one(model), 10, 5);
        AntseedFreeTierTerms.Tier[] memory tiers = new AntseedFreeTierTerms.Tier[](2);
        tiers[0] = AntseedFreeTierTerms.Tier(10, 5);
        tiers[1] = AntseedFreeTierTerms.Tier(100, 50);
        t.programs[0].tiers = tiers;
    }

    function empty(uint16 notice) internal pure returns (AntseedFreeTierTerms.Terms memory t) {
        t.noticeEpochs = notice;
    }
}

/// @notice Gate stand-in: a settable epoch.
contract FreeTierGateMock {
    uint256 public currentEpoch;

    function setCurrentEpoch(uint256 epoch) external {
        currentEpoch = epoch;
    }
}

/// @notice Seller registry stand-in for `getAgentId`.
contract FreeTierSellerRegistryMock {
    mapping(address => uint256) public agentOf;

    function setAgent(address seller, uint256 agentId) external {
        agentOf[seller] = agentId;
    }

    function getAgentId(address seller) external view returns (uint256) {
        return agentOf[seller];
    }
}

/// @notice An agent owner contract with operators, like `AntseedSellerDelegation`.
contract FreeTierOperatorOwner {
    mapping(address => bool) public isOperator;

    function setOperator(address operator, bool enabled) external {
        isOperator[operator] = enabled;
    }
}

/// @notice Owner contracts that answer `isOperator` badly.
contract FreeTierGasBurnerOwner {
    function isOperator(address) external pure returns (bool) {
        uint256 i;
        while (true) {
            ++i;
        }
        return i == 0;
    }
}

contract FreeTierLongReturnOwner {
    fallback() external {
        assembly {
            mstore(0, 1)
            mstore(32, 1)
            return(0, 64)
        }
    }
}

contract FreeTierHugeReturnOwner {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 100000)
        }
    }
}

contract FreeTierShortReturnOwner {
    fallback() external {
        assembly {
            mstore(0, 0x0100000000000000000000000000000000000000000000000000000000000000)
            return(0, 1)
        }
    }
}

contract FreeTierRevertingOwner {
    function isOperator(address) external pure returns (bool) {
        revert("no");
    }
}

contract FreeTierWrongTypeOwner {
    fallback() external {
        assembly {
            mstore(0, 2)
            return(0, 32)
        }
    }
}
