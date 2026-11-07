import type { ChainId } from './types.js';
import { DEPLOYED_CONTRACT_ADDRESSES } from './generated-contract-addresses.js';

export interface RecognizedUsageDeployment {
  status: 'deployed' | 'active';
  effectiveEpoch: number;
  /** First block of the recognized-usage deployment; floor for event scans. */
  deploymentBlock?: number;
  contracts: {
    washTradingRegistry: string;
    emissionsGate: string;
    sellerPools: string;
    sellerRegistry: string;
    positionInit: string;
    usageAccounting: string;
    pointsPolicyRegistry: string;
    washTradingPointsPolicy: string;
    sellerPoolsRewards: string;
    usageRewards: string;
    legacyEmissionsEscrow: string;
  };
}

/** The Uniswap v3 deployment a seller swaps USDC for ETH through (gas auto-refuel). */
export interface UsdcEthSwapDeployment {
  swapRouter02: string;
  quoterV2: string;
  /** Wrapped native token, unwrapped to ETH after the swap. */
  weth: string;
  /** USDC/WETH pool fee tier, in hundredths of a basis point (500 = 0.05%). */
  poolFee: number;
}

export interface ChainConfig {
  chainId: ChainId;
  evmChainId: number;
  rpcUrl: string;
  /**
   * Additional RPC endpoints tried in order when the primary `rpcUrl` fails.
   * Wired into ethers `FallbackProvider` with quorum=1 so the first successful
   * response wins. Ordered by preference (first entry is highest priority
   * after the primary).
   */
  fallbackRpcUrls?: string[];
  registryContractAddress?: string;
  depositsContractAddress: string;
  channelsContractAddress: string;
  /** Optional AntseedFreeUsage contract address for zero-price signed usage. */
  freeUsageContractAddress?: string;
  stakingContractAddress?: string;
  usdcContractAddress: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  legacyStakingContractAddress?: string;
  legacyEmissionsV1ContractAddress?: string;
  antsTokenAddress?: string;
  emissionsGateAddress?: string;
  sellerPoolsAddress?: string;
  sellerRegistryAddress?: string;
  positionInitAddress?: string;
  usageAccountingAddress?: string;
  usageRewardsAddress?: string;
  sellerPoolsRewardsAddress?: string;
  legacyEmissionsEscrowAddress?: string;
  washTradingRegistryAddress?: string;
  pointsPolicyRegistryAddress?: string;
  recognizedUsage?: RecognizedUsageDeployment;
  /** Block when Channels contract was deployed. Floor for event log scans. */
  channelsDeployBlock?: number;
  /** AntseedStats contract address. Populated only where an indexer aggregates it. */
  statsContractAddress?: string;
  /** Deployment block of AntseedStats for cold-start indexer backfill. */
  statsDeployBlock?: number;
  /** Public URL of the @antseed/network-stats aggregator that indexes the stats contract for this chain. */
  networkStatsUrl?: string;
  /** Public REST API of the chain explorer (Antscan). Serves per-seller on-chain stats at /api/sellers. */
  explorerApiUrl?: string;
  /**
   * The contract auditors submit KBF audits to: `AntseedKbfAudits` (M003), which also holds the
   * approved auditors. The results layer is discovered from it unless overridden below.
   *
   * Base mainnet defaults to the M003 deployment (release `003-verification-split`); the earlier
   * `AntseedKbfVerification` it replaces has an ABI the split client cannot read.
   */
  verificationContractAddress?: string;
  /** `AntseedVerificationResults` (verdicts and verification rewards); read from `kbf.results()` when absent. */
  verificationResultsAddress?: string;
  /** Block when the KBF audits contract was deployed. Floor for verifier event scans. */
  verificationDeployBlock?: number;
  /** AntseedDepositRelay contract for gasless USDC sweeps from buyer hot wallets. */
  depositRelayAddress?: string;
  /** Where sellers swap USDC for ETH to refuel gas; absent on chains without a deep pool. */
  usdcEthSwap?: UsdcEthSwapDeployment;
}

/**
 * Official contract addresses per chain.
 * These are the protocol defaults — users only need to override
 * if they want to point at a different chain (e.g. testnet).
 */
const CHAIN_CONFIGS: Record<ChainId, ChainConfig> = {
  'base-mainnet': {
    ...DEPLOYED_CONTRACT_ADDRESSES['base-mainnet'],
    chainId: 'base-mainnet',
    // Benchmarked 2026-08-10 (3-concurrent eth_call, archive-depth support):
    //   tenderly — ~150ms, 9/9 reliable, serves archive calls (primary)
    //   drpc     — ~175ms, 9/9 reliable, serves archive calls
    //   nodies   — ~270ms, 9/9 reliable, serves archive calls
    //   mainnet.base.org — flaky under concurrent reads (last resort)
    // Explicitly NOT listed:
    //   publicnode — 403s archive-depth requests ("Archive requests require a
    //     personal token"); FallbackProvider treats the JSON-RPC error body as
    //     a valid result (indistinguishable from a revert), so with quorum=1
    //     the 403 poisons the whole call instead of failing over.
    //   llamarpc — down (521) and returns missing revert data on concurrent reads.
    rpcUrl: 'https://base.gateway.tenderly.co',
    fallbackRpcUrls: [
      'https://base.drpc.org',
      'https://base-public.nodies.app',
      'https://mainnet.base.org',
    ],
    networkStatsUrl: 'https://network.antseed.com',
    explorerApiUrl: 'https://antscan.co',
    // Uniswap v3: the deep USDC/WETH 0.05% pool.
    usdcEthSwap: {
      swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481',
      quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      weth: '0x4200000000000000000000000000000000000006',
      poolFee: 500,
    },
  },
  'base-sepolia': {
    ...DEPLOYED_CONTRACT_ADDRESSES['base-sepolia'],
    chainId: 'base-sepolia',
    rpcUrl: 'https://sepolia.base.org',
    // depositRelayAddress: TODO — set after AntseedDepositRelay sepolia deployment
  },
  'base-local': {
    chainId: 'base-local',
    evmChainId: 31337,
    rpcUrl: 'http://127.0.0.1:8545',
    // A fresh Anvil, deployed by anvil account 0. script/Deploy.s.sol, deployer nonces 0-9: 0=MockUSDC,
    // 1=MockERC8004Registry, 2=ANTSToken, 3=AntseedRegistry, 4=Staking, 5=Deposits, 6=Channels, 7=Stats,
    // 8=Emissions (V1), 9=DepositRelay. staking/emissions keep naming those legacy contracts.
    usdcContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    identityRegistryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
    registryContractAddress: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
    stakingContractAddress: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
    depositsContractAddress: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
    channelsContractAddress: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
    statsContractAddress: '0xa513E6E4b8f2a923D98304ec87F64353C4D5C853',
    emissionsContractAddress: '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6',
    depositRelayAddress: '0x8A791620dd6260079BF849Dc5567aDC3F2FdC318',
    // The rest of the production stack, as the worktree testbench's `--chain local` lays it out by default
    // (e2e/testbench/lib/local-deploy.mjs: script/DeployLocalFull.s.sol, M001 Cutover.s.sol, DeployFreeUsage.s.sol,
    // M003 Deploy.s.sol). After the cutover the registry's staking/emissions are SellerRegistry/UsageAccounting.
    // ANTS sits at Base's address because AntseedEmissionsGate hardcodes it. A chain with only Deploy.s.sol on it
    // has no code at these addresses; the node then resolves the legacy stack (payments/contract-stack.ts).
    antsTokenAddress: '0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263',
    washTradingRegistryAddress: '0xc5a5C42992dECbae36851359345FE25997F5C42d',
    emissionsGateAddress: '0x67d269191c92Caf3cD7723F116c85e6E9bf55933',
    sellerPoolsAddress: '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E',
    sellerRegistryAddress: '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690',
    positionInitAddress: '0xa82fF9aFd8f496c3d6ac40E2a0F282E47488CFc9',
    usageAccountingAddress: '0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8',
    pointsPolicyRegistryAddress: '0x851356ae760d987E095750cCeb3bC6014560891C',
    sellerPoolsRewardsAddress: '0x70e0bA845a1A0F2DA3359C97E0285013525FFC49',
    usageRewardsAddress: '0x4826533B4897376654Bb4d4AD88B7faFD0C98528',
    legacyEmissionsEscrowAddress: '0x9d4454B023096f34B160D6B654540c56A1F81688',
    freeUsageContractAddress: '0xFD471836031dc5108809D173A067e8486B9047A3',
    verificationResultsAddress: '0x1429859428C0aBc9C2C47C8Ee9FBaf82cFA0F20f',
    verificationContractAddress: '0xB0D4afd8879eD9F52b28595d31B441D079B2Ca07',
  },
};

const DEFAULT_CHAIN_ID: ChainId = 'base-mainnet';

/**
 * Get the chain config for a given chain ID.
 * Falls back to base-sepolia if not found.
 */
export function getChainConfig(chainId?: ChainId | string): ChainConfig {
  if (!chainId) return withRecognizedUsageDefaults(CHAIN_CONFIGS[DEFAULT_CHAIN_ID]);
  const config = CHAIN_CONFIGS[chainId as ChainId];
  return withRecognizedUsageDefaults(config ?? CHAIN_CONFIGS[DEFAULT_CHAIN_ID]);
}

/**
 * The recognized-usage stack is recorded in the deployment ledger as soon as
 * it is deployed (before cutover). Expose those addresses through the
 * individual `*Address` fields so clients can read the new contracts in both
 * the `deployed` and `active` phases; explicit fields always win.
 */
export function withRecognizedUsageDefaults(config: ChainConfig): ChainConfig {
  const deployed = config.recognizedUsage?.contracts;
  if (!deployed) return config;
  return {
    ...config,
    emissionsGateAddress: config.emissionsGateAddress ?? deployed.emissionsGate,
    sellerPoolsAddress: config.sellerPoolsAddress ?? deployed.sellerPools,
    sellerRegistryAddress: config.sellerRegistryAddress ?? deployed.sellerRegistry,
    positionInitAddress: config.positionInitAddress ?? deployed.positionInit,
    usageAccountingAddress: config.usageAccountingAddress ?? deployed.usageAccounting,
    usageRewardsAddress: config.usageRewardsAddress ?? deployed.usageRewards,
    sellerPoolsRewardsAddress: config.sellerPoolsRewardsAddress ?? deployed.sellerPoolsRewards,
    legacyEmissionsEscrowAddress: config.legacyEmissionsEscrowAddress ?? deployed.legacyEmissionsEscrow,
    washTradingRegistryAddress: config.washTradingRegistryAddress ?? deployed.washTradingRegistry,
    pointsPolicyRegistryAddress: config.pointsPolicyRegistryAddress ?? deployed.pointsPolicyRegistry,
  };
}

/**
 * Resolve a full chain config from user overrides.
 * User config values take precedence over protocol defaults.
 */
export function resolveChainConfig(overrides?: {
  chainId?: ChainId | string;
  rpcUrl?: string;
  fallbackRpcUrls?: string[];
  depositsContractAddress?: string;
  channelsContractAddress?: string;
  registryContractAddress?: string;
  freeUsageContractAddress?: string;
  stakingContractAddress?: string;
  usdcContractAddress?: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  legacyStakingContractAddress?: string;
  legacyEmissionsV1ContractAddress?: string;
  antsTokenAddress?: string;
  verificationContractAddress?: string;
  verificationResultsAddress?: string;
  emissionsGateAddress?: string;
  sellerPoolsAddress?: string;
  sellerRegistryAddress?: string;
  positionInitAddress?: string;
  usageAccountingAddress?: string;
  usageRewardsAddress?: string;
  sellerPoolsRewardsAddress?: string;
  legacyEmissionsEscrowAddress?: string;
  washTradingRegistryAddress?: string;
  pointsPolicyRegistryAddress?: string;
  depositRelayAddress?: string;
}): ChainConfig {
  const base = getChainConfig(overrides?.chainId);
  // If the caller overrode the primary rpcUrl without providing their own
  // fallbacks, drop the defaults — they picked a specific endpoint, respect
  // that choice and don't silently route around it.
  const rpcOverridden = !!overrides?.rpcUrl;
  const resolvedFallbacks = overrides?.fallbackRpcUrls
    ?? (rpcOverridden ? [] : base.fallbackRpcUrls);
  // The results address belongs to the KBF deployment it came with. A caller that points at another
  // KBF contract without naming its results contract gets none, so readers discover it through
  // `kbf.results()` instead of reading verdicts from an unrelated default deployment.
  const kbfOverridden = !!overrides?.verificationContractAddress
    && overrides.verificationContractAddress.toLowerCase() !== base.verificationContractAddress?.toLowerCase();
  const { verificationResultsAddress: defaultResultsAddress, ...baseWithoutResults } = base;
  const inheritedResults = kbfOverridden || !defaultResultsAddress ? {} : { verificationResultsAddress: defaultResultsAddress };
  return {
    ...baseWithoutResults,
    ...inheritedResults,
    ...(overrides?.rpcUrl ? { rpcUrl: overrides.rpcUrl } : {}),
    ...(resolvedFallbacks !== undefined ? { fallbackRpcUrls: resolvedFallbacks } : {}),
    ...(overrides?.depositsContractAddress ? { depositsContractAddress: overrides.depositsContractAddress } : {}),
    ...(overrides?.channelsContractAddress ? { channelsContractAddress: overrides.channelsContractAddress } : {}),
    ...(overrides?.registryContractAddress ? { registryContractAddress: overrides.registryContractAddress } : {}),
    ...(overrides?.freeUsageContractAddress ? { freeUsageContractAddress: overrides.freeUsageContractAddress } : {}),
    ...(overrides?.stakingContractAddress ? { stakingContractAddress: overrides.stakingContractAddress } : {}),
    ...(overrides?.usdcContractAddress ? { usdcContractAddress: overrides.usdcContractAddress } : {}),
    ...(overrides?.identityRegistryAddress ? { identityRegistryAddress: overrides.identityRegistryAddress } : {}),
    ...(overrides?.emissionsContractAddress ? { emissionsContractAddress: overrides.emissionsContractAddress } : {}),
    ...(overrides?.legacyEmissionsContractAddress ? { legacyEmissionsContractAddress: overrides.legacyEmissionsContractAddress } : {}),
    ...(overrides?.legacyStakingContractAddress ? { legacyStakingContractAddress: overrides.legacyStakingContractAddress } : {}),
    ...(overrides?.legacyEmissionsV1ContractAddress ? { legacyEmissionsV1ContractAddress: overrides.legacyEmissionsV1ContractAddress } : {}),
    ...(overrides?.antsTokenAddress ? { antsTokenAddress: overrides.antsTokenAddress } : {}),
    ...(overrides?.verificationContractAddress
      ? { verificationContractAddress: overrides.verificationContractAddress }
      : {}),
    ...(overrides?.verificationResultsAddress
      ? { verificationResultsAddress: overrides.verificationResultsAddress }
      : {}),
    ...(overrides?.emissionsGateAddress ? { emissionsGateAddress: overrides.emissionsGateAddress } : {}),
    ...(overrides?.sellerPoolsAddress ? { sellerPoolsAddress: overrides.sellerPoolsAddress } : {}),
    ...(overrides?.sellerRegistryAddress ? { sellerRegistryAddress: overrides.sellerRegistryAddress } : {}),
    ...(overrides?.positionInitAddress ? { positionInitAddress: overrides.positionInitAddress } : {}),
    ...(overrides?.usageAccountingAddress ? { usageAccountingAddress: overrides.usageAccountingAddress } : {}),
    ...(overrides?.usageRewardsAddress ? { usageRewardsAddress: overrides.usageRewardsAddress } : {}),
    ...(overrides?.sellerPoolsRewardsAddress ? { sellerPoolsRewardsAddress: overrides.sellerPoolsRewardsAddress } : {}),
    ...(overrides?.legacyEmissionsEscrowAddress ? { legacyEmissionsEscrowAddress: overrides.legacyEmissionsEscrowAddress } : {}),
    ...(overrides?.washTradingRegistryAddress ? { washTradingRegistryAddress: overrides.washTradingRegistryAddress } : {}),
    ...(overrides?.pointsPolicyRegistryAddress ? { pointsPolicyRegistryAddress: overrides.pointsPolicyRegistryAddress } : {}),
    ...(overrides?.depositRelayAddress ? { depositRelayAddress: overrides.depositRelayAddress } : {}),
  };
}

export { DEFAULT_CHAIN_ID, CHAIN_CONFIGS };
