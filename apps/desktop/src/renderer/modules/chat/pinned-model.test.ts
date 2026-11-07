import { expect, test } from 'vitest';
import { imageModelCanEdit, joinPinnedModel, modelAcceptsImages, splitPinnedModel } from '../../../shared/pinned-model.js';

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

test('a pinned chat can send images when its seller takes them, even if not every seller does', () => {
  const mixed = { supportsImages: false, imageInputSellerIds: [PEER] };
  expect(modelAcceptsImages(mixed, `${PEER}@vision-model`)).toBe(true);
  expect(modelAcceptsImages(mixed, 'vision-model')).toBe(false);
  expect(modelAcceptsImages(mixed, `${'b'.repeat(40)}@vision-model`)).toBe(false);
  expect(modelAcceptsImages({ supportsImages: true }, 'vision-model')).toBe(true);
});

test('imageModelCanEdit: one capable seller is enough unless another seller is pinned', () => {
  const other = 'a'.repeat(40);
  const mixed = { supportsImages: false, imageInputSellerIds: [PEER] };
  expect(imageModelCanEdit(mixed, 'qwen-image')).toBe(true);
  expect(imageModelCanEdit(mixed, `${PEER}@qwen-image`)).toBe(true);
  expect(imageModelCanEdit(mixed, `${other}@qwen-image`)).toBe(false);
  expect(imageModelCanEdit({ supportsImages: false }, 'qwen-image')).toBe(false);
  expect(imageModelCanEdit({ supportsImages: true }, 'qwen-image')).toBe(true);
});
