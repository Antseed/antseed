import { expect, test } from 'vitest';
import { joinPinnedModel, splitPinnedModel } from '../../../shared/pinned-model.js';

const PEER = '1d90f467689d499dc435e5744b4613c3203eb0aa';

test('splitPinnedModel separates a pinned seller from the model', () => {
  expect(splitPinnedModel(`${PEER}@deepseek-v4-flash`)).toEqual({ modelId: 'deepseek-v4-flash', peerId: PEER });
  expect(splitPinnedModel(`0x${PEER.toUpperCase()}@org/model@v2`)).toEqual({ modelId: 'org/model@v2', peerId: PEER });
  expect(splitPinnedModel('deepseek-v4-flash')).toEqual({ modelId: 'deepseek-v4-flash', peerId: null });
  expect(splitPinnedModel('short@model')).toEqual({ modelId: 'short@model', peerId: null });
  expect(splitPinnedModel(null)).toEqual({ modelId: '', peerId: null });
});

test('joinPinnedModel pins, re-pins and unpins', () => {
  expect(joinPinnedModel('deepseek-v4-flash', PEER)).toBe(`${PEER}@deepseek-v4-flash`);
  expect(joinPinnedModel(`${PEER}@deepseek-v4-flash`, null)).toBe('deepseek-v4-flash');
  expect(joinPinnedModel(`${PEER}@deepseek-v4-flash`, `0x${'a'.repeat(40)}`)).toBe(`${'a'.repeat(40)}@deepseek-v4-flash`);
});
