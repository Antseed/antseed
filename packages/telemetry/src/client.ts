/**
 * A product's telemetry client: one envelope, one sanitizer, one queue.
 *
 * Every event carries `schema_version`, `product`, a per-process UUIDv7
 * session id, the app version and platform. Person profiles are never
 * processed. GeoIP stays on (country level is all PostHog's project settings
 * keep) unless the product turns it off: the gateway does, because its IP is
 * the server's, not its users'.
 */
import { randomBytes } from 'node:crypto';
import { sanitizeEventProperties, type EventCatalog } from './sanitize.js';
import { BatchQueue, createPostHogSender, type PostHogEvent, type PostHogSender } from './posthog.js';
import type { PostHogConfig } from './consent.js';

export const TELEMETRY_SCHEMA_VERSION = 2;

export type TelemetryProduct = 'desktop' | 'cli' | 'gateway' | 'buyer';
export type BuyerHost = 'desktop' | 'gateway' | 'standalone';

export const BUYER_HOSTS: ReadonlySet<string> = new Set<BuyerHost>(['desktop', 'gateway', 'standalone']);

/** Env a host sets on the buyer it spawns. */
export const TELEMETRY_HOST_ENV = 'ANTSEED_TELEMETRY_HOST';
export const TELEMETRY_HOST_SESSION_ID_ENV = 'ANTSEED_TELEMETRY_HOST_SESSION_ID';

/** RFC 9562 UUIDv7. PostHog's Sessions explorer derives session start from these bits. */
export function uuidV7(timestampMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  let remaining = Math.max(0, Math.floor(timestampMs));
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The buyer's normalized EVM address, or null. Nothing else is a distinct id. */
export function normalizeDistinctId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

export function normalizeBuyerHost(value: string | undefined): BuyerHost {
  const normalized = value?.trim().toLowerCase() ?? '';
  return BUYER_HOSTS.has(normalized) ? (normalized as BuyerHost) : 'standalone';
}

export type TelemetryClientOptions = {
  product: TelemetryProduct;
  appVersion: string;
  platform?: string;
  arch?: string;
  installSource?: string;
  catalog: EventCatalog;
  getDistinctId: () => string | null;
  /** Checked on every capture and before every flush. */
  isEnabled: () => boolean;
  sender?: PostHogSender;
  posthog?: PostHogConfig | null;
  /** false sends `$geoip_disable: true`. */
  geoip: boolean;
  /** Buyer events: who started this buyer, and that host's session. */
  buyerHost?: BuyerHost;
  hostSessionId?: string | null;
  nowMs?: () => number;
  flushIntervalMs?: number;
  maxQueue?: number;
};

export type TelemetryClient = {
  readonly sessionId: string;
  /** Returns whether the event was queued. Never throws. */
  capture: (event: string, properties?: Readonly<Record<string, unknown>>, eventTsMs?: number) => boolean;
  flush: () => Promise<void>;
  /** Bounded flush for shutdown. */
  close: (timeoutMs?: number) => Promise<void>;
};

export function createTelemetryClient(options: TelemetryClientOptions): TelemetryClient {
  const now = options.nowMs ?? (() => Date.now());
  const sessionId = uuidV7(now());
  const sender: PostHogSender = options.sender
    ?? (options.posthog ? createPostHogSender(options.posthog) : async () => undefined);
  const enabled = (): boolean => {
    try {
      return options.isEnabled();
    } catch {
      return false;
    }
  };
  const queue = new BatchQueue({
    send: sender,
    isEnabled: enabled,
    ...(options.flushIntervalMs !== undefined ? { flushIntervalMs: options.flushIntervalMs } : {}),
    ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
  });
  const hostSessionId = options.hostSessionId && UUID_PATTERN.test(options.hostSessionId)
    ? options.hostSessionId.toLowerCase()
    : null;

  const capture: TelemetryClient['capture'] = (event, properties, eventTsMs = now()) => {
    try {
      if (!enabled()) return false;
      const distinctId = normalizeDistinctId(options.getDistinctId());
      if (!distinctId) return false;
      const sanitized = sanitizeEventProperties(options.catalog, event, properties);
      if (!sanitized) return false;
      const payload: PostHogEvent = {
        event,
        distinct_id: distinctId,
        timestamp: new Date(eventTsMs).toISOString(),
        properties: {
          $process_person_profile: false,
          ...(options.geoip ? {} : { $geoip_disable: true }),
          schema_version: TELEMETRY_SCHEMA_VERSION,
          product: options.product,
          event_ts_ms: eventTsMs,
          session_id: sessionId,
          $session_id: sessionId,
          app_version: options.appVersion,
          platform: options.platform ?? process.platform,
          arch: options.arch ?? process.arch,
          install_source: options.installSource ?? 'unknown',
          ...(options.buyerHost ? { buyer_host: options.buyerHost } : {}),
          ...(hostSessionId ? { host_session_id: hostSessionId } : {}),
          ...sanitized,
        },
      };
      queue.push(payload);
      return true;
    } catch {
      return false;
    }
  };

  return {
    sessionId,
    capture,
    flush: () => queue.flush(),
    close: (timeoutMs) => queue.close(timeoutMs),
  };
}
