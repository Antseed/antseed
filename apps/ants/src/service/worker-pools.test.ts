import { Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { claimWorkerPool, linkWorkerPayout, workerPools } from './worker-pools.js';

const wallet = Wallet.createRandom();
const pool = '0x00000000000000000000000000000000000000aa';
const worker = '0x00000000000000000000000000000000000000bb';

function linkCode(overrides: Record<string, unknown> = {}): string {
  const payload = { chainId: 31337, pool, worker, payout: wallet.address, deadline: 2_000_000_000, signature: `0x${'11'.repeat(65)}`, ...overrides };
  return `antseed-link:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function fixture(pools: string[] = [pool]) {
  const client = {
    usdcBalance: vi.fn(async () => 2_500n),
    pendingAnts: vi.fn(async (_account: string, epochs: number[]) => (epochs[0] === 4 ? 7n : 0n)),
    claimUsdc: vi.fn(async () => 'usdc-hash'),
    claimAnts: vi.fn(async () => 'ants-hash'),
    setPayout: vi.fn(async () => 'link-hash'),
  };
  const chain = { evmChainId: 31337, workerPoolAddresses: pools };
  const ctx = {
    address: wallet.address,
    chain,
    stack: async () => ({ currentEpoch: 6 }),
    workerPoolAddresses: () => (chain.workerPoolAddresses ?? []).map((a) => a.toLowerCase()),
    rememberWorkerPool: (address: string) => { chain.workerPoolAddresses = [...chain.workerPoolAddresses, address]; },
    workerPool: () => client,
    requireSigner: () => wallet,
  } as unknown as AntsContext;
  return { ctx, client };
}

const report = vi.fn(async () => {});

describe('worker pool rewards', () => {
  it('reports USDC and ANTS each configured pool owes the wallet', async () => {
    const { ctx } = fixture();
    await expect(workerPools(ctx)).resolves.toEqual({
      pools: [{ address: pool, usdcOwed: '2500', antsOwed: '7', antsEpochs: [4] }],
    });
  });

  it('claims USDC and the epochs with ANTS owed', async () => {
    const { ctx, client } = fixture();
    await expect(claimWorkerPool(ctx, { pool, usdc: true, ants: true }, report)).resolves.toEqual({ hashes: ['usdc-hash', 'ants-hash'] });
    expect(client.claimAnts).toHaveBeenCalledWith(wallet, [4]);
  });

  it('refuses pools the dashboard does not know', async () => {
    const { ctx } = fixture([]);
    await expect(claimWorkerPool(ctx, { pool, usdc: true, ants: false }, report)).rejects.toThrow(/Unknown worker pool/);
  });

  it('submits a Mac link from the payout wallet and starts showing its pool', async () => {
    const { ctx, client } = fixture([]);
    await expect(linkWorkerPayout(ctx, { code: linkCode() }, report)).resolves.toMatchObject({ hash: 'link-hash', pool, worker });
    expect(client.setPayout).toHaveBeenCalledWith(wallet, expect.objectContaining({ worker, payout: wallet.address }));
    expect(ctx.workerPoolAddresses()).toEqual([pool]);
  });

  it('rejects a link for another wallet, another chain, or a malformed code', async () => {
    const { ctx, client } = fixture();
    await expect(linkWorkerPayout(ctx, { code: linkCode({ payout: Wallet.createRandom().address }) }, report)).rejects.toThrow(/connect that wallet/);
    await expect(linkWorkerPayout(ctx, { code: linkCode({ chainId: 8453 }) }, report)).rejects.toThrow(/chain 8453/);
    await expect(linkWorkerPayout(ctx, { code: 'not a code' }, report)).rejects.toThrow(/not a valid/);
    expect(client.setPayout).not.toHaveBeenCalled();
  });
});
