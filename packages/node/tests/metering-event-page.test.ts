import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MeteringStorage } from '../src/metering/storage.js';
import { summarizeErrorBody } from '../src/metering/seller-session-tracker.js';

function event(n: number, at: number, extra: { service?: string; buyer?: string; status?: number } = {}) {
  return {
    eventId: `e${n}`, sessionId: 's1', timestamp: at, provider: 'openai', sellerPeerId: 'seller', buyerPeerId: extra.buyer ?? 'buyer-a',
    tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15, method: 'provider-usage' as const, confidence: 'high' as const },
    latencyMs: 100 + n, statusCode: extra.status ?? 200, wasStreaming: false, ...(extra.service ? { service: extra.service } : {}),
  };
}

describe('metering request log page', () => {
  it('pages newest first by keyset, with ties on the same millisecond, filters and receipt cost', () => {
    const storage = new MeteringStorage(join(mkdtempSync(join(tmpdir(), 'metering-page-')), 'metering.db'));
    for (let n = 0; n < 7; n++) storage.insertEvent(event(n, 1_000 + Math.floor(n / 2), { service: n % 2 ? 'glm-5.3' : 'kimi-k3', buyer: n === 3 ? 'buyer-b' : 'buyer-a', status: n === 5 ? 402 : 200 }));
    storage.insertReceipt({ receiptId: 'r4', sessionId: 's1', eventId: 'e4', timestamp: 1_002, provider: 'openai', sellerPeerId: 'seller', buyerPeerId: 'buyer-a',
      tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15, method: 'provider-usage', confidence: 'high' }, unitPriceCentsPerThousandTokens: 1, costCents: 3, signature: '' });

    const seen: string[] = [];
    let before: { timestamp: number; rowid: number } | undefined;
    for (;;) {
      const page = storage.listEventsPage({ limit: 3, ...(before ? { before } : {}) });
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.event_id));
      const last = page.at(-1)!;
      before = { timestamp: last.timestamp, rowid: last.rowid };
    }
    expect(seen).toEqual(['e6', 'e5', 'e4', 'e3', 'e2', 'e1', 'e0']);
    expect(storage.listEventsPage({ limit: 10 }).find((row) => row.event_id === 'e4')!.cost_cents).toBe(3);
    expect(storage.listEventsPage({ limit: 10, service: 'glm-5.3' }).map((row) => row.event_id)).toEqual(['e5', 'e3', 'e1']);
    expect(storage.listEventsPage({ limit: 10, buyerPeerId: 'buyer-b' }).map((row) => row.event_id)).toEqual(['e3']);
    expect(storage.listEventsPage({ limit: 10, errorsOnly: true }).map((row) => [row.event_id, row.status_code])).toEqual([['e5', 402]]);
    expect(storage.listEventsPage({ limit: 10, fromMs: 1_003 }).map((row) => row.event_id)).toEqual(['e6']);
  });

  it('the event getters return service, error and cached input tokens, and leave them out on older rows', () => {
    const storage = new MeteringStorage(join(mkdtempSync(join(tmpdir(), 'metering-page-')), 'metering.db'));
    storage.insertEvent({ ...event(1, 1_000, { service: 'glm-5.3', status: 429 }), error: 'rate limited', cachedInputTokens: 0 });
    storage.insertEvent(event(2, 1_001));
    for (const events of [storage.getEventsBySession('s1'), storage.getEventsByTimeRange(0, 2_000)]) {
      expect([events[0]!.service, events[0]!.error, events[0]!.cachedInputTokens]).toEqual(['glm-5.3', 'rate limited', 0]);
      expect(['service', 'error', 'cachedInputTokens'].some((field) => field in events[1]!)).toBe(false);
    }
  });

  it('counts a stream that failed after its 200 as an error', () => {
    const storage = new MeteringStorage(join(mkdtempSync(join(tmpdir(), 'metering-page-')), 'metering.db'));
    storage.insertEvent(event(1, 1_000));
    storage.insertEvent({ ...event(2, 1_001), error: 'upstream stream reset' });
    storage.insertEvent(event(3, 1_002, { status: 500 }));
    expect(storage.listEventsPage({ limit: 10, errorsOnly: true }).map((row) => row.event_id)).toEqual(['e3', 'e2']);
  });

  it('walks the timestamp index without a sort or OFFSET (cheap at any depth)', () => {
    const storage = new MeteringStorage(join(mkdtempSync(join(tmpdir(), 'metering-page-')), 'metering.db'));
    const db = (storage as unknown as { db: { prepare(sql: string): { all(params: object): Array<{ detail: string }> } } }).db;
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT e.rowid FROM metering_events e INDEXED BY idx_events_timestamp
      LEFT JOIN usage_receipts r ON r.session_id = e.session_id AND r.event_id = e.event_id
      WHERE e.timestamp >= @from AND e.timestamp <= @ts AND NOT (e.timestamp = @ts AND e.rowid >= @rowid) AND e.service = @service
      ORDER BY e.timestamp DESC, e.rowid DESC LIMIT 50`).all({ from: 0, ts: 1, rowid: 1, service: 'x' }).map((row) => row.detail).join(' | ');
    expect(plan).toMatch(/idx_events_timestamp/);
    expect(plan).toMatch(/idx_receipts_session/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it('keeps a failed request\'s reason and cached tokens, and returns its receipt and session in the detail', () => {
    const storage = new MeteringStorage(join(mkdtempSync(join(tmpdir(), 'metering-page-')), 'metering.db'));
    storage.insertEvent(event(1, 1_000, { service: 'kimi-k3' }));
    storage.insertEvent({ ...event(2, 1_001, { service: 'kimi-k3', status: 429 }), error: 'quota reached', cachedInputTokens: 4 });
    storage.insertReceipt({ receiptId: 'r2', sessionId: 's1', eventId: 'e2', timestamp: 1_001, provider: 'openai', sellerPeerId: 'seller', buyerPeerId: 'buyer-a',
      tokens: { inputTokens: 10, outputTokens: 5, totalTokens: 15, method: 'provider-usage', confidence: 'high' }, unitPriceCentsPerThousandTokens: 2, costCents: 7, signature: 'sig' });

    expect(storage.listEventsPage({ limit: 10 })[0]).toMatchObject({ event_id: 'e2', error: 'quota reached', cached_input_tokens: 4 });
    expect(storage.getEventDetail('e2')).toMatchObject({
      event_id: 'e2', error: 'quota reached', cost_cents: 7, receipt_id: 'r2', unit_price_cents_per_thousand: 2,
      token_confidence: 'high', verification: null, session_position: 2,
    });
    expect(storage.getEventDetail('e1')).toMatchObject({ error: null, cached_input_tokens: null, receipt_id: null, session_position: 1 });
    expect(storage.getEventDetail('missing')).toBeNull();
    expect(storage.getEventDetail('e')!.event_id).toBe('e1');
  });

  it('summarizes an error body to its message', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(summarizeErrorBody(encode('{"error":{"message":"You have reached your 5-hour limit","code":429}}'))).toBe('You have reached your 5-hour limit');
    expect(summarizeErrorBody(encode('{"error":"Service \\"x\\" is not in the allowed list"}'))).toBe('Service "x" is not in the allowed list');
    expect(summarizeErrorBody(encode('upstream   timed out\n'))).toBe('upstream timed out');
    expect(summarizeErrorBody(encode(''))).toBeNull();
    expect(summarizeErrorBody(encode('x'.repeat(1000)))!.length).toBe(300);
  });
});
