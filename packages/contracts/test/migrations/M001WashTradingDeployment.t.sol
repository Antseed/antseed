pragma solidity ^0.8.24;

import { Test, Vm } from "forge-std/Test.sol";
import { M001DeployRecognizedUsage } from "../../script/migrations/M001RecognizedUsage/Deploy.s.sol";
import { AntseedWashTradingRegistry } from "../../integrity/AntseedWashTradingRegistry.sol";
import { AntseedRegistry } from "../../core/AntseedRegistry.sol";
import { ANTSToken } from "../../core/ANTSToken.sol";
import { AntseedPositionInit } from "../../sellers/AntseedPositionInit.sol";
import { AntseedWashTradingPointsPolicy } from "../../policies/AntseedWashTradingPointsPolicy.sol";
import { AntseedPointsPolicyRegistry } from "../../policies/AntseedPointsPolicyRegistry.sol";
import { MockERC8004Registry } from "../mocks/MockERC8004Registry.sol";
import { MockSP1Verifier, MockBlockhashStore } from "../AntseedWashTradingRegistry.t.sol";

contract M001WashTradingDeployHarness is M001DeployRecognizedUsage {
    function deployWashTradingRegistry() external returns (AntseedWashTradingRegistry) {
        return _deployWashTradingRegistry();
    }
}

contract M001LegacyClock {
    address public owner;
    address public registry;
    uint256 public constant genesis = 1_775_728_461;
    uint256 public constant EPOCH_DURATION = 1 weeks;

    constructor(address deployer) {
        owner = deployer;
    }

    function currentEpoch() external view returns (uint256) {
        return (block.timestamp - genesis) / EPOCH_DURATION;
    }

    function setRegistry(address target) external {
        require(msg.sender == owner);
        registry = target;
    }
}

contract M001WashTradingDeploymentTest is Test {
    address internal constant CHAINLINK_STORE = 0x78b69899C8cD252126cBB1A50171ec37286C3877;
    address internal constant ANTS_TOKEN = 0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263;
    bytes32 internal constant SELLER_VKEY = bytes32(uint256(11));
    M001WashTradingDeployHarness internal script;
    MockSP1Verifier internal verifier;

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1_775_728_461 + 8 days);
        script =
            M001WashTradingDeployHarness(deployCode("M001WashTradingDeployment.t.sol:M001WashTradingDeployHarness"));
        verifier = new MockSP1Verifier();
    }

    function _configureEnvironment() internal {
        vm.chainId(8453);
        vm.etch(CHAINLINK_STORE, address(new MockBlockhashStore()).code);
        vm.setEnv("SP1_VERIFIER", vm.toString(address(verifier)));
        vm.setEnv("SP1_VERIFIER_HASH", vm.toString(verifier.VERIFIER_HASH()));
        vm.setEnv("WASH_TRADING_BLOCKHASH_STORE", vm.toString(CHAINLINK_STORE));
        vm.setEnv("WASH_TRADING_SELLER_PROGRAM_VKEY", vm.toString(SELLER_VKEY));
        vm.setEnv("HISTORICAL_PERIOD_START_BLOCK", "100");
        vm.setEnv("HISTORICAL_PERIOD_END_BLOCK", "199");
    }

    function test_registryDeploymentConfigurationAndFullM001Wiring() public {
        _configureEnvironment();
        _checkPinnedProofConfiguration();
        _configureEnvironment();
        _checkNonChainlinkStoreOnBase();
        _configureEnvironment();
        _checkMissingStoreCode();
        _configureEnvironment();
        _checkExplicitTestnetStore();
        _configureEnvironment();
        _checkVerifierReleaseMismatch();
        _configureEnvironment();
        _checkTruncatedBlockRange();
        _configureEnvironment();
        _checkInvalidBlockRange();
        _configureEnvironment();
        _checkFullDeployPinsNewRegistryIntoPointsPolicy();
    }

    function _checkPinnedProofConfiguration() internal {
        _assertRegistry(script.deployWashTradingRegistry());
    }

    function _checkNonChainlinkStoreOnBase() internal {
        vm.setEnv("WASH_TRADING_BLOCKHASH_STORE", vm.toString(address(new MockBlockhashStore())));
        vm.expectRevert("Base registry must use Chainlink BlockhashStore");
        script.deployWashTradingRegistry();
    }

    function _checkMissingStoreCode() internal {
        vm.etch(CHAINLINK_STORE, hex"");
        vm.expectRevert("blockhash store has no code");
        script.deployWashTradingRegistry();
    }

    function _checkExplicitTestnetStore() internal {
        vm.chainId(84532);
        address store = address(new MockBlockhashStore());
        vm.setEnv("WASH_TRADING_BLOCKHASH_STORE", vm.toString(store));
        assertEq(address(script.deployWashTradingRegistry().blockhashStore()), store);
    }

    function _checkVerifierReleaseMismatch() internal {
        vm.setEnv("SP1_VERIFIER_HASH", vm.toString(bytes32(uint256(999))));
        vm.expectRevert(AntseedWashTradingRegistry.InvalidVerifier.selector);
        script.deployWashTradingRegistry();
    }

    function _checkTruncatedBlockRange() internal {
        vm.setEnv("HISTORICAL_PERIOD_END_BLOCK", vm.toString(uint256(type(uint64).max) + 1));
        vm.expectRevert("historical period exceeds uint64");
        script.deployWashTradingRegistry();
    }

    function _checkInvalidBlockRange() internal {
        vm.setEnv("HISTORICAL_PERIOD_START_BLOCK", "200");
        vm.expectRevert(AntseedWashTradingRegistry.InvalidConfiguration.selector);
        script.deployWashTradingRegistry();
    }

    function _checkFullDeployPinsNewRegistryIntoPointsPolicy() internal {
        address deployer = makeAddr("m001-deployer");
        vm.deal(deployer, 100 ether);
        deployCodeTo("ANTSToken.sol:ANTSToken", ANTS_TOKEN);
        ANTSToken token = ANTSToken(ANTS_TOKEN);
        AntseedRegistry registry = new AntseedRegistry();
        M001LegacyClock legacy = new M001LegacyClock(deployer);
        registry.setAntsToken(ANTS_TOKEN);
        registry.setIdentityRegistry(address(new MockERC8004Registry()));
        registry.setTeamWallet(address(0xA11CE));
        registry.setProtocolReserve(address(0xB0B));
        registry.setEmissions(address(legacy));
        registry.setStaking(address(legacy));
        registry.setChannels(address(legacy));
        registry.setDeposits(address(legacy));
        token.setRegistry(address(registry));
        token.transferOwnership(deployer);
        vm.setEnv("DEPLOYER", vm.toString(deployer));
        vm.setEnv("ANTSEED_REGISTRY", vm.toString(address(registry)));
        vm.setEnv("EXPECTED_ANTS_TOKEN", vm.toString(ANTS_TOKEN));
        vm.setEnv("EXPECTED_CHANNELS", vm.toString(address(legacy)));
        vm.setEnv("EXPECTED_LEGACY_EMISSIONS", vm.toString(address(legacy)));
        vm.setEnv("EXPECTED_LEGACY_STAKING", vm.toString(address(legacy)));
        vm.setEnv("VERIFICATION_WALLET", vm.toString(address(0xF1ED)));
        vm.setEnv("EMISSIONS_RESERVE_WALLET", vm.toString(address(0)));
        vm.setEnv("POSITION_INIT_AMOUNT", "1000000000000000000");
        vm.setEnv("POSITION_INIT_END_EPOCH", "106");
        vm.setEnv("WASH_TRADING_REGISTRY", vm.toString(address(0xDEAD)));
        address expectedWashRegistry = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        vm.recordLogs();
        script.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address faucet;
        address policy;
        address policyRegistry;
        for (uint256 index; index < logs.length; index++) {
            if (
                faucet == address(0) && logs[index].emitter == ANTS_TOKEN
                    && logs[index].topics[0] == keccak256("Approval(address,address,uint256)")
            ) {
                faucet = address(uint160(uint256(logs[index].topics[1])));
            }
            if (logs[index].topics[0] == keccak256("PolicyRegistered(address,uint256)")) {
                policy = address(uint160(uint256(logs[index].topics[1])));
                policyRegistry = logs[index].emitter;
            }
        }
        assertTrue(faucet != address(0));
        assertTrue(policy != address(0));
        assertEq(address(AntseedWashTradingPointsPolicy(policy).washTradingRegistry()), expectedWashRegistry);
        assertEq(AntseedPointsPolicyRegistry(policyRegistry).policyCount(), 1);
        assertTrue(AntseedPointsPolicyRegistry(policyRegistry).isPolicyRegistered(policy));
        _assertRegistry(AntseedWashTradingRegistry(expectedWashRegistry));
        assertEq(registry.emissions(), address(legacy));
        assertEq(registry.staking(), address(legacy));
        assertTrue(token.transferWhitelist(faucet));
    }

    function _assertRegistry(AntseedWashTradingRegistry registry) internal view {
        assertEq(address(registry.verifier()), address(verifier));
        assertEq(registry.verifierHash(), verifier.VERIFIER_HASH());
        assertEq(address(registry.blockhashStore()), CHAINLINK_STORE);
        assertEq(registry.sellerProgramVKey(), SELLER_VKEY);
        assertEq(registry.periodStartBlock(), 100);
        assertEq(registry.periodEndBlock(), 199);
        assertFalse(registry.isProvenWashTrader(address(0xA11CE)));
    }
}
