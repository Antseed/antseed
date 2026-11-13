// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedRegistry } from "../core/AntseedRegistry.sol";
import { AntseedUsageRewards } from "../emissions/AntseedUsageRewards.sol";
import { AntseedEmissionsGate } from "../emissions/AntseedEmissionsGate.sol";
import { AntseedLegacyEmissionsEscrow } from "../emissions/AntseedLegacyEmissionsEscrow.sol";
import { AntseedSellerPoolsRewards } from "../emissions/AntseedSellerPoolsRewards.sol";
import { AntseedUsageAccounting } from "../emissions/AntseedUsageAccounting.sol";
import { AntseedWashTradingRegistry } from "../integrity/AntseedWashTradingRegistry.sol";
import { AntseedPointsPolicyRegistry } from "../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../policies/AntseedWashTradingPointsPolicy.sol";
import { AntseedPositionInit } from "../sellers/AntseedPositionInit.sol";
import { AntseedSellerPools } from "../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../sellers/AntseedSellerRegistry.sol";
import {
    WashTradingDevelopmentBlockhashStore,
    WashTradingDevelopmentVerifier
} from "../test/mocks/WashTradingDevelopmentE2E.sol";

interface ILocalAntsAdmin {
    function owner() external view returns (address);
    function setRegistry(address registry) external;
    function setTransferWhitelist(address account, bool allowed) external;
}

interface ILocalLegacyEmissionsAdmin {
    function owner() external view returns (address);
    function setRegistry(address registry) external;
}

/**
 * @title DeployLocalFull
 * @notice Local Anvil (chain 31337) only. Lays the rest of the production contract stack on top of
 *         script/Deploy.s.sol so a fresh local chain has the layout Base runs: the recognized-usage stack
 *         (M001), free usage and the verification contracts (M003). The worktree testbench
 *         (e2e/testbench/lib/local-deploy.mjs) runs, in order:
 *           1. script/Deploy.s.sol (payments, legacy staking and emissions, stats, deposit relay)
 *           2. anvil_setCode: ANTSToken's runtime and storage copied to AntseedEmissionsGate.ANTS_TOKEN, the
 *              mainnet address the gate hardcodes
 *           3. this script's run(): M001 Deploy.s.sol's broadcast, adapted as listed below
 *           4. a warp past the gate's effective epoch boundary
 *           5. script/migrations/M001RecognizedUsage/Cutover.s.sol, unchanged (no DIEM proxy, as on testnets)
 *           6. script/DeployFreeUsage.s.sol, unchanged
 *           7. script/migrations/M003VerificationRegistry/Deploy.s.sol, unchanged
 *           8. this script's wireVerification(): M003's manual owner steps 1 and 3
 *
 *         Differences from M001 Deploy.s.sol, all because a fresh chain has no history:
 *           - the registry is pointed at the ANTS token at the gate's hardcoded address, and gets a team wallet;
 *           - the wash-trading registry uses the development verifier and blockhash store from
 *             test/mocks/WashTradingDevelopmentE2E.sol;
 *           - the legacy (V1) emissions clock starts at the local deploy, not at the gate's genesis, so the
 *             clock-equality and epoch-boundary guards are skipped. The legacy escrow is still funded and wired,
 *             so the pre-effective ANTS supply exists as on Base.
 *
 * Env (all optional except ANTSEED_REGISTRY and ANTS_TOKEN):
 *   DEPLOYER_PRIVATE_KEY  Broadcaster key (default: anvil account 0, the Deploy.s.sol deployer).
 *   ANTSEED_REGISTRY      AntseedRegistry from Deploy.s.sol.
 *   ANTS_TOKEN            The ANTS token copied to AntseedEmissionsGate.ANTS_TOKEN.
 *   TEAM_WALLET           Registry team wallet (default: anvil account 8).
 *   VERIFICATION_WALLET   Verification bucket controller until wireVerification() (default: anvil account 9).
 *   The gate takes one minter per controller, so these differ from each other and from the protocol reserve
 *   (Deploy.s.sol's deployer).
 */
contract DeployLocalFull is Script {
    bytes32 public constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    bytes32 public constant SELLER_POOLS_MINTER_ID = keccak256("antseed.emissions.seller-pools.v1");
    bytes32 public constant USAGE_MINTER_ID = keccak256("antseed.emissions.usage.v1");
    bytes32 public constant DEVELOPMENT_PROGRAM_VKEY = keccak256("antseed.local.wash-trading.vkey");
    uint256 internal constant ANVIL_ACCOUNT_0_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address internal constant ANVIL_ACCOUNT_8 = 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f;
    address internal constant ANVIL_ACCOUNT_9 = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720;

    function run() external {
        require(block.chainid == 31337, "DeployLocalFull: local Anvil (31337) only");
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_ACCOUNT_0_KEY);
        address deployer = vm.addr(key);
        AntseedRegistry registry = AntseedRegistry(vm.envAddress("ANTSEED_REGISTRY"));
        address antsToken = vm.envAddress("ANTS_TOKEN");
        address teamWallet = vm.envOr("TEAM_WALLET", ANVIL_ACCOUNT_8);
        address verificationWallet = vm.envOr("VERIFICATION_WALLET", ANVIL_ACCOUNT_9);

        address existingEmissions = registry.emissions();
        address existingChannels = registry.channels();
        address existingDeposits = registry.deposits();
        address existingStaking = registry.staking();
        address identityRegistry = registry.identityRegistry();
        address protocolReserve = registry.protocolReserve();
        require(antsToken.code.length > 0, "ANTS token has no code at ANTS_TOKEN");
        require(existingEmissions != address(0) && existingChannels != address(0), "run script/Deploy.s.sol first");
        require(existingDeposits != address(0) && existingStaking != address(0), "run script/Deploy.s.sol first");
        require(identityRegistry != address(0) && protocolReserve != address(0), "registry is not wired");
        require(ILocalAntsAdmin(antsToken).owner() == deployer, "deployer must own ANTSToken");
        require(ILocalLegacyEmissionsAdmin(existingEmissions).owner() == deployer, "deployer must own legacy emissions");

        vm.startBroadcast(key);

        registry.setAntsToken(antsToken);
        if (registry.teamWallet() == address(0)) registry.setTeamWallet(teamWallet);

        WashTradingDevelopmentBlockhashStore blockhashStore = new WashTradingDevelopmentBlockhashStore();
        WashTradingDevelopmentVerifier verifier =
            new WashTradingDevelopmentVerifier(DEVELOPMENT_PROGRAM_VKEY, bytes32(0), bytes32(0));
        AntseedWashTradingRegistry washTradingRegistry = new AntseedWashTradingRegistry(
            address(verifier), verifier.VERIFIER_HASH(), address(blockhashStore), DEVELOPMENT_PROGRAM_VKEY, 1, 1
        );

        // From here on, M001 Deploy.s.sol's broadcast in the same order.
        AntseedEmissionsGate gate = new AntseedEmissionsGate(registry.teamWallet(), protocolReserve, 15_000, 15_000);
        require(gate.ANTS_TOKEN() == antsToken, "ANTS_TOKEN is not the gate's hardcoded ANTS token");
        uint256 effectiveEpoch = gate.effectiveEpoch();

        AntseedSellerPools sellerPools =
            new AntseedSellerPools(antsToken, address(gate), identityRegistry, existingStaking);
        AntseedSellerRegistry sellerRegistry =
            new AntseedSellerRegistry(identityRegistry, address(sellerPools), existingStaking);
        sellerPools.setStakingSource(address(sellerRegistry));
        gate.setMinter(VERIFICATION_MINTER_ID, verificationWallet, 10_000, true);

        AntseedPositionInit positionInit =
            new AntseedPositionInit(address(sellerPools), existingStaking, 1 ether, effectiveEpoch + 104);
        AntseedUsageAccounting usageAccounting =
            new AntseedUsageAccounting(address(sellerPools), existingChannels, address(gate));
        AntseedPointsPolicyRegistry pointsPolicyRegistry = new AntseedPointsPolicyRegistry(deployer);
        AntseedWashTradingPointsPolicy washTradingPointsPolicy =
            new AntseedWashTradingPointsPolicy(address(washTradingRegistry));
        pointsPolicyRegistry.registerPolicy(address(washTradingPointsPolicy));
        usageAccounting.setPointsPolicy(address(pointsPolicyRegistry));

        AntseedSellerPoolsRewards sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        AntseedUsageRewards usageRewards =
            new AntseedUsageRewards(address(gate), address(usageAccounting), identityRegistry, existingDeposits);
        usageRewards.setSellerPools(address(sellerPools));
        usageAccounting.setUsageRewards(address(usageRewards));
        usageRewards.setClaimForwarder(address(usageAccounting));

        AntseedLegacyEmissionsEscrow legacyEscrow =
            new AntseedLegacyEmissionsEscrow(address(registry), existingEmissions);

        ILocalAntsAdmin(antsToken).setTransferWhitelist(address(sellerPools), true);
        ILocalAntsAdmin(antsToken).setTransferWhitelist(address(usageRewards), true);
        ILocalAntsAdmin(antsToken).setTransferWhitelist(address(sellerPoolsRewards), true);
        ILocalAntsAdmin(antsToken).setTransferWhitelist(address(legacyEscrow), true);
        ILocalAntsAdmin(antsToken).setTransferWhitelist(address(positionInit), true);
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(sellerPoolsRewards), 40_000, true);
        gate.setMinter(USAGE_MINTER_ID, address(usageRewards), 20_000, true);

        ILocalAntsAdmin(antsToken).setRegistry(address(gate));
        uint256 escrowAmount = gate.fundLegacyEscrow(address(legacyEscrow));
        ILocalLegacyEmissionsAdmin(existingEmissions).setRegistry(address(legacyEscrow));

        vm.stopBroadcast();

        require(gate.owner() == deployer, "unexpected gate owner");
        require(pointsPolicyRegistry.policyCount() == 1, "unexpected points policy count");
        console.log("WashTradingRegistry:     ", address(washTradingRegistry));
        console.log("EmissionsGate:           ", address(gate));
        console.log("SellerPools:             ", address(sellerPools));
        console.log("SellerRegistry:          ", address(sellerRegistry));
        console.log("PositionInit:            ", address(positionInit));
        console.log("UsageAccounting:         ", address(usageAccounting));
        console.log("PointsPolicyRegistry:    ", address(pointsPolicyRegistry));
        console.log("WashTradingPointsPolicy: ", address(washTradingPointsPolicy));
        console.log("SellerPoolsRewards:      ", address(sellerPoolsRewards));
        console.log("UsageRewards:            ", address(usageRewards));
        console.log("LegacyEmissionsEscrow:   ", address(legacyEscrow));
        console.log("Legacy escrow funded:    ", escrowAmount);
        console.log("Effective epoch:         ", effectiveEpoch);
    }

    /**
     * @notice M003's manual owner steps 1 and 3 (script/migrations/M003VerificationRegistry/README.md): the
     *         verification bucket moves to the results layer and the verification points policy is registered.
     *         Auditor approvals and the rewards start epoch (steps 2 and 4) are left to the scenario that needs them.
     *
     * Env: DEPLOYER_PRIVATE_KEY (optional), EMISSIONS_GATE, POINTS_POLICY_REGISTRY, VERIFICATION_RESULTS,
     *      VERIFICATION_POINTS_POLICY.
     */
    function wireVerification() external {
        require(block.chainid == 31337, "DeployLocalFull: local Anvil (31337) only");
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_ACCOUNT_0_KEY);
        AntseedEmissionsGate gate = AntseedEmissionsGate(vm.envAddress("EMISSIONS_GATE"));
        AntseedPointsPolicyRegistry pointsPolicyRegistry =
            AntseedPointsPolicyRegistry(vm.envAddress("POINTS_POLICY_REGISTRY"));
        address results = vm.envAddress("VERIFICATION_RESULTS");
        address policy = vm.envAddress("VERIFICATION_POINTS_POLICY");
        vm.startBroadcast(key);
        (address controller,,) = gate.minters(VERIFICATION_MINTER_ID);
        if (controller != results) gate.setMinterController(VERIFICATION_MINTER_ID, results);
        if (!pointsPolicyRegistry.isPolicyRegistered(policy)) pointsPolicyRegistry.registerPolicy(policy);
        vm.stopBroadcast();
        (controller,,) = gate.minters(VERIFICATION_MINTER_ID);
        require(controller == results, "verification bucket not on the results layer");
        require(pointsPolicyRegistry.isPolicyRegistered(policy), "verification points policy not registered");
    }
}
