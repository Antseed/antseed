import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
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

function caughtUpTotals(path: string) {
  const reader = new MeteringStorage(path, { readonly: true });
  try {
    let totals = advanceMeteringTotals(path, reader, 1_000);
    while (!totals.caughtUp) totals = advanceMeteringTotals(path, reader, 1_000);
    return totals;
  } finally {
    reader.close();
  }
}

test('advanceMeteringTotals starts over when the ledger file is replaced with one of equal or larger size', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-metrics-'));
  const path = join(dir, 'metering.db');
  try {
    const now = Date.now();
    const first = new MeteringStorage(path);
    for (let i = 0; i < 3; i += 1) insertEvent(first, `a${i}`, now, 10);
    first.close();
    assert.equal(caughtUpTotals(path).events.totalTokens, 30);

    for (const [count, tokens] of [[3, 7], [5, 1]] as const) {
      const next = join(dir, `next-${count}.db`);
      const replacement = new MeteringStorage(next);
      for (let i = 0; i < count; i += 1) insertEvent(replacement, `b${count}-${i}`, now, tokens);
      replacement.close();
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
      renameSync(next, path);
      const totals = caughtUpTotals(path);
      assert.equal(totals.events.requests, count);
      assert.equal(totals.events.totalTokens, count * tokens);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('advanceMeteringTotals starts over when the ledger is rebuilt in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-metrics-'));
  const path = join(dir, 'metering.db');
  const writer = new MeteringStorage(path);
  try {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) insertEvent(writer, `a${i}`, now, 10);
    assert.equal(caughtUpTotals(path).events.totalTokens, 30);

    // Same file, same rowids, different rows.
    writer.pruneOlderThan(now + 1);
    for (let i = 0; i < 3; i += 1) insertEvent(writer, `b${i}`, now, 2);
    const totals = caughtUpTotals(path);
    assert.equal(totals.events.requests, 3);
    assert.equal(totals.events.totalTokens, 6);
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
