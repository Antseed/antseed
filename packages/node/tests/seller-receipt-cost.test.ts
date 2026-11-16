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
