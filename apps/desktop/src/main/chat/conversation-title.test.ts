import test from 'node:test';
import assert from 'node:assert/strict';

import { generateConversationTitleWithModel } from './conversation-title.js';
import type { ChatServiceProtocol } from './gateway-model.js';

const ENDPOINT = { mode: 'local' as const, origin: 'http://127.0.0.1:8379', apiKey: 'antseed_key' };

async function titleRequestHeaders(protocol: ChatServiceProtocol): Promise<Record<string, string>> {
  const originalFetch = globalThis.fetch;
  let sent: Record<string, string> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = init?.headers as Record<string, string>;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await generateConversationTitleWithModel({ endpoint: ENDPOINT, serviceId: 'example-model', protocol, userMessage: 'hello' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return sent;
}

test('a title request over Anthropic Messages names the API version', async () => {
  assert.equal((await titleRequestHeaders('anthropic-messages'))['anthropic-version'], '2023-06-01');
});

test('a title request over an OpenAI protocol sends no Anthropic header', async () => {
  assert.equal('anthropic-version' in await titleRequestHeaders('openai-chat-completions'), false);
  assert.equal('anthropic-version' in await titleRequestHeaders('openai-responses'), false);
});
