import DHT from "bittorrent-dht";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lookup as lookupHost } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  /** Local address to bind the DHT UDP socket to. Default: all interfaces. */
  bindHost?: string;
  /**
   * How long this node keeps a peer another node announced to it, in ms.
   * Default: {@link DEFAULT_PEER_RECORD_MAX_AGE_MS}.
   */
  peerRecordMaxAgeMs?: number;
  /**
   * File where this node saves a few of the DHT nodes it knows, after lookups
   * and announces and on stop, and from which it adds them to `bootstrapNodes`
   * on its next start. It can then rejoin while the bootstrap nodes are down.
   * Unset: nothing is saved or read.
   */
  knownNodesFile?: string;
  /**
   * Nodes to join through only while this node knows no DHT node at all, after
   * `bootstrapNodes` and the saved nodes went unanswered, for example the public
   * BitTorrent DHT routers. Unset: no fallback.
   */
  fallbackBootstrapNodes?: Array<{ host: string; port: number }>;
}

/**
 * bittorrent-dht keeps announced peers forever unless given a `maxAge`, and
 * answers each get_peers with at most 100 random stored peers. Every peer that
 * ever announced a topic (restarted sellers, changed IPs and ports) would stay
 * listed next to the live ones, so lookups return mostly dead endpoints and can
 * miss live sellers. A record lives 0.67–1.33 × maxAge after its last announce,
 * so 30 min keeps peers that reannounce every 15 min (releases before the
 * 5-min interval) listed while dropping a gone peer within 20–40 min.
 */
export const DEFAULT_PEER_RECORD_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Most saved nodes added to the bootstrap list on start. During a lookup k-rpc
 * also queries every bootstrap entry whenever the routing table offers fewer
 * nodes near the target than the bootstrap list is long, and it offers at most
 * K = 20. With 16 saved nodes and the two official ones the list stays under K,
 * so a node with a healthy routing table never queries them.
 */
export const MAX_KNOWN_NODES = 16;
/** Least time between two saves of the known-nodes file after lookups and announces. */
const KNOWN_NODES_SAVE_INTERVAL_MS = 60_000;
/** Least time between two tries to join through the fallback nodes. */
const FALLBACK_RETRY_INTERVAL_MS = 5 * 60_000;
/** Longest a start, lookup or announce waits for a fallback node to answer. */
const FALLBACK_JOIN_WAIT_MS = 5_000;

export const DEFAULT_DHT_CONFIG: Omit<DHTNodeConfig, "peerId"> = {
  port: 6881,
  bootstrapNodes: toBootstrapConfig(OFFICIAL_BOOTSTRAP_NODES),
  // 5 min — short enough that a missed reannounce is recovered well before
  // storage nodes expire the record (DEFAULT_PEER_RECORD_MAX_AGE_MS here,
  // ~30 min on most BEP-5 nodes). Used to be 15 min, which sat right at the
  // edge and caused intermittent visibility gaps.
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

function endpointKey({ host, port }: DHTPeerEndpoint): string {
  return `${host}:${port}`;
}

function parseEndpoint(value: unknown): DHTPeerEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const { host, port } = value as { host?: unknown; port?: unknown };
  if (typeof host !== "string" || isIP(host) !== 4) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Picks up to `max` valid IPv4 nodes, spread evenly over the list. A routing
 * table lists its nodes bucket by bucket, so the pick spans the ID space
 * instead of one corner of it.
 */
export function pickKnownNodes(
  nodes: readonly unknown[],
  options: { exclude?: ReadonlySet<string>; allowPrivateIPs?: boolean; max?: number } = {},
): DHTPeerEndpoint[] {
  const max = options.max ?? MAX_KNOWN_NODES;
  const unique = new Map<string, DHTPeerEndpoint>();
  for (const value of nodes) {
    const node = parseEndpoint(value);
    if (!node) continue;
    const key = endpointKey(node);
    if (options.exclude?.has(key)) continue;
    if (!options.allowPrivateIPs && !isPublicIP(node.host)) continue;
    unique.set(key, node);
  }
  const candidates = [...unique.values()];
  if (candidates.length <= max) return candidates;
  const step = candidates.length / max;
  return Array.from({ length: max }, (_, i) => candidates[Math.floor(i * step)]!);
}

async function writeFileAtomic(file: string, body: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file);
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

/**
 * The topics every seller announces under, before its offering topics:
 *   - its subnet topic, which shards the peer set across SUBNET_COUNT infohashes so no single
 *     one carries every announcer (buyers fan out lookups across all subnets);
 *   - the wildcard, kept during the transition so older buyers still on the single-infohash scan
 *     find it (see SUBNET_COUNT);
 *   - its per-peer topic, for a lookup by peerId.
 */
export function sellerTopics(peerId: string): string[] {
  return [subnetTopic(subnetOf(peerId)), ANTSEED_WILDCARD_TOPIC, peerTopic(peerId)];
}

export function capabilityTopic(capability: string, name?: string): string {
  const base = "antseed:" + normalizeTopicSegment(capability);
  return name ? base + ":" + normalizeTopicSegment(name) : base;
}

export class DHTNode {
  private readonly config: DHTNodeConfig;
  private dht: DHT | null = null;
  public readonly events: EventEmitter = new EventEmitter();
  /** Resolved `bootstrapNodes` and fallback nodes, never saved as known nodes. */
  private readonly unsavedEndpoints = new Set<string>();
  private lastKnownNodesSaveAt = 0;
  private knownNodesWrite: Promise<void> = Promise.resolve();
  private lastFallbackJoinAt = 0;
  private fallbackJoin: Promise<void> | null = null;

  constructor(config: DHTNodeConfig) {
    this.config = config;
  }

  private async resolveEndpoints(nodes: ReadonlyArray<{ host: string; port: number }>): Promise<DHTPeerEndpoint[]> {
    const lookup: NonNullable<DHTNodeConfig["lookup"]> = this.config.lookup ?? lookupHost;
    const resolved = await Promise.all(nodes.map(async ({ host, port }): Promise<DHTPeerEndpoint[]> => {
      const family = isIP(host);
      if (family === 4) return [{ host, port }];
      if (family === 6) return [];
      try {
        // k-rpc-socket uses UDP4, but its hostname lookup can return DNS64 IPv6.
        const answers = await lookup(host, { family: 4, all: true });
        return answers
          .filter(({ address }) => isIP(address) === 4)
          .map(({ address }) => ({ host: address, port }));
      } catch (err) {
        debugWarn(`[DHTNode] Failed to resolve bootstrap ${host}: ${String(err)}`);
        return [];
      }
    }));
    const unique = new Map<string, DHTPeerEndpoint>();
    for (const endpoint of resolved.flat()) unique.set(endpointKey(endpoint), endpoint);
    return [...unique.values()];
  }

  private async readKnownNodes(): Promise<DHTPeerEndpoint[]> {
    const file = this.config.knownNodesFile;
    if (!file) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        debugWarn(`[DHTNode] Ignoring known DHT nodes file ${file}: ${String(err)}`);
      }
      return [];
    }
    const nodes = (parsed as { nodes?: unknown } | null)?.nodes;
    if (!Array.isArray(nodes)) return [];
    return pickKnownNodes(nodes, { exclude: this.unsavedEndpoints, allowPrivateIPs: this.config.allowPrivateIPs });
  }

  /**
   * Saves up to MAX_KNOWN_NODES routing-table nodes to `knownNodesFile`, after
   * any save still running. With an empty routing table it keeps the file, so
   * a run that never connected doesn't erase what a connected run saved.
   */
  private saveKnownNodes(): Promise<void> {
    const file = this.config.knownNodesFile;
    if (!file || !this.dht) return this.knownNodesWrite;
    this.lastKnownNodesSaveAt = Date.now();
    const nodes = pickKnownNodes(this.dht.toJSON().nodes, {
      exclude: this.unsavedEndpoints,
      allowPrivateIPs: this.config.allowPrivateIPs,
    });
    if (nodes.length === 0) return this.knownNodesWrite;
    const body = `${JSON.stringify({ savedAt: new Date().toISOString(), nodes })}\n`;
    this.knownNodesWrite = this.knownNodesWrite
      .then(() => writeFileAtomic(file, body))
      .catch((err) => debugWarn(`[DHTNode] Failed to save known DHT nodes to ${file}: ${String(err)}`));
    return this.knownNodesWrite;
  }

  private saveKnownNodesSoon(): void {
    if (Date.now() - this.lastKnownNodesSaveAt < KNOWN_NODES_SAVE_INTERVAL_MS) return;
    void this.saveKnownNodes();
  }

  /**
   * Joins through `fallbackBootstrapNodes` when the routing table is empty:
   * nothing on the bootstrap list or among the saved nodes answered. Tried at
   * most every FALLBACK_RETRY_INTERVAL_MS; callers share a try in progress.
   */
  private joinFallbackIfIsolated(): Promise<void> {
    if (this.fallbackJoin) return this.fallbackJoin;
    const fallback = this.config.fallbackBootstrapNodes ?? [];
    if (!this.dht || fallback.length === 0 || this.getNodeCount() > 0) return Promise.resolve();
    if (Date.now() - this.lastFallbackJoinAt < FALLBACK_RETRY_INTERVAL_MS) return Promise.resolve();
    this.lastFallbackJoinAt = Date.now();
    this.fallbackJoin = this.joinFallback(fallback).finally(() => {
      this.fallbackJoin = null;
    });
    return this.fallbackJoin;
  }

  private async joinFallback(fallback: ReadonlyArray<{ host: string; port: number }>): Promise<void> {
    const endpoints = await this.resolveEndpoints(fallback);
    const dht = this.dht;
    if (!dht || endpoints.length === 0) return;
    for (const endpoint of endpoints) this.unsavedEndpoints.add(endpointKey(endpoint));
    debugWarn(`[DHTNode] No DHT node answered; joining through ${endpoints.length} fallback node(s)`);
    // A node that answers the ping enters the routing table; the next lookup
    // walks on from it. Wait for the first answer, or give up after a few seconds.
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        dht.off("node", finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(FALLBACK_JOIN_WAIT_MS, this.config.operationTimeoutMs));
      dht.on("node", finish);
      for (const endpoint of endpoints) dht.addNode(endpoint);
    });
  }

  async start(): Promise<void> {
    const configured = await this.resolveEndpoints(this.config.bootstrapNodes);
    if (configured.length === 0 && this.config.bootstrapNodes.length > 0) {
      debugWarn(`[DHTNode] No IPv4 bootstrap addresses resolved from ${this.config.bootstrapNodes.length} configured node(s)`);
    }
    for (const endpoint of configured) this.unsavedEndpoints.add(endpointKey(endpoint));
    const saved = await this.readKnownNodes();
    await this.listen([...configured, ...saved].map(endpointKey));
    await this.joinFallbackIfIsolated();
  }

  private listen(bootstrap: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.dht = new DHT({
        bootstrap,
        maxAge: this.config.peerRecordMaxAgeMs ?? DEFAULT_PEER_RECORD_MAX_AGE_MS,
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

      const onListening = (): void => {
        // Socket is bound; now wait for DHT bootstrap to complete.
        // The 'ready' event fires when the routing table has been populated.
        this.dht!.on("ready", () => {
          cleanup();
          this.events.emit("ready");
          resolve();
        });
      };
      if (this.config.bindHost) {
        this.dht.listen(this.config.port, this.config.bindHost, onListening);
      } else {
        this.dht.listen(this.config.port, onListening);
      }

      this.dht.on("error", (err: Error) => {
        cleanup();
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    await this.saveKnownNodes();
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
    await this.joinFallbackIfIsolated();
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
          this.saveKnownNodesSoon();
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
    if (infoHashes.length > 0) await this.joinFallbackIfIsolated();
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
        this.saveKnownNodesSoon();
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

  /** Local address the DHT socket is bound to (null before start). */
  getAddress(): string | null {
    try {
      return this.dht?.address()?.address ?? null;
    } catch {
      return null;
    }
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
