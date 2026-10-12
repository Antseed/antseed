import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teeControlFileName } from '@antseed/node/tee-status';
import { requestTeeSnapshot } from './tee-verification.js';

test('missing credentials explain the existing directory setting without searching other directories', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-tee-directory-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configured = join(directory, 'configured');
  await mkdir(configured);
  const port = 8377;
  await writeFile(join(directory, teeControlFileName(port)), 'not a credential', { mode: 0o600 });
  await assert.rejects(requestTeeSnapshot(configured, port), /credentials are missing.*ANTSEED_DESKTOP_CONNECT_DATA_DIR/);
});

test('main-process requests keep credentials private and reject unexpected buyer sessions', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-tee-client-'));
  const token = 'b'.repeat(64);
  let sessionId = 'current';
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers.origin, undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sessionId, verificationEnabled: true, evidence: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  context.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const file = join(directory, teeControlFileName(port));
  await writeFile(file, JSON.stringify({ token, sessionId, port }), { mode: 0o600 });
  const snapshot = await requestTeeSnapshot(directory, port);
  assert.equal(snapshot.sessionId, 'current');
  assert.equal(snapshot.verificationEnabled, true);
  assert.ok(!JSON.stringify(snapshot).includes(token));
  assert.equal(requests, 1);
  sessionId = 'unexpected';
  await assert.rejects(requestTeeSnapshot(directory, port), /session changed/);
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await assert.rejects(requestTeeSnapshot(directory, port), /permissions/);
  }
});
