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
