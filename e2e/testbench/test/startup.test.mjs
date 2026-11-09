import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadSourceConfig, resolveConfigSource } from '../lib/config.mjs';
import { inspectLock, isPidAlive, ownProcessEntry } from '../lib/lock.mjs';
import { testbenchName, testbenchPaths, worktreeRoot } from '../lib/paths.mjs';
import { normalizeTopology } from '../lib/topology.mjs';
import { fakeFoundry } from './fake-foundry.mjs';

// The real supervisor, started the way `up` starts it, with stand-ins for anvil and forge on PATH (fake-foundry.mjs).
// Nothing here needs Foundry, a build or the network: every start fails before the supervisor loads the node.
const here = dirname(fileURLToPath(import.meta.url));
const supervisor = join(here, '..', 'supervisor.mjs');
const cli = join(here, '..', 'cli.mjs');
const worktree = worktreeRoot();
const name = testbenchName(worktree);
const source = (await loadSourceConfig(resolveConfigSource({ worktree }))).cleaned;
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const cleanups = [];
after(async () => { for (const cleanup of cleanups) await cleanup(); });

/** Starts the supervisor on a fresh state directory. `forge` is the stand-in forge's behaviour; `plan` overrides plan.json. */
async function startSupervisor({ forge, plan = {} }) {
  const home = await mkdtemp(join(tmpdir(), 'tb-startup-'));
  const foundry = fakeFoundry();
  const paths = testbenchPaths(home, name);
  await mkdir(paths.config, { recursive: true });
  await writeFile(join(paths.config, 'plan.json'), JSON.stringify({
    worktree, trees: { seller: { path: worktree }, buyer: { path: worktree } }, target: 'local', mode: 'sdk', seed: 1, starter: ownProcessEntry(), idleMinutes: 120,
    topology: normalizeTopology({}, source, { contracts: 'payments' }), upstream: 'mock', liveKeys: [], verbose: false, configHash: 'test', configOrigin: 'test', cacheHome: join(home, '.cache'),
    ...plan,
  }));
  const child = spawn(process.execPath, [supervisor, home, name], { env: foundry.env(forge), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { log += chunk.toString('utf8'); });
  const exited = once(child, 'exit');
  cleanups.push(async () => {
    // A supervisor a failed test left behind; its reaper then stops the stand-ins it started.
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await rm(home, { recursive: true, force: true });
    await rm(foundry.dir, { recursive: true, force: true });
  });
  return {
    home, paths, foundry, child, log: () => log,
    manifest: async () => JSON.parse(await readFile(paths.manifest, 'utf8')),
    /** The supervisor's exit code, or a failed assertion when it is still starting after `withinMs`. */
    async exit(withinMs) {
      let timer;
      const result = await Promise.race([exited, new Promise((resolveLate) => { timer = setTimeout(() => resolveLate(null), withinMs); })]);
      clearTimeout(timer);
      if (!result) assert.fail(`the supervisor was still starting after ${withinMs / 1000} s; its log:\n${log}`);
      return result[0];
    },
    /** Waits until the stand-in forge has started (the start is then inside the local deploy). */
    async forgeStarted() {
      for (let attempt = 0; attempt < 300 && !foundry.started('forge').length; attempt += 1) await sleep(100);
      assert.ok(foundry.started('forge').length, `forge was never started; supervisor log:\n${log}`);
    },
  };
}

function cliRun(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ANTSEED_TESTBENCH_HOME: home }, timeout: 120_000 });
}

/** A failed start left nothing behind: every stand-in it started is gone, the slot is free, and the manifest says stopped. */
async function assertFreed(run) {
  const tools = [...run.foundry.started('anvil'), ...run.foundry.started('forge')];
  assert.ok(tools.length >= 2, 'anvil and forge both ran');
  assert.deepEqual(tools.filter((tool) => isPidAlive(tool.pid)), [], 'anvil and forge are stopped');
  assert.equal((await inspectLock(run.paths.lock)).state, 'free', 'the slot lock is released');
  const manifest = await run.manifest();
  assert.equal(manifest.running, false);
  assert.equal(manifest.starting, false);
  assert.ok(manifest.stoppedAt, 'the manifest records the stop');
  assert.deepEqual(manifest.shutdownErrors, []);
  return manifest;
}

describe('a start that cannot finish fails by itself', () => {
  it('a deploy whose transactions Anvil never mines ends the start with the reason, and the slot is free again', async () => {
    const run = await startSupervisor({ forge: 'park' });
    assert.equal(await run.exit(60_000), 1, run.log());
    const manifest = await assertFreed(run);
    assert.match(manifest.startError, /Deploy\.s\.sol stalled: Anvil stopped mining with 20 transactions parked in its pool \(deployer nonce 4, block 4\)/);
    assert.match(run.log(), /FAILED: Error: Deploy\.s\.sol stalled/);
    assert.match(run.log(), /Stopped cleanly/);
    // The next commands need no --force: the testbench is simply not running.
    const down = cliRun(run.home, 'down');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stdout, /is not running \(its last start failed: Deploy\.s\.sol stalled/);
    const status = cliRun(run.home, 'status', '--json');
    assert.deepEqual(JSON.parse(status.stdout), { name, running: false, lock: 'free' });
  });
});
