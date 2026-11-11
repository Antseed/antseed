/**
 * Payment channels and usage totals as read back from the buyer daemon, plus
 * the on-chain enrichment the Credits view needs (channel status, and spend
 * authorized but not yet settled).
 */
import { ChannelsClient, type ChannelInfo, type CloseChannelResultPayload } from '@antseed/node';
import type { AbstractProvider } from 'ethers';
import { createHash } from 'node:crypto';
import { LOCALHOST_URL } from '../constants.js';
import { isOpenChannelStatus, pendingSpendFromChannels } from '../billing/credits-balance.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import { getCachedChannelsClient, loadCachedCryptoConfig, setCachedChannelsClient } from './credits.js';
import { sharedChainProvider } from './shared-chain.js';
import { CHANNELS_FRESH_MS, cachedRead, readKeys, refreshFresh } from './read-cache.js';
import {
  applyChainToChannels,
  type ChannelChainRead,
  normalizePaymentChannelSummary,
  requestCooperativeChannelCloseAtPort,
  readChannelsBatched,
  runInBatches,
} from './buyer-channel-control.js';

export {
  normalizePaymentChannelSummary,
  requestCooperativeChannelCloseAtPort,
} from './buyer-channel-control.js';

/** Per-service usage from the buyer daemon. `serviceIdHash` is
    keccak256(serviceName); `serviceName` is resolved by the main process from
    the buyer's peer cache (null when the name is no longer advertised). */
export type DesktopBuyerServiceUsage = {
  serviceIdHash: string;
  serviceName: string | null;
  amountUsdc: string;
  inputTokens: string;
  cachedInputTokens: string;
  outputTokens: string;
  requestCount: number;
};

export type DesktopBuyerUsageTotals = {
  totalRequests: number;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalSettlements: number;
  uniqueSellers: number;
  services: DesktopBuyerServiceUsage[];
};

export type DesktopPaymentChannelSummary = {
  channelId: string;
  peerId: string;
  seller: string;
  sellerDisplayName: string | null;
  /** True only when the on-chain deposit and settled amounts were read successfully. */
  onChainStateKnown: boolean;
  /** Latest in-memory ReserveAuth ceiling, when the buyer daemon has it. */
  reserveCeiling: string | null;
  cumulativeSigned: string;
  /** Authoritative amount currently locked for the channel on-chain. */
  onChainDeposit: string;
  /** Authoritative amount already settled to the seller on-chain. */
  onChainSettled: string;
  reservedAt: number;
  /** Last local cumulative usage/auth update for this channel. */
  updatedAt: number;
  status: string;
  requestCount: number;
  inputTokens: string;
  outputTokens: string;
  cooperativeCloseSupported: boolean;
};

export type DesktopRewardsSummary = {
  available: boolean;
  pendingAnts: string;
  currentEpoch: number | null;
  transfersEnabled: boolean;
  error: string | null;
};

export const MAX_SPENDING_AUTH_BASE_UNITS = 5_000_000n;
export const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

const EMPTY_BUYER_USAGE_TOTALS: DesktopBuyerUsageTotals = {
  totalRequests: 0,
  totalInputTokens: '0',
  totalOutputTokens: '0',
  totalSettlements: 0,
  uniqueSellers: 0,
  services: [],
};

export const EMPTY_REWARDS_SUMMARY: DesktopRewardsSummary = {
  available: false,
  pendingAnts: '0',
  currentEpoch: null,
  transfersEnabled: false,
  error: null,
};

function readNumberField(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function readStringField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function normalizeBuyerServiceUsage(value: unknown): DesktopBuyerServiceUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const serviceIdHash = readStringField(raw, 'serviceIdHash');
  if (!serviceIdHash) return null;
  return {
    serviceIdHash,
    serviceName: null,
    amountUsdc: readStringField(raw, 'amountUsdc') || '0',
    inputTokens: readStringField(raw, 'inputTokens') || '0',
    cachedInputTokens: readStringField(raw, 'cachedInputTokens') || '0',
    outputTokens: readStringField(raw, 'outputTokens') || '0',
    requestCount: readNumberField(raw, 'requestCount'),
  };
}

export function normalizeBuyerUsageTotals(value: unknown): DesktopBuyerUsageTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return EMPTY_BUYER_USAGE_TOTALS;
  }
  const raw = value as Record<string, unknown>;
  const services = Array.isArray(raw.services)
    ? raw.services.map(normalizeBuyerServiceUsage).filter((s): s is DesktopBuyerServiceUsage => s !== null)
    : [];
  return {
    totalRequests: readNumberField(raw, 'totalRequests'),
    totalInputTokens: readStringField(raw, 'totalInputTokens') || '0',
    totalOutputTokens: readStringField(raw, 'totalOutputTokens') || '0',
    totalSettlements: readNumberField(raw, 'totalSettlements'),
    uniqueSellers: readNumberField(raw, 'uniqueSellers'),
    services,
  };
}

export async function requestCooperativeChannelClose(peerId: string, channelId?: string): Promise<CloseChannelResultPayload> {
  const port = await resolveBuyerProxyPort();
  return requestCooperativeChannelCloseAtPort(port, peerId, channelId ? { channelId } : {});
}

const BUYER_PROXY_TIMEOUT_MS = 10_000;

export async function fetchBuyerProxyJson(pathname: string): Promise<Record<string, unknown> | null> {
  const port = await resolveBuyerProxyPort();
  try {
    // A proxy that accepts but never answers (mid-restart) must not hang callers.
    const response = await fetch(`${LOCALHOST_URL}:${port}${pathname}`, { signal: AbortSignal.timeout(BUYER_PROXY_TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function formatAnts(value: bigint): string {
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = value % 1_000_000_000_000_000_000n;
  if (fraction === 0n) return whole.toString();
  const padded = fraction.toString().padStart(18, '0').replace(/0+$/, '');
  return `${whole.toString()}.${padded.slice(0, 6)}`;
}


// Bound concurrent on-chain reads without skipping older active-looking rows.
const CHANNEL_ENRICH_CONCURRENCY = 12;

// Channels with a delegated seller live behind the seller's facade contract
// (the row's `seller` is the contract, e.g. DiemStakingProxy) and have no
// record on the canonical AntseedChannels. ChannelsClient probes
// `channelsAddress()` on the facade to find the underlying deployment, so a
// per-seller client resolves those rows. EOA sellers cache as non-facades and
// simply keep returning status 0.
const sellerFacadeClients = new Map<string, ChannelsClient>();

/** Drop the per-seller facade clients so they rebuild on the current chain config. */
export function resetSellerFacadeClients(): void {
  sellerFacadeClients.clear();
}

function facadeClientFor(
  cc: NonNullable<Awaited<ReturnType<typeof loadCachedCryptoConfig>>>,
  seller: string,
  provider: AbstractProvider | null,
): ChannelsClient {
  const key = seller.toLowerCase();
  let client = sellerFacadeClients.get(key);
  if (!client) {
    client = new ChannelsClient({
      rpcUrl: cc.rpcUrl,
      ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
      contractAddress: seller,
      evmChainId: cc.chainId,
    });
    if (provider) client.withProvider(provider);
    sellerFacadeClients.set(key, client);
  }
  return client;
}

// The local ChannelStore can disagree with the chain both ways: a seller-side
// settle or close is not always observed, and the buyer retires a row when it
// gives up on the session (a seller that went away, an exhausted channel),
// which leaves the channel open and its reserve locked. So the chain decides
// every row's status (applyChainToChannels).
async function enrichChannelStatuses(channels: DesktopPaymentChannelSummary[], fresh = false): Promise<void> {
  const cc = await loadCachedCryptoConfig();
  if (!cc?.channelsAddress) return;
  const provider = await sharedChainProvider({ rpcUrl: cc.rpcUrl, fallbackRpcUrls: cc.fallbackRpcUrls, chainId: cc.chainId });
  let client = getCachedChannelsClient();
  if (!client) {
    client = new ChannelsClient({
      rpcUrl: cc.rpcUrl,
      ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
      contractAddress: cc.channelsAddress,
      evmChainId: cc.chainId,
    });
    if (provider) client.withProvider(provider);
    setCachedChannelsClient(client);
  }
  const channelsClient = client;
  await applyChainToChannels(channels, (rows) => {
    // Callers poll this from several views; the same set of channels is read
    // from the chain at most once per freshness window (settles, closes and
    // payments invalidate it).
    const ids = rows.map((row) => row.channelId).sort();
    const key = readKeys.channelStatus(createHash('sha256').update(ids.join(',')).digest('hex'));
    const read = async (): Promise<ChannelChainRead> => {
      const readAtMs = Date.now();
      return { readAtMs, sessions: await readChannelSessions(cc, channelsClient, provider, rows) };
    };
    return fresh ? refreshFresh(key, read) : cachedRead(key, CHANNELS_FRESH_MS, read);
  });
}

/** On-chain sessions for `rows`: canonical channels first, then each delegated seller's facade. */
async function readChannelSessions(
  cc: NonNullable<Awaited<ReturnType<typeof loadCachedCryptoConfig>>>,
  client: ChannelsClient,
  provider: AbstractProvider | null,
  rows: DesktopPaymentChannelSummary[],
): Promise<Map<string, ChannelInfo>> {
  // One Multicall3 read for every candidate instead of an eth_call per row.
  // A row the batch misses gets a read of its own while it shows open; any
  // other row, and there can be hundreds, waits for the next batch.
  const batched = await readChannelsBatched(client.provider, client.contractAddress, rows.map((row) => row.channelId)).catch(() => null);
  const sessions = new Map<string, ChannelInfo>();
  const unknown: DesktopPaymentChannelSummary[] = [];
  await runInBatches(rows, CHANNEL_ENRICH_CONCURRENCY, async (row) => {
    const info = batched?.get(row.channelId)
      ?? (isOpenChannelStatus(row.status) ? await client.getSession(row.channelId) : undefined);
    if (!info) return;
    sessions.set(row.channelId, info);
    if (info.status === 0 && /^0x[0-9a-fA-F]{40}$/.test(row.seller)) unknown.push(row);
  });
  // Channels with no canonical record may live behind the seller's facade.
  // Group them per facade and read each group in one call; a seller that is
  // not a facade resolves to itself and has no channel record to read.
  const bySeller = new Map<string, DesktopPaymentChannelSummary[]>();
  for (const row of unknown) bySeller.set(row.seller.toLowerCase(), [...(bySeller.get(row.seller.toLowerCase()) ?? []), row]);
  await runInBatches([...bySeller.values()], CHANNEL_ENRICH_CONCURRENCY, async (group) => {
    const facade = facadeClientFor(cc, group[0]!.seller, provider);
    const readAddress = await facade.readAddress.catch(() => facade.contractAddress);
    if (readAddress.toLowerCase() === facade.contractAddress.toLowerCase()) return;
    const viaFacade = await readChannelsBatched(facade.provider, readAddress, group.map((row) => row.channelId)).catch(() => null);
    await Promise.allSettled(group.map(async (row) => {
      const info = viaFacade?.get(row.channelId) ?? await facade.getSession(row.channelId);
      sessions.set(row.channelId, info);
    }));
  });
  return sessions;
}

/** Fetch every buyer channel from the local proxy, retired rows included. */
export async function loadBuyerChannels({ enrichOnChain = true, fresh = false }: {
  /** Let the chain decide each row's status (on by default). */
  enrichOnChain?: boolean;
  /** Skip the short status cache, e.g. for an explicit refresh. */
  fresh?: boolean;
} = {}): Promise<DesktopPaymentChannelSummary[] | null> {
  const body = await fetchBuyerProxyJson('/_antseed/channels?all=1');
  if (!body) return null;
  const channels = Array.isArray(body['channels'])
    ? body['channels']
      .map((entry) => normalizePaymentChannelSummary(entry))
      .filter((entry): entry is DesktopPaymentChannelSummary => entry !== null)
    : [];
  if (enrichOnChain) await enrichChannelStatuses(channels, fresh).catch(() => {});
  return channels;
}

// Pending spend rides on the credits poll, which runs every 60s normally and
// every 5s while the payment card is up. Cache it so the fast poll reuses one
// buyer-proxy round trip plus its channel reads instead of repeating them.
const PENDING_SPEND_TTL_MS = 20_000;
let cachedPendingSpend = 0n;
let cachedPendingSpendAt = 0;

export function notePendingSpend(channels: readonly DesktopPaymentChannelSummary[]): bigint {
  cachedPendingSpend = pendingSpendFromChannels(channels);
  cachedPendingSpendAt = Date.now();
  return cachedPendingSpend;
}

/**
 * Signed-but-unsettled spend across the buyer's open channels. Falls back to
 * the last known value when the buyer proxy is unreachable — dropping to 0
 * there would silently inflate the displayed balance.
 *
 * `maxWaitMs` bounds how long a caller waits: the buyer proxy may still be
 * starting (app launch, upgrade) and every open channel is read on-chain, so
 * past the bound the last known value is returned and the read finishes in
 * the background for the next poll.
 */
export async function getPendingSpendUsdc(maxWaitMs?: number): Promise<bigint> {
  if (Date.now() - cachedPendingSpendAt < PENDING_SPEND_TTL_MS) return cachedPendingSpend;
  const read = loadBuyerChannels()
    .catch(() => null)
    .then((channels) => (channels ? notePendingSpend(channels) : cachedPendingSpend));
  if (maxWaitMs === undefined) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<bigint>((resolve) => {
    timer = setTimeout(() => resolve(cachedPendingSpend), maxWaitMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
