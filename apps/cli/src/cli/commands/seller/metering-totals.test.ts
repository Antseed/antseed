import assert from 'node:assert/strict';
import test from 'node:test';
import { METERING_SETTLE_MS, MeteringTotals } from '../metering-totals.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A fake metering DB: one event (1 request, 10 tokens, 2 cents, 1 session) per timestamp. */
function fakeMetering(timestamps: number[]) {
  const queries: Array<[number, number]> = [];
  const inRange = (start: number, end: number) => timestamps.filter((ts) => ts >= start && ts < end).length;
  return {
    queries,
    open: () => ({
      getEventTokenSummary: (start: number, end: number) => {
        queries.push([start, end]);
        const n = inRange(start, end);
        return { totalRequests: n, totalTokens: 10 * n, inputTokens: 6 * n, outputTokens: 4 * n };
      },
      getSessionSummary: (start: number, end: number) => ({ channelCount: inRange(start, end), totalRequests: 0, totalTokens: 0, totalCostCents: 0 }),
      getTotalCost: (start: number, end: number) => 2 * inRange(start, end),
      close: () => {},
    }),
  };
}

test('counts history once, then only the new rows, with today split at UTC midnight', async () => {
  const day = 400 * DAY;
  const rows = [day - 3 * DAY, day - HOUR, day + 2 * HOUR, day + 5 * HOUR];
  const db = fakeMetering(rows);
  const totals = new MeteringTotals();
  assert.equal(totals.snapshot(), null);

  await totals.refresh(db.open, day + 6 * HOUR + METERING_SETTLE_MS);
  let snap = totals.snapshot()!;
  assert.equal(snap.total.requests, 4);
  assert.equal(snap.today.requests, 2);
  assert.equal(snap.total.receiptCents, 8);
  assert.equal(snap.coveredTo, day + 6 * HOUR);
  // Every query covers at most one hour once past the one-shot backfill.
  assert.ok(db.queries.slice(1).every(([start, end]) => end - start <= HOUR && Math.floor(start / HOUR) === Math.floor((end - 1) / HOUR)));

  rows.push(day + 6 * HOUR + 10, day + DAY + HOUR);
  db.queries.length = 0;
  await totals.refresh(db.open, day + 7 * HOUR + METERING_SETTLE_MS);
  snap = totals.snapshot()!;
  assert.equal(snap.total.requests, 5);
  assert.equal(snap.today.requests, 3);
  assert.deepEqual(db.queries, [[day + 6 * HOUR, day + 7 * HOUR]]);

  await totals.refresh(db.open, day + DAY + 2 * HOUR + METERING_SETTLE_MS);
  snap = totals.snapshot()!;
  assert.equal(snap.total.requests, 6);
  assert.equal(snap.today.requests, 1, 'a new UTC day starts today over');
  assert.equal(snap.total.tokens, 60);
});

test('overlapping refreshes share one pass', async () => {
  const db = fakeMetering([]);
  const totals = new MeteringTotals();
  const first = totals.refresh(db.open, 10 * DAY);
  assert.equal(totals.refresh(db.open, 10 * DAY), first);
  await first;
  assert.notEqual(totals.snapshot(), null);
});
