// An upstream may write its SSE lines with no space after the colon (`data:{...}`): the standard makes the space
// optional. A client whose request is translated reads the same answer from such a stream, and what settles is the
// cost of the answers the upstream served.
import { MOCK_USAGE } from '../../lib/mock.mjs';
import { runAll } from '../../lib/stress.mjs';
import { parseSse } from '../../lib/tb.mjs';

export const meta = {
  description: 'An upstream that writes SSE with no space after the colon: Messages and Responses clients, translated from Chat Completions, read the whole answer, and what settles is exactly the cost of the answers served.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = {
  mode: 'cli',
  sellers: [{ id: 'seller', mock: { compactSse: true } }],
};

const MESSAGES = [{ role: 'user', content: 'Say hello.' }];

/** The complete frames of a translated stream, which the adapter writes with the space: each one's `event:` name and JSON. */
function translatedFrames(text) {
  return text.split('\n\n')
    .slice(0, -1)
    .filter((block) => block.length > 0 && block !== 'data: [DONE]')
    .map((block) => {
      const [, name, data] = /^(?:event: (.*)\n)?data: (.*)$/.exec(block);
      return { name, event: JSON.parse(data) };
    });
}

const everyFrameNamed = (frames) => frames.length > 0 && frames.every(({ name, event }) => typeof name === 'string' && name.length > 0 && name === event.type);

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const cost = tb.mockCostPerChat(seller.id, model);
  const answer = `Hello from testbench seller ${seller.id} (${model}).`;
  const served = async () => (await tb.mockRequests(seller.id)).filter((entry) => entry.path === '/v1/chat/completions');

  const before = { chats: (await served()).length, channels: ((await tb.channels())[seller.id] ?? []).length };
  tb.check('scenario starts on a fresh testbench (no chats, no open channel)', before.chats === 0 && before.channels === 0, before);

  // A Chat Completions client is not translated, so this one shows what the upstream wrote.
  const native = await tb.request('/v1/chat/completions', { stream: true, body: { model, messages: MESSAGES, stream: true, stream_options: { include_usage: true } } });
  const messages = await tb.request('/v1/messages', { stream: true, body: { model, messages: MESSAGES, stream: true, max_tokens: 64 } });
  const responses = await tb.request('/v1/responses', { stream: true, body: { model, input: 'Say hello.', stream: true } });
  const replies = [native, messages, responses].map((reply) => ({ status: reply.status, type: reply.headers['content-type'] }));
  tb.check('all three requests were answered with an event stream', replies.every((reply) => reply.status === 200 && reply.type?.includes('text/event-stream')), replies);

  const nativeLines = native.text.split('\n').filter((line) => line.length > 0);
  tb.check('the upstream wrote its SSE lines with no space after the colon', nativeLines.length > 0 && nativeLines.every((line) => line.startsWith('data:') && !line.startsWith('data: ')), native.text.slice(0, 300));
  const nativeAnswer = parseSse(native.text);
  tb.check('a Chat Completions client got the whole answer as written', nativeAnswer.content === answer && nativeAnswer.done && nativeAnswer.usage?.total_tokens === MOCK_USAGE.total_tokens, nativeAnswer);
  const upstream = await served();
  const ledger = Object.values((await tb.deliveries(seller.id)).byTag);
  tb.check('the upstream streamed exactly the three answers in full', upstream.length === 3 && ledger.length === 3 && ledger.every((entry) => entry.stream === true && entry.status === 'ok'), ledger);

  // The money comes first, so a client check that fails still reports what settled.
  const delivered = 3n * cost;
  tb.metric('costPerChatMicroUsdc', String(cost));
  tb.metric('deliveredWorkMicroUsdc', String(delivered));
  const open = await tb.waitForPaidChannels(seller.id, { requests: 3, signed: delivered });
  tb.check('receipts cover the three requests', open.reduce((total, channel) => total + (channel.requestCount ?? 0), 0) === 3, open);
  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned(await tb.signedBySeller());
  tb.metric('settledMicroUsdc', settlement.totalPaidMicroUsdc);
  tb.check('settled amount equals the cost of the three answers', BigInt(settlement.totalPaidMicroUsdc) === delivered, { settled: settlement.totalPaidMicroUsdc, delivered: String(delivered) });

  const settled = settlement.totalPaidMicroUsdc;
  const messageFrames = translatedFrames(messages.text);
  const messageEvents = messageFrames.map((frame) => frame.event);
  const messageText = messageEvents.filter((event) => event.type === 'content_block_delta').map((event) => event.delta.text).join('');
  const closing = messageEvents.find((event) => event.type === 'message_delta');
  const responseFrames = translatedFrames(responses.text);
  const responseEvents = responseFrames.map((frame) => frame.event);
  const responseText = responseEvents.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('');
  const completed = responseEvents.find((event) => event.type === 'response.completed')?.response;

  // Every client's verdict is reported, even after one fails.
  await runAll([
    () => tb.check('a Messages client read the whole answer', messageText === answer, { text: messageText, answer, settled }),
    () => tb.check('a Messages client read the stop reason', closing?.delta.stop_reason === 'end_turn', closing),
    () => tb.check('a Messages client read the usage', closing?.usage.input_tokens === MOCK_USAGE.prompt_tokens && closing?.usage.output_tokens === MOCK_USAGE.completion_tokens, closing),
    () => tb.check('a Messages client read the end of the message', messageEvents.at(-1)?.type === 'message_stop', messageEvents.at(-1)),
    () => tb.check('every Messages frame carries its event name', everyFrameNamed(messageFrames), messageFrames.map((frame) => frame.name)),
    () => tb.check('a Responses client read the whole answer', responseText === answer && completed?.output_text === answer, { text: responseText, final: completed?.output_text, answer, settled }),
    () => tb.check('a Responses client read the usage', completed?.usage.input_tokens === MOCK_USAGE.prompt_tokens && completed?.usage.output_tokens === MOCK_USAGE.completion_tokens, completed?.usage),
    () => tb.check('a Responses client read a completed response', completed?.status === 'completed', completed?.status),
    () => tb.check('every Responses frame carries its event name', everyFrameNamed(responseFrames), responseFrames.map((frame) => frame.name)),
  ]);
}
