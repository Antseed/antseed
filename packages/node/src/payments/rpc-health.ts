/**
 * Background chain-RPC reachability monitor.
 *
 * Payments must never be disabled for a whole session because the RPC was
 * unreachable for 1.5 seconds at launch: buyer-side payments only *sign*
 * off-chain (ReserveAuth / SpendingAuth) and all on-chain reads at request
 * time are best-effort. This monitor turns "is the chain reachable?" into a
 * live signal — callers keep payments enabled and consult `reachable` to skip
 * on-chain reads while the RPC is down, instead of deciding once at startup.
 *
 * Probing stops after the first success — there is no steady-state polling.
 * A later outage is re-detected on demand: call sites report observed on-chain
 * failures via `reportFailure()`, which restarts the backoff probe loop until
 * the RPC answers again. `probeNow()` runs a single re-check on demand.
 */

export type RpcHealthState = 'unknown' | 'ready' | 'unreachable';

export interface RpcHealthStatus {
  state: RpcHealthState;
  /** Millisecond timestamps; null until the first probe completes. */
  lastCheckedAt: number | null;
  lastReadyAt: number | null;
  lastError: string | null;
  /** Completed probe rounds (each round tries every configured URL). */
  attempts: number;
}

export interface RpcHealthMonitorOptions {
  /** Primary RPC URL first, then fallbacks. A round succeeds if any answers. */
  rpcUrls: string[];
  probeTimeoutMs?: number;
  /** First retry delay after a failed round; doubles up to retryMaxMs. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 60_000;

/** POST eth_chainId to one endpoint; true only for a well-formed 0x result. */
export async function probeRpcEndpoint(rpcUrl: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = await response.json() as { result?: unknown };
    return typeof payload.result === 'string' && payload.result.startsWith('0x');
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class RpcHealthMonitor {
  private readonly _rpcUrls: string[];
  private readonly _probeTimeoutMs: number;
  private readonly _retryBaseMs: number;
  private readonly _retryMaxMs: number;
  private readonly _onReady: Array<() => void> = [];

  private _state: RpcHealthState = 'unknown';
  private _lastCheckedAt: number | null = null;
  private _lastReadyAt: number | null = null;
  private _lastError: string | null = null;
  private _attempts = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _probing: Promise<boolean> | null = null;
  private _loopActive = false;
  private _stopped = false;

  constructor(options: RpcHealthMonitorOptions) {
    if (options.rpcUrls.length === 0) {
      throw new Error('RpcHealthMonitor requires at least one RPC URL');
    }
    this._rpcUrls = [...options.rpcUrls];
    this._probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this._retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this._retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  }

  /**
   * False only while the RPC is known-unreachable. 'unknown' counts as
   * reachable so the first requests are not gated on a probe that has not
   * finished — call sites tolerate their own on-chain failures.
   */
  get reachable(): boolean {
    return this._state !== 'unreachable';
  }

  status(): RpcHealthStatus {
    return {
      state: this._state,
      lastCheckedAt: this._lastCheckedAt,
      lastReadyAt: this._lastReadyAt,
      lastError: this._lastError,
      attempts: this._attempts,
    };
  }

  /** Fired on every transition into 'ready' (first success after start or after a failed run). */
  onReady(listener: () => void): void {
    this._onReady.push(listener);
  }

  /** Begin probing; retries with backoff until the first success, then stops. */
  start(): void {
    this._stopped = false;
    if (!this._loopActive) {
      void this._runProbeLoop(0);
    }
  }

  stop(): void {
    this._stopped = true;
    this._loopActive = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /**
   * Tell the monitor an on-chain read just failed. Restarts background probing
   * (with backoff) so a mid-session outage is re-detected and `reachable`
   * flips to false until the RPC answers again. No-op while a probe loop is
   * already running, so bursts of failures cost at most one probe round.
   */
  reportFailure(): void {
    if (this._stopped || this._loopActive) return;
    void this._runProbeLoop(0);
  }

  /** One on-demand probe round; updates state and returns the outcome. */
  probeNow(): Promise<boolean> {
    if (this._probing) return this._probing;
    const run = this._probeOnce().finally(() => {
      this._probing = null;
    });
    this._probing = run;
    return run;
  }

  private async _probeOnce(): Promise<boolean> {
    let ok = false;
    let lastError: string | null = null;
    for (const url of this._rpcUrls) {
      if (await probeRpcEndpoint(url, this._probeTimeoutMs)) {
        ok = true;
        break;
      }
      lastError = `no eth_chainId response from ${url} within ${this._probeTimeoutMs}ms`;
    }
    this._attempts += 1;
    this._lastCheckedAt = Date.now();
    if (ok) {
      const wasReady = this._state === 'ready';
      this._state = 'ready';
      this._lastReadyAt = this._lastCheckedAt;
      this._lastError = null;
      if (!wasReady) {
        for (const listener of this._onReady) {
          try {
            listener();
          } catch {
            // Listener errors must not break the monitor.
          }
        }
      }
    } else {
      this._state = 'unreachable';
      this._lastError = lastError;
    }
    return ok;
  }

  private async _runProbeLoop(round: number): Promise<void> {
    if (this._stopped) {
      this._loopActive = false;
      return;
    }
    this._loopActive = true;
    const ok = await this.probeNow();
    if (ok || this._stopped) {
      this._loopActive = false;
      return;
    }
    const delay = Math.min(this._retryBaseMs * 2 ** round, this._retryMaxMs);
    this._timer = setTimeout(() => {
      this._timer = null;
      void this._runProbeLoop(round + 1);
    }, delay);
    // Do not hold the process open just to re-probe a dead RPC.
    this._timer.unref?.();
  }
}
