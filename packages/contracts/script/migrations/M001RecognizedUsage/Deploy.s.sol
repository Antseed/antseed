// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import { AntseedUsageRewards } from "../../../emissions/AntseedUsageRewards.sol";
import { AntseedEmissionsGate } from "../../../emissions/AntseedEmissionsGate.sol";
import { AntseedLegacyEmissionsEscrow } from "../../../emissions/AntseedLegacyEmissionsEscrow.sol";
import { AntseedSellerPoolsRewards } from "../../../emissions/AntseedSellerPoolsRewards.sol";
import { AntseedUsageAccounting } from "../../../emissions/AntseedUsageAccounting.sol";
import { AntseedWashTradingRegistry } from "../../../integrity/AntseedWashTradingRegistry.sol";
import { IAntseedRegistry } from "../../../interfaces/IAntseedRegistry.sol";
import { AntseedPointsPolicyRegistry } from "../../../policies/AntseedPointsPolicyRegistry.sol";
import { AntseedWashTradingPointsPolicy } from "../../../policies/AntseedWashTradingPointsPolicy.sol";
import { AntseedPositionInit } from "../../../sellers/AntseedPositionInit.sol";
import { AntseedSellerPools } from "../../../sellers/AntseedSellerPools.sol";
import { AntseedSellerRegistry } from "../../../sellers/AntseedSellerRegistry.sol";

interface IANTSTokenAdmin {
    function owner() external view returns (address);
    function setRegistry(address registry) external;
    function setTransferWhitelist(address account, bool allowed) external;
}

interface IAntseedLegacyEmissionsClock {
    function genesis() external view returns (uint256);
    function EPOCH_DURATION() external view returns (uint256);
    function currentEpoch() external view returns (uint256);
}

interface IAntseedLegacyEmissionsAdmin {
    function owner() external view returns (address);
    function setRegistry(address registry) external;
}

/**
 * @title M001DeployRecognizedUsage
 * @notice Broadcast #1 of the two-broadcast cutover. Deploys the seller-pool /
 *         recognized-usage stack, moves the ANTS mint authority to
 *         AntseedEmissionsGate, funds the legacy escrow, and re-points the
 *         legacy emissions contract at it. It deliberately does NOT touch the
 *         registry emissions/staking pointers: the network keeps running on
 *         the legacy stack (claims paid from the escrow pot) until
 *         M001 Cutover runs in the next epoch. That split lets the
 *         in-flight epoch finalize and be claimed from legacy V2 (with its
 *         real pot) BEFORE the pointer flip, so the deployed DiemStakingProxy
 *         can never freeze the cutover epoch at a zero pot.
 *
 * Signer: this script never reads a private key. It broadcasts as DEPLOYER
 * (an address) and Foundry resolves the matching signer from the wallet
 * options on the command line (--account <keystore>, --ledger, --trezor, or
 * --interactive). DEPLOYER must own ANTSToken and the legacy emissions
 * contract (checked upfront).
 *
 * Required env:
 *   DEPLOYER               Broadcaster address (see above).
 *   ANTSEED_REGISTRY       Existing (legacy) AntseedRegistry address.
 *   EXPECTED_ANTS_TOKEN    Current registry antsToken pointer.
 *   EXPECTED_CHANNELS      Current registry channels pointer.
 *   EXPECTED_LEGACY_EMISSIONS Current registry emissions pointer.
 *   EXPECTED_LEGACY_STAKING   Current registry staking pointer.
 *   VERIFICATION_WALLET    Recipient of the verification bucket.
 *   SP1_VERIFIER           Concrete SP1 verifier deployment (not the gateway).
 *   SP1_VERIFIER_HASH      Expected concrete verifier release hash.
 *   WASH_TRADING_SELLER_PROGRAM_VKEY  Historical seller proof program vkey.
 *   HISTORICAL_PERIOD_START_BLOCK    First block covered by historical proofs.
 *   HISTORICAL_PERIOD_END_BLOCK      Last block covered by historical proofs.
 *
 * Optional env:
 *   WASH_TRADING_BLOCKHASH_STORE      Defaults to Chainlink's Base store;
 *                                     that address is mandatory on Base mainnet.
 *   EMISSIONS_RESERVE_WALLET          Destination for ANTS emission reserve flows
 *                                     via the reserve minter controller. Unset =
 *                                     ANTS reserve flows use protocolReserve.
 *   POSITION_INIT_AMOUNT              ANTS per starter position (default 1e18).
 *   POSITION_INIT_END_EPOCH           Shared end epoch of all starter
 *                                     positions; claims stop once reached
 *                                     (default effectiveEpoch + 104).
 *
 * Usage:
 *   cd packages/contracts
 *   source .env
 *   forge script script/migrations/M001RecognizedUsage/Deploy.s.sol:M001DeployRecognizedUsage \
 *     --rpc-url $BASE_MAINNET_RPC_URL \
 *     --account deployer \
 *     --broadcast \
 *     --verify \
 *     --etherscan-api-key $BASESCAN_API_KEY \
 *     --via-ir
 */
contract M001DeployRecognizedUsage is Script {
    bytes32 public constant VERIFICATION_MINTER_ID = keccak256("antseed.emissions.verification.v1");
    bytes32 public constant SELLER_POOLS_MINTER_ID = keccak256("antseed.emissions.seller-pools.v1");
    bytes32 public constant USAGE_MINTER_ID = keccak256("antseed.emissions.usage.v1");
    address internal constant BASE_CHAINLINK_BLOCKHASH_STORE = 0x78b69899C8cD252126cBB1A50171ec37286C3877;

    function run() external {
        address deployer = vm.envAddress("DEPLOYER");
        address registryAddress = vm.envAddress("ANTSEED_REGISTRY");

        IAntseedRegistry registry = IAntseedRegistry(registryAddress);
        address antsToken = registry.antsToken();
        address existingEmissions = registry.emissions();
        address existingChannels = registry.channels();
        address existingDeposits = registry.deposits();
        address existingStaking = registry.staking();
        address expectedEmissions = vm.envAddress("EXPECTED_LEGACY_EMISSIONS");
        address expectedStaking = vm.envAddress("EXPECTED_LEGACY_STAKING");
        address expectedChannels = vm.envAddress("EXPECTED_CHANNELS");
        address expectedAntsToken = vm.envAddress("EXPECTED_ANTS_TOKEN");
        require(antsToken != address(0), "ANTS token not set");
        require(antsToken == expectedAntsToken, "unexpected ANTS token");
        require(existingEmissions == expectedEmissions, "unexpected legacy emissions");
        require(existingStaking == expectedStaking, "unexpected legacy staking");
        require(existingChannels == expectedChannels, "unexpected channels");
        require(existingEmissions != address(0), "existing emissions not set");
        require(existingChannels != address(0), "channels not set");
        require(existingDeposits != address(0), "deposits not set");
        require(existingStaking != address(0), "staking not set");

        address verificationWallet = vm.envAddress("VERIFICATION_WALLET");
        require(verificationWallet != address(0), "verification wallet not set");
        address emissionsReserveWallet = vm.envOr("EMISSIONS_RESERVE_WALLET", address(0));
        address teamWallet = registry.teamWallet();
        address protocolReserve = registry.protocolReserve();
        address identityRegistry = registry.identityRegistry();
        require(teamWallet != address(0), "team wallet not set");
        require(protocolReserve != address(0), "protocol reserve not set");
        require(identityRegistry != address(0), "identity registry not set");

        // On mainnet the deployer EOA and the protocol owner key differ; this
        // broadcast performs owner-gated calls on both contracts, so fail the
        // simulation before any tx is sent rather than mid-broadcast.
        require(IANTSTokenAdmin(antsToken).owner() == deployer, "deployer must own ANTSToken");
        require(
            IAntseedLegacyEmissionsAdmin(existingEmissions).owner() == deployer, "deployer must own legacy emissions"
        );

        // Minter share checkpoints activate at currentEpoch()+1 == the gate's
        // effectiveEpoch only if every setMinter lands in the same epoch as
        // the gate's construction. A broadcast straddling an epoch boundary
        // would leave the effective epoch's buckets at zero share forever, so
        // refuse to start near the boundary.
        {
            uint256 legacyGenesis = IAntseedLegacyEmissionsClock(existingEmissions).genesis();
            uint256 legacyEpochDuration = IAntseedLegacyEmissionsClock(existingEmissions).EPOCH_DURATION();
            uint256 legacyCurrentEpoch = IAntseedLegacyEmissionsClock(existingEmissions).currentEpoch();
            uint256 nextBoundary = legacyGenesis + (legacyCurrentEpoch + 1) * legacyEpochDuration;
            require(
                nextBoundary - block.timestamp > 1 hours, "too close to epoch boundary; deploy earlier in the epoch"
            );
        }

        vm.startBroadcast(deployer);

        AntseedWashTradingRegistry washTradingRegistry = _deployWashTradingRegistry();
        console.log("WashTradingRegistry:    ", address(washTradingRegistry));

        AntseedEmissionsGate gate = new AntseedEmissionsGate(teamWallet, protocolReserve, 15_000, 15_000);
        if (emissionsReserveWallet != address(0)) {
            gate.setMinterController(gate.RESERVE_MINTER_ID(), emissionsReserveWallet);
        }
        uint256 currentEpoch = gate.currentEpoch();
        uint256 effectiveEpoch = gate.effectiveEpoch();
        uint256 genesis = gate.genesis();
        uint256 epochDuration = gate.epochDuration();

        // The escrow funding below settles pre-effective epochs on the
        // gate's schedule, so the legacy and gate clocks must agree.
        require(
            IAntseedLegacyEmissionsClock(existingEmissions).genesis() == genesis
                && IAntseedLegacyEmissionsClock(existingEmissions).EPOCH_DURATION() == epochDuration,
            "legacy emissions clock mismatch"
        );

        console.log("=== AntSeed Recognized Usage Deployment ===");
        console.log("Deployer:               ", deployer);
        console.log("Legacy Registry:        ", registryAddress);
        console.log("ANTS Token:             ", antsToken);
        console.log("Existing Emissions:     ", existingEmissions);
        console.log("Existing Channels:      ", existingChannels);
        console.log("Existing Deposits:      ", existingDeposits);
        console.log("Existing Staking:       ", existingStaking);
        console.log("Team Wallet:            ", teamWallet);
        console.log("Protocol Reserve:       ", protocolReserve);
        console.log("Genesis:                ", genesis);
        console.log("Epoch Duration:         ", epochDuration);
        console.log("Current Epoch:          ", currentEpoch);
        console.log("Effective Epoch:        ", effectiveEpoch);
        console.log("");

        AntseedSellerPools sellerPools =
            new AntseedSellerPools(antsToken, address(gate), identityRegistry, existingStaking);
        console.log("SellerPools:          ", address(sellerPools));

        AntseedSellerRegistry sellerRegistry =
            new AntseedSellerRegistry(identityRegistry, address(sellerPools), existingStaking);
        console.log("SellerRegistry:       ", address(sellerRegistry));

        // SellerPools is constructed against the legacy staking contract only
        // because SellerRegistry doesn't exist yet (circular constructor
        // dependency). Re-point it now: agentIdForSeller and pool-creation
        // ownership checks must resolve sellers registered in the new
        // SellerRegistry, not just legacy stakers (SellerRegistry itself
        // falls back to legacy bindings, so old sellers keep resolving).
        sellerPools.setStakingSource(address(sellerRegistry));

        console.log("EmissionsGate:          ", address(gate));
        gate.setMinter(VERIFICATION_MINTER_ID, verificationWallet, 10_000, true);

        // Starter-position faucet: every existing legacy seller can create one
        // small ANTS position in their own pool, so pools have nonzero power
        // (and usage accounting turns on) from the first rewarded epoch even
        // though nobody holds transferable ANTS yet. All starter positions
        // share one end epoch (default: max lock measured from the first
        // rewarded epoch), so a late claim never outweighs an early one and
        // the faucet expires by itself. Unowned and immutable — it also
        // switches off when its funded pot runs out.
        AntseedPositionInit positionInit = new AntseedPositionInit(
            address(sellerPools),
            existingStaking,
            vm.envOr("POSITION_INIT_AMOUNT", uint256(1 ether)),
            vm.envOr("POSITION_INIT_END_EPOCH", effectiveEpoch + 104)
        );
        console.log("PositionInit:         ", address(positionInit));
        console.log("PositionInit end epoch:", positionInit.initEndEpoch());

        AntseedUsageAccounting usageAccounting =
            new AntseedUsageAccounting(address(sellerPools), existingChannels, address(gate));
        console.log("UsageAccounting:        ", address(usageAccounting));

        AntseedPointsPolicyRegistry pointsPolicyRegistry = new AntseedPointsPolicyRegistry(deployer);
        AntseedWashTradingPointsPolicy washTradingPointsPolicy =
            new AntseedWashTradingPointsPolicy(address(washTradingRegistry));
        pointsPolicyRegistry.registerPolicy(address(washTradingPointsPolicy));
        usageAccounting.setPointsPolicy(address(pointsPolicyRegistry));
        console.log("PointsPolicyRegistry:   ", address(pointsPolicyRegistry));
        console.log("WashTradingPointsPolicy:", address(washTradingPointsPolicy));

        AntseedSellerPoolsRewards sellerPoolsRewards =
            new AntseedSellerPoolsRewards(address(gate), address(sellerPools), address(usageAccounting));
        console.log("SellerPoolsRewards: ", address(sellerPoolsRewards));

        AntseedUsageRewards usageRewards =
            new AntseedUsageRewards(address(gate), address(usageAccounting), identityRegistry, existingDeposits);
        usageRewards.setSellerPools(address(sellerPools));
        console.log("UsageRewards:       ", address(usageRewards));

        // Seller delegation adapter: already-deployed delegation contracts
        // (e.g. DiemStakingProxy) call the legacy pendingEmissions /
        // claimSellerEmissions selectors on registry.emissions(). The
        // accounting contract adapts those to agent usage rewards, and the
        // rewards controller lets it initiate owner-destined claims.
        usageAccounting.setUsageRewards(address(usageRewards));
        usageRewards.setClaimForwarder(address(usageAccounting));

        // Legacy emissions escrow: the deployed legacy emissions contract is
        // re-pointed at this registry facade whose antsToken() is the escrow
        // itself, so its unchanged mint() claims draw from a fixed pre-minted
        // pot instead of minting. The gate then refuses pre-effective epochs
        // unconditionally.
        AntseedLegacyEmissionsEscrow legacyEscrow = new AntseedLegacyEmissionsEscrow(registryAddress, existingEmissions);
        console.log("LegacyEmissionsEscrow:  ", address(legacyEscrow));

        // SellerPools must be able to pay out withdrawals and slash to the dead
        // address. UsageRewards must be able to stake claimed rewards via
        // stakeFor, SellerPoolsRewards to pay out and restake indexed staker
        // rewards, and the escrow to pay legacy claims — all while ANTS
        // transfers are globally disabled.
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(sellerPools), true);
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(usageRewards), true);
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(sellerPoolsRewards), true);
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(legacyEscrow), true);
        // The starter-position faucet is the transfer sender when it stakes
        // into SellerPools on sellers' behalf.
        IANTSTokenAdmin(antsToken).setTransferWhitelist(address(positionInit), true);
        sellerPools.setRewardStaker(address(sellerPoolsRewards), true);
        gate.setMinter(SELLER_POOLS_MINTER_ID, address(sellerPoolsRewards), 40_000, true);
        gate.setMinter(USAGE_MINTER_ID, address(usageRewards), 20_000, true);

        // Mint authority moves only after every bucket minter is configured: a
        // broadcast that fails before this line leaves the legacy emissions
        // path untouched, and one that fails after it leaves the new path
        // fully mintable. The escrow is funded and wired immediately after so
        // legacy claims never touch a token that only accepts the gate.
        //
        // The registry emissions/staking pointers are deliberately NOT flipped
        // here. Until Cutover.s.sol runs (next epoch), the network keeps
        // operating fully on the legacy stack: Channels accruals, seller
        // eligibility, and all legacy claims — now paid from the escrow pot —
        // keep working, while the gate cannot mint anything (its first
        // mintable epoch is effectiveEpoch, claimable only once the epoch
        // after it starts). There is no moment where both stacks can emit for
        // the same epoch.
        IANTSTokenAdmin(antsToken).setRegistry(address(gate));
        uint256 escrowAmount = gate.fundLegacyEscrow(address(legacyEscrow));
        IAntseedLegacyEmissionsAdmin(existingEmissions).setRegistry(address(legacyEscrow));
        console.log("Legacy escrow funded:   ", escrowAmount);

        vm.stopBroadcast();

        (address verificationController, uint32 verificationShareBps, bool verificationEditable) =
            gate.minters(VERIFICATION_MINTER_ID);
        require(verificationController == verificationWallet, "unexpected verification controller");
        require(verificationShareBps == 10_000, "unexpected verification share");
        require(verificationEditable, "verification minter must remain editable");
        require(pointsPolicyRegistry.policyCount() == 1, "unexpected points policy count");
        require(pointsPolicyRegistry.isPolicyRegistered(address(washTradingPointsPolicy)), "wash policy missing");
        require(gate.owner() == deployer, "unexpected gate owner");
        require(gate.pendingOwner() == address(0), "unexpected pending gate owner");
        require(pointsPolicyRegistry.owner() == deployer, "unexpected points registry owner");
        require(pointsPolicyRegistry.pendingOwner() == address(0), "unexpected pending points registry owner");

        console.log("");
        console.log("=== Recognized usage deployment complete (broadcast 1 of 2) ===");
        console.log("Token gate is:            ", address(gate));
        console.log("Registry emissions:        UNCHANGED (legacy) until Cutover");
        console.log("Registry staking:          UNCHANGED (legacy) until Cutover");
        console.log("Seller pools bucket:      2-40% dynamic (40% max)");
        console.log("Usage bucket:             buyer 5-10%, seller/operator 5-10% dynamic (20% max)");
        console.log("Team bucket:              15%");
        console.log("Reserve bucket:           15%");
        console.log("Verification bucket:      10%");
        console.log("Seller pools minter:      ", address(sellerPoolsRewards));
        console.log("Usage minter:             ", address(usageRewards));
        console.log("Legacy claims minter:     ", existingEmissions);
        console.log("Legacy claims deposits:   ", existingDeposits);
        console.log("Team recipient:           ", teamWallet);
        console.log("Reserve recipient:        ", gate.emissionsReserve());
        console.log("Verification recipient:   ", verificationWallet);
        console.log("Points policy registry:   ", address(pointsPolicyRegistry));
        console.log("Points policies:           NONE REGISTERED by this broadcast");
        console.log("Emissions gate owner:      ", gate.owner());
        console.log("Points policy owner:       ", pointsPolicyRegistry.owner());
        console.log("");
        console.log("Next: see script/migrations/M001RecognizedUsage/README.md for the");
        console.log("cutover (broadcast 2 of 2) and the post-flip checklist.");
    }

    function _deployWashTradingRegistry() internal returns (AntseedWashTradingRegistry) {
        address blockhashStore = vm.envOr("WASH_TRADING_BLOCKHASH_STORE", BASE_CHAINLINK_BLOCKHASH_STORE);
        require(blockhashStore.code.length != 0, "blockhash store has no code");
        if (block.chainid == 8453) {
            require(blockhashStore == BASE_CHAINLINK_BLOCKHASH_STORE, "Base registry must use Chainlink BlockhashStore");
        }
        uint256 periodStart = vm.envUint("HISTORICAL_PERIOD_START_BLOCK");
        uint256 periodEnd = vm.envUint("HISTORICAL_PERIOD_END_BLOCK");
        require(periodStart <= type(uint64).max && periodEnd <= type(uint64).max, "historical period exceeds uint64");
        return new AntseedWashTradingRegistry(
            vm.envAddress("SP1_VERIFIER"),
            vm.envBytes32("SP1_VERIFIER_HASH"),
            blockhashStore,
            vm.envBytes32("WASH_TRADING_SELLER_PROGRAM_VKEY"),
            uint64(periodStart),
            uint64(periodEnd)
        );
    }
}
