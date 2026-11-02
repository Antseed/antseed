export const meta = {
  description: 'Full payment lifecycle (superset of CI e2e-payment): deposit, reserve, cumulative SpendingAuth over 3 paid chats, buyer disconnect -> seller settles and closes on its own, reconnect on a fresh channel, cooperative close, exact on-chain accounting.',
  targets: ['local', 'fork'],
  requires: ['buyerControl', 'mockControl'],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

const sum = (values) => values.reduce((total, value) => total + value, 0n);

export async function run(sb) {
  const [seller] = sb.sellers;
  const model = seller.models[0];
  const chatPath = (entry) => entry.path === '/v1/chat/completions';
  const deposit = BigInt(sb.manifest.depositMicros);

  const start = await sb.buyerBalance();
  sb.check('buyer deposit is available and nothing is reserved', start.available === deposit && start.reserved === 0n, { available: String(start.available), reserved: String(start.reserved) });
  const sellerUsdcStart = await sb.usdcBalance(seller.address);

  // Phase 1: three paid chats on one channel (CI phases 5-7).
  for (const [index, stream] of [false, false, true].entries()) {
    const reply = await sb.chat({ model, prompt: `paid request ${index + 1}`, stream });
    sb.check(`paid chat ${index + 1}${stream ? ' (streaming)' : ''} answered with usage`, reply.content.length > 0 && reply.usage?.total_tokens > 0, reply.usage);
  }
  if (sb.manifest.upstream === 'mock') {
    const upstream = (await sb.mockRequests(seller.id)).filter(chatPath);
    sb.check('upstream saw exactly the three chats', upstream.length === 3, upstream.length);
  }
  const [first] = (await sb.channels())[seller.id] ?? [];
  sb.check('buyer holds one open channel with the seller', Boolean(first), first);
  sb.check('channel receipts cover all three requests', first.requestCount === 3, first.requestCount);
  const signedFirst = BigInt(first.cumulativeSigned);
  sb.check('buyer signed a nonzero cumulative SpendingAuth', signedFirst > 0n, first.cumulativeSigned);
  const reserved = await sb.buyerBalance();
  sb.check('reserve is locked on-chain while the channel is open', reserved.reserved > 0n && reserved.available + reserved.reserved === deposit, { available: String(reserved.available), reserved: String(reserved.reserved) });
  sb.metric('signedFirstChannelMicroUsdc', String(signedFirst));

  // Phase 2: buyer disappears; the seller must settle and close without buyer help (CI phase 8).
  const disconnectedAt = Date.now();
  await sb.stopBuyer();
  const settledFirst = await sb.waitFor(async () => {
    const events = (await sb.settledEvents(seller.id)).filter((event) => event.args.channelId === first.channelId);
    const balance = await sb.buyerBalance();
    return events.length > 0 && balance.reserved === 0n ? { events, balance } : null;
  }, 'seller settle-on-disconnect and reserve release', { timeoutMs: 90_000 });
  sb.metric('settleOnDisconnectMs', Date.now() - disconnectedAt);
  const paidFirst = sum(settledFirst.events.map((event) => event.args.delta));
  const feesFirst = sum(settledFirst.events.map((event) => event.args.platformFee));
  sb.check('seller settled exactly what the buyer signed before disconnecting', paidFirst === signedFirst, { settled: String(paidFirst), signed: String(signedFirst) });
  sb.check('reserve fully released after the seller closed the channel', settledFirst.balance.reserved === 0n, String(settledFirst.balance.reserved));
  sb.check('buyer available balance dropped by exactly the settled amount', settledFirst.balance.available === deposit - paidFirst, { available: String(settledFirst.balance.available), expected: String(deposit - paidFirst) });
  const sellerGain = (await sb.usdcBalance(seller.address)) - sellerUsdcStart;
  sb.check('seller USDC grew by settled amount minus platform fee', sellerGain === paidFirst - feesFirst, { gain: String(sellerGain), paid: String(paidFirst), fees: String(feesFirst) });
  if (sb.manifest.upstream === 'mock') {
    const delivered = sb.mockCostPerChat(seller.id, model) * 3n;
    sb.check('settle-on-disconnect charges exactly the delivered work', paidFirst === delivered, { settled: String(paidFirst), delivered: String(delivered) });
  }

  // Phase 3: buyer comes back and pays on a fresh channel; then a cooperative close.
  await sb.startBuyer();
  const again = await sb.chat({ model, prompt: 'paid request after reconnect' });
  sb.check('chat after reconnect answered', again.content.length > 0, again.content);
  const reopened = (await sb.channels())[seller.id] ?? [];
  sb.check('reconnect opened a new channel', reopened.length === 1 && reopened[0].channelId !== first.channelId, reopened.map((channel) => channel.channelId));
  sb.check('new channel starts its own receipts', reopened[0].requestCount === 1, reopened[0].requestCount);

  await sb.closeAll();
  const signedAll = await sb.signedBySeller();
  sb.check('signed totals span both channels', signedAll[seller.id] > signedFirst, { total: String(signedAll[seller.id]), first: String(signedFirst) });
  const settlement = await sb.assertSettlementMatchesSigned(signedAll);
  sb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  sb.metric('feesMicroUsdc', settlement.sellers[seller.id].feesMicroUsdc);
  sb.metric('settlementTransactions', settlement.transactions.length);

  if (sb.manifest.upstream === 'mock') {
    const delivered = sb.mockCostPerChat(seller.id, model);
    const secondChannel = BigInt(settlement.totalPaidMicroUsdc) - paidFirst;
    sb.knownIssue(
      'cooperative close charges exactly the delivered work',
      secondChannel === delivered,
      { settled: String(secondChannel), delivered: String(delivered) },
      'cooperative close settles one extra request cost (buyer-core close path)',
    );
  }
}
