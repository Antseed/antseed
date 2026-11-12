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

const NO_USAGE: KeyUsage = { requests: 0, spentUsd: '0' };

function addUsage(a: KeyUsage, b: KeyUsage): KeyUsage {
  return { requests: a.requests + b.requests, spentUsd: usdcFromMicros(usdcToMicros(a.spentUsd) + usdcToMicros(b.spentUsd)) };
}

/**
 * What the desktop keeps per wallet. The gateway doesn't record which wallet
 * paid for a request (its keys pay from "the default wallet", whichever that
 * is), and importing a signer changes it under the same keys. So at each
 * refresh, what the gateway counted since the last one is credited to the
 * wallet that was paying then, and a wallet's history subtracts only its own
 * share.
 */
export type HistoryState = {
  /** The wallet paying at the last refresh. */
  active: string;
  /** The gateway's totals for the default wallet's keys at the last refresh. */
  lastGateway: KeyUsage;
  wallets: Record<string, { gateway: KeyUsage; history: KeyUsage }>;
};

/**
 * Credits what the gateway counted since the last refresh to the wallet that
 * was paying then. A gateway whose totals went down lost its data: the
 * shares start again from its new totals, and what it lost shows as history,
 * since the buyer still has it.
 */
function creditGrowth(state: HistoryState, gateway: KeyUsage): HistoryState['wallets'] {
  const reset = gateway.requests < state.lastGateway.requests
    || usdcToMicros(gateway.spentUsd) < usdcToMicros(state.lastGateway.spentUsd);
  const wallets: HistoryState['wallets'] = {};
  for (const [address, entry] of Object.entries(state.wallets)) {
    wallets[address] = reset ? { ...entry, gateway: NO_USAGE } : entry;
  }
  const grown = reset ? gateway : usageBeforeGateway(gateway, state.lastGateway);
  const previous = wallets[state.active];
  wallets[state.active] = { history: previous?.history ?? NO_USAGE, gateway: addUsage(previous?.gateway ?? NO_USAGE, grown) };
  return wallets;
}

/**
 * The state after a refresh that read `buyer` (the lifetime usage of
 * `wallet`, the one paying now) and `gateway` (its keys' totals). On the
 * first refresh nothing tells whose earlier gateway usage it was, so it is
 * taken as this wallet's.
 */
export function nextHistoryState(state: HistoryState | null, wallet: string, buyer: KeyUsage, gateway: KeyUsage): HistoryState {
  const wallets = state ? creditGrowth(state, gateway) : {};
  const own = state ? wallets[wallet]?.gateway ?? NO_USAGE : gateway;
  wallets[wallet] = { gateway: own, history: usageBeforeGateway(buyer, own) };
  return { active: wallet, lastGateway: gateway, wallets };
}

/**
 * The state when the signer changes to `wallet`, with `gateway` read while no
 * request can go through (the gateway is stopped for the change): all of it
 * so far is the previous wallet's, and the new one's share starts here. With
 * no state yet, the previous wallet isn't known; the new one still starts here.
 */
export function switchedHistoryState(state: HistoryState | null, wallet: string, gateway: KeyUsage): HistoryState {
  return { active: wallet, lastGateway: gateway, wallets: state ? creditGrowth(state, gateway) : {} };
}

function parseUsage(raw: unknown): KeyUsage | null {
  const usage = raw as { requests?: unknown; spentUsd?: unknown } | null;
  const requests = usage?.requests;
  const spentUsd = usage?.spentUsd;
  if (typeof requests !== 'number' || !Number.isSafeInteger(requests) || requests < 0) return null;
  if (typeof spentUsd !== 'string' || !/^\d+(\.\d{1,6})?$/.test(spentUsd)) return null;
  return { requests, spentUsd };
}

function parseState(raw: unknown): HistoryState | null {
  const saved = raw as { active?: unknown; lastGateway?: unknown; wallets?: unknown } | null;
  const lastGateway = parseUsage(saved?.lastGateway);
  if (typeof saved?.active !== 'string' || !lastGateway || !saved.wallets || typeof saved.wallets !== 'object') return null;
  const wallets: HistoryState['wallets'] = {};
  for (const [wallet, entry] of Object.entries(saved.wallets as Record<string, { gateway?: unknown; history?: unknown } | null>)) {
    const gateway = parseUsage(entry?.gateway);
    const history = parseUsage(entry?.history);
    if (!gateway || !history) return null;
    wallets[wallet] = { gateway, history };
  }
  return { active: saved.active, lastGateway, wallets };
}

/** How often the history is worked out again while Home is open. */
const REFRESH_EVERY_MS = 30_000;

/**
 * The usage from before the gateway. It is worked out again from both sides
 * every so often rather than frozen: a request still in flight (counted by the
 * gateway, not yet by the buyer) or a charge the gateway hasn't taken in yet
 * puts one reading off by that much, and the next one corrects it. The state
 * is kept in memory and in `file`, so a later launch shows the last result
 * straight away instead of waiting for the buyer to start.
 */
export class BuyerHistory {
  private state: HistoryState | null = null;
  private loaded = false;
  private refreshing: Promise<void> | null = null;
  private lastRefreshAt = -Infinity;

  /** `file` gives where the state is saved; null keeps it in memory only. */
  constructor(
    private readonly file: () => string | null,
    private readonly refreshEveryMs = REFRESH_EVERY_MS,
  ) {}

  /**
   * Usage before the gateway for `walletAddress`, the wallet paying for the
   * desktop key: the last result for that wallet, or null before there is
   * one (Home then shows the gateway's totals alone). Never waits: when the
   * last refresh is older than the interval, it runs again in the background,
   * with `gatewayUsage` giving the gateway's totals for the default wallet's
   * keys. A refresh that can't read both sides, or finds the buyer paying
   * from another wallet, keeps the last result.
   */
  read(port: number, walletAddress: string, gatewayUsage: () => Promise<KeyUsage | null>): KeyUsage | null {
    this.ensureLoaded();
    if (!this.refreshing && Date.now() - this.lastRefreshAt >= this.refreshEveryMs) {
      this.lastRefreshAt = Date.now();
      this.refreshing = this.refresh(port, walletAddress, gatewayUsage).finally(() => { this.refreshing = null; });
    }
    return this.state?.wallets[walletAddress.toLowerCase()]?.history ?? null;
  }

  /** The refresh in progress, if any (for tests). */
  settled(): Promise<void> {
    return this.refreshing ?? Promise.resolve();
  }

  /**
   * The signer changed to `walletAddress`. Call it while the gateway is
   * stopped for the change, so what `gatewayUsage` reads is all the previous
   * wallet's. Waits for a refresh in progress, and none starts until it's
   * done. When the gateway's totals can't be read, the next refresh credits
   * what it counted meanwhile to the previous wallet.
   */
  async switchWallet(walletAddress: string, gatewayUsage: () => Promise<KeyUsage | null>): Promise<void> {
    this.ensureLoaded();
    while (this.refreshing) await this.refreshing;
    this.refreshing = (async () => {
      const gateway = await gatewayUsage().catch(() => null);
      if (!gateway) return;
      this.state = switchedHistoryState(this.state, walletAddress.toLowerCase(), gateway);
      this.save(this.state);
    })().finally(() => { this.refreshing = null; });
    await this.refreshing;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.state = this.load();
    this.loaded = true;
  }

  private async refresh(port: number, walletAddress: string, gatewayUsage: () => Promise<KeyUsage | null>): Promise<void> {
    const [buyer, gateway] = await Promise.all([readBuyerLifetime(port, walletAddress), gatewayUsage().catch(() => null)]);
    if (!buyer || !gateway) return;
    const next = nextHistoryState(this.state, walletAddress.toLowerCase(), buyer, gateway);
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) this.save(next);
  }

  private load(): HistoryState | null {
    const file = this.file();
    if (!file) return null;
    try {
      return parseState(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return null;
    }
  }

  /** Best effort: one that can't be written is worked out again at the next launch. */
  private save(state: HistoryState): void {
    const file = this.file();
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // Kept in memory for this launch.
    }
  }
}
