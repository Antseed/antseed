import { formatEther, formatUnits } from 'ethers';
import { debugLog, debugWarn } from '../utils/debug.js';

/** Refuel once the wallet holds less than this (10× the default pause minimum). */
export const DEFAULT_REFUEL_TRIGGER_WEI = 500_000_000_000_000n;
/** USDC swapped per refuel (10 USDC, base units). */
export const DEFAULT_REFUEL_SWAP_USDC_UNITS = 10_000_000n;
/** Most USDC swapped in any 24 hours (30 USDC, base units), so a gas leak cannot drain earnings. */
export const DEFAULT_REFUEL_MAX_USDC_PER_DAY_UNITS = 30_000_000n;
export const DEFAULT_REFUEL_SLIPPAGE_BPS = 100;
/** Smallest swap worth making (1 USDC); below this the refuel is skipped. */
export const MIN_REFUEL_SWAP_USDC_UNITS = 1_000_000n;
/** Wait after a refuel before another, so a balance read that lags the swap does not trigger a second one. */
export const REFUEL_SUCCESS_COOLDOWN_MS = 10 * 60_000;
/** First retry delay after a failed refuel; doubles per failure up to the max. */
export const REFUEL_FAILURE_BACKOFF_MS = 5 * 60_000;
export const REFUEL_MAX_BACKOFF_MS = 6 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** A refuel, kept for the daily cap (and persisted by the caller across restarts). */
export interface GasRefuelRecord {
  at: number;
  usdcUnits: string;
  /** Empty while `pending`. */
  txHash: string;
  /**
   * Saved before the swap is sent and replaced once it is mined (or dropped if it
   * fails). One left behind by a process that exited mid-swap still counts toward
   * the daily cap, since the swap may have gone through.
   */
  pending?: boolean;
}

export type GasRefuelSkipReason = 'daily_cap' | 'insufficient_usdc' | 'insufficient_eth';

export type GasRefuelEvent =
  | { status: 'refueled'; address: string; record: GasRefuelRecord; expectedEthWei: bigint; balanceWei: bigint }
  | { status: 'failed'; address: string; error: string; balanceWei: bigint; retryAt: number }
  | { status: 'skipped'; address: string; reason: GasRefuelSkipReason; balanceWei: bigint; detail: string };

export interface GasRefuelSnapshot {
  address: string;
  triggerBalanceWei: bigint;
  swapUsdcUnits: bigint;
  maxUsdcPerDayUnits: bigint;
  usdcLast24hUnits: bigint;
  inFlight: boolean;
  lastRefuel: GasRefuelRecord | null;
  lastError: string | null;
  /** Why the last refuel attempt was skipped, until one goes through. */
  skipped: GasRefuelSkipReason | null;
  nextAttemptAt: number | null;
}

/** The chain operations a refuel needs (implemented by `UsdcEthSwapClient`). */
export interface GasRefuelSwapper {
  quote(amountIn: bigint): Promise<bigint>;
  usdcBalance(address: string): Promise<bigint>;
  maxSwapCostWei(): Promise<bigint>;
  swap(amountIn: bigint, minEthOut: bigint): Promise<string>;
}

export interface GasAutoRefuelConfig {
  /** Seller wallet: pays the swap's gas and receives the ETH. */
  address: string;
  swapper: GasRefuelSwapper;
  triggerBalanceWei?: bigint;
  swapUsdcUnits?: bigint;
  maxUsdcPerDayUnits?: bigint;
  slippageBps?: number;
  /** Earlier refuels (e.g. loaded from disk) so the daily cap survives restarts. */
  history?: GasRefuelRecord[];
  /**
   * Persist the last 24 hours of refuels: before each swap is sent (with it as
   * `pending`) and after it settles, even after `stop()`, so the daily cap still
   * counts it after a restart.
   */
  saveHistory?: (records: GasRefuelRecord[]) => Promise<void>;
  onEvent?: (event: GasRefuelEvent) => void | Promise<void>;
  now?: () => number;
}

/**
 * Tops the seller wallet up with ETH before it runs out: when a balance
 * reading is under the trigger, swap some of the wallet's own USDC (its
 * earnings) for ETH, paying gas from the ETH still there. Swaps are capped per
 * day, spaced by a cooldown, and backed off after failures. Feed it every
 * balance reading via `onBalance` (e.g. from `GasHealthMonitor`).
 */
export class GasAutoRefueler {
  private readonly _address: string;
  private readonly _swapper: GasRefuelSwapper;
  private readonly _triggerBalanceWei: bigint;
  private readonly _swapUsdcUnits: bigint;
  private readonly _maxUsdcPerDayUnits: bigint;
  private readonly _slippageBps: bigint;
  private readonly _onEvent: GasAutoRefuelConfig['onEvent'];
  private readonly _saveHistory: GasAutoRefuelConfig['saveHistory'];
  private readonly _now: () => number;
  private _history: GasRefuelRecord[];
  private _inFlight: Promise<void> | null = null;
  private _nextAttemptAt = 0;
  private _failures = 0;
  private _lastError: string | null = null;
  private _skipped: GasRefuelSkipReason | null = null;
  private _stopped = false;

  constructor(config: GasAutoRefuelConfig) {
    this._address = config.address;
    this._swapper = config.swapper;
    this._triggerBalanceWei = config.triggerBalanceWei ?? DEFAULT_REFUEL_TRIGGER_WEI;
    this._swapUsdcUnits = config.swapUsdcUnits ?? DEFAULT_REFUEL_SWAP_USDC_UNITS;
    this._maxUsdcPerDayUnits = config.maxUsdcPerDayUnits ?? DEFAULT_REFUEL_MAX_USDC_PER_DAY_UNITS;
    this._slippageBps = BigInt(config.slippageBps ?? DEFAULT_REFUEL_SLIPPAGE_BPS);
    this._onEvent = config.onEvent;
    this._saveHistory = config.saveHistory;
    this._now = config.now ?? Date.now;
    this._history = [...(config.history ?? [])];
  }

  /**
   * No more refuels after this. One already running finishes and its history is
   * still saved, but it reports nothing; the returned promise settles when it is done.
   */
  stop(): Promise<void> {
    this._stopped = true;
    return this._inFlight ?? Promise.resolve();
  }

  /** Every refuel in the last 24 hours (what the daily cap counts). */
  get recentHistory(): GasRefuelRecord[] {
    const since = this._now() - DAY_MS;
    return this._history.filter((record) => record.at > since);
  }

  getSnapshot(): GasRefuelSnapshot {
    const recent = this.recentHistory;
    return {
      address: this._address,
      triggerBalanceWei: this._triggerBalanceWei,
      swapUsdcUnits: this._swapUsdcUnits,
      maxUsdcPerDayUnits: this._maxUsdcPerDayUnits,
      usdcLast24hUnits: recent.reduce((sum, record) => sum + BigInt(record.usdcUnits), 0n),
      inFlight: this._inFlight !== null,
      lastRefuel: this._history.filter((record) => !record.pending).at(-1) ?? null,
      lastError: this._lastError,
      skipped: this._skipped,
      nextAttemptAt: this._nextAttemptAt > this._now() ? this._nextAttemptAt : null,
    };
  }

  /**
   * A fresh balance reading. Starts a refuel when it is under the trigger and
   * none is running or cooling down. Resolves when that refuel is done.
   */
  onBalance(balanceWei: bigint): Promise<void> {
    if (this._stopped) return Promise.resolve();
    if (balanceWei >= this._triggerBalanceWei) {
      // Funded (by a refuel or by hand): a later shortfall reports its skip reason afresh.
      this._skipped = null;
      return Promise.resolve();
    }
    if (this._inFlight) return this._inFlight;
    if (this._now() < this._nextAttemptAt) return Promise.resolve();
    this._inFlight = this._refuel(balanceWei).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  private async _refuel(balanceWei: bigint): Promise<void> {
    let reservation: GasRefuelRecord | null = null;
    try {
      const recent = this.recentHistory;
      const usedToday = recent.reduce((sum, record) => sum + BigInt(record.usdcUnits), 0n);
      const leftToday = this._maxUsdcPerDayUnits - usedToday;
      if (leftToday < MIN_REFUEL_SWAP_USDC_UNITS) {
        // Try again once the oldest refuel in the window ages out.
        this._nextAttemptAt = (recent[0]?.at ?? this._now()) + DAY_MS;
        this._skip('daily_cap', balanceWei, `swapped ${formatUnits(usedToday, 6)} USDC in the last 24h (cap ${formatUnits(this._maxUsdcPerDayUnits, 6)})`);
        return;
      }
      const usdcBalance = await this._swapper.usdcBalance(this._address);
      const amount = [this._swapUsdcUnits, leftToday, usdcBalance].reduce((a, b) => (b < a ? b : a));
      if (amount < MIN_REFUEL_SWAP_USDC_UNITS) {
        this._nextAttemptAt = this._now() + REFUEL_SUCCESS_COOLDOWN_MS;
        this._skip('insufficient_usdc', balanceWei, `wallet holds ${formatUnits(usdcBalance, 6)} USDC`);
        return;
      }
      const maxCost = await this._swapper.maxSwapCostWei();
      if (balanceWei < maxCost) {
        this._nextAttemptAt = this._now() + REFUEL_SUCCESS_COOLDOWN_MS;
        this._skip('insufficient_eth', balanceWei, `a swap can cost up to ${formatEther(maxCost)} ETH; wallet holds ${formatEther(balanceWei)} ETH`);
        return;
      }
      const expected = await this._swapper.quote(amount);
      const minOut = (expected * (10_000n - this._slippageBps)) / 10_000n;
      debugLog(`[GasRefuel] ${this._address} at ${formatEther(balanceWei)} ETH: swapping ${formatUnits(amount, 6)} USDC for ~${formatEther(expected)} ETH`);
      // Reserve the spend on disk first: if the process exits before the swap is mined, a restart still counts it.
      reservation = { at: this._now(), usdcUnits: amount.toString(), txHash: '', pending: true };
      this._history = [...this.recentHistory, reservation];
      await this._persist();
      const txHash = await this._swapper.swap(amount, minOut);
      const record: GasRefuelRecord = { at: this._now(), usdcUnits: amount.toString(), txHash };
      this._history = [...this.recentHistory.filter((entry) => entry !== reservation), record];
      reservation = null;
      await this._persist();
      this._failures = 0;
      this._lastError = null;
      this._skipped = null;
      this._nextAttemptAt = this._now() + REFUEL_SUCCESS_COOLDOWN_MS;
      this._emit({ status: 'refueled', address: this._address, record, expectedEthWei: expected, balanceWei });
    } catch (err) {
      // The swap reverted, was dropped or never sent: no USDC left the wallet.
      if (reservation) {
        const dropped = reservation;
        this._history = this._history.filter((entry) => entry !== dropped);
        await this._persist();
      }
      const error = err instanceof Error ? err.message : String(err);
      this._failures += 1;
      const backoff = Math.min(REFUEL_MAX_BACKOFF_MS, REFUEL_FAILURE_BACKOFF_MS * 2 ** (this._failures - 1));
      this._nextAttemptAt = this._now() + backoff;
      this._lastError = error;
      debugWarn(`[GasRefuel] ${this._address} refuel failed: ${error}`);
      this._emit({ status: 'failed', address: this._address, error, balanceWei, retryAt: this._nextAttemptAt });
    }
  }

  private async _persist(): Promise<void> {
    if (!this._saveHistory) return;
    await this._saveHistory(this.recentHistory)
      .catch((err) => debugWarn(`[GasRefuel] could not save refuel history: ${err instanceof Error ? err.message : err}`));
  }

  /** Report a skip once per reason, not on every reading while it lasts. */
  private _skip(reason: GasRefuelSkipReason, balanceWei: bigint, detail: string): void {
    if (this._skipped === reason) return;
    this._skipped = reason;
    debugLog(`[GasRefuel] ${this._address} refuel skipped (${reason}): ${detail}`);
    this._emit({ status: 'skipped', address: this._address, reason, balanceWei, detail });
  }

  private _emit(event: GasRefuelEvent): void {
    if (this._stopped || !this._onEvent) return;
    try {
      const result = this._onEvent(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => debugWarn(`[GasRefuel] onEvent failed: ${err instanceof Error ? err.message : err}`));
      }
    } catch (err) {
      debugWarn(`[GasRefuel] onEvent failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
