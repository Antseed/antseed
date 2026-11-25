import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishKeyWithPolicy } from './key-with-policy.js';

test('a key whose policy fails is revoked and never saved', async () => {
  const saved: string[] = [];
  const revoked: string[] = [];
  await assert.rejects(publishKeyWithPolicy({
    create: async () => 'key',
    applyPolicy: async () => { throw new Error('policy write failed'); },
    revoke: async (key) => { revoked.push(key); },
    save: (key) => saved.push(key),
  }), /policy write failed/);
  assert.deepEqual(saved, []);
  assert.deepEqual(revoked, ['key']);
});

test('a failed revoke still reports the policy failure', async () => {
  await assert.rejects(publishKeyWithPolicy({
    create: async () => 'key',
    applyPolicy: async () => { throw new Error('policy write failed'); },
    revoke: async () => { throw new Error('revoke failed'); },
    save: () => {},
  }), /policy write failed/);
});

test('the key is saved only after its policy is on', async () => {
  const order: string[] = [];
  const key = await publishKeyWithPolicy({
    create: async () => 'key',
    applyPolicy: async () => { order.push('policy'); },
    revoke: async () => {},
    save: () => order.push('save'),
  });
  assert.equal(key, 'key');
  assert.deepEqual(order, ['policy', 'save']);
});
