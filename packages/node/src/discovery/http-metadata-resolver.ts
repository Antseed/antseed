import type { PeerEndpoint, MetadataResolver } from './metadata-resolver.js';
import { METADATA_VERSION, METADATA_VERSION_HEADER, type PeerMetadata } from './peer-metadata.js';
import { debugLog, debugWarn } from '../utils/debug.js';

export const MAX_METADATA_HTTP_RESPONSE_SIZE = 256 * 1024;

export interface HttpMetadataResolverConfig {
  /** Timeout in ms for each metadata fetch. Default: 1500 */
  timeoutMs?: number;
  /** Port offset from the signaling port to the metadata HTTP port. Default: 0 (same port) */
  metadataPortOffset?: number;
  /** Cooldown in ms before retrying an endpoint that recently failed. Default: 30000 */
  failureCooldownMs?: number;
  /** Upper bound for failure cooldown backoff. Default: 1800000 (30 minutes) */
  maxFailureCooldownMs?: number;
  /**
   * Upper bound on how long an announcing endpoint is skipped before a recovery
   * probe. Default: 120000 (2 minutes). Set to 0 to only use exponential
   * cooldowns.
   */
  recoveryProbeIntervalMs?: number;
  /** Maximum concurrent metadata fetches. Default: 24 */
  maxConcurrent?: number;
  /** Maximum metadata HTTP response size in bytes. Default: 262144 */
  maxResponseBytes?: number;
}

type FailedEndpointState = {
  nextRetryAt: number;
  nextProbeAt: number;
  consecutiveFailures: number;
}

export class HttpMetadataResolver implements MetadataResolver {
  private readonly timeoutMs: number;
  private readonly metadataPortOffset: number;
  private readonly failureCooldownMs: number;
  private readonly maxFailureCooldownMs: number;
  private readonly recoveryProbeIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly maxResponseBytes: number;
  private readonly failedEndpoints: Map<string, FailedEndpointState>;
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(config?: HttpMetadataResolverConfig) {
    this.timeoutMs = config?.timeoutMs ?? 1500;
    this.metadataPortOffset = config?.metadataPortOffset ?? 0;
    this.failureCooldownMs = Math.max(0, config?.failureCooldownMs ?? 30_000);
    this.maxFailureCooldownMs = Math.max(
      this.failureCooldownMs,
      config?.maxFailureCooldownMs ?? 30 * 60_000,
    );
    this.recoveryProbeIntervalMs = Math.max(0, config?.recoveryProbeIntervalMs ?? 2 * 60_000);
    this.maxConcurrent = Math.max(1, config?.maxConcurrent ?? 24);
    this.maxResponseBytes = Math.max(1, config?.maxResponseBytes ?? MAX_METADATA_HTTP_RESPONSE_SIZE);
    this.failedEndpoints = new Map<string, FailedEndpointState>();
  }

  async resolve(peer: PeerEndpoint): Promise<PeerMetadata | null> {
    const metadataPort = peer.port + this.metadataPortOffset;
    const host = peer.host.toLowerCase();
    const endpointKey = this.getEndpointKey(host, metadataPort);
    const now = Date.now();

    const failedState = this.failedEndpoints.get(endpointKey);
    if (failedState !== undefined) {
      if (failedState.nextRetryAt > now) {
        if (failedState.nextProbeAt > now) {
          debugLog(
            `[MetadataResolver] Skipping ${endpointKey}: failure cooldown `
            + `${failedState.nextRetryAt - now}ms remaining after `
            + `${failedState.consecutiveFailures} failure(s); recovery probe in `
            + `${failedState.nextProbeAt - now}ms`,
          );
          return null;
        }
        debugLog(
          `[MetadataResolver] Probing ${endpointKey} during failure cooldown `
          + `${failedState.nextRetryAt - now}ms remaining after `
          + `${failedState.consecutiveFailures} failure(s)`,
        );
      }
    }

    const url = `http://${peer.host}:${metadataPort}/metadata`;

    await this.acquireSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Ask for the newest metadata version this build understands; sellers
      // that predate negotiation ignore the header and send v12.
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { [METADATA_VERSION_HEADER]: String(METADATA_VERSION) },
      });

      if (!response.ok) {
        this.markEndpointFailure(endpointKey);
        debugWarn(`[MetadataResolver] Failed to resolve ${url}: HTTP ${response.status}`);
        return null;
      }

      const body = await readResponseBodyWithLimit(response, this.maxResponseBytes);
      const metadata = JSON.parse(body) as PeerMetadata;
      const resolvedAtMs = Date.now();
      metadata.resolvedAtMs = resolvedAtMs;
      const serverDateHeader = response.headers.get('date');
      const serverDateMs = serverDateHeader ? Date.parse(serverDateHeader) : NaN;
      if (Number.isFinite(serverDateMs)) {
        metadata.serverDateMs = serverDateMs;
      }
      this.failedEndpoints.delete(endpointKey);
      debugLog(
        `[MetadataResolver] Resolved ${url}: peerId=${metadata.peerId?.slice(0, 12) ?? 'unknown'}... `
        + `displayName=${JSON.stringify(metadata.displayName ?? null)} `
        + `providers=${metadata.providers?.length ?? 0} `
        + `ageMs=${typeof metadata.timestamp === 'number' ? resolvedAtMs - metadata.timestamp : 'unknown'} `
        + `serverAgeMs=${typeof metadata.timestamp === 'number' && metadata.serverDateMs !== undefined ? metadata.serverDateMs - metadata.timestamp : 'unknown'} `
        + `clientServerSkewMs=${metadata.serverDateMs !== undefined ? resolvedAtMs - metadata.serverDateMs : 'unknown'}`,
      );
      return metadata;
    } catch (err) {
      this.markEndpointFailure(endpointKey);
      const reason = err instanceof DOMException && err.name === 'AbortError'
        ? 'timeout'
        : err instanceof SyntaxError
          ? 'invalid JSON'
          : err instanceof RangeError
            ? err.message
            : 'network error';
      debugWarn(`[MetadataResolver] Failed to resolve ${url}: ${reason}`);
      return null;
    } finally {
      clearTimeout(timeout);
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.activeCount += 1;
  }

  private releaseSlot(): void {
    if (this.activeCount > 0) {
      this.activeCount -= 1;
    }
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  private markEndpointFailure(endpointKey: string): void {
    if (this.failureCooldownMs <= 0) {
      return;
    }
    const previous = this.failedEndpoints.get(endpointKey);
    const consecutiveFailures = Math.max(1, (previous?.consecutiveFailures ?? 0) + 1);
    const multiplier = 2 ** Math.max(0, consecutiveFailures - 1);
    const backoffMs = Math.min(this.maxFailureCooldownMs, this.failureCooldownMs * multiplier);
    const probeMs = this.recoveryProbeIntervalMs > 0
      ? Math.min(backoffMs, this.recoveryProbeIntervalMs)
      : backoffMs;
    const now = Date.now();
    this.failedEndpoints.set(endpointKey, {
      nextRetryAt: now + backoffMs,
      nextProbeAt: now + probeMs,
      consecutiveFailures,
    });
  }

  private getEndpointKey(host: string, port: number): string {
    return `${host}:${port}`;
  }
}

async function readResponseBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RangeError(`metadata response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new RangeError(`metadata response exceeds ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new RangeError(`metadata response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
