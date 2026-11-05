import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AntscanIndexer } from './indexer.js';
import { BOOST_REFERENCE_POWER, boostBySeller, boostFromWeight, createBoostLookup, formatBoost } from './boost.js';

// Six pools recorded from https://antscan.co/api/staking/pools at epoch 27.
const fixture = readFileSync(new URL('./staking-pools.fixture.json', import.meta.url), 'utf8');
const respond = () => new Response(fixture, { headers: { 'content-type': 'application/json' } });

describe('boostFromWeight', () => {
  it('is 1.0× at 10,000 ANTS max-locked', () => {
    expect(BOOST_REFERENCE_POWER).toBe(1_040_000n * 10n ** 18n);
    expect(boostFromWeight(BOOST_REFERENCE_POWER)).toBe(1);
    expect(boostFromWeight(BOOST_REFERENCE_POWER / 2n)).toBe(0.5);
  });

  it('is 0 for an empty or negative pool', () => {
    expect(boostFromWeight(0n)).toBe(0);
    expect(boostFromWeight(-1n)).toBe(0);
  });
});

describe('boostBySeller', () => {
  it('maps a recorded Antscan pools response by lowercase seller', async () => {
    const { pools } = await new AntscanIndexer('https://scan', vi.fn<typeof fetch>(async () => respond())).pools();
    const map = boostBySeller(pools);
    expect(map.get('0x983e9de990b9ac8d36d373db5d0b49a4d7f7d826')).toEqual({ boost: expect.closeTo(15.8718, 4), agentId: 87124 });
    expect(map.get('0x73b4c9335fa239f9c6df3d28d5bf5d3cdf4de736')?.boost).toBeCloseTo(7.2336, 4);
    expect(map.get('0x07e4624d6718e0c7b6b951e908590b4988859e85')).toEqual({ boost: 0, agentId: 86084 });
    expect(map.get('0x472f6914375a83fc827499612f5673e3780469fd')?.boost).toBeCloseTo(0.0000952, 7);
    // The pool without a bound seller is skipped.
    expect(map.size).toBe(5);
  });

  it('lowercases sellers and keeps the strongest pool when a seller has several', () => {
    const map = boostBySeller([
      { agentId: 1, seller: '0xABC', weight: String(BOOST_REFERENCE_POWER) },
      { agentId: 2, seller: '0xabc', weight: String(BOOST_REFERENCE_POWER * 3n) },
      { agentId: 3, seller: '0xAbc', weight: 'garbage' },
    ]);
    expect(map.get('0xabc')).toEqual({ boost: 3, agentId: 2 });
  });
});

describe('formatBoost', () => {
  it('matches the Points site', () => {
    expect(formatBoost(15.87)).toBe('16×');
    expect(formatBoost(7.23)).toBe('7.2×');
    expect(formatBoost(0.05)).toBe('<0.1×');
    expect(formatBoost(0)).toBe('0×');
    expect(formatBoost(null)).toBe('—');
  });
});

describe('createBoostLookup', () => {
  it('is null without an explorer', async () => {
    expect(await createBoostLookup('')()).toBeNull();
  });

  it('caches the map and falls back to null when Antscan is unreachable', async () => {
    let time = 0;
    const request = vi.fn<typeof fetch>(async () => respond());
    const lookup = createBoostLookup('https://scan', { fetchImpl: request, ttlMs: 1_000, staleMs: 5_000, now: () => time });
    const [first, concurrent] = await Promise.all([lookup(), lookup()]);
    expect(first?.size).toBe(5);
    expect(concurrent).toBe(first);
    expect(await lookup()).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);

    request.mockRejectedValue(new Error('offline'));
    time = 2_000;
    expect(await lookup()).toBe(first); // stale but recent: still answers
    time = 10_000;
    expect(await lookup()).toBeNull();
  }, 30_000);

  it('is null when the first read fails', async () => {
    const lookup = createBoostLookup('https://scan', { fetchImpl: vi.fn<typeof fetch>(async () => new Response('', { status: 404 })) });
    expect(await lookup()).toBeNull();
  });
});
