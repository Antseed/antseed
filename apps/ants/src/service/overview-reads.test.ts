import { beforeEach, describe, expect, it, vi } from 'vitest';
import { multicallRead } from '@antseed/node/payments';
import { overviewReads } from './overview-reads.js';
import { overview } from './overview.js';
import type { AntsContext, ResolvedStack } from './context.js';
import { networkSnapshot } from './network.js';
import type { NetworkSnapshot } from '../api-types.js';
vi.mock('./network.js', () => ({ networkSnapshot: vi.fn() }));
vi.mock('@antseed/node/payments', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));
const address = '0x0000000000000000000000000000000000000001';
const provider = { getBalance: vi.fn(async () => 99n) };
const ctx = {
  address, chain: { sellerPoolsAddress: address, sellerRegistryAddress: address, emissionsGateAddress: address, sellerPoolsRewardsAddress: address, usageRewardsAddress: address },
  antsToken: () => ({ contractAddress: address }), provider: () => provider,
  indexer: () => null,
} as unknown as AntsContext;
const stack = { currentEpoch: 22, legacyStaking: address } as ResolvedStack;
beforeEach(() => {
  vi.mocked(networkSnapshot).mockResolvedValue({ totalSupply: '10', maxSupply: '10', totalActiveStake: '10', totalPowerWeight: '10', emission: '10', budgets: { staker: '10', buyer: '7', seller: '8' }, errors: [] } as unknown as NetworkSnapshot);
  provider.getBalance.mockClear();
  vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(request =>
    request.method === 'transfersEnabled' ? [false] : request.method === 'transferWhitelist' ? [true] : request.method === 'usageEpochBudgets' ? [7n, 8n] : [10n]));
});
describe('batched overview', () => {
  it.each([address, '0x0000000000000000000000000000000000000002'])('reads the separate signing wallet gas balance only when needed: %s', async wallet => {
    const viewContext = {
      ...ctx, signer: { getAddress: async () => wallet },
      stack: async () => ({ ...stack, phase: 'active', genesis: 0, epochDuration: 86400 }),
      pools: () => null, sellerRegistry: () => null, addresses: () => ({}),
    } as unknown as AntsContext;
    const summary = (await overview(viewContext)).wallet;
    expect(summary).toMatchObject({ address, eth: '99' });
    expect(summary.signingWalletEth).toBe(wallet === address ? undefined : '99');
    expect(provider.getBalance).toHaveBeenCalledTimes(wallet === address ? 1 : 2);
    if (wallet !== address) expect(provider.getBalance).toHaveBeenCalledWith(wallet);
  });
  it('groups contract reads and retains separate buyer/seller budgets and restrictions', async () => {
    const result = await overviewReads(ctx, stack);
    expect(result).toMatchObject({ ants: 10n, eth: 99n, transfersEnabled: false, whitelisted: true, positionCount: 10, usageBudgets: { buyer: 7n, seller: 8n } });
    expect(vi.mocked(multicallRead).mock.calls.at(-1)![1]).toHaveLength(7);
    expect(networkSnapshot).toHaveBeenCalledWith(ctx);
  });
  it('rejects an incomplete balance read instead of displaying a zero', async () => {
    vi.mocked(multicallRead).mockResolvedValue([null]);
    await expect(overviewReads(ctx, stack)).rejects.toThrow('balanceOf');
  });
});
