// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";

contract DeployWashTradingRegistry is Script {
    /// @notice Chainlink BlockhashStore on Base mainnet; the registry authenticates every proof
    ///         block reference against this public store.
    address internal constant BASE_CHAINLINK_BLOCKHASH_STORE = 0x78b69899C8cD252126cBB1A50171ec37286C3877;

    function run() external returns (AntseedWashTradingRegistry registry) {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address blockhashStore = vm.envOr("WASH_TRADING_BLOCKHASH_STORE", BASE_CHAINLINK_BLOCKHASH_STORE);
        require(blockhashStore.code.length != 0, "blockhash store has no code");
        if (block.chainid == 8453) {
            require(blockhashStore == BASE_CHAINLINK_BLOCKHASH_STORE, "Base registry must use Chainlink BlockhashStore");
        }

        vm.startBroadcast(deployerPrivateKey);
        registry = new AntseedWashTradingRegistry(
            vm.envAddress("SP1_VERIFIER"),
            vm.envBytes32("SP1_VERIFIER_HASH"),
            blockhashStore,
            vm.envBytes32("WASH_TRADING_SELLER_PROGRAM_VKEY"),
            uint64(vm.envUint("HISTORICAL_PERIOD_START_BLOCK")),
            uint64(vm.envUint("HISTORICAL_PERIOD_END_BLOCK"))
        );
        vm.stopBroadcast();

        console.log("AntseedWashTradingRegistry:", address(registry));
    }
}
