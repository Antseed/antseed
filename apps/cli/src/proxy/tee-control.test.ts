import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { teeControlFileName } from '@antseed/node/tee-status';
import { TeeControl } from './tee-control.js';

test('verification control authenticates, rejects origins/targets, bounds requests and cleans credentials', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'tee-control-'));
  const control = new TeeControl('session');
  const checks: string[] = [];
  const seller = 'a'.repeat(40);
  const snapshot = { sessionId: 'session', verificationEnabled: true, evidence: [] };
  const server = createServer((req, res) => {
    void control.handle(req, res, req.method!, req.url!, () => snapshot, async (peerId) => {
      if (peerId !== seller) throw new Error('Unknown seller');
      checks.push(peerId);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  context.after(async () => {
    await control.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await control.publish(directory, port);
  const file = join(directory, teeControlFileName(port));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const credential = JSON.parse(await readFile(file, 'utf8')) as { token: string };
  const url = `http://127.0.0.1:${port}/_antseed/verification`;
  const headers = { authorization: `Bearer ${credential.token}` };
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer invalid' } })).status, 403);
  assert.equal((await fetch(url, { headers: { ...headers, origin: 'http://127.0.0.1.evil.test' } })).status, 403);
  assert.equal((await fetch(url, { headers: { ...headers, origin: 'http://localhost:3000' } })).status, 403);
  const status = await (await fetch(url, { headers })).json();
  assert.deepEqual(status, snapshot);
  assert.equal((await fetch(`${url}/resume`, { method: 'POST', headers })).status, 404);
  assert.ok(!JSON.stringify(status).includes(credential.token));
  assert.equal((await fetch(`${url}/check`, { method: 'POST', headers, body: JSON.stringify({ peerId: seller, url: 'https://evil.test' }) })).status, 400);
  await new Promise((resolve) => setTimeout(resolve, 1010));
  assert.equal((await fetch(`${url}/check`, { method: 'POST', headers, body: JSON.stringify({ peerId: 'b'.repeat(40) }) })).status, 400);
  await new Promise((resolve) => setTimeout(resolve, 1010));
  assert.equal((await fetch(`${url}/check`, { method: 'POST', headers, body: JSON.stringify({ peerId: seller }) })).status, 200);
  assert.deepEqual(checks, [seller]);
  assert.equal((await fetch(`${url}/check`, { method: 'POST', headers, body: JSON.stringify({ peerId: seller }) })).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 1010));
  assert.equal((await fetch(`${url}/check`, { method: 'POST', headers, body: 'x'.repeat(2048) })).status, 413);
  await control.close();
  await assert.rejects(readFile(file));
  assert.equal((await fetch(url, { headers })).status, 403);
});
