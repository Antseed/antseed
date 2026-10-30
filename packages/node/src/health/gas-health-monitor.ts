import { formatEther } from 'ethers';
import { debugLog, debugWarn } from '../utils/debug.js';

/** Default balance poll interval. Each poll is a single eth_getBalance call. */
export const DEFAULT_GAS_CHECK_INTERVAL_MS = 60_000;
/**
 * Default minimum wallet balance before the seller is treated as out of gas.
 * 0.00005 ETH covers several reserve/settle/close transactions on Base; below
 * that the next on-chain call is likely to fail with "insufficient funds",
 * which rejects every buyer while the peer keeps looking discoverable.
 */
export const DEFAULT_MIN_GAS_BALANCE_WEI = 50_000_000_000_000n;
/** How often a well-funded wallet is checked. */
export const DEFAULT_RELAXED_GAS_CHECK_INTERVAL_MS = 5 * 60_000;
/** The relaxed interval never exceeds this many regular intervals, so a drained wallet is noticed within a few checks. */
export const MAX_RELAXED_INTERVAL_MULTIPLE = 5;
/** A balance this many times the minimum counts as well funded (the default of `relaxedBalanceFactor`). */
export const RELAXED_BALANCE_FACTOR = 20n;

export interface GasHealthEvent {
  status: 'depleted' | 'restored';
  /** Wallet that pays gas for seller transactions (the peer identity wallet). */
  address: string;
  balanceWei: bigint;
  minBalanceWei: bigint;
}

export interface GasHealthSnapshot {
  address: string;
  depleted: boolean;
  lastBalanceWei: bigint | null;
  lastCheckedAt: number | null;
  minBalanceWei: bigint;
}

export interface GasHealthMonitorConfig {
  /** Wallet that pays gas for seller transactions (the peer identity wallet). */
  address: string;
  /** Reads the wallet's current balance in wei (e.g. `provider.getBalance`). */
  getBalance: (address: string) => Promise<bigint>;
  intervalMs?: number;
  minBalanceWei?: bigint;
  /**
   * While the last balance is at least `RELAXED_BALANCE_FACTOR` × the minimum,
   * check only this often (default 5 minutes, at most 5 regular intervals).
   * A wallet drained in between is noticed that much later, so a seller
   * settling heavily lowers it or raises `relaxedBalanceFactor`.
   */
  relaxedIntervalMs?: number;
  /** How many times the minimum counts as well funded (default `RELAXED_BALANCE_FACTOR`). */
  relaxedBalanceFactor?: bigint;
  /**
   * Invoked when the wallet crosses the threshold in either direction.
   * Callers should pause/resume advertising here (e.g.
   * `node.pauseAdvertising(...)` / `node.resumeAdvertising()`).
   */
  onChange?: (event: GasHealthEvent) => void | Promise<void>;
  /** Invoked with every successful reading (e.g. `GasAutoRefueler.onBalance`). */
  onBalance?: (balanceWei: bigint) => void | Promise<void>;
}

/**
 * Periodically reads the seller wallet's ETH balance and reports when it drops
 * below the minimum needed to fund on-chain settlement. A seller with no gas
 * cannot reserve, settle, or close payment channels — every buyer that finds
 * it gets rejected — so the operator hook should unadvertise the peer until
 * the wallet is funded again.
 *
 * A balance read is authoritative (unlike a model probe there is nothing flaky
 * to debounce), so a single reading below the threshold flips to `depleted`
 * and a single reading at or above it flips back to `restored`. RPC errors are
 * inconclusive and leave the current state untouched.
 */
export class GasHealthMonitor {
  private readonly _address: string;
  private readonly _getBalance: (address: string) => Promise<bigint>;
  private readonly _intervalMs: number;
  private readonly _relaxedIntervalMs: number;
  private readonly _relaxedBalanceFactor: bigint;
  private readonly _minBalanceWei: bigint;
  private readonly _onChange: GasHealthMonitorConfig['onChange'];
  private readonly _onBalance: GasHealthMonitorConfig['onBalance'];
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _stopped = false;
  private _checkInFlight: Promise<void> | null = null;
  private _depleted = false;
  private _lastBalanceWei: bigint | null = null;
  private _lastCheckedAt: number | null = null;

  constructor(config: GasHealthMonitorConfig) {
    this._address = config.address;
    this._getBalance = config.getBalance;
    this._intervalMs = config.intervalMs ?? DEFAULT_GAS_CHECK_INTERVAL_MS;
    this._relaxedIntervalMs = Math.min(this._intervalMs * MAX_RELAXED_INTERVAL_MULTIPLE, Math.max(this._intervalMs, config.relaxedIntervalMs ?? DEFAULT_RELAXED_GAS_CHECK_INTERVAL_MS));
    this._minBalanceWei = config.minBalanceWei ?? DEFAULT_MIN_GAS_BALANCE_WEI;
    this._relaxedBalanceFactor = config.relaxedBalanceFactor ?? RELAXED_BALANCE_FACTOR;
    this._onChange = config.onChange;
    this._onBalance = config.onBalance;
  }

  /** Start periodic checks. The first check runs immediately (async). */
  start(): void {
    if (this._timer) return;
    this._stopped = false;
    void this.checkNow();
    this._timer = setInterval(() => {
      if (this._relaxed() && this._lastCheckedAt !== null && Date.now() - this._lastCheckedAt < this._relaxedIntervalMs) return;
      void this.checkNow();
    }, this._intervalMs);
    // Never keep the process alive just for gas checks.
    this._timer.unref?.();
  }

  stop(): void {
    // A reading still in flight is dropped, so nothing reports a change after shutdown.
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private _relaxed(): boolean {
    return this._lastBalanceWei !== null && this._lastBalanceWei >= this._minBalanceWei * this._relaxedBalanceFactor;
  }

  /** Whether the last successful reading was below the threshold. */
  get depleted(): boolean {
    return this._depleted;
  }

  getSnapshot(): GasHealthSnapshot {
    return {
      address: this._address,
      depleted: this._depleted,
      lastBalanceWei: this._lastBalanceWei,
      lastCheckedAt: this._lastCheckedAt,
      minBalanceWei: this._minBalanceWei,
    };
  }

  /** Read the balance once and emit a change event on a threshold crossing. */
  async checkNow(): Promise<void> {
    if (this._checkInFlight) return this._checkInFlight;
    this._checkInFlight = this._check().finally(() => {
      this._checkInFlight = null;
    });
    return this._checkInFlight;
  }

  private async _check(): Promise<void> {
    let balanceWei: bigint;
    try {
      balanceWei = await this._getBalance(this._address);
    } catch (err) {
      // Can't tell anything from an unreachable RPC — keep the current state.
      debugWarn(`[GasHealth] Balance check failed for ${this._address}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (this._stopped) return;
    this._lastBalanceWei = balanceWei;
    this._lastCheckedAt = Date.now();
    this._notifyBalance(balanceWei);

    const depleted = balanceWei < this._minBalanceWei;
    if (depleted === this._depleted) return;
    this._depleted = depleted;
    this._emitChange({
      status: depleted ? 'depleted' : 'restored',
      address: this._address,
      balanceWei,
      minBalanceWei: this._minBalanceWei,
    });
  }

  private _notifyBalance(balanceWei: bigint): void {
    if (!this._onBalance) return;
    try {
      const result = this._onBalance(balanceWei);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          debugWarn(`[GasHealth] onBalance failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    } catch (err) {
      debugWarn(`[GasHealth] onBalance failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private _emitChange(event: GasHealthEvent): void {
    debugLog(
      `[GasHealth] ${event.address} ${event.status} `
      + `(${formatEther(event.balanceWei)} ETH, minimum ${formatEther(event.minBalanceWei)} ETH)`,
    );
    if (!this._onChange) return;
    try {
      const result = this._onChange(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch((err) => {
          debugWarn(`[GasHealth] onChange failed: ${err instanceof Error ? err.message : err}`);
        });
      }
    } catch (err) {
      debugWarn(`[GasHealth] onChange failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
