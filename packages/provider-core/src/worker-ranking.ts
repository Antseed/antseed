/**
 * The colony pool's routing score (docs/protocol/colony-pool.md, "Routing"),
 * shared by the pool (@antseed/provider-colony-pool) and the seller
 * dashboard's Workers panel, so the order it shows is the order it routes.
 */

export interface RankCandidate {
  /** Smoothed share of dispatches that ended well, 0..1; null until the first outcome. */
  reliability: number | null;
  /** The pool's smoothed decode speed; 0 until measured. */
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
