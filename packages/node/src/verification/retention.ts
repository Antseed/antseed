import { debugLog, debugWarn } from '../utils/debug.js';
import type { VerificationSamplePruneResult, VerificationSampler } from './samples.js';
import type { VerificationStorage } from './storage.js';

const HOUR_MS = 60 * 60_000;

/**
 * ResponseAuth rows are read only right after they are written: the verifier
 * (`antseed verifier run`) polls for its own request's row for at most its
 * `responseAuthWaitTimeoutMs` (35 s by default) and copies the signed
 * preimages into its evidence files, and routing reacts to the in-memory
 * `response-auth` event, not the table. A sample's manifest carries its own
 * signed ResponseAuth, so samples do not need the row either. A day is ample
 * margin for those readers and for an operator looking into a recent verdict.
 */
export const DEFAULT_RESPONSE_AUTH_RETENTION_MS = 24 * HOUR_MS;
/** The first pass waits until the buyer has finished starting. */
export const VERIFICATION_PRUNE_STARTUP_DELAY_MS = 60_000;
export const VERIFICATION_PRUNE_INTERVAL_MS = HOUR_MS;

export interface VerificationRetentionOptions {
  storage: Pick<VerificationStorage, 'pruneResponseAuthsOlderThan'> | null;
  sampler: Pick<VerificationSampler, 'prune'> | null;
  /** Rows received longer ago than this are deleted. 0 keeps rows of any age. Default: 24 hours. */
  responseAuthRetentionMs?: number;
  startupDelayMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export interface VerificationPruneResult {
  responseAuthsDeleted: number;
  samples: VerificationSamplePruneResult | null;
}

/**
 * Keeps the buyer's verification stores bounded: the `response_auths` table
 * by age and the evidence samples by age, total size and count. Runs once
 * shortly after start and then every interval on an unref'd timer; `stop()`
 * cancels the timer, aborts a pass in progress and waits for it, so the
 * stores can be closed safely afterwards.
 */
export class VerificationRetention {
  private readonly _storage: VerificationRetentionOptions['storage'];
  private readonly _sampler: VerificationRetentionOptions['sampler'];
  private readonly _responseAuthRetentionMs: number;
  private readonly _startupDelayMs: number;
  private readonly _intervalMs: number;
  private readonly _now: () => number;
  private readonly _abort = new AbortController();
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _run: Promise<unknown> | null = null;
  private _stopped = false;

  constructor(options: VerificationRetentionOptions) {
    this._storage = options.storage;
    this._sampler = options.sampler;
    const retention = options.responseAuthRetentionMs;
    this._responseAuthRetentionMs = retention === undefined || !Number.isFinite(retention) || retention < 0
      ? DEFAULT_RESPONSE_AUTH_RETENTION_MS
      : retention;
    this._startupDelayMs = Math.max(0, options.startupDelayMs ?? VERIFICATION_PRUNE_STARTUP_DELAY_MS);
    this._intervalMs = Math.max(1, options.intervalMs ?? VERIFICATION_PRUNE_INTERVAL_MS);
    this._now = options.now ?? Date.now;
  }

  start(): void {
    if (this._stopped || this._timer || this._run) return;
    this._schedule(this._startupDelayMs);
  }

  /** One pass over both stores. A failing store is logged and never throws. */
  async runOnce(): Promise<VerificationPruneResult> {
    const signal = this._abort.signal;
    const now = this._now();
    const result: VerificationPruneResult = { responseAuthsDeleted: 0, samples: null };
    if (this._storage && this._responseAuthRetentionMs > 0) {
      try {
        result.responseAuthsDeleted = await this._storage.pruneResponseAuthsOlderThan(
          now - this._responseAuthRetentionMs,
          { signal },
        );
        if (result.responseAuthsDeleted > 0) {
          debugLog(`[Verification] Pruned ${result.responseAuthsDeleted} expired ResponseAuth record(s)`);
        }
      } catch (err) {
        debugWarn(`[Verification] ResponseAuth prune failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (this._sampler && !signal.aborted) {
      try {
        result.samples = await this._sampler.prune({ now, signal });
        if (result.samples.deletedSamples > 0) {
          debugLog(`[Verification] Pruned ${result.samples.deletedSamples} evidence sample(s) (${result.samples.deletedBytes} bytes)`);
        }
      } catch (err) {
        debugWarn(`[Verification] Evidence sample prune failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return result;
  }

  async stop(): Promise<void> {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._abort.abort();
    await this._run;
  }

  private _schedule(delayMs: number): void {
    this._timer = setTimeout(() => {
      this._timer = null;
      this._run = this.runOnce().finally(() => {
        this._run = null;
        if (!this._stopped) this._schedule(this._intervalMs);
      });
    }, delayMs);
    this._timer.unref?.();
  }
}
