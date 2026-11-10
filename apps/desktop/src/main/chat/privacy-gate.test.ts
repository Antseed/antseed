import assert from 'node:assert/strict';
import test from 'node:test';
import { passPrivacyGate, PRIVATE_REQUIRED_ERROR, requiresPrivate } from './privacy-gate.js';

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

test('a chat with replies sent in Private needs Private, whoever sends, unless the user chose to keep it in Anonymous', async () => {
  const sentPrivately = [{ meta: { privacy: 'private' } }, { meta: { privacy: 'anonymous' } }];
  // A caller that knows nothing of the history (the Telegram bridge) passes no options.
  assert.equal(requiresPrivate({}, sentPrivately), true);
  assert.equal(requiresPrivate({ allowPrivateHistory: true }, sentPrivately), false);
  assert.equal(requiresPrivate({}, [{ meta: { privacy: 'anonymous' } }, { meta: null }]), false);
  assert.equal(requiresPrivate({ requirePrivate: true }, []), true);
  // So a Telegram turn on that chat is refused once Private is off.
  const anonymous = { whenSettled: async () => undefined, mode: () => 'anonymous' as const };
  assert.equal(await passPrivacyGate(anonymous, requiresPrivate({}, sentPrivately)), PRIVATE_REQUIRED_ERROR);
});
