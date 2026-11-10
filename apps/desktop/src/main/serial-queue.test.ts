import assert from 'node:assert/strict';
import test from 'node:test';
import { createSerialQueue } from './serial-queue.js';

test('a later task waits for the earlier one, so the last choice wins', async () => {
  const queue = createSerialQueue();
  const finished: string[] = [];
  let release: () => void = () => undefined;
  const first = queue.run(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    finished.push('private');
  });
  const second = queue.run(async () => { finished.push('anonymous'); });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(finished, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(finished, ['private', 'anonymous']);
});

test('a failed task does not stop the next, and settling never rejects', async () => {
  const queue = createSerialQueue();
  await assert.rejects(queue.run(async () => { throw new Error('nope'); }), /nope/);
  await queue.whenSettled();
  assert.equal(await queue.run(async () => 'ok'), 'ok');
});
