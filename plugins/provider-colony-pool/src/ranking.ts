/**
 * How the pool ranks its workers (docs/protocol/colony-pool.md, "Routing").
 *
 * Each worker keeps a smoothed reliability (share of dispatches that ended
 * well) and time to first byte. A failure the worker is responsible for
 * (it never answered, or dropped the connection mid-request) benches it:
 * no assignments for 30 s, doubling with each failure in a row up to
 * 10 minutes, and reset by its next success. The seller dashboard reads the
 * same state from the ledger (apps/cli seller-monitor/workers.ts) and scores
 * it with the same `rankScores`.
 */

/** Weight of the newest outcome in the smoothed reliability and first-byte time. */
export const RANK_ALPHA = 0.2;
export const BENCH_BASE_MS = 30_000;
export const BENCH_MAX_MS = 10 * 60_000;

export interface WorkerRank {
  /** Smoothed share of dispatches that ended well, 0..1; null until the first outcome. */
  reliability: number | null;
  /** Smoothed time from dispatch to the response's first byte, ms; null until measured. */
  firstByteMs: number | null;
  /** Benching failures in a row; the next bench lasts BENCH_BASE_MS × 2^(failures − 1). */
  failures: number;
  /** No assignments or dispatches before this time (ms); 0 when not benched. */
  benchedUntil: number;
  /** Smoothed decode speed (output tokens per second); 0 until measured. */
  tokensPerSecond: number;
}

export interface DispatchOutcome {
  ok: boolean;
  /** The failure was the worker's (no answer, dropped connection): bench it. */
  bench?: boolean;
  firstByteMs?: number;
  at: number;
}

export function newRank(): WorkerRank {
  return { reliability: null, firstByteMs: null, failures: 0, benchedUntil: 0, tokensPerSecond: 0 };
}

export function benchMs(failures: number): number {
  return Math.min(BENCH_MAX_MS, BENCH_BASE_MS * 2 ** Math.max(0, failures - 1));
}

const smooth = (previous: number | null, sample: number, start: number): number =>
  (previous ?? start) * (1 - RANK_ALPHA) + sample * RANK_ALPHA;

/** Fold one finished request's decode speed into `rank` (mutates it). */
export function recordSpeed(rank: WorkerRank, tokensPerSecond: number): WorkerRank {
  rank.tokensPerSecond = rank.tokensPerSecond === 0 ? tokensPerSecond : smooth(rank.tokensPerSecond, tokensPerSecond, tokensPerSecond);
  return rank;
}

/** Fold one dispatch's outcome into `rank` (mutates it). */
export function recordOutcome(rank: WorkerRank, outcome: DispatchOutcome): WorkerRank {
  // Smoothing starts from a clean record, so one early failure doesn't sink a new worker.
  rank.reliability = smooth(rank.reliability, outcome.ok ? 1 : 0, 1);
  if (outcome.firstByteMs !== undefined) rank.firstByteMs = smooth(rank.firstByteMs, outcome.firstByteMs, outcome.firstByteMs);
  if (outcome.ok) {
    rank.failures = 0;
    rank.benchedUntil = 0;
  } else if (outcome.bench && outcome.at >= rank.benchedUntil) {
    // Requests that were already running when it was benched don't lengthen the bench.
    rank.failures += 1;
    rank.benchedUntil = outcome.at + benchMs(rank.failures);
  }
  return rank;
}

// The score itself is shared with the seller dashboard (@antseed/provider-core).
export { rankScores, type RankCandidate } from '@antseed/provider-core';

/** Parse COLONY_POOL_WORKER_PRIORITY: `0xaddress=weight,…`; weight 0 means never route to it. */
export function parseWorkerPriority(raw: string | undefined): Map<string, number> {
  const priorities = new Map<string, number>();
  for (const entry of (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [address, weight] = entry.split('=', 2).map((part) => part.trim());
    const value = Number(weight);
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address) || weight === undefined || !Number.isFinite(value) || value < 0) {
      throw new Error(`COLONY_POOL_WORKER_PRIORITY: "${entry}" is not address=weight (weight ≥ 0)`);
    }
    priorities.set(address.toLowerCase(), value);
  }
  return priorities;
}
