import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import type { BuyerPeerView } from './interfaces.js';

/**
 * Buyer-side hook for colony pools (docs/protocol/colony-pool.md). Requests
 * for a service a seller's colony-pool provider offers are encrypted to a
 * few of its workers; the seller's other services are untouched. The crypto lives
 * in @antseed/node so this package stays free of Node-only modules.
 */

export const WORKER_E2E_CAPABILITY = 'colony-pool-e2e.v2';
/** Free control route that assigns a worker; body `{ "model": <service> }`. */
export const WORKER_ASSIGN_PATH = '/_antseed/provider/colony-pool/assign';
/** Status and error code a pool answers when the worker a request names cannot take it. */
export const WORKER_UNAVAILABLE_STATUS = 421;
export const WORKER_UNAVAILABLE_CODE = 'worker_unavailable';

export interface SealedWorkerRequest {
  /** Workers the request is encrypted for, in the order the pool tries them. */
  recipients: string[];
  /** The recipient whose sealed answer opened (null until one did). Only it is paid. */
  readonly worker: string | null;
  /** The request as sent on the wire. */
  request: SerializedHttpRequest;
  /** Decrypt a complete body; bodies the pool itself answered pass through. Throws on tampering. */
  openBody(body: Uint8Array): Uint8Array;
  /** Decrypt streamed bytes into plaintext SSE. Throws on tampering. */
  pushStream(chunk: Uint8Array): Uint8Array;
  /** True once the worker's end marker verified. */
  readonly verified: boolean;
  /** False when the usage the pool showed in the clear (what it bills) differs from the worker's sealed usage. */
  readonly usageConsistent: boolean;
  /** Token counts inside the worker's ciphertext (zero when it reported none). */
  readonly usage: WorkerUsage;
}

/** Token counts a worker authenticated inside its sealed answer. */
export interface WorkerUsage {
  /** Prompt tokens, cached ones included. */
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
}

export interface WorkerE2EClient {
  /**
   * Encrypt `request` for the workers assigned to this seller and service
   * (the pool's top-ranked few), asking the seller through `assign` when
   * none are cached.
   */
  seal(
    peer: BuyerPeerView,
    request: SerializedHttpRequest,
    service: string,
    assign: (body: Uint8Array) => Promise<SerializedHttpResponse>,
    channelId: string | null,
  ): Promise<SealedWorkerRequest>;
  /** Drop a cached assignment (the pool said none of its workers could take the request). */
  forget(peerId: string, service: string): void;
  /**
   * Whether a request none of its workers could take is encrypted again for
   * new workers. Off when each request is meant for a single worker: a worker
   * that failed may already have read it, so it is not shown to another.
   */
  readonly failover: boolean;
}

/**
 * The peer capability a seller announces for each colony-pool provider
 * (`colony-pool-e2e.v2.<provider>`), next to WORKER_E2E_CAPABILITY, so buyers
 * encrypt only that provider's services.
 */
export function workerE2EProviderCapability(provider: string): string {
  return `${WORKER_E2E_CAPABILITY}.${provider.toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`;
}

/** True when the seller announces any colony-pool provider: its payment claims must name requests the buyer sent it. */
export function peerAnnouncesWorkerE2E(peer: BuyerPeerView): boolean {
  return (peer.capabilities ?? []).includes(WORKER_E2E_CAPABILITY);
}

/** True when the peer announces `provider` as a colony-pool provider. */
export function isWorkerE2EProvider(peer: BuyerPeerView, provider: string): boolean {
  return workerProviders(peer)(provider);
}

function workerProviders(peer: BuyerPeerView): (provider: string) => boolean {
  const capabilities = new Set(peer.capabilities ?? []);
  return (provider) => capabilities.has(workerE2EProviderCapability(provider));
}

/** Where a request to a peer is routed, as the buyer resolved it. */
export interface WorkerE2ERoute {
  /** The provider the request names itself (`x-antseed-provider`), before the buyer adds one. */
  explicitProvider?: string | null;
  /** The provider the buyer's billing route resolved for the service (null when none offers it). */
  routedProvider?: string | null;
}

/**
 * True when a request on this peer, routed as `route` says, must be
 * encrypted to a worker. Plaintext is only for a request the buyer resolved to an ordinary
 * provider, because a pool must never see a prompt in the clear:
 * - a request that names a colony-pool provider is encrypted, whatever the
 *   buyer's metadata says the provider offers (pools gain models as workers
 *   join, so it may be stale);
 * - a request that names an ordinary provider stays plaintext only when that
 *   provider offers the service. Otherwise the seller would serve it through
 *   another provider, possibly its pool;
 * - without a named provider, the resolved provider decides, and a service no
 *   provider announces is encrypted, since the seller could route it to its pool.
 */
export function peerServiceUsesWorkerE2E(peer: BuyerPeerView, route: WorkerE2ERoute = {}): boolean {
  if (!peerAnnouncesWorkerE2E(peer)) return false;
  const isWorkerProvider = workerProviders(peer);
  const explicit = route.explicitProvider?.trim().toLowerCase() || null;
  const routed = route.routedProvider ?? null;
  if (explicit && isWorkerProvider(explicit)) return true;
  if (!routed) return true;
  if (explicit && routed.toLowerCase() !== explicit) return true;
  return isWorkerProvider(routed);
}

export function isWorkerUnavailable(response: SerializedHttpResponse): boolean {
  if (response.statusCode !== WORKER_UNAVAILABLE_STATUS) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as { error?: { code?: unknown } };
    return parsed.error?.code === WORKER_UNAVAILABLE_CODE;
  } catch {
    return false;
  }
}
