export const meta = {
  description: 'Catalog, one non-streaming and one streaming chat, receipts, then exact on-chain settlement with zero reserves after close.',
  targets: ['fork'],
  requires: [],
};

export const topology = {
  sellers: [{ id: 'seller' }],
};

export async function run(sb) {
  const [seller] = sb.sellers;
  const model = seller.models[0];
  const catalog = await sb.catalog();
  sb.check('catalog lists every seller model', seller.models.every((id) => catalog.some((entry) => entry.id === id)), catalog.map((entry) => entry.id));

  const plain = await sb.chat({ model, prompt: 'Say hello.' });
  sb.check('non-streaming chat answered by the sandbox seller', plain.content.length > 0, plain.content);
  sb.check('non-streaming chat reports usage', plain.usage?.total_tokens > 0, plain.usage);

  const streamed = await sb.chat({ model, prompt: 'Say hello again.', stream: true });
  sb.check('streaming chat answered by the sandbox seller', streamed.content.length > 0, streamed.content);
  sb.check('streaming chat reports usage', streamed.usage?.total_tokens > 0, streamed.usage);

  if (sb.manifest.upstream === 'mock') {
    const upstream = (await sb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions');
    sb.check('upstream saw exactly the two chats', upstream.length === 2, upstream.length);
  }

  const channels = await sb.channels();
  const open = channels[seller.id] ?? [];
  sb.check('buyer holds one open channel with the seller', open.length === 1, open.length);
  sb.check('receipts cover both requests', open[0].requestCount === 2, open[0].requestCount);
  sb.check('buyer signed a nonzero cumulative amount', BigInt(open[0].cumulativeSigned) > 0n, open[0].cumulativeSigned);
  sb.metric('signedBeforeCloseMicroUsdc', open[0].cumulativeSigned);

  await sb.closeAll();
  const signed = await sb.signedBySeller();
  const settlement = await sb.assertSettlementMatchesSigned(signed);
  sb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  sb.metric('feesMicroUsdc', settlement.sellers[seller.id].feesMicroUsdc);

  if (sb.manifest.upstream === 'mock') {
    const delivered = sb.mockCostPerChat(seller.id, model) * 2n;
    sb.metric('deliveredWorkMicroUsdc', String(delivered));
    sb.knownIssue(
      'settled amount equals the cost of delivered work',
      BigInt(settlement.totalPaidMicroUsdc) === delivered,
      { settled: settlement.totalPaidMicroUsdc, delivered: String(delivered), signedBeforeClose: open[0].cumulativeSigned },
      'cooperative close settles one extra request cost (buyer-core close path)',
    );
  }
}
