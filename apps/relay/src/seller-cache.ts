/**
 * SellerCache
 *
 * Maintains the set of sellers a browser buyer may bridge to. Entries come
 * from periodic DHT discovery (same flow as network-stats) and/or a static
 * list supplied via config. The bridge only ever dials endpoints found here,
 * so the relay can never be used as an open TCP proxy.
 */

import { randomBytes } from 'node:crypto';
import {
  DHTNode,
  DEFAULT_DHT_CONFIG,
  DEFAULT_LOOKUP_CONFIG,
  HttpMetadataResolver,
  OFFICIAL_BOOTSTRAP_NODES,
  PeerLookup,
  toBootstrapConfig,
} from '@antseed/node/discovery';
import { toPeerId } from '@antseed/node';
import type { PeerMetadata } from '@antseed/node';

export interface SellerEndpoint {
  host: string;
  port: number;
  /**
   * True for operator-configured static sellers. Discovered endpoints come
   * from attacker-controllable DHT announcements, so the bridge applies the
   * private-address guard before dialing them.
   */
  trusted: boolean;
}

export interface StaticSeller {
  peerId: string;
  host: string;
  port: number;
}

export interface SellerCacheConfig {
  dht: boolean;
  pollIntervalMs: number;
  staticSellers: StaticSeller[];
  bootstrapNodes?: { host: string; port: number }[];
}

const DHT_WARMUP_MS = 15_000;
const PEER_STALE_MS = 2 * 60 * 60_000;
const DEFAULT_SIGNALING_PORT = 6882;

/**
 * Parses `host[:port]`, `[v6]:port`, or a bare IPv6 address (no port).
 * Returns null on malformed input.
 */
export function parseHostPort(address: string): { host: string; port: number } | null {
  let host: string;
  let portStr: string | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(address);
  if (bracket) {
    host = bracket[1]!;
    portStr = bracket[2];
  } else if (address.split(':').length > 2) {
    host = address; // bare IPv6, no port
  } else {
    [host, portStr] = address.split(':') as [string, string | undefined];
  }
  if (!host) return null;
  const port = portStr ? parseInt(portStr, 10) : DEFAULT_SIGNALING_PORT;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
}

/** Parses `peerId@host:port[,peerId@host:port...]` (port optional). */
export function parseStaticSellers(raw: string): StaticSeller[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf('@');
      if (at < 0) throw new Error(`invalid static seller "${entry}" — expected peerId@host:port`);
      const peerId = toPeerId(entry.slice(0, at));
      const [host, portStr] = entry.slice(at + 1).split(':');
      if (!host) throw new Error(`invalid static seller "${entry}" — missing host`);
      const port = portStr ? parseInt(portStr, 10) : DEFAULT_SIGNALING_PORT;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`invalid static seller "${entry}" — bad port`);
      }
      return { peerId, host, port };
    });
}

export class SellerCache {
  private discovered = new Map<string, PeerMetadata>();
  private updatedAt: string = new Date(0).toISOString();
  private warmupTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: SellerCacheConfig) {}

  start(): void {
    if (!this.config.dht) return;
    this.warmupTimer = setTimeout(() => void this.safePoll(), DHT_WARMUP_MS);
    this.timer = setInterval(() => void this.safePoll(), this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.warmupTimer !== null) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Endpoint for a peerId, or null if unknown. Static entries win. */
  resolve(peerId: string): SellerEndpoint | null {
    const id = peerId.toLowerCase();
    const staticEntry = this.config.staticSellers.find((s) => s.peerId === id);
    if (staticEntry) return { host: staticEntry.host, port: staticEntry.port, trusted: true };

    const meta = this.discovered.get(id);
    if (!meta?.publicAddress) return null;
    const ts = typeof meta.timestamp === 'number' ? meta.timestamp : 0;
    if (ts !== 0 && Date.now() - ts >= PEER_STALE_MS) return null;

    const parsed = parseHostPort(meta.publicAddress);
    if (!parsed) return null;
    return { ...parsed, trusted: false };
  }

  snapshot(): { peers: PeerMetadata[]; static: StaticSeller[]; updatedAt: string } {
    const now = Date.now();
    const peers = [...this.discovered.values()].filter((p) => {
      const ts = typeof p.timestamp === 'number' ? p.timestamp : 0;
      return ts === 0 || now - ts < PEER_STALE_MS;
    });
    return { peers, static: this.config.staticSellers, updatedAt: this.updatedAt };
  }

  /** Whether this instance has a usable, sufficiently fresh seller view. */
  isReady(maxAgeMs: number): boolean {
    if (this.config.staticSellers.length > 0) return true;
    if (!this.config.dht) return false;
    const updatedAtMs = Date.parse(this.updatedAt);
    return Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs <= maxAgeMs;
  }

  async poll(): Promise<void> {
    const peerId = toPeerId(randomBytes(20).toString('hex'));
    const dht = new DHTNode({
      ...DEFAULT_DHT_CONFIG,
      port: 0,
      bootstrapNodes: this.config.bootstrapNodes ?? toBootstrapConfig(OFFICIAL_BOOTSTRAP_NODES),
      peerId,
    });
    try {
      await dht.start();
      const peerLookup = new PeerLookup({
        dht,
        metadataResolver: new HttpMetadataResolver(),
        requireValidSignature: DEFAULT_LOOKUP_CONFIG.requireValidSignature,
        allowStaleMetadata: DEFAULT_LOOKUP_CONFIG.allowStaleMetadata,
        maxAnnouncementAgeMs: DEFAULT_LOOKUP_CONFIG.maxAnnouncementAgeMs,
        maxClientServerClockSkewMs: DEFAULT_LOOKUP_CONFIG.maxClientServerClockSkewMs,
        maxResults: DEFAULT_LOOKUP_CONFIG.maxResults,
      });
      const results = await peerLookup.findAllExhaustive();
      const next = new Map<string, PeerMetadata>();
      for (const result of results) {
        next.set(result.metadata.peerId.toLowerCase(), result.metadata);
      }
      this.discovered = next;
      this.updatedAt = new Date().toISOString();
      console.log(`[relay] discovery poll complete — ${next.size} peers`);
    } finally {
      await dht.stop().catch(() => {});
    }
  }

  private async safePoll(): Promise<void> {
    try {
      await this.poll();
    } catch (err) {
      console.error('[relay] discovery poll error:', err);
    }
  }
}
