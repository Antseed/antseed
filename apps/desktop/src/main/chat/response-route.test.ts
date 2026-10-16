import assert from 'node:assert/strict';
import test from 'node:test';
import { RESPONSE_ROUTE_ENTRY, restoreResponseRoutes } from './response-route.js';
import type { AiChatMessage } from './conversation-types.js';
import { mergeAssistantMessagesForUi } from './message-projection.js';
import { convertPiMessagesToUi, toUsage } from './message-projection.js';
import { SessionManager } from '@mariozechner/pi-coding-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message } from '@mariozechner/pi-ai';

test('persisted response routes restore the model per reply, not the current chat model', () => {
  const messages: AiChatMessage[] = [
    { role: 'assistant', content: 'First', createdAt: 100, meta: { service: 'antseed', outputTokens: 12 } },
    { role: 'assistant', content: 'Second', createdAt: 200, meta: { service: 'antseed' } },
    { role: 'user', content: 'Hello', createdAt: 100 },
  ];
  const restored = restoreResponseRoutes(messages, [
    { type: 'custom', customType: RESPONSE_ROUTE_ENTRY, data: { createdAt: 100, service: 'model-a', peerId: 'peer-a' } },
    { type: 'custom', customType: RESPONSE_ROUTE_ENTRY, data: { createdAt: 200, service: 'model-b', peerId: 'peer-b' } },
    { type: 'custom', customType: RESPONSE_ROUTE_ENTRY, data: { createdAt: 100, service: null, peerId: 'invalid' } },
  ]);
  assert.equal(restored[0]!.meta!.service, 'model-a');
  assert.equal(restored[0]!.meta!.outputTokens, 12);
  assert.equal(restored[1]!.meta!.service, 'model-b');
  assert.equal(restored[2], messages[2]);
  assert.equal(messages[0]!.meta!.service, 'antseed');
});

test('the final model survives merging a multi-step assistant turn after reload', () => {
  const messages: AiChatMessage[] = [
    { role: 'assistant', content: 'Planning', createdAt: 100, meta: { service: 'antseed' } },
    { role: 'assistant', content: 'Final response', createdAt: 200, meta: { service: 'antseed' } },
  ];
  const restored = restoreResponseRoutes(messages, [{ type: 'custom', customType: RESPONSE_ROUTE_ENTRY,
    data: { createdAt: 200, service: 'model-b', peerId: 'peer-b' } }]);
  const merged = mergeAssistantMessagesForUi(restored[0]!, restored[1]!);
  assert.equal(merged.createdAt, 100);
  assert.equal(merged.meta!.service, 'model-b');
});

test('response-model indicators survive closing and reopening the on-disk session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-response-route-'));
  try {
    const manager = SessionManager.create(directory, directory);
    for (const [timestamp, service] of [[100, 'model-a'], [200, 'model-b']] as const) {
      manager.appendMessage({ role: 'user', content: 'Hello', timestamp: timestamp - 1 });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Reply' }],
        api: 'openai-completions', provider: 'antseed', model: 'antseed', usage: toUsage({}), stopReason: 'stop', timestamp });
      manager.appendCustomEntry(RESPONSE_ROUTE_ENTRY, { createdAt: timestamp, service, peerId: 'peer-a' });
    }
    const reopened = SessionManager.open(manager.getSessionFile()!, directory);
    const messages = restoreResponseRoutes(convertPiMessagesToUi(reopened.buildSessionContext().messages as Message[]), reopened.getBranch());
    assert.deepEqual(messages.filter((message) => message.role === 'assistant').map((message) => message.meta?.service), ['model-a', 'model-b']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
