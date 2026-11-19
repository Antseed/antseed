import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { StudioProjectSummary } from '../../../shared/studio.js';
import { studioProjectForConversation } from './open-project';

const project = (id: string, conversationId: string | null) => ({ id, conversationId }) as StudioProjectSummary;

test('a Studio project\'s chat is found by its conversation, so the sidebar opens it in Studio', () => {
  const projects = [project('harbor-film', 'conv-1'), project('empty', null)];
  assert.equal(studioProjectForConversation(projects, 'conv-1'), 'harbor-film');
  assert.equal(studioProjectForConversation(projects, 'conv-2'), null);
  assert.equal(studioProjectForConversation(null, 'conv-1'), null);
});
