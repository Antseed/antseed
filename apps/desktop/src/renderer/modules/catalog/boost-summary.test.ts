import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../../core/state';
import { paidSellerBoosts, summarizeModelBoost, type BoostOption } from './boost-summary.js';

const option = (peerId: string, boost: number | null, free = false): BoostOption => ({ peerId, name: peerId.toUpperCase(), boost, free });

test('offers the best paid seller when it earns more than the current one', () => {
  const options = [option('auto', 2), option('best', 15.9), option('free', 40, true)];
  const summary = summarizeModelBoost(options, 'auto');
  assert.equal(summary?.current?.peerId, 'auto');
  assert.equal(summary?.best?.peerId, 'best');
  assert.equal(summary?.better, true);
});

test('a free current seller earns nothing, so any paid seller with points is better', () => {
  const summary = summarizeModelBoost([option('free', 40, true), option('paid', 0.5)], 'free');
  assert.equal(summary?.best?.peerId, 'paid');
  assert.equal(summary?.better, true);
});

test('nothing better when the current seller is the best', () => {
  const summary = summarizeModelBoost([option('best', 15.9), option('other', 2)], 'best');
  assert.equal(summary?.better, false);
  assert.equal(summary?.best?.peerId, 'best');
});

test('no best when only free or 0x sellers exist', () => {
  const summary = summarizeModelBoost([option('free', 9, true), option('zero', 0), option('dust', 0.004)], 'zero');
  assert.equal(summary?.best, null);
  assert.equal(summary?.better, false);
});

test('null when no boost is known (Antscan unreachable)', () => {
  assert.equal(summarizeModelBoost([option('a', null), option('b', null)], 'a'), null);
});

test('paid sellers for the points calculator: best paid boost per seller, highest first', () => {
  const row = (peerId: string, boost: number | null, input = 1) => ({
    peerId, peerDisplayName: peerId.toUpperCase(), peerLabel: '', protocol: 'openai-chat-completions',
    inputUsdPerMillion: input, outputUsdPerMillion: input, boost,
  }) as unknown as DiscoverRow;
  assert.deepEqual(paidSellerBoosts([
    row('a', 2), row('a', 5), row('b', 16), row('c', 30, 0), row('d', 0.004), row('e', null),
  ]), [{ peerId: 'b', name: 'B', boost: 16 }, { peerId: 'a', name: 'A', boost: 5 }]);
});
