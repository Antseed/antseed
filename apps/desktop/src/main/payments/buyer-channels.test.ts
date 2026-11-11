import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyChannelOnChainSnapshot,
  normalizePaymentChannelSummary,
  requestCooperativeChannelCloseAtPort,
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
