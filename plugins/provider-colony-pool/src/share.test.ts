import { createServer } from 'node:http';
import { AbiCoder } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import plugin from './index.js';
import { readWorkerShareBps } from './share.js';

const POOL = '0x00000000000000000000000000000000000000aa';
const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

interface Call { id: number; method: string }

/** A JSON-RPC endpoint whose pool reports `feeBps` as its operator fee. */
async function fakeRpc(feeBps: number): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body) as Call | Call[];
      const answer = (call: Call) => ({
        jsonrpc: '2.0', id: call.id,
        result: call.method === 'eth_chainId' ? '0x2105' : AbiCoder.defaultAbiCoder().encode(['uint256'], [feeBps]),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('worker share', () => {
  it('is what a pool contract\'s operator fee leaves', async () => {
    expect(await readWorkerShareBps(await fakeRpc(2500), POOL)).toBe(7500);
    expect(await readWorkerShareBps(await fakeRpc(1000), POOL)).toBe(9000);
  });

  it('cannot also be configured when it is read from the pool contract', () => {
    expect(() => plugin.createProvider({
      ANTSEED_ALLOWED_SERVICES: 'm', ANTSEED_OUTPUT_USD_PER_MILLION: '1', COLONY_POOL_SELLER_ADDRESS: POOL,
      COLONY_POOL_RPC_URL: 'http://127.0.0.1:1', COLONY_POOL_WORKER_SHARE_BPS: '8000',
    })).toThrow(/read from the pool contract/);
  });
});
