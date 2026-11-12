import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KeyUsage } from '../gateway/key-info.js';
import { compareBuyerSigner, fetchBuyerJson, liveBuyerAddress } from '../gateway/buyer-signer.js';
import { usdcFromMicros, usdcToMicros } from './usdc-decimal.js';

/**
 * Requests and spend the gateway never saw: what the buyer served before the
 * local gateway existed (the desktop used it directly then). The gateway
 * sends every request through this same buyer, so that history is the
 * buyer's lifetime usage on the wallet less the gateway's own totals for the
 * wallet's keys. It needs no request times, which the buyer doesn't keep:
 * a channel used on both sides of the switch, or settled after it, counts
 * once. Home adds it to the gateway's totals.
 *
 * Known limit, accepted: the gateway doesn't record which wallet paid, so
 * after importing another signer the earlier wallet's gateway usage is
 * subtracted from the new wallet's history too. That history can come out
 * short, never too high.
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
  const body = await fetchBuyerJson(port, pathname, READ_TIMEOUT_MS);
  return body && typeof body === 'object' ? body as Record<string, unknown> : null;
}

/** The buyer's lifetime usage when `walletAddress` is its default wallet (the desktop's own); null otherwise or when it can't be read. */
async function readBuyerLifetime(port: number, walletAddress: string): Promise<KeyUsage | null> {
  if (compareBuyerSigner(await liveBuyerAddress(port, READ_TIMEOUT_MS), walletAddress) !== 'match') return null;
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

/** How often the history is worked out again while Home is open. */
const REFRESH_EVERY_MS = 30_000;

/**
 * The usage from before the gateway. It is worked out again from both sides
 * every so often rather than frozen: a request still in flight (counted by the
 * gateway, not yet by the buyer) or a charge the gateway hasn't taken in yet
 * puts one reading off by that much, and the next one corrects it. The last
 * result is kept in memory and in `file`, so a later launch shows it straight
 * away instead of waiting for the buyer to start.
 */
export class BuyerHistory {
  private memory: SavedHistory | null = null;
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt = -Infinity;

  /** `file` gives where the result is saved; null keeps it in memory only. */
  constructor(
    private readonly file: () => string | null,
    private readonly refreshEveryMs = REFRESH_EVERY_MS,
  ) {}

  /**
   * Usage before the gateway for `walletAddress`, the wallet paying for the
   * desktop key: the last result for that wallet, or null before there is
   * one (Home then shows the gateway's totals alone). Never waits: when the
   * last result is older than the refresh interval, it is worked out again in
   * the background, with `gatewayUsage` giving the gateway's totals for the
   * wallet's keys. A refresh that can't read both sides, or finds the buyer
   * paying from another wallet, keeps the last result.
   */
  read(port: number, walletAddress: string, gatewayUsage: () => Promise<KeyUsage | null>): KeyUsage | null {
    const wallet = walletAddress.toLowerCase();
    if (this.memory?.wallet !== wallet) {
      const saved = this.load();
      this.memory = saved?.wallet === wallet ? saved : null;
    }
    if (!this.refreshing && Date.now() - this.lastRefreshAt >= this.refreshEveryMs) {
      this.lastRefreshAt = Date.now();
      this.refreshing = this.refresh(port, walletAddress, gatewayUsage).finally(() => { this.refreshing = null; });
    }
    return this.memory?.usage ?? null;
  }

  /** The refresh in progress, if any (for tests). */
  settled(): Promise<void> {
    return this.refreshing ?? Promise.resolve();
  }

  private async refresh(port: number, walletAddress: string, gatewayUsage: () => Promise<KeyUsage | null>): Promise<void> {
    const [buyer, gateway] = await Promise.all([readBuyerLifetime(port, walletAddress), gatewayUsage().catch(() => null)]);
    if (!buyer || !gateway) return;
    const next = { wallet: walletAddress.toLowerCase(), usage: usageBeforeGateway(buyer, gateway) };
    const changed = !this.memory || this.memory.wallet !== next.wallet
      || this.memory.usage.requests !== next.usage.requests || this.memory.usage.spentUsd !== next.usage.spentUsd;
    this.memory = next;
    if (changed) this.save(next);
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
