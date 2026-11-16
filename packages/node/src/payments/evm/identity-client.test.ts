import { describe, it, expect } from 'vitest';
import { ethers, type AbstractProvider } from 'ethers';
import { IdentityClient } from './identity-client.js';

const REGISTRY = '0x0000000000000000000000000000000000008004';
const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ZERO = ethers.ZeroAddress;
const TRANSFER = ethers.id('Transfer(address,address,uint256)');
const iface = new ethers.Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 agentId) view returns (address)',
]);

interface Transfer { from: string; to: string; agentId: number; block: number }

/** A provider that serves a fake registry: Transfer logs plus balanceOf/ownerOf from current ownership. */
function fakeRegistry(transfers: Transfer[], head: number) {
  const owners = new Map<number, string>();
  for (const t of [...transfers].sort((a, b) => a.block - b.block)) owners.set(t.agentId, t.to);
  const ranges: Array<[number, number]> = [];
  const provider = {
    getBlockNumber: async () => head,
    getLogs: async (filter: { topics: Array<string | null>; fromBlock: number; toBlock: number }) => {
      ranges.push([filter.fromBlock, filter.toBlock]);
      const to = filter.topics[2]!;
      return transfers
        .filter((t) => t.block >= filter.fromBlock && t.block <= filter.toBlock
          && ethers.zeroPadValue(t.to, 32).toLowerCase() === to.toLowerCase())
        .sort((a, b) => a.block - b.block)
        .map((t) => ({
          topics: [TRANSFER, ethers.zeroPadValue(t.from, 32), ethers.zeroPadValue(t.to, 32), ethers.toBeHex(t.agentId, 32)],
          blockNumber: t.block,
        }));
    },
    call: async (tx: { data: string }) => {
      const parsed = iface.parseTransaction({ data: tx.data })!;
      if (parsed.name === 'balanceOf') {
        const owner = (parsed.args[0] as string).toLowerCase();
        const count = [...owners.values()].filter((o) => o.toLowerCase() === owner).length;
        return iface.encodeFunctionResult('balanceOf', [count]);
      }
      const owner = owners.get(Number(parsed.args[0]));
      if (!owner || owner === ZERO) throw ethers.makeError('execution reverted', 'CALL_EXCEPTION', { action: 'call', data: null, reason: null, transaction: { to: REGISTRY, data: tx.data }, invocation: null, revert: null });
      return iface.encodeFunctionResult('ownerOf', [owner]);
    },
  };
  return { provider: provider as unknown as AbstractProvider, ranges };
}

function client(provider: AbstractProvider, deployBlock?: number): IdentityClient {
  return new IdentityClient({ rpcUrl: 'http://localhost:8545', contractAddress: REGISTRY, deployBlock }).withProvider(provider);
}

describe('IdentityClient.findOwnedAgentIds', () => {
  it('recovers the agent ID minted to the wallet', async () => {
    const { provider } = fakeRegistry([
      { from: ZERO, to: OTHER, agentId: 4, block: 1_200 },
      { from: ZERO, to: OWNER, agentId: 7, block: 1_500 },
    ], 2_000);
    expect(await client(provider, 1_000).findOwnedAgentIds(OWNER, { chunkBlocks: 100 })).toEqual([7]);
  });

  it('returns nothing without scanning when the wallet holds no agent', async () => {
    const { provider, ranges } = fakeRegistry([{ from: ZERO, to: OTHER, agentId: 4, block: 1_200 }], 2_000);
    expect(await client(provider, 1_000).findOwnedAgentIds(OWNER)).toEqual([]);
    expect(ranges).toEqual([]);
  });

  it('returns every agent the wallet holds, skipping ones transferred away', async () => {
    const { provider } = fakeRegistry([
      { from: ZERO, to: OWNER, agentId: 3, block: 1_050 },
      { from: ZERO, to: OWNER, agentId: 9, block: 1_400 },
      { from: OWNER, to: OTHER, agentId: 9, block: 1_450 },
      { from: OTHER, to: OWNER, agentId: 12, block: 1_900 },
    ], 2_000);
    expect(await client(provider, 1_000).findOwnedAgentIds(OWNER, { chunkBlocks: 100 })).toEqual([3, 12]);
  });

  it('scans newest first in bounded windows down to the deploy block, stopping once balanceOf is met', async () => {
    const { provider, ranges } = fakeRegistry([{ from: ZERO, to: OWNER, agentId: 7, block: 1_750 }], 2_000);
    expect(await client(provider, 1_000).findOwnedAgentIds(OWNER, { chunkBlocks: 100 })).toEqual([7]);
    expect(ranges).toEqual([[1_901, 2_000], [1_801, 1_900], [1_701, 1_800]]);
    for (const [from, to] of ranges) expect(to - from + 1).toBeLessThanOrEqual(100);
  });

  it('never scans below the deploy block', async () => {
    const { provider, ranges } = fakeRegistry([{ from: ZERO, to: OWNER, agentId: 7, block: 900 }], 1_250);
    expect(await client(provider, 1_000).findOwnedAgentIds(OWNER, { chunkBlocks: 100 })).toEqual([]);
    expect(ranges.at(-1)).toEqual([1_000, 1_050]);
  });

  it('shrinks the window when the RPC rejects its block range', async () => {
    const { provider, ranges } = fakeRegistry([{ from: ZERO, to: OWNER, agentId: 7, block: 1_750 }], 2_000);
    const getLogs = provider.getLogs.bind(provider);
    provider.getLogs = (async (filter: { fromBlock: number; toBlock: number }) => {
      if (filter.toBlock - filter.fromBlock + 1 > 100) {
        ranges.push([filter.fromBlock, filter.toBlock]);
        throw new Error('block range too large');
      }
      return getLogs(filter as never);
    }) as AbstractProvider['getLogs'];
    expect(await client(provider, 1_000).findOwnedAgentIds(OWNER, { chunkBlocks: 1_000 })).toEqual([7]);
    expect(ranges).toEqual([[1_001, 2_000], [1_901, 2_000], [1_801, 1_900], [1_701, 1_800]]);
  });

  it('reports progress after each window', async () => {
    // The agent was minted below the floor, so every window is scanned.
    const { provider: withAgent } = fakeRegistry([{ from: ZERO, to: OWNER, agentId: 7, block: 900 }], 1_250);
    const progress: Array<[number, number]> = [];
    await client(withAgent, 1_000).findOwnedAgentIds(OWNER, { chunkBlocks: 100, onProgress: (down, floor) => progress.push([down, floor]) });
    expect(progress).toEqual([[1_151, 1_000], [1_051, 1_000], [1_000, 1_000]]);
  });

  it('bounds the scan by a lookback when the deploy block is unknown', async () => {
    const { provider, ranges } = fakeRegistry([{ from: ZERO, to: OWNER, agentId: 7, block: 10 }], 5_000);
    expect(await client(provider).findOwnedAgentIds(OWNER, { chunkBlocks: 1_000, maxLookbackBlocks: 2_000 })).toEqual([]);
    expect(ranges.at(-1)?.[0]).toBe(3_000);
  });
});
