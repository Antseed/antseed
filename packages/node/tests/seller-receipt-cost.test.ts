import { describe, expect, it } from 'vitest';
import { SellerSessionTracker } from '../src/metering/seller-session-tracker.js';
import { ReceiptGenerator } from '../src/metering/receipt-generator.js';
import type { MeteringStorage } from '../src/metering/storage.js';
import type { Identity } from '../src/p2p/identity.js';
import type { ProviderTokenPricingUsdPerMillion } from '../src/interfaces/seller-provider.js';
import type { UsageReceipt } from '../src/types/metering.js';

function track(receipts: UsageReceipt[]): SellerSessionTracker {
  const metering = {
    insertEvent() {},
    insertReceipt(receipt: UsageReceipt) { receipts.push(receipt); },
    upsertSession() {},
  } as unknown as MeteringStorage;
  const signer = { peerId: 'seller', sign: () => 'f'.repeat(128) };
  return new SellerSessionTracker(
    { peerId: 'seller' } as Identity,
    metering,
    new ReceiptGenerator(signer),
    {},
    { onSessionUpdated() {}, onSessionFinalized() {} },
  );
}

async function receiptCost(
  pricing: ProviderTokenPricingUsdPerMillion,
  providerUsage: { inputTokens: number; outputTokens: number; freshInputTokens?: number; cachedInputTokens?: number },
): Promise<number> {
  const receipts: UsageReceipt[] = [];
  const tracker = track(receipts);
  await tracker.recordMetering({
    buyerPeerId: 'buyer',
    providerName: 'codex',
    pricing,
    request: { requestId: 'r1', method: 'POST', path: '/v1/responses', headers: {}, body: new Uint8Array() },
    statusCode: 200,
    latencyMs: 10,
    inputBytes: 0,
    outputBytes: 0,
    responseBody: new Uint8Array(),
    providerUsage,
  });
  tracker.clearTimers();
  expect(receipts).toHaveLength(1);
  return receipts[0]!.costCents;
}

describe('seller receipt cost', () => {
  const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.1 };

  it('prices cached input at the cached rate, like the channel charge', async () => {
    // 10K fresh × $1/M + 90K cached × $0.1/M + 1K output × $10/M = $0.029.
    const cost = await receiptCost(pricing, { inputTokens: 100_000, outputTokens: 1_000, freshInputTokens: 10_000, cachedInputTokens: 90_000 });
    expect(cost).toBe(3);
  });

  it('takes fresh input as input minus cached when the usage leaves it out', async () => {
    const cost = await receiptCost(pricing, { inputTokens: 100_000, outputTokens: 1_000, cachedInputTokens: 90_000 });
    expect(cost).toBe(3);
  });

  it('prices cached input at the input rate when no cached rate is set', async () => {
    // 100K input × $1/M + 1K output × $10/M = $0.11.
    const cost = await receiptCost(
      { inputUsdPerMillion: 1, outputUsdPerMillion: 10 },
      { inputTokens: 100_000, outputTokens: 1_000, freshInputTokens: 10_000, cachedInputTokens: 90_000 },
    );
    expect(cost).toBe(11);
  });
});

describe('seller receipt for a request without a usage report', () => {
  const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
  const encoder = new TextEncoder();
  const screenshot = 'A'.repeat(1_000_000);
  const body = encoder.encode(JSON.stringify({
    model: 'test-model',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'What is on my screen?' },
      ...Array.from({ length: 10 }, () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot } })),
    ] }],
  }));

  async function record(statusCode: number, responseBody: Uint8Array) {
    const receipts: UsageReceipt[] = [];
    const tracker = track(receipts);
    await tracker.recordMetering({
      buyerPeerId: 'buyer',
      providerName: 'p',
      pricing,
      request: { requestId: 'r1', method: 'POST', path: '/v1/messages', headers: {}, body },
      statusCode,
      latencyMs: 10,
      inputBytes: body.length,
      outputBytes: responseBody.length,
      responseBody,
    });
    tracker.clearTimers();
    expect(receipts).toHaveLength(1);
    return receipts[0]!;
  }

  it('prices a failed request at nothing, however large its body', async () => {
    const receipt = await record(400, encoder.encode(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad image' } })));
    expect(receipt.tokens.totalTokens).toBe(0);
    expect(receipt.costCents).toBe(0);
  });

  it('counts each image of a delivered answer as a flat allowance, not by its base64 size', async () => {
    const receipt = await record(200, encoder.encode(JSON.stringify({ content: [{ type: 'text', text: 'A desktop.' }] })));
    // Ten 1 MB images by bytes would be about 2.5M tokens.
    expect(receipt.tokens.inputTokens).toBeGreaterThan(10 * 1_000);
    expect(receipt.tokens.inputTokens).toBeLessThan(20_000);
  });
});
