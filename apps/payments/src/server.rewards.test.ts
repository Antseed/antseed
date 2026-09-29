import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from './server.js';

vi.mock('./crypto-context.js', () => ({ loadCryptoContext: async () => null }));
const servers: Awaited<ReturnType<typeof createServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
async function setup(onOpenRewards?: () => Promise<void>) {
  const server = await createServer({ port: 0, chainOverrides: { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [] }, onOpenRewards });
  servers.push(server);
  return { server, headers: { authorization: `Bearer ${(server as unknown as { bearerToken: string }).bearerToken}` } };
}
it('old claim handoffs require the session token and open only the host rewards destination', async () => {
  const open = vi.fn(async () => {});
  const { server, headers } = await setup(open);
  expect((await server.inject({ method: 'POST', url: '/api/pay/open-rewards' })).statusCode).toBe(401);
  expect(open).not.toHaveBeenCalled();
  expect((await server.inject({ method: 'POST', url: '/api/pay/open-rewards', headers, payload: { url: 'https://untrusted.example' } })).statusCode).toBe(200);
  expect(open).toHaveBeenCalledWith();
});
it('standalone payments explain how to open rewards without retaining a second claiming UI', async () => {
  const { server, headers } = await setup();
  const result = await server.inject({ method: 'POST', url: '/api/pay/open-rewards', headers });
  expect(result.statusCode).toBe(409);
  expect(result.json().error).toContain('antseed ants,');
});
it('launcher failures are reported and can be retried', async () => {
  const open = vi.fn().mockRejectedValueOnce(new Error('Dashboard unavailable')).mockResolvedValue(undefined);
  const { server, headers } = await setup(open);
  expect((await server.inject({ method: 'POST', url: '/api/pay/open-rewards', headers })).json().error).toBe('Dashboard unavailable');
  expect((await server.inject({ method: 'POST', url: '/api/pay/open-rewards', headers })).statusCode).toBe(200);
});
