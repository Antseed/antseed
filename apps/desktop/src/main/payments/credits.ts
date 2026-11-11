/**
 * The balance the app spends from, read from its gateway, and the on-chain
 * clients the local deposit and channel flows use.
 *
 * The client cache is shared with the other payments modules through the
 * accessors below; `invalidateChainClients()` drops it when chain config
 * changes under us.
 */
import {
  ChannelsClient,
  DepositRelayClient,
  DepositsClient,
  formatUsdc,
  resolveChainConfig,
} from '@antseed/node';
import { getGatewayBalanceInfo } from '../gateway/service.js';
import { getGatewaySettings } from '../gateway/settings.js';
import { readConfig } from '../runtime/config-io.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { asRecord, asString } from '../utils.js';
import { gatewayCreditsInfo, type DepositRulesUsdc } from './gateway-credits.js';
import { LastCredits } from './last-credits.js';
import { resetSharedChain, withSharedProvider } from './shared-chain.js';
import { clearChainReads, invalidateChainReads } from './read-cache.js';

export type CreditsInfo = {
  evmAddress: string | null;
  operatorAddress: string | null;
  /** Everything on deposit for this buyer: unreserved + locked in channels. */
  balanceUsdc: string;
  /** Locked into open payment channels (still the buyer's money). */
  reservedUsdc: string;
  /** Unreserved deposits — what a new channel reserve or a withdrawal can draw on. */
  availableUsdc: string;
  /** Signed via SpendingAuth but not settled on-chain yet: committed, not gone. */
  pendingUsdc: string;
  /** balanceUsdc - pendingUsdc — what the buyer actually still owns. */
  spendableUsdc: string;
  /** USDC received by the buyer wallet but not yet swept into deposits. */
  walletUsdc: string;
  /** spendableUsdc + walletUsdc — the complete balance the buyer owns. */
  totalOwnedUsdc: string;
  creditLimitUsdc: string;
  /** Contract floor for a buyer's first deposit, net of the relay fee. */
  minFirstDepositUsdc: string;
  /** Fixed fee the deposit relayer takes from each wallet sweep. */
  depositFeeUsdc: string;
  /**
   * False until the deposits balance has been read once for this wallet.
   * Until then every amount above is a placeholder zero, not a real balance.
   */
  balanceKnown: boolean;
};

// Deposit rules: MIN_BUYER_DEPOSIT on AntseedDeposits and FEE on the deposit
// relay. They almost never change, so read once per chain config; these
// mainnet values only stand in until the first read succeeds.
const DEFAULT_MIN_FIRST_DEPOSIT = 1_000_000n;
const DEFAULT_DEPOSIT_FEE = 50_000n;
type DepositRules = { minFirstDeposit: bigint; fee: bigint };
let cachedDepositRules: DepositRules | null = null;

// Use shared formatUsdc from @antseed/node
const formatUsdc6 = formatUsdc;

// Cached crypto config — invalidated on config update. Uses protocol defaults
// from resolveChainConfig with optional user overrides from config.json.
type CryptoConfig = {
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  depositsAddress: string;
  channelsAddress: string;
  usdcAddress: string;
  chainId: number;
  emissionsAddress?: string;
  legacyEmissionsAddress?: string;
  usageAccountingAddress?: string;
  usageRewardsAddress?: string;
  recognizedUsageEffectiveEpoch?: number;
  antsTokenAddress?: string;
  depositRelayAddress?: string;
};
let cachedCryptoConfig: CryptoConfig | null = null;

// Cached on-chain client, invalidated together with cachedCryptoConfig on
// config updates.
let cachedChannelsClient: ChannelsClient | null = null;
// One deposits client for the credits poll and the deposit watcher, reading
// through the shared chain provider.
let cachedDepositsClient: Promise<DepositsClient> | null = null;

export async function loadCachedCryptoConfig(): Promise<CryptoConfig | null> {
  if (cachedCryptoConfig) return cachedCryptoConfig;
  let overrides: Record<string, unknown> = {};
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const payments = asRecord(config.payments);
    overrides = asRecord(payments.crypto);
  } catch {
    // No config — no crypto config available
  }
  // Resolve chain config from the selected chain ID (default: base-mainnet).
  // All contract addresses come from the preset in chain-config.ts.
  const selectedChain = asString(overrides.chainId as string, '') || 'base-mainnet';
  const userRpcUrl = asString(overrides.rpcUrl as string, '');
  const cc = resolveChainConfig({ chainId: selectedChain, ...(userRpcUrl ? { rpcUrl: userRpcUrl } : {}) });
  cachedCryptoConfig = {
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    depositsAddress: cc.depositsContractAddress,
    channelsAddress: cc.channelsContractAddress,
    usdcAddress: cc.usdcContractAddress,
    chainId: cc.evmChainId,
    ...(cc.emissionsContractAddress ? { emissionsAddress: cc.emissionsContractAddress } : {}),
    ...(cc.recognizedUsage?.status === 'active' && cc.legacyEmissionsContractAddress
      ? { legacyEmissionsAddress: cc.legacyEmissionsContractAddress }
      : {}),
    ...(cc.recognizedUsage?.status === 'active' && cc.usageAccountingAddress
      ? { usageAccountingAddress: cc.usageAccountingAddress }
      : {}),
    ...(cc.recognizedUsage?.status === 'active' && cc.usageRewardsAddress
      ? { usageRewardsAddress: cc.usageRewardsAddress }
      : {}),
    ...(cc.recognizedUsage?.status === 'active'
      ? { recognizedUsageEffectiveEpoch: cc.recognizedUsage.effectiveEpoch }
      : {}),
    ...(cc.antsTokenAddress ? { antsTokenAddress: cc.antsTokenAddress } : {}),
    ...(cc.depositRelayAddress ? { depositRelayAddress: cc.depositRelayAddress } : {}),
  };
  return cachedCryptoConfig;
}

async function readDepositRules(cc: CryptoConfig, depositsClient: DepositsClient): Promise<DepositRules | null> {
  if (cachedDepositRules) return cachedDepositRules;
  try {
    const relay = cc.depositRelayAddress
      ? await withSharedProvider(new DepositRelayClient({
        rpcUrl: cc.rpcUrl,
        ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
        contractAddress: cc.depositRelayAddress,
        evmChainId: cc.chainId,
      }), { rpcUrl: cc.rpcUrl, fallbackRpcUrls: cc.fallbackRpcUrls, chainId: cc.chainId })
      : null;
    const [minFirstDeposit, fee] = await Promise.all([
      depositsClient.getMinBuyerDeposit(),
      relay ? relay.fee() : Promise.resolve(DEFAULT_DEPOSIT_FEE),
    ]);
    const rules = { minFirstDeposit, fee };
    // Without a relay the fee is only the default; re-read once it's configured.
    if (relay) cachedDepositRules = rules;
    return rules;
  } catch {
    return null; // keep the defaults; retried on the next poll
  }
}

/**
 * The deposit contract's rules for a first deposit into this computer's
 * wallet (minimum and relay fee). They shape the local deposit flow's copy,
 * which sweeps into this computer's own wallet, so they are read from that
 * contract and cached; the mainnet defaults stand in until then.
 */
export async function readLocalDepositRules(): Promise<DepositRulesUsdc> {
  const fallback = { minFirstDepositUsdc: formatUsdc6(DEFAULT_MIN_FIRST_DEPOSIT), depositFeeUsdc: formatUsdc6(DEFAULT_DEPOSIT_FEE) };
  if (getGatewaySettings().mode !== 'local') return fallback;
  const cc = await loadCachedCryptoConfig();
  if (!cc) return fallback;
  const rules = cachedDepositRules ?? await readDepositRules(cc, await getDepositsClient(cc)).catch(() => null);
  return rules ? { minFirstDepositUsdc: formatUsdc6(rules.minFirstDeposit), depositFeeUsdc: formatUsdc6(rules.fee) } : fallback;
}

/**
 * The balance the app spends from, as its gateway (local or remote) reports
 * it for the app's key: deposits, what open channels hold signed but
 * unsettled, unswept wallet USDC and the credit limit. `fresh` asks the
 * gateway to re-read the chain. The last answer is kept for cheap reads.
 */
export async function refreshCreditsInfo(options: { fresh?: boolean } = {}): Promise<CreditsInfo> {
  const [info, rules] = await Promise.all([
    getGatewayBalanceInfo(options).catch(() => null),
    readLocalDepositRules(),
  ]);
  // A failed read keeps the last known balance rather than showing zero.
  return lastCredits.settle(gatewayCreditsInfo(info, rules));
}

const lastCredits = new LastCredits();

/**
 * Whether the last balance read found nothing the buyer owns (deposits net of
 * pending spend, plus unswept wallet USDC). Undefined until a balance has
 * been read for the current identity. Cache-only: never touches the chain.
 */
export function cachedBuyerBalanceIsZero(): boolean | undefined {
  return lastCredits.isZero();
}

/** Drop the cached balance — call when the signing identity changes. */
export function invalidateCreditsCache(): void {
  invalidateChainReads();
  lastCredits.clear();
}

/**
 * Drop every cached chain client and reset the RPC backoff. Call when chain
 * config changes, so the next read builds clients against the new endpoints
 * instead of serving answers from the old chain.
 */
export function invalidateChainClients(): void {
  resetSharedChain();
  clearChainReads();
  cachedCryptoConfig = null;
  cachedDepositsClient = null;
  cachedChannelsClient = null;
  cachedDepositRules = null;
  lastCredits.clear();
}

/** The cached deposits client for `cc`, reading through the shared chain provider. */
export function getDepositsClient(cc: CryptoConfig): Promise<DepositsClient> {
  if (cachedDepositsClient) return cachedDepositsClient;
  const client = new DepositsClient({
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    contractAddress: cc.depositsAddress,
    usdcAddress: cc.usdcAddress,
    ...(cc.chainId ? { evmChainId: cc.chainId } : {}),
  });
  cachedDepositsClient = withSharedProvider(client, { rpcUrl: cc.rpcUrl, fallbackRpcUrls: cc.fallbackRpcUrls, chainId: cc.chainId });
  return cachedDepositsClient;
}

export function getCachedChannelsClient(): ChannelsClient | null {
  return cachedChannelsClient;
}

export function setCachedChannelsClient(client: ChannelsClient): void {
  cachedChannelsClient = client;
}
