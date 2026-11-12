import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KeyUsage } from '../gateway/key-info.js';
import { liveBuyerAddress } from '../gateway/buyer-signer.js';

/**
 * Requests and spend from before the local gateway, read from the buyer's own
 * channels. The gateway accounts for every request from its first key on;
 * what the buyer served before that (the desktop used it directly) is in its
 * channel store only. Home adds this to the gateway's totals.
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

/** Whether a channel was last used before the cutoff; one open across it is left to the gateway, so nothing counts twice. */
function endedBefore(entry: Record<string, unknown>, cutoffMs: number): boolean {
  const updatedAt = entry['updatedAt'];
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt < cutoffMs;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object') : [];
}

/** USDC base units (6 decimals) as a decimal string, e.g. 1500000n → "1.5". */
export function usdcDecimal(units: bigint): string {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Usage of the channels that ended before `cutoffMs`.
 *
 * - `channels`: `GET /_antseed/channels?all=1` (paid and one-off channels).
 *   Spend is the larger of the last amount the buyer signed and what the
 *   seller settled, as the gateway's ledger counts signed charges.
 * - `usagePoints`: the `channels` of `GET /_antseed/buyer-usage` (paid and
 *   free channels), for request counts, so free requests count too. One-off
 *   requests, which it leaves out, come from `channels`.
 */
export function historicUsage(channels: unknown, usagePoints: unknown, cutoffMs: number): KeyUsage {
  let requests = 0;
  let spent = 0n;
  for (const channel of records(channels)) {
    if (!endedBefore(channel, cutoffMs)) continue;
    const signed = nonNegativeBigInt(channel['cumulativeSigned']);
    const settled = nonNegativeBigInt(channel['settledAmount']);
    spent += settled > signed ? settled : signed;
    if (channel['channelKind'] === 'one_off') requests += count(channel['requestCount']);
  }
  for (const point of records(usagePoints)) {
    if (endedBefore(point, cutoffMs)) requests += count(point['requestCount']);
  }
  return { requests, spentUsd: usdcDecimal(spent) };
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

type SavedHistory = { scope: string; usage: KeyUsage };

function parseSaved(raw: unknown): SavedHistory | null {
  const saved = raw as { scope?: unknown; usage?: { requests?: unknown; spentUsd?: unknown } } | null;
  const requests = saved?.usage?.requests;
  const spentUsd = saved?.usage?.spentUsd;
  if (typeof saved?.scope !== 'string') return null;
  if (typeof requests !== 'number' || !Number.isSafeInteger(requests) || requests < 0) return null;
  if (typeof spentUsd !== 'string' || !/^\d+(\.\d{1,6})?$/.test(spentUsd)) return null;
  return { scope: saved.scope, usage: { requests, spentUsd } };
}

/**
 * The buyer's usage before the gateway, read once and then kept: in memory,
 * and in `file` so later launches show it straight away instead of waiting
 * for the buyer to start. It never changes for a given wallet and cutoff.
 */
export class BuyerHistory {
  private memory: SavedHistory | null = null;

  /** `file` gives where the result is saved; null keeps it in memory only. */
  constructor(private readonly file: () => string | null) {}

  /**
   * Usage before `cutoffMs` for `walletAddress`, the wallet paying for the
   * desktop key. Read only when it is the buyer's default wallet (the
   * desktop's own); otherwise, or when the buyer can't be read, null, and
   * Home shows the gateway's totals alone. A failed read is not kept, so the
   * next refresh tries again.
   */
  async read(port: number, walletAddress: string, cutoffMs: number): Promise<KeyUsage | null> {
    const scope = `${walletAddress.toLowerCase()}|${cutoffMs}`;
    if (this.memory?.scope === scope) return this.memory.usage;
    const saved = this.load();
    if (saved?.scope === scope) {
      this.memory = saved;
      return saved.usage;
    }
    const usage = await readFromBuyer(port, walletAddress, cutoffMs);
    if (!usage) return null;
    this.memory = { scope, usage };
    this.save(this.memory);
    return usage;
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

  /** Best effort: one that can't be written is read from the buyer again at the next launch. */
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

async function readFromBuyer(port: number, walletAddress: string, cutoffMs: number): Promise<KeyUsage | null> {
  const buyerAddress = await liveBuyerAddress(port, READ_TIMEOUT_MS);
  if (!buyerAddress || buyerAddress.toLowerCase() !== walletAddress.toLowerCase()) return null;
  const [channels, usage] = await Promise.all([
    readBuyerJson(port, '/_antseed/channels?all=1'),
    readBuyerJson(port, '/_antseed/buyer-usage'),
  ]);
  if (!channels || channels['ok'] !== true || !Array.isArray(channels['channels'])) return null;
  const totals = usage?.['totals'] as Record<string, unknown> | undefined;
  if (!usage || usage['ok'] !== true || !Array.isArray(totals?.['channels'])) return null;
  return historicUsage(channels['channels'], totals['channels'], cutoffMs);
}
