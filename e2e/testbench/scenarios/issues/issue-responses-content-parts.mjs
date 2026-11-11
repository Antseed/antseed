import OpenAI from 'openai';

export const meta = {
  description: 'A client streaming POST /v1/responses from a seller that speaks only Chat Completions gets the events OpenAI sends: the message opens with empty content, its text part is added once at the next free index, the closing events carry the text, and the OpenAI SDK rebuilds the answer.',
  targets: ['local', 'fork'],
  requires: ['mockControl'],
};

export const topology = {
  mode: 'cli',
  sellers: [{ id: 'seller' }],
};

const parseEvents = (sse) => sse
  .split('\n')
  .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
  .map((line) => JSON.parse(line.slice('data: '.length)));

/** Rebuilds the output the way the SDK does: an item or part is added only at the next free index. */
function replay(events) {
  const output = [];
  const problems = [];
  for (const event of events) {
    if (event.type === 'response.output_item.added') {
      if (event.output_index !== output.length) problems.push(`item ${event.item.id} added at output_index ${event.output_index} with ${output.length} items`);
      output.push(structuredClone(event.item));
    } else if (event.type === 'response.content_part.added') {
      const item = output[event.output_index];
      if (item?.id !== event.item_id) problems.push(`part names item ${event.item_id}, output_index ${event.output_index} is ${item?.id}`);
      if (event.content_index !== item?.content?.length) problems.push(`part added at content_index ${event.content_index} with ${item?.content?.length} parts`);
      item?.content?.push(structuredClone(event.part));
    } else if (event.type === 'response.output_text.delta') {
      const part = output[event.output_index]?.content?.[event.content_index];
      if (part) part.text += event.delta;
      else problems.push(`delta for missing content_index ${event.content_index}`);
    }
  }
  return { output, problems };
}

export async function run(tb) {
  const [seller] = tb.sellers;
  const model = seller.models[0];
  const upstream = async () => (await tb.mockRequests(seller.id)).filter((entry) => entry.method === 'POST');

  const before = await upstream();
  tb.check('scenario starts on a fresh testbench (no upstream requests)', before.length === 0, before);

  // Both clients run before any check: a failed check stops the scenario, and a failing run should record both.
  const raw = await tb.request('/v1/responses', { body: { model, input: 'Say hello.', stream: true }, stream: true });
  const client = new OpenAI({ apiKey: 'testbench', baseURL: `${tb.proxyUrl}/v1`, maxRetries: 0 });
  const sdk = await client.responses.stream({ model, input: 'Say hello again.' }).finalResponse().then(
    (response) => ({ outputText: response.output_text }),
    (error) => ({ error: error.message }),
  );
  await tb.event('sdk-stream', sdk);

  tb.check('the proxy streamed the answer', raw.status === 200 && (raw.headers['content-type'] ?? '').includes('text/event-stream'), { status: raw.status, contentType: raw.headers['content-type'], body: raw.text.slice(0, 500) });
  const served = await upstream();
  tb.check('the proxy translated both requests into streamed Chat Completions', served.length === 2 && served.every((entry) => entry.path === '/v1/chat/completions' && entry.stream), served);

  const events = parseEvents(raw.text);
  const isMessage = (type) => (event) => event.type === type && event.item?.type === 'message';
  const opened = events.filter(isMessage('response.output_item.added'));
  tb.check('one message item is opened', opened.length === 1, opened);
  tb.check('the message opens with empty content', opened[0].item.content.length === 0, opened[0]);

  const { output, problems } = replay(events);
  tb.check('each item and part is added once, at the next free index', problems.length === 0, problems);

  const completed = events.at(-1);
  tb.check('the stream ends with response.completed', completed?.type === 'response.completed', completed);
  const text = completed.response.output_text;
  tb.check('the answer has text', typeof text === 'string' && text.length > 0, text);
  tb.check('the added part and its deltas rebuild the whole answer', output.length === 1 && output[0].content.length === 1 && output[0].content[0].text === text, { output, text });
  const closed = events.find(isMessage('response.output_item.done'));
  tb.check('response.output_item.done carries the text', closed?.item.content.length === 1 && closed.item.content[0].text === text, closed);
  tb.check('response.completed carries the text', completed.response.output[0]?.content.length === 1 && completed.response.output[0].content[0].text === text, completed.response.output);
  tb.check('the OpenAI SDK rebuilds the answer', sdk.outputText === text, sdk);

  const delivered = tb.mockCostPerChat(seller.id, model) * 2n;
  const open = await tb.waitForPaidChannels(seller.id, { requests: 2, signed: delivered });
  tb.check('receipts cover both answers', open.length === 1 && open[0].requestCount === 2, open);
  await tb.closeAll();
  const settlement = await tb.assertSettlementMatchesSigned(await tb.signedBySeller());
  tb.check('settled amount equals the cost of both answers', BigInt(settlement.totalPaidMicroUsdc) === delivered, { settled: settlement.totalPaidMicroUsdc, delivered: String(delivered) });
}
