import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeEach } from './remove-all.js';

test('a failure on one app still removes the others, and is reported', () => {
  const removed: string[] = [];
  const failed: string[] = [];
  removeEach(['a', 'b', 'c'], (item) => {
    if (item === 'b') throw new Error('read-only');
    removed.push(item);
  }, (item) => failed.push(item));
  assert.deepEqual(removed, ['a', 'c']);
  assert.deepEqual(failed, ['b']);
});
