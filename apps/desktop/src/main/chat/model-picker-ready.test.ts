import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelPickerReadyGate } from './model-picker-ready.js';

test('waiters resolve true once the first snapshot arrives', async () => {
  const gate = createModelPickerReadyGate();
  const waiting = gate.waitForReady(5_000);
  gate.markReady();
  assert.equal(await waiting, true);
});

test('waiting after the snapshot arrived resolves immediately', async () => {
  const gate = createModelPickerReadyGate();
  gate.markReady();
  assert.equal(await gate.waitForReady(5_000), true);
});

test('waiters resolve false when no snapshot arrives before the timeout', async () => {
  const gate = createModelPickerReadyGate();
  assert.equal(await gate.waitForReady(10), false);
});
