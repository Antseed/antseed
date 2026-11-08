export const meta = {
  description: 'Two sellers with different mock latency: pinned and auto-routed chats stay inside the testbench, per-seller settlement is exact.',
  targets: ['fork', 'local'],
  requires: ['mockControl'],
};

export const topology = {
  sellers: [
    { id: 'fast', mock: { latencyMs: 20 } },
    { id: 'slow', mock: { latencyMs: 400 } },
  ],
};

export async function run(tb) {
  const model = tb.sellers[0].models[0];
  const ours = new Set(tb.sellers.map((seller) => seller.peerId));
  const peers = await tb.peers();
  tb.check('buyer only sees testbench sellers', peers.every((peer) => ours.has(peer.peerId)) && peers.length === tb.sellers.length, peers.map((peer) => peer.peerId));

  for (const seller of tb.sellers) {
    const reply = await tb.chat({ model, sellerId: seller.id, prompt: `Hello ${seller.id}` });
    tb.check(`pinned chat reaches ${seller.id}`, reply.content.includes(`seller ${seller.id}`), reply.content);
  }

  const autoRequests = 6;
  for (let index = 0; index < autoRequests; index += 1) await tb.chat({ model, prompt: `auto ${index}` });

  const counts = {};
  for (const seller of tb.sellers) {
    counts[seller.id] = (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions').length;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  tb.check('every request was served by a testbench seller', total === autoRequests + tb.sellers.length, counts);
  for (const seller of tb.sellers) tb.metric(`share.${seller.id}`, (counts[seller.id] - 1) / autoRequests);

  // Closing one seller's channel must not wait for, or disturb, the other seller's.
  const [closing, staying] = tb.sellers;
  const open = await tb.channels();
  tb.check('both sellers hold an open channel', open[closing.id]?.length === 1 && open[staying.id]?.length === 1, open);
  const [closingChannel] = open[closing.id];
  const [stayingChannel] = open[staying.id];
  const closed = await tb.closeChannel(closing.id);
  tb.check(`closing ${closing.id}'s channel reports it closed`, closed.results[closing.id] === 'closed', closed.results);
  const after = await tb.channels();
  tb.check(`${closing.id}'s channel is gone and ${staying.id}'s stays open`, !after[closing.id]?.length && after[staying.id]?.[0]?.channelId === stayingChannel.channelId, after);
  const closedOnChain = await tb.channelState(closingChannel.channelId);
  const stayingOnChain = await tb.channelState(stayingChannel.channelId);
  const { reserved } = await tb.buyerBalance();
  tb.check(`${closing.id}'s reserve is released and only ${staying.id}'s is still locked`, closedOnChain.status !== 1 && stayingOnChain.status === 1 && reserved > 0n && reserved <= BigInt(stayingOnChain.deposit), { closed: closedOnChain.status, staying: stayingOnChain, reserved: String(reserved) });

  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned(await tb.signedBySeller());
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
}
