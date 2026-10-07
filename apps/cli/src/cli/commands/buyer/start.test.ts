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
  proxyDisplayUrl,
  resolveBuyerProxyListenOptions,
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

test('buyer start defaults to a loopback bind with no auth token', () => {
  assert.deepEqual(resolveBuyerProxyListenOptions({}, {}), { host: '127.0.0.1', authToken: null });
});

test('buyer start takes the auth token from --auth-token or ANTSEED_PROXY_TOKEN, flag first', () => {
  assert.deepEqual(
    resolveBuyerProxyListenOptions({ host: '0.0.0.0' }, { ANTSEED_PROXY_TOKEN: 'env-token-0123456789' }),
    { host: '0.0.0.0', authToken: 'env-token-0123456789' },
  );
  assert.equal(
    resolveBuyerProxyListenOptions({ authToken: 'flag-token-0123456789' }, { ANTSEED_PROXY_TOKEN: 'env-token-0123456789' }).authToken,
    'flag-token-0123456789',
  );
});

test('buyer start refuses a non-loopback bind without an auth token', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.20']) {
    assert.throws(() => resolveBuyerProxyListenOptions({ host }, {}), /Refusing to listen/);
  }
  assert.equal(resolveBuyerProxyListenOptions({ host: 'localhost' }, {}).host, 'localhost');
});

test('buyer start rejects weak auth tokens', () => {
  assert.throws(() => resolveBuyerProxyListenOptions({ authToken: 'short' }, {}), /at least 16/);
  assert.throws(() => resolveBuyerProxyListenOptions({}, { ANTSEED_PROXY_TOKEN: 'short' }), /at least 16/);
});

test('buyer start shows a reachable URL for the bind host', () => {
  assert.equal(proxyDisplayUrl('127.0.0.1', 8377), 'http://localhost:8377');
  assert.equal(proxyDisplayUrl('0.0.0.0', 8377), 'http://localhost:8377');
  assert.equal(proxyDisplayUrl('10.0.0.5', 8377), 'http://10.0.0.5:8377');
  assert.equal(proxyDisplayUrl('fd00::5', 8377), 'http://[fd00::5]:8377');
});

test('buyer start probe sends auth headers to a token-protected proxy', async () => {
  await withProbeServer((req, res) => {
    if (req.headers.authorization !== 'Bearer probe-token-0123456789') {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'x-antseed-request-id': 'probe' }).end('{}');
  }, async (port) => {
    assert.equal(await isCompatibleBuyerProxy(port), false);
    assert.equal(await isCompatibleBuyerProxy(port, 1200, { authorization: 'Bearer probe-token-0123456789' }), true);
  });
});
