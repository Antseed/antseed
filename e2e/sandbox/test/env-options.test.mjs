import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { describe, it } from 'node:test';
import { assertLocalUrl, assertNetworkOptions, FORBIDDEN_PORTS, freePort, isolatedEnv, listenWithRetry, parseEnvFile, resolveLiveKeys } from '../lib/env.mjs';
import { validateManifest, MANIFEST_VERSION } from '../lib/manifest.mjs';
import { sandboxNodeOptions } from '../lib/node-options.mjs';
import { parseArgs } from '../lib/options.mjs';

describe('isolatedEnv', () => {
  it('strips AntSeed/provider secrets and sets a private HOME', () => {
    const env = isolatedEnv({
      PATH: '/bin', HOME: '/Users/me', ANTSEED_DATA_DIR: '/Users/me/.antseed', OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'a',
      VENICE_API_KEY: 'v', BASE_MAINNET_RPC_URL: 'https://secret', SANDBOX_KEY_CHAT: 'k', LANG: 'C',
    }, '/sb/home', { EXTRA: '1' });
    assert.equal(env.HOME, '/sb/home');
    assert.equal(env.PATH, '/bin');
    assert.equal(env.LANG, 'C');
    assert.equal(env.EXTRA, '1');
    for (const key of ['ANTSEED_DATA_DIR', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VENICE_API_KEY', 'BASE_MAINNET_RPC_URL', 'SANDBOX_KEY_CHAT']) {
      assert.equal(env[key], undefined, key);
    }
  });
});

describe('network options', () => {
  const base = { role: 'seller', dhtPort: 0, signalingPort: 0, bindHost: '127.0.0.1', natTraversal: false, noOfficialBootstrap: true, allowPrivateIPs: true, bootstrapNodes: [{ host: '127.0.0.1', port: 40000 }] };

  it('accepts the sandbox defaults', () => {
    assert.equal(assertNetworkOptions({ ...base }).dhtPort, 0);
    const built = sandboxNodeOptions({ role: 'seller', dataDir: '/sb/s', bootstrapNodes: base.bootstrapNodes, payments: {} });
    assert.equal(built.dhtPort, 0);
    assert.equal(built.signalingPort, 0);
    assert.equal(built.bindHost, '127.0.0.1');
    assert.equal(sandboxNodeOptions({ role: 'buyer', dataDir: '/sb/b', bootstrapNodes: base.bootstrapNodes, payments: {} }).signalingPort, undefined);
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
  const dir = '/sb/wt-a-12345678';
  const good = () => ({
    version: MANIFEST_VERSION, name: 'wt-a-12345678', chainId: 8453, rpcUrl: 'http://127.0.0.1:1000', proxyUrl: 'http://127.0.0.1:1001',
    supervisor: { pid: 10, startedAt: 'x' }, anvil: { pid: 11, startedAt: 'y' },
    sellers: [{ id: 's', peerId: 'a'.repeat(40), dhtPort: 40001, signalingPort: 40002, process: { pid: 12, startedAt: 'z' } }],
    bootstrap: { host: '127.0.0.1', port: 40000 },
    home: `${dir}/home`, buyerDir: `${dir}/buyer`, buyerConfig: `${dir}/buyer/config.json`,
  });

  it('accepts a well-formed manifest', () => {
    assert.equal(validateManifest(good(), { dir }).name, 'wt-a-12345678');
  });

  it('rejects unsafe manifests', () => {
    const cases = [
      [(m) => { m.version = 99; }, /Unsupported/],
      [(m) => { m.chainId = 1; }, /chainId/],
      [(m) => { m.proxyUrl = 'http://0.0.0.0:1'; }, /proxyUrl/],
      [(m) => { m.supervisor = { pid: 10 }; }, /supervisor/],
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
  it('parses commands and flags', () => {
    const options = parseArgs(['up', '--config', 'c.json', '--live', '--deposit-usdc', '2.5', '--block', '123', '--slot', 'b']);
    assert.deepEqual([options.command, options.config, options.live, options.depositUsdc, options.block, options.slot], ['up', 'c.json', true, '2.5', '123', 'b']);
    assert.equal(parseArgs(['run', 'chat-basic', '--strict']).scenario, 'chat-basic');
    assert.equal(parseArgs(['--', 'status']).command, 'status');
    assert.equal(parseArgs([]).command, 'help');
  });

  it('rejects bad input', () => {
    assert.throws(() => parseArgs(['nuke']), /Unknown command/);
    assert.throws(() => parseArgs(['up', '--bogus']), /Unknown option/);
    assert.throws(() => parseArgs(['up', '--config']), /needs a value/);
    assert.throws(() => parseArgs(['up', '--block', 'latest']), /block number/);
    assert.throws(() => parseArgs(['up', '--deposit-usdc', '0']), /USDC amount/);
    assert.throws(() => parseArgs(['up', '--deposit-usdc', '1.1234567']), /USDC amount/);
    assert.throws(() => parseArgs(['run']), /Usage/);
    assert.throws(() => parseArgs(['run', '../evil']), /Invalid scenario/);
    assert.throws(() => parseArgs(['up', '--slot', 'A B']), /Invalid sandbox slot/);
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
