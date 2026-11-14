import { Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { MulticallRequest } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import { claimColonyPool, forgetColonyPool, linkWorkerPayout, colonyPools } from './colony-pools.js';

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

/** `unfunded`: epochs the wallet earned in that the pool has not pulled; `empty`: those of them with no upstream reward. */
function fixture(pools: string[] = [pool], unfunded: number[] = [], empty: number[] = []) {
  let pulled = false;
  const client = {
    usdcBalance: vi.fn(async () => 2_500n),
    pendingAnts: vi.fn(async (_account: string, epochs: number[]) => (epochs[0] === 4 ? 7n : pulled && unfunded.includes(epochs[0]!) ? 3n : 0n)),
    epochWeight: vi.fn(async (epoch: number) => (epoch === 4 || unfunded.includes(epoch) ? 10n : 0n)),
    epochAnts: vi.fn(async (epoch: number) => (epoch === 4 || (pulled && unfunded.includes(epoch)) ? 100n : 0n)),
    claimEpochEmissions: vi.fn(async () => { pulled = true; return 'pull-hash'; }),
    // The emissions contract: the seller reward a pull would bring the pool.
    pendingEmissions: vi.fn(async (_account: string, epochs: number[]) => (empty.includes(epochs[0]!) ? 0n : 5n)),
    claimUsdc: vi.fn(async () => 'usdc-hash'),
    claimAnts: vi.fn(async () => 'ants-hash'),
    claimAntsFor: vi.fn(async () => 'ants-for-hash'),
    payout: '0x0000000000000000000000000000000000000000',
    payoutOf: vi.fn(async (): Promise<string> => client.payout),
    setPayout: vi.fn(async (_signer: unknown, authorization: { payout: string }) => { client.payout = authorization.payout; return 'link-hash'; }),
  };
  const code = new Map<string, string>([[pool, '0x6080']]);
  multicall.client = client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  multicall.calls = [];
  const chain = { evmChainId: 31337, colonyPoolAddresses: pools };
  const configured = new Set(pools.map((a) => a.toLowerCase()));
  const linkedWorkers = new Map<string, string[]>();
  const ctx = {
    address: wallet.address,
    chain,
    stack: async () => ({ currentEpoch: 6, registryPointers: { emissions: '0x00000000000000000000000000000000000000ee', staking: '0x' } }),
    colonyPoolAddresses: () => (chain.colonyPoolAddresses ?? []).map((a) => a.toLowerCase()),
    rememberColonyPool: async (address: string) => { chain.colonyPoolAddresses = [...chain.colonyPoolAddresses, address]; },
    colonyPoolWorkers: (address: string) => linkedWorkers.get(address.toLowerCase()) ?? [],
    rememberColonyPoolWorker: async (address: string, linked: string) => {
      linkedWorkers.set(address.toLowerCase(), [...(linkedWorkers.get(address.toLowerCase()) ?? []), linked.toLowerCase()]);
    },
    isLinkedColonyPool: (address: string) => chain.colonyPoolAddresses.some((a) => a.toLowerCase() === address.toLowerCase()) && !configured.has(address.toLowerCase()),
    forgetColonyPool: async (address: string) => {
      if (configured.has(address.toLowerCase())) throw new Error('Only a colony pool linked from this dashboard can be forgotten here');
      chain.colonyPoolAddresses = chain.colonyPoolAddresses.filter((a) => a.toLowerCase() !== address.toLowerCase());
    },
    colonyPool: () => client,
    provider: () => ({ getCode: async (address: string) => code.get(address.toLowerCase()) ?? '0x' }),
    requireSigner: () => wallet,
  } as unknown as AntsContext;
  return { ctx, client, code };
}

const report = vi.fn(async () => {});

describe('colony pool rewards', () => {
  it('reports USDC and ANTS each configured pool owes the wallet', async () => {
    const { ctx } = fixture();
    await expect(colonyPools(ctx)).resolves.toEqual({
      pools: [{ address: pool, usdcOwed: '2500', antsOwed: '7', antsEpochs: [4], unfundedEpochs: [], forgettable: false }],
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

  it('never offers to pull an epoch the emissions contract has no reward for', async () => {
    const { ctx, client } = fixture([pool], [2, 5], [2]);
    expect((await colonyPools(ctx)).pools[0]!.unfundedEpochs).toEqual([5]);
    await claimColonyPool(ctx, { pool, usdc: false, ants: true }, report);
    expect(client.claimEpochEmissions).toHaveBeenCalledTimes(1);
    expect(client.claimEpochEmissions).toHaveBeenCalledWith(wallet, [5]);
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

  it('marks a pool unreadable instead of showing zero when a batched epoch read fails', async () => {
    const { ctx, client } = fixture();
    client.epochAnts.mockImplementation(async () => undefined as unknown as bigint);
    const [view] = (await colonyPools(ctx)).pools;
    expect(view).toMatchObject({ address: pool, usdcOwed: '0', antsOwed: '0', error: expect.stringMatching(/epochAnts unavailable/) });
    await expect(claimColonyPool(ctx, { pool, usdc: true, ants: true }, report)).rejects.toThrow(/epochAnts unavailable/);
  });

  it('keeps showing valid pools when a remembered one cannot be read, and lets it be forgotten', async () => {
    const broken = '0x00000000000000000000000000000000000000cc';
    const { ctx, client } = fixture([pool]);
    await ctx.rememberColonyPool(broken);
    const base = client.usdcBalance.getMockImplementation()!;
    client.usdcBalance.mockImplementation(async () => { throw new Error('missing revert data'); });
    const opened = (ctx as unknown as { colonyPool: (address: string) => typeof client });
    opened.colonyPool = (address: string) => (address.toLowerCase() === broken ? client : { ...client, usdcBalance: vi.fn(base) });
    const { pools } = await colonyPools(ctx);
    expect(pools.find((entry) => entry.address === pool)).toMatchObject({ usdcOwed: '2500', forgettable: false });
    expect(pools.find((entry) => entry.address === broken)).toMatchObject({ error: expect.stringMatching(/missing revert data/), forgettable: true });
    await expect(forgetColonyPool(ctx, { pool })).rejects.toThrow(/linked from this dashboard/);
    await expect(forgetColonyPool(ctx, { pool: broken })).resolves.toEqual({ pool: broken });
    expect(ctx.colonyPoolAddresses()).toEqual([pool]);
  });

  it('refuses pools the dashboard does not know', async () => {
    const { ctx } = fixture([]);
    await expect(claimColonyPool(ctx, { pool, usdc: true, ants: false }, report)).rejects.toThrow(/Unknown colony pool/);
  });

  it('rejects a link to an account without code, or to a contract that is not a colony pool, and never remembers it', async () => {
    const { ctx, client, code } = fixture([]);
    code.delete(pool);
    await expect(linkWorkerPayout(ctx, { code: linkCode() }, report)).rejects.toThrow(/not a contract/);
    code.set(pool, '0x6080');
    client.payoutOf.mockRejectedValueOnce(new Error('could not decode result data'));
    await expect(linkWorkerPayout(ctx, { code: linkCode() }, report)).rejects.toThrow(/not a colony pool/);
    expect(client.setPayout).not.toHaveBeenCalled();
    expect(ctx.colonyPoolAddresses()).toEqual([]);
  });

  it('does not report or remember a link the pool did not record', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, client } = fixture([]);
      client.setPayout.mockImplementation(async () => 'link-hash');
      const linking = linkWorkerPayout(ctx, { code: linkCode() }, report);
      const settled = expect(linking).rejects.toThrow(/did not record this wallet/);
      await vi.runAllTimersAsync();
      await settled;
      expect(ctx.colonyPoolAddresses()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('submits a Mac link from the payout wallet and starts showing its pool', async () => {
    const { ctx, client } = fixture([]);
    await expect(linkWorkerPayout(ctx, { code: linkCode() }, report)).resolves.toMatchObject({ hash: 'link-hash', pool, worker });
    expect(client.setPayout).toHaveBeenCalledWith(wallet, expect.objectContaining({ worker, payout: wallet.address }));
    expect(ctx.colonyPoolAddresses()).toEqual([pool]);
  });

  it('shows and claims the ANTS a Mac linked here earned before its link, while its payout is this wallet', async () => {
    const { ctx, client } = fixture([]);
    await linkWorkerPayout(ctx, { code: linkCode() }, report);
    // The Mac's own weight in epoch 1, older than its link moved; this wallet's own in epoch 4.
    client.epochWeight.mockImplementation(async (epoch: number, account: string) =>
      (account === worker ? (epoch === 1 ? 10n : 0n) : epoch === 4 ? 10n : 0n));
    client.pendingAnts.mockImplementation(async (account: string, epochs: number[]) =>
      (account === worker ? (epochs[0] === 1 ? 9n : 0n) : epochs[0] === 4 ? 7n : 0n));
    client.epochAnts.mockImplementation(async () => 100n);
    const view = (await colonyPools(ctx)).pools[0]!;
    expect(view).toMatchObject({ antsOwed: '16', antsEpochs: [4], workerAnts: [{ worker, antsOwed: '9', antsEpochs: [1] }] });
    await expect(claimColonyPool(ctx, { pool, usdc: false, ants: true }, report)).resolves.toEqual({ hashes: ['ants-hash', 'ants-for-hash'] });
    expect(client.claimAntsFor).toHaveBeenCalledWith(wallet, worker, [1]);
    // Linked elsewhere since: its ANTS are no longer this wallet's to claim.
    client.payout = Wallet.createRandom().address;
    expect((await colonyPools(ctx)).pools[0]!).not.toHaveProperty('workerAnts');
  });

  it('rejects a link for another wallet, another chain, or a malformed code', async () => {
    const { ctx, client } = fixture();
    await expect(linkWorkerPayout(ctx, { code: linkCode({ payout: Wallet.createRandom().address }) }, report)).rejects.toThrow(/connect that wallet/);
    await expect(linkWorkerPayout(ctx, { code: linkCode({ chainId: 8453 }) }, report)).rejects.toThrow(/chain 8453/);
    await expect(linkWorkerPayout(ctx, { code: 'not a code' }, report)).rejects.toThrow(/not a valid/);
    expect(client.setPayout).not.toHaveBeenCalled();
  });
});
