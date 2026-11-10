#!/usr/bin/env node
// pnpm testbench:sweep <scenario> --seeds 1-5 [run flags]: seed search. Runs the scenario once per seed, each on its
// own fresh testbench (run, then down), one at a time, and prints every failure with its `rerun:` line.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSweepArgs, readRunOutput, sweepSummary } from './lib/sweep.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

/** Runs the testbench CLI, echoing its output; resolves with the exit code and everything it printed. */
function testbench(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.on('close', (code, signal) => resolveRun({ code: code ?? (signal ? 1 : 0), output }));
  });
}

async function main() {
  const { scenario, seeds, runArgs } = parseSweepArgs(process.argv.slice(2));
  const slot = runArgs.includes('--slot') ? ['--slot', runArgs[runArgs.indexOf('--slot') + 1]] : [];
  const runs = [];
  for (const seed of seeds) {
    console.log(`[sweep] ${scenario} seed ${seed} (${runs.length + 1}/${seeds.length})`);
    const { code, output } = await testbench(['run', scenario, '--seed', String(seed), ...runArgs]);
    runs.push(readRunOutput(seed, code, output));
    // A run stops the testbench it started; this covers one that ended before it could.
    await testbench(['down', ...slot]);
  }
  const lines = sweepSummary(scenario, runs);
  for (const line of lines) console.log(`[sweep] ${line}`);
  const out = process.env.ANTSEED_TESTBENCH_SWEEP_OUT;
  if (out) await writeFile(out, `${JSON.stringify({ scenario, runArgs, runs }, null, 2)}\n`);
  if (runs.some((run) => run.result !== 'passed')) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[sweep] ${error.message}`);
  process.exitCode = 2;
});
