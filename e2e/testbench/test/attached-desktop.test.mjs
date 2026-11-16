import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { forgetAttachedDesktop, isAttachedDesktopProcess, processEnvironment, processGroupMembers, recordAttachedDesktop, stopAttachedDesktop, stopAttachedDesktops } from '../lib/attached-desktop.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'tb-desktop-group-'));
after(() => rm(tmp, { recursive: true, force: true }));
const HOME_DIR = '/tb/home';
const OURS = `foo HOME=${HOME_DIR} ANTSEED_DESKTOP_ATTACH_ONLY=1 bar`;
const FOREIGN = 'foo HOME=/Users/me ANTSEED_DESKTOP_ATTACH_ONLY=1 bar';
const record = { pid: 100, startedAt: 'x', home: HOME_DIR, instance: 'inst' };

/** Injected process table: `env` per pid; a killed pid leaves the group unless listed in `unkillable`. */
function fakes(env, { unkillable = [], leaderAlive = false } = {}) {
  const group = new Set(Object.keys(env).map(Number));
  const killed = [];
  return {
    killed,
    deps: {
      listGroup: () => [...group],
      environmentOf: (pid) => env[pid] ?? null,
      startTime: (pid) => `start-${pid}`,
      leaderAlive: () => leaderAlive,
      settleMs: 0,
      kill: async (entry) => { killed.push(entry); if (!unkillable.includes(entry.pid)) group.delete(entry.pid); return 'terminated'; },
    },
  };
}

describe('proving a process is the attached desktop', () => {
  it('needs the testbench HOME and the attach-only flag, as whole variables', () => {
    assert.equal(isAttachedDesktopProcess(OURS, HOME_DIR), true);
    assert.equal(isAttachedDesktopProcess(`HOME=${HOME_DIR}\0ANTSEED_DESKTOP_ATTACH_ONLY=1\0`, HOME_DIR), true, '/proc environ is NUL separated');
    assert.equal(isAttachedDesktopProcess(FOREIGN, HOME_DIR), false);
    assert.equal(isAttachedDesktopProcess(`HOME=${HOME_DIR}`, HOME_DIR), false);
    assert.equal(isAttachedDesktopProcess(`HOME=${HOME_DIR}/sub ANTSEED_DESKTOP_ATTACH_ONLY=1`, HOME_DIR), false);
    assert.equal(isAttachedDesktopProcess(`HOME=${HOME_DIR} ANTSEED_DESKTOP_ATTACH_ONLY=12`, HOME_DIR), false);
    assert.equal(isAttachedDesktopProcess(null, HOME_DIR), false);
  });
});

describe('stopping a recorded desktop group', () => {
  it('stops every proven member through killOwned, recording pid and start time', async () => {
    const { deps, killed } = fakes({ 100: OURS, 101: OURS });
    assert.deepEqual(await stopAttachedDesktop(record, deps), { stopped: [100, 101], problems: [] });
    assert.deepEqual(killed.map((entry) => [entry.pid, entry.startedAt]), [[100, 'start-100'], [101, 'start-101']]);
  });

  it('re-scans during shutdown: a helper that appears is stopped, and one that exits by itself is no problem', async () => {
    const group = new Set([100]);
    const killed = [];
    const deps = {
      listGroup: () => [...group],
      environmentOf: () => OURS,
      startTime: (pid) => `start-${pid}`,
      leaderAlive: () => false,
      settleMs: 2000,
      // Stopping the leader starts a helper, as concurrently's tree-kill does; the helper stops when signalled.
      kill: async (entry) => { killed.push(entry.pid); group.delete(entry.pid); if (entry.pid === 100) group.add(101); return 'terminated'; },
    };
    assert.deepEqual(await stopAttachedDesktop(record, deps), { stopped: [100, 101], problems: [] });
    assert.deepEqual(killed, [100, 101]);
  });

  it('does not report a process that left the group while it was settling', async () => {
    const group = new Set([100, 102]);
    setTimeout(() => group.delete(102), 100);
    const deps = { listGroup: () => [...group], environmentOf: (pid) => (pid === 100 ? OURS : FOREIGN), startTime: (pid) => `s-${pid}`, leaderAlive: () => false, settleMs: 2000, kill: async (entry) => { group.delete(entry.pid); return 'terminated'; } };
    assert.deepEqual(await stopAttachedDesktop(record, deps), { stopped: [100], problems: [] });
  });

  it('leaves a member it cannot prove alone and says so', async () => {
    const { deps, killed } = fakes({ 100: OURS, 102: FOREIGN });
    const result = await stopAttachedDesktop(record, deps);
    assert.deepEqual(killed.map((entry) => entry.pid), [100], 'only the proven one is signalled');
    assert.match(result.problems[0], /pid 102 of desktop inst is still running \(not provably/);
  });

  it('says what would not stop', async () => {
    const { deps } = fakes({ 100: OURS }, { unkillable: [100] });
    const result = await stopAttachedDesktop(record, deps);
    assert.deepEqual(result.stopped, []);
    assert.match(result.problems[0], /pid 100 of desktop inst is still running$/);
  });

  it('ignores a group with no proven member once its leader is gone: the id was reused', async () => {
    const { deps, killed } = fakes({ 100: FOREIGN, 101: FOREIGN });
    assert.deepEqual(await stopAttachedDesktop(record, deps), { stopped: [], problems: [] });
    assert.deepEqual(killed, []);
  });

  it('reports a group whose live leader cannot be proven', async () => {
    const { deps } = fakes({ 100: FOREIGN }, { leaderAlive: true });
    assert.match((await stopAttachedDesktop(record, deps)).problems[0], /pid 100/);
  });

  it('keeps the record while something is left, and forgets it once stopped', async () => {
    const dir = join(tmp, 'records');
    const saved = await recordAttachedDesktop(dir, { pid: 100, home: HOME_DIR, instance: 'inst' }, { startTime: () => 'x' });
    assert.deepEqual(saved, record);
    const stuck = fakes({ 100: OURS }, { unkillable: [100] });
    assert.equal((await stopAttachedDesktops(dir, { deps: stuck.deps })).length, 1);
    assert.deepEqual(await readdir(join(dir, 'desktops')), ['100.json']);
    const said = [];
    assert.deepEqual(await stopAttachedDesktops(dir, { deps: fakes({ 100: OURS }).deps, say: (line) => said.push(line) }), []);
    assert.deepEqual(await readdir(join(dir, 'desktops')), []);
    assert.deepEqual(said, ['Stopped attached desktop inst (1 processes)']);
    assert.deepEqual(await stopAttachedDesktops(join(tmp, 'none')), [], 'no records, nothing to do');
    await forgetAttachedDesktop(dir, record);
  });
});

describe('a real process group', { skip: process.platform === 'win32' }, () => {
  it('finds and stops a detached tree whose launcher is gone, leaving a look-alike outside the group', async () => {
    const dir = join(tmp, 'real');
    const home = join(tmp, 'real-home');
    const env = { ...process.env, HOME: home, ANTSEED_DESKTOP_ATTACH_ONLY: '1' };
    // The leader starts a grandchild and exits: the launcher is gone, its tree is not.
    const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => process.exit(0), 100);`;
    const leader = spawn(process.execPath, ['-e', script], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const saved = await recordAttachedDesktop(dir, { pid: leader.pid, home, instance: 'real' });
    const [chunk] = await once(leader.stdout, 'data');
    const grandchild = Number(chunk.toString().trim());
    await once(leader, 'exit');
    const lookAlike = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, detached: true, stdio: 'ignore' });
    try {
      assert.deepEqual(processGroupMembers(leader.pid), [grandchild]);
      assert.equal(isAttachedDesktopProcess(processEnvironment(grandchild), home), true);
      const result = await stopAttachedDesktop(saved);
      assert.deepEqual(result, { stopped: [grandchild], problems: [] });
      assert.deepEqual(processGroupMembers(leader.pid), []);
      assert.equal(lookAlike.exitCode, null, 'another group is untouched');
      assert.deepEqual(processGroupMembers(lookAlike.pid), [lookAlike.pid]);
    } finally {
      lookAlike.kill('SIGKILL');
      try { process.kill(grandchild, 'SIGKILL'); } catch { /* stopped above */ }
    }
  });
});
