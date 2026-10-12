import { join } from 'node:path';
import {
  DepositsClient,
  ChannelsClient,
  StakingClient,
  DepositRelayClient,
  loadOrCreateIdentity,
  resolveChainConfig,
  resolveContractStack,
  resolveLegacyContractAddresses,
  type ContractStackResolution,
} from '@antseed/node';
import {
  IdentityClient,
  EmissionsClient,
  UsageAccountingClient,
  UsageRewardsClient,
  PositionInitClient,
  EmissionsGateClient,
  ChannelStore,
  ANTSTokenClient,
  SellerPoolsClient,
  SellerPoolsRewardsClient,
  SellerRegistryClient,
} from '@antseed/node/payments';
import type { Identity } from '@antseed/node';
import type { AntseedConfig } from '../config/types.js';

export const ANTSEED_BASE_RPC_URL_ENV = 'ANTSEED_BASE_RPC_URL';

export interface RpcUrlOverrideInput {
  /** Runtime-only CLI flag value. Wins over environment variables. */
  flagValue?: string;
  /** Environment to read from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface CryptoConfigOverrides {
  /** Runtime-only RPC URL override. Wins over environment variables and config.json. */
  rpcUrl?: string;
  /** Environment to read ANTSEED_BASE_RPC_URL from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export function normalizeHttpRpcUrl(value: string | undefined, label = ANTSEED_BASE_RPC_URL_ENV): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http:// or https://`);
  }

  return trimmed;
}

function normalizeRpcUrl(value: string | undefined): string | undefined {
  return normalizeHttpRpcUrl(value, ANTSEED_BASE_RPC_URL_ENV);
}

/**
 * Resolve the runtime Base JSON-RPC URL override used by seller infrastructure.
 * Precedence: CLI flag > ANTSEED_BASE_RPC_URL env var > config/defaults.
 */
export function resolveBaseRpcUrlOverride(input: RpcUrlOverrideInput = {}): string | undefined {
  return normalizeRpcUrl(
    input.flagValue ?? (input.env ?? process.env)[ANTSEED_BASE_RPC_URL_ENV],
  );
}

/** Format ANTS token amounts (18 decimals) to human-readable string. */
export function formatAnts(baseUnits: bigint): string {
  const whole = baseUnits / 10n ** 18n;
  const frac = baseUnits % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6) || '0';
  return `${whole}.${fracStr}`;
}

export function formatAntsExact(baseUnits: bigint): string {
  const whole = baseUnits / 10n ** 18n;
  const fraction = (baseUnits % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fraction}`;
}

/** Parse a positive human-readable ANTS amount into 18-decimal base units. */
export function parseAntsToBaseUnits(amount: string): bigint {
  const match = amount.trim().match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!match) throw new Error('Amount must be a positive number with at most 18 decimals.');
  const whole = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(18, '0');
  const baseUnits = whole * 10n ** 18n + BigInt(fraction || '0');
  if (baseUnits <= 0n) throw new Error('Amount must be a positive number.');
  return baseUnits;
}

/** Format USDC base units (6 decimals) to human-readable string. */
export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${fracStr}`;
}

export function shortId(value: string, len = 10): string {
  return value.length > len ? `${value.slice(0, len)}...` : value;
}

/** Parse human-readable USDC to base units (6 decimals). */
export function parseUsdcToBaseUnits(amount: string): bigint {
  const amountFloat = parseFloat(amount);
  if (isNaN(amountFloat) || amountFloat <= 0) {
    throw new Error('Amount must be a positive number.');
  }
  return BigInt(Math.round(amountFloat * 1_000_000));
}

export interface CryptoContext {
  identity: Identity;
  wallet: Identity['wallet'];
  address: string;
}

type ResolvedCryptoConfig = NonNullable<AntseedConfig['payments']['crypto']> & {
  rpcUrl: string;
  depositsContractAddress: string;
  channelsContractAddress: string;
  usdcContractAddress: string;
  stakingContractAddress?: string;
  identityRegistryAddress?: string;
  emissionsContractAddress?: string;
  legacyEmissionsContractAddress?: string;
  legacyStakingContractAddress?: string;
  legacyEmissionsV1ContractAddress?: string;
  antsTokenAddress?: string;
  registryContractAddress?: string;
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
  explorerApiUrl?: string;
  evmChainId: number;
};

/**
 * Load identity and derive EVM wallet + address. Shared across all payment commands.
 */
export async function loadCryptoContext(dataDir: string): Promise<CryptoContext> {
  const identity = await loadOrCreateIdentity(dataDir);
  const wallet = identity.wallet;
  const address = identity.wallet.address;
  return { identity, wallet, address };
}

/**
 * Validate that crypto payment config is present and return it.
 * Exits with error if not configured.
 */
export function requireCryptoConfig(
  config: AntseedConfig,
  overrides: CryptoConfigOverrides = {},
): ResolvedCryptoConfig {
  const crypto = config.payments?.crypto;
  if (!crypto) {
    throw new Error('No crypto payment configuration found. Configure payments.crypto in your config file.');
  }

  const rpcUrlOverride = normalizeRpcUrl(overrides.rpcUrl)
    ?? resolveBaseRpcUrlOverride({ env: overrides.env });

  // Merge with chain-config defaults so commands work with just chainId.
  // Runtime RPC overrides intentionally win over config.json and built-ins.
  const resolved = resolveChainConfig({
    ...crypto,
    ...(rpcUrlOverride ? { rpcUrl: rpcUrlOverride } : {}),
  });
  return {
    ...crypto,
    rpcUrl: rpcUrlOverride || crypto.rpcUrl || resolved.rpcUrl,
    ...(resolved.fallbackRpcUrls && resolved.fallbackRpcUrls.length > 0
      ? { fallbackRpcUrls: resolved.fallbackRpcUrls }
      : {}),
    usdcContractAddress: crypto.usdcContractAddress || resolved.usdcContractAddress,
    depositsContractAddress: crypto.depositsContractAddress || resolved.depositsContractAddress,
    channelsContractAddress: crypto.channelsContractAddress || resolved.channelsContractAddress,
    stakingContractAddress: crypto.stakingContractAddress || resolved.stakingContractAddress,
    emissionsContractAddress: crypto.emissionsContractAddress || resolved.emissionsContractAddress,
    legacyEmissionsContractAddress: crypto.legacyEmissionsContractAddress || resolved.legacyEmissionsContractAddress,
    legacyStakingContractAddress: crypto.legacyStakingContractAddress || resolved.legacyStakingContractAddress,
    legacyEmissionsV1ContractAddress: crypto.legacyEmissionsV1ContractAddress || resolved.legacyEmissionsV1ContractAddress,
    antsTokenAddress: crypto.antsTokenAddress || (crypto.chainId === 'base-local' ? '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' : resolved.antsTokenAddress),
    registryContractAddress: crypto.registryContractAddress || (crypto.chainId === 'base-local' ? '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9' : resolved.registryContractAddress),
    emissionsGateAddress: crypto.emissionsGateAddress || resolved.emissionsGateAddress,
    sellerPoolsAddress: crypto.sellerPoolsAddress || resolved.sellerPoolsAddress,
    sellerRegistryAddress: crypto.sellerRegistryAddress || resolved.sellerRegistryAddress,
    positionInitAddress: crypto.positionInitAddress || resolved.positionInitAddress,
    usageAccountingAddress: crypto.usageAccountingAddress || resolved.usageAccountingAddress,
    usageRewardsAddress: crypto.usageRewardsAddress || resolved.usageRewardsAddress,
    sellerPoolsRewardsAddress: crypto.sellerPoolsRewardsAddress || resolved.sellerPoolsRewardsAddress,
    legacyEmissionsEscrowAddress: crypto.legacyEmissionsEscrowAddress || resolved.legacyEmissionsEscrowAddress,
    washTradingRegistryAddress: crypto.washTradingRegistryAddress || resolved.washTradingRegistryAddress,
    pointsPolicyRegistryAddress: crypto.pointsPolicyRegistryAddress || resolved.pointsPolicyRegistryAddress,
    identityRegistryAddress: crypto.identityRegistryAddress || resolved.identityRegistryAddress,
    depositRelayAddress: crypto.depositRelayAddress || resolved.depositRelayAddress,
    evmChainId: resolved.evmChainId,
    explorerApiUrl: crypto.explorerApiUrl ?? resolved.explorerApiUrl,
  };
}

export function requireContractAddress(
  crypto: ReturnType<typeof requireCryptoConfig>,
  field: keyof ReturnType<typeof requireCryptoConfig>,
  name: string,
): string {
  const address = crypto[field];
  if (typeof address !== 'string' || !address) {
    throw new Error(`\`${name}\` address not configured for chain \`${crypto.chainId}\``);
  }
  return address;
}

export function resolveCliContractStack(
  config: AntseedConfig,
  overrides?: CryptoConfigOverrides,
): Promise<ContractStackResolution> {
  return resolveContractStack(requireCryptoConfig(config, overrides));
}

function fallbackClientOpts(crypto: ReturnType<typeof requireCryptoConfig>) {
  return crypto.fallbackRpcUrls && crypto.fallbackRpcUrls.length > 0
    ? { fallbackRpcUrls: crypto.fallbackRpcUrls }
    : {};
}

/**
 * Create a DepositsClient from the CLI config.
 */
export function createDepositsClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): DepositsClient {
  const crypto = requireCryptoConfig(config, overrides);
  return new DepositsClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.depositsContractAddress,
    usdcAddress: crypto.usdcContractAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Create a ChannelsClient from the CLI config.
 */
export function createChannelsClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): ChannelsClient {
  const crypto = requireCryptoConfig(config, overrides);
  return new ChannelsClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.channelsContractAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Create an IdentityClient from the CLI config.
 */
export function createIdentityClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): IdentityClient {
  const crypto = requireCryptoConfig(config, overrides);
  if (!crypto.identityRegistryAddress) {
    throw new Error('No identity registry address configured. Set payments.crypto.identityRegistryAddress in your config file.');
  }
  return new IdentityClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.identityRegistryAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Create a StakingClient from the CLI config.
 */
export function createStakingClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): StakingClient {
  const crypto = requireCryptoConfig(config, overrides);
  if (!crypto.stakingContractAddress) {
    throw new Error('No staking contract address configured. Set payments.crypto.stakingContractAddress in your config file.');
  }
  return new StakingClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.stakingContractAddress,
    usdcAddress: crypto.usdcContractAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Create an EmissionsClient from the CLI config.
 */
export function createEmissionsClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): EmissionsClient {
  const crypto = requireCryptoConfig(config, overrides);
  if (!crypto.emissionsContractAddress) {
    throw new Error('No emissions contract address configured. Set payments.crypto.emissionsContractAddress in your config file.');
  }
  return new EmissionsClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.emissionsContractAddress,
    evmChainId: crypto.evmChainId,
  });
}

function contractClientConfig(crypto: ReturnType<typeof requireCryptoConfig>, contractAddress: string) {
  return {
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress,
    evmChainId: crypto.evmChainId,
  };
}

export function createUsageAccountingClient(config: AntseedConfig): UsageAccountingClient {
  const crypto = requireCryptoConfig(config);
  return new UsageAccountingClient(contractClientConfig(crypto, requireContractAddress(crypto, 'usageAccountingAddress', 'usageAccounting')));
}

export function createUsageRewardsClient(config: AntseedConfig): UsageRewardsClient {
  const crypto = requireCryptoConfig(config);
  return new UsageRewardsClient(contractClientConfig(crypto, requireContractAddress(crypto, 'usageRewardsAddress', 'usageRewards')));
}

export function createSellerPoolsClient(config: AntseedConfig): SellerPoolsClient {
  const crypto = requireCryptoConfig(config);
  return new SellerPoolsClient({
    ...contractClientConfig(crypto, requireContractAddress(crypto, 'sellerPoolsAddress', 'sellerPools')),
    antsTokenAddress: requireContractAddress(crypto, 'antsTokenAddress', 'antsToken'),
  });
}

export function createSellerPoolsRewardsClient(config: AntseedConfig): SellerPoolsRewardsClient {
  const crypto = requireCryptoConfig(config);
  return new SellerPoolsRewardsClient(contractClientConfig(crypto, requireContractAddress(crypto, 'sellerPoolsRewardsAddress', 'sellerPoolsRewards')));
}

export function createSellerRegistryClient(config: AntseedConfig): SellerRegistryClient {
  const crypto = requireCryptoConfig(config);
  return new SellerRegistryClient(contractClientConfig(crypto, requireContractAddress(crypto, 'sellerRegistryAddress', 'sellerRegistry')));
}

export function createPositionInitClient(config: AntseedConfig): PositionInitClient {
  const crypto = requireCryptoConfig(config);
  return new PositionInitClient(contractClientConfig(crypto, requireContractAddress(crypto, 'positionInitAddress', 'positionInit')));
}

export function createEmissionsGateClient(config: AntseedConfig): EmissionsGateClient {
  const crypto = requireCryptoConfig(config);
  return new EmissionsGateClient(contractClientConfig(crypto, requireContractAddress(crypto, 'emissionsGateAddress', 'emissionsGate')));
}

export function createAntsTokenClient(config: AntseedConfig): ANTSTokenClient {
  const crypto = requireCryptoConfig(config);
  return new ANTSTokenClient(contractClientConfig(crypto, requireContractAddress(crypto, 'antsTokenAddress', 'antsToken')));
}

export function createLegacyEmissionsClient(config: AntseedConfig): EmissionsClient {
  const crypto = requireCryptoConfig(config);
  const legacy = { ...crypto, ...resolveLegacyContractAddresses(crypto) };
  return new EmissionsClient(contractClientConfig(legacy, requireContractAddress(legacy, 'legacyEmissionsContractAddress', 'legacyEmissions')));
}

export function createLegacyStakingClient(config: AntseedConfig): StakingClient {
  const crypto = requireCryptoConfig(config);
  const legacy = { ...crypto, ...resolveLegacyContractAddresses(crypto) };
  return new StakingClient({
    ...contractClientConfig(legacy, requireContractAddress(legacy, 'legacyStakingContractAddress', 'legacyStaking')),
    usdcAddress: crypto.usdcContractAddress,
  });
}

/**
 * Create a DepositRelayClient from the CLI config.
 */
export function createDepositRelayClient(config: AntseedConfig, overrides?: CryptoConfigOverrides): DepositRelayClient {
  const crypto = requireCryptoConfig(config, overrides);
  if (!crypto.depositRelayAddress) {
    throw new Error('No deposit relay address configured for this chain. Set payments.crypto.depositRelayAddress in your config file.');
  }
  return new DepositRelayClient({
    rpcUrl: crypto.rpcUrl,
    ...fallbackClientOpts(crypto),
    contractAddress: crypto.depositRelayAddress,
    evmChainId: crypto.evmChainId,
  });
}

/**
 * Open a ChannelStore from the given data directory.
 * The runtime stores channels in {dataDir}/payments/sessions.db.
 */
export function openChannelStore(dataDir: string): ChannelStore {
  return new ChannelStore(join(dataDir, 'payments'));
}
