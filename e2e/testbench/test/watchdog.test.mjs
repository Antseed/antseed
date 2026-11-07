import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
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
  /** A stand-in supervisor: spawns the reaper and a child that ignores nothing, hands it over, prints the child's pid. */
  const standIn = (childScript) => `
    const { spawn, execFileSync } = require('node:child_process');
    const reaper = spawn(process.execPath, [${JSON.stringify(reaperPath)}], { stdio: ['pipe', 'inherit', 'inherit'] });
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });
    const startedAt = execFileSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], { env: { ...process.env, LC_ALL: 'C' } }).toString().trim();
    reaper.stdin.write(JSON.stringify({ pid: child.pid, startedAt }) + '\\n');
    console.log(child.pid, startedAt);
    setInterval(() => {}, 1000);`;
  const waitGone = async (entry, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (isOwnedProcessAlive(entry) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return !isOwnedProcessAlive(entry);
  };
  const launch = async (childScript) => {
    const parent = spawn(process.execPath, ['-e', standIn(childScript)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const [chunk] = await once(parent.stdout, 'data');
    const line = chunk.toString().trim();
    const pid = Number(line.split(' ')[0]);
    return { parent, entry: { pid, startedAt: processStartTime(pid) } };
  };

  it('stops a registered child when its parent dies by SIGKILL', { skip: process.platform === 'win32' }, async () => {
    const { parent, entry } = await launch('setInterval(() => {}, 1000)');
    assert.ok(isOwnedProcessAlive(entry));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(isOwnedProcessAlive(entry), 'the child runs while its parent lives');
    parent.kill('SIGKILL');
    assert.ok(await waitGone(entry, 3000));
  });

  it('kills a child that ignores SIGTERM', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
    const { parent, entry } = await launch(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`);
    await new Promise((r) => setTimeout(r, 200));
    parent.kill('SIGKILL');
    assert.ok(await waitGone(entry, 12_000));
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
