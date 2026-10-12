// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";

import { IAntseedRegistry } from "../../interfaces/IAntseedRegistry.sol";

interface IAntseedRegistryForkAdmin is IAntseedRegistry {
    function owner() external view returns (address);
    function setEmissions(address emissions) external;
    function setStaking(address staking) external;
}

contract ForkCutoverTarget { }

contract M001RecognizedUsageForkTest is Test {
    uint256 internal constant BASE_MAINNET_CHAIN_ID = 8453;
    address internal constant REGISTRY = 0xf33fC901BFa97326379A369401F4490E231B69B0;
    address internal constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    address internal constant CHANNELS = 0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d;
    address internal constant DEPOSITS = 0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2;
    address internal constant LEGACY_EMISSIONS = 0xF13bE52c4A3afC6AE29536f073588d01A0564088;
    address internal constant LEGACY_STAKING = 0x3652E6B22919bd322A25723B94BB207602E5c8e6;

    function testFork_m001BaselineMatchesCanonicalDeployment() public {
        if (!_selectFork()) return;
        assertEq(block.chainid, BASE_MAINNET_CHAIN_ID);

        IAntseedRegistry registry = IAntseedRegistry(REGISTRY);
        assertGt(REGISTRY.code.length, 0);
        assertEq(registry.antsToken(), ANTS_TOKEN);
        assertEq(registry.channels(), CHANNELS);
        assertEq(registry.deposits(), DEPOSITS);
        assertEq(registry.emissions(), LEGACY_EMISSIONS);
        assertEq(registry.staking(), LEGACY_STAKING);

        assertGt(ANTS_TOKEN.code.length, 0);
        assertGt(CHANNELS.code.length, 0);
        assertGt(DEPOSITS.code.length, 0);
        assertGt(LEGACY_EMISSIONS.code.length, 0);
        assertGt(LEGACY_STAKING.code.length, 0);
    }

    function testFork_registryOwnerCanApplyM001PointerFlip() public {
        if (!_selectFork()) return;

        IAntseedRegistryForkAdmin registry = IAntseedRegistryForkAdmin(REGISTRY);
        address registryOwner = registry.owner();
        address usageAccounting = address(new ForkCutoverTarget());
        address sellerRegistry = address(new ForkCutoverTarget());

        vm.startPrank(registryOwner);
        registry.setEmissions(usageAccounting);
        registry.setStaking(sellerRegistry);
        vm.stopPrank();

        assertEq(registry.emissions(), usageAccounting);
        assertEq(registry.staking(), sellerRegistry);
        assertEq(registry.antsToken(), ANTS_TOKEN);
        assertEq(registry.channels(), CHANNELS);
        assertEq(registry.deposits(), DEPOSITS);
    }

    function _selectFork() private returns (bool) {
        string memory rpcUrl = vm.envOr("BASE_MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return false;

        uint256 forkBlock = vm.envOr("BASE_MAINNET_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }
        return true;
    }
}
