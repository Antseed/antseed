import type { SerializedHttpRequest, SerializedHttpResponse } from '@antseed/protocol/http';
import type { BuyerPeerView } from './interfaces.js';

/**
 * Buyer-side hook for colony pools (docs/protocol/colony-pool.md). Sellers
 * advertising WORKER_E2E_CAPABILITY get requests encrypted to one of their
 * workers. The crypto lives in @antseed/node so this package stays free of
 * Node-only modules.
 */

export const WORKER_E2E_CAPABILITY = 'colony-pool-e2e.v2';
/** Free control route that assigns a worker; body `{ "model": <service> }`. */
export const WORKER_ASSIGN_PATH = '/_antseed/provider/colony-pool/assign';
/** Status and error code a pool answers when the worker a request names cannot take it. */
export const WORKER_UNAVAILABLE_STATUS = 421;
export const WORKER_UNAVAILABLE_CODE = 'worker_unavailable';

export interface SealedWorkerRequest {
  /** Worker the request is encrypted for. */
  worker: string;
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
}

export interface WorkerE2EClient {
  /**
   * Encrypt `request` for the worker assigned to this seller and service,
   * asking the seller for one through `assign` when none is cached.
   */
  seal(
    peer: BuyerPeerView,
    request: SerializedHttpRequest,
    service: string,
    assign: (body: Uint8Array) => Promise<SerializedHttpResponse>,
    channelId: string | null,
  ): Promise<SealedWorkerRequest>;
  /** Drop a cached assignment (the pool said its worker is unavailable). */
  forget(peerId: string, service: string): void;
}

export function peerSupportsWorkerE2E(peer: BuyerPeerView): boolean {
  return (peer.capabilities ?? []).includes(WORKER_E2E_CAPABILITY);
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
