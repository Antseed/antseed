// Seed search: one scenario across many seeds, each on its own fresh testbench. Pure parts of `pnpm testbench:sweep`.
import { RESULT_EXIT_CODES } from './report.mjs';

export const MAX_SWEEP_SEEDS = 200;
/** Flags a sweep refuses: it starts and stops a testbench per seed, on a local chain, with mocks. */
const REFUSED = ['--seed', '--keep', '--live', '--real-funds'];

/** Seeds from `1-5`, `3,7,11` or a mix (`1-3,9`), in order, without repeats. */
export function parseSeeds(text) {
  const seeds = [];
  for (const part of String(text ?? '').split(',')) {
    const match = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`--seeds takes numbers and ranges such as 1-5 or 3,7,11 (got "${part}")`);
    const [from, to] = [Number(match[1]), Number(match[2] ?? match[1])];
    if (to < from || to >= 2 ** 32) throw new Error(`--seeds range ${part} must run upwards, below 4294967296`);
    if (seeds.length + to - from + 1 > MAX_SWEEP_SEEDS) throw new Error(`A sweep runs at most ${MAX_SWEEP_SEEDS} seeds`);
    for (let seed = from; seed <= to; seed += 1) if (!seeds.includes(seed)) seeds.push(seed);
  }
  return seeds;
}

/** `{ scenario, seeds, runArgs }` from the sweep's arguments: the scenario, --seeds, and flags passed on to every run. */
export function parseSweepArgs(argv) {
  const args = argv.filter((arg) => arg !== '--');
  const at = args.indexOf('--seeds');
  if (at === -1 || args[at + 1] === undefined) throw new Error('Usage: pnpm testbench:sweep <scenario> --seeds 1-5 [run flags, such as --chain local --seller-tree DIR]');
  const seeds = parseSeeds(args[at + 1]);
  const [scenario, ...runArgs] = [...args.slice(0, at), ...args.slice(at + 2)];
  if (!scenario || scenario.startsWith('--')) throw new Error('A sweep needs a scenario name first');
  const refused = runArgs.find((arg) => REFUSED.includes(arg) || arg === 'mainnet');
  if (refused) throw new Error(`A sweep does not take ${refused}: it runs each seed on its own fresh testbench with mock upstreams`);
  return { scenario, seeds, runArgs };
}

/** The `--slot NAME` of a sweep's run flags as arguments for `status` and `down`; nothing for the default slot. */
export function sweepSlotArgs(runArgs) {
  const at = runArgs.indexOf('--slot');
  return at !== -1 && runArgs[at + 1] !== undefined ? ['--slot', runArgs[at + 1]] : [];
}

/**
 * Why a sweep must not start, from what `pnpm testbench status --json` printed for its slot; null when the slot is
 * free. A run reuses a testbench that is already up and keeps that testbench's seed, so the first seed would not be
 * the one reported, and the sweep's `down` would stop a testbench it did not start. Output that cannot be read
 * refuses too: the sweep only starts on a slot it knows to be free.
 */
export function sweepSlotProblem(statusOutput) {
  let status;
  // Notes the CLI prints ahead of the JSON are not part of it.
  try { status = JSON.parse(String(statusOutput).slice(String(statusOutput).search(/^\{/m))); } catch { return 'could not read the testbench status of this slot'; }
  if (status?.running === false) return null;
  return `testbench ${status?.manifest?.name ?? status?.name ?? 'of this slot'} is already running: a sweep starts and stops its own testbench for every seed. Stop it with pnpm testbench down, or give the sweep a slot of its own (--slot NAME)`;
}

const RESULT_BY_CODE = Object.fromEntries(Object.entries(RESULT_EXIT_CODES).map(([result, code]) => [code, result]));

/** What one run's exit code and output say: its result, the report path, and for anything but a pass the `rerun:` line and failed checks. */
export function readRunOutput(seed, code, output) {
  const lines = output.split('\n');
  const find = (pattern) => lines.map((line) => line.match(pattern)?.[1]).filter(Boolean).at(-1) ?? null;
  return {
    seed,
    result: RESULT_BY_CODE[code] ?? `exit ${code}`,
    report: find(/(\/\S+report\.json)/),
    rerun: find(/^\[testbench\] rerun: (.+)$/),
    failed: lines.filter((line) => /^\[testbench\] FAIL /.test(line)).map((line) => line.replace(/^\[testbench\] FAIL /, '').slice(0, 300)),
    plan: find(/^\[(?:chaos|failpoint)\] plan: (.+)$/),
  };
}

/** The sweep's closing lines: one per seed, then every failure with its rerun line. */
export function sweepSummary(scenario, runs) {
  const failures = runs.filter((run) => run.result !== 'passed');
  const lines = [`Sweep of ${scenario}: ${runs.length - failures.length}/${runs.length} seeds passed`];
  // A chaos or fail point run's plan, without its numbers: what fired on that seed.
  for (const run of runs) lines.push(`  seed ${run.seed}: ${run.result}${run.plan ? `  [${run.plan.replace(/ \{.*$/, '')}]` : ''}`);
  for (const run of failures) {
    lines.push(`FAILED seed ${run.seed} (${run.result})${run.report ? `: ${run.report}` : ''}`);
    for (const check of run.failed.slice(0, 6)) lines.push(`    ${check}`);
    if (run.rerun) lines.push(`    rerun: ${run.rerun}`);
  }
  return lines;
}

/**
 * Fail point coverage of a sweep, from each run's `metrics.failpointCoverage` (`{ armed: { node: [point] }, crashes:
 * [{ node, point }] }`; `coverages` is one entry per seed, null for a run without it): per node and point, how many
 * seeds armed it and how many saw a crash there (`crashes` counts every crash), and the armed points no seed crashed
 * at. Null when no run carried a fail point plan.
 */
export function sweepCoverage(coverages) {
  const runs = coverages.filter((coverage) => coverage && typeof coverage.armed === 'object');
  if (runs.length === 0) return null;
  const points = {};
  const entry = (node, point) => (points[`${node} ${point}`] ??= { node, point, armedSeeds: 0, crashedSeeds: 0, crashes: 0 });
  for (const { armed, crashes = [] } of runs) {
    for (const [node, names] of Object.entries(armed)) for (const point of new Set(names)) entry(node, point).armedSeeds += 1;
    const seen = new Set();
    for (const { node, point } of crashes) {
      const at = entry(node, point);
      at.crashes += 1;
      if (!seen.has(`${node} ${point}`)) at.crashedSeeds += 1;
      seen.add(`${node} ${point}`);
    }
  }
  const all = Object.values(points).sort((a, b) => b.crashedSeeds - a.crashedSeeds || a.node.localeCompare(b.node) || a.point.localeCompare(b.point));
  return { seeds: runs.length, points: all, neverTriggered: all.filter((at) => at.armedSeeds > 0 && at.crashedSeeds === 0).map(({ node, point }) => ({ node, point })) };
}

/** The coverage summary's lines for the end of a sweep; none without coverage. */
export function coverageSummary(coverage) {
  if (!coverage) return [];
  const hit = coverage.points.filter((at) => at.crashedSeeds > 0);
  const lines = [`Fail point coverage over ${coverage.seeds} seed${coverage.seeds === 1 ? '' : 's'}: a crash fired at ${hit.length} of ${coverage.points.length} armed points`];
  for (const at of hit) lines.push(`  ${at.node} ${at.point}: ${at.crashedSeeds} seed${at.crashedSeeds === 1 ? '' : 's'}${at.crashes > at.crashedSeeds ? `, ${at.crashes} crashes` : ''}${at.armedSeeds === 0 ? ' (not in the armed list)' : ''}`);
  if (coverage.neverTriggered.length) lines.push(`  never triggered (${coverage.neverTriggered.length}): ${coverage.neverTriggered.map(({ node, point }) => `${node} ${point}`).join(', ')}`);
  return lines;
}
