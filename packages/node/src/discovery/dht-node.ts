import DHT from "bittorrent-dht";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lookup as lookupHost } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { debugWarn } from "../utils/debug.js";
import type { PeerId } from "../types/peer.js";
import { OFFICIAL_BOOTSTRAP_NODES, toBootstrapConfig } from "./bootstrap.js";

export interface DHTPeerEndpoint {
  host: string;
  port: number;
}

export interface DHTNodeConfig {
  peerId: PeerId;
  port: number;
  bootstrapNodes: Array<{ host: string; port: number }>;
  reannounceIntervalMs: number;
  operationTimeoutMs: number;
  /** Allow private/loopback IPs in lookup results. Default: false. Set true for local testing. */
  allowPrivateIPs?: boolean;
  /** Injectable bootstrap DNS lookup. Always called with IPv4 and all answers requested. */
  lookup?: (host: string, options: { family: 4; all: true }) => Promise<LookupAddress[]>;
}

export const DEFAULT_DHT_CONFIG: Omit<DHTNodeConfig, "peerId"> = {
  port: 6881,
  bootstrapNodes: toBootstrapConfig(OFFICIAL_BOOTSTRAP_NODES),
  // 5 min — short enough that a missed reannounce is recovered well before
  // most BEP-5 storage nodes expire the value (~30 min). Used to be 15 min,
  // which sat right at the edge and caused intermittent visibility gaps.
  reannounceIntervalMs: 5 * 60 * 1000,
  // 25s — long enough for a cold routing table to fan out and for the DHT
  // to drain its 'peer' events. With 10s we frequently observed lookups
  // returning a small subset of announcers right after bootstrap.
  operationTimeoutMs: 25_000,
};

function isPublicIP(host: string): boolean {
  if (host === "localhost" || host === "::1") return false;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const [a, b] = parts.map(Number);
  if (a === 127) return false; // loopback
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 169 && b === 254) return false; // link-local
  if (a === 0) return false;
  return true;
}

export function topicToInfoHash(topic: string): Buffer {
  return createHash("sha1").update(topic).digest();
}

function normalizeTopicSegment(value: string): string {
  return value.trim().toLowerCase();
}

/** Wildcard topic that all peers announce on — used for general discovery. */
export const ANTSEED_WILDCARD_TOPIC = "antseed:*";

/**
 * Number of subnet shards used to spread peer announcements across multiple
 * DHT infohashes. The wildcard topic concentrates *every* peer onto one
 * infohash, which is stored at the K=8 nodes closest to that infohash.
 * Once the announcement count exceeds those nodes' per-infohash capacity
 * (~50–200 entries per node depending on implementation), individual
 * announcers start aging out and `dht.lookup` returns inconsistent subsets.
 *
 * Sharding peers across N subnets keeps each subnet's K-closest set well
 * under that limit. Buyers fan out N parallel `dht.lookup` calls (one per
 * subnet) and union the results — total wall-clock cost is unchanged because
 * the lookups share the routing table and run in parallel.
 *
 * 16 is a good balance for the foreseeable network size:
 *   - up to ~3 200 peers (200/subnet × 16) before the saturation regime
 *     reappears
 *   - 16 parallel lookups is trivial for the routing table and bandwidth
 *   - first byte of an EVM-derived peerId is already pseudo-random, so
 *     `parseInt(peerId.slice(0, 2), 16) % 16` distributes peers evenly
 *
 * Bumping this constant requires a coordinated upgrade: old peers will keep
 * announcing on a different subnet count, and old buyers will keep querying
 * a different one. During such a transition we'd announce on multiple Ns
 * and query both. The wildcard topic is kept as the fallback path until the
 * subnet announce/query is universal.
 */
export const SUBNET_COUNT = 16;

/**
 * Map a peerId to its subnet index in `[0, SUBNET_COUNT)`. The first byte of
 * an EVM-derived peerId is uniformly distributed, so `firstByte % N`
 * spreads peers evenly across subnets.
 *
 * Throws no errors — invalid input falls through to subnet 0 so callers
 * never need to special-case bad peerIds. Real callers always pass a
 * 40-hex peerId; this only matters for defensive correctness.
 */
export function subnetOf(peerId: string, subnetCount: number = SUBNET_COUNT): number {
  const normalized = peerId.trim().toLowerCase().replace(/^0x/, "");
  if (normalized.length < 2) return 0;
  const firstByte = parseInt(normalized.slice(0, 2), 16);
  if (!Number.isFinite(firstByte)) return 0;
  return firstByte % subnetCount;
}

/**
 * Topic used to enumerate a single subnet. Sellers announce on exactly one
 * subnet — the one their peerId hashes to via `subnetOf`. Buyers query all
 * subnets in parallel inside `PeerLookup.findAll()`.
 */
export function subnetTopic(index: number): string {
  return `antseed:subnet:${index}`;
}

/**
 * Per-peer topic that the announcer registers under so callers can look
 * up a single peer by its peerId without scanning the wildcard. Buyers do
 * `dht.lookup(topicToInfoHash(peerTopic(peerId)))` to get the peer's
 * signaling endpoint(s) directly. The peerId is normalized to lowercase
 * hex (no `0x`); validation is the caller's responsibility.
 */
export function peerTopic(peerId: string): string {
  return "antseed:peer:" + peerId.trim().toLowerCase().replace(/^0x/, "");
}

export function capabilityTopic(capability: string, name?: string): string {
  const base = "antseed:" + normalizeTopicSegment(capability);
  return name ? base + ":" + normalizeTopicSegment(name) : base;
}

export class DHTNode {
  private readonly config: DHTNodeConfig;
  private dht: DHT | null = null;
  public readonly events: EventEmitter = new EventEmitter();

  constructor(config: DHTNodeConfig) {
    this.config = config;
  }

  private async resolveBootstrap(): Promise<string[]> {
    const lookup: NonNullable<DHTNodeConfig["lookup"]> = this.config.lookup ?? lookupHost;
    const resolved = await Promise.all(this.config.bootstrapNodes.map(async ({ host, port }) => {
      const family = isIP(host);
      if (family === 4) return [`${host}:${port}`];
      if (family === 6) return [];
      try {
        // k-rpc-socket uses UDP4, but its hostname lookup can return DNS64 IPv6.
        const answers = await lookup(host, { family: 4, all: true });
        return answers
          .filter(({ address }) => isIP(address) === 4)
          .map(({ address }) => `${address}:${port}`);
      } catch (err) {
        debugWarn(`[DHTNode] Failed to resolve bootstrap ${host}: ${String(err)}`);
        return [];
      }
    }));
    return [...new Set(resolved.flat())];
  }

  async start(): Promise<void> {
    const bootstrap = await this.resolveBootstrap();
    return new Promise<void>((resolve, reject) => {
      this.dht = new DHT({
        bootstrap,
      });

      const timeout = setTimeout(() => {
        // Resolve even on timeout — the DHT may still work with partial bootstrap.
        // This prevents hanging when public bootstrap nodes are unreachable.
        cleanup();
        this.events.emit("ready");
        resolve();
      }, this.config.operationTimeoutMs);

      let settled = false;
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
      };

      this.dht.listen(this.config.port, () => {
        // Socket is bound; now wait for DHT bootstrap to complete.
        // The 'ready' event fires when the routing table has been populated.
        this.dht!.on("ready", () => {
          cleanup();
          this.events.emit("ready");
          resolve();
        });
      });

      this.dht.on("error", (err: Error) => {
        cleanup();
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.dht) {
        resolve();
        return;
      }
      this.dht.destroy(() => {
        this.dht = null;
        resolve();
      });
    });
  }

  async announce(infoHash: Buffer, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.dht) {
        reject(new Error("DHT not started"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error("Announce timeout"));
      }, this.config.operationTimeoutMs);

      this.dht.announce(infoHash, port, (err?: Error) => {
        clearTimeout(timeout);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  async lookup(infoHash: Buffer): Promise<DHTPeerEndpoint[]> {
    return this.lookupMany([infoHash]);
  }

  /**
   * Look up multiple infohashes concurrently while sharing one temporary
   * bittorrent-dht "peer" listener. Calling `lookup()` N times in parallel
   * attaches N listeners to the same EventEmitter and trips Node's default
   * listener warning once subnet fan-out exceeds 10 topics.
   */
  async lookupMany(infoHashes: Buffer[]): Promise<DHTPeerEndpoint[]> {
    return new Promise<DHTPeerEndpoint[]>((resolve) => {
      if (!this.dht) {
        resolve([]);
        return;
      }
      if (infoHashes.length === 0) {
        resolve([]);
        return;
      }

      const wantedHashes = new Set(infoHashes.map((hash) => hash.toString("hex")));
      const peers: DHTPeerEndpoint[] = [];
      let pending = infoHashes.length;
      let done = false;

      const onPeer = (peer: { host: string; port: number }, hash: Buffer): void => {
        if (!wantedHashes.has(hash.toString("hex"))) return;
        if (peer.port < 1 || peer.port > 65535) return;
        if (!this.config.allowPrivateIPs && !isPublicIP(peer.host)) return;
        peers.push({ host: peer.host, port: peer.port });
      };

      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.dht?.off("peer", onPeer);
        resolve(peers);
      };

      this.dht.on("peer", onPeer);

      const timeout = setTimeout(() => {
        finish();
      }, this.config.operationTimeoutMs);

      for (const infoHash of infoHashes) {
        this.dht.lookup(infoHash, () => {
          pending -= 1;
          if (pending === 0) finish();
        });
      }
    });
  }

  getNodeCount(): number {
    if (!this.dht) {
      return 0;
    }
    return this.dht.nodes.toArray().length;
  }

  getPort(): number {
    if (!this.dht) {
      return this.config.port;
    }
    try {
      const addr = this.dht.address();
      return addr?.port ?? this.config.port;
    } catch {
      return this.config.port;
    }
  }
}
