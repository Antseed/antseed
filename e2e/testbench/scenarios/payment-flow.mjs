export const meta = {
  description: 'Full payment lifecycle (superset of CI e2e-payment): deposit, reserve, cumulative SpendingAuth over 3 paid chats, buyer disconnect -> seller settles and closes on its own, reconnect on a fresh channel, cooperative close, exact on-chain accounting.',
  targets: ['local', 'fork'],
  requires: ['buyerControl', 'mockControl'],
};

// Budget: twice what one `--chain local` run measured on a developer laptop (2026-11-07; sdk mode 1019 ms, cli mode
// 526 ms). Local-machine numbers; the nightly job will set CI numbers. Checked only with --budgets.
export const topology = {
  sellers: [{ id: 'seller' }],
  budgets: { settleOnDisconnectMs: 2038 },
};

const sum = (values) => values.reduce((total, value) => total + value, 0n);

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const chatPath = (entry) => entry.path === '/v1/chat/completions';
  const deposit = BigInt(tb.manifest.depositMicros);

  const start = await tb.buyerBalance();
  tb.check('buyer deposit is available and nothing is reserved', start.available === deposit && start.reserved === 0n, { available: String(start.available), reserved: String(start.reserved) });
  const sellerUsdcStart = await tb.usdcBalance(seller.address);

  // Phase 1: three paid chats on one channel (CI phases 5-7).
  for (const [index, stream] of [false, false, true].entries()) {
    const reply = await tb.chat({ model, prompt: `paid request ${index + 1}`, stream });
    tb.check(`paid chat ${index + 1}${stream ? ' (streaming)' : ''} answered with usage`, reply.content.length > 0 && reply.usage?.total_tokens > 0, reply.usage);
  }
  if (tb.manifest.upstream === 'mock') {
    const upstream = (await tb.mockRequests(seller.id)).filter(chatPath);
    tb.check('upstream saw exactly the three chats', upstream.length === 3, upstream.length);
  }
  const [first] = (await tb.channels())[seller.id] ?? [];
  tb.check('buyer holds one open channel with the seller', Boolean(first), first);
  tb.check('channel receipts cover all three requests', first.requestCount === 3, first.requestCount);
  const signedFirst = BigInt(first.cumulativeSigned);
  tb.check('buyer signed a nonzero cumulative SpendingAuth', signedFirst > 0n, first.cumulativeSigned);
  const reserved = await tb.buyerBalance();
  tb.check('reserve is locked on-chain while the channel is open', reserved.reserved > 0n && reserved.available + reserved.reserved === deposit, { available: String(reserved.available), reserved: String(reserved.reserved) });
  tb.metric('signedFirstChannelMicroUsdc', String(signedFirst));

  // Phase 2: buyer disappears; the seller must settle and close without buyer help (CI phase 8).
  const disconnectedAt = Date.now();
  await tb.stopBuyer();
  const settledFirst = await tb.waitFor(async () => {
    const events = (await tb.settledEvents(seller.id)).filter((event) => event.args.channelId === first.channelId);
    const balance = await tb.buyerBalance();
    return events.length > 0 && balance.reserved === 0n ? { events, balance } : null;
  }, 'seller settle-on-disconnect and reserve release', { timeoutMs: 90_000 });
  const settleOnDisconnectMs = Date.now() - disconnectedAt;
  tb.metric('settleOnDisconnectMs', settleOnDisconnectMs);
  const paidFirst = sum(settledFirst.events.map((event) => event.args.delta));
  const feesFirst = sum(settledFirst.events.map((event) => event.args.platformFee));
  tb.check('seller settled exactly what the buyer signed before disconnecting', paidFirst === signedFirst, { settled: String(paidFirst), signed: String(signedFirst) });
  tb.check('reserve fully released after the seller closed the channel', settledFirst.balance.reserved === 0n, String(settledFirst.balance.reserved));
  tb.check('buyer available balance dropped by exactly the settled amount', settledFirst.balance.available === deposit - paidFirst, { available: String(settledFirst.balance.available), expected: String(deposit - paidFirst) });
  const sellerGain = (await tb.usdcBalance(seller.address)) - sellerUsdcStart;
  tb.check('seller USDC grew by settled amount minus platform fee', sellerGain === paidFirst - feesFirst, { gain: String(sellerGain), paid: String(paidFirst), fees: String(feesFirst) });
  if (tb.manifest.upstream === 'mock') {
    const delivered = tb.mockCostPerChat(seller.id, model) * 3n;
    tb.check('settle-on-disconnect charges exactly the delivered work', paidFirst === delivered, { settled: String(paidFirst), delivered: String(delivered) });
  }

  // Phase 3: buyer comes back and pays on a fresh channel; then a cooperative close.
  await tb.startBuyer();
  const again = await tb.chat({ model, prompt: 'paid request after reconnect' });
  tb.check('chat after reconnect answered', again.content.length > 0, again.content);
  const reopened = (await tb.channels())[seller.id] ?? [];
  tb.check('reconnect opened a new channel', reopened.length === 1 && reopened[0].channelId !== first.channelId, reopened.map((channel) => channel.channelId));
  tb.check('new channel starts its own receipts', reopened[0].requestCount === 1, reopened[0].requestCount);

  await tb.closeAll();
  const signedAll = await tb.signedBySeller();
  tb.check('signed totals span both channels', signedAll[seller.id] > signedFirst, { total: String(signedAll[seller.id]), first: String(signedFirst) });
  const settlement = await tb.assertSettlementMatchesSigned(signedAll);
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  tb.metric('feesMicroUsdc', settlement.sellers[seller.id].feesMicroUsdc);
  tb.metric('settlementTransactions', settlement.transactions.length);

  if (tb.manifest.upstream === 'mock') {
    const delivered = tb.mockCostPerChat(seller.id, model);
    const secondChannel = BigInt(settlement.totalPaidMicroUsdc) - paidFirst;
    tb.check(
      'cooperative close charges exactly the delivered work',
      secondChannel === delivered,
      { settled: String(secondChannel), delivered: String(delivered) },
    );
  }

  // Last, so that a budget failing under --budgets cannot hide a money check.
  tb.timings({ settleOnDisconnectMs });
}
