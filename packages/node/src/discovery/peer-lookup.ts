import { verifySignature, hexToBytes } from "../p2p/identity.js";
import type { DHTNode } from "./dht-node.js";
import {
  ANTSEED_WILDCARD_TOPIC,
  capabilityTopic,
  peerTopic,
  subnetTopic,
  SUBNET_COUNT,
  topicToInfoHash,
} from "./dht-node.js";
import type { PeerMetadata } from "./peer-metadata.js";
import { encodeMetadataForSigning } from "./metadata-codec.js";
import type { MetadataResolver, PeerEndpoint } from "./metadata-resolver.js";
import { validateMetadata } from "./metadata-validator.js";
import { debugLog, debugWarn } from "../utils/debug.js";

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface LookupConfig {
  dht: DHTNode;
  metadataResolver: MetadataResolver;
  requireValidSignature: boolean;
  allowStaleMetadata: boolean;
  maxAnnouncementAgeMs: number;
  /**
   * Maximum tolerated difference between the buyer's wall clock and the HTTP
   * Date header returned by the seller metadata endpoint. When the skew exceeds
   * this value, freshness checks use the seller's HTTP Date header instead of
   * the buyer's local clock so misconfigured desktops can still discover peers.
   */
  maxClientServerClockSkewMs: number;
  maxResults: number;
  /**
   * Optional foreground DHT budget for findAll(). Each individual lookup still
   * gets the DHT's full operation timeout; the budget only controls how many
   * subnet shards we attempt before returning the peers already found.
   */
  maxFindAllDhtDurationMs?: number;
}

export const DEFAULT_LOOKUP_CONFIG: Omit<LookupConfig, "dht" | "metadataResolver"> = {
  requireValidSignature: true,
  allowStaleMetadata: false,
  maxAnnouncementAgeMs: 30 * 60 * 1000,
  // Some desktops have wall clocks hours ahead/behind real UTC. Metadata HTTP
  // responses include a seller-side Date header; if buyer-vs-seller clock skew
  // is larger than this, trust the seller Date for freshness instead.
  maxClientServerClockSkewMs: 5 * 60 * 1000,
  // Old cap was 50, then 200; with subnet fan-out and larger live networks,
  // keep browse/discovery truncation comfortably above current scale while
  // still bounding downstream enrichment/rendering work.
  maxResults: 1000,
  // Do not make buyer startup wait for every empty shard in the foreground.
  // A shard we do run still gets the full DHT operation timeout, but the
  // sweep can resume from the next shard on the next refresh.
  maxFindAllDhtDurationMs: 20_000,
};

export interface LookupResult {
  metadata: PeerMetadata;
  host: string;
  port: number;
}

export interface LookupPartialContext {
  mode: "foreground" | "background";
  phase: "wildcard" | "subnet";
  subnet?: number;
  endpointCount: number;
}

export type LookupPartialCallback = (
  results: LookupResult[],
  context: LookupPartialContext,
) => void | Promise<void>;

type ResolveLookupResultsOptions = {
  metadataPeerId?: string;
  maxResults?: number;
  onResult?: (result: LookupResult) => void | Promise<void>;
};

/**
 * Collapse lookup results to one per peerId, keeping the newest signed
 * announcement (highest `metadata.timestamp`). A seller that moved hosts can
 * still be advertised from its previous endpoints for a while; resolution
 * order is random, so "first one wins" would let an older announcement shadow
 * the current one. Output keeps the order in which each peerId first appeared.
 */
export function preferFreshestResultPerPeer(results: LookupResult[]): LookupResult[] {
  const best = new Map<string, LookupResult>();
  for (const result of results) {
    const peerId = result.metadata.peerId.toLowerCase();
    const current = best.get(peerId);
    if (!current || result.metadata.timestamp > current.metadata.timestamp) {
      best.set(peerId, result);
    }
  }
  return [...best.values()];
}

export class PeerLookup {
  private readonly config: LookupConfig;
  private nextSubnetStart = 0;

  constructor(config: LookupConfig) {
    this.config = config;
  }

  /**
   * Enumerate every peer on the network.
   *
   * The lookup runs in two stages, sequentially:
   *
   *   1. Wildcard topic, alone. Its broad reach pulls many peers and warms
   *      the local DHT routing table with nodes that already know about
   *      AntSeed traffic.
   *   2. Each subnet topic, one at a time, against that hot routing table.
   *      Each subnet only holds ~total/SUBNET_COUNT announcers, which keeps
   *      us well under the K-closest saturation limit that made the single
   *      wildcard topic return inconsistent subsets at scale.
   *
   * Why sequential: firing all shard lookups together through one UDP socket
   * gave us lower wall-clock but worse completeness. Buyers need to give a
   * shard lookup enough time to converge and drain its peer events, so every
   * shard we do run gets a full lookup slot.
   *
   * Startup still should not block on all 16 shards when most of them are
   * empty. If `maxFindAllDhtDurationMs` is configured, `findAll()` walks
   * shards in a rotating order and stops after the foreground budget is
   * exhausted; the next refresh resumes from the next shard. This preserves
   * per-shard quality without forcing every buyer startup to pay the full
   * network-wide sweep cost.
   *
   * `resolveLookupResults` deduplicates by `host:port` before resolving
   * metadata, so the union still only incurs one metadata fetch per endpoint.
   */
  async findAll(): Promise<LookupResult[]> {
    return this.findAllWithDhtBudget(this.config.maxFindAllDhtDurationMs, "foreground");
  }

  /**
   * Complete a full sequential wildcard+subnet sweep. Intended for background
   * catch-up after a fast foreground discovery has already populated the UI.
   *
   * When `onPartial` is provided, each accepted metadata result is emitted as
   * soon as it settles instead of making callers wait for every endpoint in a
   * shard to resolve or timeout. This keeps the buyer catalog moving while the
   * exhaustive sweep is still walking later shards.
   */
  async findAllExhaustive(onPartial?: LookupPartialCallback): Promise<LookupResult[]> {
    return this.findAllWithDhtBudget(undefined, "background", onPartial);
  }

  private async findAllWithDhtBudget(
    maxDhtDurationMs: number | undefined,
    mode: "foreground" | "background",
    onPartial?: LookupPartialCallback,
  ): Promise<LookupResult[]> {
    const merged: PeerEndpoint[] = [];
    const partialResults: LookupResult[] = [];
    const sweepStartedAt = Date.now();

    // Stage 1: wildcard, on its own. Warm the routing table.
    const wildcardStartedAt = Date.now();
    debugLog(`[PeerLookup] ${mode}: wildcard lookup starting`);
    const wildcardEndpoints = await this.config.dht.lookup(
      topicToInfoHash(ANTSEED_WILDCARD_TOPIC),
    );
    debugLog(
      `[PeerLookup] ${mode}: wildcard lookup returned ${wildcardEndpoints.length} endpoint(s) `
      + `in ${Date.now() - wildcardStartedAt}ms`,
    );
    merged.push(...wildcardEndpoints);
    if (onPartial && wildcardEndpoints.length > 0) {
      const context: LookupPartialContext = {
        mode,
        phase: "wildcard",
        endpointCount: wildcardEndpoints.length,
      };
      await this.resolveLookupResults(shuffle(wildcardEndpoints), {
        onResult: async (result) => {
          partialResults.push(result);
          await onPartial([result], context);
        },
      });
    }

    // Stage 2: per-subnet, sequential. Each lookup gets the full operation
    // timeout and exclusive use of the UDP socket. Rotate the start shard so
    // budgeted foreground scans eventually cover the whole shard ring.
    const startedAt = Date.now();
    const start = this.nextSubnetStart;
    let nextStart = start;
    for (let offset = 0; offset < SUBNET_COUNT; offset++) {
      if (
        offset > 0
        && maxDhtDurationMs !== undefined
        && Date.now() - startedAt >= maxDhtDurationMs
      ) {
        break;
      }

      const subnet = (start + offset) % SUBNET_COUNT;
      const subnetStartedAt = Date.now();
      debugLog(`[PeerLookup] ${mode}: subnet ${subnet}/${SUBNET_COUNT - 1} lookup starting`);
      const subnetEndpoints = await this.config.dht.lookup(
        topicToInfoHash(subnetTopic(subnet)),
      );
      debugLog(
        `[PeerLookup] ${mode}: subnet ${subnet}/${SUBNET_COUNT - 1} returned `
        + `${subnetEndpoints.length} endpoint(s) in ${Date.now() - subnetStartedAt}ms`,
      );
      merged.push(...subnetEndpoints);
      if (onPartial && subnetEndpoints.length > 0) {
        const partialStartedAt = Date.now();
        let resolvedCount = 0;
        const context: LookupPartialContext = {
          mode,
          phase: "subnet",
          subnet,
          endpointCount: subnetEndpoints.length,
        };
        await this.resolveLookupResults(shuffle(subnetEndpoints), {
          onResult: async (result) => {
            resolvedCount += 1;
            partialResults.push(result);
            await onPartial([result], context);
          },
        });
        debugLog(
          `[PeerLookup] ${mode}: subnet ${subnet}/${SUBNET_COUNT - 1} partial metadata resolved `
          + `${resolvedCount}/${subnetEndpoints.length} in ${Date.now() - partialStartedAt}ms`,
        );
      }
      nextStart = (subnet + 1) % SUBNET_COUNT;
    }
    this.nextSubnetStart = nextStart;

    if (onPartial) {
      const deduped = this.deduplicateResultsByPeerId(partialResults);
      debugLog(
        `[PeerLookup] ${mode}: emitted ${deduped.length} incremental metadata result(s) from `
        + `${merged.length} DHT endpoint(s) (total ${Date.now() - sweepStartedAt}ms)`,
      );
      return deduped;
    }

    const metadataStartedAt = Date.now();
    const resolved = await this.resolveLookupResults(shuffle(merged));
    debugLog(
      `[PeerLookup] ${mode}: resolved ${resolved.length} metadata result(s) from `
      + `${merged.length} DHT endpoint(s) in ${Date.now() - metadataStartedAt}ms `
      + `(total ${Date.now() - sweepStartedAt}ms)`,
    );
    return resolved;
  }

  private deduplicateResultsByPeerId(results: LookupResult[]): LookupResult[] {
    return preferFreshestResultPerPeer(results);
  }

  async findByCapability(capability: string, name?: string): Promise<LookupResult[]> {
    const topic = capabilityTopic(capability, name);
    const infoHash = topicToInfoHash(topic);
    const peers = await this.config.dht.lookup(infoHash);
    return this.resolveLookupResults(shuffle(peers));
  }

  /**
   * Look up a single peer by its peerId via the per-peer DHT topic
   * (`antseed:peer:<peerId>`). Returns every endpoint whose served metadata
   * actually matches the requested peerId — a remote endpoint announcing
   * the topic but serving a different peer's metadata is filtered out, so
   * a hostile peer cannot squat another peer's identity.
   *
   * The peerId is normalized to lowercase hex; passing an empty / invalid
   * id returns an empty list.
   */
  async findByPeerId(peerId: string): Promise<LookupResult[]> {
    const normalized = peerId.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(normalized)) return [];
    const infoHash = topicToInfoHash(peerTopic(normalized));
    const peers = await this.config.dht.lookup(infoHash);
    return this.resolveLookupResults(shuffle(peers), { metadataPeerId: normalized });
  }

  private async resolveLookupResults(
    peers: PeerEndpoint[],
    options?: ResolveLookupResultsOptions,
  ): Promise<LookupResult[]> {
    const maxResults = options?.maxResults ?? this.config.maxResults;
    const metadataPeerId = options?.metadataPeerId;

    // Deduplicate endpoints before firing parallel requests
    const seenEndpoints = new Set<string>();
    const uniquePeers: PeerEndpoint[] = [];
    for (const peer of peers) {
      const key = `${peer.host.toLowerCase()}:${peer.port}`;
      if (!seenEndpoints.has(key)) {
        seenEndpoints.add(key);
        uniquePeers.push(peer);
      }
    }

    debugLog(
      `[PeerLookup] Resolving metadata for ${uniquePeers.length}/${peers.length} unique endpoint(s)`,
    );
    if (uniquePeers.length > 0) {
      debugLog(
        `[PeerLookup] Metadata endpoints: ${uniquePeers.map((p) => `${p.host}:${p.port}`).join(', ')}`,
      );
    }

    // Resolve all peers in parallel — bad-port timeouts no longer block good peers.
    // When a progress callback is provided, publish accepted metadata as each
    // endpoint settles instead of waiting for every slow endpoint to timeout.
    const settled = await Promise.allSettled(
      uniquePeers.map(async (peer) => {
        const result = await this._resolveSinglePeer(peer);
        if (result === null) return null;
        if (metadataPeerId && result.metadata.peerId.toLowerCase() !== metadataPeerId) {
          return null;
        }
        if (options?.onResult) {
          await options.onResult(result);
        }
        return result;
      }),
    );

    const results: LookupResult[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value !== null) {
        results.push(r.value);
        if (results.length >= maxResults) break;
      }
    }
    return results;
  }

  private async _resolveSinglePeer(peer: PeerEndpoint): Promise<LookupResult | null> {
    const metadata = await this.config.metadataResolver.resolve(peer);
    if (metadata === null) {
      return null;
    }

    return this._validateResolvedMetadata(peer, metadata);
  }

  private async _validateResolvedMetadata(
    peer: PeerEndpoint,
    metadata: PeerMetadata,
  ): Promise<LookupResult | null> {
    const endpoint = `${peer.host}:${peer.port}`;
    const version = metadata.version;

    try {
      const schemaErrors = validateMetadata(metadata);
      if (schemaErrors.length > 0) {
        debugWarn(
          `[PeerLookup] Dropping ${version} metadata from ${endpoint}: invalid schema `
          + schemaErrors.map((error) => `${error.field}=${error.message}`).join("; "),
        );
        return null;
      }
    } catch (err) {
      debugWarn(
        `[PeerLookup] Dropping ${version} metadata from ${endpoint}: invalid schema `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    if (this.config.requireValidSignature) {
      const valid = await this.verifyMetadataSignature(metadata);
      if (!valid) {
        debugWarn(
          `[PeerLookup] Dropping ${version} metadata from ${endpoint}: invalid signature `
          + `peerId=${metadata.peerId?.slice(0, 12) ?? 'unknown'}...`,
        );
        return null;
      }
    }

    if (!this.config.allowStaleMetadata) {
      const freshness = this.getMetadataFreshness(metadata);
      if (freshness.stale) {
        debugWarn(
          `[PeerLookup] Dropping ${version} metadata from ${endpoint}: stale `
          + `ageMs=${freshness.ageMs} maxAgeMs=${this.config.maxAnnouncementAgeMs} `
          + `reference=${freshness.reference} `
          + `clientServerSkewMs=${freshness.clientServerSkewMs ?? 'unknown'} `
          + `peerId=${metadata.peerId?.slice(0, 12) ?? 'unknown'}...`,
        );
        return null;
      }
      if (freshness.clockSkewSuspected) {
        debugWarn(
          `[PeerLookup] Accepting ${version} metadata from ${endpoint} using seller HTTP Date; `
          + `client clock skew suspected clientAgeMs=${freshness.clientAgeMs} `
          + `serverAgeMs=${freshness.ageMs} `
          + `clientServerSkewMs=${freshness.clientServerSkewMs ?? 'unknown'} `
          + `maxAgeMs=${this.config.maxAnnouncementAgeMs} `
          + `peerId=${metadata.peerId?.slice(0, 12) ?? 'unknown'}...`,
        );
      }
    }

    debugLog(
      `[PeerLookup] Accepted ${version} metadata from ${endpoint}: peerId=${metadata.peerId.slice(0, 12)}... `
      + `displayName=${JSON.stringify(metadata.displayName ?? null)} `
      + `providers=${metadata.providers.length}`,
    );
    return { metadata, host: peer.host, port: peer.port };
  }

  async verifyMetadataSignature(metadata: PeerMetadata): Promise<boolean> {
    const dataToVerify = encodeMetadataForSigning(metadata);
    const signature = hexToBytes(metadata.signature);
    return verifySignature(metadata.peerId, signature, dataToVerify);
  }

  getMetadataFreshness(metadata: PeerMetadata): {
    ageMs: number;
    clientAgeMs: number;
    clientServerSkewMs?: number;
    reference: "client" | "server";
    stale: boolean;
    clockSkewSuspected: boolean;
  } {
    const clientNowMs = metadata.resolvedAtMs ?? Date.now();
    const clientAgeMs = clientNowMs - metadata.timestamp;
    const serverDateMs = metadata.serverDateMs;
    const clientServerSkewMs = serverDateMs !== undefined ? clientNowMs - serverDateMs : undefined;
    const useServerDate = (
      serverDateMs !== undefined
      && clientServerSkewMs !== undefined
      && Math.abs(clientServerSkewMs) > this.config.maxClientServerClockSkewMs
    );
    const ageMs = useServerDate ? serverDateMs - metadata.timestamp : clientAgeMs;
    return {
      ageMs,
      clientAgeMs,
      ...(clientServerSkewMs !== undefined ? { clientServerSkewMs } : {}),
      reference: useServerDate ? "server" : "client",
      stale: ageMs > this.config.maxAnnouncementAgeMs,
      clockSkewSuspected: useServerDate,
    };
  }

  isStale(metadata: PeerMetadata): boolean {
    return this.getMetadataFreshness(metadata).stale;
  }
}
