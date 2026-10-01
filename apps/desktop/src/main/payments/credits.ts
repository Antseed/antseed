/**
 * Buyer balance: USDC deposits, ANTS rewards, and the on-chain clients used to
 * read them. Everything here is cached — the renderer polls it, and a failing
 * RPC backs off rather than hammering.
 *
 * The client cache is shared with the other payments modules through the
 * accessors below; `invalidateChainClients()` drops it when chain config
 * changes under us.
 */
import {
  ANTSTokenClient,
  ChannelsClient,
  DepositsClient,
  EmissionsClient,
  formatUsdc,
  resolveChainConfig,
} from '@antseed/node';
import {
  creditsBalanceTotals,
  updateCreditsBalanceComponents,
  type CreditsBalanceComponents,
} from '../billing/credits-balance.js';
import { getSecureIdentity } from '../identity.js';
import { readConfig } from '../runtime/config-io.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { asRecord, asString } from '../utils.js';
import { getPendingSpendUsdc } from './buyer-channels.js';

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
};

const EMPTY_CREDITS: Omit<CreditsInfo, 'evmAddress'> = {
  operatorAddress: null,
  balanceUsdc: '0',
  reservedUsdc: '0',
  availableUsdc: '0',
  pendingUsdc: '0',
  spendableUsdc: '0',
  walletUsdc: '0',
  totalOwnedUsdc: '0',
  creditLimitUsdc: '0',
};

// Use shared formatUsdc from @antseed/node
const formatUsdc6 = formatUsdc;

const EMPTY_BALANCE_COMPONENTS: CreditsBalanceComponents = {
  available: 0n,
  reserved: 0n,
  pending: 0n,
  wallet: 0n,
};

type CreditsComponentCache = {
  evmAddress: string;
  balance: CreditsBalanceComponents;
  creditLimit: bigint;
  operatorAddress: string | null;
};

let cachedCreditsComponents: CreditsComponentCache | null = null;

// Cached crypto config — invalidated on config update. Uses protocol defaults
// from resolveChainConfig with optional user overrides from config.json.
let cachedCryptoConfig: {
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
  referralsAddress?: string;
} | null = null;

// Cached on-chain clients for the rewards summary — invalidated together with
// cachedCryptoConfig on config updates.
let cachedEmissionsClient: EmissionsClient | null = null;
let cachedAntsTokenClient: ANTSTokenClient | null = null;
let cachedChannelsClient: ChannelsClient | null = null;

export async function loadCachedCryptoConfig(): Promise<typeof cachedCryptoConfig> {
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
  // Contract addresses come from the preset in chain-config.ts, except the
  // referrals address: it is rolled out via payments.crypto.referralsAddress
  // (the CLI child honors the same key), so honor it here too or Desktop
  // reports referrals dark while the daemon carries the referrer.
  const selectedChain = asString(overrides.chainId as string, '') || 'base-mainnet';
  const userRpcUrl = asString(overrides.rpcUrl as string, '');
  const userReferralsAddress = asString(overrides.referralsAddress as string, '');
  const cc = resolveChainConfig({
    chainId: selectedChain,
    ...(userRpcUrl ? { rpcUrl: userRpcUrl } : {}),
    ...(userReferralsAddress ? { referralsAddress: userReferralsAddress } : {}),
  });
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
    ...(cc.referralsAddress ? { referralsAddress: cc.referralsAddress } : {}),
  };
  return cachedCryptoConfig;
}

let creditsRpcFailCount = 0;
let creditsRpcLastFailAt = 0;
const CREDITS_RPC_BACKOFF_THRESHOLD = 3;
const CREDITS_RPC_RETRY_COOLDOWN_MS = 60_000;

function componentCacheFor(evmAddress: string): CreditsComponentCache {
  if (cachedCreditsComponents?.evmAddress.toLowerCase() === evmAddress.toLowerCase()) {
    return cachedCreditsComponents;
  }
  cachedCreditsComponents = {
    evmAddress,
    balance: EMPTY_BALANCE_COMPONENTS,
    creditLimit: 0n,
    operatorAddress: null,
  };
  return cachedCreditsComponents;
}

function creditsInfoFromCache(cache: CreditsComponentCache): CreditsInfo {
  const totals = creditsBalanceTotals(cache.balance);
  return {
    evmAddress: cache.evmAddress,
    operatorAddress: cache.operatorAddress,
    balanceUsdc: formatUsdc6(totals.deposited),
    reservedUsdc: formatUsdc6(totals.reserved),
    availableUsdc: formatUsdc6(totals.available),
    pendingUsdc: formatUsdc6(totals.pending),
    spendableUsdc: formatUsdc6(totals.spendable),
    walletUsdc: formatUsdc6(totals.wallet),
    totalOwnedUsdc: formatUsdc6(totals.totalOwned),
    creditLimitUsdc: formatUsdc6(cache.creditLimit),
  };
}

export async function refreshCreditsInfo(): Promise<CreditsInfo> {
  const identity = getSecureIdentity();
  if (!identity) {
    return { evmAddress: null, ...EMPTY_CREDITS };
  }

  const evmAddress = identity.wallet.address;
  const cache = componentCacheFor(evmAddress);
  const cc = await loadCachedCryptoConfig();
  if (!cc) {
    return { evmAddress, ...EMPTY_CREDITS };
  }

  // Back off after repeated RPC failures; retry after cooldown so transient
  // outages don't permanently disable balance display for the session.
  if (creditsRpcFailCount >= CREDITS_RPC_BACKOFF_THRESHOLD) {
    if (Date.now() - creditsRpcLastFailAt < CREDITS_RPC_RETRY_COOLDOWN_MS) {
      return creditsInfoFromCache(cache);
    }
    // Cooldown elapsed — allow a retry attempt
    creditsRpcFailCount = 0;
  }

  const depositsClient = new DepositsClient({ rpcUrl: cc.rpcUrl, ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}), contractAddress: cc.depositsAddress, usdcAddress: cc.usdcAddress, ...(cc.chainId ? { evmChainId: cc.chainId } : {}) });

  const [balanceResult, creditLimitResult, operatorResult, pendingResult, walletResult] = await Promise.allSettled([
    depositsClient.getBuyerBalance(evmAddress),
    depositsClient.getBuyerCreditLimit(evmAddress),
    depositsClient.getOperator(evmAddress),
    getPendingSpendUsdc(),
    depositsClient.getUSDCBalance(evmAddress),
  ]);

  const balanceUpdates: Partial<CreditsBalanceComponents> = {};
  if (balanceResult.status === 'fulfilled') {
    balanceUpdates.available = balanceResult.value.available;
    balanceUpdates.reserved = balanceResult.value.reserved;
    creditsRpcFailCount = 0;
  } else {
    creditsRpcFailCount++;
    creditsRpcLastFailAt = Date.now();
    if (creditsRpcFailCount <= 1) {
      const reason = balanceResult.reason;
      try { console.warn('[credits] Deposits RPC unavailable:', reason instanceof Error ? reason.message : String(reason)); }
      catch { /* EPIPE — ignore */ }
    }
  }
  if (pendingResult.status === 'fulfilled') balanceUpdates.pending = pendingResult.value;
  if (walletResult.status === 'fulfilled') balanceUpdates.wallet = walletResult.value;
  cache.balance = updateCreditsBalanceComponents(cache.balance, balanceUpdates);

  if (creditLimitResult.status === 'fulfilled') cache.creditLimit = creditLimitResult.value;
  if (operatorResult.status === 'fulfilled') {
    const address = operatorResult.value;
    cache.operatorAddress = address && address !== '0x0000000000000000000000000000000000000000'
      ? address
      : null;
  }

  return creditsInfoFromCache(cache);
}


/** Drop the cached balance — call when the signing identity changes. */
export function invalidateCreditsCache(): void {
  cachedCreditsComponents = null;
}

/**
 * Drop every cached chain client and reset the RPC backoff. Call when chain
 * config changes, so the next read builds clients against the new endpoints
 * instead of serving answers from the old chain.
 */
export function invalidateChainClients(): void {
  cachedCryptoConfig = null;
  cachedEmissionsClient = null;
  cachedAntsTokenClient = null;
  cachedChannelsClient = null;
  cachedCreditsComponents = null;
  creditsRpcFailCount = 0;
}

export function getCachedChannelsClient(): ChannelsClient | null {
  return cachedChannelsClient;
}

export function setCachedChannelsClient(client: ChannelsClient): void {
  cachedChannelsClient = client;
}

export function getCachedEmissionsClient(): EmissionsClient | null {
  return cachedEmissionsClient;
}

export function setCachedEmissionsClient(client: EmissionsClient): void {
  cachedEmissionsClient = client;
}

export function getCachedAntsTokenClient(): ANTSTokenClient | null {
  return cachedAntsTokenClient;
}

export function setCachedAntsTokenClient(client: ANTSTokenClient): void {
  cachedAntsTokenClient = client;
}
