import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { acquireLock } from '../lib/lock.mjs';
import { testbenchPaths } from '../lib/paths.mjs';
import { cleanupStale, settleSlot } from '../lib/stale.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'testbench-stale-'));
after(() => rm(tmp, { recursive: true, force: true }));

// pid 111 is the dead supervisor the cleanup judged stale; 222 is a replacement that is alive; 999 runs the cleanup.
const OLD = { pid: 111, startedAt: 'old' };
const NEW = { pid: 222, startedAt: 'new' };
const CLEANER = { pid: 999, startedAt: 'cleaner' };
const alive = new Set([NEW.pid, CLEANER.pid]);
const lockDeps = (entry = CLEANER) => ({ entry, isPidAlive: (pid) => alive.has(pid), processStartTime: (pid) => ({ 222: 'new', 999: 'cleaner' })[pid] ?? null });
const readText = (path) => readFile(path, 'utf8');

async function slot(name, { lockHolder = OLD, manifest = { running: true, supervisor: OLD, seed: 1 }, control = { url: 'http://127.0.0.1:1', token: 'old-token' } } = {}) {
  const paths = testbenchPaths(tmp, name);
  await mkdir(paths.dir, { recursive: true });
  if (lockHolder) await writeFile(paths.lock, JSON.stringify(lockHolder));
  await writeFile(paths.manifest, JSON.stringify(manifest));
  await writeFile(paths.control, JSON.stringify(control));
  return paths;
}

/** A replacement supervisor taking the slot: its lock, control token and running manifest. */
async function replacementStarts(paths) {
  const lock = await acquireLock(paths.lock, { role: 'supervisor' }, lockDeps(NEW));
  assert.equal(lock.state, 'acquired');
  await writeFile(paths.control, JSON.stringify({ url: 'http://127.0.0.1:2', token: 'new-token' }));
  await writeFile(paths.manifest, JSON.stringify({ running: true, supervisor: NEW, seed: 2 }));
}

describe('cleanupStale', () => {
  it('resets control and manifest as the slot owner, then releases the slot', async () => {
    const paths = await slot('wt-clean-00000000');
    const killed = [];
    const { results, slot: outcome } = await cleanupStale(paths, { running: true, supervisor: OLD }, { lockDeps: lockDeps(), killOwned: async (entry) => { killed.push(entry.pid); return 'not-running'; } });
    assert.deepEqual(results, ['111:not-running']);
    assert.equal(outcome, 'reset');
    assert.deepEqual(killed, [111]);
    assert.deepEqual(JSON.parse(await readText(paths.control)), {});
    const manifest = JSON.parse(await readText(paths.manifest));
    assert.equal(manifest.running, false);
    assert.equal(typeof manifest.staleCleanedAt, 'string');
    assert.equal((await readdir(paths.dir)).some((file) => file.includes('.lock')), false, 'the slot lock is released, no mutex left');
  });

  it('leaves a replacement that took the slot during the cleanup alone: lock, control token and manifest', async () => {
    const paths = await slot('wt-race-00000000');
    // The race: while the old processes are being stopped, a new supervisor reclaims the stale lock and publishes.
    const { results, slot: outcome } = await cleanupStale(paths, { running: true, supervisor: OLD }, { lockDeps: lockDeps(), killOwned: async () => { await replacementStarts(paths); return 'not-running'; } });
    assert.match(results.at(-1), /^lock:held by pid 222; its control and manifest were left alone$/);
    assert.equal(outcome, 'held');
    assert.equal(JSON.parse(await readText(paths.lock)).pid, NEW.pid);
    assert.equal(JSON.parse(await readText(paths.control)).token, 'new-token');
    assert.deepEqual(JSON.parse(await readText(paths.manifest)), { running: true, supervisor: NEW, seed: 2 });
  });

  it('writes nothing over a manifest another generation wrote since, even when its lock is gone again', async () => {
    // The replacement wrote its manifest and died: the slot is free to take, but the manifest is not the one judged.
    const paths = await slot('wt-generation-00000000', { lockHolder: null, manifest: { running: true, supervisor: { pid: 333, startedAt: 'other' } }, control: { token: 'other-token' } });
    const { results, slot: outcome } = await cleanupStale(paths, { running: true, supervisor: OLD }, { lockDeps: lockDeps(), killOwned: async () => 'not-running' });
    assert.match(results.at(-1), /^manifest:another supervisor \(pid 333\) wrote it since; left alone$/);
    assert.equal(outcome, 'foreign-manifest');
    assert.equal(JSON.parse(await readText(paths.control)).token, 'other-token');
    assert.equal(JSON.parse(await readText(paths.manifest)).running, true);
  });

  it('many concurrent cleanups and one starter: the starter keeps its lock and metadata, or starts after the cleanup', async () => {
    for (let round = 0; round < 20; round += 1) {
      const paths = await slot(`wt-many-${String(round).padStart(8, '0')}`);
      const cleaners = Array.from({ length: 5 }, () => cleanupStale(paths, { running: true, supervisor: OLD }, { lockDeps: lockDeps(), killOwned: async () => 'not-running' }));
      const starter = (async () => {
        for (;;) {
          const lock = await acquireLock(paths.lock, { role: 'supervisor' }, lockDeps(NEW));
          if (lock.state === 'acquired') break;
          await new Promise((r) => setTimeout(r, 2));
        }
        await writeFile(paths.control, JSON.stringify({ token: 'new-token' }));
        await writeFile(paths.manifest, JSON.stringify({ running: true, supervisor: NEW }));
      })();
      await Promise.all([...cleaners, starter]);
      assert.equal(JSON.parse(await readText(paths.lock)).pid, NEW.pid, 'the starter owns the slot');
      assert.equal(JSON.parse(await readText(paths.control)).token, 'new-token');
      assert.deepEqual(JSON.parse(await readText(paths.manifest)), { running: true, supervisor: NEW });
    }
  });
});

describe('settleSlot (what up does with its slot)', () => {
  const free = { lock: { state: 'free' }, manifest: null, running: false };
  const stale = { lock: { state: 'stale', holder: OLD }, manifest: { running: true, supervisor: OLD }, running: false };
  const replacementRunning = { lock: { state: 'held', holder: NEW }, manifest: { running: true, supervisor: NEW }, running: true };
  const replacementStarting = { lock: { state: 'held', holder: NEW }, manifest: { running: false, starting: true, supervisor: NEW }, running: false };

  it('reattaches when a replacement took the slot during the cleanup and is running', async () => {
    const cleanups = [];
    const settled = await settleSlot({ state: stale, readState: async () => replacementRunning, cleanup: async (manifest) => { cleanups.push(manifest.supervisor.pid); return { results: ['111:not-running', 'lock:held by pid 222; its control and manifest were left alone'], slot: 'held' }; } });
    assert.equal(settled.action, 'reattach');
    assert.equal(settled.state.manifest.supervisor.pid, NEW.pid);
    assert.deepEqual(cleanups, [111]);
  });

  it('waits (no supervisor spawned) while the replacement is still starting', async () => {
    const settled = await settleSlot({ state: stale, readState: async () => replacementStarting, cleanup: async () => ({ results: ['lock:held by pid 222; …'], slot: 'held' }) });
    assert.equal(settled.action, 'wait');
    assert.equal(settled.state.lock.holder.pid, NEW.pid);
  });

  it('cleans up again after another generation wrote the manifest, and starts once the slot is reset', async () => {
    const other = { lock: { state: 'stale', holder: { pid: 333, startedAt: 'other' } }, manifest: { running: true, supervisor: { pid: 333, startedAt: 'other' } }, running: false };
    const outcomes = [{ results: ['manifest:another supervisor (pid 333) wrote it since; left alone'], slot: 'foreign-manifest' }, { results: ['333:not-running'], slot: 'reset' }];
    const cleaned = [];
    const settled = await settleSlot({ state: stale, readState: async () => other, cleanup: async (manifest) => { cleaned.push(manifest.supervisor.pid); return outcomes.shift(); } });
    assert.equal(settled.action, 'start');
    assert.deepEqual(cleaned, [111, 333], 'the second generation\'s processes are stopped too');
  });

  it('starts on a free slot or after a clean reset, and gives up waiting after repeated losses', async () => {
    assert.equal((await settleSlot({ state: free, readState: async () => free, cleanup: async () => assert.fail('nothing to clean') })).action, 'start');
    assert.equal((await settleSlot({ state: stale, readState: async () => free, cleanup: async () => ({ results: [], slot: 'reset' }) })).action, 'start');
    const lost = await settleSlot({ state: stale, readState: async () => stale, cleanup: async () => ({ results: ['manifest:another supervisor (pid 333) wrote it since; left alone'], slot: 'foreign-manifest' }), attempts: 2 });
    assert.deepEqual([lost.action, lost.reason], ['wait', 'manifest:another supervisor (pid 333) wrote it since; left alone']);
  });
});
