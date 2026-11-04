import { Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { MulticallRequest } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import { claimColonyPool, linkWorkerPayout, colonyPools } from './colony-pools.js';

// Batched epoch reads go through Multicall3; here they are answered by the fixture's client.
const multicall = vi.hoisted(() => ({ client: null as Record<string, (...args: unknown[]) => Promise<unknown>> | null, calls: [] as string[] }));
vi.mock('@antseed/node/payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@antseed/node/payments')>()),
  multicallRead: vi.fn(async (_provider: unknown, requests: MulticallRequest[]) => {
    multicall.calls.push(requests[0]?.method ?? '');
    return Promise.all(requests.map(async (request) => {
      const value = await multicall.client![request.method]!(...(request.args ?? []));
      return value === undefined ? null : [value];
    }));
  }),
}));

const wallet = Wallet.createRandom();
const pool = '0x00000000000000000000000000000000000000aa';
const worker = '0x00000000000000000000000000000000000000bb';

function linkCode(overrides: Record<string, unknown> = {}): string {
  const payload = { chainId: 31337, pool, worker, payout: wallet.address, deadline: 2_000_000_000, signature: `0x${'11'.repeat(65)}`, ...overrides };
  return `antseed-link:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function fixture(pools: string[] = [pool], unfunded: number[] = []) {
  let pulled = false;
  const client = {
    usdcBalance: vi.fn(async () => 2_500n),
    pendingAnts: vi.fn(async (_account: string, epochs: number[]) => (epochs[0] === 4 ? 7n : pulled && unfunded.includes(epochs[0]!) ? 3n : 0n)),
    epochWeight: vi.fn(async (epoch: number) => (epoch === 4 || unfunded.includes(epoch) ? 10n : 0n)),
    epochAnts: vi.fn(async (epoch: number) => (epoch === 4 || (pulled && unfunded.includes(epoch)) ? 100n : 0n)),
    claimEpochEmissions: vi.fn(async () => { pulled = true; return 'pull-hash'; }),
    claimUsdc: vi.fn(async () => 'usdc-hash'),
    claimAnts: vi.fn(async () => 'ants-hash'),
    setPayout: vi.fn(async () => 'link-hash'),
  };
  multicall.client = client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  multicall.calls = [];
  const chain = { evmChainId: 31337, colonyPoolAddresses: pools };
  const ctx = {
    address: wallet.address,
    chain,
    stack: async () => ({ currentEpoch: 6 }),
    colonyPoolAddresses: () => (chain.colonyPoolAddresses ?? []).map((a) => a.toLowerCase()),
    rememberColonyPool: async (address: string) => { chain.colonyPoolAddresses = [...chain.colonyPoolAddresses, address]; },
    colonyPool: () => client,
    provider: () => ({}),
    requireSigner: () => wallet,
  } as unknown as AntsContext;
  return { ctx, client };
}

const report = vi.fn(async () => {});

describe('colony pool rewards', () => {
  it('reports USDC and ANTS each configured pool owes the wallet', async () => {
    const { ctx } = fixture();
    await expect(colonyPools(ctx)).resolves.toEqual({
      pools: [{ address: pool, usdcOwed: '2500', antsOwed: '7', antsEpochs: [4], unfundedEpochs: [] }],
    });
  });

  it('claims USDC and the epochs with ANTS owed', async () => {
    const { ctx, client } = fixture();
    await expect(claimColonyPool(ctx, { pool, usdc: true, ants: true }, report)).resolves.toEqual({ hashes: ['usdc-hash', 'ants-hash'] });
    expect(client.claimAnts).toHaveBeenCalledWith(wallet, [4]);
  });

  it('pulls the pool\'s emissions for earned but unfunded epochs before claiming ANTS', async () => {
    const { ctx, client } = fixture([pool], [5]);
    expect((await colonyPools(ctx)).pools[0]!.unfundedEpochs).toEqual([5]);
    await expect(claimColonyPool(ctx, { pool, usdc: false, ants: true }, report)).resolves.toEqual({ hashes: ['pull-hash', 'ants-hash'] });
    expect(client.claimEpochEmissions).toHaveBeenCalledWith(wallet, [5]);
    expect(client.claimAnts).toHaveBeenCalledWith(wallet, [4, 5]);
  });

  it('still claims funded epochs when pulling emissions fails', async () => {
    const { ctx, client } = fixture([pool], [5]);
    client.claimEpochEmissions.mockRejectedValueOnce(new Error('EmissionsLocked'));
    await expect(claimColonyPool(ctx, { pool, usdc: false, ants: true }, report)).resolves.toEqual({ hashes: ['ants-hash'] });
    expect(client.claimAnts).toHaveBeenCalledWith(wallet, [4]);
  });

  it('reads only the pool being claimed', async () => {
    const other = Wallet.createRandom().address.toLowerCase();
    const { ctx, client } = fixture([pool, other]);
    const opened: string[] = [];
    (ctx as unknown as { colonyPool: (address: string) => typeof client }).colonyPool = (address: string) => { opened.push(address.toLowerCase()); return client; };
    await claimColonyPool(ctx, { pool, usdc: true, ants: false }, report);
    expect(new Set(opened)).toEqual(new Set([pool.toLowerCase()]));
  });

  it('reports, but does not fail the link, when the pool cannot be saved', async () => {
    const { ctx } = fixture([]);
    (ctx as unknown as { rememberColonyPool: () => Promise<void> }).rememberColonyPool = async () => { throw new Error('disk full'); };
    await expect(linkWorkerPayout(ctx, { code: linkCode() }, report)).resolves.toMatchObject({ hash: 'link-hash' });
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/Could not save the colony pool.*disk full/));
  });

  it('finds and claims ANTS from every finished epoch, in batches the contract accepts', async () => {
    const { ctx, client } = fixture();
    // Earned in epoch 4 (long past any recent window) and in each of epochs 40..79.
    const earned = (epoch: number) => epoch === 4 || (epoch >= 40 && epoch < 80);
    (ctx as unknown as { stack: () => Promise<{ currentEpoch: number }> }).stack = async () => ({ currentEpoch: 100 });
    client.epochWeight.mockImplementation(async (epoch: number) => (earned(epoch) ? 10n : 0n));
    client.epochAnts.mockImplementation(async () => 100n);
    client.pendingAnts.mockImplementation(async (_account: string, epochs: number[]) => (earned(epochs[0]!) ? 1n : 0n));
    const view = (await colonyPools(ctx)).pools[0]!;
    expect(view.antsEpochs).toEqual([4, ...Array.from({ length: 40 }, (_, i) => 40 + i)]);
    expect(view.antsOwed).toBe('41');
    await claimColonyPool(ctx, { pool, usdc: false, ants: true }, report);
    expect(client.claimAnts.mock.calls.map(([, epochs]) => epochs)).toEqual([
      [4, ...Array.from({ length: 31 }, (_, i) => 40 + i)],
      Array.from({ length: 9 }, (_, i) => 71 + i),
    ]);
    // Epochs with no weight are never asked about beyond their weight.
    expect(client.pendingAnts).toHaveBeenCalledTimes(82);
    // A hundred epochs' weights are one batched read, not a hundred calls.
    expect(multicall.calls.filter((method) => method === 'epochWeight')).toHaveLength(2);
  });

  it('fails instead of showing zero when a batched epoch read fails', async () => {
    const { ctx, client } = fixture();
    client.epochAnts.mockImplementation(async () => undefined as unknown as bigint);
    await expect(colonyPools(ctx)).rejects.toThrow(/epochAnts unavailable/);
  });

  it('refuses pools the dashboard does not know', async () => {
    const { ctx } = fixture([]);
    await expect(claimColonyPool(ctx, { pool, usdc: true, ants: false }, report)).rejects.toThrow(/Unknown colony pool/);
  });

  it('submits a Mac link from the payout wallet and starts showing its pool', async () => {
    const { ctx, client } = fixture([]);
    await expect(linkWorkerPayout(ctx, { code: linkCode() }, report)).resolves.toMatchObject({ hash: 'link-hash', pool, worker });
    expect(client.setPayout).toHaveBeenCalledWith(wallet, expect.objectContaining({ worker, payout: wallet.address }));
    expect(ctx.colonyPoolAddresses()).toEqual([pool]);
  });

  it('rejects a link for another wallet, another chain, or a malformed code', async () => {
    const { ctx, client } = fixture();
    await expect(linkWorkerPayout(ctx, { code: linkCode({ payout: Wallet.createRandom().address }) }, report)).rejects.toThrow(/connect that wallet/);
    await expect(linkWorkerPayout(ctx, { code: linkCode({ chainId: 8453 }) }, report)).rejects.toThrow(/chain 8453/);
    await expect(linkWorkerPayout(ctx, { code: 'not a code' }, report)).rejects.toThrow(/not a valid/);
    expect(client.setPayout).not.toHaveBeenCalled();
  });
});
