import { makeError } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { builders, claimBuilderRewards, registerClientAgent } from './builders.js';

const wallet = '0x0000000000000000000000000000000000000001';
const other = '0x0000000000000000000000000000000000000002';

function fixture(options: { clientRewards?: boolean; explorer?: boolean } = {}) {
  const owners: Record<number, string> = { 5: wallet, 6: other, 9: other };
  const identity = {
    getAgentWallet: vi.fn(async (agentId: number) => {
      const owner = owners[agentId];
      if (!owner) throw makeError('execution reverted', 'CALL_EXCEPTION', { action: 'call', data: '0x', reason: null, transaction: { to: null, data: '0x' }, invocation: null, revert: null });
      return owner;
    }),
    register: vi.fn(async () => 31),
  };
  const clientRewards = {
    pendingRewards: vi.fn(async (agentId: number) => agentId === 9 ? [{ epoch: 8, amount: 1n }] : []),
    claim: vi.fn(async (_signer: unknown, _agentId: number, epoch: number) => `0xhash${epoch}`),
  };
  const indexer = {
    builders: vi.fn(async (agentIds: number[]) => ({
      available: true,
      agents: agentIds.map((agentId) => agentId === 5
        ? { agentId, points: '20', pendingPoints: '0', claimed: '0', payable: '15', claimableEpochs: [3, 4] }
        : { agentId, points: '0', pendingPoints: '0', claimed: '0', payable: '0', claimableEpochs: [] }),
    })),
  };
  const ctx = {
    address: wallet,
    chain: { clientAgentIds: { cli: 5, desktop: 6 }, ...(options.clientRewards === false ? {} : { clientRewardsAddress: '0x0000000000000000000000000000000000000009' }) },
    indexer: () => (options.explorer === false ? null : indexer),
    identity: () => identity,
    clientRewards: () => (options.clientRewards === false ? null : clientRewards),
    requireSigner: () => ({}),
    invalidate: vi.fn(),
  } as unknown as AntsContext;
  return { ctx, identity, clientRewards, indexer };
}

describe('builders program', () => {
  it('reports unavailable without a client rewards contract or an explorer, never scanning RPC epochs', async () => {
    expect(await builders(fixture({ clientRewards: false }).ctx, [5])).toEqual({ available: false, agents: [] });
    const { ctx, clientRewards, identity } = fixture({ explorer: false });
    expect(await builders(ctx, [5])).toEqual({ available: false, agents: [] });
    expect(clientRewards.pendingRewards).not.toHaveBeenCalled();
    expect(identity.getAgentWallet).not.toHaveBeenCalled();
  });

  it('reads payable amounts for every candidate in one Antscan request', async () => {
    const { ctx, clientRewards, indexer } = fixture();
    await builders(ctx, [9]);
    expect(indexer.builders).toHaveBeenCalledTimes(1);
    expect(indexer.builders).toHaveBeenCalledWith([9, 5, 6]);
    expect(clientRewards.pendingRewards).not.toHaveBeenCalled();
  });

  it('hides the card when Antscan does not index the builders program', async () => {
    const { ctx, indexer } = fixture();
    indexer.builders.mockResolvedValueOnce({ available: false, agents: [] });
    expect(await builders(ctx, [9])).toEqual({ available: false, agents: [] });
  });

  it('adds first-party ids this wallet owns and keeps requested ids of any owner', async () => {
    const { ctx } = fixture();
    const view = await builders(ctx, [9, 9, 0, 404]);
    expect(view.agents.map((agent) => agent.agentId)).toEqual([5, 9, 404]);
    expect(view.agents.find((agent) => agent.agentId === 5)).toEqual({
      agentId: 5, owner: wallet, owned: true, firstParty: 'cli', payable: '15', claimableEpochs: [3, 4],
    });
    expect(view.agents.find((agent) => agent.agentId === 9)).toMatchObject({ owner: other, owned: false, firstParty: null, payable: '0' });
    expect(view.agents.find((agent) => agent.agentId === 404)).toMatchObject({ owner: null, owned: false });
  });

  it('lists owned agents first, first-party before user-added, then the rest in request order', async () => {
    const { ctx, identity } = fixture();
    identity.getAgentWallet.mockImplementation(async (agentId: number) => ({ 5: wallet, 6: other, 9: other, 12: wallet, 13: other } as Record<number, string>)[agentId]!);
    const view = await builders(ctx, [13, 12, 9]);
    expect(view.agents.map((agent) => agent.agentId)).toEqual([5, 12, 13, 9]);
  });

  it('fails the read on an RPC error rather than treating the agent as unregistered', async () => {
    const { ctx, identity } = fixture();
    identity.getAgentWallet.mockRejectedValueOnce(new Error('rate limited'));
    await expect(builders(ctx, [9])).rejects.toThrow('rate limited');
  });

  it('claims each epoch Antscan reports payable in its own transaction and reports every hash', async () => {
    const { ctx, clientRewards } = fixture();
    const report = vi.fn();
    expect(await claimBuilderRewards(ctx, 5, report)).toEqual({ agentId: 5, owner: wallet, epochs: [3, 4], hashes: ['0xhash3', '0xhash4'] });
    expect(clientRewards.claim).toHaveBeenNthCalledWith(1, {}, 5, 3);
    expect(clientRewards.claim).toHaveBeenNthCalledWith(2, {}, 5, 4);
    expect(report).toHaveBeenCalledWith('Epoch 3 claimed', '0xhash3');
    expect(report).toHaveBeenCalledWith('Epoch 4 claimed', '0xhash4');
  });

  it('falls back to the on-chain epoch scan for a claim only without an explorer', async () => {
    const { ctx, clientRewards } = fixture({ explorer: false });
    expect(await claimBuilderRewards(ctx, 9)).toMatchObject({ epochs: [8], hashes: ['0xhash8'] });
    expect(clientRewards.pendingRewards).toHaveBeenCalledWith(9);
  });

  it('refuses unregistered agents, invalid ids and empty claims without sending', async () => {
    const { ctx, clientRewards } = fixture();
    await expect(claimBuilderRewards(ctx, 404)).rejects.toThrow('not registered');
    await expect(claimBuilderRewards(ctx, 0)).rejects.toThrow('positive integer');
    await expect(claimBuilderRewards(ctx, 9)).rejects.toThrow('No builder rewards');
    expect(clientRewards.claim).not.toHaveBeenCalled();
  });

  it('registers a new client agent and returns its id', async () => {
    const { ctx, identity } = fixture();
    const report = vi.fn();
    expect(await registerClientAgent(ctx, report)).toEqual({ agentId: 31 });
    expect(identity.register).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('agent 31'));
  });
});
