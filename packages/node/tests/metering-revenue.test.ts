import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MeteringStorage } from '../src/metering/storage.js';
import { SellerSessionTracker } from '../src/metering/seller-session-tracker.js';
import { ReceiptGenerator } from '../src/metering/receipt-generator.js';
import type { Identity } from '../src/p2p/identity.js';

// Revenue a seller sees is the receipts' unrounded value, not the sum of their
// one-cent floors, and failed requests earn nothing (issue #1319).
function storage(): MeteringStorage {
  return new MeteringStorage(join(mkdtempSync(join(tmpdir(), 'metering-revenue-')), 'metering.db'));
}

function tracker(metering: MeteringStorage): SellerSessionTracker {
  return new SellerSessionTracker(
    { peerId: 'seller' } as Identity,
    metering,
    new ReceiptGenerator({ peerId: 'seller', sign: () => 'f'.repeat(128) }),
    {},
    { onSessionUpdated() {}, onSessionFinalized() {} },
  );
}

async function record(t: SellerSessionTracker, statusCode: number, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
  await t.recordMetering({
    buyerPeerId: 'buyer',
    providerName: 'openai',
    // $0.10/M input, $0.40/M output: every request here is worth well under a cent.
    pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 },
    request: { requestId: `r-${Math.random()}`, method: 'POST', path: '/v1/chat/completions', headers: {}, body: new Uint8Array() },
    statusCode,
    latencyMs: 10,
    inputBytes: 0,
    outputBytes: 0,
    responseBody: new Uint8Array(),
    providerUsage: usage,
  });
}

describe('seller revenue from metering', () => {
  it('sums sub-cent requests at their real value and leaves out failed ones, while each receipt keeps its one-cent floor', async () => {
    const metering = storage();
    const t = tracker(metering);
    // 10 paid requests of 2,000 in + 500 out = $0.0004 each, $0.004 in all.
    for (let i = 0; i < 10; i++) await record(t, 200, { inputTokens: 2_000, outputTokens: 500 });
    // 5 requests that failed before reaching the model: no buyer pays for them.
    for (let i = 0; i < 5; i++) await record(t, 400, { inputTokens: 2_000, outputTokens: 500 });
    t.clearTimers();

    const receipts = metering.getReceiptsByTimeRange(0, Number.MAX_SAFE_INTEGER);
    expect(receipts).toHaveLength(15);
    expect(receipts.every((receipt) => receipt.costCents === 1)).toBe(true);
    expect(metering.getTotalCost(0, Number.MAX_SAFE_INTEGER)).toBe(15);

    // $0.004 = 0.4 cents.
    expect(metering.getRevenueCents(0, Number.MAX_SAFE_INTEGER)).toBeCloseTo(0.4, 9);
    const chunk = metering.summarizeReceiptsAfter(0, 100);
    expect(chunk.days.reduce((sum, day) => sum + day.revenueCents, 0)).toBeCloseTo(0.4, 9);

    const rows = metering.listEventsPage({ limit: 100 }).rows;
    const paid = rows.find((row) => row.status_code === 200)!;
    const failed = rows.find((row) => row.status_code === 400)!;
    expect(paid.cost_cents).toBe(1);
    expect(paid.revenue_cents).toBeCloseTo(0.04, 9);
    expect(failed.cost_cents).toBe(1);
    expect(failed.revenue_cents).toBe(0);

    const detail = metering.getEventDetail(paid.event_id)!;
    expect(detail.revenue_cents).toBeCloseTo(0.04, 9);
    expect(detail.session!.total_cost_cents).toBe(15);
    expect(detail.session!.revenue_cents).toBeCloseTo(0.4, 9);
    metering.close();
  });

  it('keeps a request without a receipt at null and an empty range at 0', () => {
    const metering = storage();
    metering.insertEvent({
      eventId: 'e1', sessionId: 's1', timestamp: 1_000, provider: 'openai', sellerPeerId: 'seller', buyerPeerId: 'buyer',
      tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15, method: 'provider-usage', confidence: 'high' },
      latencyMs: 10, statusCode: 200, wasStreaming: false,
    });
    expect(metering.listEventsPage({ limit: 10 }).rows[0]!.revenue_cents).toBeNull();
    expect(metering.getRevenueCents(0, 10_000)).toBe(0);
    metering.close();
  });
});
