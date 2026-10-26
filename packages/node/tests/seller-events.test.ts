import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendSellerEvent, readSellerEvents, SELLER_EVENTS_MAX_BYTES, type SellerEvent } from '../src/health/seller-events.js';

const event = (at: number, title = `event ${at}`): SellerEvent => ({ at, kind: 'model_down', severity: 'warning', title });

describe('seller events journal', () => {
  it('appends events and reads them newest first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seller-events-'));
    for (const at of [1, 2, 3]) await appendSellerEvent(dir, event(at));
    expect((await readSellerEvents(dir)).map((e) => e.at)).toEqual([3, 2, 1]);
    expect((await readSellerEvents(dir, 2)).map((e) => e.at)).toEqual([3, 2]);
  });

  it('is empty without a journal and skips a torn last line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seller-events-'));
    expect(await readSellerEvents(dir)).toEqual([]);
    await appendSellerEvent(dir, event(1));
    appendFileSync(join(dir, 'seller-events.jsonl'), '{"at":2,"kind":"mod');
    expect((await readSellerEvents(dir)).map((e) => e.at)).toEqual([1]);
  });

  it('rotates past the size cap and still reads across both files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seller-events-'));
    writeFileSync(join(dir, 'seller-events.jsonl'), `${JSON.stringify(event(1, 'x'.repeat(SELLER_EVENTS_MAX_BYTES)))}\n`);
    await appendSellerEvent(dir, event(2));
    expect(existsSync(join(dir, 'seller-events.1.jsonl'))).toBe(true);
    expect(readFileSync(join(dir, 'seller-events.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1);
    expect((await readSellerEvents(dir)).map((e) => e.at)).toEqual([2, 1]);
  });

  it('rotates once when writers overlap, keeping the old history and both new events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seller-events-'));
    writeFileSync(join(dir, 'seller-events.jsonl'), `${JSON.stringify(event(1, 'x'.repeat(SELLER_EVENTS_MAX_BYTES)))}\n`);
    await Promise.all([appendSellerEvent(dir, event(2)), appendSellerEvent(dir, event(3))]);
    expect((await readSellerEvents(dir)).map((e) => e.at)).toEqual([3, 2, 1]);
  });
});
