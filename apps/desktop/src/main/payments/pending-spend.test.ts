import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChannelSpendRow } from '../billing/credits-balance.js';
import { readPendingSpend } from './pending-spend.js';
import { clearChainReads, disposeChainReads, invalidateChainReads } from './read-cache.js';

// gcTime timers would keep the test process alive.
after(() => disposeChainReads());

const ALICE = `0x${'a1'.repeat(20)}`;
const BOB = `0x${'b0'.repeat(20)}`;

/** An open channel with `signed` authorized and nothing settled. */
const open = (signed: string): ChannelSpendRow => ({ status: 'active', cumulativeSigned: signed, onChainSettled: '0' });

function source(rows: readonly ChannelSpendRow[] | null) {
  const state = { rows, calls: 0 };
  return { state, load: async () => { state.calls += 1; return state.rows; } };
}

test('pending spend is read once per freshness window and again after a channel close', async () => {
  clearChainReads();
  const channels = source([open('400000')]);
  assert.equal(await readPendingSpend(ALICE, channels.load), 400_000n);
  assert.equal(await readPendingSpend(ALICE, channels.load), 400_000n);
  assert.equal(channels.state.calls, 1);

  // The close settles the channel; the main process invalidates the chain reads.
  channels.state.rows = [];
  invalidateChainReads();
  assert.equal(await readPendingSpend(ALICE, channels.load), 0n);
  assert.equal(channels.state.calls, 2);
});

test('a pending-spend read that started before a close does not refill the cache after it', async () => {
  clearChainReads();
  let finishEarlier: ((rows: ChannelSpendRow[]) => void) | undefined;
  const earlier = readPendingSpend(ALICE, () => new Promise<ChannelSpendRow[]>((resolve) => { finishEarlier = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));

  invalidateChainReads();
  // The earlier read comes back with the channel as it was before the close.
  finishEarlier?.([open('400000')]);
  assert.equal(await earlier, 400_000n);

  const after = source([]);
  assert.equal(await readPendingSpend(ALICE, after.load), 0n);
  assert.equal(after.state.calls, 1);
});

test('each identity has its own pending spend, and an unreachable buyer falls back to that identity\'s last value', async () => {
  clearChainReads();
  assert.equal(await readPendingSpend(ALICE, source([open('400000')]).load), 400_000n);
  // Another identity is not answered from the first one's cache.
  const bob = source([open('70000')]);
  assert.equal(await readPendingSpend(BOB, bob.load), 70_000n);
  assert.equal(bob.state.calls, 1);

  // The identity changes (the cache is cleared) and the buyer proxy is down.
  clearChainReads();
  const down = source(null);
  assert.equal(await readPendingSpend(BOB, down.load), 70_000n);
  assert.equal(await readPendingSpend(ALICE, down.load), 400_000n);
  // An identity never read has no last value: nothing is pending for it, not another identity's amount.
  assert.equal(await readPendingSpend(`0x${'c0'.repeat(20)}`, down.load), 0n);
});

test('a slow buyer proxy does not hold the balance: the last value comes back and the read finishes behind it', async () => {
  clearChainReads();
  assert.equal(await readPendingSpend(ALICE, source([open('400000')]).load), 400_000n);
  clearChainReads();
  let finish: ((rows: ChannelSpendRow[]) => void) | undefined;
  const slow = () => new Promise<ChannelSpendRow[]>((resolve) => { finish = resolve; });
  assert.equal(await readPendingSpend(ALICE, slow, 10), 400_000n);
  finish?.([open('900000')]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await readPendingSpend(ALICE, async () => { throw new Error('not read again inside the window'); }), 900_000n);
});
