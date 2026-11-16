import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, type AbstractProvider } from 'ethers';
import { recordChannelAfterTransaction } from './channel-withdraw.js';

test('after its own close request, the command stores the channel as read at the head block', async () => {
  const channels = new Interface(['function channels(bytes32) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)']);
  const id = `0x${'ab'.repeat(32)}`;
  const tags: unknown[] = [];
  // A chain without Multicall3: every read is a plain eth_call at the block it names.
  const provider = {
    getBlockNumber: async () => 77,
    getCode: async () => '0x',
    call: async ({ blockTag }: { blockTag?: unknown }) => {
      tags.push(blockTag);
      return channels.encodeFunctionResult('channels', [`0x${'b1'.repeat(20)}`, `0x${'51'.repeat(20)}`, 1_000_000n, 250_000n, `0x${'00'.repeat(32)}`, 0n, 0n, 1_800_000_000n, 1]);
    },
  } as unknown as AbstractProvider;
  const stored: unknown[] = [];
  const recorded = await recordChannelAfterTransaction({
    provider, channelsAddress: `0x${'c1'.repeat(20)}`, channelId: id, seller: `0x${'51'.repeat(20)}`,
    store: { recordChainState: (channelId, record) => { stored.push([channelId, record]); return true; } },
    now: () => 5,
  });
  assert.equal(recorded, true);
  assert.deepEqual(stored, [[id, { status: 1, deposit: 1_000_000n, settled: 250_000n, closeRequestedAt: 1_800_000_000n, block: 77, readAt: 5 }]]);
  assert.ok(tags.every((tag) => tag === 77));
  // The record goes on the buyer's row for the channel, though the id was given in another case.
  const upper = `0x${'AB'.repeat(32)}`;
  const onRow: string[] = [];
  await recordChannelAfterTransaction({
    provider, channelsAddress: `0x${'c1'.repeat(20)}`, channelId: id, seller: `0x${'51'.repeat(20)}`,
    store: { recordChainState: (channelId) => { onRow.push(channelId); return true; } },
    channels: [{ sessionId: `0x${'cd'.repeat(32)}` }, { sessionId: upper }],
  });
  assert.deepEqual(onRow, [upper]);
  // An unreadable chain is left to the buyer's next read.
  const down = { ...provider, getBlockNumber: async () => { throw new Error('rpc down'); } } as unknown as AbstractProvider;
  assert.equal(await recordChannelAfterTransaction({ provider: down, channelsAddress: `0x${'c1'.repeat(20)}`, channelId: id, seller: `0x${'51'.repeat(20)}`, store: { recordChainState: () => true } }), false);
});
