import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trackChatRun } from './served-peer.js';

// The observer wraps fetch once, so the stub it wraps stays and answers per test.
let respond: () => Response = () => new Response('{}');
globalThis.fetch = async () => respond();

const streamResponse = (body: string | ReadableStream) => new Response(body, {
  headers: { 'x-antseed-peer-id': 'abc123', 'content-type': 'text/event-stream' },
});

async function streamEnded(body: () => string | ReadableStream): Promise<boolean> {
  respond = () => streamResponse(body());
  const run = trackChatRun(() => {}, async () => { await (await fetch('http://gateway.test/')).text().catch(() => ''); });
  await run.result;
  return run.lastStreamEnded();
}

test('reports the seller for requests inside a run, and only those', async () => {
  respond = () => new Response('{}', { headers: { 'x-antseed-peer-id': 'abc123' } });
  const seen: string[] = [];
  await trackChatRun((peerId) => seen.push(peerId), async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await fetch('http://gateway.test/v1/chat/completions');
  }).result;
  await fetch('http://gateway.test/v1/models');
  assert.deepEqual(seen, ['abc123']);
});

test('reports the model the seller served with it, as a router picked it', async () => {
  respond = () => new Response('{}', { headers: { 'x-antseed-peer-id': 'abc123', 'x-antseed-service': 'glm-5.3-flash' } });
  const seen: Array<[string, string | null]> = [];
  await trackChatRun((peerId, servedModel) => seen.push([peerId, servedModel]), async () => {
    await fetch('http://gateway.test/v1/chat/completions');
  }).result;
  respond = () => new Response('{}', { headers: { 'x-antseed-peer-id': 'abc123' } });
  await trackChatRun((peerId, servedModel) => seen.push([peerId, servedModel]), async () => {
    await fetch('http://gateway.test/v1/chat/completions');
  }).result;
  assert.deepEqual(seen, [['abc123', 'glm-5.3-flash'], ['abc123', null]]);
});

for (const end of ['data: [DONE]', 'data: {"choices":[{"finish_reason":"stop"}]}', 'event: response.completed', 'event: message_stop']) {
  test(`a stream ending with ${end} reached its end`, async () => {
    assert.equal(await streamEnded(() => `data: {"text":"hi"}\n\n${end}\n\n`), true);
  });
}

test('a stream that stops early did not reach its end', async () => {
  assert.equal(await streamEnded(() => 'data: {"text":"hi"}\n\n'), false);
});

test('a stream that breaks did not reach its end', async () => {
  assert.equal(await streamEnded(() => new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"text":"hi"}\n\n'));
      controller.error(new Error('terminated'));
    },
  })), false);
});

test('an end marker split across two chunks still counts', async () => {
  assert.equal(await streamEnded(() => new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DO'));
      controller.enqueue(new TextEncoder().encode('NE]\n\n'));
      controller.close();
    },
  })), true);
});

test('end words inside the generated text do not count as the end', async () => {
  const quoting = [
    'data: {"choices":[{"delta":{"content":"the stream ends with message_stop or data: [DONE]"},"finish_reason":null}]}',
    'data: {"type":"response.output_text.delta","delta":"then response.completed arrives"}',
  ].join('\n\n');
  assert.equal(await streamEnded(() => `${quoting}\n\n`), false);
});

test('an end record in the last line without a trailing newline still counts', async () => {
  assert.equal(await streamEnded(() => 'data: {"text":"hi"}\n\ndata: [DONE]'), true);
});
