import assert from 'node:assert/strict';
import test from 'node:test';
import { passPrivacyGate, PRIVATE_REQUIRED_ERROR } from './privacy-gate.js';

test('a request waits for a privacy switch before reading the mode it goes out under', async () => {
  let mode: 'anonymous' | 'private' = 'anonymous';
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const passing = passPrivacyGate({ whenSettled: () => settled, mode: () => mode }, true);
  mode = 'private';
  settle();
  assert.equal(await passing, null);
});

test('a request that needs Private is refused once Private is off, and others go', async () => {
  const anonymous = { whenSettled: async () => undefined, mode: () => 'anonymous' as const };
  assert.equal(await passPrivacyGate(anonymous, true), PRIVATE_REQUIRED_ERROR);
  assert.equal(await passPrivacyGate(anonymous, false), null);
  assert.equal(await passPrivacyGate({ whenSettled: async () => undefined, mode: () => null }, true), null);
  assert.equal(await passPrivacyGate(undefined, true), null);
});
