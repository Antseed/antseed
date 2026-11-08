import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadSourceConfig, resolveConfigSource } from '../lib/config.mjs';
import { ownProcessEntry } from '../lib/lock.mjs';
import { MANIFEST_VERSION, shutdownProblems } from '../lib/manifest.mjs';
import { testbenchName, testbenchPaths, worktreeRoot } from '../lib/paths.mjs';
import { applyCheckVerdict } from '../lib/report.mjs';
import { stressTopology } from '../lib/stress.mjs';
import { normalizeTopology } from '../lib/topology.mjs';

// A "running" testbench here is only a manifest and a lock held by this test process: the CLI sees it as running,
// and nothing is started. A refusal must come before the CLI ever talks to it.
const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const worktree = worktreeRoot();
const source = (await loadSourceConfig(resolveConfigSource({ worktree }))).cleaned;
const homes = [];
after(() => Promise.all(homes.map((home) => rm(home, { recursive: true, force: true }))));

async function fakeTestbench({ lock, ...manifest }) {
  const home = await mkdtemp(join(tmpdir(), 'tb-reuse-'));
  homes.push(home);
  const name = testbenchName(worktree);
  const paths = testbenchPaths(home, name);
  await mkdir(paths.config, { recursive: true });
  // `lock: null` leaves no lock file (a supervisor that stopped and released it).
  if (lock !== null) await writeFile(paths.lock, JSON.stringify(lock ?? ownProcessEntry()));
  await writeFile(paths.manifest, JSON.stringify({
    version: MANIFEST_VERSION, name, target: 'local', mode: 'sdk', running: true, starter: null, seed: 1, upstream: 'mock',
    dir: paths.dir, worktree, sellers: [], topology: normalizeTopology({}, source), ...manifest,
  }));
  return { home, paths };
}

function cliRun(home, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ANTSEED_TESTBENCH_HOME: home }, timeout: 60_000 });
}

async function lastReport(paths) {
  const runs = (await readdir(paths.reports)).sort();
  return JSON.parse(await readFile(join(paths.reports, runs.at(-1), 'report.json'), 'utf8'));
}

describe('reusing a running testbench', () => {
  it('a run without --live refuses a live-upstream testbench', async () => {
    const { home, paths } = await fakeTestbench({ upstream: 'live' });
    const run = cliRun(home, 'run', 'chat-basic', '--chain', 'local');
    assert.equal(run.status, 2, run.stdout + run.stderr);
    const report = await lastReport(paths);
    assert.equal(report.result, 'blocked');
    assert.match(report.error, /running with a live upstream, not mock \(this command has no --live\); run pnpm testbench down first or use --slot/);
  });

  it('up without --live refuses to reattach to a live-upstream testbench, and up --live to a mock one', async () => {
    const live = await fakeTestbench({ upstream: 'live' });
    const up = cliRun(live.home, 'up', '--chain', 'local');
    assert.equal(up.status, 1, up.stdout + up.stderr);
    assert.match(up.stderr, /running with a live upstream, not mock/);
    const mock = await fakeTestbench({ upstream: 'mock' });
    const upLive = cliRun(mock.home, 'up', '--chain', 'local', '--live');
    assert.equal(upLive.status, 1, upLive.stdout + upLive.stderr);
    assert.match(upLive.stderr, /running with a mock upstream, not live/);
  });

  it('a run whose topology differs in payment settings refuses, naming them', async () => {
    const { home, paths } = await fakeTestbench({ mode: 'cli', topology: normalizeTopology(stressTopology(), source) });
    const run = cliRun(home, 'run', 'stress-smallreserve', '--chain', 'local');
    assert.equal(run.status, 2, run.stdout + run.stderr);
    const report = await lastReport(paths);
    assert.equal(report.result, 'blocked');
    assert.match(report.error, /does not match scenario stress-smallreserve .*differs in buyer\.maxPerRequestMicros, buyer\.maxReserveMicros; run pnpm testbench down first or use --slot/);
  });
});

describe('down', () => {
  const deadLock = { pid: 2 ** 22 - 3, startedAt: 'long ago' };

  it('exits non-zero when the shutdown reported errors', async () => {
    const { home } = await fakeTestbench({ lock: deadLock, shutdownErrors: ['settle and close channels: RPC timeout'] });
    const down = cliRun(home, 'down');
    assert.equal(down.status, 1, down.stdout + down.stderr);
    assert.match(down.stderr, /stopped with problems: settle and close channels: RPC timeout/);
  });

  it('exits 0 after a clean stop', async () => {
    const { home } = await fakeTestbench({ lock: deadLock });
    const down = cliRun(home, 'down');
    assert.equal(down.status, 0, down.stdout + down.stderr);
    assert.match(down.stdout, /stopped$/m);
  });

  it('exits non-zero for a shutdown that already finished with errors (free lock, stopped manifest)', async () => {
    // The watchdog (or an earlier down) ran the shutdown, recorded its failure and released the lock.
    const { home } = await fakeTestbench({ lock: null, running: false, stoppedAt: '2026-11-07T00:00:00Z', shutdownErrors: ['settle and close channels: RPC timeout'] });
    const down = cliRun(home, 'down');
    assert.equal(down.status, 1, down.stdout + down.stderr);
    assert.match(down.stderr, /is not running, but its last shutdown had problems: settle and close channels: RPC timeout/);
  });

  it('exits non-zero for locked reserve recorded by a completed shutdown, even with a stale lock', async () => {
    const { home } = await fakeTestbench({
      lock: deadLock, running: false, stoppedAt: '2026-11-07T00:00:00Z', shutdownErrors: [],
      finalBalances: { availableMicroUsdc: '9000000', reservedMicroUsdc: '1000000' }, closeResults: { seller: 'seller-offline' },
    });
    const down = cliRun(home, 'down');
    assert.equal(down.status, 1, down.stdout + down.stderr);
    assert.match(down.stderr, /buyer reserve still locked after closing channels: 1000000 micro-USDC \(seller seller was offline at shutdown, so its channel was not closed; a scenario must restart stopped sellers or close their channels before it ends\)/);
  });

  it('a clean stop stays exit 0 when down is repeated', async () => {
    const { home } = await fakeTestbench({
      lock: null, running: false, stoppedAt: '2026-11-07T00:00:00Z', shutdownErrors: [],
      finalBalances: { availableMicroUsdc: '9999964', reservedMicroUsdc: '0' }, closeResults: { seller: 'closed' },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const down = cliRun(home, 'down');
      assert.equal(down.status, 0, down.stdout + down.stderr);
      assert.match(down.stdout, /is not running$/m);
    }
  });

  it('judges locked reserve only from balances the shutdown recorded after closing, and says why', () => {
    assert.deepEqual(shutdownProblems(null), []);
    assert.deepEqual(shutdownProblems({ shutdownErrors: [], finalBalances: { reservedMicroUsdc: '0' } }), []);
    assert.deepEqual(shutdownProblems({ shutdownErrors: ['anvil: x'] }), ['anvil: x']);
    assert.deepEqual(shutdownProblems({ shutdownErrors: [] }), [], 'a stop that never closed channels (SIGKILL) has no balances to judge');
    const reserved = { shutdownErrors: ['settle and close channels: RPC timeout'], finalBalances: { availableMicroUsdc: '9000000', reservedMicroUsdc: '1000000' } };
    assert.deepEqual(shutdownProblems(reserved), ['settle and close channels: RPC timeout', 'buyer reserve still locked after closing channels: 1000000 micro-USDC']);
    const offline = { finalBalances: { reservedMicroUsdc: '5' }, closeResults: { a: 'closed', b: 'seller-offline', c: 'no-channel' } };
    assert.match(shutdownProblems(offline)[0], /5 micro-USDC \(seller b was offline at shutdown, so its channel was not closed; a scenario must restart/);
    assert.match(shutdownProblems({ finalBalances: { reservedMicroUsdc: '5' }, closeResults: { a: 'buyer-offline' } })[0], /the buyer was offline at shutdown/);
  });
});

describe('verdict', () => {
  it('a resolved run with a failed check is failed, and a failed known issue only under --strict', () => {
    const swallowed = applyCheckVerdict({ result: 'passed', checks: [{ name: 'a', ok: true }, { name: 'paid', ok: false }, { name: 'b', ok: false }], knownIssues: [] });
    assert.deepEqual([swallowed.result, swallowed.phase, swallowed.error], ['failed', 'scenario', 'check failed: paid']);
    const known = () => ({ result: 'passed', checks: [{ name: 'a', ok: true }], knownIssues: [{ name: 'json flag', ok: false }] });
    assert.equal(applyCheckVerdict(known()).result, 'passed');
    assert.deepEqual(applyCheckVerdict(known(), { strict: true }).error, 'known issue failed under --strict: json flag');
    assert.equal(applyCheckVerdict({ result: 'passed', checks: [{ name: 'a', ok: true }], knownIssues: [] }).result, 'passed');
    const errored = { result: 'error', error: 'boom', checks: [{ name: 'x', ok: false }] };
    assert.equal(applyCheckVerdict(errored).error, 'boom', 'an earlier verdict is kept');
  });
});
