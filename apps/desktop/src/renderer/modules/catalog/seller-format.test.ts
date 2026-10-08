import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DiscoverRow } from '../../core/state';
import { sellerMetaLabel, sellerReputationLabel, sellerReputationExplanation } from './seller-format.js';

test('seller reputation explains the trust formula part by part', () => {
  const route = {
    effectiveReputationScore: 65,
    onChainReputationScore: 65,
    trust: {
      score: 65,
      history: { score: 30, channelCount: 100, totalVolumeUsdcMicros: 100_000_000 },
      usage: { score: 10, shareBps: 1_000, epoch: 11 },
      power: { score: 5, shareBps: 1_000, epoch: 12 },
      identity: { score: 20, kind: 'github', claim: 'portfolio' },
      washFlagged: false,
    },
  } as DiscoverRow;
  assert.equal(
    sellerReputationExplanation(route),
    'Trust 6.5/10 = history 3.0 + usage 1.0 + power 0.5 + identity 2.0 GitHub. Not flagged for wash trading.',
  );
});

test('seller reputation shows n/a, none and 0 for missing trust parts', () => {
  const route = {
    effectiveReputationScore: 0,
    onChainReputationScore: 0,
    trust: { score: 0, history: null, usage: null, power: null, identity: null, washFlagged: null },
  } as DiscoverRow;
  assert.equal(
    sellerReputationExplanation(route),
    'Trust 0.0/10 = history n/a + usage n/a + power n/a + identity none. Wash-trading registry unavailable.',
  );
});

test('seller reputation calls out proven wash traders', () => {
  const route = {
    effectiveReputationScore: 0,
    onChainReputationScore: 0,
    trust: {
      score: 0,
      history: { score: 50, channelCount: 100, totalVolumeUsdcMicros: 100_000_000 },
      usage: { score: 38, shareBps: 7_000, epoch: 11 },
      power: { score: 5, shareBps: 20, epoch: 12 },
      identity: null,
      washFlagged: true,
    },
  } as DiscoverRow;
  assert.equal(
    sellerReputationExplanation(route),
    'Trust 0/10: flagged as a proven wash trader by the on-chain registry.',
  );
});

test('seller reputation falls back to the label when no breakdown is available', () => {
  const route = { effectiveReputationScore: 42, onChainReputationScore: 42, trust: null } as DiscoverRow;
  assert.equal(sellerReputationExplanation(route), 'Trust: 4.2/10');
});

test('seller reputation displays the effective model score, not the raw trust score', () => {
  const route = {
    effectiveReputationScore: 78.4,
    onChainReputationScore: 100,
  } as DiscoverRow;
  assert.equal(sellerReputationLabel(route), '7.8');
});

test('seller metadata omits the last settlement date', () => {
  const route = {
    protocol: 'openai-chat-completions',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    onChainLastSettledAt: 1_786_569_600,
  } as DiscoverRow;
  assert.equal(sellerMetaLabel(route), '$1/m input · $5/m output');
});
