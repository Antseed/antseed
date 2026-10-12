import {useEffect, useState} from 'react';
import ExecutionEnvironment from '@docusaurus/ExecutionEnvironment';

/**
 * Live network stats from Antscan (the Antseed Base explorer), replacing
 * hand-updated numbers in marketing copy. Fetches the on-chain
 * `networkSnapshot` from Antscan's public GraphQL API (CORS: *) and
 * formats values in the site's compact style ("95B+", "$188K+").
 *
 * SSR / hydration: the initial state is the FALLBACK constant on both the
 * server and the first client render (React #418), so the static build
 * ships the last known-good numbers and live values swap in after mount.
 * Any fetch failure silently keeps the fallback.
 *
 * The response is cached in sessionStorage for 10 minutes so client-side
 * navigation between pages doesn't refetch.
 *
 * Not available on-chain (still hand-maintained where used): model count —
 * the model directory lives in the network DHT, not in contract events.
 */

const ANTSCAN_GRAPHQL = 'https://antscan.co/graphql';
const CACHE_KEY = 'as-network-stats-v1';
const CACHE_TTL_MS = 10 * 60 * 1000;

const STATS_QUERY = `{
  networkSnapshot(id: "network") {
    totalVolumeUsdc
    totalInputTokens
    totalOutputTokens
    sellerCount
  }
  settlementMetadatas(limit: 1) { totalCount }
  epochMetrics(orderBy: "epoch", orderDirection: "desc", limit: 1) { items { epoch } }
}`;

interface SnapshotResponse {
  data?: {
    networkSnapshot?: {
      totalVolumeUsdc: string;
      totalInputTokens: string;
      totalOutputTokens: string;
      sellerCount: number;
    } | null;
    settlementMetadatas?: {totalCount: number};
    epochMetrics?: {items: {epoch: string}[]};
  };
}

export interface NetworkStats {
  /** Total settled tokens (input + output), e.g. "95B+" */
  tokens: string;
  /** Total settled USDC volume, e.g. "$188K+" */
  revenue: string;
  /** Same without the "+", for CountUp, e.g. "$188K" */
  revenueShort: string;
  /** Registered sellers, e.g. "177+" */
  providers: string;
  /** Same without the "+", for CountUp, e.g. "177" */
  providersCount: string;
  /** Average settlements per completed epoch, grouped, e.g. "12,502" */
  settlementsPerEpoch: string;
  /** true once live on-chain values have replaced the fallback */
  live: boolean;
}

/** Last known-good values — what SSR ships and what any failure shows. */
const FALLBACK: NetworkStats = {
  tokens: '82B+',
  revenue: '$143K+',
  revenueShort: '$143K',
  providers: '158+',
  providersCount: '162',
  settlementsPerEpoch: '18,440',
  live: false,
};

/** 95_373_559_732 → "95B" · 1_234_000 → "1.2M" · 188_718 → "188K".
    Floors instead of rounding so the "+" suffix stays honest. */
function compact(n: number): string {
  const floor1 = (x: number) => Math.floor(x * 10) / 10;
  if (n >= 1e9) {
    const v = n / 1e9;
    return `${v >= 10 ? Math.floor(v) : floor1(v)}B`;
  }
  if (n >= 1e6) {
    const v = n / 1e6;
    return `${v >= 10 ? Math.floor(v) : floor1(v)}M`;
  }
  if (n >= 1e3) {
    const v = n / 1e3;
    return `${v >= 10 ? Math.floor(v) : floor1(v)}K`;
  }
  return `${Math.floor(n)}`;
}

function toStats(res: SnapshotResponse): NetworkStats | null {
  const snap = res.data?.networkSnapshot;
  if (!snap) return null;
  const tokens = Number(snap.totalInputTokens) + Number(snap.totalOutputTokens);
  const revenueUsd = Number(snap.totalVolumeUsdc) / 1e6; // USDC has 6 decimals
  if (!Number.isFinite(tokens) || !Number.isFinite(revenueUsd) || tokens <= 0 || revenueUsd <= 0) {
    return null;
  }

  const settlements = res.data?.settlementMetadatas?.totalCount ?? 0;
  const currentEpoch = Number(res.data?.epochMetrics?.items?.[0]?.epoch ?? 0);
  const completedEpochs = Math.max(1, currentEpoch - 1);
  const perEpoch = settlements > 0 ? Math.floor(settlements / completedEpochs) : 0;

  return {
    tokens: `${compact(tokens)}+`,
    revenue: `$${compact(revenueUsd)}+`,
    revenueShort: `$${compact(revenueUsd)}`,
    providers: `${snap.sellerCount}+`,
    providersCount: `${snap.sellerCount}`,
    settlementsPerEpoch:
      perEpoch > 0 ? perEpoch.toLocaleString('en-US') : FALLBACK.settlementsPerEpoch,
    live: true,
  };
}

function readCache(): NetworkStats | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {at: number; stats: NetworkStats};
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return parsed.stats;
  } catch {
    return null;
  }
}

function writeCache(stats: NetworkStats): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({at: Date.now(), stats}));
  } catch {
    /* storage full / disabled — just refetch next navigation */
  }
}

export function useNetworkStats(): NetworkStats {
  const [stats, setStats] = useState<NetworkStats>(FALLBACK);

  useEffect(() => {
    if (!ExecutionEnvironment.canUseDOM) return undefined;
    const cached = readCache();
    if (cached) {
      setStats(cached);
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch(ANTSCAN_GRAPHQL, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({query: STATS_QUERY}),
      signal: controller.signal,
    })
      .then(r => (r.ok ? (r.json() as Promise<SnapshotResponse>) : null))
      .then(res => {
        if (cancelled || !res) return;
        const live = toStats(res);
        if (live) {
          writeCache(live);
          setStats(live);
        }
      })
      .catch(() => {
        /* offline / API down — keep the fallback numbers */
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return stats;
}
