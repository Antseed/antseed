export const meta = {
  description: 'Two sellers with different mock latency: pinned and auto-routed chats stay inside the sandbox, per-seller settlement is exact.',
  targets: ['fork'],
  requires: ['mockControl'],
};

export const topology = {
  sellers: [
    { id: 'fast', mock: { latencyMs: 20 } },
    { id: 'slow', mock: { latencyMs: 400 } },
  ],
};

export async function run(sb) {
  const model = sb.sellers[0].models[0];
  const ours = new Set(sb.sellers.map((seller) => seller.peerId));
  const peers = await sb.peers();
  sb.check('buyer only sees sandbox sellers', peers.every((peer) => ours.has(peer.peerId)) && peers.length === sb.sellers.length, peers.map((peer) => peer.peerId));

  for (const seller of sb.sellers) {
    const reply = await sb.chat({ model, sellerId: seller.id, prompt: `Hello ${seller.id}` });
    sb.check(`pinned chat reaches ${seller.id}`, reply.content.includes(`seller ${seller.id}`), reply.content);
  }

  const autoRequests = 6;
  for (let index = 0; index < autoRequests; index += 1) await sb.chat({ model, prompt: `auto ${index}` });

  const counts = {};
  for (const seller of sb.sellers) {
    counts[seller.id] = (await sb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions').length;
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  sb.check('every request was served by a sandbox seller', total === autoRequests + sb.sellers.length, counts);
  for (const seller of sb.sellers) sb.metric(`share.${seller.id}`, (counts[seller.id] - 1) / autoRequests);

  await sb.closeAll();
  const settlement = await sb.assertSettlementMatchesSigned(await sb.signedBySeller());
  sb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
}
