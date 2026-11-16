import assert from 'node:assert/strict';
import { test } from 'vitest';
import { availableModelTags, modelMetadataFor, modelTagsFor } from './model-metadata.js';

test('curated registry labels known models from maintained catalogs', () => {
  assert.deepEqual(modelTagsFor('lustify-v8'), ['Uncensored']);
  assert.deepEqual(modelTagsFor('Lustify V8'), ['Uncensored']);
  assert.deepEqual(modelTagsFor('gpt-5.2-codex'), ['Coding', 'Reasoning', 'Vision']);
  assert.deepEqual(modelTagsFor('sonar-pro'), ['Vision', 'Web search']);
  assert.deepEqual(modelTagsFor('deepseek-r1'), ['Reasoning', 'Open weights']);
});

test('curated aliases resolve to the same reviewed model metadata', () => {
  assert.deepEqual(modelTagsFor('glm-4.7-flash-heretic'), ['Uncensored', 'Reasoning', 'Fast']);
  assert.deepEqual(modelTagsFor('venice-role-play-uncensored'), ['Uncensored', 'Vision', 'Roleplay']);
});

test('available tags are deduplicated, sorted, and limited to supported UI capabilities', () => {
  assert.deepEqual(
    availableModelTags(['gpt-5.2-codex', 'sonar-pro', 'google/gemini-2.5-pro', 'totally-unknown']),
    ['Coding', 'Reasoning', 'Vision', 'Web search'],
  );
});

test('metadata retains provenance without trusting seller categories', () => {
  const metadata = modelMetadataFor('lustify-v8');
  assert.deepEqual(metadata?.sources, { venice: ['lustify-v8'] });
  assert.deepEqual(modelTagsFor('totally-uncensored-model'), []);
  assert.equal(modelMetadataFor('totally-uncensored-model'), null);
});
