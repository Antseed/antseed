import { describe, expect, it } from 'vitest';
import { parsePinnedModel } from './model-identity.js';

describe('parsePinnedModel', () => {
  const peer = 'ab'.repeat(20);
  it('splits a pinned model, with or without 0x, and lowercases the peer id', () => {
    expect(parsePinnedModel(`${peer}@vendor/model`)).toEqual({ modelId: 'vendor/model', peerId: peer });
    expect(parsePinnedModel(`0x${peer.toUpperCase()}@m@x`)).toEqual({ modelId: 'm@x', peerId: peer });
  });
  it('is null when the value pins no seller', () => {
    expect(parsePinnedModel('vendor/model')).toBeNull();
    expect(parsePinnedModel(`${peer.slice(2)}@model`)).toBeNull();
    expect(parsePinnedModel(`${peer}@`)).toBeNull();
  });
});
