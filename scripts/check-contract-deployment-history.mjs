#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const base = process.argv.slice(2).find((argument) => argument !== '--');
if (!base) throw new Error('Usage: node scripts/check-contract-deployment-history.mjs <base-commit>');

const result = spawnSync('git', [
  'diff',
  '--name-status',
  '--diff-filter=DMRT',
  `${base}...HEAD`,
  '--',
  'packages/contracts/deployments/*/history/*.json',
], { encoding: 'utf8' });

if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr.trim() || `git diff exited with status ${result.status}`);
if (result.stdout.trim()) {
  throw new Error(`Contract deployment history is append-only; add a corrective record instead:\n${result.stdout.trim()}`);
}

console.log('Contract deployment history is append-only');
