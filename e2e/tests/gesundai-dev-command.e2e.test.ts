import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AntseedNode, resolveServiceBillingOffer } from '@antseed/node';
import { resolveInstancePorts } from '../../apps/desktop/scripts/dev-instance-config.mjs';
import { GESUNDAI_TARGET } from '../scripts/gesundai-router.mjs';
import { validateRoutingResponse } from '../../plugins/router-levanto/src/validation.js';

it('discovers the standalone fake router, serves its catalog API and buys a free recommendation over real P2P', async () => {
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
    const routerApi = output.match(/Router API: (http:\/\/\S+)/)![1]!;
    const routingCatalog = await (await fetch(`${routerApi}/_antseed/route/catalog?provider=fake-levanto&service=levanto-route`)).json();
    expect((await fetch(`${routerApi}/_antseed/route/catalog?provider=fake-levanto&service=other`)).status).toBe(404);
    expect(routingCatalog.title).toBe('Auto Router');
    expect(routingCatalog.models).toEqual([{ provider: GESUNDAI_TARGET.provider, serviceId: GESUNDAI_TARGET.serviceId }]);
    expect(routingCatalog.preferencesSchema.properties.cqt).toMatchObject({
      title: 'Cost quality', description: 'Set your preferred balance between cost and response quality.',
    });
    const offer = resolveServiceBillingOffer(peer!.metadata!.providers, 'fake-levanto', 'levanto-route');
    expect(offer.unitModel.components[0]!.priceUsd).toBe(0);
    const body = { v: 1, preferences: { cqt: '5' }, service: 'levanto-route', inputMessage: 'Recommend the fixed target',
      catalogRevision: routingCatalog.revision,
      promptTokens: 5, expectedCachedTokens: [], constraints: { allowedPeerIds: [GESUNDAI_TARGET.peerId], allowedCandidates: [GESUNDAI_TARGET] } };
    const send = () => buyer.sendRequest(peer!, { requestId: randomUUID(), method: 'POST', path: '/_antseed/levanto-route',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) }, {
      unitBilling: offer, maxFeeMicroUsdc: '0', acceptResponse: (response) => {
        validateRoutingResponse(JSON.parse(Buffer.from(response.body).toString()), body);
        return true;
      },
    });
    const response = await send();
    expect(response.statusCode).toBe(200);
    expect(validateRoutingResponse(JSON.parse(Buffer.from(response.body).toString()), body)).toEqual([
      { peer: GESUNDAI_TARGET.peerId, model: GESUNDAI_TARGET.serviceId, provider: GESUNDAI_TARGET.provider },
    ]);
    available = false;
    const missing = await send();
    expect(missing.statusCode).toBe(503);
    expect(Buffer.from(missing.body).toString()).toContain('not available');
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
