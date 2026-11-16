import { describe, expect, it } from 'vitest';
import { AbiCoder, Interface, type AbstractProvider } from 'ethers';
import { createChannelChainReader, readChannelStatesAt } from '../src/payments/channel-chain-record.js';

const CANONICAL = `0x${'c1'.repeat(20)}`;
const UNDERLYING = `0x${'c2'.repeat(20)}`;
const FACADE = `0x${'f1'.repeat(20)}`;
const PLAIN_SELLER = `0x${'51'.repeat(20)}`;
const DEPOSITS = `0x${'d1'.repeat(20)}`;
const BUYER = `0x${'b1'.repeat(20)}`;
const CHANNELS = new Interface(['function channels(bytes32) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)']);
const PROBE = new Interface(['function channelsAddress() view returns (address)']);
const DEPOSITS_ABI = new Interface(['function getBuyerBalance(address buyer) view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)']);
const id = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

const MULTICALL3 = new Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)']);
const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';

/**
 * A chain this fake answers, without Multicall3 unless `multicall` (then
 * every read goes through `aggregate3`); it records the block each call asked
 * for and each Multicall3 probe.
 */
function fakeProvider(records: Record<string, Record<string, { deposit: bigint; status: number }>>, opts: { probeFails?: boolean; underlyingReverts?: boolean; head?: number; reserveFails?: boolean; multicall?: boolean } = {}) {
  const blockTags: unknown[] = [];
  const probes: unknown[] = [];
  const answer = async ({ to, data }: { to: string; data: string }): Promise<string> => {
    const target = to.toLowerCase();
    if (target === DEPOSITS) {
      if (opts.reserveFails) throw new Error('rpc timeout');
      return DEPOSITS_ABI.encodeFunctionResult('getBuyerBalance', [5_000_000n, 1_750_000n, 0n]);
    }
    if (data.startsWith(PROBE.getFunction('channelsAddress')!.selector)) {
      if (opts.probeFails) throw new Error('rpc timeout');
      return target === FACADE ? AbiCoder.defaultAbiCoder().encode(['address'], [UNDERLYING]) : '0x';
    }
    if (opts.underlyingReverts && target === UNDERLYING) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x' });
    const [channelId] = CHANNELS.decodeFunctionData('channels', data);
    const record = records[target]?.[channelId as string] ?? { deposit: 0n, status: 0 };
    return CHANNELS.encodeFunctionResult('channels', [BUYER, FACADE, record.deposit, 0n, `0x${'00'.repeat(32)}`, 0n, 0n, 0n, record.status]);
  };
  const provider = {
    getBlockNumber: async () => opts.head ?? 0,
    getCode: async (address: string, blockTag?: unknown) => {
      probes.push(blockTag);
      return opts.multicall && address.toLowerCase() === MULTICALL3_ADDRESS ? '0x6080' : '0x';
    },
    call: async ({ to, data, blockTag }: { to: string; data: string; blockTag?: unknown }) => {
      blockTags.push(blockTag);
      if (to.toLowerCase() !== MULTICALL3_ADDRESS) return answer({ to, data });
      const [calls] = MULTICALL3.decodeFunctionData('aggregate3', data);
      const results = [];
      for (const call of calls as Array<{ target: string; callData: string }>) {
        try {
          results.push({ success: true, returnData: await answer({ to: call.target, data: call.callData }) });
        } catch {
          results.push({ success: false, returnData: '0x' });
        }
      }
      return MULTICALL3.encodeFunctionResult('aggregate3', [results]);
    },
  } as unknown as AbstractProvider;
  return { provider, blockTags, probes };
}

describe('reading channel records', () => {
  it('reads a channel missing on the canonical contract behind its seller facade', async () => {
    const { provider } = fakeProvider({ [CANONICAL]: { [id(1)]: { deposit: 5n, status: 1 } }, [UNDERLYING]: { [id(2)]: { deposit: 7n, status: 1 } } });
    const sellers = new Map([[id(2), FACADE], [id(3), PLAIN_SELLER]]);
    const states = await readChannelStatesAt(provider, CANONICAL, [id(1), id(2), id(3)], sellers);
    expect(states.get(id(1))?.status).toBe(1);
    // Active on the facade's channels contract, so not missing.
    expect([states.get(id(2))?.status, states.get(id(2))?.deposit]).toEqual([1, 7n]);
    // A plain seller has no other contract: the record really is missing.
    expect(states.get(id(3))?.status).toBe(0);
  });

  it('leaves out a missing channel whose facade could not be checked', async () => {
    const { provider } = fakeProvider({}, { probeFails: true });
    expect((await readChannelStatesAt(provider, CANONICAL, [id(2)], new Map([[id(2), FACADE]]))).has(id(2))).toBe(false);
  });

  it('leaves out a facade channel its own contract could not read', async () => {
    const { provider } = fakeProvider({}, { underlyingReverts: true });
    expect((await readChannelStatesAt(provider, CANONICAL, [id(2)], new Map([[id(2), FACADE]]))).has(id(2))).toBe(false);
  });

  it('reads every channel and the reserve at the block it read first, and says which', async () => {
    const { provider, blockTags } = fakeProvider({ [CANONICAL]: { [id(1)]: { deposit: 1_000_000n, status: 1 } } }, { head: 4242 });
    const read = await createChannelChainReader({ provider, channelsAddress: CANONICAL, depositsAddress: DEPOSITS, now: () => 7 })(BUYER, [{ channelId: id(1), seller: PLAIN_SELLER }]);
    expect(read.block).toBe(4242);
    expect(read.readAt).toBe(7);
    expect(read.reserved).toBe(1_750_000n);
    expect(read.channels.get(id(1))).toEqual({ status: 1, deposit: 1_000_000n, settled: 0n, closeRequestedAt: 0n });
    expect(blockTags.length).toBeGreaterThan(0);
    expect(blockTags.every((tag) => tag === 4242)).toBe(true);
  });

  it('asks whether Multicall3 is deployed once, not on every read', async () => {
    const { provider, blockTags, probes } = fakeProvider({ [CANONICAL]: { [id(1)]: { deposit: 1_000_000n, status: 1 } } }, { head: 4242, multicall: true });
    const read = createChannelChainReader({ provider, channelsAddress: CANONICAL, depositsAddress: DEPOSITS });
    const first = await read(BUYER, [{ channelId: id(1), seller: PLAIN_SELLER }]);
    const second = await read(BUYER, [{ channelId: id(1), seller: PLAIN_SELLER }]);
    expect([first.reserved, second.reserved, second.channels.get(id(1))?.deposit]).toEqual([1_750_000n, 1_750_000n, 1_000_000n]);
    expect(probes).toHaveLength(1);
    // Each read is one Multicall3 call for the channels and one for the reserve, at the block it read first.
    expect(blockTags).toEqual([4242, 4242, 4242, 4242]);
  });

  it('survives an unreadable reserve', async () => {
    const { provider } = fakeProvider({ [CANONICAL]: { [id(1)]: { deposit: 1_000_000n, status: 1 } } }, { head: 9, reserveFails: true });
    const read = await createChannelChainReader({ provider, channelsAddress: CANONICAL, depositsAddress: DEPOSITS })(BUYER, [{ channelId: id(1), seller: PLAIN_SELLER }]);
    expect(read.reserved).toBeNull();
    expect(read.channels.get(id(1))?.status).toBe(1);
  });
});
