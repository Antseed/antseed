import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet, type TransactionReceipt } from 'ethers';
import { AntsContext } from './service/context.js';
import { createAntsServer, type AntsServer } from './server.js';
import { BrowserSigning } from './browser-signer.js';
import { JobRunner } from './jobs.js';
import * as routes from './routes.js';
import * as service from './service/index.js';

const directories: string[] = [];
const servers: AntsServer[] = [];

describe('selected account browser sessions', () => {
  async function setup() {
    vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
    const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-selected-test-'));
    directories.push(dataDir);
    const selected = Wallet.createRandom();
    const operator = Wallet.createRandom();
    const server = await createAntsServer({ port: 0, dataDir, address: selected.address, selectedAddress: selected.address, signer: selected,
      chain: { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [], explorerApiUrl: '' } });
    servers.push(server);
    const getOperator = vi.fn(async () => operator.address);
    vi.spyOn(server.context, 'deposits').mockReturnValue({ getOperator } as never);
    const headers = { authorization: `Bearer ${server.token}` };
    const connect = (address: string, chainId = 31337) => server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { address, chainId } });
    const action = async (url: string, payload: object = {}) => {
      const response = await server.app.inject({ method: 'POST', url, headers, payload });
      expect(response.statusCode).toBe(200);
      const id = response.json().data.id;
      await vi.waitFor(() => expect(server.busy).toBe(false));
      return (await server.app.inject({ url: `/api/jobs/${id}`, headers })).json().data;
    };
    return { server, selected, operator, getOperator, connect, action, headers };
  }

  it('pins reads to the selected address without ever using the integrated signer', async () => {
    const { server, selected, operator, connect, headers } = await setup();
    expect(server.context.address).toBe(selected.address);
    expect(server.context.signer).toBeUndefined();
    expect((await connect(operator.address)).statusCode).toBe(200);
    expect(server.context.address).toBe(selected.address);
    expect(server.context.buyerAddress).toBe(selected.address);
    expect(await server.context.signer!.getAddress()).toBe(operator.address);
    const config = (await server.app.inject({ url: '/api/config', headers })).json().data;
    expect(config).toMatchObject({ selectedAddress: selected.address, walletAddress: operator.address, readOnly: false, canAuthorize: false });
    await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { disconnect: true } });
    expect(server.context.address).toBe(selected.address);
    expect(server.context.signer).toBeUndefined();
  });

  it('rejects unrelated wallets and wrong networks and clears an idle old signer', async () => {
    const { server, selected, operator, connect } = await setup();
    await connect(selected.address);
    const mismatch = await connect(Wallet.createRandom().address);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toContain('Wallet mismatch');
    expect(mismatch.json().error).toContain(operator.address);
    expect(server.context.signer).toBeUndefined();
    expect((await connect(operator.address, 1)).json().error).toContain('network');
    expect(server.context.address).toBe(selected.address);
  });

  it('allows the selected seller without an operator, but rejects unauthorized buyer writes', async () => {
    const { selected, getOperator, connect, action } = await setup();
    getOperator.mockResolvedValue('0x0000000000000000000000000000000000000000');
    const register = vi.spyOn(service, 'registerBinding').mockResolvedValue({} as never);
    const claim = vi.spyOn(service, 'claim').mockResolvedValue({} as never);
    expect((await connect(selected.address.toLowerCase())).statusCode).toBe(200);
    expect((await action('/api/seller/register')).status).toBe('done');
    expect(register).toHaveBeenCalledOnce();
    const rejected = await action('/api/rewards/claim', { scope: 'buyer', buckets: ['buyer'] });
    expect(rejected.error).toContain('authorize a wallet first');
    expect(claim).not.toHaveBeenCalled();
  });

  it('allows buyer-only actions for the operator, not seller or position actions', async () => {
    const { operator, connect, action } = await setup();
    const claim = vi.spyOn(service, 'claim').mockResolvedValue({} as never);
    const register = vi.spyOn(service, 'registerBinding').mockResolvedValue({} as never);
    const stake = vi.spyOn(service, 'stake').mockResolvedValue({} as never);
    await connect(operator.address);
    expect((await action('/api/rewards/claim', { scope: 'buyer', buckets: ['buyer', 'legacy'] })).status).toBe('done');
    expect(claim).toHaveBeenCalledOnce();
    for (const url of ['/api/seller/register', '/api/positions/stake', '/api/rewards/compound']) {
      expect((await action(url)).error).toContain('selected account wallet');
    }
    expect(register).not.toHaveBeenCalled();
    expect(stake).not.toHaveBeenCalled();
  });

  it('rechecks operator permissions before actions and fails closed on RPC errors', async () => {
    const { operator, getOperator, connect, action } = await setup();
    const claim = vi.spyOn(service, 'claim').mockResolvedValue({} as never);
    await connect(operator.address);
    getOperator.mockResolvedValue(Wallet.createRandom().address);
    expect((await action('/api/rewards/claim', { scope: 'buyer', buckets: ['buyer'] })).error).toContain('authorized wallet');
    getOperator.mockRejectedValue(new Error('Operator RPC unavailable'));
    expect((await action('/api/rewards/claim', { scope: 'buyer', buckets: ['buyer'] })).error).toContain('Operator RPC unavailable');
    expect((await connect(operator.address)).statusCode).toBe(400);
    expect(claim).not.toHaveBeenCalled();
  });

  it('allows both roles when the selected wallet is also the operator', async () => {
    const { selected, getOperator, connect, action } = await setup();
    getOperator.mockResolvedValue(selected.address);
    vi.spyOn(service, 'claim').mockResolvedValue({} as never);
    await connect(selected.address);
    expect((await action('/api/rewards/claim', { buckets: ['seller', 'buyer'] })).status).toBe('done');
  });

  it('does not cancel or switch wallets while an action is pending', async () => {
    const { server, selected, operator, connect, headers } = await setup();
    let finish!: () => void;
    vi.spyOn(service, 'registerBinding').mockImplementation(() => new Promise(resolve => { finish = () => resolve({} as never); }));
    await connect(selected.address);
    await server.app.inject({ method: 'POST', url: '/api/seller/register', headers, payload: {} });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await connect(operator.address)).statusCode).toBe(409);
    expect(await server.context.signer!.getAddress()).toBe(selected.address);
    finish();
    await vi.waitFor(() => expect(server.busy).toBe(false));
  });

  it.each(['unopened', 'opened', 'submitted'])('handles disconnect during an %s wallet request safely', async phase => {
    const { server, selected, connect, headers } = await setup();
    const destination = Wallet.createRandom().address;
    const hash = `0x${'ab'.repeat(32)}`;
    let confirm!: (receipt: { status: number }) => void;
    const provider = {
      getNetwork: async () => ({ chainId: 31337n }),
      getTransactionCount: async () => 0,
      call: async () => '0x',
      waitForTransaction: () => new Promise(resolve => { confirm = resolve; }),
      getTransaction: async () => ({ from: selected.address, to: destination, chainId: 31337n, nonce: 0, data: '0x', value: 0n, hash }),
    };
    vi.spyOn(server.context, 'provider').mockReturnValue(provider as never);
    vi.spyOn(service, 'registerBinding').mockImplementation(async () => {
      const transaction = await server.context.requireSigner().sendTransaction({ to: destination });
      return { hash: transaction.hash } as never;
    });
    await connect(selected.address);
    const response = await server.app.inject({ method: 'POST', url: '/api/seller/register', headers, payload: {} });
    const jobId = response.json().data.id;
    let requestId = '';
    await vi.waitFor(async () => {
      const pending = (await server.app.inject({ url: '/api/wallet/request', headers })).json().data;
      expect(pending).not.toBeNull();
      requestId = pending.id;
    });
    if (phase !== 'unopened') await server.app.inject({ method: 'POST', url: '/api/wallet/begin', headers, payload: { id: requestId } });
    if (phase === 'submitted') await server.app.inject({ method: 'POST', url: '/api/wallet/result', headers, payload: { id: requestId, hash } });
    const disconnected = await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { disconnect: true } });
    expect(disconnected.statusCode).toBe(200);
    expect(server.context.signer).toBeUndefined();
    expect(server.context.address).toBe(selected.address);
    if (phase !== 'unopened') {
      expect(server.busy).toBe(true);
      if (phase === 'opened') await server.app.inject({ method: 'POST', url: '/api/wallet/result', headers, payload: { id: requestId, hash } });
      await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));
      confirm({ status: 1 });
    }
    await vi.waitFor(() => expect(server.busy).toBe(false));
    const job = (await server.app.inject({ url: `/api/jobs/${jobId}`, headers })).json().data;
    expect(job.status).toBe(phase === 'unopened' ? 'failed' : 'done');
    if (phase === 'unopened') expect(job.error).toContain('Wallet or network changed');
  });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

it('remembers the latest confirmed transaction in the current dashboard session', async () => {
  vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
  const registration = vi.spyOn(routes, 'registerRoutes');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-checkpoint-test-'));
  directories.push(dataDir);
  const address = Wallet.createRandom().address;
  const options = { port: 0, dataDir, address, chain: { chainId: 'base-local' as const, evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [], explorerApiUrl: '' } };
  const server = await createAntsServer(options);
  servers.push(server);
  const receipt = { from: address, status: 1, blockNumber: 100, logs: [] } as unknown as TransactionReceipt;
  const getReceipt = vi.spyOn(server.context.provider(), 'getTransactionReceipt').mockResolvedValue(receipt);
  const rememberTransaction = registration.mock.calls[0]![1].rememberTransaction!;
  await rememberTransaction(`0x${'ab'.repeat(32)}`);
  getReceipt.mockResolvedValue({ ...receipt, blockNumber: 90 } as TransactionReceipt);
  await rememberTransaction(`0x${'cd'.repeat(32)}`);
  getReceipt.mockResolvedValue({ ...receipt, status: 0, blockNumber: 110 } as TransactionReceipt);
  await rememberTransaction(`0x${'ef'.repeat(32)}`);
  const barrier = server.context.positionReadBarriers.get(address.toLowerCase());
  expect(barrier).toEqual({ block: 100, at: expect.any(Number) });
  await server.close();
  servers.pop();
  const restarted = await createAntsServer(options);
  servers.push(restarted);
  expect([...restarted.context.positionReadBarriers]).toEqual([]);
});

it.each([true, false])('correlates a wallet request only with its running owner job (active=%s)', async active => {
  vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-wallet-job-test-'));
  directories.push(dataDir);
  const address = Wallet.createRandom().address;
  const transaction = { id: 'request-1', from: address, to: address, data: '0x', value: '0', chainId: 31337 };
  vi.spyOn(BrowserSigning.prototype, 'request', 'get').mockReturnValue(transaction);
  const list = vi.spyOn(JobRunner.prototype, 'list').mockReturnValue([{ id: 'job-1', kind: 'move', owner: address, status: active ? 'running' : 'done', steps: [], startedAt: Date.now() }]);
  const server = await createAntsServer({ port: 0, dataDir, address, chain: { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [] } });
  servers.push(server);
  const response = await server.app.inject({ method: 'GET', url: '/api/wallet/request', headers: { authorization: `Bearer ${server.token}` } });
  expect(response.json()).toEqual({ ok: true, data: { ...transaction, ...(active ? { jobId: 'job-1' } : {}) } });
  expect(list).toHaveBeenCalledWith(address);
  expect(transaction).not.toHaveProperty('jobId');
});

describe('explicit local service harness', () => {
  it('uses the host signer/config and an assigned local port with authenticated same-origin access', async () => {
    vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
    const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-host-test-'));
    directories.push(dataDir);
    const signer = Wallet.createRandom();
    const chain = { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:1', fallbackRpcUrls: [], explorerApiUrl: '' };
    const server = await createAntsServer({ port: 0, dataDir, browserWallet: false, signer, address: signer.address, chain });
    servers.push(server);
    const url = await server.listen();
    expect(new URL(url).port).not.toBe('0');
    expect(server.url).toBe(url);
    expect(server.context.signer).toBe(signer);
    expect(server.context.chain).toEqual(chain);
    const origin = new URL(url).origin;
    const unauthorized = await fetch(`${origin}/api/config`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${origin}/api/config`, { headers: { Authorization: `Bearer ${server.token}`, Origin: origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(JSON.stringify(await response.json())).toContain(signer.address);
    const foreign = await fetch(`${origin}/api/config`, { headers: { Authorization: `Bearer ${server.token}`, Origin: 'https://untrusted.example' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    server.pauseWrites();
    expect(server.busy).toBe(false);
    await server.close();
    servers.pop();
    await expect(fetch(`${origin}/api/config`)).rejects.toThrow();
  });
});

it('browser sessions ignore host signing keys and retain the original buyer across wallet changes', async () => {
  vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-browser-test-'));
  directories.push(dataDir);
  const buyer = Wallet.createRandom();
  const external = Wallet.createRandom();
  const server = await createAntsServer({ port: 0, dataDir, signer: buyer, address: buyer.address,
    chain: { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:8545', fallbackRpcUrls: [], explorerApiUrl: '' } });
  servers.push(server);
  // The external wallet is the buyer's authorized operator, so buyer reads stay on the originating buyer.
  vi.spyOn(server.context, 'deposits').mockReturnValue({ getOperator: async () => external.address } as never);
  const invalidate = vi.spyOn(server.context, 'invalidate');
  const noChange = await server.app.inject({ method: 'POST', url: '/api/wallet', headers: { authorization: `Bearer ${server.token}` }, payload: {} });
  expect(noChange.json().data).toEqual({ changed: false });
  expect(invalidate).not.toHaveBeenCalled();
  await server.app.inject({ method: 'POST', url: '/api/wallet', headers: { authorization: `Bearer ${server.token}` }, payload: { refresh: true } });
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(server.context.signer).toBeUndefined();
  expect(server.context.buyerAddress).toBe(buyer.address);
  const headers = { authorization: `Bearer ${server.token}` };
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet', payload: { address: external.address, chainId: 31337 } })).statusCode).toBe(401);
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { address: external.address, chainId: 8453 } })).statusCode).toBe(400);
  expect(server.context.signer).toBeUndefined();
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { address: external.address, chainId: 31337 } })).statusCode).toBe(200);
  expect(await server.context.signer?.getAddress()).toBe(external.address);
  expect(server.context.buyerAddress).toBe(buyer.address);
  expect(server.context.signer).not.toBe(buyer);
  // A wallet-less sync (second tab, extension still reconnecting) keeps the connected signer.
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: {} })).json().data).toEqual({ changed: false });
  expect(await server.context.signer?.getAddress()).toBe(external.address);
  await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { disconnect: true } });
  expect(server.context.signer).toBeUndefined();
  expect(server.context.address).toBe(external.address);
  const disconnectedConfig = (await server.app.inject({ url: '/api/config', headers })).json().data;
  expect(disconnectedConfig).toMatchObject({ readOnly: true, address: external.address });
});

it('shows a connected wallet its own buyer rewards unless it operates the originating buyer', async () => {
  vi.spyOn(AntsContext.prototype, 'selectRpc').mockResolvedValue();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-buyer-test-'));
  directories.push(dataDir);
  const buyer = Wallet.createRandom();
  const operator = Wallet.createRandom();
  const other = Wallet.createRandom();
  const server = await createAntsServer({ port: 0, dataDir, signer: buyer, address: buyer.address, onAuthorize: async () => {},
    chain: { chainId: 'base-local', evmChainId: 31337, rpcUrl: 'http://127.0.0.1:8545', fallbackRpcUrls: [], explorerApiUrl: '' } });
  servers.push(server);
  vi.spyOn(server.context, 'deposits').mockReturnValue({ getOperator: async () => operator.address } as never);
  const headers = { authorization: `Bearer ${server.token}` };
  const connect = (address: string) => server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { address, chainId: 31337 } });
  const config = async () => (await server.app.inject({ url: '/api/config', headers })).json().data;

  await connect(other.address);
  expect(server.context.buyerAddress).toBe(other.address);
  expect(await config()).toMatchObject({ buyerAddress: other.address, canAuthorize: false });
  expect((await server.app.inject({ method: 'POST', url: '/api/wallet/authorize', headers })).statusCode).toBe(400);

  await connect(operator.address);
  expect(server.context.buyerAddress).toBe(buyer.address);
  expect(await config()).toMatchObject({ buyerAddress: buyer.address, canAuthorize: true });

  await connect(buyer.address);
  expect(server.context.buyerAddress).toBe(buyer.address);

  await server.app.inject({ method: 'POST', url: '/api/wallet', headers, payload: { disconnect: true } });
  expect(server.context.buyerAddress).toBe(buyer.address);
});
