import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MeteringStorage } from '@antseed/node/metering';
import { advanceMeteringTotals } from './metrics.js';

function insertEvent(storage: MeteringStorage, id: string, timestamp: number, totalTokens: number): void {
  storage.insertEvent({
    eventId: id,
    sessionId: 's',
    timestamp,
    provider: 'openai',
    sellerPeerId: 'seller',
    buyerPeerId: 'buyer',
    tokens: { inputTokens: totalTokens, outputTokens: 0, totalTokens, method: 'content-length', confidence: 'high' },
    latencyMs: 1,
    statusCode: 200,
    wasStreaming: false,
  });
}

test('advanceMeteringTotals reads the ledger a chunk at a time and reports when caught up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-metrics-'));
  const path = join(dir, 'metering.db');
  const writer = new MeteringStorage(path);
  try {
    const now = Date.now();
    for (let i = 0; i < 5; i += 1) insertEvent(writer, `e${i}`, now, 10);

    const reader = new MeteringStorage(path, { readonly: true });
    try {
      let totals = advanceMeteringTotals(path, reader, 2);
      assert.equal(totals.caughtUp, false);
      assert.equal(totals.events.requests, 2);
      totals = advanceMeteringTotals(path, reader, 2);
      totals = advanceMeteringTotals(path, reader, 2);
      assert.equal(totals.caughtUp, true);
      assert.equal(totals.events.requests, 5);
      assert.equal(totals.events.totalTokens, 50);
      assert.equal(totals.eventDays.get(Math.floor(now / 86_400_000))?.requests, 5);

      insertEvent(writer, 'e5', now, 10);
      totals = advanceMeteringTotals(path, reader, 2);
      assert.equal(totals.caughtUp, true);
      assert.equal(totals.events.requests, 6);
    } finally {
      reader.close();
    }
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
