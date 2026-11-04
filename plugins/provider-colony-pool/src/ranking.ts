/**
 * How the pool ranks its workers (docs/protocol/colony-pool.md, "Routing").
 *
 * Each worker keeps a smoothed reliability (share of dispatches that ended
 * well) and time to first byte. A failure the worker is responsible for
 * (it never answered, or dropped the connection mid-request) benches it:
 * no assignments for 30 s, doubling with each failure in a row up to
 * 10 minutes, and reset by its next success. The seller dashboard reads the
 * same state from the ledger (apps/cli seller-monitor/workers.ts).
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
}

export interface DispatchOutcome {
  ok: boolean;
  /** The failure was the worker's (no answer, dropped connection): bench it. */
  bench?: boolean;
  firstByteMs?: number;
  at: number;
}

export function newRank(): WorkerRank {
  return { reliability: null, firstByteMs: null, failures: 0, benchedUntil: 0 };
}

export function benchMs(failures: number): number {
  return Math.min(BENCH_MAX_MS, BENCH_BASE_MS * 2 ** Math.max(0, failures - 1));
}

const smooth = (previous: number | null, sample: number, start: number): number =>
  (previous ?? start) * (1 - RANK_ALPHA) + sample * RANK_ALPHA;

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

export interface RankCandidate {
  reliability: number | null;
  tokensPerSecond: number;
  /** Operator weight (COLONY_POOL_WORKER_PRIORITY), 1 by default. */
  priority: number;
  /** Share of the worker's capacity in use, 0 when idle. */
  load: number;
}

/**
 * Scores for candidates serving one service: priority × reliability × speed
 * (decode speed relative to the fastest) ÷ (1 + load). A worker with no
 * record yet gets the others' average reliability and speed, so it is
 * neither punished nor favored.
 */
export function rankScores(candidates: RankCandidate[]): number[] {
  const known = candidates.filter((c) => c.reliability !== null).map((c) => c.reliability!);
  const averageReliability = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const fastest = Math.max(0, ...candidates.map((c) => c.tokensPerSecond));
  const speeds = candidates.filter((c) => c.tokensPerSecond > 0).map((c) => c.tokensPerSecond / fastest);
  const averageSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 1;
  return candidates.map((c) => {
    const speed = c.tokensPerSecond > 0 ? c.tokensPerSecond / fastest : averageSpeed;
    return (c.priority * (c.reliability ?? averageReliability) * speed) / (1 + c.load);
  });
}

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
