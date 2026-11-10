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
