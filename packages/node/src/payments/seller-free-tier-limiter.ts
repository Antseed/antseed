import { isIP } from 'node:net';
import {
  evaluateFreeTierLimits,
  type FreeTierConsumption,
  type FreeTierLimitCheck,
  type MeteringStorage,
} from '../metering/storage.js';
import { peerIdToAddress } from '../types/peer.js';

export interface SellerFreeTierConfig {
  /** Maximum zero-priced requests accepted from one buyer address per window. */
  maxRequestsPerAddress?: number;
  /** Maximum zero-priced requests accepted from one remote IP per window. */
  maxRequestsPerIp?: number;
  /** Sliding-window duration in milliseconds. Default: 24 hours. */
  windowMs?: number;
}

export interface FreeTierDecision extends FreeTierConsumption {
  buyerAddress: string;
  /** Normalized remote IP the decision was keyed on, or null when unknown. */
  remoteIp: string | null;
}

export interface FreeTierConsumeInput {
  buyerPeerId: string;
  service: string;
  /** Raw socket remote address of the buyer connection, if known. */
  remoteIp?: string | null;
  nowMs?: number;
}

export const DEFAULT_FREE_TIER_WINDOW_MS = 24 * 60 * 60_000;
const MAX_IN_MEMORY_KEYS = 20_000;

/**
 * Normalize a socket remote address into a limiter key.
 * IPv4-mapped IPv6 addresses collapse to plain IPv4; IPv6 is grouped by /64 so a
 * single host cannot hop across its own prefix to reset the counter.
 */
export function normalizeRemoteIp(remoteIp: string | null | undefined): string | null {
  if (!remoteIp) return null;
  let ip = remoteIp.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  return `${expanded.slice(0, 4).join(':')}::/64`;
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail] = ip.toLowerCase().split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const isCompressed = tail !== undefined;
  const missing = 8 - headParts.length - tailParts.length;
  if (isCompressed ? missing < 0 : missing !== 0) return null;
  const zeros = isCompressed ? Array<string>(missing).fill('0') : [];
  return [...headParts, ...zeros, ...tailParts].map((part) => part.padStart(4, '0'));
}

export class SellerFreeTierLimiter {
  readonly maxRequestsPerAddress: number | null;
  readonly maxRequestsPerIp: number | null;
  readonly windowMs: number;

  private readonly _storage: MeteringStorage | null;
  private readonly _inMemoryUsage = new Map<string, number[]>();

  constructor(config: SellerFreeTierConfig, storage: MeteringStorage | null = null) {
    const perAddress = config.maxRequestsPerAddress;
    const perIp = config.maxRequestsPerIp;
    if (perAddress !== undefined && (!Number.isSafeInteger(perAddress) || perAddress < 1)) {
      throw new Error('freeTier.maxRequestsPerAddress must be a positive safe integer');
    }
    if (perIp !== undefined && (!Number.isSafeInteger(perIp) || perIp < 1)) {
      throw new Error('freeTier.maxRequestsPerIp must be a positive safe integer');
    }
    if (perAddress === undefined && perIp === undefined) {
      throw new Error('freeTier requires maxRequestsPerAddress and/or maxRequestsPerIp');
    }
    const windowMs = config.windowMs ?? DEFAULT_FREE_TIER_WINDOW_MS;
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) {
      throw new Error('freeTier.windowMs must be a safe integer of at least 1000');
    }
    this.maxRequestsPerAddress = perAddress ?? null;
    this.maxRequestsPerIp = perIp ?? null;
    this.windowMs = windowMs;
    this._storage = storage;
  }

  describe(): string {
    const parts: string[] = [];
    if (this.maxRequestsPerAddress !== null) parts.push(`${this.maxRequestsPerAddress} per buyer address`);
    if (this.maxRequestsPerIp !== null) parts.push(`${this.maxRequestsPerIp} per IP`);
    return `${parts.join(', ')} every ${this.windowMs}ms`;
  }

  consume(input: FreeTierConsumeInput): FreeTierDecision {
    const nowMs = input.nowMs ?? Date.now();
    const buyerAddress = peerIdToAddress(input.buyerPeerId).toLowerCase();
    const remoteIp = normalizeRemoteIp(input.remoteIp);
    const decision = this._storage
      ? this._storage.consumeFreeTierRequest({
        buyerAddress,
        remoteIp,
        service: input.service,
        maxRequestsPerAddress: this.maxRequestsPerAddress,
        maxRequestsPerIp: this.maxRequestsPerIp,
        windowMs: this.windowMs,
        nowMs,
      })
      : this._consumeInMemory(buyerAddress, remoteIp, nowMs);
    return { ...decision, buyerAddress, remoteIp };
  }

  private _consumeInMemory(buyerAddress: string, remoteIp: string | null, nowMs: number): FreeTierConsumption {
    const windowStart = nowMs - this.windowMs;
    const buckets: number[][] = [];
    const checks: FreeTierLimitCheck[] = [];
    const track = (kind: FreeTierLimitCheck['kind'], key: string, limit: number): void => {
      const timestamps = this._bucket(key, windowStart);
      buckets.push(timestamps);
      checks.push({ kind, limit, count: timestamps.length, oldestTimestamp: timestamps[0] ?? null });
    };
    if (this.maxRequestsPerAddress !== null) track('address', `address:${buyerAddress}`, this.maxRequestsPerAddress);
    if (this.maxRequestsPerIp !== null && remoteIp !== null) track('ip', `ip:${remoteIp}`, this.maxRequestsPerIp);

    const decision = evaluateFreeTierLimits(checks, this.windowMs, nowMs);
    if (decision.allowed) {
      for (const timestamps of buckets) timestamps.push(nowMs);
    }
    return decision;
  }

  private _bucket(key: string, windowStart: number): number[] {
    let timestamps = this._inMemoryUsage.get(key);
    if (!timestamps) {
      this._pruneExpiredBuckets(windowStart);
      if (this._inMemoryUsage.size >= MAX_IN_MEMORY_KEYS) {
        throw new Error('free-tier limiter capacity reached while persistent metering is unavailable');
      }
      timestamps = [];
      this._inMemoryUsage.set(key, timestamps);
    }
    let firstActive = 0;
    while (firstActive < timestamps.length && timestamps[firstActive]! < windowStart) {
      firstActive += 1;
    }
    if (firstActive > 0) timestamps.splice(0, firstActive);
    return timestamps;
  }

  private _pruneExpiredBuckets(windowStart: number): void {
    for (const [key, timestamps] of this._inMemoryUsage) {
      if ((timestamps.at(-1) ?? 0) < windowStart) {
        this._inMemoryUsage.delete(key);
      }
    }
  }
}
