import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { startRpcRelay } from '../lib/rpc-relay.mjs';

async function fakeUpstream(handler) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    handler(req, body, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v2/SECRETKEY`, close: () => new Promise((r) => server.close(r)) };
}

const rpc = (url, method) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });

describe('fork RPC relay', () => {
  it('forwards JSON-RPC and never exposes the upstream URL', async () => {
    const seen = [];
    const upstream = await fakeUpstream((req, body, res) => { seen.push({ path: req.url, body }); res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":"0x2105"}'); });
    const relay = await startRpcRelay(upstream.url);
    try {
      assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
      assert.doesNotMatch(relay.url, /SECRETKEY/);
      assert.equal((await (await rpc(relay.url, 'eth_chainId')).json()).result, '0x2105');
      assert.equal(seen[0].path, '/v2/SECRETKEY');
      assert.match(seen[0].body, /eth_chainId/);
      const origin = new URL(relay.url).origin;
      assert.equal((await rpc(`${origin}/wrong`, 'eth_chainId')).status, 404);
      assert.equal((await fetch(relay.url)).status, 404);
    } finally {
      await relay.close();
      await upstream.close();
    }
  });

  it('answers a JSON-RPC error without the URL when the upstream fails', async () => {
    const relay = await startRpcRelay('http://127.0.0.1:1/v2/SECRETKEY');
    try {
      const response = await rpc(relay.url, 'eth_chainId');
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.doesNotMatch(text, /SECRETKEY|127\.0\.0\.1:1/);
    } finally {
      await relay.close();
    }
  });

  it('lets Anvil fork through it', { skip: spawnSync('anvil', ['--version']).status !== 0 && 'anvil not on PATH' }, async () => {
    const free = () => new Promise((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
    const startAnvil = async (args) => {
      const port = await free();
      const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), ...args], { stdio: 'ignore' });
      const url = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100; i += 1) {
        try { if ((await (await rpc(url, 'eth_chainId')).json()).result) return { child, url }; } catch { /* starting */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      child.kill('SIGKILL');
      throw new Error('anvil did not start');
    };
    const base = await startAnvil(['--chain-id', '4242']);
    const relay = await startRpcRelay(base.url);
    let fork;
    try {
      fork = await startAnvil(['--fork-url', relay.url, '--chain-id', '4243']);
      assert.equal((await (await rpc(fork.url, 'eth_chainId')).json()).result, '0x1093');
      assert.equal((await (await rpc(fork.url, 'eth_blockNumber')).json()).result, '0x0');
    } finally {
      fork?.child.kill('SIGKILL');
      await relay.close();
      base.child.kill('SIGKILL');
    }
  });
});
