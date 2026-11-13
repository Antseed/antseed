#!/usr/bin/env node
// pnpm testbench:sweep <scenario> --seeds 1-5 [run flags]: seed search. Runs the scenario once per seed, each on its
// own fresh testbench (run, then down), one at a time, and prints every failure with its `rerun:` line.
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageSummary, parseSweepArgs, readRunOutput, sweepCoverage, sweepSlotArgs, sweepSlotProblem, sweepSummary } from './lib/sweep.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

/** Runs the testbench CLI, echoing its output unless `quiet`; resolves with the exit code and everything it printed. */
function testbench(args, { quiet = false } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; if (!quiet) process.stdout.write(chunk); });
    child.on('close', (code, signal) => resolveRun({ code: code ?? (signal ? 1 : 0), output }));
  });
}

async function main() {
  const { scenario, seeds, runArgs } = parseSweepArgs(process.argv.slice(2));
  const slot = sweepSlotArgs(runArgs);
  // Every seed needs a fresh testbench of the sweep's own: never reuse, and never stop, one that was already there.
  const occupied = sweepSlotProblem((await testbench(['status', '--json', ...slot], { quiet: true })).output);
  if (occupied) throw new Error(`Not starting: ${occupied}`);
  const runs = [];
  for (const seed of seeds) {
    console.log(`[sweep] ${scenario} seed ${seed} (${runs.length + 1}/${seeds.length})`);
    const { code, output } = await testbench(['run', scenario, '--seed', String(seed), ...runArgs]);
    runs.push(readRunOutput(seed, code, output));
    // A run stops the testbench it started; this covers one that ended before it could. The slot was free when the
    // sweep began, so whatever is up now is this run's.
    await testbench(['down', ...slot]);
  }
  // What each run's report says its fail points covered; a run without a report or a plan adds nothing.
  const coverages = [];
  for (const run of runs) coverages.push(run.report ? await readFile(run.report, 'utf8').then((text) => JSON.parse(text).metrics?.failpointCoverage ?? null, () => null) : null);
  const coverage = sweepCoverage(coverages);
  const lines = [...sweepSummary(scenario, runs), ...coverageSummary(coverage)];
  for (const line of lines) console.log(`[sweep] ${line}`);
  const out = process.env.ANTSEED_TESTBENCH_SWEEP_OUT;
  if (out) await writeFile(out, `${JSON.stringify({ scenario, runArgs, runs, ...(coverage ? { failpointCoverage: coverage } : {}) }, null, 2)}\n`);
  if (runs.some((run) => run.result !== 'passed')) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[sweep] ${error.message}`);
  process.exitCode = 2;
});
