import assert from 'node:assert/strict';
import test from 'node:test';
import { setUpTurnConversation } from './conversation-setup.js';
import { TurnSlot } from './turn-slot.js';

type Turn = { cancelled: boolean; name: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

test('a turn cancelled by /new never replaces the conversation a newer turn saved', async () => {
  const slot = new TurnSlot<Turn>();
  const saved: { active: string | null } = { active: null };
  const creations = new Map<string, ReturnType<typeof deferred<{ id: string }>>>();
  const remembered: string[] = [];
  const createCalls: string[] = [];
  const setUp = (turn: Turn, id: string) => {
    const creation = deferred<{ id: string }>();
    creations.set(id, creation);
    return setUpTurnConversation({
      active: () => saved.active,
      exists: async () => false,
      prepareExisting: async () => undefined,
      resolveModel: async () => 'model-a',
      create: () => { createCalls.push(id); return creation.promise; },
      saveActive: async (conversationId) => { saved.active = conversationId; },
      owns: () => slot.owns(turn),
      remember: (conversationId) => { remembered.push(conversationId); },
    });
  };

  const turnA: Turn = { cancelled: false, name: 'A' };
  assert.equal(slot.reserve(turnA), true);
  const setupA = setUp(turnA, 'conv-a');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(createCalls, ['conv-a'], 'A is creating its conversation');
  // /new while A's conversation is still being created.
  slot.cancel();
  saved.active = null;

  const turnB: Turn = { cancelled: false, name: 'B' };
  assert.equal(slot.reserve(turnB), true);
  const setupB = setUp(turnB, 'conv-b');
  await new Promise((resolve) => setTimeout(resolve, 0));
  creations.get('conv-b')!.resolve({ id: 'conv-b' });
  assert.equal(await setupB, 'conv-b');
  assert.equal(saved.active, 'conv-b');

  // A's creation finishes last.
  creations.get('conv-a')!.resolve({ id: 'conv-a' });
  assert.equal(await setupA, null, 'the cancelled turn gets no conversation');
  assert.equal(saved.active, 'conv-b', 'the next message continues B');
  assert.deepEqual(remembered.sort(), ['conv-a', 'conv-b'], 'both stay listed as the bot\'s');
});

test('a turn that keeps the slot reuses the saved conversation while it exists', async () => {
  const slot = new TurnSlot<Turn>();
  const turn: Turn = { cancelled: false, name: 'A' };
  slot.reserve(turn);
  const prepared: string[] = [];
  const id = await setUpTurnConversation({
    active: () => 'conv-x',
    exists: async () => true,
    prepareExisting: async (conversationId) => { prepared.push(conversationId); },
    resolveModel: async () => { throw new Error('not needed'); },
    create: async () => { throw new Error('not needed'); },
    saveActive: async () => { throw new Error('not needed'); },
    owns: () => slot.owns(turn),
    remember: () => undefined,
  });
  assert.equal(id, 'conv-x');
  assert.deepEqual(prepared, ['conv-x']);
});
