#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const sandboxCli = resolve(repo, 'e2e/sandbox/cli.mjs');
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`pnpm sandbox:attach [--slot NAME] [sandbox up options]

Starts or reuses this worktree's routing-smoke sandbox, then opens the attach-only VPR desktop.
Up options are passed to pnpm sandbox up; only --slot is passed to pnpm sandbox desktop.`);
  process.exit(0);
}

const slotIndex = args.indexOf('--slot');
const desktopArgs = slotIndex === -1 ? [] : ['--slot', args[slotIndex + 1]];

const run = (commandArgs) => new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, [sandboxCli, ...commandArgs], { cwd: repo, env: process.env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
});

const up = await run(['up', '--scenario', 'routing-smoke', ...args]);
if (up !== 0) process.exit(up);

const desktop = await run(['desktop', ...desktopArgs]);
process.exit(desktop);
