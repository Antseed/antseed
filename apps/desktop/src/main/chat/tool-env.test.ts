import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installChatNodeShim } from './tool-env.js';

test('installChatNodeShim exposes the bundled runtime as `node`', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-node-shim-'));
  try {
    const shimDir = installChatNodeShim(process.execPath, dir, process.platform);
    const shim = path.join(shimDir, 'node');
    assert.ok(((await stat(shim)).mode & 0o111) !== 0);
    const output = execFileSync(shim, ['-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "")'], { encoding: 'utf8' });
    assert.equal(output, '1');
    installChatNodeShim(process.execPath, dir, process.platform);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installChatNodeShim quotes paths and writes a Windows launcher', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'antseed-node-shim-'));
  try {
    installChatNodeShim("C:\\Program Files\\Ant's VPR\\AntSeed VPR.exe", dir, 'win32');
    assert.equal(
      await readFile(path.join(dir, 'node'), 'utf8'),
      "#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec 'C:/Program Files/Ant'\\''s VPR/AntSeed VPR.exe' \"$@\"\n",
    );
    assert.equal(
      await readFile(path.join(dir, 'node.cmd'), 'utf8'),
      '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"C:\\Program Files\\Ant\'s VPR\\AntSeed VPR.exe" %*\r\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
