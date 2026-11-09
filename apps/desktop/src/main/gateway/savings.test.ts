import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSavings, createSavingsReader, parseRetailPrices, parseServiceUsage, type ServiceUsage } from './savings.js';

const HASH_A = '0x' + 'aa'.repeat(32);
const HASH_B = '0x' + 'bb'.repeat(32);

function usage(overrides: Partial<ServiceUsage>): ServiceUsage {
  return { serviceIdHash: HASH_A, amountUsdc: '0', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', requestCount: 0, ...overrides };
}

// $10/M input, $1/M cached input, $30/M output, as OpenRouter writes them (per token).
const PRICES_BODY = { data: [{ id: 'openai/gpt-4o', name: 'GPT-4o', pricing: { prompt: '0.00001', completion: '0.00003', input_cache_read: '0.000001' } }] };

test('retail vs paid over matched services, with cached input priced apart', () => {
  const prices = parseRetailPrices(PRICES_BODY)!;
  const names = new Map([[HASH_A, 'gpt-4o'], [HASH_B, 'some-unpriced-model']]);
  const result = computeSavings([
    // 1M input of which 0.5M cached, 1M output: 5 + 0.5 + 30 = $35.50 retail; paid $5.
    usage({ amountUsdc: String(5_000_000), inputTokens: '1000000', cachedInputTokens: '500000', outputTokens: '1000000', requestCount: 12 }),
    // No retail match: left out of both sides.
    usage({ serviceIdHash: HASH_B, amountUsdc: String(99_000_000), inputTokens: '1000000', requestCount: 40 }),
  ], names, prices);
  assert.ok(result);
  assert.ok(Math.abs(result.retailUsd - 35.5) < 1e-9);
  assert.ok(Math.abs(result.paidUsd - 5) < 1e-9);
  assert.ok(Math.abs(result.savedUsd - 30.5) < 1e-9);
  assert.equal(result.matchedRequests, 12);
});

test('paying above retail saves nothing rather than a negative amount', () => {
  const prices = parseRetailPrices(PRICES_BODY)!;
  const result = computeSavings([usage({ amountUsdc: String(50_000_000), outputTokens: '1000000', requestCount: 1 })], new Map([[HASH_A, 'gpt-4o']]), prices);
  assert.equal(result?.savedUsd, 0);
});

test('nothing matched, or no tokens, is no savings', () => {
  const prices = parseRetailPrices(PRICES_BODY)!;
  assert.equal(computeSavings([usage({ inputTokens: '100' })], new Map(), prices), null);
  assert.equal(computeSavings([usage({})], new Map([[HASH_A, 'gpt-4o']]), prices), null);
  assert.equal(parseRetailPrices({ data: [{ id: 'free', pricing: { prompt: '0', completion: '0' } }] }), null);
});

test('usage is read from the daemon reply', () => {
  assert.deepEqual(parseServiceUsage({ ok: true, totals: { services: [{ serviceIdHash: HASH_A, amountUsdc: '7', inputTokens: 3, requestCount: 2 }, { amountUsdc: '1' }] } }), [
    usage({ amountUsdc: '7', inputTokens: '3', requestCount: 2 }),
  ]);
  assert.deepEqual(parseServiceUsage(null), []);
});

test('the reader keeps retail prices between reads and is off without a prices URL', async () => {
  let fetches = 0;
  let clock = 0;
  let url: string | null = 'https://prices.test/models';
  const read = createSavingsReader({
    pricesUrl: () => url,
    fetchJson: async () => { fetches += 1; return PRICES_BODY; },
    readUsage: async () => ({ ok: true, totals: { services: [{ serviceIdHash: HASH_A, outputTokens: '1000000', requestCount: 3 }] } }),
    resolveNames: async () => new Map([[HASH_A, 'gpt-4o']]),
    now: () => clock,
  });
  assert.equal((await read())?.savedUsd, 30);
  clock += 60_000;
  await read();
  assert.equal(fetches, 1);
  clock += 10 * 60_000;
  await read();
  assert.equal(fetches, 2);
  url = null;
  assert.equal(await read(), null);
});

test('a failed price refresh keeps the last good prices', async () => {
  let clock = 0;
  let fail = false;
  const read = createSavingsReader({
    pricesUrl: () => 'https://prices.test/models',
    fetchJson: async () => { if (fail) throw new Error('down'); return PRICES_BODY; },
    readUsage: async () => ({ totals: { services: [{ serviceIdHash: HASH_A, outputTokens: '1000000', requestCount: 1 }] } }),
    resolveNames: async () => new Map([[HASH_A, 'gpt-4o']]),
    now: () => clock,
  });
  await read();
  fail = true;
  clock += 11 * 60_000;
  assert.equal((await read())?.retailUsd, 30);
});
