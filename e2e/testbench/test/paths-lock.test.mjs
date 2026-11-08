import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { acquireLock, inspectLock, isOwnedProcessAlive, killOwned, ownProcessEntry, processStartTime, releaseLock, withLock } from '../lib/lock.mjs';
import { resetRunState, testbenchName, testbenchPaths, testbenchRoot, validateSlot } from '../lib/paths.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'testbench-'));
after(() => rm(tmp, { recursive: true, force: true }));

describe('naming', () => {
  it('derives a stable wt-<basename>-<hash> name from the worktree path', () => {
    const name = testbenchName('/Users/x/worktrees/My Feature_Branch');
    assert.match(name, /^wt-my-feature-branch-[0-9a-f]{8}$/);
    assert.equal(testbenchName('/Users/x/worktrees/My Feature_Branch'), name);
    assert.notEqual(testbenchName('/Users/y/worktrees/My Feature_Branch'), name, 'same basename, different path => different testbench');
  });

  it('appends a validated slot', () => {
    assert.equal(testbenchName('/a/b', 'two'), `${testbenchName('/a/b')}-two`);
    assert.throws(() => validateSlot('Bad Slot'), /Invalid testbench slot/);
    assert.throws(() => validateSlot('../x'), /Invalid testbench slot/);
  });

  it('refuses a testbench root inside ~/.antseed or at $HOME', () => {
    assert.equal(testbenchRoot({}, '/home/u'), '/home/u/.antseed-testbench');
    assert.throws(() => testbenchRoot({ ANTSEED_TESTBENCH_HOME: '/home/u/.antseed/tb' }, '/home/u'), /never live inside ~\/\.antseed/);
    assert.throws(() => testbenchRoot({ ANTSEED_TESTBENCH_HOME: '/home/u/.antseed' }, '/home/u'), /never live inside/);
    assert.throws(() => testbenchRoot({ ANTSEED_TESTBENCH_HOME: '/home/u' }, '/home/u'), /home directory/);
  });

  it('lays out all state under the testbench dir', () => {
    const paths = testbenchPaths('/r', 'wt-a-12345678');
    for (const key of ['home', 'anvilHome', 'buyer', 'sellers', 'config', 'logs', 'reports', 'manifest', 'lock', 'control']) {
      assert.ok(paths[key].startsWith('/r/wt-a-12345678/'), key);
    }
    assert.equal(paths.seller('s1'), '/r/wt-a-12345678/sellers/s1');
  });

  it('resetRunState clears per-run state but keeps identity keys', async () => {
    const paths = testbenchPaths(tmp, 'wt-reset-00000000');
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

  it('recovers a corrupt lock file once it is older than the grace period', async () => {
    const path = join(tmp, 'corrupt.lock');
    await writeFile(path, '{not json');
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    assert.equal((await acquireLock(path, {}, deps({ pid: 111, startedAt: starts[111] }))).state, 'acquired');
  });

  // Contenders 1000-1039 are all alive, so a lock one of them published is never stale to the others.
  const contenders = Array.from({ length: 40 }, (_, index) => ({ pid: 1000 + index, startedAt: `start-${1000 + index}` }));
  const isContender = (pid) => pid >= 1000 && pid < 1040;
  const liveDeps = (entry, extra = {}) => ({
    entry, isPidAlive: isContender, processStartTime: (pid) => (isContender(pid) ? `start-${pid}` : null), ...extra,
  });
  const race = (path, extra, count = 20) => Promise.all(contenders.slice(0, count).map((entry) => acquireLock(path, {}, liveDeps(entry, extra))));
  const assertOneOwner = async (path, results) => {
    const winners = results.filter((result) => result.state === 'acquired');
    assert.equal(winners.length, 1, `exactly one contender owns the lock (got ${winners.length})`);
    const holder = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(holder.pid, winners[0].entry.pid, 'the lock on disk is the winner\'s');
    for (const result of results.filter((entry) => entry.state === 'held')) assert.equal(result.holder.pid, holder.pid);
  };

  it('grants a free lock to exactly one of many concurrent contenders and leaves no draft files', async () => {
    for (let round = 0; round < 10; round += 1) {
      const dir = join(tmp, `free-race-${round}`);
      const path = join(dir, 'x.lock');
      await assertOneOwner(path, await race(path));
      assert.deepEqual(await readdir(dir), ['x.lock']);
    }
  });

  it('lets only one of many contenders reclaim the same stale lock', async () => {
    for (let round = 0; round < 50; round += 1) {
      const dir = join(tmp, `stale-race-${round}`);
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'x.lock');
      await writeFile(path, JSON.stringify({ pid: 999, startedAt: 'dead' }));
      await assertOneOwner(path, await race(path, {}, 40));
      assert.deepEqual(await readdir(dir), ['x.lock'], 'no stale, mutex or draft files left behind');
    }
  });

  // A promise the test resolves by hand, and a hook that parks one contender at a reclaim step until then.
  const barrier = () => { let open; const opened = new Promise((r) => { open = r; }); return { open, opened }; };
  const parkAt = (step, gate, reached) => async (current) => { if (current === step) { reached.open(); await gate.opened; } };
  const staleLock = async (name, holder = { pid: 999, startedAt: 'dead' }) => {
    const dir = join(tmp, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'x.lock');
    const text = JSON.stringify(holder);
    await writeFile(path, text);
    return { dir, path, text };
  };

  it('a contender that judged a lock stale and stalled never removes the lock another reclaimed meanwhile', async () => {
    // The schedule that broke the rename-based reclaim: A judges S stale and pauses; B reclaims S and acquires;
    // C and D contend; then A resumes. Exactly one may own the lock.
    for (let round = 0; round < 20; round += 1) {
      const { dir, path } = await staleLock(`schedule-a-${round}`);
      const gate = barrier();
      const reached = barrier();
      const a = acquireLock(path, {}, liveDeps(contenders[0], { onReclaimStep: parkAt('judged-stale', gate, reached) }));
      await reached.opened;
      const b = await acquireLock(path, {}, liveDeps(contenders[1]));
      assert.equal(b.state, 'acquired');
      const others = Promise.all([contenders[2], contenders[3]].map((entry) => acquireLock(path, {}, liveDeps(entry))));
      gate.open();
      await assertOneOwner(path, [await a, b, ...(await others)]);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, contenders[1].pid, 'B still owns it');
      assert.deepEqual(await readdir(dir), ['x.lock']);
    }
  });

  it('nobody acquires while a live reclaimer holds the reclaim mutex, and exactly one does after', async () => {
    for (let round = 0; round < 20; round += 1) {
      const { dir, path } = await staleLock(`schedule-b-${round}`);
      const gate = barrier();
      const reached = barrier();
      const a = acquireLock(path, {}, liveDeps(contenders[0], { onReclaimStep: parkAt('mutex-held', gate, reached) }));
      await reached.opened;
      const settled = [];
      const others = contenders.slice(1, 4).map((entry) => acquireLock(path, {}, liveDeps(entry)).then((result) => { settled.push(result); return result; }));
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(settled, [], 'the others wait: the stale lock is still in place and the mutex owner is alive');
      gate.open();
      await assertOneOwner(path, await Promise.all([a, ...others]));
      assert.deepEqual(await readdir(dir), ['x.lock']);
    }
  });

  it('a dead reclaimer does not block recovery, and its mutex is cleaned up', async () => {
    const { dir, path, text } = await staleLock('dead-reclaimer');
    const key = createHash('sha256').update(text).digest('hex').slice(0, 16);
    await writeFile(`${path}.reclaim-${key}-0`, JSON.stringify({ pid: 998, startedAt: 'dead too' }));
    await assertOneOwner(path, await race(path, {}, 20));
    assert.deepEqual(await readdir(dir), ['x.lock']);
  });

  it('says a filesystem without hard links cannot hold the lock, and leaves no draft behind', async () => {
    const dir = join(tmp, 'nolink');
    for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
      const link = async () => { throw Object.assign(new Error(code), { code }); };
      await assert.rejects(acquireLock(join(dir, 'x.lock'), {}, liveDeps(contenders[0], { link })), new RegExp(`needs a filesystem with hard links \\(link\\(\\) failed with ${code}\\)`));
    }
    assert.deepEqual(await readdir(dir), []);
  });

  it('a reader never sees a partially written lock from this module', async () => {
    const path = join(tmp, 'reader.lock');
    const seen = [];
    const reads = (async () => {
      for (let i = 0; i < 200; i += 1) {
        const text = await readFile(path, 'utf8').catch(() => null);
        if (text !== null) seen.push(text);
        await new Promise((r) => setImmediate(r));
      }
    })();
    for (let i = 0; i < 20; i += 1) {
      const result = await acquireLock(path, { padding: 'x'.repeat(64 * 1024) }, liveDeps(contenders[i % 20]));
      assert.equal(result.state, 'acquired');
      await releaseLock(path, result.entry);
    }
    await reads;
    for (const text of seen) assert.doesNotThrow(() => JSON.parse(text));
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

  it('reads process start times independent of the shell locale', () => {
    const original = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_TIME: process.env.LC_TIME };
    try {
      Object.assign(process.env, { LANG: 'de_DE.UTF-8', LC_TIME: 'de_DE.UTF-8' });
      delete process.env.LC_ALL;
      const expected = process.platform === 'linux' ? /^boot\+\d+$/ : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) /;
      assert.match(processStartTime(process.pid), expected);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
