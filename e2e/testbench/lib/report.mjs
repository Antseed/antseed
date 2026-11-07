// What a run ended as: result classes, exit codes, the rerun line and the run's provenance for report.json.
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** `pnpm testbench run` exit code per report.json `result`. */
export const RESULT_EXIT_CODES = { passed: 0, failed: 1, blocked: 2, timeout: 3, error: 4 };

export class RunTimeoutError extends Error {
  constructor(seconds) {
    super(`Scenario did not finish within ${seconds}s (--run-timeout)`);
    this.name = 'RunTimeoutError';
    this.seconds = seconds;
  }
}

/**
 * Rejects with RunTimeoutError when `run()` takes longer than `seconds`. The scenario cannot be cancelled: it
 * keeps going in the background until the process exits, so the caller must exit once it has torn down.
 */
export async function runWithTimeout(run, seconds) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new RunTimeoutError(seconds)), seconds * 1000); });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The result class of an error thrown by a scenario. `tb.check` and everything else that judges the run
 * (`checkAll`, a strict known issue, settlement verification) fail through node:assert; a timeout is its own
 * class; anything else (a failed chat, a wait that ran out, the control API) means the run broke, not a verdict.
 */
export function classifyScenarioError(error) {
  if (error instanceof RunTimeoutError) return 'timeout';
  return error?.code === 'ERR_ASSERTION' ? 'failed' : 'error';
}

/**
 * A failure after the scenario finished (closing the desktop, `down`): turns a pass into `error`, and is kept
 * next to the verdict otherwise, because the scenario's own result is the more useful one.
 */
export function recordTeardownFailure(report, error) {
  if (report.result === 'passed') Object.assign(report, { result: 'error', phase: 'teardown', error: error.message });
  else report.teardownError = error.message;
}

/** The command that replays a run. Flags that change what runs are kept; --real-funds and --live still need a yes per run. */
export function rerunCommand({ scenario, target, mode, seed, strict, budgets, slot, live }) {
  const parts = ['pnpm testbench run', scenario];
  if (target) parts.push('--chain', target);
  // Only a mode the user asked for is repeated; a topology's default mode replays by itself.
  if (mode && target !== 'mainnet') parts.push('--mode', mode);
  if (seed !== undefined && seed !== null) parts.push('--seed', seed);
  if (strict) parts.push('--strict');
  if (budgets) parts.push('--budgets');
  if (slot && slot !== 'default') parts.push('--slot', slot);
  if (live) parts.push('--live');
  if (target === 'mainnet') parts.push('--real-funds');
  return parts.join(' ');
}

/** A metric that moved by more than this against the previous run gets a DRIFT line. */
const DRIFT_ABOVE = 1.5;
const DRIFT_BELOW = 0.67;

/**
 * Every top-level numeric metric in both runs as { previous, current, ratio }. Nested metrics (per-load summaries,
 * log counters) stay out: they vary with the seed and would bury the timings. `ratio` is null when the previous
 * value was 0 and the current one is not, because no multiple describes that.
 */
export function computeDrift(previous = {}, current = {}) {
  const drift = {};
  for (const [name, value] of Object.entries(current)) {
    const before = previous[name];
    if (!Number.isFinite(value) || !Number.isFinite(before)) continue;
    const ratio = before === 0 ? (value === 0 ? 1 : null) : Number((value / before).toFixed(3));
    drift[name] = { previous: before, current: value, ratio };
  }
  return drift;
}

/** One line per metric that drifted past the thresholds. Information for whoever reads the run; nothing fails on it. */
export function driftLines(drift = {}) {
  return Object.entries(drift)
    .filter(([, { ratio }]) => ratio !== null && (ratio > DRIFT_ABOVE || ratio < DRIFT_BELOW))
    .map(([name, { previous, current, ratio }]) => `DRIFT ${name} ${previous} -> ${current} (x${ratio.toFixed(1)})`);
}

/**
 * The latest passed report.json before `currentDir` of the same scenario, mode and chain, as { dir, report }, or
 * null. Run directories start with their timestamp, so names sort by time. Only a passed run is a baseline: a
 * failed one can be fast because it skipped the work (a run whose requests went unpaid closed nothing). A chain
 * other than this run's is passed over too: a fork's RPC would swamp the comparison.
 */
export async function previousReport(reportsDir, currentDir, { scenario, mode, target }) {
  const names = await readdir(reportsDir).catch(() => []);
  const earlier = names.filter((name) => name.endsWith(`-${scenario}`) && name < currentDir).sort().reverse();
  for (const dir of earlier) {
    const report = await readFile(join(reportsDir, dir, 'report.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (report?.scenario === scenario && report.mode === mode && report.target === target && report.result === 'passed') return { dir, report };
  }
  return null;
}

/** The commit a run tested. Fields are null when git cannot answer; `dirty` means uncommitted changes were included. */
export function gitInfo(cwd) {
  const git = (...args) => {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout : null;
  };
  const status = git('status', '--porcelain');
  return { sha: git('rev-parse', 'HEAD')?.trim() ?? null, branch: git('rev-parse', '--abbrev-ref', 'HEAD')?.trim() ?? null, dirty: status === null ? null : status.trim().length > 0 };
}

/**
 * The seller mocks' ledgers for metrics.json: per `[req:TAG]` the token counts and cost, plus totals. These are
 * what two runs of one seed must agree on (`maxActive` and the like depend on wall-clock timing and are left out).
 */
export async function deliveryMetrics(sellers, control) {
  const bySeller = {};
  for (const seller of sellers) {
    if (!seller.mockUrl) continue;
    const { byTag, counts, deliveredCost, startedCost } = await control.deliveries(seller.id);
    bySeller[seller.id] = { deliveredCost, startedCost, counts, byTag };
  }
  return bySeller;
}
