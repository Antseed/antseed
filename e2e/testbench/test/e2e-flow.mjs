#!/usr/bin/env node
// Full testbench flow against a real Base fork: up -> run <scenario> -> down, plus isolation checks.
// Needs anvil on PATH, a built workspace and BASE_MAINNET_RPC_URL (shell or the worktree .env.local).
// Usage: node e2e/testbench/test/e2e-flow.mjs [scenario...]   (default: chat-basic)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from '../lib/manifest.mjs';
import { testbenchName, testbenchPaths, testbenchRoot, worktreeRoot } from '../lib/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '..', 'cli.mjs');
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : ['chat-basic'];
const say = (message) => console.log(`[e2e-flow] ${message}`);

/** Fingerprint of a directory tree (path, size, mtime) without reading file contents. */
async function treeFingerprint(dir) {
  const hash = createHash('sha256');
  let count = 0;
  const walk = async (path) => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(path, entry.name);
      const info = await lstat(full);
      hash.update(`${full}\0${info.size}\0${info.mtimeMs}\n`);
      count += 1;
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return { digest: hash.digest('hex'), count };
}

function listeners() {
  const result = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8' });
  return new Set(result.stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => Number(line.split(':').pop())));
}

function portOpen(port) {
  return new Promise((resolvePort) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('error', () => resolvePort(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolvePort(false); });
  });
}

function testbench(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
    child.once('exit', (code) => resolveRun(code ?? 1));
  });
}

// Must never change. buyer.state.json is excluded: a real buyer on this machine rewrites it every few seconds.
const SENSITIVE = ['identity.key', 'config.json'];

async function sensitiveFingerprint(dir) {
  const out = {};
  for (const file of SENSITIVE) {
    try { const info = await lstat(join(dir, file)); out[file] = `${info.size}:${info.mtimeMs}`; } catch { out[file] = 'absent'; }
  }
  return out;
}

/** PIDs (with commands) holding files open under a directory. */
function openersOf(dir) {
  const result = spawnSync('lsof', ['-Fpc', '+D', dir], { encoding: 'utf8' });
  const openers = new Map();
  let pid = null;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('c') && pid) openers.set(pid, line.slice(1));
  }
  return openers;
}

function ownedPids(manifest) {
  return [manifest?.supervisor?.pid, manifest?.anvil?.pid, ...(manifest?.sellers ?? []).map((seller) => seller.process?.pid)].filter(Boolean);
}

function assertNoOwnedOpeners(manifest) {
  const openers = openersOf(realAntseed);
  const ours = ownedPids(manifest).filter((pid) => openers.has(pid));
  assert.deepEqual(ours, [], `testbench processes have files open under ~/.antseed: ${ours.join(', ')}`);
  return openers;
}

function otherAnvils() {
  const result = spawnSync('pgrep', ['-x', 'anvil'], { encoding: 'utf8' });
  return new Set(result.stdout.split('\n').filter(Boolean).map(Number));
}

const worktree = worktreeRoot();
const paths = testbenchPaths(testbenchRoot(), testbenchName(worktree));
const realAntseed = join(homedir(), '.antseed');
assert.notEqual((await readJson(paths.manifest))?.running, true, `Testbench ${paths.name} is already running; stop it first (pnpm testbench down)`);

const before = { antseed: await treeFingerprint(realAntseed), sensitive: await sensitiveFingerprint(realAntseed), listeners: listeners(), anvils: otherAnvils() };
say(`~/.antseed fingerprint ${before.antseed.digest.slice(0, 12)} (${before.antseed.count} entries); ${before.anvils.size} foreign anvil process(es)`);

let failures = 0;
let downDone = false;
try {
  assert.equal(await testbench(['up']), 0, 'pnpm testbench up failed');
  const up = await readJson(paths.manifest);
  const ownedPorts = [up.anvil.port, up.proxyPort, up.bootstrap.port, ...up.sellers.map((seller) => seller.signalingPort)];
  for (const port of ownedPorts) assert.ok(!before.listeners.has(port), `testbench reused a port that was already listening: ${port}`);
  for (const port of ownedPorts) assert.ok(![6881, 6882, 8377].includes(port), `testbench used a default port ${port}`);
  say(`testbench ports: ${ownedPorts.join(', ')}`);
  assertNoOwnedOpeners(up);

  assert.equal(await testbench(['up']), 0, 'second up (reattach) failed');
  assert.equal((await readJson(paths.manifest)).supervisor.pid, up.supervisor.pid, 'up while running must reattach, not restart');
  assert.equal(await testbench(['status']), 0, 'status failed');

  for (const scenario of scenarios) {
    // Each scenario brings its own topology; run starts and stops a matching testbench when needed.
    const current = await readJson(paths.manifest);
    if (current?.running && scenario !== 'chat-basic') { await testbench(['down']); }
    const running = await readJson(paths.manifest);
    if (running?.running) assertNoOwnedOpeners(running);
    const code = await testbench(['run', scenario]);
    if (code !== 0) { failures += 1; say(`scenario ${scenario} FAILED`); } else say(`scenario ${scenario} passed`);
  }

  if ((await readJson(paths.manifest))?.running) assert.equal(await testbench(['down']), 0, 'down failed');
  downDone = true;
  const final = await readJson(paths.manifest);
  assert.equal(final.running, false, 'manifest must record running=false after down');
  for (const port of [final.anvil?.port, final.proxyPort, final.bootstrap?.port, ...final.sellers.map((seller) => seller.signalingPort)].filter(Boolean)) {
    assert.equal(await portOpen(port), false, `port ${port} still accepting connections after down`);
  }
  if (final.finalBalances) assert.equal(final.finalBalances.reservedMicroUsdc, '0', 'reserves must be zero after down');
} catch (error) {
  failures += 1;
  say(`FAILED: ${error.message}`);
} finally {
  if (!downDone && (await readJson(paths.manifest))?.running) await testbench(['down']);
}

const after = await treeFingerprint(realAntseed);
const sensitiveAfter = await sensitiveFingerprint(realAntseed);
for (const file of SENSITIVE) {
  if (sensitiveAfter[file] !== before.sensitive[file]) { failures += 1; say(`FAILED: ~/.antseed/${file} changed`); }
}
if (after.digest === before.antseed.digest) say('~/.antseed unchanged');
else {
  // Sampling open handles cannot prove the testbench never wrote and closed a file there, so a change fails by default.
  // On a machine where a real node or verifier writes ~/.antseed, ANTSEED_TESTBENCH_E2E_ALLOW_HOME_WRITES=1 turns this
  // into a note; the writers are listed either way, and identity.key/config.json changing always fails (above).
  const writers = [...openersOf(realAntseed)].map(([pid, command]) => `${pid}:${command}`);
  const detail = `~/.antseed changed (${before.antseed.count} -> ${after.count} entries); processes holding it open now: ${writers.join(', ') || 'none'}`;
  if (process.env.ANTSEED_TESTBENCH_E2E_ALLOW_HOME_WRITES === '1') say(`note: ${detail} (allowed by ANTSEED_TESTBENCH_E2E_ALLOW_HOME_WRITES=1)`);
  else { failures += 1; say(`FAILED: ${detail}; if another AntSeed process on this machine writes there, rerun with ANTSEED_TESTBENCH_E2E_ALLOW_HOME_WRITES=1`); }
}
const survivors = otherAnvils();
const killed = [...before.anvils].filter((pid) => !survivors.has(pid));
if (killed.length) { failures += 1; say(`FAILED: foreign anvil processes disappeared: ${killed.join(', ')}`); }
else say('all foreign anvil processes still alive');

say(failures ? `${failures} failure(s)` : 'all checks passed');
process.exitCode = failures ? 1 : 0;
