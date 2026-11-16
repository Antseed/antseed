import { readFile } from 'node:fs/promises';
import { net } from 'electron';
import { DEFAULT_BUYER_STATE_PATH } from '../constants.js';
import { resolveBuyerProxyPort } from './active-config.js';
import { getTelemetryService } from '../telemetry/runtime.js';
import { readPeerHealth, type RawPeerHealth } from './peer-health.js';
import { computePeerSignature } from './peer-signature.js';
import { deriveNetworkLifecycleObservation } from './network-lifecycle.js';

export { readPeerHealth } from './peer-health.js';
export type { RawPeerHealth } from './peer-health.js';

export type DashboardNetworkPeer = {
  peerId: string;
  displayName: string | null;
  host: string;
  port: number;
  providers: string[];
  services: string[];
  /**
   * Services this peer actually serves for $0 (cached tokens included), from
   * its per-service pricing matrix — present only once the peer's metadata
   * has been fetched, unlike the headline default prices which fall back to 0
   * when unknown.
   */
  freeServices: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  onChainReputationScore: number | null;
  lastSeen: number;
  /**
   * Last successful transport-level contact with the peer. This can be fresher
   * than the DHT announcement timestamp when discovery temporarily misses a
   * peer but requests are still succeeding.
   */
  lastReachedAt: number | null;
  source: 'dht' | 'daemon';
  online: boolean;
  /**
   * Buyer-proxy cooldown: peers that recently failed are deprioritized by auto
   * routing until this passes. Null when the peer has no cooldown. Advisory —
   * a cooling-down peer is still reachable if a request names it.
   */
  cooldownUntil: number | null;
  failureStreak: number;
  lastFailureReason: string | null;
};

/** Join a peer with its health entry. */
export function mergePeerHealthIntoPeer(
  peer: DashboardNetworkPeer,
  raw: RawPeerHealth | undefined,
  now: number,
): DashboardNetworkPeer {
  return { ...peer, ...readPeerHealth(raw, now) };
}

export type DashboardNetworkStats = {
  totalPeers: number;
  dhtNodeCount: number;
  dhtHealthy: boolean;
  lastScanAt: number | null;
  internetOnline?: boolean;
  proxyReachable?: boolean;
  proxyUptimeMs?: number | null;
  totalLookups?: number;
  successfulLookups?: number;
  lookupSuccessRate?: number;
  averageLookupLatencyMs?: number;
  healthReason?: string;
};

export type DashboardNetworkResult = {
  ok: boolean;
  peers: DashboardNetworkPeer[];
  stats: DashboardNetworkStats;
  error: string | null;
};

export const PEER_ONLINE_TTL_MS = 2 * 60 * 60_000; // 2 hours — peers re-announce via DHT every 5 min

const REFRESH_MIN_INTERVAL_MS = 5_000;

const peerCache = new Map<string, DashboardNetworkPeer>();
let peerCacheLastScanAt: number | null = null;
let peerCacheLastRefreshAt = 0;
let peerCacheLastSignature = '';
const peersChangedListeners: Array<() => void> = [];

type NetworkHealthProbe = {
  proxyReachable: boolean;
  /** null = proxy running but status endpoint unavailable (older CLI). */
  dhtNodeCount: number | null;
  peerCount: number | null;
  consecutiveEmptyDiscoveries: number;
  proxyUptimeMs: number | null;
  internetOnline: boolean;
};
let lastHealthProbe: NetworkHealthProbe | null = null;
let healthProbeInFlight: Promise<void> | null = null;

/**
 * Probe the buyer proxy's /_antseed/status. A firewall/VPN drops DHT traffic
 * silently — lookups "succeed" with zero results — so the routing-table size
 * is the only trustworthy signal that we are actually on the network.
 */
async function refreshNetworkHealth(): Promise<void> {
  if (healthProbeInFlight) return healthProbeInFlight;
  healthProbeInFlight = (async () => {
    const internetOnline = net.isOnline();
    try {
      const port = await resolveBuyerProxyPort();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/_antseed/status`, {
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (response.ok && payload?.['ok'] === true) {
          lastHealthProbe = {
            proxyReachable: true,
            dhtNodeCount: Number(payload['dhtNodeCount']) || 0,
            peerCount: Number(payload['peerCount']) || 0,
            consecutiveEmptyDiscoveries: Number(payload['consecutiveEmptyDiscoveries']) || 0,
            proxyUptimeMs: Number.isFinite(Number(payload['uptimeMs'])) ? Number(payload['uptimeMs']) : null,
            internetOnline,
          };
          return;
        }
        // Older CLI without the status endpoint: reachable, DHT state unknown.
        lastHealthProbe = { proxyReachable: true, dhtNodeCount: null, peerCount: null, consecutiveEmptyDiscoveries: 0, proxyUptimeMs: null, internetOnline };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      lastHealthProbe = { proxyReachable: false, dhtNodeCount: null, peerCount: null, consecutiveEmptyDiscoveries: 0, proxyUptimeMs: null, internetOnline };
    }
  })().finally(() => {
    healthProbeInFlight = null;
  });
  return healthProbeInFlight;
}

/** Register a callback invoked when the peer set changes. Returns an unsubscribe function. */
export function onPeersChanged(listener: () => void): () => void {
  peersChangedListeners.push(listener);
  return () => {
    const idx = peersChangedListeners.indexOf(listener);
    if (idx >= 0) peersChangedListeners.splice(idx, 1);
  };
}

function emitIfChanged(): void {
  const sig = computePeerSignature(peerCache);
  if (sig !== peerCacheLastSignature) {
    peerCacheLastSignature = sig;
    for (const listener of peersChangedListeners) {
      try { listener(); } catch { /* ignore */ }
    }
  }
}

export function defaultNetworkStats(): DashboardNetworkStats {
  return {
    totalPeers: 0,
    dhtNodeCount: 0,
    dhtHealthy: false,
    lastScanAt: null,
    totalLookups: 0,
    successfulLookups: 0,
    lookupSuccessRate: 0,
    averageLookupLatencyMs: 0,
    healthReason: 'dashboard offline',
  };
}

export function parsePeerFromRaw(pr: Record<string, unknown>): DashboardNetworkPeer | null {
  if (typeof pr.peerId !== 'string') return null;

  let peerHost = '';
  let peerPort = 0;
  if (typeof pr.publicAddress === 'string') {
    const addr = pr.publicAddress as string;
    const lastColon = addr.lastIndexOf(':');
    peerHost = lastColon > -1 ? addr.slice(0, lastColon) : addr;
    peerPort = lastColon > -1 ? Number(addr.slice(lastColon + 1)) || 0 : 0;
  }

  const displayName = typeof pr.displayName === 'string' && pr.displayName.trim().length > 0
    ? pr.displayName.trim()
    : null;

  const providers = Array.isArray(pr.providers)
    ? (pr.providers as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  const services = Array.isArray(pr.services)
    ? (pr.services as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];

  // Per-service $0 offers from the announced pricing matrix. Every service
  // listed there carries explicit prices, so a zero here means the seller
  // really serves it free — the same judgement the routing free-gate makes.
  const freeServices: string[] = [];
  if (pr.providerPricing && typeof pr.providerPricing === 'object') {
    for (const entry of Object.values(pr.providerPricing as Record<string, unknown>)) {
      const serviceMap = (entry as { services?: unknown } | null)?.services;
      if (!serviceMap || typeof serviceMap !== 'object') continue;
      for (const [service, pricing] of Object.entries(serviceMap as Record<string, unknown>)) {
        const p = pricing as { inputUsdPerMillion?: unknown; outputUsdPerMillion?: unknown; cachedInputUsdPerMillion?: unknown } | null;
        if (!p) continue;
        const input = Number(p.inputUsdPerMillion);
        const output = Number(p.outputUsdPerMillion);
        const cached = p.cachedInputUsdPerMillion === undefined || p.cachedInputUsdPerMillion === null
          ? 0
          : Number(p.cachedInputUsdPerMillion);
        if (input === 0 && output === 0 && cached <= 0) freeServices.push(service);
      }
    }
  }

  return {
    peerId: pr.peerId as string,
    displayName,
    host: peerHost,
    port: peerPort,
    providers,
    services,
    freeServices,
    inputUsdPerMillion: Number(pr.defaultInputUsdPerMillion) || 0,
    outputUsdPerMillion: Number(pr.defaultOutputUsdPerMillion) || 0,
    capacityMsgPerHour: (Number(pr.maxConcurrency) || 0) * 60,
    reputation: 100,
    onChainReputationScore: typeof pr.onChainReputationScore === 'number' && Number.isFinite(pr.onChainReputationScore)
      ? pr.onChainReputationScore
      : null,
    lastSeen: Number(pr.lastSeen) || Date.now(),
    lastReachedAt: Number(pr.lastReachedAt) || null,
    source: 'dht',
    online: true,
    cooldownUntil: null,
    failureStreak: 0,
    lastFailureReason: null,
  };
}

function peerFreshnessAnchor(peer: Pick<DashboardNetworkPeer, 'lastSeen' | 'lastReachedAt'>): number {
  return Math.max(Number(peer.lastSeen) || 0, Number(peer.lastReachedAt) || 0);
}

/** Refresh peer cache from buyer.state.json — derive online status from lastSeen / lastReachedAt. */
export async function refreshPeerCache(): Promise<void> {
  const now = Date.now();
  // Use a shorter debounce until we've found at least one peer (startup phase).
  const interval = peerCache.size === 0 ? 1_000 : REFRESH_MIN_INTERVAL_MS;
  if (now - peerCacheLastRefreshAt < interval) {
    return;
  }
  peerCacheLastRefreshAt = now;

  await refreshNetworkHealth();

  try {
    const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawPeers = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];
    const rawHealth = parsed.peerHealth && typeof parsed.peerHealth === 'object' && !Array.isArray(parsed.peerHealth)
      ? parsed.peerHealth as Record<string, RawPeerHealth>
      : {};

    for (const p of rawPeers) {
      if (!p || typeof p !== 'object') continue;
      const parsedPeer = parsePeerFromRaw(p as Record<string, unknown>);
      if (!parsedPeer) continue;
      const peer = mergePeerHealthIntoPeer(parsedPeer, rawHealth[parsedPeer.peerId], now);
      // Skip legacy (non-EVM) peer IDs — EVM addresses are 40 hex chars
      if (peer.peerId.length !== 40) continue;

      const existing = peerCache.get(peer.peerId);
      if (existing) {
        peer.displayName = peer.displayName ?? existing.displayName;
        peer.providers = peer.providers.length > 0 ? peer.providers : existing.providers;
        peer.services = peer.services.length > 0 ? peer.services : existing.services;
        peer.freeServices = peer.freeServices.length > 0 ? peer.freeServices : existing.freeServices;
        peer.inputUsdPerMillion = peer.inputUsdPerMillion || existing.inputUsdPerMillion;
        peer.outputUsdPerMillion = peer.outputUsdPerMillion || existing.outputUsdPerMillion;
        peer.capacityMsgPerHour = peer.capacityMsgPerHour || existing.capacityMsgPerHour;
        peer.onChainReputationScore = peer.onChainReputationScore ?? existing.onChainReputationScore;
        peer.lastSeen = Math.max(peer.lastSeen, existing.lastSeen);
        peer.lastReachedAt = Math.max(peer.lastReachedAt ?? 0, existing.lastReachedAt ?? 0) || null;
      }
      // Derive online from the freshest known liveness signal. `lastSeen` is
      // the DHT announcement timestamp; `lastReachedAt` is updated after a
      // successful transport/request. If discovery misses all peers for a bit,
      // using only lastSeen makes the desktop paint everything offline even
      // though recently-used peers are still reachable.
      peer.online = now - peerFreshnessAnchor(peer) < PEER_ONLINE_TTL_MS;
      peerCache.set(peer.peerId, peer);
    }

    peerCacheLastScanAt = Number(parsed.peersUpdatedAt) || Date.now();
  } catch {
    // File doesn't exist yet — buyer runtime may not be running.
  }

  // Re-derive online for every cached peer so evicted / un-filed peers
  // also transition to offline once both liveness timestamps expire.
  for (const peer of peerCache.values()) {
    peer.online = now - peerFreshnessAnchor(peer) < PEER_ONLINE_TTL_MS;
  }

  emitIfChanged();

  const onlinePeers = Array.from(peerCache.values()).filter((peer) => peer.online);
  const observation = deriveNetworkLifecycleObservation(
    lastHealthProbe,
    onlinePeers.length,
    new Set(onlinePeers.flatMap((peer) => peer.services)).size,
  );
  if (observation.runtimeStarted) {
    const telemetry = getTelemetryService();
    void telemetry?.recordNetworkRuntimeStarted();
    if (observation.dhtRoutingNodeCount !== null) {
      void telemetry?.recordDhtStarted(observation.dhtRoutingNodeCount);
    }
    if (observation.discoveredPeerCount > 0) {
      void telemetry?.recordPeersDiscovered(
        observation.discoveredPeerCount,
        observation.discoveredServiceCount,
      );
    }
  }
}

export function getNetworkSnapshot(): DashboardNetworkResult {
  const peers = Array.from(peerCache.values());
  const probe = lastHealthProbe;
  const anyOnline = peers.some((p) => p.online);

  // Prefer the live probe: cached peers can look "online" for hours after
  // switching to a network that blocks P2P traffic.
  const dhtHealthy = probe?.proxyReachable && probe.dhtNodeCount !== null
    ? probe.internetOnline && probe.dhtNodeCount > 0 && probe.consecutiveEmptyDiscoveries < 3
    : anyOnline;

  let healthReason = 'ok';
  if (!probe || !probe.proxyReachable) {
    healthReason = 'runtime offline';
  } else if (!probe.internetOnline) {
    healthReason = 'no internet';
  } else if (probe.dhtNodeCount === 0) {
    healthReason = 'dht unreachable';
  } else if (probe.dhtNodeCount === null) {
    healthReason = 'dht status unavailable';
  } else if (probe.consecutiveEmptyDiscoveries >= 3) {
    healthReason = 'no peers found';
  }

  return {
    ok: true,
    peers,
    stats: {
      ...defaultNetworkStats(),
      totalPeers: peers.length,
      dhtNodeCount: probe?.dhtNodeCount ?? 0,
      dhtHealthy,
      lastScanAt: peerCacheLastScanAt,
      internetOnline: probe?.internetOnline ?? true,
      proxyReachable: probe?.proxyReachable ?? false,
      proxyUptimeMs: probe?.proxyUptimeMs ?? null,
      healthReason,
    },
    error: null,
  };
}

