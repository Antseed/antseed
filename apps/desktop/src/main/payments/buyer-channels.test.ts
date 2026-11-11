import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelInfo } from '@antseed/node';
import { pendingSpendFromChannels } from '../billing/credits-balance.js';
import {
  applyChainToChannels,
  applyChannelOnChainSnapshot,
  channelEndedOnChain,
  normalizePaymentChannelSummary,
  requestCooperativeChannelCloseAtPort,
  rowsToReadAlone,
  runInBatches,
} from './buyer-channel-control.js';

function closeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('normalizePaymentChannelSummary defaults missing cooperative-close support to false', () => {
  const unsupported = normalizePaymentChannelSummary({ sessionId: 'channel-1', peerId: 'peer-1' });
  const supported = normalizePaymentChannelSummary({
    sessionId: 'channel-2',
    peerId: 'peer-2',
    cooperativeCloseSupported: true,
  });

  assert.equal(unsupported?.cooperativeCloseSupported, false);
  assert.equal(supported?.cooperativeCloseSupported, true);
});

test('normalizePaymentChannelSummary preserves proxy seller metadata and separates channel amounts', () => {
  const channel = normalizePaymentChannelSummary({
    sessionId: 'channel-1',
    peerId: 'peer-1',
    sellerDisplayName: 'Seller One',
    reserveCeiling: '5000000',
    cumulativeSigned: '700000',
  });

  assert.equal(channel?.sellerDisplayName, 'Seller One');
  assert.equal(channel?.onChainStateKnown, false);
  assert.equal(channel?.reserveCeiling, '5000000');
  assert.equal(channel?.cumulativeSigned, '700000');
  assert.equal(channel?.onChainDeposit, '0');
  assert.equal(channel?.onChainSettled, '0');
});

test('normalizePaymentChannelSummary accepts the legacy reserveMax field', () => {
  const channel = normalizePaymentChannelSummary({ sessionId: 'channel-1', reserveMax: '5000000' });
  assert.equal(channel?.reserveCeiling, '5000000');
});

test('on-chain snapshots preserve the last verified state across failed or ambiguous polls', () => {
  const firstPoll = normalizePaymentChannelSummary({ sessionId: 'channel-1', status: 'active' });
  assert.ok(firstPoll);
  applyChannelOnChainSnapshot(firstPoll, {
    status: 1,
    deposit: '1000000',
    settled: '0',
    closeRequestedAt: 0,
  });

  const failedPoll = normalizePaymentChannelSummary({ sessionId: 'channel-1', status: 'active' });
  assert.ok(failedPoll);
  applyChannelOnChainSnapshot(failedPoll);
  assert.equal(failedPoll.onChainStateKnown, true);
  assert.equal(failedPoll.onChainDeposit, '1000000');
  assert.equal(failedPoll.onChainSettled, '0');

  const ambiguousPoll = normalizePaymentChannelSummary({ sessionId: 'channel-1', status: 'active' });
  assert.ok(ambiguousPoll);
  applyChannelOnChainSnapshot(ambiguousPoll, {
    status: 0,
    deposit: '0',
    settled: '0',
    closeRequestedAt: 0,
  });
  assert.equal(ambiguousPoll.onChainStateKnown, true);
  assert.equal(ambiguousPoll.onChainDeposit, '1000000');
});

test('on-chain snapshots advance cached closing channels to withdrawable', () => {
  const row = normalizePaymentChannelSummary({ sessionId: 'channel-2', status: 'active' });
  assert.ok(row);
  applyChannelOnChainSnapshot(row, {
    status: 1,
    deposit: '1000000',
    settled: '250000',
    closeRequestedAt: 1_000,
  }, 1_100);
  assert.equal(row.status, 'closing');

  const laterPoll = normalizePaymentChannelSummary({ sessionId: 'channel-2', status: 'active' });
  assert.ok(laterPoll);
  applyChannelOnChainSnapshot(laterPoll, undefined, 1_901);
  assert.equal(laterPoll.status, 'withdrawable');
});

// The store retires a row when the buyer gives up on it, which does not close the channel.
for (const retired of ['ghost', 'settled', 'timeout']) {
  test(`a row the store calls ${retired} reads as active while the chain holds it open`, () => {
    const row = normalizePaymentChannelSummary({
      sessionId: `retired-open-${retired}`,
      status: retired,
      cooperativeCloseSupported: true,
      live: false,
    });
    assert.ok(row);

    applyChannelOnChainSnapshot(row, { status: 1, deposit: '1000000', settled: '250000', closeRequestedAt: 0 });

    assert.equal(row.status, 'active');
    assert.equal(row.onChainStateKnown, true);
    assert.equal(row.onChainDeposit, '1000000');
    assert.equal(row.onChainSettled, '250000');
    // Only the live session can be closed by its seller: the row offers the on-chain close.
    assert.equal(row.cooperativeCloseSupported, false);
  });
}

test('a retired row the chain holds open never offers the seller-assisted close, even from a buyer that predates live', () => {
  // An older buyer omits `live` and closes whatever session it holds with the seller: never the retired channel.
  const row = normalizePaymentChannelSummary({ sessionId: 'revived-older-buyer', status: 'ghost', cooperativeCloseSupported: true });
  assert.ok(row);
  assert.equal(row.cooperativeCloseSupported, true);

  applyChannelOnChainSnapshot(row, { status: 1, deposit: '1000000', settled: '0', closeRequestedAt: 0 });

  assert.equal(row.status, 'active');
  assert.equal(row.cooperativeCloseSupported, false);
});

test('a batch that misses rows reads each open one alone, and the others a few at a time in turn', () => {
  const row = (sessionId: string, status: string) => {
    const summary = normalizePaymentChannelSummary({ sessionId, status });
    assert.ok(summary);
    return summary;
  };
  const missed = [row('alone-open', 'active'), ...[0, 1, 2, 3, 4].map((index) => row(`alone-retired-${index}`, 'ghost'))];
  const ids = (picked: ReturnType<typeof rowsToReadAlone>) => picked.map((summary) => summary.channelId);

  assert.deepEqual(ids(rowsToReadAlone(missed, 2, 1_000)), ['alone-open', 'alone-retired-0', 'alone-retired-1']);
  assert.deepEqual(ids(rowsToReadAlone(missed, 2, 2_000)), ['alone-open', 'alone-retired-2', 'alone-retired-3']);
  // The longest unread comes first, so every row is reached.
  assert.deepEqual(ids(rowsToReadAlone(missed, 2, 3_000)), ['alone-open', 'alone-retired-4', 'alone-retired-0']);
});

test('a retired row stays retired when the chain has no record of it', () => {
  const row = normalizePaymentChannelSummary({ sessionId: 'retired-missing', status: 'ghost' });
  assert.ok(row);

  applyChannelOnChainSnapshot(row, { status: 0, deposit: '0', settled: '0', closeRequestedAt: 0 });

  assert.equal(row.status, 'ghost');
  assert.equal(row.onChainStateKnown, false);
});

test('a retired row keeps the ended status the chain shows', () => {
  const settled = normalizePaymentChannelSummary({ sessionId: 'retired-settled', status: 'ghost' });
  const timedOut = normalizePaymentChannelSummary({ sessionId: 'retired-timed-out', status: 'ghost' });
  assert.ok(settled && timedOut);

  applyChannelOnChainSnapshot(settled, { status: 2, deposit: '1000000', settled: '1000000', closeRequestedAt: 0 });
  applyChannelOnChainSnapshot(timedOut, { status: 3, deposit: '1000000', settled: '0', closeRequestedAt: 900 });

  assert.equal(settled.status, 'settled');
  assert.equal(timedOut.status, 'timedout');
});

function chainRecord(status: number, deposit: bigint, settled: bigint, closeRequestedAt = 0n): ChannelInfo {
  return {
    buyer: '0x' + '22'.repeat(20),
    seller: '0x' + '44'.repeat(20),
    deposit,
    settled,
    metadataHash: '0x' + '00'.repeat(32),
    deadline: 0n,
    settledAt: 0n,
    closeRequestedAt,
    status,
  };
}

test('the chain decides the status of every row it has not shown ended, whatever the store calls it', async () => {
  const anHourAgo = Date.now() - 3_600_000;
  const row = (sessionId: string, status: string, cumulativeSigned = '0') => {
    const summary = normalizePaymentChannelSummary({ sessionId, status, cumulativeSigned, updatedAt: anHourAgo });
    assert.ok(summary);
    return summary;
  };
  const rows = [
    row('decide-active', 'active', '100000'),
    row('decide-retired-open', 'ghost', '300000'),
    row('decide-retired-never-opened', 'ghost'),
    row('decide-retired-closed', 'settled', '500000'),
    row('decide-ended-earlier', 'settled', '900000'),
  ];
  applyChannelOnChainSnapshot(rows[4]!, { status: 2, deposit: '1000000', settled: '900000', closeRequestedAt: 0 });
  const asked: string[] = [];

  await applyChainToChannels(rows, async (candidates) => {
    asked.push(...candidates.map((candidate) => candidate.channelId));
    return {
      readAtMs: Date.now(),
      sessions: new Map([
        ['decide-active', chainRecord(1, 1_000_000n, 0n)],
        ['decide-retired-open', chainRecord(1, 1_000_000n, 100_000n)],
        ['decide-retired-never-opened', chainRecord(0, 0n, 0n)],
        ['decide-retired-closed', chainRecord(2, 1_000_000n, 500_000n)],
      ]),
    };
  });

  // A channel that ended is not read again; every other row is, retired or not.
  assert.deepEqual(asked, ['decide-active', 'decide-retired-open', 'decide-retired-never-opened', 'decide-retired-closed']);
  assert.deepEqual(rows.map((summary) => summary.status), ['active', 'active', 'ghost', 'settled', 'settled']);
  // The seller can still settle what was signed on the retired channel it holds open.
  assert.equal(pendingSpendFromChannels(rows), 100_000n + 200_000n);
});

test('a read from before the buyer retired a row, or just after, does not show it open', () => {
  const retiredAt = Date.now();
  const row = normalizePaymentChannelSummary({ sessionId: 'just-retired', status: 'settled', settledAmount: '400000', updatedAt: retiredAt });
  assert.ok(row);
  const open = { status: 1, deposit: '1000000', settled: '0', closeRequestedAt: 0 };

  // The read from before a seller-assisted close, and one right after it that lags the chain.
  applyChannelOnChainSnapshot(row, { ...open, readAtMs: retiredAt - 5_000 });
  assert.equal(row.status, 'settled');
  applyChannelOnChainSnapshot(row, { ...open, readAtMs: retiredAt + 2_000 });
  assert.equal(row.status, 'settled');
  assert.equal(row.onChainStateKnown, false);

  applyChannelOnChainSnapshot(row, { ...open, readAtMs: retiredAt + 60_000 });
  assert.equal(row.status, 'active');
});

test('channelEndedOnChain holds only for a channel the chain showed Settled or TimedOut', () => {
  const open = normalizePaymentChannelSummary({ sessionId: 'read-again-open', status: 'ghost' });
  const settled = normalizePaymentChannelSummary({ sessionId: 'read-again-settled', status: 'active' });
  const timedOut = normalizePaymentChannelSummary({ sessionId: 'read-again-timed-out', status: 'ghost' });
  assert.ok(open && settled && timedOut);

  applyChannelOnChainSnapshot(open, { status: 1, deposit: '1000000', settled: '0', closeRequestedAt: 0 });
  applyChannelOnChainSnapshot(settled, { status: 2, deposit: '1000000', settled: '400000', closeRequestedAt: 0 });
  applyChannelOnChainSnapshot(timedOut, { status: 3, deposit: '1000000', settled: '0', closeRequestedAt: 900 });

  assert.equal(channelEndedOnChain('read-again-open'), false);
  assert.equal(channelEndedOnChain('read-again-settled'), true);
  assert.equal(channelEndedOnChain('read-again-timed-out'), true);
  assert.equal(channelEndedOnChain('read-again-never-read'), false);
});

test('runInBatches processes active-looking channels beyond the first batch', async () => {
  const processed: number[] = [];
  await runInBatches(Array.from({ length: 14 }, (_, index) => index), 12, async (index) => {
    processed.push(index);
  });

  assert.deepEqual(processed.sort((left, right) => left - right), Array.from({ length: 14 }, (_, index) => index));
});

test('requestCooperativeChannelCloseAtPort returns a closed result', async () => {
  const fetchImpl: typeof fetch = async (_input, init) => {
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { peerId: 'peer-1', includeAuth: true });
    return closeResponse({
      ok: true,
      result: { version: 1, channelId: 'channel-1', status: 'closed', txHash: '0xtx' },
    });
  };

  const result = await requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl });
  assert.equal(result.status, 'closed');
  assert.equal(result.txHash, '0xtx');
});

test('requestCooperativeChannelCloseAtPort preserves structured rejection results', async () => {
  const fetchImpl: typeof fetch = async () => closeResponse({
    ok: true,
    result: { version: 1, channelId: 'channel-1', status: 'rejected', code: 'busy' },
  });

  const result = await requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl });
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'busy');
});

test('requestCooperativeChannelCloseAtPort reports HTTP errors', async () => {
  const fetchImpl: typeof fetch = async () => closeResponse({ ok: false, error: 'seller offline' }, 502);

  await assert.rejects(
    requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl }),
    /seller offline/,
  );
});

test('requestCooperativeChannelCloseAtPort rejects malformed success responses', async () => {
  const fetchImpl: typeof fetch = async () => closeResponse({ ok: true, result: { status: 'closed' } });

  await assert.rejects(
    requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl }),
    /invalid cooperative-close response/,
  );
});

test('requestCooperativeChannelCloseAtPort propagates timeouts', async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };

  await assert.rejects(
    requestCooperativeChannelCloseAtPort(8123, 'peer-1', { fetchImpl, timeoutMs: 1 }),
    /timeout/i,
  );
});
