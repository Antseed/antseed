/**
 * NetworkPoller
 *
 * Connects to the Antseed network as an anonymous buyer, discovers peers,
 * and returns raw PeerMetadata for each discovered peer.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface NetworkSnapshot {
  peers: PeerMetadata[];
  updatedAt: string; // ISO 8601
}

const DEFAULT_CACHE_PATH = join(__dirname, '..', 'cache', 'network.json');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const DHT_WARMUP_MS = 15_000;            // wait for routing table to populate
// Filter out peers whose last DHT announcement is older than this.
// Matches desktop's PEER_ONLINE_TTL_MS — peers re-announce every ~5 min.
const PEER_STALE_MS = 2 * 60 * 60_000;   // 2 hours

export class NetworkPoller {
  private snapshot: NetworkSnapshot = { peers: [], updatedAt: new Date(0).toISOString() };
  private cachePath: string;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(cachePath = DEFAULT_CACHE_PATH) {
    this.cachePath = cachePath;
  }

  /**
   * Return the latest cached snapshot, filtered to exclude peers whose
   * `timestamp` is older than `PEER_STALE_MS`. All metadata versions are
   * surfaced — network-stats is a network observer, not a buyer, so it
   * should show peers across codec versions (consumers can filter).
   * Filtering happens at read time so the on-disk cache remains the source
   * of truth and peers refreshed on the next poll repopulate seamlessly.
   */
  getSnapshot(): NetworkSnapshot {
    const now = Date.now();
    const peers = this.snapshot.peers.filter((p) => {
      const ts = typeof p.timestamp === 'number' ? p.timestamp : 0;
      return ts === 0 || now - ts < PEER_STALE_MS;
    });
    return { peers, updatedAt: this.snapshot.updatedAt };
  }

  /** Start polling. Loads cache from disk on first run, then polls immediately. */
  async start(): Promise<void> {
    await this.loadCache();
    // First poll after DHT warmup
    setTimeout(() => {
      this.poll().catch((err: unknown) => console.error('[network-stats] poll error:', err));
    }, DHT_WARMUP_MS);
    // Subsequent periodic polls
    this.timer = setInterval(() => {
      this.poll().catch((err: unknown) => console.error('[network-stats] poll error:', err));
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Perform one discovery cycle. */
  async poll(): Promise<void> {
    console.log('[network-stats] starting poll...');
    const peerId = toPeerId(randomBytes(20).toString('hex'));
    const dht = new DHTNode({
      ...DEFAULT_DHT_CONFIG,
      port: 0, // OS-assigned, ephemeral
      bootstrapNodes: toBootstrapConfig(OFFICIAL_BOOTSTRAP_NODES),
      peerId,
    });

    try {
      await dht.start();

      const metadataResolver = new HttpMetadataResolver();
      const peerLookup = new PeerLookup({
        dht,
        metadataResolver,
        requireValidSignature: DEFAULT_LOOKUP_CONFIG.requireValidSignature,
        allowStaleMetadata: DEFAULT_LOOKUP_CONFIG.allowStaleMetadata,
        maxAnnouncementAgeMs: DEFAULT_LOOKUP_CONFIG.maxAnnouncementAgeMs,
        maxClientServerClockSkewMs: DEFAULT_LOOKUP_CONFIG.maxClientServerClockSkewMs,
        maxResults: DEFAULT_LOOKUP_CONFIG.maxResults,
      });

      // Use the SDK's latest whole-network discovery flow instead of manually
      // fanning out DHT lookups. PeerLookup warms the routing table via the
      // wildcard topic, then walks subnet shards sequentially so each shard gets
      // a full lookup slot; it also validates metadata signatures and freshness.
      const results = await peerLookup.findAllExhaustive();
      const discoveredPeers = new Map<string, PeerMetadata>();
      for (const result of results) {
        discoveredPeers.set(result.metadata.peerId, result.metadata);
      }

      this.snapshot = {
        peers: [...discoveredPeers.values()],
        updatedAt: new Date().toISOString(),
      };

      console.log(`[network-stats] poll complete — ${this.snapshot.peers.length} peers`);
      await this.saveCache();
    } finally {
      await dht.stop().catch(() => {});
    }
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await readFile(this.cachePath, 'utf8');
      this.snapshot = JSON.parse(raw) as NetworkSnapshot;
      console.log('[network-stats] loaded cache from disk');
    } catch {
      // file missing or stale — start fresh
    }
  }

  private async saveCache(): Promise<void> {
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, JSON.stringify(this.snapshot, null, 2), 'utf8');
    } catch (err) {
      console.error('[network-stats] failed to save cache:', err);
    }
  }
}
