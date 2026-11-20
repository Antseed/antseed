#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const testbenchCli = resolve(repo, 'e2e/testbench/cli.mjs');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`pnpm testbench:attach [--slot NAME] [testbench up options]

Starts or reuses this worktree's routing-smoke testbench, then opens the attach-only VPR desktop.
Up options are passed to pnpm testbench up; only --slot is passed to pnpm testbench desktop.`);
  process.exit(0);
}

const slotIndex = args.indexOf('--slot');
const desktopArgs = slotIndex === -1 ? [] : ['--slot', args[slotIndex + 1]];

const run = (commandArgs) => new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [testbenchCli, ...commandArgs], { cwd: repo, env: process.env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
});

const up = await run(['up', '--scenario', 'routing-smoke', ...args]);
if (up !== 0) process.exit(up);

const desktop = await run(['desktop', ...desktopArgs]);
process.exit(desktop);
