#!/usr/bin/env node
// Stops the supervisor's child processes if the supervisor dies by SIGKILL. The supervisor holds this process's stdin
// open and writes one {pid, startedAt} line per child it spawns; the pipe closes however the supervisor goes.
// Anvil is why this exists: a Rust binary cannot take the parent-death preload the CLI nodes have. On a normal stop
// every child is already gone and this exits without doing anything.
import { createInterface } from 'node:readline';
import { killOwned } from './lock.mjs';

const STOP_GRACE_MS = 8000;
const children = [];
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => children.push(JSON.parse(line)));
lines.on('close', async () => {
  const results = await Promise.all(children.map(async (entry) => `${entry.pid}:${await killOwned(entry, { graceMs: STOP_GRACE_MS })}`));
  const stopped = results.filter((result) => !result.endsWith(':not-running'));
  if (stopped.length) console.log(`[reaper] ${new Date().toISOString()} supervisor gone; stopped ${stopped.join(', ')}`);
  process.exit(0);
});
