import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { CLI_EVENT_STREAM_LIMIT, cliCommandEnv, cliEventData, createCliRunner, parseCliJson, runCli } from '../lib/cli-run.mjs';
import {
  alignChainClock, assertContractLayout, chainContracts, copyContract, expectedRegistryPointers, FULL_NONCES, FULL_ONLY_CHAIN_KEYS,
  LAYOUT_END_NONCE, LOCAL_CLOCK_LEAD_SECONDS, LOCAL_DEPLOYER, localChainConfig, localGenesisTimestamp, localLayout, MAINNET_ANTS_TOKEN,
  PAYMENTS_NONCES,
} from '../lib/local-deploy.mjs';
import { parseArgs } from '../lib/options.mjs';
import { cliActiveChannels } from '../lib/stress.mjs';
import { normalizeFreeTier, normalizeTopology, topologyFingerprint } from '../lib/topology.mjs';
import { cliSellerConfig } from '../lib/node-options.mjs';
import { createTestbenchApi } from '../lib/tb.mjs';
import { DEFAULT_SOURCE_CONFIG, sanitizeConfig } from '../lib/config.mjs';
import { micros, stderrProblems } from '../scenarios/cli-buyer-commands.mjs';
import { channelCommandResult, usdcArg } from '../scenarios/buyer-withdraw-and-exit.mjs';
import { freeTierRefusal } from '../scenarios/free-tier.mjs';

const require = createRequire(import.meta.url);
const { getCreateAddress } = require('ethers');
const sdk = await import('../../../packages/node/dist/index.js');
const preset = sdk.getChainConfig('base-local');
const source = sanitizeConfig(DEFAULT_SOURCE_CONFIG).cleaned;
const same = (left, right) => left?.toLowerCase() === right?.toLowerCase();

describe('local contract layout', () => {
  it('puts every contract at the deployer nonce the deploy scripts use, ANTS at the gate\'s hardcoded address', () => {
    const { chain, extra } = localLayout('full');
    for (const [key, nonce] of Object.entries(PAYMENTS_NONCES)) {
      if (key !== 'antsTokenAddress') assert.equal(chain[key], getCreateAddress({ from: LOCAL_DEPLOYER, nonce }), key);
    }
    assert.equal(chain.registryContractAddress, '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9');
    assert.equal(chain.antsTokenAddress, MAINNET_ANTS_TOKEN);
    assert.equal(extra.legacyAntsToken, getCreateAddress({ from: LOCAL_DEPLOYER, nonce: PAYMENTS_NONCES.antsTokenAddress }));
    for (const [key, nonce] of Object.entries(FULL_NONCES)) assert.equal({ ...chain, ...extra }[key], getCreateAddress({ from: LOCAL_DEPLOYER, nonce }), key);
    const { chain: payments, extra: none } = localLayout('payments');
    assert.equal(payments.antsTokenAddress, extra.legacyAntsToken);
    assert.deepEqual(none, {});
    for (const key of FULL_ONLY_CHAIN_KEYS) assert.equal(payments[key], undefined, key);
  });

  it('keeps the deploy steps in nonce order, inside each layout\'s nonce range', () => {
    const payments = Object.values(PAYMENTS_NONCES);
    assert.ok(payments.every((nonce) => nonce < LAYOUT_END_NONCE.payments));
    const full = Object.values(FULL_NONCES);
    assert.deepEqual(full, [...full].sort((a, b) => a - b));
    assert.ok(full.every((nonce) => nonce >= LAYOUT_END_NONCE.payments && nonce < LAYOUT_END_NONCE.full));
    assert.equal(new Set(full).size, full.length);
  });

  it('matches chain-config base-local, and refuses a preset that drifted from the deploy', () => {
    assert.doesNotThrow(() => localChainConfig(preset, 'full'));
    assert.throws(() => localChainConfig({ ...preset, registryContractAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' }, 'full'), /registryContractAddress is 0x9fE4.*deploy puts it at 0xCf7E/);
    assert.throws(() => localChainConfig({ ...preset, sellerPoolsAddress: undefined }, 'payments'), /sellerPoolsAddress is unset/);
  });

  it('names the cut-over stack on full, as base-mainnet does, and only Deploy.s.sol on payments', () => {
    const full = localChainConfig(preset, 'full');
    assert.equal(full.stakingContractAddress, preset.sellerRegistryAddress);
    assert.equal(full.emissionsContractAddress, preset.usageAccountingAddress);
    assert.equal(full.legacyStakingContractAddress, preset.stakingContractAddress);
    assert.equal(full.legacyEmissionsContractAddress, preset.emissionsContractAddress);
    const payments = localChainConfig(preset, 'payments');
    for (const key of FULL_ONLY_CHAIN_KEYS) assert.equal(payments[key], undefined, key);
    assert.equal(payments.stakingContractAddress, preset.stakingContractAddress);
    assert.equal(payments.antsTokenAddress, localLayout('full').extra.legacyAntsToken);
    assert.equal(payments.recognizedUsage, undefined);
    assert.equal(payments.depositsContractAddress, preset.depositsContractAddress);
  });

  it('expects the registry to point at the new stack only on full', () => {
    const full = expectedRegistryPointers('full');
    const payments = expectedRegistryPointers('payments');
    assert.ok(same(full.staking, preset.sellerRegistryAddress) && same(full.emissions, preset.usageAccountingAddress) && same(full.antsToken, MAINNET_ANTS_TOKEN));
    assert.ok(same(payments.staking, preset.stakingContractAddress) && same(payments.emissions, preset.emissionsContractAddress));
    assert.ok(same(full.channels, payments.channels) && same(full.deposits, preset.depositsContractAddress));
  });

  it('lists contracts by short name for tb.contracts, with the layout\'s extra contracts', () => {
    const contracts = chainContracts(localChainConfig(preset, 'full'), 'full');
    assert.equal(contracts.registry, preset.registryContractAddress);
    assert.equal(contracts.usdc, preset.usdcContractAddress);
    assert.equal(contracts.freeUsage, preset.freeUsageContractAddress);
    assert.equal(contracts.verification, preset.verificationContractAddress);
    assert.equal(contracts.staking, preset.sellerRegistryAddress);
    assert.equal(contracts.legacyStaking, preset.stakingContractAddress);
    assert.equal(contracts.verificationPointsPolicy, localLayout('full').extra.verificationPointsPolicy);
    const plain = chainContracts({ chainId: 'x', rpcUrl: 'http://127.0.0.1:1', depositsContractAddress: preset.depositsContractAddress, channelsDeployBlock: 5 });
    assert.deepEqual(plain, { deposits: preset.depositsContractAddress });
  });

  it('validates the layout name and starts only the full layout\'s chain in the past', () => {
    assert.throws(() => assertContractLayout('everything'), /chain.contracts must be one of full, payments/);
    assert.equal(localGenesisTimestamp('full', 1_800_000_000_000), 1_800_000_000 - LOCAL_CLOCK_LEAD_SECONDS);
    assert.equal(localGenesisTimestamp('payments'), null);
  });
});

/** A provider that answers the handful of calls the clock and copy helpers make. */
function fakeProvider({ timestamp = 0, code = '0x', storage = {} } = {}) {
  const sent = [];
  return {
    sent,
    getBlock: async () => ({ timestamp }),
    getCode: async () => code,
    getStorage: async (_address, slot) => storage[slot] ?? `0x${'0'.repeat(64)}`,
    send: async (method, params) => { sent.push([method, params]); return null; },
  };
}

describe('chain clock and contract copy', () => {
  it('moves a chain that setup left behind up to wall time, and never backwards', async () => {
    const behind = fakeProvider({ timestamp: 1000 });
    assert.equal(await alignChainClock(behind, 5_000_000), 4000);
    assert.deepEqual(behind.sent, [['evm_setNextBlockTimestamp', [5000]], ['evm_mine', []]]);
    const ahead = fakeProvider({ timestamp: 9000 });
    assert.equal(await alignChainClock(ahead, 5_000_000), 0);
    assert.deepEqual(ahead.sent, []);
  });

  it('copies runtime code and the nonzero storage slots', async () => {
    const value = `0x${'0'.repeat(63)}7`;
    const provider = fakeProvider({ code: '0x6001', storage: { 3: value } });
    await copyContract(provider, '0x1111111111111111111111111111111111111111', MAINNET_ANTS_TOKEN, 8);
    assert.deepEqual(provider.sent, [['anvil_setCode', [MAINNET_ANTS_TOKEN, '0x6001']], ['anvil_setStorageAt', [MAINNET_ANTS_TOKEN, `0x${'0'.repeat(63)}3`, value]]]);
    await assert.rejects(copyContract(fakeProvider(), '0x1111111111111111111111111111111111111111', MAINNET_ANTS_TOKEN), /no contract/);
  });
});

describe('topology chain.contracts and --contracts', () => {
  it('defaults to full and records only another layout, which then has its own fingerprint', () => {
    const full = normalizeTopology({}, source);
    assert.equal(full.chain.contracts, undefined);
    const payments = normalizeTopology({ chain: { contracts: 'payments' } }, source);
    assert.equal(payments.chain.contracts, 'payments');
    assert.equal(normalizeTopology({ chain: { contracts: 'full' } }, source).chain.contracts, undefined);
    assert.equal(normalizeTopology({ chain: { contracts: 'full' } }, source, { contracts: 'payments' }).chain.contracts, 'payments');
    assert.throws(() => normalizeTopology({ chain: { contracts: 'all' } }, source), /chain.contracts must be one of full, payments/);
    assert.equal(topologyFingerprint(full), topologyFingerprint(normalizeTopology({ chain: { contracts: 'full' } }, source)));
    assert.match(topologyFingerprint(payments), /#contracts=payments$/);
  });

  it('takes --contracts on up and run of the local chain only', () => {
    assert.equal(parseArgs(['up', '--chain', 'local', '--contracts', 'payments']).contracts, 'payments');
    assert.equal(parseArgs(['run', 'chat-basic', '--contracts', 'full']).contracts, 'full');
    assert.throws(() => parseArgs(['up', '--contracts', 'some']), /--contracts must be one of full, payments/);
    assert.throws(() => parseArgs(['status', '--contracts', 'full']), /only for pnpm testbench up and run/);
    assert.throws(() => parseArgs(['up', '--chain', 'fork', '--contracts', 'full']), /only applies to --chain local/);
  });
});

describe('cli-run', () => {
  let dir;
  let entry;
  let manifest;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tb-cli-run-'));
    entry = join(dir, 'fake-cli.mjs');
    // Stands in for apps/cli/dist/cli/index.js: reports what it was given, or misbehaves on request.
    await writeFile(entry, `
const args = process.argv.slice(2);
const mode = process.env.FAKE_MODE ?? 'report';
if (mode === 'report') console.log(JSON.stringify({ args, home: process.env.HOME, debug: process.env.ANTSEED_DEBUG ?? null, nodeOptions: process.env.NODE_OPTIONS, now: Date.now(), date: new Date().getTime(), parsed: new Date(0).getTime() }));
else if (mode === 'stdin') { let text = ''; process.stdin.on('data', (chunk) => { text += chunk; }).on('end', () => console.log(JSON.stringify({ stdin: text }))); }
else if (mode === 'fail') { process.stdout.write('x'.repeat(5000)); process.stderr.write('boom\\n'); process.exit(3); }
else if (mode === 'text') console.log('Payment Channels (1 of 1)');
else setInterval(() => {}, 1000);
`);
    manifest = { dir, home: join(dir, 'home'), buyerDir: join(dir, 'buyer'), buyerConfig: join(dir, 'buyer', 'config.json'), sellers: [{ id: 'a' }] };
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('parses stdout as JSON only when all of it is JSON', () => {
    assert.deepEqual(parseCliJson(' {"a":1}\n'), { a: 1 });
    assert.deepEqual(parseCliJson('[1]'), [1]);
    assert.equal(parseCliJson('- spinner\n{"a":1}'), null);
    assert.equal(parseCliJson(''), null);
  });

  it('runs the CLI on a data dir and config with the isolated environment, without debug logs', async () => {
    const result = await runCli({ entry, dataDir: '/d', configPath: '/d/c.json', args: ['buyer', 'status', '--json', 3], env: cliCommandEnv({ PATH: process.env.PATH, ANTSEED_DEBUG: '1' }, manifest.home) });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.json.args, ['--data-dir', '/d', '--config', '/d/c.json', 'buyer', 'status', '--json', '3']);
    assert.equal(result.json.home, manifest.home);
    assert.equal(result.json.debug, null);
    assert.match(result.json.nodeOptions, /isolate-preload\.mjs/);
    assert.doesNotMatch(result.json.nodeOptions, /clock-preload/);
    assert.ok(result.durationMs >= 0);
  });

  it('returns failures, stdin and timeouts instead of throwing', async () => {
    const env = (mode) => cliCommandEnv({ PATH: process.env.PATH }, manifest.home, { FAKE_MODE: mode });
    const failed = await runCli({ entry, env: env('fail') });
    assert.equal(failed.code, 3);
    assert.equal(failed.stdout.length, 5000);
    assert.equal(failed.stderr, 'boom\n');
    assert.equal(failed.json, null);
    const echoed = await runCli({ entry, env: env('stdin'), input: 'yes\n' });
    assert.deepEqual(echoed.json, { stdin: 'yes\n' });
    const hung = await runCli({ entry, env: env('hang'), timeoutMs: 300 });
    assert.equal(hung.timedOut, true);
    assert.equal(hung.code, null);
    assert.equal(hung.signal, 'SIGKILL');
  });

  it('records each call as a cli event with the head of both streams', () => {
    const data = cliEventData('buyer', ['buyer', 1], { code: 3, signal: null, stdout: 'x'.repeat(5000), stderr: 'e', json: null, durationMs: 5, timedOut: false });
    assert.equal(data.stdout.length, CLI_EVENT_STREAM_LIMIT);
    assert.equal(data.stdoutLength, 5000);
    assert.deepEqual(data.args, ['buyer', '1']);
    assert.equal(data.json, false);
  });

  it('tb.cli runs on the buyer dir, tb.sellerCli on the seller\'s, and both record events', async () => {
    const events = [];
    const runner = createCliRunner({ repo: dir, manifest, entry, event: async (type, data) => events.push({ type, ...data }), baseEnv: { PATH: process.env.PATH } });
    const buyer = await runner.cli(['buyer', 'status']);
    assert.deepEqual(buyer.json.args.slice(0, 4), ['--data-dir', manifest.buyerDir, '--config', manifest.buyerConfig]);
    const seller = await runner.sellerCli('a', ['seller', 'status']);
    assert.deepEqual(seller.json.args.slice(0, 4), ['--data-dir', join(dir, 'sellers', 'a'), '--config', join(dir, 'sellers', 'a', 'config.json')]);
    const other = await runner.cli(['x'], { dataDir: join(dir, 'copy') });
    assert.equal(other.json.args[3], join(dir, 'copy', 'config.json'));
    assert.deepEqual(events.map((event) => [event.type, event.who, event.code]), [['cli', 'buyer', 0], ['cli', 'seller:a', 0], ['cli', `dir:${join(dir, 'copy')}`, 0]]);
    assert.throws(() => runner.sellerCli('nope', []), /Unknown seller nope/);
    await assert.rejects(runner.cli('buyer status'), /must be an array/);
  });

  it('clock: chain shifts the command\'s Date to the chain\'s time', async () => {
    const events = [];
    const chainNow = async () => Math.floor(Date.now() / 1000) + 3600;
    const runner = createCliRunner({ repo: dir, manifest, entry, event: async (type, data) => events.push(data), baseEnv: { PATH: process.env.PATH }, chainNow });
    const started = Date.now();
    const shifted = await runner.cli(['x'], { clock: 'chain' });
    assert.match(shifted.json.nodeOptions, /clock-preload\.mjs/);
    for (const value of [shifted.json.now, shifted.json.date]) assert.ok(value - started > 3_590_000 && value - started < 3_620_000, String(value - started));
    assert.equal(shifted.json.parsed, 0, 'an explicit date is left alone');
    assert.ok(Math.abs(events[0].clockOffsetMs - 3_600_000) < 2000);
    const wall = await runner.cli(['x']);
    assert.ok(Math.abs(wall.json.now - Date.now()) < 60_000);
    await assert.rejects(runner.cli(['x'], { clock: 'mars' }), /'wall' or 'chain'/);
    await assert.rejects(createCliRunner({ repo: dir, manifest, entry }).cli(['x'], { clock: 'chain' }), /needs the chain's time/);
  });

  it('cliActiveChannels reads activeChannels through tb.cli, as before', async () => {
    const reply = (result) => async () => ({ signal: null, stdout: '', stderr: '', json: null, ...result });
    assert.deepEqual(await cliActiveChannels({ run: reply({ code: 0, json: { activeChannels: 2 } }) }), { count: 2 });
    assert.deepEqual(await cliActiveChannels({ run: reply({ code: 0, stdout: '- loading\n{"activeChannels":0}\n' }) }), { count: 0 });
    assert.deepEqual(await cliActiveChannels({ run: reply({ code: 1, stderr: 'no store\n' }) }), { error: 'exit 1: no store' });
    assert.deepEqual(await cliActiveChannels({ run: reply({ code: null, signal: 'SIGKILL' }) }), { error: 'exit SIGKILL' });
    assert.deepEqual(await cliActiveChannels({ run: reply({ code: 0, json: { connectionState: 'stopped' } }) }), { error: 'no activeChannels in the output' });
    let seen;
    await cliActiveChannels({ home: '/h', dataDir: '/d', configPath: '/c', run: async (args, options) => { seen = { args, options }; return { code: 0, json: { activeChannels: 1 }, stdout: '', stderr: '' }; } });
    assert.deepEqual(seen, { args: ['buyer', 'status', '--json'], options: { dataDir: '/d', configPath: '/c', timeoutMs: 120_000, home: '/h' } });
  });
});

describe('CLI scenario helpers', () => {
  it('flags stack traces and uncaught errors in stderr, not spinner lines', () => {
    assert.deepEqual(stderrProblems('- Fetching balance...\n✔ done\n'), []);
    assert.equal(stderrProblems('TypeError: x is undefined\n    at run (/a/b.js:10:5)\n').length, 2);
    assert.equal(stderrProblems('    at /a/b.js:10:5').length, 1);
  });

  it('reads CLI USDC amounts and writes withdraw amounts exactly', () => {
    assert.equal(micros('9.0'), 9_000_000n);
    assert.equal(micros('0.000036'), 36n);
    assert.equal(micros('1.00'), 1_000_000n);
    assert.equal(micros('0.0'), 0n);
    assert.equal(micros('1e3'), null);
    assert.equal(usdcArg(9_000_000n), '9');
    assert.equal(usdcArg(8_999_964n), '8.999964');
    assert.equal(usdcArg('36'), '0.000036');
  });

  it('reads request-close and withdraw results from JSON or from their text transcript', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    assert.deepEqual(channelCommandResult({ json: { transaction: hash, estimatedRefund: '1000000' }, stdout: '' }), { transaction: hash, estimatedRefundMicros: 1_000_000n, json: true });
    assert.deepEqual(channelCommandResult({ json: null, stdout: `Transaction: ${hash}\nEstimated released reserve: 1.0 USDC\n` }), { transaction: hash, estimatedRefundMicros: 1_000_000n, json: false });
    assert.deepEqual(channelCommandResult({ json: null, stdout: 'nothing' }), { transaction: null, estimatedRefundMicros: null, json: false });
  });
});

describe('free-tier topology and helpers', () => {
  const providers = { chat: { plugin: 'openai', defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 }, services: { free: { pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } }, priced: { freeTier: { maxRequestsPerAddress: 2 } } } } };

  it('keeps seller-wide and per-service free-tier programs, in cli mode only', () => {
    const topology = normalizeTopology({ mode: 'cli', sellers: [{ id: 's', providers, freeTier: { maxRequestsPerAddress: 2, windowMs: 60_000, stakeTiers: [{ minPower: 1000, multiplier: 3 }, { minPower: 9000, multiplier: 'unlimited' }] } }] }, source);
    assert.deepEqual(topology.sellers[0].freeTier, { maxRequestsPerAddress: 2, windowMs: 60_000, stakeTiers: [{ minPower: 1000, multiplier: 3 }, { minPower: 9000, multiplier: 'unlimited' }] });
    assert.deepEqual(topology.sellers[0].providers.chat.services.priced.freeTier, { maxRequestsPerAddress: 2 });
    assert.throws(() => normalizeTopology({ sellers: [{ id: 's', providers, freeTier: { maxRequestsPerAddress: 2 } }] }, source), /need mode cli/);
    assert.throws(() => normalizeTopology({ sellers: [{ id: 's', providers }] }, source), /need mode cli/);
    assert.doesNotThrow(() => normalizeTopology({ sellers: [{ id: 's', providers }] }, source, { mode: 'cli' }));
  });

  it('refuses free-tier settings the limiter does not have', () => {
    assert.throws(() => normalizeFreeTier({ perDay: 3 }), /perDay is not a free-tier setting/);
    assert.throws(() => normalizeFreeTier({ maxRequestsPerAddress: -1 }), /non-negative integer/);
    assert.throws(() => normalizeFreeTier({ windowMs: 10 }), /at least 1000/);
    assert.throws(() => normalizeFreeTier({ stakeTiers: [{ minPower: 0, multiplier: 2 }] }), /minPower/);
    assert.throws(() => normalizeFreeTier({ stakeTiers: [{ minPower: 5, multiplier: 1 }] }), /multiplier/);
    assert.throws(() => normalizeFreeTier({ stakersOnly: 'yes' }), /boolean/);
    assert.throws(() => normalizeFreeTier([]), /must be an object/);
  });

  it('writes the seller-wide program into the CLI seller config only when set', () => {
    const chain = { chainId: 'base-local', evmChainId: 31337 };
    const payments = { rpcUrl: 'http://127.0.0.1:9', defaultAuthDurationSecs: 100 };
    const bootstrapNodes = [{ host: '127.0.0.1', port: 40000 }];
    assert.deepEqual(cliSellerConfig({ id: 's', providers, chain, bootstrapNodes, payments, freeTier: { maxRequestsPerAddress: 2 } }).seller.freeTier, { maxRequestsPerAddress: 2 });
    assert.equal('freeTier' in cliSellerConfig({ id: 's', providers, chain, bootstrapNodes, payments }).seller, false);
  });

  it('reads a free-tier 429 from the proxy or straight from the seller', () => {
    const proxied = { error: { type: 'rate_limit_error', code: 'free_tier_exhausted', metadata: { raw: '{}' } }, free_tier: { limitedBy: 'address', limit: 6, stakePower: 12000 } };
    assert.deepEqual(freeTierRefusal({ status: 429, headers: { 'retry-after': '3600' }, json: proxied }), { status: 429, retryAfter: 3600, type: 'rate_limit_error', code: 'free_tier_exhausted', limit: 6, stakePower: 12000, limitedBy: 'address' });
    const direct = { error: { type: 'rate_limit_error', code: 'free_tier_exhausted' }, limitedBy: 'address', limit: 2, stakePower: 0 };
    assert.equal(freeTierRefusal({ status: 429, headers: {}, json: direct }).limit, 2);
    assert.deepEqual(freeTierRefusal({ status: 502, headers: {}, json: null }), { status: 502, retryAfter: null, type: null, code: null, limit: null, stakePower: null, limitedBy: null });
  });

  it('tb.delegateFreeTier wants a positive ANTS amount and a seller with an agent id', async () => {
    const manifest = {
      proxyUrl: 'http://127.0.0.1:9', rpcUrl: 'http://127.0.0.1:9', dir: '/tmp/tb', home: '/tmp/tb/home', buyerDir: '/tmp/tb/buyer', buyerConfig: '/tmp/tb/buyer/config.json',
      buyer: { address: '0x0' }, sellers: [{ id: 's', peerId: 'a'.repeat(40), address: '0x1', models: ['m'] }], topology: { sellers: [] },
    };
    const tb = createTestbenchApi({ manifest, control: {}, eventsPath: '/dev/null', chain: { depositsContractAddress: `0x${'1'.repeat(40)}`, usdcContractAddress: `0x${'2'.repeat(40)}`, channelsContractAddress: `0x${'3'.repeat(40)}` } });
    try {
      await assert.rejects(tb.delegateFreeTier({}), /needs amount/);
      await assert.rejects(tb.delegateFreeTier({ amount: '-5' }), /needs amount/);
      await assert.rejects(tb.delegateFreeTier({ amount: '10' }), /has no agent id/);
      assert.deepEqual(Object.keys(tb.contracts), ['deposits', 'usdc', 'channels']);
    } finally {
      await tb.dispose();
    }
  });
});
