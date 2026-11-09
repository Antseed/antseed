import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { controlClient, startControlServer } from '../lib/control.mjs';
import { isOwnedProcessAlive, ownProcessEntry, processStartTime } from '../lib/lock.mjs';
import { lifecycleState } from '../lib/manifest.mjs';
import { DEFAULT_IDLE_MINUTES, IDLE_MINUTES_ENV, reattachDecision, resolveIdleMinutes, startHeartbeat, watchdogDecision, WATCHDOG_INTERVAL_MS } from '../lib/watchdog.mjs';

const MINUTE = 60_000;
const base = { heartbeatAgeMs: 0, lastControlAgeMs: 0, idleMs: 120 * MINUTE };

describe('watchdogDecision', () => {
  it('keeps a testbench whose starter is alive, however quiet', () => {
    assert.equal(watchdogDecision({ ...base, starter: 'alive' }), 'keep');
    assert.equal(watchdogDecision({ ...base, starter: 'alive', heartbeatAgeMs: 999 * MINUTE, lastControlAgeMs: 999 * MINUTE }), 'keep');
  });

  it('gives a dead starter one grace interval after its last heartbeat', () => {
    assert.equal(watchdogDecision({ ...base, starter: 'dead', heartbeatAgeMs: 0 }), 'keep');
    assert.equal(watchdogDecision({ ...base, starter: 'dead', heartbeatAgeMs: WATCHDOG_INTERVAL_MS - 1 }), 'keep');
    assert.equal(watchdogDecision({ ...base, starter: 'dead', heartbeatAgeMs: WATCHDOG_INTERVAL_MS }), 'stop:starter-died');
    assert.equal(watchdogDecision({ ...base, starter: 'dead', heartbeatAgeMs: 5000, graceMs: 1000 }), 'stop:starter-died');
  });

  it('says starter-died, not idle, when both apply', () => {
    assert.equal(watchdogDecision({ ...base, starter: 'dead', heartbeatAgeMs: 999 * MINUTE, lastControlAgeMs: 999 * MINUTE }), 'stop:starter-died');
  });

  it('stops a testbench without a starter once the idle budget is spent', () => {
    assert.equal(watchdogDecision({ ...base, starter: 'none', lastControlAgeMs: 120 * MINUTE - 1 }), 'keep');
    assert.equal(watchdogDecision({ ...base, starter: 'none', lastControlAgeMs: 120 * MINUTE }), 'stop:idle');
    assert.equal(watchdogDecision({ ...base, starter: 'none', heartbeatAgeMs: 999 * MINUTE }), 'keep', 'a stale heartbeat means nothing without a starter');
  });
});

describe('resolveIdleMinutes', () => {
  it('defaults to 120 and takes 5 to 1440', () => {
    assert.equal(DEFAULT_IDLE_MINUTES, 120);
    assert.equal(resolveIdleMinutes({}), 120);
    assert.equal(resolveIdleMinutes({ [IDLE_MINUTES_ENV]: ' ' }), 120);
    assert.equal(resolveIdleMinutes({ [IDLE_MINUTES_ENV]: '5' }), 5);
    assert.equal(resolveIdleMinutes({ [IDLE_MINUTES_ENV]: '1440' }), 1440);
  });

  it('refuses anything else', () => {
    for (const value of ['4', '1441', '0', '-5', 'soon', '1.5']) assert.throws(() => resolveIdleMinutes({ [IDLE_MINUTES_ENV]: value }), /must be 5-1440 minutes/, value);
  });
});

describe('reattachDecision', () => {
  const starter = { pid: 1, startedAt: 'x' };

  it('starts when nothing is running, whatever the old manifest says', () => {
    assert.equal(reattachDecision({ running: false, starter: null, starterAlive: false }), 'start');
    assert.equal(reattachDecision({ running: false, starter, starterAlive: false }), 'start');
  });

  it('reuses a testbench left up by up or --keep', () => {
    assert.equal(reattachDecision({ running: true, starter: null, starterAlive: false }), 'reuse');
  });

  it('reuses a testbench whose run is still alive', () => {
    assert.equal(reattachDecision({ running: true, starter, starterAlive: true }), 'reuse');
  });

  it('restarts a testbench whose run died without down', () => {
    assert.equal(reattachDecision({ running: true, starter, starterAlive: false }), 'restart');
  });
});

describe('lifecycleState', () => {
  const held = { state: 'held' };

  it('only says stopped when no supervisor is alive', () => {
    assert.equal(lifecycleState({ lock: held, manifest: { running: true }, running: true }), 'running');
    assert.equal(lifecycleState({ lock: held, manifest: { running: false, stoppingAt: 't' }, running: false }), 'stopping');
    assert.equal(lifecycleState({ lock: held, manifest: { starting: true }, running: false }), 'starting');
    assert.equal(lifecycleState({ lock: { state: 'stale' }, manifest: { running: true }, running: false }), 'stale');
    assert.equal(lifecycleState({ lock: { state: 'free' }, manifest: { running: false, stoppingAt: 't' }, running: false }), 'stopped');
    assert.equal(lifecycleState({ lock: { state: 'free' }, manifest: null, running: false }), 'stopped');
  });
});

describe('startHeartbeat', () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it('beats at once and on every interval until stopped', async () => {
    let beats = 0;
    const stop = startHeartbeat(() => { beats += 1; }, { intervalMs: 10 });
    await sleep(0);
    assert.equal(beats, 1);
    await sleep(60);
    assert.ok(beats >= 3, `beats ${beats}`);
    stop();
    const stopped = beats;
    await sleep(40);
    assert.equal(beats, stopped);
  });

  it('keeps beating after a failed beat, thrown or rejected', async () => {
    let beats = 0;
    const stop = startHeartbeat(() => {
      beats += 1;
      if (beats === 1) throw new Error('sync');
      return Promise.reject(new Error('async'));
    }, { intervalMs: 5 });
    await sleep(40);
    stop();
    assert.ok(beats >= 3, `beats ${beats}`);
  });
});

describe('control API activity', () => {
  it('counts each authorized request, not an unauthorized one, and the client reaches the watchdog routes', async () => {
    let requests = 0;
    const seen = [];
    const server = await startControlServer({
      token: 'secret', onRequest: () => { requests += 1; },
      routes: {
        'POST /heartbeat': ({ body }) => { seen.push(['heartbeat', body]); return {}; },
        'POST /starter/release': ({ body }) => { seen.push(['release', body]); return {}; },
      },
    });
    try {
      const entry = { pid: 7, startedAt: 'x' };
      const client = controlClient({ url: server.url, token: 'secret' });
      await client.heartbeat(entry);
      await client.releaseStarter(entry);
      await assert.rejects(controlClient({ url: server.url, token: 'wrong' }).heartbeat(entry), /unauthorized/);
      assert.equal(requests, 2);
      assert.deepEqual(seen, [['heartbeat', entry], ['release', entry]]);
    } finally {
      await server.stop();
    }
  });
});

describe('reaper', () => {
  const reaperPath = fileURLToPath(new URL('../lib/reaper.mjs', import.meta.url));
  const lockUrl = pathToFileURL(fileURLToPath(new URL('../lib/lock.mjs', import.meta.url))).href;
  /**
   * A stand-in supervisor: spawns the reaper and a child, hands it over exactly as supervisor.mjs reap() does (start
   * time from processStartTime, which is /proc boot ticks on Linux and ps lstart elsewhere), prints the child's entry.
   */
  const standIn = (childScript) => `
    import { spawn } from 'node:child_process';
    import { processStartTime } from ${JSON.stringify(lockUrl)};
    const reaper = spawn(process.execPath, [${JSON.stringify(reaperPath)}], { stdio: ['pipe', 'inherit', 'inherit'] });
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });
    const entry = { pid: child.pid, startedAt: processStartTime(child.pid) };
    reaper.stdin.write(JSON.stringify(entry) + '\\n');
    console.log(JSON.stringify(entry));
    setInterval(() => {}, 1000);`;
  const waitGone = async (entry, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (isOwnedProcessAlive(entry) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return !isOwnedProcessAlive(entry);
  };
  const launch = async (childScript) => {
    const parent = spawn(process.execPath, ['--input-type=module', '-e', standIn(childScript)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const [chunk] = await once(parent.stdout, 'data');
    const registered = JSON.parse(chunk.toString().trim());
    const entry = { pid: registered.pid, startedAt: processStartTime(registered.pid) };
    // What the reaper was handed must be what it checks; a mismatch is the bug that made these tests fail on Linux.
    assert.equal(registered.startedAt, entry.startedAt, 'the registered start time is the one isOwnedProcessAlive compares');
    return { parent, entry };
  };

  it('stops a registered child when its parent dies by SIGKILL', { skip: process.platform === 'win32' }, async () => {
    const { parent, entry } = await launch('setInterval(() => {}, 1000)');
    assert.ok(isOwnedProcessAlive(entry));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(isOwnedProcessAlive(entry), 'the child runs while its parent lives');
    parent.kill('SIGKILL');
    // SIGTERM reaches the child as soon as the reaper sees its pipe close; the bound is room for a slow runner.
    assert.ok(await waitGone(entry, 10_000), 'the reaper stopped the child');
  });

  it('kills a child that ignores SIGTERM', { skip: process.platform === 'win32', timeout: 40_000 }, async () => {
    const { parent, entry } = await launch(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`);
    await new Promise((r) => setTimeout(r, 200));
    const killedAt = Date.now();
    parent.kill('SIGKILL');
    // The reaper sends SIGKILL after its 8 s grace; 30 s leaves a slow runner room.
    assert.ok(await waitGone(entry, 30_000), 'the reaper killed the child');
    assert.ok(Date.now() - killedAt >= 7_000, 'only after the SIGTERM grace, so the SIGTERM was ignored and SIGKILL did it');
  });

  it('a registration records the start time format isOwnedProcessAlive uses on this OS', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const entry = { pid: child.pid, startedAt: processStartTime(child.pid) };
      assert.ok(isOwnedProcessAlive(entry));
      if (process.platform === 'linux') assert.match(entry.startedAt, /^boot\+\d+$/, 'Linux: /proc boot-relative ticks, not ps lstart');
      else assert.doesNotMatch(entry.startedAt, /^boot\+/);
      assert.deepEqual(ownProcessEntry(child.pid), entry);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('every process registration in the testbench uses processStartTime, never ps lstart', () => {
    // Registrations (reaper feed, manifest entries, share children) must match what isOwnedProcessAlive checks.
    const root = dirname(fileURLToPath(new URL('../cli.mjs', import.meta.url)));
    const files = ['cli.mjs', 'supervisor.mjs', 'share-host.mjs', 'seller-worker.mjs', ...readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.mjs')).map((f) => `lib/${f}`)];
    for (const file of files) {
      const text = readFileSync(join(root, file), 'utf8');
      if (file !== 'lib/lock.mjs') assert.doesNotMatch(text, /lstart/, `${file} reads ps lstart directly`);
      for (const line of text.split('\n').filter((l) => /pid: [\w.]+\.pid\b/.test(l) && /startedAt:/.test(l))) {
        assert.match(line, /startedAt: processStartTime\(/, `${file}: ${line.trim()}`);
      }
    }
  });

  it('does not signal a pid that now belongs to another process', async () => {
    const self = ownProcessEntry();
    const reaper = spawn(process.execPath, [reaperPath], { stdio: ['pipe', 'ignore', 'inherit'] });
    reaper.stdin.end(`${JSON.stringify({ pid: self.pid, startedAt: 'another start time' })}\n`);
    const [code] = await once(reaper, 'exit');
    assert.equal(code, 0);
    assert.ok(isOwnedProcessAlive(self));
  });
});
