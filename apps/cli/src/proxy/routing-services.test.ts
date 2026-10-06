import test from 'node:test';
import assert from 'node:assert/strict';
import type { PeerInfo } from '@antseed/node';
import { ModelRoutingClient } from '@antseed/router-core';
import { buildRoutingServices } from './routing-services.js';
import { RoutingModelsCache } from './router-execution.js';

const node = { sendRequest: async () => { throw new Error('unused'); } };
const client = { listModels: async () => ['openai/gpt-5'], selectRoute: async () => null };

function peer(): PeerInfo {
  const peerId = 'a'.repeat(40) as PeerInfo['peerId'];
  return { peerId, lastSeen: 0, providers: ['router'], displayName: 'Test router',
    providerServiceApiProtocols: { router: { services: { routing: ['model-routing'], image: ['openai-images'], 'gpt-5': ['openai-chat-completions'] } } },
    metadata: {
    peerId, version: 12, region: 'test', timestamp: 0, signature: '', providers: [{
      provider: 'router', services: ['routing', 'image', 'gpt-5'],
      defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, maxConcurrency: 10, currentLoad: 0,
      serviceApiProtocols: { routing: ['model-routing'], image: ['openai-images'], 'gpt-5': ['openai-chat-completions'] },
      serviceUnitBillingModels: {
        routing: { 'model-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } },
        image: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.01 }] } },
      },
    }],
  } };
}

test('discovery exposes IRP completed-request offers and canonically matched network models', async () => {
  const services = await buildRoutingServices([peer()], client, node);
  assert.equal(services.length, 1);
  const found = services[0]!;
  assert.equal(found.serviceId, 'routing');
  assert.equal(found.priceMicroUsdc, '1000');
  assert.equal(found.label, 'Test router');
  assert.deepEqual(found.catalog, { models: [{ provider: 'router', serviceId: 'gpt-5' }] });
  const unnamed = peer();
  delete unnamed.displayName;
  assert.equal((await buildRoutingServices([unnamed], client, node))[0]!.label, 'router');
});

test('missing, ambiguous and token-only offers cannot become routing purchases', async () => {
  const missing = peer();
  delete missing.metadata;
  const ambiguous = peer();
  ambiguous.metadata!.providers.push(structuredClone(ambiguous.metadata!.providers[0]!));
  const tokenOnly = peer();
  delete tokenOnly.metadata!.providers[0]!.serviceUnitBillingModels;
  assert.deepEqual(await buildRoutingServices([missing, ambiguous, tokenOnly], client, node), []);
});

test('discovery caches listModels, surfaces failures and recovers without stale data', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  let calls = 0;
  let fail = false;
  const routingClient = { ...client, listModels: async () => {
    calls++;
    if (fail) throw new Error('Router models unavailable (503)');
    return ['openai/gpt-5'];
  } };
  const cache = new RoutingModelsCache(60_000);
  const found = (await buildRoutingServices([peer()], routingClient, node, cache))[0]!;
  assert.equal(found.catalogExpiresAt, 61_000);
  await buildRoutingServices([peer()], routingClient, node, cache);
  assert.equal(calls, 1);
  fail = true;
  context.mock.timers.setTime(62_000);
  const failed = (await buildRoutingServices([peer()], routingClient, node, cache))[0]!;
  assert.equal(failed.catalog, undefined);
  assert.match(failed.catalogError!, /503/);
  fail = false;
  assert.deepEqual((await buildRoutingServices([peer()], routingClient, node, cache))[0]!.catalog, found.catalog);
  assert.equal(calls, 3);
});

test('discovery uses free IRP models requests and rejects malformed model responses', async () => {
  let invalid = false;
  const routingClient = new ModelRoutingClient();
  const transport: Parameters<typeof buildRoutingServices>[2] = { sendRequest: async (target, request, options) => {
    assert.equal(target.peerId, peer().peerId);
    assert.equal(request.method, 'GET');
    assert.equal(request.path, '/v1/routing/models');
    assert.equal(request.headers['x-antseed-service'], 'routing');
    assert.equal(options?.controlPlane, true);
    return { requestId: request.requestId, statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(
      invalid ? { models: ['gpt-5'] } : { object: 'list', data: [{ id: 'openai/gpt-5', object: 'model' }] },
    )) };
  } };
  assert.ok((await buildRoutingServices([peer()], routingClient, transport))[0]!.catalog);
  invalid = true;
  const result = (await buildRoutingServices([peer()], routingClient, transport))[0]!;
  assert.equal(result.catalog, undefined);
  assert.ok(result.catalogError);
});
