import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBarHeights } from './bottom-notice-height.js';

test('the layout keeps room for a bar still showing after another goes', () => {
  const written: Array<number | null> = [];
  const bars = createBarHeights((height) => written.push(height));
  const update = {};
  const deposit = {};
  bars.set(update, 48);
  bars.set(deposit, 64);
  bars.remove(deposit);
  assert.equal(written.at(-1), 48);
  bars.remove(update);
  assert.equal(written.at(-1), null);
});
