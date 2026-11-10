import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPrivacyToKeys } from './privacy-keys.js';

test('Private reaches every app key before the desktop key shows it', async () => {
  const order: string[] = [];
  await applyPrivacyToKeys('private', 'desktop', ['codex', 'desktop', 'goose'], async (id) => { order.push(id); });
  assert.deepEqual(order, ['codex', 'goose', 'desktop']);
});

test('leaving Private changes the desktop key first, so a failed app key stays private', async () => {
  const order: string[] = [];
  await assert.rejects(applyPrivacyToKeys('anonymous', 'desktop', ['codex', 'goose'], async (id) => {
    if (id === 'codex') throw new Error('policy write failed');
    order.push(id);
  }), /policy write failed/);
  assert.deepEqual(order, ['desktop']);
});

test('a failed app key leaves the desktop key, and the mode shown, unchanged', async () => {
  const order: string[] = [];
  await assert.rejects(applyPrivacyToKeys('private', 'desktop', ['codex'], async (id) => {
    if (id === 'codex') throw new Error('policy write failed');
    order.push(id);
  }), /policy write failed/);
  assert.deepEqual(order, []);
});
