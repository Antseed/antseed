import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import test from 'node:test';
import { createDefaultConfig } from '../../../config/defaults.js';
import { resolveEffectiveBuyerConfig } from '../../../config/effective.js';
import {
  buildBuyerRuntimeOverridesFromFlags,
  buildBuyerBootstrapEntries,
  buildRouterRuntimeEnvFromBuyerConfig,
  isCompatibleBuyerProxy,
  resolveBuyerRouterName,
} from './start.js';

async function withProbeServer(
  handler: RequestListener,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('buyer start runtime overrides are runtime-only and win over env/config', () => {
  const config = createDefaultConfig();
  config.buyer.proxyPort = 7777;
  config.buyer.maxPricing.defaults.inputUsdPerMillion = 50;
  config.buyer.maxPricing.defaults.outputUsdPerMillion = 60;
  config.buyer.metadataFetchTimeoutMs = 1500;
  const beforeResolution = JSON.parse(JSON.stringify(config));

  const env = {
    ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION: '70',
    ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION: '80',
    ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS: '2000',
  } as NodeJS.ProcessEnv;

  const overrides = buildBuyerRuntimeOverridesFromFlags({
    port: 9000,
    maxInputUsdPerMillion: 90,
    maxOutputUsdPerMillion: 95,
    metadataFetchTimeoutMs: 2500,
    disableMetadataV2Services: true,
  });

  const effective = resolveEffectiveBuyerConfig({
    config,
    env,
    buyerOverrides: overrides,
  });

  assert.equal(effective.proxyPort, 9000);
  assert.equal(effective.maxPricing.defaults.inputUsdPerMillion, 90);
  assert.equal(effective.maxPricing.defaults.outputUsdPerMillion, 95);
  assert.equal(effective.metadataFetchTimeoutMs, 2500);
  assert.equal(effective.disableMetadataV2Services, true);
  assert.deepEqual(config, beforeResolution);
});

test('buyer start rejects invalid metadata fetch timeout flag overrides', () => {
  const config = createDefaultConfig();

  const tooSmall = buildBuyerRuntimeOverridesFromFlags({ metadataFetchTimeoutMs: 0 });
  assert.throws(
    () => resolveEffectiveBuyerConfig({ config, buyerOverrides: tooSmall }),
    /buyer\.metadataFetchTimeoutMs must be an integer >= 100/,
  );

  const notANumber = buildBuyerRuntimeOverridesFromFlags({ metadataFetchTimeoutMs: Number.NaN });
  assert.throws(
    () => resolveEffectiveBuyerConfig({ config, buyerOverrides: notANumber }),
    /buyer\.metadataFetchTimeoutMs must be an integer >= 100/,
  );
});

test('buyer start maps effective buyer config into router runtime env keys', () => {
  const config = createDefaultConfig();
  config.buyer.minPeerReputation = 72;
  config.buyer.maxPricing.defaults.inputUsdPerMillion = 21;
  config.buyer.maxPricing.defaults.outputUsdPerMillion = 63;

  const runtimeEnv = buildRouterRuntimeEnvFromBuyerConfig(config.buyer);
  assert.equal(runtimeEnv['ANTSEED_MIN_REPUTATION'], '72');

  const parsed = JSON.parse(runtimeEnv['ANTSEED_MAX_PRICING_JSON'] ?? '{}') as {
    defaults?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number };
  };
  assert.equal(parsed.defaults?.inputUsdPerMillion, 21);
  assert.equal(parsed.defaults?.outputUsdPerMillion, 63);
});

test('buyer start bootstrap entries use official nodes when config is empty and include local seeder first', () => {
  const entries = buildBuyerBootstrapEntries([], 6881);
  assert.equal(entries[0], '127.0.0.1:6881');
  assert.ok(entries.length > 1);
});

test('buyer start bootstrap entries respect explicit configured nodes', () => {
  const entries = buildBuyerBootstrapEntries(['10.0.0.2:6881'], 6889);
  assert.equal(entries[0], '127.0.0.1:6889');
  assert.deepEqual(entries.slice(1), ['10.0.0.2:6881']);
});

test('buyer start defaults router name to local', () => {
  assert.equal(resolveBuyerRouterName({}), 'local');
  assert.equal(resolveBuyerRouterName({ router: 'claude-code' }), 'claude-code');
});

test('buyer start recognizes legacy proxies that only return no_peer_pinned', async () => {
  await withProbeServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'no_peer_pinned' } }));
  }, async (port) => {
    assert.equal(await isCompatibleBuyerProxy(port), true);
  });
});

test('buyer start recognizes current proxies by AntSeed response header', async () => {
  await withProbeServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-antseed-request-id': 'test' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
  }, async (port) => {
    assert.equal(await isCompatibleBuyerProxy(port), true);
  });
});
