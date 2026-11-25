import test from 'node:test';
import assert from 'node:assert/strict';

import { lastServingSeller, previewFirstSeller } from './auto-seller.js';
import type { ChatRouteCandidate } from '../../shared/chat-gateway-types.js';

test('the last serving seller is the latest reply that recorded one', () => {
  assert.equal(lastServingSeller([]), null);
  assert.equal(lastServingSeller([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'a', meta: { peerId: 'aa' } },
    { role: 'user', content: 'again' },
    { role: 'assistant', content: 'b', meta: { peerId: 'bb' } },
    // A reply that failed before a seller answered names none.
    { role: 'assistant', content: 'c', meta: {} },
  ]), 'bb');
});

test('Auto\'s first pick is the eligible seller ranked first', () => {
  const candidate = (peerId: string, rank: number | null, eligible = true): ChatRouteCandidate => ({
    peerId, name: null, rank, eligible, reasons: [], inputUsdPerMillion: null, outputUsdPerMillion: null,
  } as unknown as ChatRouteCandidate);
  const preview = (candidates: ChatRouteCandidate[]) => ({ model: 'm', modelAllowed: true, sort: null, candidates });
  assert.equal(previewFirstSeller(preview([candidate('cc', 3), candidate('aa', 1, false), candidate('bb', 2)])), 'bb');
  assert.equal(previewFirstSeller(preview([candidate('aa', null, false)])), null);
});
