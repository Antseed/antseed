import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { studioProjectChats } from './project-chat.js';
import { createStudioProject, getStudioProjectSummary } from './store.js';

test('two first-chat requests that overlap get one chat, the one the project keeps', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { id } = await createStudioProject('Lighthouse', root);
  const made: string[] = [];
  const engine = {
    hasConversation: async (conversationId: string) => made.includes(conversationId),
    // Slow enough that the second request arrives while the first chat is still being made.
    createConversation: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const conversation = { id: `chat-${String(made.length + 1)}` };
      made.push(conversation.id);
      return conversation as never;
    },
  };
  const chat = studioProjectChats(engine, root);
  const [first, second] = await Promise.all([chat(id, 'example-model'), chat(id, 'example-model')]);
  assert.deepEqual(made, ['chat-1']);
  assert.deepEqual(first, { ok: true, conversationId: 'chat-1' });
  assert.deepEqual(second, { ok: true, conversationId: 'chat-1' });
  assert.equal((await getStudioProjectSummary(id, root))!.conversationId, 'chat-1');
  assert.deepEqual(await chat('missing', 'example-model'), { ok: false, error: 'Project not found.' });
});
