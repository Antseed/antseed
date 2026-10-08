import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertNoInlineSecrets, bindUpstream, configHash, DEFAULT_SOURCE_CONFIG, listModels, loadSourceConfig, resolveConfigSource, sanitizeConfig } from '../lib/config.mjs';
import { assertScenarioSupported, buyerRoutingPreferences, MAX_SELLERS, normalizeTopology, topologyFingerprint, validateScenarioModule } from '../lib/topology.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'sandbox-config-'));
after(() => rm(tmp, { recursive: true, force: true }));

const realConfig = () => ({
  identity: { privateKeyPath: '/Users/me/.antseed/identity.key' },
  dataDir: '/Users/me/.antseed',
  network: { dhtPort: 6881, signalingPort: 6882, bootstrapNodes: ['dht1.antseed.com:6881'] },
  seller: {
    publicAddress: '1.2.3.4',
    providers: {
      venice: {
        plugin: 'openai',
        baseUrl: 'https://api.venice.ai/api',
        apiKeyEnv: 'VENICE_API_KEY',
        defaults: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
        relay: { enabled: true },
        services: { 'venice-large': { upstreamModel: 'llama', categories: ['chat'], pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 6 }, internal: true } },
      },
    },
  },
  buyer: { proxyPort: 8377, routingPreferences: { minTrustScore: 50, preferLowLatency: true, allowedPeerIds: ['ffff'] }, maxPricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } } },
  payments: { crypto: { chainId: 'base-mainnet', rpcUrl: 'https://mainnet.base.org', depositsAddress: '0xabc' }, systemProxy: true },
  verifier: { enabled: true },
});

describe('sanitizeConfig', () => {
  it('copies only allowed settings and reports the rest as dropped', () => {
    const { cleaned, dropped } = sanitizeConfig(realConfig());
    assert.deepEqual(Object.keys(cleaned).sort(), ['buyer', 'payments', 'seller']);
    assert.deepEqual(cleaned.payments, { crypto: { chainId: 'base-mainnet' } });
    const venice = cleaned.seller.providers.venice;
    assert.deepEqual(Object.keys(venice).sort(), ['apiKeyEnv', 'baseUrl', 'defaults', 'plugin', 'services']);
    assert.deepEqual(Object.keys(venice.services['venice-large']).sort(), ['categories', 'pricing', 'upstreamModel']);
    assert.deepEqual(Object.keys(cleaned.buyer).sort(), ['maxPricing', 'routingPreferences']);
    for (const key of ['identity', 'dataDir', 'network', 'seller.publicAddress', 'seller.providers.venice.relay', 'buyer.proxyPort', 'payments.crypto.rpcUrl', 'payments.crypto.depositsAddress', 'payments.systemProxy', 'verifier']) {
      assert.ok(dropped.includes(key), `dropped ${key}`);
    }
  });

  it('refuses inline secrets anywhere, naming the path', () => {
    const config = realConfig();
    config.seller.providers.venice.apiKey = 'sk-live-123';
    assert.throws(() => sanitizeConfig(config), /inline secret at \$\.seller\.providers\.venice\.apiKey/);
    assert.throws(() => assertNoInlineSecrets({ payments: { crypto: { privateKey: '0xdead' } } }), /privateKey/);
    assert.throws(() => assertNoInlineSecrets({ x: [{ token: 'abc' }] }), /\$\.x\[0\]\.token/);
    assert.throws(() => assertNoInlineSecrets({ mnemonic: 'a b c' }), /mnemonic/);
    assert.doesNotThrow(() => assertNoInlineSecrets({ apiKeyEnv: 'OPENAI_API_KEY', apiKey: '' }));
  });

  it('validates apiKeyEnv, providers and chain', () => {
    const config = realConfig();
    config.seller.providers.venice.apiKeyEnv = 'not a var';
    assert.throws(() => sanitizeConfig(config), /apiKeyEnv must be an environment variable name/);
    assert.throws(() => sanitizeConfig({ seller: { providers: {} } }), /at least one seller\.providers/);
    assert.throws(() => sanitizeConfig({ seller: { providers: { a: { plugin: 'openai', services: {} } } } }), /at least one model/);
    const testnet = realConfig();
    testnet.payments.crypto.chainId = 'base-sepolia';
    assert.throws(() => sanitizeConfig(testnet), /not supported yet/);
  });

  it('hashes deterministically regardless of key order', () => {
    assert.equal(configHash({ a: 1, b: { c: 2, d: 3 } }), configHash({ b: { d: 3, c: 2 }, a: 1 }));
    assert.equal(sanitizeConfig(realConfig()).hash, sanitizeConfig(realConfig()).hash);
    assert.match(sanitizeConfig(realConfig()).hash, /^[0-9a-f]{64}$/);
  });

  it('lists models for the mock catalog', () => {
    assert.deepEqual(listModels(sanitizeConfig(realConfig()).cleaned), ['venice-large']);
    assert.deepEqual(listModels(sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned), ['sandbox-chat']);
  });

  it('never writes the source file', async () => {
    const file = join(tmp, 'source.json');
    const text = `${JSON.stringify(realConfig(), null, 2)}\n`;
    await writeFile(file, text);
    const loaded = await loadSourceConfig({ path: file, origin: '--config' });
    loaded.cleaned.seller.providers.venice.plugin = 'mutated';
    assert.equal(await readFile(file, 'utf8'), text);
  });

  it('resolves the source: --config, then env, then .antseed-sandbox.json, then built-in', async () => {
    assert.equal(resolveConfigSource({ explicit: 'x.json', env: { ANTSEED_SANDBOX_CONFIG: 'y.json' }, worktree: tmp }).origin, '--config');
    assert.equal(resolveConfigSource({ env: { ANTSEED_SANDBOX_CONFIG: 'y.json' }, worktree: tmp }).origin, 'ANTSEED_SANDBOX_CONFIG');
    assert.equal(resolveConfigSource({ env: {}, worktree: tmp }).origin, 'built-in default');
    await writeFile(join(tmp, '.antseed-sandbox.json'), '{}');
    assert.equal(resolveConfigSource({ env: {}, worktree: tmp }).origin, '.antseed-sandbox.json');
  });
});

describe('bindUpstream', () => {
  const cleaned = () => sanitizeConfig(realConfig()).cleaned;

  it('mock mode points every provider at the mock with a throwaway key', () => {
    const { providers, sellerEnv } = bindUpstream(cleaned(), { mode: 'mock', mockUrl: 'http://127.0.0.1:5000', env: { VENICE_API_KEY: 'real' } });
    assert.equal(providers.venice.baseUrl, 'http://127.0.0.1:5000');
    assert.equal(providers.venice.apiKeyEnv, 'SANDBOX_KEY_VENICE');
    assert.deepEqual(sellerEnv, { SANDBOX_KEY_VENICE: 'mock-only' });
    assert.ok(!Object.values(sellerEnv).includes('real'), 'real key never reaches a mock seller');
  });

  it('mock mode refuses plugins without a mock', () => {
    const config = sanitizeConfig({ seller: { providers: { a: { plugin: 'anthropic', services: { m: {} } } } } }).cleaned;
    assert.throws(() => bindUpstream(config, { mode: 'mock', mockUrl: 'http://127.0.0.1:1' }), /no sandbox mock yet/);
    const unknown = sanitizeConfig({ seller: { providers: { a: { plugin: 'some-npm-plugin', services: { m: {} } } } } }).cleaned;
    assert.throws(() => bindUpstream(unknown, { mode: 'mock', mockUrl: 'http://127.0.0.1:1' }), /cannot load/);
  });

  it('live mode requires every apiKeyEnv and HTTPS', () => {
    assert.throws(() => bindUpstream(cleaned(), { mode: 'live', env: {} }), /--live requires VENICE_API_KEY/);
    const { sellerEnv, providers } = bindUpstream(cleaned(), { mode: 'live', env: { VENICE_API_KEY: 'k' } });
    assert.deepEqual(sellerEnv, { VENICE_API_KEY: 'k' });
    assert.equal(providers.venice.baseUrl, 'https://api.venice.ai/api');
    const http = cleaned();
    http.seller.providers.venice.baseUrl = 'http://api.example.com';
    assert.throws(() => bindUpstream(http, { mode: 'live', env: { VENICE_API_KEY: 'k' } }), /HTTPS/);
  });
});

describe('topology', () => {
  const source = sanitizeConfig(realConfig()).cleaned;

  it('defaults to one seller inheriting the config providers', () => {
    const topology = normalizeTopology({}, source);
    assert.equal(topology.sellers.length, 1);
    assert.equal(topology.sellers[0].id, 'seller');
    assert.deepEqual(topology.sellers[0].providers, source.seller.providers);
    assert.equal(topology.buyer.depositMicros, '10000000');
    assert.ok(topology.buyer.maxPricing);
  });

  it('applies overrides and per-seller providers', () => {
    const topology = normalizeTopology({
      sellers: [{ id: 'a', mock: { latencyMs: 50 } }, { id: 'b', providers: { other: { plugin: 'openai', services: { x: {} } } } }],
      buyer: { depositUsdc: '1', routingPreferences: { preferLowLatency: false } },
      chain: { block: 100 },
    }, source, { depositUsdc: '2.5', block: '200' });
    assert.equal(topology.sellers[0].mock.latencyMs, 50);
    assert.deepEqual(Object.keys(topology.sellers[1].providers), ['other']);
    assert.equal(topology.buyer.depositMicros, '2500000');
    assert.equal(topology.chain.block, 200);
    assert.equal(topology.buyer.routingPreferences.preferLowLatency, false);
  });

  it('rejects bad topologies', () => {
    assert.throws(() => normalizeTopology({ sellers: [] }, source), /at least one seller/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a' }, { id: 'a' }] }, source), /Duplicate seller/);
    assert.throws(() => normalizeTopology({ sellers: Array.from({ length: MAX_SELLERS + 1 }, (_, i) => ({ id: `s${i}` })) }, source), /At most/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'Bad Id' }] }, source), /Invalid seller id/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', mock: { latencyMs: -1 } }] }, source), /latencyMs/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'a', providers: { p: { plugin: 'openai', apiKey: 'sk', services: { m: {} } } } }] }, source), /inline secret/);
  });

  it('buyer routing keeps config prefs but forces trust 0 and only our sellers', () => {
    const prefs = buyerRoutingPreferences(normalizeTopology({}, source), ['aa', 'bb']);
    assert.equal(prefs.minTrustScore, 0);
    assert.deepEqual(prefs.allowedPeerIds, ['aa', 'bb']);
    assert.deepEqual(prefs.blockedPeerIds, []);
    assert.equal(prefs.preferLowLatency, true);
    assert.deepEqual(buyerRoutingPreferences(normalizeTopology({}, source), ['aa'], ['rr']).allowedPeerIds, ['aa', 'rr']);
  });

  it('declares routing peers explicitly', () => {
    const topology = normalizeTopology({ routers: [{ id: 'levanto', priceUsd: '0.001' }] }, source);
    assert.deepEqual(topology.routers, [{ id: 'levanto', priceUsd: '0.001' }]);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 'same' }], routers: [{ id: 'same' }] }, source), /Duplicate peer/);
    assert.throws(() => normalizeTopology({ routers: [{ id: 'bad', priceUsd: -1 }] }, source), /priceUsd/);
  });

  it('fingerprints sellers and models for reuse checks', () => {
    const one = topologyFingerprint(normalizeTopology({}, source));
    assert.equal(one, topologyFingerprint(normalizeTopology({ buyer: { depositUsdc: '3' } }, source)));
    assert.notEqual(one, topologyFingerprint(normalizeTopology({ sellers: [{ id: 'a' }, { id: 'b' }] }, source)));
    assert.notEqual(one, topologyFingerprint(normalizeTopology({ routers: [{ id: 'levanto' }] }, source)));
  });
});

describe('scenario modules', () => {
  it('validates exports and target capabilities', () => {
    assert.throws(() => validateScenarioModule({}, 'x'), /must export async function run/);
    assert.throws(() => validateScenarioModule({ run() {}, meta: { targets: [] } }, 'x'), /non-empty/);
    const scenario = validateScenarioModule({ run() {}, meta: { requires: ['mockControl'] } }, 'x');
    assert.deepEqual(scenario.targets, ['fork']);
    assert.doesNotThrow(() => assertScenarioSupported(scenario, 'fork'));
    assert.throws(() => assertScenarioSupported(validateScenarioModule({ run() {}, meta: { targets: ['mainnet'] } }, 'm'), 'fork'), /does not support target fork/);
    assert.throws(() => assertScenarioSupported(validateScenarioModule({ run() {}, meta: { requires: ['teleport'] } }, 't'), 'fork'), /lacks teleport/);
  });

  it('every shipped scenario is valid', async () => {
    for (const name of ['chat-basic', 'routing-smoke', 'load-mixed', 'load-ramp', 'chaos-seller-drop']) {
      const scenario = validateScenarioModule(await import(`../scenarios/${name}.mjs`), name);
      assertScenarioSupported(scenario, 'fork');
      assert.ok(scenario.description);
      normalizeTopology(scenario.topology, sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned);
    }
  });
});
