import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadSourceConfig, resolveConfigSource } from '../lib/config.mjs';
import { parkedTransactions, watchForParkedPool } from '../lib/local-deploy.mjs';
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

  it('broadcasts one transaction at a time, so Anvil cannot park a later nonce', async () => {
    const run = await startSupervisor({ forge: 'park' });
    await run.exit(60_000);
    const script = run.foundry.started('forge').find((entry) => entry.args[0] === 'script');
    assert.ok(script.args.includes('--broadcast') && script.args.includes('--slow'), script.args.join(' '));
  });
});

describe("watching Anvil's pool while forge broadcasts", () => {
  it('counts transactions as parked only when none is ready', () => {
    assert.equal(parkedTransactions({ pending: '0x0', queued: '0x14' }), 20);
    assert.equal(parkedTransactions({ pending: '0x1', queued: '0x13' }), 0, 'a ready transaction ahead of them will be mined');
    assert.equal(parkedTransactions({ pending: '0x0', queued: '0x0' }), 0);
    assert.equal(parkedTransactions(undefined), 0);
  });

  /** A provider whose pool answers come from `looks`, one per poll (the last one repeats). */
  const poolOf = (looks) => {
    let poll = 0;
    let current = looks[0];
    return {
      send: async (method) => {
        assert.equal(method, 'txpool_status');
        current = looks[Math.min(poll, looks.length - 1)];
        poll += 1;
        if (current.error) throw new Error(current.error);
        return { pending: `0x${(current.pending ?? 0).toString(16)}`, queued: `0x${(current.queued ?? 0).toString(16)}` };
      },
      getTransactionCount: async () => current.nonce,
      getBlockNumber: async () => current.block ?? 0,
      polls: () => poll,
    };
  };
  const watch = (provider, polls = 3) => new Promise((resolveStall) => {
    const stop = watchForParkedPool(provider, { intervalMs: 5, polls, onStall: (stall) => resolveStall({ stall, stop }) });
    setTimeout(() => { stop(); resolveStall({ stall: null, stop }); }, 400);
  });

  it('reports a stall once the same parked pool was seen three times in a row', async () => {
    const provider = poolOf([{ pending: 2, queued: 3, nonce: 2 }, { queued: 20, nonce: 4, block: 4 }]);
    const { stall } = await watch(provider);
    assert.deepEqual(stall, { parked: 20, nonce: 4, block: 4 });
    const polls = provider.polls();
    await sleep(30);
    assert.equal(provider.polls(), polls, 'it stops looking once it reported');
  });

  it('does not report a pool that keeps moving, or one it cannot read', async () => {
    // Parked behind a nonce that advances: the predecessor was mined in between, so Anvil is still working.
    const moving = poolOf(Array.from({ length: 200 }, (_, index) => ({ queued: 5, nonce: index })));
    assert.equal((await watch(moving)).stall, null);
    const healthy = poolOf([{ pending: 1, queued: 19, nonce: 4 }]);
    assert.equal((await watch(healthy)).stall, null);
    const unreachable = poolOf([{ error: 'connect ECONNREFUSED' }]);
    assert.equal((await watch(unreachable)).stall, null);
  });
});
