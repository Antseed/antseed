import { describe, expect, it } from 'vitest';
import {
  SELLER_HEALTH_HALF_LIFE_MS,
  SellerHealthBook,
  adaptiveFirstTokenTimeoutMs,
  orderAdaptiveRoutes,
  type AdaptiveRouteInput,
} from './seller-health.js';

const NOW = 1_800_000_000_000;
const SHAPE = { inputTokens: 35_000, outputTokens: 200 };
const id = (seed: string): string => seed.repeat(40);

type Seller = AdaptiveRouteInput;
const seller = (seed: string, input: number, output: number, overrides: Partial<Seller> = {}): Seller => ({
  peerId: id(seed), serviceId: 'model-x', inputUsdPerMillion: input, outputUsdPerMillion: output, trustScore: 70, coolingDown: false, ...overrides,
});
const order = (sellers: Seller[], book: SellerHealthBook, random = () => 0, now = NOW) =>
  orderAdaptiveRoutes(sellers, (s) => s, book, SHAPE, { now, random, explorationRate: 0 });
const first = (sellers: Seller[], book: SellerHealthBook, random?: () => number) => order(sellers, book, random).ordered[0]!.peerId[0];

describe('seller health', () => {
  it('a seller failing every request falls behind pricier healthy sellers within a few requests', () => {
    const book = new SellerHealthBook();
    const cheap = seller('a', 0.1, 0.3);
    const pricier = seller('b', 0.2, 0.6);
    expect(first([cheap, pricier], book)).toBe('a');
    book.recordFailure(cheap.peerId, 'model-x', NOW, 'HTTP 403');
    book.recordFailure(cheap.peerId, 'model-x', NOW, 'HTTP 403');
    const result = order([cheap, pricier], book);
    expect(result.ordered.map((s) => s.peerId[0])).toEqual(['b', 'a']);
    expect(result.scores.get(cheap)!.unhealthy).toBe(true);
  });

  it('one blip does not knock a seller off the top, and failures fade without any timer', () => {
    const book = new SellerHealthBook();
    const cheap = seller('a', 0.1, 0.3);
    const pricier = seller('b', 0.2, 0.6);
    for (let i = 0; i < 10; i += 1) book.recordSuccess(cheap.peerId, 'model-x', NOW - 60_000, { firstTokenMs: 2000, streamed: true });
    book.recordFailure(cheap.peerId, 'model-x', NOW, 'HTTP 503');
    expect(first([cheap, pricier], book)).toBe('a');

    const broken = new SellerHealthBook();
    for (let i = 0; i < 6; i += 1) broken.recordFailure(cheap.peerId, 'model-x', NOW, 'HTTP 403');
    expect(order([cheap, pricier], broken).scores.get(cheap)!.unhealthy).toBe(true);
    expect(order([cheap, pricier], broken, () => 0, NOW + 4 * SELLER_HEALTH_HALF_LIFE_MS).scores.get(cheap)!.unhealthy).toBe(false);
  });

  it('a recovered seller comes back as soon as it serves again', () => {
    const book = new SellerHealthBook();
    const cheap = seller('a', 0.1, 0.3);
    const pricier = seller('b', 0.3, 0.9);
    for (let i = 0; i < 4; i += 1) book.recordFailure(cheap.peerId, 'model-x', NOW, 'HTTP 403');
    expect(first([cheap, pricier], book)).toBe('b');
    for (let i = 0; i < 3; i += 1) book.recordSuccess(cheap.peerId, 'model-x', NOW, { firstTokenMs: 1500, streamed: true });
    expect(first([cheap, pricier], book)).toBe('a');
  });

  it('a much slower seller loses to a slightly pricier fast one; a much cheaper slow one still competes', () => {
    const book = new SellerHealthBook();
    const slow = seller('a', 0.1, 0.3);
    const fast = seller('b', 0.11, 0.33);
    const slowCheap = seller('c', 0.05, 0.2);
    for (let i = 0; i < 5; i += 1) {
      book.recordSuccess(slow.peerId, 'model-x', NOW, { firstTokenMs: 23_000, streamed: false, outputTokens: 50 });
      book.recordSuccess(fast.peerId, 'model-x', NOW, { firstTokenMs: 8_000, streamed: false, outputTokens: 50 });
      book.recordSuccess(slowCheap.peerId, 'model-x', NOW, { firstTokenMs: 23_000, streamed: false, outputTokens: 50 });
    }
    expect(order([slow, fast, slowCheap], book).ordered.map((s) => s.peerId[0])).toEqual(['b', 'c', 'a']);
  });

  it('spreads traffic among sellers close to the best, weighted toward the cheapest', () => {
    const book = new SellerHealthBook();
    const a = seller('a', 0.1, 0.3);
    const b = seller('b', 0.11, 0.33);
    const far = seller('c', 1, 3);
    const picks = { a: 0, b: 0, c: 0 } as Record<string, number>;
    for (let i = 0; i < 1000; i += 1) picks[first([a, b, far], book, () => i / 1000)!]! += 1;
    expect(picks['c']).toBe(0);
    expect(picks['a']).toBeGreaterThan(picks['b']!);
    expect(picks['b']).toBeGreaterThan(300);
  });

  it('explores a seller with no recent data on a small share of requests, keeping the usual order as fallback', () => {
    const book = new SellerHealthBook();
    const known = seller('a', 0.1, 0.3);
    const unknown = seller('b', 1, 3);
    book.recordSuccess(known.peerId, 'model-x', NOW, { firstTokenMs: 1000, streamed: true });
    const draws = [0.01];
    const result = orderAdaptiveRoutes([known, unknown], (s) => s, book, SHAPE, { now: NOW, random: () => draws.shift() ?? 0, explorationRate: 0.05 });
    expect(result.explored).toBe(unknown);
    expect(result.ordered.map((s) => s.peerId[0])).toEqual(['b', 'a']);
    expect(orderAdaptiveRoutes([known, unknown], (s) => s, book, SHAPE, { now: NOW, random: () => 0.5, explorationRate: 0.05 }).explored).toBeNull();
  });

  it('cooling-down sellers go last; unhealthy ones before them', () => {
    const book = new SellerHealthBook();
    const cooling = seller('a', 0, 0, { coolingDown: true });
    const sick = seller('b', 0.01, 0.01);
    const fine = seller('c', 1, 3);
    for (let i = 0; i < 5; i += 1) book.recordFailure(sick.peerId, 'model-x', NOW, 'empty answer');
    expect(order([cooling, sick, fine], book).ordered.map((s) => s.peerId[0])).toEqual(['c', 'b', 'a']);
  });

  it('with no observations the order is plain price order, unpriced sellers last', () => {
    const book = new SellerHealthBook();
    const sellers = [seller('a', 1, 3), seller('b', null as unknown as number, null as unknown as number), seller('c', 0.1, 0.3), seller('d', 0, 0)];
    expect(orderAdaptiveRoutes(sellers, (s) => s, book, SHAPE, { now: NOW, spreadTolerance: 0, explorationRate: 0 }).ordered.map((s) => s.peerId[0]))
      .toEqual(['d', 'c', 'a', 'b']);
  });

  it('round-trips through persistence and drops malformed entries', () => {
    const book = new SellerHealthBook();
    book.recordSuccess(id('a'), 'model-x', NOW, { firstTokenMs: 3000, streamed: true, streamMs: 2000, outputTokens: 100 });
    book.recordFailure(id('a'), 'model-x', NOW, 'HTTP 403');
    const raw = JSON.parse(JSON.stringify([...book.serialize(NOW), ['junk', null], 7]));
    const restored = SellerHealthBook.parse(raw, NOW);
    const stats = restored.stats(id('a'), 'model-x', NOW)!;
    expect(stats.successes).toBeCloseTo(1);
    expect(stats.failures).toBeCloseTo(1);
    expect(stats.tokensPerSecond).toBeCloseTo(50);
    expect(restored.entries(NOW)).toHaveLength(1);
  });

  it('adaptive timeouts follow the seller’s own speed, within bounds, and need data first', () => {
    const book = new SellerHealthBook();
    expect(adaptiveFirstTokenTimeoutMs(book.stats(id('a'), 'm', NOW), 200, true)).toBeNull();
    for (let i = 0; i < 3; i += 1) book.recordSuccess(id('a'), 'm', NOW, { firstTokenMs: 6000, streamed: true });
    expect(adaptiveFirstTokenTimeoutMs(book.stats(id('a'), 'm', NOW), 200, true)).toBe(30_000);
    for (let i = 0; i < 3; i += 1) book.recordSuccess(id('c'), 'm', NOW, { firstTokenMs: 10_000, streamed: true });
    expect(adaptiveFirstTokenTimeoutMs(book.stats(id('c'), 'm', NOW), 200, true)).toBe(40_000);
    for (let i = 0; i < 3; i += 1) book.recordSuccess(id('d'), 'm', NOW, { firstTokenMs: 60_000, streamed: true });
    expect(adaptiveFirstTokenTimeoutMs(book.stats(id('d'), 'm', NOW), 200, true)).toBe(120_000);
  });

  it('keeps each conversation on one seller while different conversations spread', () => {
    const book = new SellerHealthBook();
    const sellers = [seller('a', 0.1, 0.3), seller('b', 0.11, 0.33), seller('c', 0.105, 0.31)];
    const pick = (key: string) => orderAdaptiveRoutes(sellers, (s) => s, book, SHAPE, { now: NOW, affinityKey: key, random: Math.random }).ordered[0]!.peerId[0];
    for (let turn = 0; turn < 20; turn += 1) expect(pick('conversation-1')).toBe(pick('conversation-1'));
    const spread = new Set(Array.from({ length: 60 }, (_, i) => pick(`conversation-${i}`)));
    expect(spread.size).toBe(3);
  });

  it('a conversation stays put when another seller joins or leaves the pool, unless its own seller leaves', () => {
    const book = new SellerHealthBook();
    const a = seller('a', 0.1, 0.3), b = seller('b', 0.1, 0.3), c = seller('c', 0.1, 0.3);
    const pick = (sellers: Seller[], key: string) => orderAdaptiveRoutes(sellers, (s) => s, book, SHAPE, { now: NOW, affinityKey: key }).ordered[0]!.peerId[0];
    let moved = 0;
    for (let i = 0; i < 200; i += 1) {
      const before = pick([a, b], `k${i}`);
      const after = pick([a, b, c], `k${i}`);
      if (after !== before && after !== 'c') moved += 1;
    }
    expect(moved).toBe(0);
  });

  it('spreads only across sellers with an open channel; a new reserve only for a clearly better seller', () => {
    const book = new SellerHealthBook();
    const open = seller('a', 0.11, 0.33, { channelOpen: true });
    const closedCheaper = seller('b', 0.1, 0.3, { channelOpen: false });
    const firsts = new Set(Array.from({ length: 50 }, (_, i) => order([open, closedCheaper], book, () => i / 50).ordered[0]!.peerId[0]));
    expect([...firsts]).toEqual(['a']);
    const closedMuchCheaper = seller('c', 0.001, 0.001, { channelOpen: false });
    const shape = { inputTokens: 500_000, outputTokens: 200 };
    expect(orderAdaptiveRoutes([open, closedMuchCheaper], (s) => s, book, shape, { now: NOW, explorationRate: 0 }).ordered[0]!.peerId[0]).toBe('c');
  });

  it('never probes a seller that would need a new reserve, nor during a conversation', () => {
    const book = new SellerHealthBook();
    const known = seller('a', 0.1, 0.3, { channelOpen: true });
    const stranger = seller('b', 1, 3, { channelOpen: false });
    book.recordSuccess(known.peerId, 'model-x', NOW, { firstTokenMs: 1000, streamed: true });
    expect(orderAdaptiveRoutes([known, stranger], (s) => s, book, SHAPE, { now: NOW, random: () => 0, explorationRate: 1 }).explored).toBeNull();
    const idle = seller('c', 1, 3, { channelOpen: true });
    expect(orderAdaptiveRoutes([known, idle], (s) => s, book, SHAPE, { now: NOW, random: () => 0, explorationRate: 1, affinityKey: 'chat' }).explored).toBeNull();
    expect(orderAdaptiveRoutes([known, idle], (s) => s, book, SHAPE, { now: NOW, random: () => 0, explorationRate: 1 }).explored).toBe(idle);
  });

  it('a seller failing on one model starts behind on a model the buyer has not used with it yet', () => {
    const book = new SellerHealthBook();
    const flaky = seller('a', 0.1, 0.3, { serviceId: 'other-model' });
    const fine = seller('b', 0.12, 0.36, { serviceId: 'other-model' });
    for (let i = 0; i < 6; i += 1) book.recordFailure(flaky.peerId, 'model-x', NOW, 'HTTP 403');
    expect(first([flaky, fine], book)).toBe('b');
    expect(book.stats(flaky.peerId, 'other-model', NOW)!.failures).toBeCloseTo(3);
    expect(book.stats(flaky.peerId, 'other-model', NOW)!.firstTokenMs).toBeNull();
  });

  it('a seller already at its advertised capacity for this buyer is not drawn and goes after sellers with room', () => {
    const book = new SellerHealthBook();
    const full = seller('a', 0.1, 0.3, { saturated: true });
    const roomy = seller('b', 0.105, 0.31);
    const roomier = seller('c', 0.106, 0.31);
    for (let i = 0; i < 20; i += 1) {
      const ordered = order([full, roomy, roomier], book, () => i / 20).ordered.map((s) => s.peerId[0]);
      expect(ordered[0]).not.toBe('a');
      expect(ordered.indexOf('a')).toBe(2);
    }
  });

  it('never probes a seller already at its advertised capacity', () => {
    const book = new SellerHealthBook();
    const known = seller('a', 0.1, 0.3, { channelOpen: true });
    const full = seller('b', 1, 3, { channelOpen: true, saturated: true });
    book.recordSuccess(known.peerId, 'model-x', NOW, { firstTokenMs: 1000, streamed: true });
    const result = orderAdaptiveRoutes([known, full], (s) => s, book, SHAPE, { now: NOW, random: () => 0, explorationRate: 1 });
    expect(result.explored).toBeNull();
    expect(result.ordered.map((s) => s.peerId[0])).toEqual(['a', 'b']);
  });

  it('the only open-channel seller in the pool goes first even when a seller needing a new channel scores better', () => {
    const book = new SellerHealthBook();
    const closedLeader = seller('a', 0.1, 0.3, { channelOpen: false });
    const openAlternative = seller('b', 0.13, 0.39, { channelOpen: true });
    const result = order([closedLeader, openAlternative], book);
    expect(result.scores.get(closedLeader)!.score).toBeLessThan(result.scores.get(openAlternative)!.score);
    expect(result.pool).toEqual([openAlternative]);
    expect(result.ordered.map((s) => s.peerId[0])).toEqual(['b', 'a']);
  });
});
