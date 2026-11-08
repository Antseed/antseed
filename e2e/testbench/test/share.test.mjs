import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { cleanupShare, createStateWriter, displayEnv, scheduleForcedExit, findNoVncDir, funnelEnabled, landingPage, originAllowed, parseTailscaleStatus, startShareServer, startXvfb, stripPrefix, XAUTH_PROTOCOL, xauthorityEntry, xvfbArgs } from '../lib/share.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'testbench-share-'));
after(() => rm(tmp, { recursive: true, force: true }));

describe('share X display authorization', () => {
  it('writes one wildcard MIT-MAGIC-COOKIE-1 entry valid for any display', () => {
    const cookie = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const entry = xauthorityEntry(cookie);
    let at = 0;
    const u16 = () => { const value = entry.readUInt16BE(at); at += 2; return value; };
    const field = () => { const length = u16(); const bytes = entry.subarray(at, at + length); at += length; return bytes; };
    assert.equal(u16(), 0xffff, 'FamilyWild');
    assert.equal(field().length, 0, 'any address');
    assert.equal(field().length, 0, 'any display number');
    assert.equal(field().toString(), XAUTH_PROTOCOL);
    assert.deepEqual(field(), cookie);
    assert.equal(at, entry.length);
    assert.throws(() => xauthorityEntry(Buffer.alloc(8)), /16 bytes/);
  });

  it('starts Xvfb with -auth, never -ac, and gives every X client the cookie file', () => {
    const args = xvfbArgs({ width: 1440, height: 900, authFile: '/tb/share-xauthority' });
    assert.deepEqual(args, ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-auth', '/tb/share-xauthority']);
    assert.equal(args.includes('-ac'), false);
    assert.throws(() => xvfbArgs({ width: 1, height: 1 }), /-auth file/);
    assert.deepEqual(displayEnv({ PATH: '/bin', DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority' }, { display: ':7', authFile: '/tb/share-xauthority' }), { PATH: '/bin', DISPLAY: ':7', XAUTHORITY: '/tb/share-xauthority' });
  });
});

describe('share state writes', () => {
  it('a delayed first write never lands after a later ready snapshot with the full child list', async () => {
    let persisted = null;
    const order = [];
    let releaseFirst;
    const firstHeld = new Promise((r) => { releaseFirst = r; });
    let calls = 0;
    const writer = createStateWriter(async (snapshot) => {
      const call = calls += 1;
      if (call === 1) await firstHeld; // the first save's I/O is slow
      persisted = snapshot;
      order.push(call);
    });
    writer.write({ running: false, starting: true, processes: [{ pid: 10 }] }).catch(() => {}); // fire-and-forget, as track() does
    const ready = writer.write({ running: true, starting: false, processes: [{ pid: 10 }, { pid: 20 }] });
    setTimeout(releaseFirst, 20);
    await ready;
    await writer.flush();
    assert.deepEqual(order, [1, 2], 'saves land in call order');
    assert.equal(persisted.running, true);
    assert.equal(persisted.starting, false);
    assert.deepEqual(persisted.processes.map((entry) => entry.pid), [10, 20]);
    assert.equal(writer.state.running, true);
  });

  it('surfaces a failed fire-and-forget save at the next flush, once', async () => {
    let calls = 0;
    const writer = createStateWriter(async () => { calls += 1; if (calls === 1) throw new Error('disk full'); });
    writer.write({ processes: [{ pid: 1 }] }).catch(() => {});
    await writer.write({ running: true });
    await assert.rejects(writer.flush(), /disk full/);
    await writer.flush();
    assert.equal(calls, 2, 'a failed save does not stop later ones');
  });
});

describe('share host forced exit', () => {
  const run = (exitCode) => {
    const exits = [];
    const proc = { exitCode, exit: (code) => exits.push(code) };
    let fire;
    scheduleForcedExit({ proc, setTimer: (fn, ms) => { assert.equal(ms, 100); fire = fn; return { unref() {} }; } });
    fire();
    return exits;
  };

  it('keeps a recorded failure (a share.json that could not be saved) instead of forcing 0', () => {
    assert.deepEqual(run(1), [1]);
    assert.deepEqual(run(undefined), [0]);
    assert.deepEqual(run(0), [0]);
  });
});

describe('Xvfb start', () => {
  function fakeXvfb() {
    const child = new EventEmitter();
    child.stdio = [null, null, null, new EventEmitter()];
    child.exitCode = null;
    child.signalCode = null;
    child.signals = [];
    child.kill = (signal) => { child.signals.push(signal); return true; };
    return child;
  }
  const timers = () => {
    const pending = [];
    return { pending, setTimer: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clearTimer: () => {} };
  };

  it('tracks Xvfb right after spawn, before the display reports, and resolves the display', async () => {
    const child = fakeXvfb();
    const tracked = [];
    const { setTimer, clearTimer } = timers();
    const started = startXvfb({ spawnXvfb: () => child, track: (c) => tracked.push(c), setTimer, clearTimer });
    assert.deepEqual(tracked, [child], 'recorded before the readiness wait');
    child.stdio[3].emit('data', Buffer.from('7\n'));
    assert.equal(await started, ':7');
    assert.deepEqual(child.signals, []);
  });

  it('stops a tracked Xvfb that never reports a display, and one that errors', async () => {
    const child = fakeXvfb();
    const tracked = [];
    const clock = timers();
    const started = startXvfb({ spawnXvfb: () => child, track: (c) => tracked.push(c), timeoutMs: 15_000, ...clock });
    assert.equal(tracked.length, 1);
    assert.equal(clock.pending[0].ms, 15_000);
    clock.pending[0].fn();
    await assert.rejects(started, /Xvfb did not report a display within 15s/);
    assert.deepEqual(child.signals, ['SIGTERM']);
    const failing = fakeXvfb();
    const errored = startXvfb({ spawnXvfb: () => failing, track: () => {}, ...timers() });
    failing.emit('error', new Error('spawn Xvfb ENOENT'));
    await assert.rejects(errored, /ENOENT/);
    assert.deepEqual(failing.signals, ['SIGTERM']);
  });
});

describe('share cleanup', () => {
  const host = { pid: 10, startedAt: 'h' };
  const processes = [{ label: 'Xvfb', pid: 11, startedAt: 'x' }, { label: 'desktop', pid: 12, startedAt: 'd' }];
  const recorder = (alive) => {
    const calls = [];
    return {
      calls,
      deps: {
        isOwnedProcessAlive: (entry) => alive.has(entry.pid),
        killOwned: async (entry) => { calls.push(`kill:${entry.pid}`); return alive.has(entry.pid) ? 'terminated' : 'not-running'; },
        tailscaleOff: (path) => calls.push(`tailscale-off:${path}`),
        save: async (state) => calls.push(`save:${state.running}:${Boolean(state.cleanedAt)}`),
        say: (message) => calls.push(`say:${message}`),
      },
    };
  };

  it('cleans up the children and the route when the host is dead', async () => {
    const { calls, deps } = recorder(new Set([11, 12]));
    assert.equal(await cleanupShare({ running: true, host, processes, tailscale: { path: '/wt-x' } }, deps), true);
    assert.deepEqual(calls, ['say:Cleaning up after a share whose host is gone (desktop, display, VNC, tailscale serve)', 'kill:11', 'kill:12', 'tailscale-off:/wt-x', 'save:false:true']);
  });

  it('stops a live host first, then its recorded children', async () => {
    const { calls, deps } = recorder(new Set([10, 11]));
    assert.equal(await cleanupShare({ running: true, host, processes, tailscale: null }, deps), true);
    assert.deepEqual(calls, ['say:Stopping share (desktop, display, VNC, tailscale serve)', 'kill:10', 'kill:11', 'kill:12', 'save:false:true']);
  });

  it('returns early only without state, or once it was cleaned up', async () => {
    const { calls, deps } = recorder(new Set());
    assert.equal(await cleanupShare(null, deps), false);
    assert.equal(await cleanupShare({ host, processes, cleanedAt: 'earlier' }, deps), false);
    assert.deepEqual(calls, []);
    assert.equal(await cleanupShare({ running: false, stoppedAt: 'x', host, processes }, deps), true, 'a host that stopped itself is still checked');
    assert.deepEqual(calls, ['kill:11', 'kill:12', 'save:false:true']);
  });
});

describe('share helpers', () => {
  it('finds noVNC and reads tailscale state', async () => {
    const dir = join(tmp, 'novnc');
    await mkdir(dir, { recursive: true });
    assert.equal(findNoVncDir(null, [join(tmp, 'nope'), dir]), null);
    await writeFile(join(dir, 'vnc.html'), '<html>');
    assert.equal(findNoVncDir(null, [join(tmp, 'nope'), dir]), dir);
    assert.equal(findNoVncDir(dir), dir);
    assert.deepEqual(parseTailscaleStatus({ BackendState: 'Running', Self: { DNSName: 'box.tail1.ts.net.' } }), { running: true, dnsName: 'box.tail1.ts.net' });
    assert.equal(parseTailscaleStatus({ BackendState: 'NeedsLogin' }).running, false);
    assert.equal(funnelEnabled({ AllowFunnel: { 'box.tail1.ts.net:443': true } }, 'box.tail1.ts.net'), true);
    assert.equal(funnelEnabled({ AllowFunnel: { 'box.tail1.ts.net:8443': true } }, 'box.tail1.ts.net'), false);
    assert.equal(funnelEnabled({}, 'box.tail1.ts.net'), false);
  });

  it('strips the mount prefix and checks WebSocket origins', () => {
    assert.equal(stripPrefix('/wt-a/desktop/vnc.html', '/wt-a'), '/desktop/vnc.html');
    assert.equal(stripPrefix('/wt-a', '/wt-a'), '/');
    assert.equal(stripPrefix('/wt-ab/x', '/wt-a'), '/wt-ab/x');
    assert.equal(stripPrefix('/desktop/', '/wt-a'), '/desktop/');
    const ctx = { host: '127.0.0.1:5000', dnsName: 'box.tail1.ts.net', port: 5000 };
    assert.equal(originAllowed('https://box.tail1.ts.net', ctx), true);
    assert.equal(originAllowed('http://127.0.0.1:5000', ctx), true);
    assert.equal(originAllowed('https://evil.example', ctx), false);
    assert.equal(originAllowed('not a url', ctx), false);
    assert.equal(originAllowed(undefined, ctx), true);
  });

  it('escapes landing page values', () => {
    const html = landingPage({ name: 'wt-a', branch: '<script>x</script>', target: 'local', upstream: 'mock', desktop: 'running', startedAt: 's', idleMinutes: 120 });
    assert.ok(!html.includes('<script>x</script>'));
    assert.ok(html.includes('desktop/vnc.html'));
  });
});

describe('share server', () => {
  it('serves landing, noVNC, reports and bridges the desktop stream to VNC', async () => {
    const noVncDir = join(tmp, 'novnc');
    await writeFile(join(noVncDir, 'vnc.html'), '<html>novnc</html>');
    const reportsDir = join(tmp, 'reports');
    await mkdir(join(reportsDir, 'run-1'), { recursive: true });
    await writeFile(join(reportsDir, 'run-1', 'index.html'), '<html>report</html>');
    const socketPath = join(tmp, 'vnc.sock');
    const vnc = createServer((socket) => { socket.write('RFB 003.008\n'); socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data]))); });
    await new Promise((resolve) => vnc.listen(socketPath, resolve));
    let activity = 0;
    const server = await startShareServer({
      prefix: '/wt-a', noVncDir, vncSocket: socketPath, reportsDir, dnsName: 'box.tail1.ts.net', onActivity: () => { activity += 1; },
      info: () => ({ name: 'wt-a', branch: 'main', target: 'local', upstream: 'mock', desktop: 'running', startedAt: 's', idleMinutes: 120 }),
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      for (const prefix of ['', '/wt-a']) {
        assert.match(await (await fetch(`${base}${prefix}/`)).text(), /Open desktop/);
        assert.equal(await (await fetch(`${base}${prefix}/desktop/vnc.html`)).text(), '<html>novnc</html>');
        assert.equal(await (await fetch(`${base}${prefix}/reports/run-1/index.html`)).text(), '<html>report</html>');
      }
      assert.equal((await fetch(`${base}/desktop/../../etc/passwd`)).status, 404);
      assert.equal((await fetch(`${base}/status.json`)).headers.get('content-type'), 'application/json');
      assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
      const redirect = await fetch(`${base}/wt-a/reports/run-1`, { redirect: 'manual' });
      assert.equal(redirect.headers.get('location'), 'run-1/');

      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/wt-a/websockify`, ['binary'], { origin: 'https://box.tail1.ts.net' });
      const messages = [];
      await new Promise((resolve, reject) => {
        ws.on('message', (data) => { messages.push(data.toString()); if (messages.length === 1) ws.send('hi'); if (messages.length === 2) resolve(); });
        ws.on('error', reject);
      });
      assert.deepEqual(messages, ['RFB 003.008\n', 'echo:hi']);
      assert.equal(server.viewerCount(), 1);
      ws.close();

      const blocked = new WebSocket(`ws://127.0.0.1:${server.port}/websockify`, ['binary'], { origin: 'https://evil.example' });
      const status = await new Promise((resolve) => { blocked.on('unexpected-response', (_req, res) => resolve(res.statusCode)); blocked.on('error', () => resolve('error')); });
      assert.equal(status, 403);
      assert.ok(activity > 0);
    } finally {
      await server.stop();
      vnc.close();
    }
  });
});
