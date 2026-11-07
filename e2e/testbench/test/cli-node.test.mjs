import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assertSellerPaymentsOn, assertSingleBootstrap, buyerProxyListening, cliArgs, cliBuyerClient, cliNodeEnv, linkPlugins, sellerReady, spawnCliNode, stopWithGrace, waitForCliReady } from '../lib/cli-node.mjs';
import { assertCliConfig, cliBuyerConfig, cliSellerConfig, paymentsConfig } from '../lib/node-options.mjs';

const chain = { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:8545', depositsContractAddress: '0x01', channelsContractAddress: '0x02', stakingContractAddress: '0x03', usdcContractAddress: '0x04', identityRegistryAddress: '0x05' };
const bootstrapNodes = [{ host: '127.0.0.1', port: 40000 }];
const payments = { ...paymentsConfig(chain, 'http://127.0.0.1:41000', { settlementIdleMs: 15_000 }), minBudgetPerRequest: '10000' };
const providers = { chat: { plugin: 'openai', baseUrl: 'http://127.0.0.1:42000', apiKeyEnv: 'TESTBENCH_KEY_CHAT', services: { model: {} } } };
const sellerConfig = () => cliSellerConfig({ id: 'a', providers, chain, bootstrapNodes, payments });
const routingPreferences = { minTrustScore: 0, allowedPeerIds: ['ab'.repeat(20)], blockedPeerIds: [] };
const buyerConfig = (extra = {}) => cliBuyerConfig({ proxyPort: 43000, routingPreferences, chain, bootstrapNodes, payments: { ...payments, maxReserveAmountUsdc: '2000000' }, ...extra });

describe('CLI config writer', () => {
  it('writes every network option the SDK path sets into a seller config', () => {
    const config = assertCliConfig(sellerConfig(), 'seller');
    assert.deepEqual(config.network, { bootstrapNodes: ['127.0.0.1:40000'], dhtPort: 0, signalingPort: 0, bindHost: '127.0.0.1', natTraversal: false, noOfficialBootstrap: true, allowPrivateIPs: true, dhtOperationTimeoutMs: 5000 });
    assert.equal(config.payments.crypto.rpcUrl, 'http://127.0.0.1:41000');
    assert.equal(config.payments.crypto.chainId, 'base-local');
    assert.equal(config.payments.minBudgetPerRequest, '10000');
    assert.equal(config.payments.defaultAuthDurationSecs, payments.defaultAuthDurationSecs);
    assert.equal(config.seller.providers, providers);
    assert.equal(config.seller.healthCheck.enabled, false);
    assert.deepEqual(config.relayer, { enabled: false });
  });

  it('leaves the minimum budget to the CLI default unless the topology sets it', () => {
    const { minBudgetPerRequest, ...unset } = payments;
    assert.equal(cliSellerConfig({ id: 'a', providers, chain, bootstrapNodes, payments: unset }).payments.minBudgetPerRequest, undefined);
  });

  it('writes the proxy port, routing, caps and network of a buyer config', () => {
    const config = assertCliConfig(buyerConfig({ maxPricing: { defaults: { inputUsdPerMillion: 7, outputUsdPerMillion: 8 } } }), 'buyer');
    assert.equal(config.buyer.proxyPort, 43000);
    assert.equal(config.buyer.minPeerReputation, 0);
    assert.equal(config.buyer.autoSweep, false);
    assert.equal(config.buyer.routingPreferences, routingPreferences);
    assert.equal(config.buyer.maxPricing.defaults.outputUsdPerMillion, 8);
    assert.equal(config.payments.maxReserveAmountUsdc, '2000000');
    assert.equal(config.network.dhtPort, 0);
    assert.equal(config.network.signalingPort, undefined);
    assert.equal(buyerConfig().buyer.maxPricing, undefined);
  });

  it('refuses default ports and anything that leaves the private network', () => {
    const change = (config, section, patch) => ({ ...config, [section]: { ...config[section], ...patch } });
    const seller = sellerConfig();
    assert.throws(() => assertCliConfig(change(seller, 'network', { dhtPort: 6881 }), 'seller'), /dhtPort=6881 collides/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { signalingPort: 6882 }), 'seller'), /signalingPort=6882 collides/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { dhtPort: undefined }), 'seller'), /dhtPort must be set explicitly/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { signalingPort: undefined }), 'seller'), /signalingPort must be set explicitly/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { bindHost: '0.0.0.0' }), 'seller'), /bindHost/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { natTraversal: true }), 'seller'), /natTraversal/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { noOfficialBootstrap: false }), 'seller'), /noOfficialBootstrap/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { allowPrivateIPs: false }), 'seller'), /allowPrivateIPs/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { bootstrapNodes: [] }), 'seller'), /private bootstrap/);
    assert.throws(() => assertCliConfig(change(seller, 'network', { bootstrapNodes: ['1.2.3.4:6881'] }), 'seller'), /not a private loopback/);
    assert.throws(() => assertCliConfig(change(seller, 'payments', { crypto: { rpcUrl: 'https://mainnet.base.org' } }), 'seller'), /rpcUrl/);
    const buyer = buyerConfig();
    assert.throws(() => assertCliConfig(change(buyer, 'buyer', { proxyPort: 8377 }), 'buyer'), /proxyPort=8377/);
    assert.throws(() => assertCliConfig(change(buyer, 'buyer', { proxyPort: undefined }), 'buyer'), /proxyPort=undefined/);
    assert.throws(() => assertCliConfig(change(buyer, 'network', { dhtPort: 6881 }), 'buyer'), /dhtPort=6881 collides/);
  });
});

describe('CLI launcher', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'tb-cli-node-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('builds the CLI argv on a data dir and an isolated environment', () => {
    assert.deepEqual(cliArgs('/repo', '/d', ['seller', 'start']), ['/repo/apps/cli/dist/cli/index.js', '--data-dir', '/d', '--config', '/d/config.json', '--verbose', 'seller', 'start']);
    const env = cliNodeEnv({ PATH: '/bin', ANTSEED_SETTLEMENT_IDLE_MS: '1', OPENAI_API_KEY: 'real' }, join(dir, 'home'), { TESTBENCH_KEY_CHAT: 'mock-only' });
    assert.equal(env.HOME, join(dir, 'home'));
    assert.equal(env.PATH, '/bin');
    assert.equal(env.ANTSEED_DEBUG, '1');
    assert.equal(env.ANTSEED_SKIP_PLUGIN_UPDATE_CHECK, '1');
    assert.equal(env.ANTSEED_NO_UPDATE_CHECK, '1');
    assert.equal(env.TESTBENCH_KEY_CHAT, 'mock-only');
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTSEED_SETTLEMENT_IDLE_MS, undefined);
    assert.match(env.NODE_OPTIONS, /--unhandled-rejections=warn --import file:.*isolate-preload\.mjs$/);
  });

  it('links workspace plugins where the CLI loader looks, once', async () => {
    const repo = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
    const home = join(dir, 'home-plugins');
    await linkPlugins(home, repo, ['provider-openai', 'router-local', 'provider-openai']);
    await linkPlugins(home, repo, ['provider-openai']);
    assert.equal(readlinkSync(join(home, '.antseed/plugins/node_modules/@antseed/provider-openai')), join(repo, 'plugins/provider-openai'));
    assert.equal(readlinkSync(join(home, '.antseed/plugins/node_modules/@antseed/router-local')), join(repo, 'plugins/router-local'));
    await assert.rejects(linkPlugins(home, repo, ['provider-nope']), /No workspace plugin provider-nope/);
  });

  it('appends both output streams to the log across restarts and captures the output', async () => {
    const logPath = join(dir, 'node.log');
    for (const round of [1, 2]) {
      const node = spawnCliNode({ who: 'seller:a', args: ['-e', `console.log('out ${round}'); console.error('err ${round}')`], env: process.env, logPath });
      await once(node.child, 'close');
      await new Promise((r) => setTimeout(r, 20));
      assert.match(node.output(), new RegExp(`out ${round}`));
      node.stopCapture();
      assert.equal(node.output(), '');
    }
    const text = readFileSync(logPath, 'utf8');
    for (const line of ['out 1', 'err 1', 'out 2', 'err 2', 'start seller:a', 'seller:a exited code=0']) assert.ok(text.includes(line), line);
  });

  it('fails readiness when the process exits, flagging a lost port', async () => {
    const node = spawnCliNode({ who: 'buyer', args: ['-e', `console.error('listen EADDRINUSE: address already in use'); process.exit(1)`], env: process.env, logPath: join(dir, 'buyer.log') });
    await once(node.child, 'close');
    await assert.rejects(waitForCliReady(node, () => false), (error) => error.code === 'EADDRINUSE' && /buyer exited with 1/.test(error.message));
    const hung = spawnCliNode({ who: 'buyer', args: ['-e', 'setTimeout(() => {}, 5000)'], env: process.env, logPath: join(dir, 'buyer.log') });
    await assert.rejects(waitForCliReady(hung, () => false, { timeoutMs: 50, intervalMs: 5 }), /was not ready after 50 ms/);
    hung.child.kill('SIGKILL');
    assert.equal(await waitForCliReady(spawnCliNodeAlive(dir), () => 'value'), 'value');
  });

  it('recognizes seller and buyer readiness and the isolation guard', () => {
    const state = { state: 'seeding', pid: 7, peerId: 'p' };
    assert.equal(sellerReady('- Starting seeding daemon...', state, 7), null);
    assert.equal(sellerReady('✔ Seeding active', state, 8), null, 'a stale state file of an earlier process');
    assert.equal(sellerReady('✔ Seeding active', null, 7), null);
    assert.equal(sellerReady('✔ Seeding active', state, 7), state);
    assert.throws(() => assertSellerPaymentsOn('Payments disabled: RPC node unreachable at http://127.0.0.1:1\n✔ Seeding active', 'seller:a'), /seller:a started with payments disabled/);
    assert.doesNotThrow(() => assertSellerPaymentsOn('✔ Seeding active', 'seller:a'));
    assert.equal(buyerProxyListening('- Starting local proxy on port 4000...', 4000), false);
    assert.equal(buyerProxyListening('✔ Proxy listening on http://localhost:4000', 4000), true);
    assert.equal(buyerProxyListening('✔ Proxy listening on http://localhost:40001', 4000), false);
    assert.throws(() => buyerProxyListening('Proxy port 4000 already in use; reusing existing local proxy.', 4000), (error) => error.code === 'EADDRINUSE');
    assert.doesNotThrow(() => assertSingleBootstrap('[Node] Starting as seller with 1 bootstrap node(s)', 's'));
    assert.throws(() => assertSingleBootstrap('[Node] Starting as buyer with 3 bootstrap node(s)', 'buyer'), /ISOLATION: buyer started with 3/);
    assert.throws(() => assertSingleBootstrap('nothing', 'buyer'), /ISOLATION/);
  });

  it('stops on SIGTERM without forcing, and forces a process that ignores it', async () => {
    const forced = [];
    const polite = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); console.log('up')`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(polite.stdout, 'data');
    await stopWithGrace(polite, { graceMs: 5000, onForced: (ms) => forced.push(ms) });
    assert.equal(polite.exitCode, 0);
    assert.deepEqual(forced, []);
    await stopWithGrace(polite, { graceMs: 5000, onForced: (ms) => forced.push(ms) });
    assert.deepEqual(forced, [], 'an exited process is left alone');
    const stubborn = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log('up')`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await once(stubborn.stdout, 'data');
    await stopWithGrace(stubborn, { graceMs: 100, onForced: (ms) => forced.push(ms) });
    assert.equal(stubborn.signalCode, 'SIGKILL');
    assert.equal(forced.length, 1);
    assert.ok(forced[0] >= 100);
  });

  it('keeps a CLI process from outliving its parent (preload)', async () => {
    const preload = new URL('../lib/isolate-preload.mjs', import.meta.url).href;
    const marker = join(dir, 'orphan-stopped');
    const child = `process.on('SIGTERM', () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(0); }); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { detached: true, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: ${JSON.stringify(`--import ${preload}`)} } }).unref(); setTimeout(() => process.exit(0), 1000);`], { stdio: 'ignore' });
    await once(parent, 'exit');
    const deadline = Date.now() + 8000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(marker));
  });
});

function spawnCliNodeAlive(dir) {
  const node = spawnCliNode({ who: 'buyer', args: ['-e', 'setTimeout(() => {}, 200)'], env: process.env, logPath: join(dir, 'buyer.log') });
  return node;
}

describe('CLI buyer client', () => {
  const closes = [];
  let closeResponse = { status: 200, body: { ok: true, result: { status: 'closed', channelId: '0xc' } } };
  let peersStatus = 200;
  let server;
  let url;
  before(async () => {
    server = createServer((request, response) => {
      const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        if (request.url === '/_antseed/channels') return send(200, { ok: true, channels: [{ peerId: 'p1' }] });
        if (request.url === '/_antseed/peers/refresh') return send(peersStatus, { ok: peersStatus === 200, error: 'no dht' });
        if (request.url === '/_antseed/peers') return send(200, { ok: true, peers: [{ peerId: 'p1' }] });
        if (request.url === '/_antseed/channels/close') { closes.push(JSON.parse(raw)); return send(closeResponse.status, closeResponse.body); }
        return send(404, { ok: false, error: 'nope' });
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server.closeAllConnections(); server.close(); });

  it('reads channels and peers over the proxy API', async () => {
    const client = cliBuyerClient(url);
    assert.deepEqual(await client.getActiveBuyerChannels(), [{ peerId: 'p1' }]);
    assert.deepEqual((await client.discoverPeers()).map((peer) => peer.peerId), ['p1']);
  });

  it('reads a failed discovery as no peers yet, so the supervisor keeps polling', async () => {
    peersStatus = 502;
    assert.deepEqual(await cliBuyerClient(url).discoverPeers(), []);
    peersStatus = 200;
  });

  it('returns the node result from a close and throws what the node threw', async () => {
    const client = cliBuyerClient(url);
    assert.deepEqual(await client.requestChannelClose('p1'), { status: 'closed', channelId: '0xc' });
    assert.deepEqual(closes.at(-1), { peerId: 'p1' });
    closeResponse = { status: 502, body: { ok: false, error: 'Seller did not answer' } };
    await assert.rejects(client.requestChannelClose('p1'), /Seller did not answer/);
  });
});
