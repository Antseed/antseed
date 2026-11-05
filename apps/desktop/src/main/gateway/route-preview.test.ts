import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutePreview } from './route-preview.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

test('parseRoutePreview lists allowed sellers in Auto order, then the excluded ones', () => {
  const preview = parseRoutePreview({
    model: 'deepseek-v4-flash',
    policy: { sort: null },
    sources: [{ level: 'buyer', policy: { sort: 'expected-cost' } }],
    modelAllowed: true,
    candidates: [
      { peerId: C, displayName: 'Blocked', rank: null, eligible: false, reasons: ['blocked by workspace'], inputUsdPerMillion: 1, outputUsdPerMillion: 2, trustScore: 40, selection: null },
      { peerId: `0x${B.toUpperCase()}`, displayName: '  ', rank: 2, eligible: true, reasons: [], inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2, trustScore: null, selection: { successRate: 0.9 }, health: { status: 'failing' } },
      { peerId: A, displayName: 'Open Forge', rank: 1, eligible: true, reasons: ['free'], inputUsdPerMillion: 0, outputUsdPerMillion: 0, trustScore: 77, selection: { successRate: 0.98, firstTokenMs: 946, tokensPerSecond: 79 } },
    ],
  });
  assert.equal(preview.sort, 'expected-cost');
  assert.equal(preview.modelAllowed, true);
  assert.deepEqual(preview.candidates.map((candidate) => candidate.peerId), [A, B, C]);
  assert.deepEqual(preview.candidates[0], {
    peerId: A,
    name: 'Open Forge',
    rank: 1,
    eligible: true,
    reasons: ['free'],
    inputUsdPerMillion: 0,
    outputUsdPerMillion: 0,
    trustScore: 77,
    successRate: 0.98,
    firstTokenMs: 946,
    tokensPerSecond: 79,
    failing: false,
  });
  assert.equal(preview.candidates[1]!.name, null);
  assert.equal(preview.candidates[1]!.failing, true);
  assert.equal(preview.candidates[2]!.eligible, false);
});

test('parseRoutePreview reads a disallowed model and tolerates a malformed body', () => {
  assert.equal(parseRoutePreview({ model: 'x', modelAllowed: false, candidates: [] }).modelAllowed, false);
  assert.deepEqual(parseRoutePreview(null), { model: '', modelAllowed: true, sort: null, candidates: [] });
});
