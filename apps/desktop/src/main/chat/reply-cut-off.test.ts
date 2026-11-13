import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isReplyCutOff } from './stream-stop.js';

const message = (stopReason: 'stop' | 'length', output: number, text = 'partial answer') => ({
  stopReason,
  content: [{ type: 'text' as const, text }],
  usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test('text with no output tokens counted means the stream was cut', () => {
  assert.equal(isReplyCutOff(message('stop', 0)), true);
});

test('a counted reply, or one with nothing shown, is not flagged', () => {
  assert.equal(isReplyCutOff(message('stop', 12)), false);
  assert.equal(isReplyCutOff(message('length', 0)), false);
  assert.equal(isReplyCutOff(message('stop', 0, '  ')), false);
});
