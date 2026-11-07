export const meta = {
  description: 'Catalog, one non-streaming and one streaming chat, receipts, then exact on-chain settlement with zero reserves after close.',
  targets: ['fork', 'local'],
  requires: [],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const catalog = await tb.catalog();
  tb.check('catalog lists every seller model', seller.models.every((id) => catalog.some((entry) => entry.id === id)), catalog.map((entry) => entry.id));

  const plain = await tb.chat({ model, prompt: 'Say hello.' });
  tb.check('non-streaming chat answered by the testbench seller', plain.content.length > 0, plain.content);
  tb.check('non-streaming chat reports usage', plain.usage?.total_tokens > 0, plain.usage);
  tb.metric('chatMs', plain.latencyMs);

  const streamed = await tb.chat({ model, prompt: 'Say hello again.', stream: true });
  tb.check('streaming chat answered by the testbench seller', streamed.content.length > 0, streamed.content);
  tb.check('streaming chat reports usage', streamed.usage?.total_tokens > 0, streamed.usage);
  tb.metric('streamChatMs', streamed.latencyMs);

  if (tb.manifest.upstream === 'mock') {
    const upstream = (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions');
    tb.check('upstream saw exactly the two chats', upstream.length === 2, upstream.length);
  }

  const channels = await tb.channels();
  const open = channels[seller.id] ?? [];
  tb.check('buyer holds one open channel with the seller', open.length === 1, open.length);
  tb.check('receipts cover both requests', open[0].requestCount === 2, open[0].requestCount);
  tb.check('buyer signed a nonzero cumulative amount', BigInt(open[0].cumulativeSigned) > 0n, open[0].cumulativeSigned);
  tb.metric('signedBeforeCloseMicroUsdc', open[0].cumulativeSigned);

  await tb.closeAll();
  const signed = await tb.signedBySeller();
  const settlement = await tb.assertSettlementMatchesSigned(signed);
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  tb.metric('feesMicroUsdc', settlement.sellers[seller.id].feesMicroUsdc);

  if (tb.manifest.upstream === 'mock') {
    const delivered = tb.mockCostPerChat(seller.id, model) * 2n;
    tb.metric('deliveredWorkMicroUsdc', String(delivered));
    tb.check(
      'settled amount equals the cost of delivered work',
      BigInt(settlement.totalPaidMicroUsdc) === delivered,
      { settled: settlement.totalPaidMicroUsdc, delivered: String(delivered), signedBeforeClose: open[0].cumulativeSigned },
    );
  }
}
