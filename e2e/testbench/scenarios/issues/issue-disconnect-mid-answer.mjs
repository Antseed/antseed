// The buyer stops while an answer is still streaming, with nothing signed on the channel yet. The client cuts its
// request off through the proxy and the buyer process stops, the way a user reaches this. When the buyer comes back it
// pays for that answer on the same channel before it is served again, and the oracle finds every delivered answer
// paid exactly.
import { join } from 'node:path';
import { randomTag } from '../../lib/prng.mjs';
import { channelRows, runAll, STRESS_MODEL, stressTopology } from '../../lib/stress.mjs';

export const meta = {
  description: 'The buyer stops mid-answer before signing anything. The seller records the answer on the channel, the restarted buyer pays for it on that same channel before it is served again, and the payment oracle finds the delivered work paid exactly.',
  targets: ['local', 'fork'],
  requires: ['buyerControl', 'mockControl'],
};

// Long enough for the client to cut the stream and the buyer to stop while the upstream is still answering.
export const topology = stressTopology({ seller: { mock: { latencyRangeMs: [20_000, 20_000], outTokens: [400, 400] } } });

export async function run(tb) {
  const [seller] = tb.sellers;
  const sellerRows = () => channelRows(join(tb.manifest.dir, 'sellers', seller.id), 'seller');
  const buyerRows = () => channelRows(tb.manifest.buyerDir, 'buyer');
  const delivery = async (tag) => (await tb.deliveries(seller.id)).byTag[tag];
  const random = tb.prng('disconnect-mid-answer');
  const cutTag = `cut-${randomTag(random, 8)}`;
  const nextTag = `next-${randomTag(random, 8)}`;

  const before = await tb.paymentSnapshot();
  tb.check('scenario starts on a fresh testbench', before.channels.open.length === 0 && before.channels.closed.length === 0, before.channels);

  // The first paid request opens the channel, so nothing is signed on it until this answer ends.
  const controller = new AbortController();
  const response = await fetch(`${tb.proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ model: STRESS_MODEL, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: `[req:${cutTag}] tell me a long story` }] }),
  });
  tb.check('the answer started streaming', response.status === 200, response.status);
  const firstBytes = await response.body.getReader().read();
  tb.check('the client received part of the answer', !firstBytes.done && firstBytes.value.length > 0, { done: firstBytes.done });

  controller.abort();
  await tb.stopBuyer();
  let channelId;
  let cutCost;
  try {
    const whenStopped = await delivery(cutTag);
    tb.check('the upstream was still answering when the buyer stopped', whenStopped?.started === true && whenStopped.status === 'pending', whenStopped);
    const signedRows = buyerRows();
    tb.check('nothing was signed when the buyer stopped', signedRows.length === 1 && BigInt(signedRows[0].auth_max) === 0n, signedRows);
    channelId = signedRows[0].session_id;

    await tb.waitFor(async () => (await delivery(cutTag))?.status === 'ok', 'the upstream finishing the answer', { timeoutMs: 60_000 });
    cutCost = BigInt((await delivery(cutTag)).cost);
    // The seller records the answer just after the upstream ends.
    await tb.waitFor(() => BigInt(sellerRows()[0]?.tokens_delivered ?? '0') > 0n, 'the seller recording the answer', { timeoutMs: 10_000 }).catch(() => null);
    const recorded = sellerRows();
    tb.check('the seller recorded the delivered answer on the channel', recorded.length === 1 && BigInt(recorded[0].tokens_delivered) === cutCost && recorded[0].status === 'active', { recorded, delivered: String(cutCost) });
  } finally {
    await tb.startBuyer();
  }

  const next = await tb.chat({ model: STRESS_MODEL, prompt: `[req:${nextTag}] and one more` });
  tb.check('the buyer is served again after it comes back', next.content.length > 0, next.content);

  const nextCost = BigInt((await delivery(nextTag)).cost);
  const delivered = cutCost + nextCost;
  const channels = await tb.waitForPaidChannels(seller.id, { requests: 1, signed: delivered });
  tb.check('the buyer stayed on the same channel', channels.length === 1 && channels[0].channelId === channelId, channels.map((channel) => channel.channelId));
  tb.check('the buyer signed exactly both delivered answers', BigInt(channels[0].cumulativeSigned) === delivered, { signed: channels[0].cumulativeSigned, delivered: String(delivered) });
  tb.metric('cutOffAnswerMicroUsdc', String(cutCost));
  tb.metric('deliveredMicroUsdc', String(delivered));

  await runAll([
    () => tb.assertDeliveredWorkPaid({ before, results: [{ tag: cutTag, clientAborted: true }, { tag: nextTag }] }),
    () => tb.assertNoCrashes(),
  ]);
}
