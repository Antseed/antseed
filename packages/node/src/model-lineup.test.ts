import { describe, expect, it } from 'vitest';
import { curatedPickerModels, selectRecommendedModels } from './model-lineup.js';

const entry = (serviceId: string, free = false) => ({ serviceId, label: serviceId, free });
const select = (catalog: ReturnType<typeof entry>[]) =>
  selectRecommendedModels(catalog, { hasTrustedFreeSeller: (item) => item.free }).map((item) => item.serviceId);

describe('selectRecommendedModels', () => {
  it('lists lineup models in lineup order, then trusted free models', () => {
    expect(select([entry('aion-2.0'), entry('free-model', true), entry('claude-sonnet-5'), entry('claude-opus-5')]))
      .toEqual(['claude-opus-5', 'claude-sonnet-5', 'free-model']);
  });

  it('prefers the exact model for a slot and lets a broad slot take an unclaimed variant', () => {
    expect(select([entry('gpt-5.6-sol'), entry('gpt-5.6-luna'), entry('gpt-5.6')]))
      .toEqual(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6']);
    expect(select([entry('gpt-5.6-sol-2'), entry('gpt-5.6-sol')])).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol-2']);
  });
});

describe('curatedPickerModels', () => {
  const PREFS = { preferFreePeers: false, maxInputUsdPerMillion: 25, minTrustScore: 60, allowedPeerIds: [], blockedPeerIds: [] };
  const peer = (peerId: string, overrides: Record<string, unknown> = {}) => (
    { peerId, provider: 'openai', effectiveReputationScore: 90, inputUsdPerMillion: 1, outputUsdPerMillion: 2, ...overrides }
  );
  const model = (id: string, peers: Record<string, unknown>[], overrides: Record<string, unknown> = {}) => (
    { id, name: id, type: 'text', peers, ...overrides }
  );
  const ids = (rows: { model: string }[]) => rows.map((row) => row.model);

  it('offers the Recommended lineup in lineup order, not the whole network', () => {
    const entries = [
      model('aion-2.0', [peer('a')]),
      model('claude-sonnet-5', [peer('a')]),
      model('gpt-5.6-sol', [peer('a'), peer('b')], { name: 'GPT 5.6 Sol' }),
      model('claude-opus-5', [peer('a')], { name: 'Claude Opus 5' }),
      model('flux-2', [peer('a')], { type: 'image' }),
    ];
    const rows = curatedPickerModels(entries, { preferences: PREFS });
    expect(ids(rows)).toEqual(['claude-opus-5', 'gpt-5.6-sol', 'claude-sonnet-5']);
    expect(rows[0]?.label).toBe('Claude Opus 5');
  });

  it('writes the id most sellers advertise, preferring ids without a vendor prefix', () => {
    const entries = [model('opus-5.5', [
      peer('a', { serviceId: 'claude-opus-5.5' }),
      peer('b', { serviceId: 'claude-opus-5.5' }),
      peer('c', { serviceId: 'opus-5.5' }),
    ], { name: 'Claude Opus 5.5' }), model('minimax/minimax-m3', [
      peer('a', { serviceId: 'minimax/minimax-m3' }),
      peer('b', { serviceId: 'minimax-m3' }),
    ])];
    expect(ids(curatedPickerModels(entries, { preferences: PREFS }))).toEqual(['claude-opus-5.5', 'minimax-m3']);
  });

  it('adds free models only from sellers that pass the trust gate', () => {
    const entries = [
      model('trusted-free', [peer('a', { inputUsdPerMillion: 0, outputUsdPerMillion: 0 })]),
      model('untrusted-free', [peer('b', { inputUsdPerMillion: 0, outputUsdPerMillion: 0, effectiveReputationScore: 10 })]),
      model('cached-billed', [peer('a', { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.01 })]),
    ];
    expect(ids(curatedPickerModels(entries, { preferences: PREFS }))).toEqual(['trusted-free']);
  });

  it('lists the AI VPN selection, then favorites, then the lineup, and drops blocked sellers', () => {
    const entries = [
      model('claude-opus-5', [peer('blocked')]),
      model('gpt-5.6-sol', [peer('a')]),
      model('aion-2.0', [peer('a')]),
      model('kimi-k2.6', [peer('a', { capabilities: { reasoning: true } })]),
    ];
    const rows = curatedPickerModels(entries, {
      preferences: { ...PREFS, blockedPeerIds: ['blocked'] },
      favoriteModels: ['aion-2.0', 'gpt-5.6-sol'],
      defaultRoutedModel: `${'a'.repeat(40)}@kimi-k2.6`,
    });
    expect(rows).toEqual([
      { label: 'kimi-k2.6', model: 'kimi-k2.6', provider: 'openai', reasoning: true },
      // Favorites in catalog order (seller count, then label), as in the desktop dropdown.
      { label: 'aion-2.0', model: 'aion-2.0', provider: 'openai', favorite: true },
      { label: 'gpt-5.6-sol', model: 'gpt-5.6-sol', provider: 'openai', favorite: true },
    ]);
  });
});
