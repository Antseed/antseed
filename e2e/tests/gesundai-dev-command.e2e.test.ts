import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AntseedNode, validateRoutingRankResponse } from '@antseed/node';
import { resolveInstancePorts } from '../../apps/desktop/scripts/dev-instance-config.mjs';
import { GESUNDAI_TARGET } from '../scripts/gesundai-router.mjs';

it('discovers the standalone fake router, lists its IRP models and buys a free recommendation over real P2P', async () => {
  const instance = `levanto-test-${randomUUID().slice(0, 8)}`;
  const directory = await mkdtemp(join(tmpdir(), 'levanto-dev-buyer-'));
  let available = true;
  const catalog = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ peers: available ? [{ ...GESUNDAI_TARGET,
      inputUsdPerMillion: 0.65, outputUsdPerMillion: 3.25, cachedInputUsdPerMillion: 0.07 }] : [] }] }));
  });
  await new Promise<void>((ready) => catalog.listen(0, '127.0.0.1', ready));
  const port = (catalog.address() as { port: number }).port;
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../scripts/dev-levanto.mjs'), instance, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const buyer = new AntseedNode({ role: 'buyer', dataDir: directory, dhtPort: 0,
    bootstrapNodes: [{ host: '127.0.0.1', port: resolveInstancePorts(instance).levantoDht }],
    noOfficialBootstrap: true, allowPrivateIPs: true, dhtOperationTimeoutMs: 1500 });
  try {
    const deadline = Date.now() + 25_000;
    while (!output.includes('Fake Levanto ready')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Dev router did not start: ${output}`);
      await new Promise((ready) => setTimeout(ready, 100));
    }
    await buyer.start();
    const peerId = output.match(/Router peer: ([0-9a-f]{40})/)![1]!;
    const peer = (await buyer.discoverPeers()).find((candidate) => candidate.peerId === peerId);
    expect(peer, output).toBeDefined();
    expect(peer!.metadata!.displayName).toBe('Levanto');
    const headers = { 'content-type': 'application/json', 'x-antseed-provider': 'fake-levanto', 'x-antseed-service': 'levanto-route' };
    const models = await buyer.sendRequest(peer!, { requestId: randomUUID(), method: 'GET', path: '/v1/routing/models', headers, body: new Uint8Array() }, { controlPlane: true });
    expect(JSON.parse(Buffer.from(models.body).toString())).toEqual({ object: 'list', data: [{ id: GESUNDAI_TARGET.serviceId, object: 'model' }] });
    const candidate = { id: GESUNDAI_TARGET.provider + ':' + GESUNDAI_TARGET.serviceId + '@' + GESUNDAI_TARGET.peerId,
      model: GESUNDAI_TARGET.serviceId, pricing: { input: 0.65, cache_read: 0.07, output: 3.25 } };
    const body = { request: { messages: [{ role: 'user', content: 'Recommend the fixed target' }] },
      routing: { cost_quality_tradeoff: 5, candidates: [candidate] } };
    const send = () => buyer.sendRequest(peer!, { requestId: randomUUID(), method: 'POST', path: '/v1/routing/rank',
      headers, body: Buffer.from(JSON.stringify(body)) });
    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(validateRoutingRankResponse(JSON.parse(Buffer.from(response.body).toString()), [candidate])).toEqual([{ candidate_id: candidate.id }]);
    available = false;
    const missing = await send();
    expect(missing.statusCode).toBe(503);
    expect(JSON.parse(Buffer.from(missing.body).toString()).ranked).toBeUndefined();
  } finally {
    await buyer.stop();
    child.kill('SIGINT');
    const forceStop = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited;
    clearTimeout(forceStop);
    await new Promise<void>((done) => catalog.close(() => done()));
    await rm(directory, { recursive: true, force: true });
    await rm(join(tmpdir(), 'antseed-desktop', instance), { recursive: true, force: true });
  }
}, 60_000);
