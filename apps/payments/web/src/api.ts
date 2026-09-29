import type { BalanceData, PaymentConfig } from './types';

const BASE = '';

// Read bearer token from URL param (injected by the desktop app when opening the portal)
// Cached after first read — URL doesn't change during the session.
let _cachedToken: string | null | undefined;
function getBearerToken(): string | null {
  if (_cachedToken !== undefined) return _cachedToken;
  _cachedToken = new URLSearchParams(window.location.search).get('token');
  return _cachedToken;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const token = getBearerToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}${url}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('antseed:session-expired'));
    }
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getBalance(): Promise<BalanceData> {
  return fetchJson('/api/balance');
}

export async function getConfig(): Promise<PaymentConfig> {
  return fetchJson('/api/config');
}

export interface RpcHealthResponse {
  ok: boolean;
  blockNumber: number;
  latencyMs: number;
}

export async function getRpcHealth(): Promise<RpcHealthResponse> {
  return fetchJson('/api/rpc-health');
}

/** Raw channel row from the buyer proxy's local ChannelStore — no on-chain enrichment. */
export interface RawChannel {
  channelId: string;
  peerId: string;
  seller: string;
  buyer: string;
  reserveCeiling: string | null;
  cumulativeSigned: string;
  deadline: number;
  reservedAt: number;
  status: string;
  requestCount: number;
  tokensDelivered: string;
}

/** Client-side enriched channel — `deposit`/`settled`/`status` are from on-chain reads. */
export interface ChannelData {
  channelId: string;
  seller: string;
  deposit: string;
  settled: string;
  reservedAt: number;
  deadline: number;
  closeRequestedAt: number;
  status: number;
}

export interface OperatorData {
  operator: string;
  nonce: number;
}

export async function getChannels(): Promise<{ channels: RawChannel[] }> {
  return fetchJson('/api/channels');
}

export async function getOperatorInfo(): Promise<OperatorData> {
  return fetchJson('/api/operator');
}

export async function signOperatorAuth(operator: string): Promise<{ ok: boolean; signature: string; nonce: number; buyer: string }> {
  return fetchJson('/api/operator/sign', {
    method: 'POST',
    body: JSON.stringify({ operator }),
  });
}

export interface EmissionsEpochInfo {
  currentEpoch: number;
  epochDuration: number;
  currentRate: string;
  epochEmission: string;
  genesis: number;
  halvingInterval: number;
}

export interface EmissionsEpochParams {
  sellerSharePct: number;
  buyerSharePct: number;
  reserveSharePct: number;
  teamSharePct: number;
  maxSellerSharePct: number;
  maxBuyerSharePct: number;
  initialized: boolean;
}

export interface EmissionsPendingRow {
  epoch: number;
  protocol: 'legacy' | 'recognized';
  epochEmission: string;
  params: EmissionsEpochParams | null;
  seller: { amount: string; userPoints: string; totalPoints: string; claimed: boolean };
  buyer:  { amount: string; userPoints: string; totalPoints: string; claimed: boolean };
  isCurrent: boolean;
}

export interface EmissionsPendingResponse {
  currentEpoch: number;
  rows: EmissionsPendingRow[];
}

export interface EmissionsShares extends EmissionsEpochParams {}

export async function getEmissionsInfo(): Promise<EmissionsEpochInfo> {
  return fetchJson('/api/emissions');
}

export async function getEmissionsPending(address: string, epochs = 10): Promise<EmissionsPendingResponse> {
  const params = new URLSearchParams({ address, epochs: String(epochs) });
  return fetchJson(`/api/emissions/pending?${params.toString()}`);
}

export async function getEmissionsShares(): Promise<EmissionsShares> {
  return fetchJson('/api/emissions/shares');
}

export async function getTransfersEnabled(): Promise<{ enabled: boolean; configured: boolean }> {
  return fetchJson('/api/emissions/transfers-enabled');
}

/** Tell the host app a pay action completed — it refocuses and refreshes. */
export async function notifyPaymentCompleted(): Promise<void> {
  await fetchJson('/api/pay/completed', { method: 'POST' });
}

export interface BuyerUsageChannelPoint {
  reservedAt: number;
  updatedAt: number;
  requestCount: number;
  inputTokens: string;
  outputTokens: string;
}

export interface BuyerUsageTotals {
  totalRequests: number;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalSettlements: number;
  uniqueSellers: number;
  activeChannels: number;
  channels: BuyerUsageChannelPoint[];
}

/**
 * Personal buyer usage, sourced from the buyer's local channel store via
 * the payments server. All fields are answerable without hitting the
 * external network-stats aggregator.
 */
export async function getBuyerUsage(): Promise<BuyerUsageTotals> {
  return fetchJson('/api/buyer-usage');
}

export interface NetworkStatsTotals {
  activePeers: number;
  totalRequests: string;        // bigint as string
  totalInputTokens: string;
  totalOutputTokens: string;
  totalSettlements: number;
  sellerCount?: number;
}

export interface NetworkStatsResponse {
  totals: NetworkStatsTotals;
  indexer?: {
    lastBlock: number;
    lastBlockTimestamp: number | null;
    latestBlock?: number;
    synced?: boolean;
  };
}

/**
 * Calls the network-stats `/stats` endpoint. Newer network-stats servers expose
 * top-level aggregate totals that include inactive historical sellers; fall back
 * to aggregating active peers for compatibility with older deployments.
 */
export async function getNetworkStats(networkStatsUrl: string): Promise<NetworkStatsResponse> {
  const url = `${networkStatsUrl.replace(/\/$/, '')}/stats`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`network-stats returned ${res.status}`);
  }
  const body = (await res.json()) as {
    peers?: Array<{
      onChainStats?: {
        totalRequests?: string;
        totalInputTokens?: string;
        totalOutputTokens?: string;
        settlementCount?: number;
      } | null;
    }>;
    totals?: {
      totalRequests?: string;
      totalInputTokens?: string;
      totalOutputTokens?: string;
      settlementCount?: number;
      sellerCount?: number;
    };
    indexer?: NetworkStatsResponse['indexer'];
  };
  const peers = Array.isArray(body.peers) ? body.peers : [];
  const activePeers = peers.filter((peer) => peer.onChainStats).length;

  if (body.totals) {
    return {
      totals: {
        activePeers,
        totalRequests: body.totals.totalRequests ?? '0',
        totalInputTokens: body.totals.totalInputTokens ?? '0',
        totalOutputTokens: body.totals.totalOutputTokens ?? '0',
        totalSettlements: Number(body.totals.settlementCount ?? 0),
        ...(typeof body.totals.sellerCount === 'number' ? { sellerCount: body.totals.sellerCount } : {}),
      },
      indexer: body.indexer,
    };
  }
  let totalRequests = 0n;
  let totalInputTokens = 0n;
  let totalOutputTokens = 0n;
  let totalSettlements = 0;
  for (const peer of peers) {
    const s = peer.onChainStats;
    if (!s) continue;
    try {
      totalRequests += BigInt(s.totalRequests ?? '0');
      totalInputTokens += BigInt(s.totalInputTokens ?? '0');
      totalOutputTokens += BigInt(s.totalOutputTokens ?? '0');
    } catch {
      // skip malformed numeric strings
    }
    totalSettlements += Number(s.settlementCount ?? 0);
  }
  return {
    totals: {
      activePeers,
      totalRequests: totalRequests.toString(),
      totalInputTokens: totalInputTokens.toString(),
      totalOutputTokens: totalOutputTokens.toString(),
      totalSettlements,
    },
    indexer: body.indexer,
  };
}

/** Old claim links hand off to the shared dashboard through their trusted host. */
export async function openRewardsDashboard(): Promise<void> {
  await fetchJson('/api/pay/open-rewards', { method: 'POST' });
}
