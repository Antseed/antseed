import test from 'node:test';
import assert from 'node:assert/strict';
import type { PeerInfo } from '@antseed/node';
import { buildRoutingServices } from './routing-services.js';
import { createRoutingServiceMetadata, type RoutingCatalogV1, type Router } from '@antseed/node';
import { RoutingCatalogCache } from './routing-catalog-cache.js';

function createRoutingCatalog(models: RoutingCatalogV1['models'], preferencesSchema: RoutingCatalogV1['preferencesSchema'] = { type: 'object', properties: {}, additionalProperties: false }, options: { title?: string } = {}): RoutingCatalogV1 {
  return { version: 1, revision: 'test-catalog-1', models, preferencesSchema, ...options };
}

const identity = { peerId: 'a'.repeat(40) as PeerInfo['peerId'] };
const noSchema = createRoutingServiceMetadata({ type: 'object', properties: {}, additionalProperties: false });
function routerWith(getCatalog?: () => Promise<RoutingCatalogV1 | undefined>): Router {
  return { selectPeer: () => null, onResult: () => {}, getModelRouterAdapter: target => {
    if (target.serviceId !== 'routing') throw new Error('Unsupported');
    return { routingMetadata: noSchema, selectRoute: async () => null, ...(getCatalog ? { getCatalog } : {}) };
  } };
}

function peer(): PeerInfo {
  const peerId = identity.peerId;
  return { peerId, lastSeen: 0, providers: ['levanto'], displayName: 'Test router', metadata: {
    peerId, version: 12, region: 'test', timestamp: 0, signature: '', providers: [{
    provider: 'levanto', services: ['routing', 'image'],
    defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, maxConcurrency: 10, currentLoad: 0,
    serviceApiProtocols: { routing: ['levanto-routing'], image: ['openai-images'] },
    serviceUnitBillingModels: {
      routing: { 'levanto-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } },
      image: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.01 }] } },
    },
  }] } };
}

test('routing discovery exposes exact completed-request offers without image services', async () => {
  assert.deepEqual(await buildRoutingServices([peer()]), [{ peerId: identity.peerId, provider: 'levanto', serviceId: 'routing', label: 'Test router', sellerName: 'Test router', priceMicroUsdc: '1000' }]);
});

test('router title comes from the plugin catalog and seller name from discovery, with provider fallback', async () => {
  const advertised = peer();
  advertised.displayName = 'Levanto';
  const router = routerWith(async () => createRoutingCatalog([], undefined, { title: 'Auto Router' }));
  const found = (await buildRoutingServices([advertised], router))[0]!;
  assert.equal(found.label, 'Auto Router');
  assert.equal(found.sellerName, 'Levanto');
  assert.equal(found.provider, 'levanto');
  delete advertised.displayName;
  assert.equal((await buildRoutingServices([advertised], router))[0]!.sellerName, 'levanto');
  assert.equal((await buildRoutingServices([advertised], router))[0]!.label, 'Auto Router');
  const unknown = (await buildRoutingServices([advertised], routerWith()))[0]!;
  assert.equal(unknown.label, 'levanto');
  assert.equal(unknown.catalog, undefined);
  assert.equal(unknown.catalogError, undefined);
});

test('missing, ambiguous and token-only offers cannot become routing purchases', async () => {
  const missing = peer();
  delete missing.metadata;
  const ambiguous = peer();
  ambiguous.metadata!.providers.push(structuredClone(ambiguous.metadata!.providers[0]!));
  const tokenOnly = peer();
  delete tokenOnly.metadata!.providers[0]!.serviceUnitBillingModels;
  assert.deepEqual(await buildRoutingServices([missing, ambiguous, tokenOnly]), []);
});

test('router discovery publishes plugin catalogs, caches them and surfaces catalog errors', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }]);
  let calls = 0;
  let fail = false;
  const router = routerWith(async () => { calls++; if (fail) throw new Error('Router catalog unavailable (503)'); return catalog; });
  const cache = new RoutingCatalogCache(60_000);
  const found = (await buildRoutingServices([peer()], router, cache))[0]!;
  assert.deepEqual(found.catalog, catalog);
  assert.equal(found.catalogExpiresAt, 61_000);
  await buildRoutingServices([peer()], router, cache);
  assert.equal(calls, 1);
  fail = true;
  context.mock.timers.setTime(62_000);
  const failed = (await buildRoutingServices([peer()], router, cache))[0]!;
  assert.equal(failed.catalog, undefined);
  assert.match(failed.catalogError!, /503/);
  fail = false;
  context.mock.timers.setTime(68_000);
  assert.deepEqual((await buildRoutingServices([peer()], router, cache))[0]!.catalog, catalog);
  assert.equal(calls, 3);
});

test('invalid plugin catalogs are reported instead of trusted', async () => {
  const catalog = createRoutingCatalog([{ provider: 'openai', serviceId: 'model-a' }]);
  const found = (await buildRoutingServices([peer()], routerWith(async () => ({ ...catalog, revision: '' }))))[0]!;
  assert.equal(found.catalog, undefined);
  assert.match(found.catalogError!, /Invalid routing catalog/);
});

test('registered routing protocols expose their own enum schemas without Levanto-specific discovery', async () => {
  const advertised = peer();
  const provider = advertised.metadata!.providers[0]!;
  provider.serviceApiProtocols = { routing: ['openai-responses'] };
  provider.serviceUnitBillingModels = { routing: { 'openai-responses': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0 }] } } };
  const schema = { type: 'object' as const, additionalProperties: false as const, properties: {
    mode: { type: 'string' as const, enum: ['quick', 'thorough'], default: 'quick' },
  } };
  const router = routerWith(async () => createRoutingCatalog([], schema));
  assert.deepEqual((await buildRoutingServices([advertised], router))[0]!.catalog!.preferencesSchema, schema);
});
