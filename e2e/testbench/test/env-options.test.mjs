import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { assertLocalUrl, assertNetworkOptions, FORBIDDEN_PORTS, freePort, isolatedEnv, listenWithRetry, parseEnvFile, redactingStream, resolveForkUrl, resolveLiveKeys, supervisorEnvs } from '../lib/env.mjs';
import { validateManifest, MANIFEST_VERSION } from '../lib/manifest.mjs';
import { testbenchNodeOptions } from '../lib/node-options.mjs';
import { DEFAULT_RUN_TIMEOUT_SECONDS, parseArgs } from '../lib/options.mjs';

describe('isolatedEnv', () => {
  it('strips AntSeed/provider secrets and sets a private HOME', () => {
    const env = isolatedEnv({
      PATH: '/bin', HOME: '/Users/me', ANTSEED_DATA_DIR: '/Users/me/.antseed', OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'a',
      VENICE_API_KEY: 'v', BASE_MAINNET_RPC_URL: 'https://secret', TESTBENCH_KEY_CHAT: 'k', LANG: 'C',
    }, '/tb/home', { EXTRA: '1' });
    assert.equal(env.HOME, '/tb/home');
    assert.equal(env.PATH, '/bin');
    assert.equal(env.LANG, 'C');
    assert.equal(env.EXTRA, '1');
    for (const key of ['ANTSEED_DATA_DIR', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VENICE_API_KEY', 'BASE_MAINNET_RPC_URL', 'TESTBENCH_KEY_CHAT']) {
      assert.equal(env[key], undefined, key);
    }
  });
});

describe('supervisor environments', () => {
  const home = '/tmp/tb-env-home';
  const inherited = { PATH: '/bin', HOME: '/Users/me', ANTSEED_TESTBENCH_FORK_URL: 'https://rpc/key', ANTSEED_DEBUG: '1', OPENROUTER_API_KEY: 'sk-live' };
  const buyerEnv = { ANTSEED_SETTLEMENT_IDLE_MS: '5000' };

  it('--verbose reaches SDK sellers, and buyer switches never do', () => {
    const envs = supervisorEnvs(inherited, home, { verbose: true, buyerEnv, liveKeys: ['OPENROUTER_API_KEY'] });
    const seller = envs.sdkSeller({ TESTBENCH_KEY_OPENAI: 'mock-only', ANTSEED_LOG_LEVEL: 'x' });
    assert.equal(seller.ANTSEED_DEBUG, '1', 'verbose survives the seller env cleaning');
    assert.equal(seller.ANTSEED_LOG_LEVEL, 'x');
    assert.equal(seller.TESTBENCH_KEY_OPENAI, 'mock-only');
    assert.equal(seller.HOME, home);
    for (const env of [envs.base, seller]) {
      assert.equal(env.ANTSEED_SETTLEMENT_IDLE_MS, undefined, 'buyer-only switch');
      assert.equal(env.ANTSEED_TESTBENCH_FORK_URL, undefined, 'fork URL');
      assert.equal(env.OPENROUTER_API_KEY, undefined, 'live key');
    }
    assert.equal(envs.base.ANTSEED_DEBUG, '1');
    assert.equal(envs.own.ANTSEED_SETTLEMENT_IDLE_MS, '5000', 'the in-process sdk buyer gets its switches');
  });

  it('without --verbose nobody gets the inherited ANTSEED_DEBUG, and in cli mode the supervisor keeps no buyer switches', () => {
    const sdk = supervisorEnvs(inherited, home, { buyerEnv });
    assert.equal(sdk.base.ANTSEED_DEBUG, undefined);
    assert.equal(sdk.sdkSeller().ANTSEED_DEBUG, undefined);
    assert.equal(sdk.sdkSeller({ ANTSEED_DEBUG: '1' }).ANTSEED_DEBUG, '1', 'a seller topology env still applies');
    const cli = supervisorEnvs(inherited, home, { buyerEnv, cliMode: true });
    assert.equal(cli.own.ANTSEED_SETTLEMENT_IDLE_MS, undefined);
    assert.equal(cli.own, cli.base);
  });
});

describe('network options', () => {
  const base = { role: 'seller', dhtPort: 0, signalingPort: 0, bindHost: '127.0.0.1', natTraversal: false, noOfficialBootstrap: true, allowPrivateIPs: true, bootstrapNodes: [{ host: '127.0.0.1', port: 40000 }] };

  it('accepts the testbench defaults', () => {
    assert.equal(assertNetworkOptions({ ...base }).dhtPort, 0);
    const built = testbenchNodeOptions({ role: 'seller', dataDir: '/tb/s', bootstrapNodes: base.bootstrapNodes, payments: {} });
    assert.equal(built.dhtPort, 0);
    assert.equal(built.signalingPort, 0);
    assert.equal(built.bindHost, '127.0.0.1');
    assert.equal(testbenchNodeOptions({ role: 'buyer', dataDir: '/tb/b', bootstrapNodes: base.bootstrapNodes, payments: {} }).signalingPort, undefined);
  });

  it('fails fast on unset or default ports', () => {
    assert.throws(() => assertNetworkOptions({ ...base, dhtPort: undefined }), /dhtPort must be set explicitly/);
    assert.throws(() => assertNetworkOptions({ ...base, signalingPort: undefined }), /signalingPort must be set explicitly/);
    assert.throws(() => assertNetworkOptions({ ...base, dhtPort: 6881 }), /default AntSeed port/);
    assert.throws(() => assertNetworkOptions({ ...base, signalingPort: 6882 }), /default AntSeed port/);
    assert.throws(() => assertNetworkOptions({ ...base, dhtPort: 80 }), /default AntSeed port/);
  });

  it('requires loopback bind, private bootstrap, no NAT traversal', () => {
    assert.throws(() => assertNetworkOptions({ ...base, bindHost: '0.0.0.0' }), /bindHost/);
    assert.throws(() => assertNetworkOptions({ ...base, bindHost: undefined }), /bindHost/);
    assert.throws(() => assertNetworkOptions({ ...base, noOfficialBootstrap: false }), /noOfficialBootstrap/);
    assert.throws(() => assertNetworkOptions({ ...base, natTraversal: true }), /natTraversal/);
    assert.throws(() => assertNetworkOptions({ ...base, allowPrivateIPs: false }), /allowPrivateIPs/);
    assert.throws(() => assertNetworkOptions({ ...base, bootstrapNodes: [] }), /private bootstrap/);
    assert.throws(() => assertNetworkOptions({ ...base, bootstrapNodes: [{ host: 'dht1.antseed.com', port: 6881 }] }), /not a private loopback/);
    assert.throws(() => assertNetworkOptions({ ...base, bootstrapNodes: [{ host: '127.0.0.1', port: 6881 }] }), /not a private loopback/);
  });

  it('only trusts owned loopback URLs', () => {
    assert.equal(assertLocalUrl('http://127.0.0.1:1234').port, '1234');
    for (const url of ['http://localhost:1234', 'https://127.0.0.1:1', 'http://127.0.0.1', 'http://u:p@127.0.0.1:1', 'http://10.0.0.1:1']) {
      assert.throws(() => assertLocalUrl(url), /owned http/, url);
    }
  });
});

describe('--budgets', () => {
  it('is a run flag that --strict does not imply', () => {
    assert.equal(parseArgs(['run', 'stress-smoke', '--budgets'], {}).budgets, true);
    assert.equal(parseArgs(['run', 'stress-smoke'], {}).budgets, undefined);
    assert.equal(parseArgs(['run', 'stress-smoke', '--strict'], {}).budgets, undefined);
    assert.throws(() => parseArgs(['up', '--budgets'], {}), /only for pnpm testbench run/);
  });

  it('is also set by ANTSEED_TESTBENCH_BUDGETS=1, on run only', () => {
    assert.equal(parseArgs(['run', 'stress-smoke'], { ANTSEED_TESTBENCH_BUDGETS: '1' }).budgets, true);
    assert.equal(parseArgs(['run', 'stress-smoke'], { ANTSEED_TESTBENCH_BUDGETS: '0' }).budgets, undefined);
    assert.equal(parseArgs(['up'], { ANTSEED_TESTBENCH_BUDGETS: '1' }).budgets, undefined);
  });
});

describe('listenWithRetry', () => {
  it('retries when another process wins the port race', async () => {
    const squatter = createServer();
    await new Promise((resolve) => squatter.listen(0, '127.0.0.1', resolve));
    const taken = squatter.address().port;
    const free = await freePort();
    const picks = [taken, free];
    const { port, value } = await listenWithRetry(async (candidate) => {
      const server = createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(candidate, '127.0.0.1', resolve); });
      return server;
    }, { pickPort: async () => picks.shift() });
    assert.equal(port, free);
    value.close();
    squatter.close();
  });

  it('skips forbidden ports and rethrows non-EADDRINUSE errors', async () => {
    const seen = [];
    const picks = [6881, 45555];
    await listenWithRetry(async (port) => { seen.push(port); return port; }, { pickPort: async () => picks.shift() });
    assert.deepEqual(seen, [45555]);
    assert.ok(FORBIDDEN_PORTS.has(6882));
    await assert.rejects(listenWithRetry(async () => { throw new Error('nope'); }, { pickPort: async () => 45556 }), /nope/);
  });
});

describe('manifest validation', () => {
  const dir = '/tb/wt-a-12345678';
  const good = () => ({
    version: MANIFEST_VERSION, name: 'wt-a-12345678', chainId: 8453, rpcUrl: 'http://127.0.0.1:1000', proxyUrl: 'http://127.0.0.1:1001',
    supervisor: { pid: 10, startedAt: 'x' }, anvil: { pid: 11, startedAt: 'y' },
    sellers: [{ id: 's', peerId: 'a'.repeat(40), dhtPort: 40001, signalingPort: 40002, process: { pid: 12, startedAt: 'z' } }],
    bootstrap: { host: '127.0.0.1', port: 40000 },
    home: `${dir}/home`, buyerDir: `${dir}/buyer`, buyerConfig: `${dir}/buyer/config.json`,
  });

  it('accepts a well-formed manifest', () => {
    assert.equal(validateManifest(good(), { dir }).name, 'wt-a-12345678');
    assert.equal(validateManifest({ ...good(), target: 'local', chainId: 31337 }, { dir }).target, 'local');
    assert.equal(validateManifest({ ...good(), mode: 'cli', nodeProcesses: { buyer: { pid: 10, startedAt: 'x' } } }, { dir }).mode, 'cli');
  });

  it('rejects unsafe manifests', () => {
    const cases = [
      [(m) => { m.version = 99; }, /Unsupported/],
      [(m) => { m.chainId = 1; }, /chainId/],
      [(m) => { m.target = 'local'; }, /chainId must be 31337/],
      [(m) => { m.target = 'mainnet'; }, /Unknown testbench target/],
      [(m) => { m.proxyUrl = 'http://0.0.0.0:1'; }, /proxyUrl/],
      [(m) => { m.supervisor = { pid: 10 }; }, /supervisor/],
      [(m) => { m.mode = 'docker'; }, /Manifest mode must be one of/],
      [(m) => { m.nodeProcesses = { buyer: { pid: 10 } }; }, /Manifest buyer must record pid/],
      [(m) => { m.starter = { pid: 10 }; }, /Manifest starter must record pid/],
      [(m) => { m.sellers[0].signalingPort = 6882; }, /default AntSeed port/],
      [(m) => { m.sellers[0].peerId = 'nope'; }, /peerId/],
      [(m) => { m.bootstrap.host = '1.2.3.4'; }, /loopback/],
      [(m) => { m.home = '/Users/me'; }, /Unsafe manifest home/],
      [(m) => { m.buyerDir = dir; }, /Unsafe manifest buyerDir/],
      [(m) => { m.buyerConfig = '/Users/me/.antseed/config.json'; }, /Unsafe manifest buyerConfig/],
    ];
    for (const [mutate, error] of cases) {
      const manifest = good();
      mutate(manifest);
      assert.throws(() => validateManifest(manifest, { dir }), error);
    }
  });
});

describe('parseArgs', () => {
  it('takes --mode on up and run only', () => {
    assert.equal(parseArgs(['up', '--mode', 'cli']).mode, 'cli');
    assert.equal(parseArgs(['run', 'chat-basic', '--mode', 'sdk']).mode, 'sdk');
    assert.equal(parseArgs(['up']).mode, undefined);
    assert.throws(() => parseArgs(['up', '--mode', 'docker']), /--mode must be one of sdk, cli/);
    assert.throws(() => parseArgs(['status', '--mode', 'cli']), /--mode is only for/);
    assert.throws(() => parseArgs(['run', 'mainnet-smoke', '--chain', 'mainnet', '--real-funds', '--mode', 'cli']), /does not apply to --chain mainnet/);
  });

  it('takes a run seed and a run timeout, with a fresh random seed by default', () => {
    const given = parseArgs(['run', 'chat-basic', '--seed', '7', '--run-timeout', '60']);
    assert.deepEqual([given.seed, given.seedGiven, given.runTimeout], [7, true, 60]);
    assert.equal(parseArgs(['up', '--seed', '0']).seed, 0);
    assert.equal(parseArgs(['up', '--seed', '4294967295']).seed, 4294967295);
    const defaults = parseArgs(['run', 'chat-basic']);
    assert.ok(Number.isInteger(defaults.seed) && defaults.seed >= 0 && defaults.seed < 2 ** 32);
    assert.equal(defaults.seedGiven, undefined);
    assert.equal(defaults.runTimeout, DEFAULT_RUN_TIMEOUT_SECONDS);
    assert.equal(DEFAULT_RUN_TIMEOUT_SECONDS, 1800);
    assert.equal(parseArgs(['status']).seed, undefined);
  });

  it('rejects bad seeds and run timeouts', () => {
    for (const seed of ['abc', '1.5', '-1', '4294967296']) assert.throws(() => parseArgs(['run', 'x', '--seed', seed]), /--seed must be an integer/);
    assert.throws(() => parseArgs(['down', '--seed', '7']), /only for pnpm testbench run and up/);
    for (const seconds of ['0', 'soon', '1.5']) assert.throws(() => parseArgs(['run', 'x', '--run-timeout', seconds]), /--run-timeout must be/);
    assert.throws(() => parseArgs(['up', '--run-timeout', '5']), /only for pnpm testbench run/);
  });

  it('parses commands and flags', () => {
    const options = parseArgs(['up', '--config', 'c.json', '--live', '--deposit-usdc', '2.5', '--block', '123', '--slot', 'b']);
    assert.deepEqual([options.command, options.config, options.live, options.depositUsdc, options.block, options.slot], ['up', 'c.json', true, '2.5', '123', 'b']);
    assert.equal(parseArgs(['run', 'chat-basic', '--strict']).scenario, 'chat-basic');
    assert.equal(parseArgs(['--', 'status']).command, 'status');
    assert.equal(parseArgs(['run', 'payment-flow', '--chain', 'local']).chain, 'local');
    assert.equal(parseArgs([]).command, 'help');
    assert.equal(parseArgs(['desktop', '--cdp-port', '9333']).cdpPort, '9333');
  });

  it('rejects bad input', () => {
    assert.throws(() => parseArgs(['nuke']), /Unknown command/);
    assert.throws(() => parseArgs(['up', '--bogus']), /Unknown option/);
    assert.throws(() => parseArgs(['up', '--config']), /needs a value/);
    assert.throws(() => parseArgs(['up', '--block', 'latest']), /block number/);
    assert.throws(() => parseArgs(['up', '--deposit-usdc', '0']), /USDC amount/);
    assert.throws(() => parseArgs(['up', '--deposit-usdc', '1.1234567']), /USDC amount/);
    assert.throws(() => parseArgs(['run']), /Usage/);
    assert.throws(() => parseArgs(['up', '--chain', 'sepolia']), /--chain must be one of fork, local, mainnet/);
    assert.throws(() => parseArgs(['up', '--chain', 'mainnet']), /--real-funds/);
    assert.throws(() => parseArgs(['run', '../evil']), /Invalid scenario/);
    assert.throws(() => parseArgs(['up', '--slot', 'A B']), /Invalid testbench slot/);
    assert.throws(() => parseArgs(['up', '--cdp-port', '9333']), /only for pnpm testbench desktop/);
    assert.throws(() => parseArgs(['desktop', '--cdp-port', '80']), /1024-65535/);
    assert.throws(() => parseArgs(['desktop', '--cdp-port', 'x']), /1024-65535/);
  });
});

describe('live key env files', () => {
  it('parses dotenv lines without evaluating shell syntax', () => {
    const values = parseEnvFile('# comment\nexport VENICE_API_KEY="quoted value"\nPLAIN=abc # note\nSINGLE=\'$(rm -rf x)\'\nnot a line\n');
    assert.deepEqual(values, { VENICE_API_KEY: 'quoted value', PLAIN: 'abc', SINGLE: '$(rm -rf x)' });
  });

  it('resolves only requested keys, preferring the shell, and reports sources without values', () => {
    const resolved = resolveLiveKeys(['VENICE_API_KEY', 'OPENAI_API_KEY'], {
      env: { OPENAI_API_KEY: 'shell-key', UNRELATED: 'x' },
      fileValues: { VENICE_API_KEY: 'file-key', OPENAI_API_KEY: 'file-openai', OTHER_SECRET: 'nope' },
    });
    assert.deepEqual(resolved.values, { VENICE_API_KEY: 'file-key', OPENAI_API_KEY: 'shell-key' });
    assert.deepEqual(resolved.sources, { VENICE_API_KEY: 'env file', OPENAI_API_KEY: 'shell' });
    assert.deepEqual(resolved.missing, []);
    assert.deepEqual(resolveLiveKeys(['MISSING_KEY'], { env: {}, fileValues: { MISSING_KEY: ' ' } }).missing, ['MISSING_KEY']);
  });

  it('parses --env-file', () => {
    assert.equal(parseArgs(['up', '--live', '--env-file', 'keys.env']).envFile, 'keys.env');
  });
});

describe('fork RPC', () => {
  it('requires BASE_MAINNET_RPC_URL, preferring the shell over .env.local', () => {
    assert.throws(() => resolveForkUrl({ env: {}, fileValues: {} }), /BASE_MAINNET_RPC_URL is required/);
    assert.throws(() => resolveForkUrl({ env: {}, fileValues: { BASE_MAINNET_RPC_URL: 'ws://x' } }), /must be HTTP/);
    assert.deepEqual(resolveForkUrl({ env: {}, fileValues: { BASE_MAINNET_RPC_URL: 'https://file' }, envFile: '.env.local' }), { url: 'https://file', source: '.env.local' });
    assert.deepEqual(resolveForkUrl({ env: { BASE_MAINNET_RPC_URL: 'https://shell' }, fileValues: { BASE_MAINNET_RPC_URL: 'https://file' } }), { url: 'https://shell', source: 'shell' });
  });
});

describe('redactingStream', () => {
  it('removes the secret even when it spans chunks', async () => {
    const stream = redactingStream('https://rpc/key123');
    let out = '';
    stream.on('data', (chunk) => { out += chunk; });
    stream.write('Endpoint: https://rpc/ke');
    stream.write('y123\nnext line\ntail https://rpc/key123');
    stream.end();
    await new Promise((resolve) => stream.on('end', resolve));
    assert.equal(out, 'Endpoint: <BASE_MAINNET_RPC_URL>\nnext line\ntail <BASE_MAINNET_RPC_URL>');
  });
});

describe('anvil exits', async () => {
  const { anvilExitMessage, isAddressInUse } = await import('../lib/env.mjs');
  it('retries only when the port was taken', () => {
    assert.equal(isAddressInUse('Error: Address already in use (os error 98)'), true);
    assert.equal(isAddressInUse('error sending request for url'), false);
  });
  it('explains other exits without echoing the output', () => {
    const output = 'failed to get fork block from https://base.example/v2/SECRET';
    const message = anvilExitMessage(1, output, { fork: true, logPath: '/tb/logs/anvil.log' });
    assert.match(message, /see \/tb\/logs\/anvil\.log/);
    assert.match(message, /BASE_MAINNET_RPC_URL/);
    assert.doesNotMatch(message, /SECRET/);
    assert.doesNotMatch(anvilExitMessage(1, '', { fork: false, logPath: 'x' }), /BASE_MAINNET_RPC_URL/);
  });
});
