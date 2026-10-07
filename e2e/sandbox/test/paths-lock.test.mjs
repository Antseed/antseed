import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { acquireLock, inspectLock, isOwnedProcessAlive, killOwned, ownProcessEntry, releaseLock, withLock } from '../lib/lock.mjs';
import { resetRunState, sandboxName, sandboxPaths, sandboxRoot, validateSlot } from '../lib/paths.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'sandbox-test-'));
after(() => rm(tmp, { recursive: true, force: true }));

describe('naming', () => {
  it('derives a stable wt-<basename>-<hash> name from the worktree path', () => {
    const name = sandboxName('/Users/x/worktrees/My Feature_Branch');
    assert.match(name, /^wt-my-feature-branch-[0-9a-f]{8}$/);
    assert.equal(sandboxName('/Users/x/worktrees/My Feature_Branch'), name);
    assert.notEqual(sandboxName('/Users/y/worktrees/My Feature_Branch'), name, 'same basename, different path => different sandbox');
  });

  it('appends a validated slot', () => {
    assert.equal(sandboxName('/a/b', 'two'), `${sandboxName('/a/b')}-two`);
    assert.throws(() => validateSlot('Bad Slot'), /Invalid sandbox slot/);
    assert.throws(() => validateSlot('../x'), /Invalid sandbox slot/);
  });

  it('refuses a sandbox root inside ~/.antseed or at $HOME', () => {
    assert.equal(sandboxRoot({}, '/home/u'), '/home/u/.antseed-sandbox');
    assert.throws(() => sandboxRoot({ ANTSEED_SANDBOX_HOME: '/home/u/.antseed/sb' }, '/home/u'), /never live inside ~\/\.antseed/);
    assert.throws(() => sandboxRoot({ ANTSEED_SANDBOX_HOME: '/home/u/.antseed' }, '/home/u'), /never live inside/);
    assert.throws(() => sandboxRoot({ ANTSEED_SANDBOX_HOME: '/home/u' }, '/home/u'), /home directory/);
  });

  it('lays out all state under the sandbox dir', () => {
    const paths = sandboxPaths('/r', 'wt-a-12345678');
    for (const key of ['home', 'anvilHome', 'buyer', 'sellers', 'config', 'logs', 'reports', 'manifest', 'lock', 'control']) {
      assert.ok(paths[key].startsWith('/r/wt-a-12345678/'), key);
    }
    assert.equal(paths.seller('s1'), '/r/wt-a-12345678/sellers/s1');
  });

  it('resetRunState clears per-run state but keeps identity keys', async () => {
    const paths = sandboxPaths(tmp, 'wt-reset-00000000');
    await mkdir(join(paths.buyer, 'payments'), { recursive: true });
    await mkdir(paths.seller('s1'), { recursive: true });
    await mkdir(join(paths.home, '.antseed'), { recursive: true });
    await writeFile(join(paths.buyer, 'identity.key'), 'buyer');
    await writeFile(join(paths.buyer, 'payments', 'channels.db'), 'x');
    await writeFile(join(paths.seller('s1'), 'identity.key'), 'seller');
    await writeFile(join(paths.seller('s1'), 'metering.db'), 'x');
    await mkdir(paths.reports, { recursive: true });
    await writeFile(join(paths.reports, 'keep.json'), '{}');
    const removed = await resetRunState(paths);
    assert.equal(removed.length, 2);
    assert.equal(await readFile(join(paths.buyer, 'identity.key'), 'utf8'), 'buyer');
    assert.equal(await readFile(join(paths.seller('s1'), 'identity.key'), 'utf8'), 'seller');
    await assert.rejects(readFile(join(paths.seller('s1'), 'metering.db')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(paths.home, '.antseed', 'x')), { code: 'ENOENT' });
    assert.equal(await readFile(join(paths.reports, 'keep.json'), 'utf8'), '{}', 'reports survive');
  });
});

describe('locks', () => {
  const alive = new Set([111]);
  const starts = { 111: 'Mon Oct  5 10:00:00 2026' };
  const deps = (entry) => ({ entry, isPidAlive: (pid) => alive.has(pid), processStartTime: (pid) => starts[pid] ?? null });

  it('acquires, reports held for a live owner, and releases only for the owner', async () => {
    const path = join(tmp, 'a.lock');
    const owner = { pid: 111, startedAt: starts[111] };
    assert.equal((await acquireLock(path, {}, deps(owner))).state, 'acquired');
    const second = await acquireLock(path, {}, deps({ pid: 222, startedAt: 'x' }));
    assert.equal(second.state, 'held');
    assert.equal(second.holder.pid, 111);
    assert.equal((await inspectLock(path, deps(owner))).state, 'held');
    assert.equal(await releaseLock(path, { pid: 222, startedAt: 'x' }), false);
    assert.equal(await releaseLock(path, owner), true);
    assert.equal((await inspectLock(path, deps(owner))).state, 'free');
  });

  it('recovers a stale lock from a dead pid', async () => {
    const path = join(tmp, 'dead.lock');
    await writeFile(path, JSON.stringify({ pid: 999, startedAt: 'whenever' }));
    assert.equal((await inspectLock(path, deps({}))).state, 'stale');
    const result = await acquireLock(path, {}, deps({ pid: 111, startedAt: starts[111] }));
    assert.equal(result.state, 'acquired');
    assert.equal(result.recoveredStale, true);
  });

  it('treats a reused pid (different start time) as stale', async () => {
    const path = join(tmp, 'reuse.lock');
    await writeFile(path, JSON.stringify({ pid: 111, startedAt: 'Sun Oct  4 09:00:00 2026' }));
    assert.equal((await inspectLock(path, deps({}))).state, 'stale');
    assert.equal(isOwnedProcessAlive({ pid: 111, startedAt: 'Sun Oct  4 09:00:00 2026' }, deps({})), false);
    assert.equal(isOwnedProcessAlive({ pid: 111, startedAt: starts[111] }, deps({})), true);
    assert.equal(isOwnedProcessAlive({ pid: 111 }, deps({})), false, 'no start time => never owned');
  });

  it('recovers a corrupt lock file', async () => {
    const path = join(tmp, 'corrupt.lock');
    await writeFile(path, '{not json');
    assert.equal((await acquireLock(path, {}, deps({ pid: 111, startedAt: starts[111] }))).state, 'acquired');
  });

  it('withLock serializes and always releases', async () => {
    const path = join(tmp, 'with.lock');
    await assert.rejects(withLock(path, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await withLock(path, async () => 42), 42);
  });

  it('killOwned never signals a process whose start time does not match', async () => {
    const signals = [];
    const kill = (pid, signal) => signals.push([pid, signal]);
    assert.equal(await killOwned({ pid: 111, startedAt: 'other' }, { deps: { ...deps({}), kill } }), 'not-running');
    assert.equal(await killOwned({ pid: 333, startedAt: 'x' }, { deps: { ...deps({}), kill } }), 'not-running');
    assert.deepEqual(signals, []);
    const killDeps = { ...deps({}), kill: (pid, signal) => { signals.push([pid, signal]); alive.delete(pid); } };
    assert.equal(await killOwned({ pid: 111, startedAt: starts[111] }, { deps: killDeps }), 'terminated');
    assert.deepEqual(signals, [[111, 'SIGTERM']]);
  });

  it('records the real start time of this process', () => {
    const entry = ownProcessEntry();
    assert.equal(entry.pid, process.pid);
    assert.ok(entry.startedAt);
    assert.equal(isOwnedProcessAlive(entry), true);
  });
});
