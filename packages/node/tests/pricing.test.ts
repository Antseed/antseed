import { describe, it, expect } from 'vitest';
import {
  computeCostUsdc,
  estimateCostFromBytes,
  estimateTokensFromBytes,
  estimateTokensFromBytesSampled,
  estimateTokensFromText,
  isFreeUnitBillingModel,
  validateUnitBillingModelV1,
} from '../src/payments/pricing.js';
import { evaluateUnitBilling } from '../src/billing/unit.js';

describe('pricing utilities', () => {
  // ── estimateTokensFromBytes ──

  it('estimateTokensFromBytes uses tokenx for accurate estimation', () => {
    const text = 'Hello world, this is a test of the tokenizer.';
    const bytes = new TextEncoder().encode(text);
    const tokens = estimateTokensFromBytes(bytes);
    // tokenx should give a reasonable estimate — roughly 10-12 tokens for this text
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
  });

  it('estimateTokensFromBytes with empty Uint8Array returns 0', () => {
    expect(estimateTokensFromBytes(new Uint8Array(0))).toBe(0);
  });

  it('estimateTokensFromBytes with code content gives reasonable estimate', () => {
    const code = 'function hello() { return "world"; }\nconst x = 42;';
    const bytes = new TextEncoder().encode(code);
    const tokens = estimateTokensFromBytes(bytes);
    // Code typically has more tokens per byte than prose
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(30);
  });

  // ── estimateTokensFromBytesSampled ──

  it('estimateTokensFromBytesSampled is exact for bodies up to 64 KiB', () => {
    const body = new TextEncoder().encode(JSON.stringify({ input: 'Explain the code below. '.repeat(2000) }));
    expect(body.length).toBeLessThanOrEqual(64 * 1024);
    expect(estimateTokensFromBytesSampled(body)).toBe(estimateTokensFromBytes(body));
  });

  it('estimateTokensFromBytesSampled stays close to the full estimate for large bodies', () => {
    const turns = Array.from({ length: 400 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: i % 3
        ? `function handler${i}(req, res) {\n  const body = JSON.parse(req.body);\n  return res.status(200).json({ ok: true, id: ${i} });\n}\n`.repeat(8)
        : `Turn ${i}: please review the change and point out anything that could break in production. `.repeat(12),
    }));
    const body = new TextEncoder().encode(JSON.stringify({ model: 'm', input: turns }));
    expect(body.length).toBeGreaterThan(256 * 1024);
    const exact = estimateTokensFromBytes(body);
    const sampled = estimateTokensFromBytesSampled(body);
    expect(Math.abs(sampled - exact) / exact).toBeLessThan(0.1);
  });

  // ── estimateTokensFromText ──

  it('estimateTokensFromText returns reasonable count for English text', () => {
    const tokens = estimateTokensFromText('The quick brown fox jumps over the lazy dog');
    expect(tokens).toBeGreaterThan(7);
    expect(tokens).toBeLessThan(15);
  });

  // ── computeCostUsdc ──

  it('computeCostUsdc computes USDC base units from tokens and pricing', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    // 100 input tokens * $3/M + 500 output tokens * $15/M
    // = 300/1M + 7500/1M = 7800/1M USD = $0.0078 = 7800 base units
    expect(computeCostUsdc(100, 500, pricing)).toBe(7800n);
  });

  it('computeCostUsdc returns 0 for zero tokens', () => {
    expect(computeCostUsdc(0, 0, { inputUsdPerMillion: 3, outputUsdPerMillion: 15 })).toBe(0n);
  });

  it('computeCostUsdc returns 0 for zero pricing', () => {
    expect(computeCostUsdc(1000, 1000, { inputUsdPerMillion: 0, outputUsdPerMillion: 0 })).toBe(0n);
  });

  it('computeCostUsdc applies cachedInputUsdPerMillion to cached tokens', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 };
    // 200 fresh input * $3/M + 800 cached input * $0.3/M + 100 output * $15/M
    // = 600/1M + 240/1M + 1500/1M = 2340/1M USD = $0.00234 = 2340 base units
    expect(computeCostUsdc(200, 100, pricing, 800)).toBe(2340n);
  });

  it('computeCostUsdc defaults cachedInputUsdPerMillion to inputUsdPerMillion when not set', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    // 200 fresh * $3/M + 800 cached * $3/M (no discount) + 100 output * $15/M
    // = 600/1M + 2400/1M + 1500/1M = 4500/1M = $0.0045 = 4500 base units
    expect(computeCostUsdc(200, 100, pricing, 800)).toBe(4500n);
  });

  it('computeCostUsdc with zero cached tokens matches original behavior', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 };
    // All fresh, no cached — cachedInputUsdPerMillion is irrelevant
    expect(computeCostUsdc(100, 500, pricing, 0)).toBe(7800n);
    expect(computeCostUsdc(100, 500, pricing)).toBe(7800n);
  });

  // ── estimateCostFromBytes ──

  it('estimateCostFromBytes uses tokenx for accurate cost', () => {
    const pricing = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
    const input = new TextEncoder().encode('What is the capital of France?');
    const output = new TextEncoder().encode('The capital of France is Paris.');
    const result = estimateCostFromBytes(input, output, pricing);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.cost).toBeGreaterThan(0n);
  });

  it('evaluates image unit billing with exact match attributes', () => {
    const costUsdc = evaluateUnitBilling({
      version: 1,
      components: [
        { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
        { unit: 'output_images', priceUsd: 0.08, match: { size: '2048x2048' } },
      ],
    }, {
      sellerPeerId: 'seller',
      provider: 'openai',
      service: 'gpt-image-1',
      serviceApiProtocol: 'openai-images',
      attributes: { size: '1024x1024' },
    }, {
      units: { output_images: 2 },
    });
    expect(costUsdc).toBe(80_000n);
  });

  it('validates unit and price shape', () => {
    expect(validateUnitBillingModelV1({
      version: 1,
      components: [
        { unit: 'requests', priceUsd: Number.NaN } as any,
      ],
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('unsupported'),
      expect.stringContaining('priceUsd'),
    ]));
  });

  it('treats non-zero image billing as paid even with free token fallback', () => {
    expect(isFreeUnitBillingModel({ version: 1, components: [] })).toBe(true);
    expect(isFreeUnitBillingModel({
      version: 1,
      components: [{ unit: 'output_images', priceUsd: 0.01 }],
    })).toBe(false);
  });
});
