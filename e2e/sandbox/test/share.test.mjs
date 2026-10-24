import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import WebSocket from 'ws';
import { findNoVncDir, funnelEnabled, landingPage, originAllowed, parseTailscaleStatus, startShareServer, stripPrefix } from '../lib/share.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'sandbox-share-'));
after(() => rm(tmp, { recursive: true, force: true }));

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
