import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { StudioProjectSummary } from '../../../shared/studio.js';
import { openConversationWhereItBelongs, holdSend, studioProjectForConversation, type ConversationRoute } from './open-project';

const project = (id: string, conversationId: string | null) => ({ id, conversationId }) as StudioProjectSummary;

test('a Studio project\'s chat is found by its conversation, so the sidebar opens it in Studio', () => {
  const projects = [project('harbor-film', 'conv-1'), project('empty', null)];
  assert.equal(studioProjectForConversation(projects, 'conv-1'), 'harbor-film');
  assert.equal(studioProjectForConversation(projects, 'conv-2'), null);
  assert.equal(studioProjectForConversation(null, 'conv-1'), null);
});

function route(known: StudioProjectSummary[] | null, current = () => true) {
  const calls: string[] = [];
  let finish: (projects: StudioProjectSummary[] | null) => void = () => {};
  const value: ConversationRoute = {
    known,
    reload: () => new Promise((resolve) => { calls.push('reload'); finish = resolve; }),
    current,
    activate: (id) => calls.push(`activate ${id}`),
    openProject: (id) => calls.push(`project ${id}`),
    selectView: (view) => calls.push(`view ${view}`),
  };
  return { value, calls, finish: (projects: StudioProjectSummary[] | null) => finish(projects) };
}

test('a chat picked in the sidebar becomes active only once it is known whether it belongs to a Studio project', async () => {
  const plain = route([project('harbor-film', 'conv-1')]);
  const opening = openConversationWhereItBelongs('conv-2', plain.value);
  await Promise.resolve();
  assert.deepEqual(plain.calls, ['reload'], 'the project on screen keeps its own chat while the list is read');
  plain.finish([project('harbor-film', 'conv-1')]);
  await opening;
  assert.deepEqual(plain.calls, ['reload', 'activate conv-2', 'view chat']);

  const newer = route([project('harbor-film', 'conv-1')]);
  await openConversationWhereItBelongs('conv-1', newer.value);
  assert.deepEqual(newer.calls, ['project harbor-film', 'activate conv-1', 'view studio']);

  let latest = true;
  const dropped = route(null, () => latest);
  const pending = openConversationWhereItBelongs('conv-3', dropped.value);
  latest = false;
  dropped.finish([project('later', 'conv-3')]);
  await pending;
  assert.deepEqual(dropped.calls, ['reload'], 'a newer choice made meanwhile wins');
});

test('a clip request waiting on its edit goes to the chat it was asked in, or nowhere', () => {
  const sent: string[] = [];
  let where: string | null | false = 'conv-a';
  const held = holdSend(() => where, (text) => sent.push(text));
  assert.equal(held.still(), true);
  where = 'conv-b';
  assert.equal(held.still(), false);
  held.send('remake clip 2');
  assert.deepEqual(sent, [], 'another chat opened meanwhile');

  where = null;
  const draft = holdSend(() => where, (text) => sent.push(text));
  where = false;
  draft.send('remake clip 3');
  assert.deepEqual(sent, [], 'the project left the screen meanwhile');

  where = 'conv-a';
  const stayed = holdSend(() => where, (text) => sent.push(text));
  stayed.send('remake clip 4');
  assert.deepEqual(sent, ['remake clip 4']);

  where = false;
  const hidden = holdSend(() => where, (text) => sent.push(text));
  where = 'conv-a';
  hidden.send('remake clip 5');
  assert.deepEqual(sent, ['remake clip 4'], 'a request started off screen is not sent');
});
