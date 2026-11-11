import { runAll } from '../../lib/stress.mjs';

export const meta = {
  description: 'A client whose streamed request is translated learns when the upstream is cut off mid-answer: a Messages client gets an error event and no message_stop, a Responses client gets response.failed and no response.completed, while whole answers still end normally. The mock upstream speaks only Chat Completions, so both clients go through the translation. The payment oracle then judges the money by the mock\'s delivery ledger: the whole answers paid in full, nothing beyond what reached the wire.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

// `load` usage streams an answer in pieces, so a cut lands in the middle of one, after some text has arrived.
// ANTSEED_DEBUG gives the payment oracle the seller's own cost lines to compare with the settlement.
export const topology = {
  mode: 'cli',
  sellers: [{ id: 'seller', mock: { usage: 'load', latencyRangeMs: [200, 400], outTokens: [800, 1200] }, env: { ANTSEED_DEBUG: '1' } }],
};

/** One entry per SSE block, with its JSON parsed when it has any. */
const parseFrames = (sse) => sse.split('\n\n').filter(Boolean).map((block) => {
  const lines = block.split('\n');
  const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? null;
  const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? '';
  let json = null;
  try { json = JSON.parse(data); } catch { /* [DONE] */ }
  return { event, data, json };
});
const eventNames = (frames) => frames.map((frame) => frame.event);
const tail = (frames) => eventNames(frames).slice(-4);

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const upstream = async () => (await tb.mockRequests(seller.id)).filter((entry) => entry.method === 'POST');
  const prompt = (tag) => `[req:${tag}] Say something long.`;
  const messages = (tag) => tb.request('/v1/messages', {
    stream: true,
    headers: { 'anthropic-version': '2023-06-01' },
    body: { model, max_tokens: 2000, stream: true, messages: [{ role: 'user', content: prompt(tag) }] },
  });
  const responses = (tag) => tb.request('/v1/responses', { stream: true, body: { model, stream: true, input: prompt(tag) } });

  const earlier = await upstream();
  tb.check('scenario starts on a fresh testbench (no upstream requests)', earlier.length === 0, earlier);
  const before = await tb.paymentSnapshot();

  // Every request runs before any check: a failed check stops the scenario, and a failing run should record all four.
  const wholeMessages = await messages('whole-messages');
  const wholeResponses = await responses('whole-responses');
  await tb.setMockFaults(seller.id, { disconnectRate: 1 });
  const cutMessages = await messages('cut-messages');
  const cutResponses = await responses('cut-responses');
  await tb.setMockFaults(seller.id, { disconnectRate: 0 });

  const served = await upstream();
  tb.check('the proxy translated all four requests into streamed Chat Completions', served.length === 4 && served.every((entry) => entry.path === '/v1/chat/completions' && entry.stream), served);
  const { byTag } = await tb.deliveries(seller.id);
  const statuses = Object.fromEntries(Object.entries(byTag).map(([tag, entry]) => [tag, entry.status]));
  tb.check('the mock delivered the whole answers and cut the others after it started', byTag['whole-messages']?.status === 'ok' && byTag['whole-responses']?.status === 'ok' && byTag['cut-messages']?.status === 'disconnect' && byTag['cut-messages']?.started && byTag['cut-responses']?.status === 'disconnect' && byTag['cut-responses']?.started, statuses);
  const replies = { 'the whole Messages answer': wholeMessages, 'the whole Responses answer': wholeResponses, 'the cut Messages answer': cutMessages, 'the cut Responses answer': cutResponses };
  for (const [label, reply] of Object.entries(replies)) {
    tb.check(`the proxy streamed ${label}`, reply.status === 200 && (reply.headers['content-type'] ?? '').includes('text/event-stream'), { status: reply.status, contentType: reply.headers['content-type'], body: reply.text.slice(0, 500) });
  }

  const whole = { messages: parseFrames(wholeMessages.text), responses: parseFrames(wholeResponses.text) };
  tb.check('a whole answer ends with message_stop', whole.messages.at(-1)?.event === 'message_stop', tail(whole.messages));
  const stop = whole.messages.find((frame) => frame.event === 'message_delta');
  tb.check('a whole answer reports its stop reason', stop?.json?.delta?.stop_reason === 'end_turn', stop?.data);
  tb.check('a whole answer ends with response.completed', eventNames(whole.responses).includes('response.completed') && whole.responses.at(-1)?.data === '[DONE]', tail(whole.responses));

  const cut = { messages: parseFrames(cutMessages.text), responses: parseFrames(cutResponses.text) };
  // Every verdict runs even after one fails, so a failing run records both clients and still judges the settlement.
  await runAll([
    () => {
      tb.check('the cut answer reached the Messages client before the cut', eventNames(cut.messages).includes('content_block_delta'), tail(cut.messages));
      tb.check('a cut answer reaches a Messages client as an error event', cut.messages.at(-1)?.event === 'error' && cut.messages.at(-1)?.json?.type === 'error', tail(cut.messages));
      tb.check('a cut answer never reaches a Messages client as finished', !eventNames(cut.messages).includes('message_stop'), tail(cut.messages));
    },
    () => {
      tb.check('the cut answer reached the Responses client before the cut', eventNames(cut.responses).includes('response.output_text.delta'), tail(cut.responses));
      tb.check('a cut answer reaches a Responses client as response.failed', cut.responses.at(-1)?.event === 'response.failed' && cut.responses.at(-1)?.json?.response?.status === 'failed', tail(cut.responses));
      tb.check('a cut answer never reaches a Responses client as finished', !eventNames(cut.responses).includes('response.completed') && !cut.responses.some((frame) => frame.data === '[DONE]'), tail(cut.responses));
    },
    // Payment reads the seller's raw stream, so translating the failure changes nothing it settles. The mock's ledger
    // is the judge, not what the buyer signed: the two whole answers were received in full and the cut ones were not,
    // whatever the translated stream told the client.
    () => tb.assertDeliveredWorkPaid({
      before,
      results: [{ tag: 'whole-messages' }, { tag: 'whole-responses' }, { tag: 'cut-messages', error: 'cut' }, { tag: 'cut-responses', error: 'cut' }],
      injected: { disconnectRate: 1 },
    }),
  ]);
}
