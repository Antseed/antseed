import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroAddress } from 'ethers';
import { multicallRead } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import { stakeEligibility } from './stake-eligibility.js';

vi.mock('@antseed/node/payments', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));

const poolsAddress = '0x0000000000000000000000000000000000000001';
const identity = '0x0000000000000000000000000000000000000002';
const source = '0x0000000000000000000000000000000000000003';
const owner = '0x0000000000000000000000000000000000000004';
const provider = { getBlockNumber: vi.fn(async () => 123) };
let ctx: AntsContext;
function makeCtx(): AntsContext {
  const memos = new Map<string, unknown>();
  return {
    requirePools: () => ({ contractAddress: poolsAddress, provider }),
    chain: { sellerRegistryAddress: '0x0000000000000000000000000000000000000099' },
    memoGet: (key: string) => memos.get(key),
    memoSet: (key: string, value: unknown) => { memos.set(key, value); return value; },
  } as unknown as AntsContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  ctx = makeCtx();
  vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(request => {
    if (request.method === 'identityRegistry') return [identity];
    if (request.method === 'stakingSource') return [source];
    if (request.method === 'ownerOf') return [owner];
    if (request.method === 'getAgentId') return [59096n];
    throw new Error(`Unexpected method ${request.method}`);
  }));
});

describe('contract-aligned staking eligibility', () => {
  it('accepts legacy registration without requiring an explicit agentSeller binding', async () => {
    expect((await stakeEligibility(ctx, [59096])).get(59096)).toEqual({ owner, stakeable: true });
    expect(vi.mocked(multicallRead).mock.calls.flatMap(call => call[1].map(request => request.method))).toEqual([
      'identityRegistry', 'stakingSource', 'ownerOf', 'getAgentId',
    ]);
  });

  it('uses the actual pool pointers and pins every read to the same block', async () => {
    await stakeEligibility(ctx, [59096]);
    const calls = vi.mocked(multicallRead).mock.calls;
    expect(calls.map(call => call[2])).toEqual([{ blockTag: 123 }, { blockTag: 123 }, { blockTag: 123 }]);
    expect(calls[1]![1][0]!.target).toBe(identity);
    expect(calls[2]![1][0]!.target).toBe(source);
    expect(calls[2]![1][0]!.args).toEqual([owner]);
  });

  it('rejects a current owner registered to another agent, even if indexed registration was true', async () => {
    expect((await stakeEligibility(ctx, [60570])).get(60570)).toEqual({ owner, stakeable: false });
  });

  it('deduplicates agents and owner reads across the provider list', async () => {
    const result = await stakeEligibility(ctx, [59096, 59096, 60570]);
    expect(result.size).toBe(2);
    const calls = vi.mocked(multicallRead).mock.calls;
    expect(calls[1]![1]).toHaveLength(2);
    expect(calls[2]![1]).toHaveLength(1);
  });

  it('rejects a nonexistent identity without looking up a zero address', async () => {
    vi.mocked(multicallRead).mockResolvedValueOnce([[identity], [source]]).mockResolvedValueOnce([null]).mockResolvedValueOnce([]);
    expect((await stakeEligibility(ctx, [59096])).get(59096)).toEqual({ owner: null, stakeable: false });
    expect(vi.mocked(multicallRead).mock.calls[2]![1]).toEqual([]);
  });

  it('reports a failed registration read rather than claiming the seller must register again', async () => {
    vi.mocked(multicallRead).mockResolvedValueOnce([[identity], [source]]).mockResolvedValueOnce([[owner]]).mockResolvedValueOnce([null]);
    await expect(stakeEligibility(ctx, [59096])).rejects.toThrow('seller registration is unavailable');
  });

  it('reports an unconfigured source instead of trusting the configured registry address', async () => {
    vi.mocked(multicallRead).mockResolvedValueOnce([[identity], [ZeroAddress]]);
    await expect(stakeEligibility(ctx, [59096])).rejects.toThrow('staking source is unavailable');
  });

  it('serves repeated agents from the cache until a transaction invalidates it', async () => {
    await stakeEligibility(ctx, [59096]);
    expect((await stakeEligibility(ctx, [59096, 60570])).size).toBe(2);
    const calls = vi.mocked(multicallRead).mock.calls;
    expect(calls).toHaveLength(6);
    expect(calls[4]![1].map(request => request.args)).toEqual([[60570]]);
    expect(await stakeEligibility(ctx, [59096, 60570])).toEqual(new Map([[59096, { owner, stakeable: true }], [60570, { owner, stakeable: false }]]));
    expect(vi.mocked(multicallRead).mock.calls).toHaveLength(6);
  });

  it('propagates RPC failures and makes no calls for an empty list', async () => {
    expect(await stakeEligibility(ctx, [])).toEqual(new Map());
    expect(provider.getBlockNumber).not.toHaveBeenCalled();
    vi.mocked(multicallRead).mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(stakeEligibility(ctx, [59096])).rejects.toThrow('RPC unavailable');
  });
});
