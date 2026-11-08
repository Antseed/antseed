import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { assertNoInlineSecrets, bindUpstream, configHash, DEFAULT_SOURCE_CONFIG, listModels, loadSourceConfig, resolveConfigSource, sanitizeConfig } from '../lib/config.mjs';
import { pathToFileURL } from 'node:url';
import { scenarioFile, scenarioFiles } from '../lib/scenarios.mjs';
import { assertScenarioSupported, assertUpstreamReusable, buyerRoutingPreferences, chooseMode, chooseTarget, MAX_SELLERS, normalizeTopology, requestedMode, requestedUpstream, topologyDifferences, topologyFingerprint, topologySummary, validateScenarioModule } from '../lib/topology.mjs';

const tmp = await mkdtemp(join(tmpdir(), 'testbench-config-'));
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
    assert.deepEqual(listModels(sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned), ['testbench-chat']);
  });

  it('never writes the source file', async () => {
    const file = join(tmp, 'source.json');
    const text = `${JSON.stringify(realConfig(), null, 2)}\n`;
    await writeFile(file, text);
    const loaded = await loadSourceConfig({ path: file, origin: '--config' });
    loaded.cleaned.seller.providers.venice.plugin = 'mutated';
    assert.equal(await readFile(file, 'utf8'), text);
  });

  it('resolves the source: --config, then env, then .antseed-testbench.json, then built-in', async () => {
    assert.equal(resolveConfigSource({ explicit: 'x.json', env: { ANTSEED_TESTBENCH_CONFIG: 'y.json' }, worktree: tmp }).origin, '--config');
    assert.equal(resolveConfigSource({ env: { ANTSEED_TESTBENCH_CONFIG: 'y.json' }, worktree: tmp }).origin, 'ANTSEED_TESTBENCH_CONFIG');
    assert.equal(resolveConfigSource({ env: {}, worktree: tmp }).origin, 'built-in default');
    await writeFile(join(tmp, '.antseed-testbench.json'), '{}');
    assert.equal(resolveConfigSource({ env: {}, worktree: tmp }).origin, '.antseed-testbench.json');
  });
});

describe('bindUpstream', () => {
  const cleaned = () => sanitizeConfig(realConfig()).cleaned;

  it('mock mode points every provider at the mock with a throwaway key', () => {
    const { providers, sellerEnv } = bindUpstream(cleaned(), { mode: 'mock', mockUrl: 'http://127.0.0.1:5000', env: { VENICE_API_KEY: 'real' } });
    assert.equal(providers.venice.baseUrl, 'http://127.0.0.1:5000');
    assert.equal(providers.venice.apiKeyEnv, 'TESTBENCH_KEY_VENICE');
    assert.deepEqual(sellerEnv, { TESTBENCH_KEY_VENICE: 'mock-only' });
    assert.ok(!Object.values(sellerEnv).includes('real'), 'real key never reaches a mock seller');
  });

  it('mock mode refuses plugins without a mock', () => {
    const config = sanitizeConfig({ seller: { providers: { a: { plugin: 'anthropic', services: { m: {} } } } } }).cleaned;
    assert.throws(() => bindUpstream(config, { mode: 'mock', mockUrl: 'http://127.0.0.1:1' }), /no testbench mock yet/);
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

  it('validates per-topology payment settings', () => {
    assert.deepEqual(normalizeTopology({}, source).payments, {});
    assert.equal(normalizeTopology({ payments: { settlementIdleMs: 5000 } }, source).payments.settlementIdleMs, 5000);
    assert.throws(() => normalizeTopology({ payments: { settlementIdleMs: 10 } }, source), /settlementIdleMs/);
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
  });

  it('fingerprints every behavior-affecting setting for reuse checks', () => {
    const one = topologyFingerprint(normalizeTopology({}, source));
    assert.equal(one, topologyFingerprint(normalizeTopology({}, source)), 'identical topologies still match');
    assert.equal(one, topologyFingerprint(JSON.parse(JSON.stringify(normalizeTopology({}, source)))), 'a manifest round trip still matches');
    assert.notEqual(one, topologyFingerprint(normalizeTopology({ sellers: [{ id: 'a' }, { id: 'b' }] }, source)));
    const variants = {
      'buyer.depositMicros': { buyer: { depositUsdc: '3' } },
      'buyer.maxReserveMicros': { buyer: { maxReserveUsdc: '0.25' } },
      'buyer.maxPricing': { buyer: { maxPricing: { defaults: { inputUsdPerMillion: 1 } } } },
      'buyer.env': { buyer: { env: { ANTSEED_DEBUG: '1' } } },
      'payments.settlementIdleMs': { payments: { settlementIdleMs: 5000 } },
      'payments.minBudgetPerRequestMicros': { payments: { minBudgetPerRequestUsdc: '0.01' } },
      'chain.topUpThresholdBps': { chain: { topUpThresholdBps: 5000 } },
      'chain.blockTimeSec': { chain: { blockTimeSec: 3 } },
      'sellers.0.mock.latencyMs': { sellers: [{ id: 'seller', mock: { latencyMs: 250 } }] },
      'sellers.0.mock.fault500Rate': { sellers: [{ id: 'seller', mock: { fault500Rate: 0.1 } }] },
      'sellers.0.env': { sellers: [{ id: 'seller', env: { ANTSEED_DEBUG: '1' } }] },
    };
    for (const [path, topology] of Object.entries(variants)) {
      const other = normalizeTopology(topology, source);
      assert.notEqual(topologyFingerprint(other), one, `${path} changes the fingerprint`);
      assert.ok(topologyDifferences(normalizeTopology({}, source), other).some((entry) => entry.startsWith(path)), `${path} is named: ${topologyDifferences(normalizeTopology({}, source), other)}`);
    }
    assert.equal(topologySummary(normalizeTopology({ buyer: { depositUsdc: '3' } }, source)), topologySummary(normalizeTopology({}, source)), 'the summary stays short');
  });

  it('reuses a running testbench only with the upstream the command asked for', () => {
    assert.equal(requestedUpstream(undefined), 'mock');
    assert.equal(requestedUpstream(true), 'live');
    assert.doesNotThrow(() => assertUpstreamReusable('mock', 'mock'));
    assert.doesNotThrow(() => assertUpstreamReusable(undefined, 'mock'), 'a manifest without upstream is a mock one');
    assert.doesNotThrow(() => assertUpstreamReusable('live', 'live'));
    assert.throws(() => assertUpstreamReusable('live', 'mock', 'Testbench wt-x'), /Testbench wt-x is running with a live upstream, not mock \(this command has no --live\); run pnpm testbench down first or use --slot/);
    assert.throws(() => assertUpstreamReusable('mock', 'live'), /running with a mock upstream, not live; run pnpm testbench down first or use --slot/);
  });
});

describe('topology mode', () => {
  const source = sanitizeConfig(realConfig()).cleaned;

  it('defaults to sdk, takes the topology value and lets the override win', () => {
    assert.equal(normalizeTopology({}, source).mode, 'sdk');
    assert.equal(normalizeTopology({ mode: 'cli' }, source).mode, 'cli');
    assert.equal(normalizeTopology({ mode: 'cli' }, source, { mode: 'sdk' }).mode, 'sdk');
    assert.equal(normalizeTopology({}, source, { mode: 'cli' }).mode, 'cli');
    assert.equal(requestedMode(undefined, undefined), 'sdk');
    assert.equal(requestedMode(undefined, { mode: 'cli' }), 'cli');
    assert.equal(requestedMode('sdk', { mode: 'cli' }), 'sdk');
  });

  it('refuses an unknown mode', () => {
    assert.throws(() => normalizeTopology({ mode: 'docker' }, source), /mode must be one of sdk, cli/);
    assert.throws(() => normalizeTopology({}, source, { mode: 'docker' }), /mode must be one of sdk, cli/);
  });

  it('chooses the run mode from --mode, the running testbench, the topology, then sdk', () => {
    const plain = validateScenarioModule({ run() {}, meta: {} }, 'x');
    const declared = validateScenarioModule({ run() {}, topology: { mode: 'cli' }, meta: {} }, 'y');
    assert.equal(chooseMode(plain), 'sdk');
    assert.equal(chooseMode(declared), 'cli');
    assert.equal(chooseMode(plain, { requested: 'cli' }), 'cli');
    assert.equal(chooseMode(plain, { running: 'cli' }), 'cli', 'a run without --mode inherits the running testbench');
    assert.equal(chooseMode(declared, { running: 'sdk' }), 'sdk', 'the running testbench wins over the topology, as for chains');
    assert.equal(chooseMode(plain, { requested: 'cli', running: 'cli' }), 'cli');
    assert.throws(() => chooseMode(plain, { requested: 'sdk', running: 'cli' }), /running in cli mode, not sdk/);
    assert.throws(() => chooseMode(plain, { requested: 'cli', running: 'sdk' }), /running in sdk mode, not cli/);
  });

  it('inherited, the mode matches the running fingerprint', () => {
    const running = topologyFingerprint(normalizeTopology({}, source, { mode: 'cli' }));
    const scenario = validateScenarioModule({ run() {}, topology: {}, meta: {} }, 'x');
    assert.equal(topologyFingerprint(normalizeTopology(scenario.topology, source, { mode: chooseMode(scenario, { running: 'cli' }) })), running);
  });

  it('puts the mode in the fingerprint, so a run cannot reuse a testbench of the other mode', () => {
    const sdk = topologyFingerprint(normalizeTopology({}, source));
    assert.equal(sdk, topologyFingerprint(normalizeTopology({ mode: 'sdk' }, source)));
    assert.notEqual(sdk, topologyFingerprint(normalizeTopology({ mode: 'cli' }, source)));
    assert.match(topologySummary(normalizeTopology({ mode: 'cli', chain: { rpc: 'base' } }, source)), /#rpc=base#mode=cli$/);
    assert.equal(topologyFingerprint(normalizeTopology({ chain: { rpc: 'direct' } }, source)), sdk, 'a manifest from before modes reads as sdk');
  });

  it('buyerFaults is an sdk-mode capability on fork and local', () => {
    const scenario = validateScenarioModule({ run() {}, meta: { targets: ['local', 'fork', 'mainnet'], requires: ['buyerFaults'] } }, 'faulty');
    assert.doesNotThrow(() => assertScenarioSupported(scenario, 'local'));
    assert.doesNotThrow(() => assertScenarioSupported(scenario, 'fork', 'sdk'));
    assert.throws(() => assertScenarioSupported(scenario, 'local', 'cli'), /Mode cli lacks buyerFaults required by faulty; run it with --mode sdk/);
    assert.throws(() => assertScenarioSupported(scenario, 'mainnet'), /Target mainnet lacks buyerFaults/);
    const plain = validateScenarioModule({ run() {}, meta: { targets: ['local'], requires: ['mockControl', 'buyerControl'] } }, 'plain');
    assert.doesNotThrow(() => assertScenarioSupported(plain, 'local', 'cli'));
  });

  it('issue-1200 asks for buyerFaults; the scenarios cli mode must run do not', async () => {
    const load = async (name) => validateScenarioModule(await import(pathToFileURL(scenarioFile(name)).href), name);
    assert.ok((await load('issue-1200-spendingauth-catchup')).requires.includes('buyerFaults'));
    for (const name of ['chat-basic', 'payment-flow', 'routing-smoke', 'stress-smoke', 'stress-restart-buyer', 'stress-restart-seller', 'issue-1050-stale-channel']) {
      const scenario = await load(name);
      assert.doesNotThrow(() => assertScenarioSupported(scenario, 'local', 'cli'), name);
    }
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

  it('chooses the chain target from --chain, the running testbench, then the scenario', () => {
    const scenario = validateScenarioModule({ run() {}, meta: { targets: ['local', 'fork'] } }, 'x');
    assert.equal(chooseTarget(scenario), 'local');
    assert.equal(chooseTarget(scenario, { running: 'fork' }), 'fork');
    assert.equal(chooseTarget(scenario, { requested: 'fork' }), 'fork');
    assert.throws(() => chooseTarget(scenario, { requested: 'local', running: 'fork' }), /running on chain fork/);
    assert.doesNotThrow(() => assertScenarioSupported(validateScenarioModule({ run() {}, meta: { targets: ['local'], requires: ['sourceContracts'] } }, 'y'), 'local'));
    assert.throws(() => assertScenarioSupported(validateScenarioModule({ run() {}, meta: { requires: ['sourceContracts'] } }, 'z'), 'fork'), /lacks sourceContracts/);
  });

  it('every scenario file is valid', async () => {
    const files = scenarioFiles();
    assert.ok(files.length >= 15, `expected the shipped scenarios, found ${files.length}`);
    for (const { name, group, file } of files) {
      if (name.startsWith('stress-')) assert.equal(group, 'stress', `${name} belongs in scenarios/stress/`);
      if (name.startsWith('issue-')) assert.equal(group, 'issues', `${name} belongs in scenarios/issues/`);
      if (group !== null) assert.ok(['stress', 'issues'].includes(group), `${name}: unknown scenario group ${group}`);
      const scenario = validateScenarioModule(await import(pathToFileURL(file).href), name);
      for (const target of scenario.targets) assertScenarioSupported(scenario, target);
      assert.ok(scenario.description, `${name} needs a description`);
    }
  });

  it('every shipped scenario is valid', async () => {
    const stress = ['stress-smoke', 'stress-c32', 'stress-c64', 'stress-smallreserve', 'stress-images', 'stress-faults', 'stress-restart-buyer', 'stress-restart-seller', 'issue-1050-stale-channel'];
    const cliScenarios = ['cli-buyer-commands', 'buyer-withdraw-and-exit', 'free-tier'];
    for (const name of ['chat-basic', 'routing-smoke', 'desktop-chat', 'payment-flow', 'issue-1200-spendingauth-catchup', ...stress, ...cliScenarios]) {
      const scenario = validateScenarioModule(await import(pathToFileURL(scenarioFile(name)).href), name);
      for (const target of scenario.targets) assertScenarioSupported(scenario, target);
      assert.ok(scenario.description);
      const topology = normalizeTopology(scenario.topology, sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned);
      if (cliScenarios.includes(name)) {
        assert.equal(topology.mode, 'cli', `${name} drives the CLI next to a CLI buyer`);
        assert.equal(topology.chain.contracts, undefined, `${name} runs on the full local layout`);
      }
    }
  });
});
