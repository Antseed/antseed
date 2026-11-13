import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { devCommandRemovedMessage, registerDevCommand } from './dev.js';

async function runDev(args: string[]): Promise<{ exitCode: number | undefined; stderr: string }> {
  const program = new Command().exitOverride();
  registerDevCommand(program);
  const lines: string[] = [];
  const originalError = console.error;
  const originalExitCode = process.exitCode;
  console.error = (...parts: unknown[]) => { lines.push(parts.join(' ')); };
  try {
    process.exitCode = undefined;
    await program.parseAsync(['node', 'antseed', 'dev', ...args]);
    return { exitCode: process.exitCode as number | undefined, stderr: lines.join('\n') };
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
}

test('antseed dev exits non-zero and points to seller start and buyer start --peer', async () => {
  const { exitCode, stderr } = await runDev([]);
  assert.equal(exitCode, 1);
  assert.match(stderr, /`antseed dev` has been removed/);
  assert.match(stderr, /antseed seller start/);
  assert.match(stderr, /antseed buyer start --peer <peerId>/);
  assert.match(stderr, /https:\/\/antseed\.com\/docs\/provide\//);
  assert.doesNotMatch(stderr, /Proxy running/);
});

test('antseed dev still gives the message when called with its old --port flag', async () => {
  const { exitCode, stderr } = await runDev(['--port', '18377']);
  assert.equal(exitCode, 1);
  assert.equal(stderr.split('\n').length, devCommandRemovedMessage().length);
});

test('antseed dev is hidden from help', () => {
  const program = new Command();
  registerDevCommand(program);
  assert.doesNotMatch(program.helpInformation(), /\bdev\b/);
});
