import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KeyUsage } from '../gateway/key-info.js';
import { liveBuyerAddress } from '../gateway/buyer-signer.js';
import { usdcFromMicros, usdcToMicros } from './usdc-decimal.js';

/**
 * Requests and spend the gateway never saw: what the buyer served before the
 * local gateway existed (the desktop used it directly then). The gateway
 * sends every request through this same buyer, so that history is the
 * buyer's lifetime usage on the wallet less the gateway's own totals for the
 * wallet's keys. It needs no request times, which the buyer doesn't keep:
 * a channel used on both sides of the switch, or settled after it, counts
 * once. Home adds it to the gateway's totals.
 */

const READ_TIMEOUT_MS = 5_000;

function nonNegativeBigInt(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') return 0n;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : [];
}

/**
 * Everything the buyer has served on the wallet.
 *
 * - `channels`: `GET /_antseed/channels?all=1` (paid and one-off channels).
 *   Spend is the larger of the last amount the buyer signed and what the
 *   seller settled, as the gateway's ledger counts signed charges.
 * - `usagePoints`: the `channels` of `GET /_antseed/buyer-usage` (paid and
 *   free channels), for request counts, so free requests count too. One-off
 *   requests, which it leaves out, come from `channels`.
 */
export function buyerLifetimeUsage(channels: unknown, usagePoints: unknown): KeyUsage {
  let requests = 0;
  let spent = 0n;
  for (const channel of records(channels)) {
    const signed = nonNegativeBigInt(channel['cumulativeSigned']);
    const settled = nonNegativeBigInt(channel['settledAmount']);
    spent += settled > signed ? settled : signed;
    if (channel['channelKind'] === 'one_off') requests += count(channel['requestCount']);
  }
  for (const point of records(usagePoints)) requests += count(point['requestCount']);
  return { requests, spentUsd: usdcFromMicros(spent) };
}

/** The buyer's lifetime usage less the gateway's; never below zero, so a gateway that counted more adds nothing. */
export function usageBeforeGateway(buyer: KeyUsage, gateway: KeyUsage): KeyUsage {
  const spent = usdcToMicros(buyer.spentUsd) - usdcToMicros(gateway.spentUsd);
  return {
    requests: Math.max(0, buyer.requests - gateway.requests),
    spentUsd: usdcFromMicros(spent > 0n ? spent : 0n),
  };
}

async function readBuyerJson(port: number, pathname: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = await response.json() as unknown;
    return body && typeof body === 'object' ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The buyer's lifetime usage when `walletAddress` is its default wallet (the desktop's own); null otherwise or when it can't be read. */
async function readBuyerLifetime(port: number, walletAddress: string): Promise<KeyUsage | null> {
  const buyerAddress = await liveBuyerAddress(port, READ_TIMEOUT_MS);
  if (!buyerAddress || buyerAddress.toLowerCase() !== walletAddress.toLowerCase()) return null;
  const [channels, usage] = await Promise.all([
    readBuyerJson(port, '/_antseed/channels?all=1'),
    readBuyerJson(port, '/_antseed/buyer-usage'),
  ]);
  if (!channels || channels['ok'] !== true || !Array.isArray(channels['channels'])) return null;
  const totals = usage?.['totals'] as Record<string, unknown> | undefined;
  if (!usage || usage['ok'] !== true || !Array.isArray(totals?.['channels'])) return null;
  return buyerLifetimeUsage(channels['channels'], totals['channels']);
}

type SavedHistory = { wallet: string; usage: KeyUsage };

function parseSaved(raw: unknown): SavedHistory | null {
  const saved = raw as { wallet?: unknown; usage?: { requests?: unknown; spentUsd?: unknown } } | null;
  const requests = saved?.usage?.requests;
  const spentUsd = saved?.usage?.spentUsd;
  if (typeof saved?.wallet !== 'string') return null;
  if (typeof requests !== 'number' || !Number.isSafeInteger(requests) || requests < 0) return null;
  if (typeof spentUsd !== 'string' || !/^\d+(\.\d{1,6})?$/.test(spentUsd)) return null;
  return { wallet: saved.wallet, usage: { requests, spentUsd } };
}

/**
 * Both sides must describe the same moment: the gateway takes in the buyer's
 * charges by polling (every 2 s, each poll allowed 3 s), so a charge the buyer
 * signed a moment ago may not be in the gateway's totals yet. A result is kept
 * only when neither side changed across this window.
 */
const QUIET_WINDOW_MS = 8_000;
/** How soon after an attempt that found traffic (or couldn't read) the next may start. */
const RETRY_AFTER_MS = 15_000;

function sameUsage(a: KeyUsage, b: KeyUsage): boolean {
  return a.requests === b.requests && usdcToMicros(a.spentUsd) === usdcToMicros(b.spentUsd);
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The usage from before the gateway, worked out once per wallet and then
 * kept: in memory, and in `file` so later launches show it straight away
 * instead of waiting for the buyer to start. Kept once, it can't drift as the
 * gateway and the buyer go on counting the same new requests.
 */
export class BuyerHistory {
  private memory: SavedHistory | null = null;
  private attempt: Promise<void> | null = null;
  private lastAttemptAt = -Infinity;

  /** `file` gives where the result is saved; null keeps it in memory only. */
  constructor(
    private readonly file: () => string | null,
    private readonly timing: { quietWindowMs: number; retryAfterMs: number } = { quietWindowMs: QUIET_WINDOW_MS, retryAfterMs: RETRY_AFTER_MS },
  ) {}

  /**
   * Usage before the gateway for `walletAddress`, the wallet paying for the
   * desktop key, once known; null until then, and Home shows the gateway's
   * totals alone. Never waits: the first time, it starts working it out in
   * the background, with `gatewayUsage` giving the gateway's totals for the
   * wallet's keys. That is kept only when the buyer pays from that wallet,
   * both sides could be read, and neither changed across the quiet window;
   * otherwise a later call tries again.
   */
  read(port: number, walletAddress: string, gatewayUsage: () => Promise<KeyUsage | null>): KeyUsage | null {
    const wallet = walletAddress.toLowerCase();
    if (this.memory?.wallet === wallet) return this.memory.usage;
    const saved = this.load();
    if (saved?.wallet === wallet) {
      this.memory = saved;
      return saved.usage;
    }
    if (!this.attempt && Date.now() - this.lastAttemptAt >= this.timing.retryAfterMs) {
      this.lastAttemptAt = Date.now();
      this.attempt = this.workOut(port, walletAddress, gatewayUsage).finally(() => { this.attempt = null; });
    }
    return null;
  }

  /** The attempt in progress, if any (for tests). */
  settled(): Promise<void> {
    return this.attempt ?? Promise.resolve();
  }

  private async workOut(port: number, walletAddress: string, gatewayUsage: () => Promise<KeyUsage | null>): Promise<void> {
    const readBoth = () => Promise.all([readBuyerLifetime(port, walletAddress), gatewayUsage().catch(() => null)]);
    const [buyerBefore, gatewayBefore] = await readBoth();
    if (!buyerBefore || !gatewayBefore) return;
    await wait(this.timing.quietWindowMs);
    const [buyer, gateway] = await readBoth();
    if (!buyer || !gateway || !sameUsage(buyer, buyerBefore) || !sameUsage(gateway, gatewayBefore)) return;
    this.memory = { wallet: walletAddress.toLowerCase(), usage: usageBeforeGateway(buyer, gateway) };
    this.save(this.memory);
  }

  private load(): SavedHistory | null {
    const file = this.file();
    if (!file) return null;
    try {
      return parseSaved(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }

  /** Best effort: one that can't be written is worked out again at the next launch. */
  private save(saved: SavedHistory): void {
    const file = this.file();
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // Kept in memory for this launch.
    }
  }
}
