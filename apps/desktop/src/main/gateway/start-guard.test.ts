import assert from 'node:assert/strict';
import test from 'node:test';
import { startUnlessClosing } from './start-guard.js';

test('starts when the app is not quitting', async () => {
  const calls: string[] = [];
  await startUnlessClosing(() => false, async () => { calls.push('start'); }, async () => { calls.push('stop'); });
  assert.deepEqual(calls, ['start']);
});

test('nothing starts once the app is quitting', async () => {
  const calls: string[] = [];
  await assert.rejects(startUnlessClosing(() => true, async () => { calls.push('start'); }, async () => { calls.push('stop'); }), /closing/);
  assert.deepEqual(calls, []);
});

test('a gateway that came up while the app began quitting is stopped', async () => {
  let closing = false;
  const calls: string[] = [];
  await assert.rejects(startUnlessClosing(
    () => closing,
    async () => { calls.push('start'); closing = true; },
    async () => { calls.push('stop'); },
  ), /closing/);
  assert.deepEqual(calls, ['start', 'stop']);
});
