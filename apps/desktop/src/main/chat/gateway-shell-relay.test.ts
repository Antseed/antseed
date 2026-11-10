import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { grantShellGateway } from './gateway-shell-relay.js';

async function withGateway(fn: (origin: string, seen: Array<{ auth?: string; url?: string; body: string; tee?: string }>) => Promise<void>): Promise<void> {
  const seen: Array<{ auth?: string; url?: string; body: string; tee?: string }> = [];
  const gateway = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, url: req.url, body, ...(req.headers['x-antseed-require-tee'] ? { tee: String(req.headers['x-antseed-require-tee']) } : {}) });
      res.writeHead(201, { 'x-from': 'gateway' });
      res.write('part one, ');
      res.end('part two');
    });
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  try {
    await fn(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}`, seen);
  } finally {
    gateway.closeAllConnections();
    gateway.close();
  }
}

test('swaps the run\'s token for the real key and passes the answer through', async () => {
  await withGateway(async (origin, seen) => {
    const grant = await grantShellGateway({ origin, apiKey: 'real-key' });
    const answer = await fetch(`${grant.url}/v1/images/generations?x=1`, { method: 'POST', headers: { authorization: `Bearer ${grant.token}` }, body: 'prompt' });
    assert.equal(answer.status, 201);
    assert.equal(answer.headers.get('x-from'), 'gateway');
    assert.equal(await answer.text(), 'part one, part two');
    assert.deepEqual(seen, [{ auth: 'Bearer real-key', url: '/v1/images/generations?x=1', body: 'prompt' }]);
    assert.ok(!grant.url.includes('real-key') && grant.token !== 'real-key');
    grant.revoke();
  });
});

test('the real key is not accepted, nor a token once its run has ended', async () => {
  await withGateway(async (origin, seen) => {
    const grant = await grantShellGateway({ origin, apiKey: 'real-key' });
    const withKey = await fetch(`${grant.url}/v1/models`, { headers: { authorization: 'Bearer real-key' } });
    assert.equal(withKey.status, 401);
    assert.equal((await fetch(`${grant.url}/v1/models`, { headers: { authorization: `Bearer ${grant.token}` } })).status, 201);
    grant.revoke();
    assert.equal((await fetch(`${grant.url}/v1/models`, { headers: { authorization: `Bearer ${grant.token}` } })).status, 401);
    assert.equal(seen.length, 1);
  });
});

test('only the API paths the skills use are forwarded', async () => {
  await withGateway(async (origin, seen) => {
    const grant = await grantShellGateway({ origin, apiKey: 'real-key' });
    const get = (path: string) => fetch(`${grant.url}${path}`, { headers: { authorization: `Bearer ${grant.token}` } }).then((r) => r.status);
    assert.equal(await get('/_antseed/route'), 403);
    assert.equal(await get('/console/keys'), 403);
    assert.equal(await get('/v1evil'), 403);
    assert.equal(await get('/v1/models'), 201);
    assert.equal(await get('/api/v1/video/retrieve'), 201);
    assert.equal(await get('/fal/v1/video/retrieve'), 201);
    assert.equal(seen.length, 3);
    grant.revoke();
  });
});

test('a path that only starts with /v1 before dot segments are resolved is refused', async () => {
  await withGateway(async (origin, seen) => {
    const grant = await grantShellGateway({ origin, apiKey: 'real-key' });
    const { port } = new URL(grant.url);
    // A raw request target: fetch would resolve the dots before sending.
    const raw = (path: string) => new Promise<number>((resolve, reject) => {
      http.request({ host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${grant.token}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject).end();
    });
    assert.equal(await raw('/v1/../console/api/status'), 403);
    assert.equal(await raw('/v1/%2e%2e/console/api/status'), 403);
    assert.equal(await raw('//elsewhere.example/v1/models'), 403);
    assert.equal(seen.length, 0);
    // A target the URL parser rejects is answered, and the relay keeps working.
    assert.equal(await raw('//[/'), 400);
    assert.equal(await raw('/v1/models'), 201);
    grant.revoke();
  });
});

test('each run reaches its own gateway', async () => {
  await withGateway(async (firstOrigin, first) => {
    await withGateway(async (secondOrigin, second) => {
      const a = await grantShellGateway({ origin: firstOrigin, apiKey: 'key-a' });
      const b = await grantShellGateway({ origin: secondOrigin, apiKey: 'key-b' });
      await fetch(`${a.url}/v1/models`, { headers: { authorization: `Bearer ${a.token}` } });
      await fetch(`${b.url}/v1/models`, { headers: { authorization: `Bearer ${b.token}` } });
      assert.equal(first[0]!.auth, 'Bearer key-a');
      assert.equal(second[0]!.auth, 'Bearer key-b');
      a.revoke();
      b.revoke();
    });
  });
});

test('a gateway that is down answers 502', async () => {
  const grant = await grantShellGateway({ origin: 'http://127.0.0.1:1', apiKey: 'k' });
  assert.equal((await fetch(`${grant.url}/v1/models`, { headers: { authorization: `Bearer ${grant.token}` } })).status, 502);
  grant.revoke();
});

test('a Private run\'s requests always ask for TEE sellers, whatever the shell sends', async () => {
  await withGateway(async (origin, seen) => {
    const grant = await grantShellGateway({ origin, apiKey: 'real-key', requireTee: true });
    await fetch(`${grant.url}/v1/images/generations`, { method: 'POST', headers: { authorization: `Bearer ${grant.token}` }, body: 'a' });
    await fetch(`${grant.url}/v1/images/generations`, { method: 'POST', headers: { authorization: `Bearer ${grant.token}`, 'x-antseed-require-tee': '0' }, body: 'b' });
    assert.deepEqual(seen.map((request) => request.tee), ['1', '1']);
    grant.revoke();

    // An Anonymous run adds nothing of its own.
    const open = await grantShellGateway({ origin, apiKey: 'real-key' });
    await fetch(`${open.url}/v1/images/generations`, { method: 'POST', headers: { authorization: `Bearer ${open.token}` }, body: 'c' });
    assert.equal(seen[2]?.tee, undefined);
    open.revoke();
  });
});
