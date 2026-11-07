import { describe, expect, it } from 'vitest';
import { WorkerDeliveryTracker } from './worker-delivery-tracker.js';

const SELLER = 'seller-a';
const OTHER = 'seller-b';
const W1 = '0xAAAA';
const W2 = '0xBBBB';
const usage = { inputTokens: 10n, cachedInputTokens: 0n, outputTokens: 5n };

describe('WorkerDeliveryTracker', () => {
  it('credits only the recipient whose answer verified, and only for its seller', () => {
    const tracker = new WorkerDeliveryTracker();
    tracker.recordAttribution(SELLER, 'r1', [W1, W2]);
    expect(tracker.get('r1')?.state).toBe('pending');
    expect(tracker.verifiedWorker('r1', SELLER)).toBeUndefined();

    tracker.recordDelivery('r1', usage, W2);
    expect(tracker.get('r1')).toMatchObject({ state: 'verified', worker: W2.toLowerCase(), usage });
    expect(tracker.verifiedWorker('r1', SELLER)).toBe(W2.toLowerCase());
    expect(tracker.verifiedWorker('r1', OTHER)).toBeUndefined();
  });

  it('fails an answer from a non-recipient, or an unnamed one with several recipients', () => {
    const tracker = new WorkerDeliveryTracker();
    tracker.recordAttribution(SELLER, 'r1', [W1, W2]);
    tracker.recordDelivery('r1', usage, '0xCCCC');
    expect(tracker.get('r1')?.state).toBe('failed');

    tracker.recordAttribution(SELLER, 'r2', [W1, W2]);
    tracker.recordDelivery('r2', usage);
    expect(tracker.get('r2')?.state).toBe('failed');

    // With one recipient, an unnamed answer is that recipient's.
    tracker.recordAttribution(SELLER, 'r3', W1);
    tracker.recordDelivery('r3', usage);
    expect(tracker.verifiedWorker('r3', SELLER)).toBe(W1.toLowerCase());
  });

  it('retires verified requests as completed and others as forgotten, never as unknown', () => {
    const tracker = new WorkerDeliveryTracker();
    tracker.recordAttribution(SELLER, 'paid', W1);
    tracker.recordDelivery('paid', usage, W1);
    tracker.retire('paid');
    tracker.recordAttribution(SELLER, 'failed', W1);
    tracker.recordDelivery('failed', null);
    tracker.retire('failed');

    expect(tracker.get('paid')).toBeUndefined();
    expect(tracker.isCompleted(SELLER, 'paid')).toBe(true);
    expect(tracker.isForgotten(SELLER, 'failed')).toBe(true);
    // Neither is an untracked claim: their own checks refuse them.
    expect(tracker.isUntrackedPoolSellerClaim(SELLER, 'paid', undefined)).toBe(false);
    expect(tracker.isUntrackedPoolSellerClaim(SELLER, 'failed', undefined)).toBe(false);
  });

  it('evicts verified records first, then failed, then pending, keeping their ids', () => {
    const tracker = new WorkerDeliveryTracker();
    tracker.recordAttribution(SELLER, 'pending-0', W1);
    tracker.recordAttribution(SELLER, 'failed-0', W1);
    tracker.recordDelivery('failed-0', null);
    for (let i = 0; i < 509; i++) tracker.recordAttribution(SELLER, `p${i}`, W1);
    tracker.recordAttribution(SELLER, 'verified-0', W1);
    tracker.recordDelivery('verified-0', usage, W1);
    // The cache holds 512; the next record evicts the verified one, then the failed one.
    tracker.recordAttribution(SELLER, 'next-1', W1);
    expect(tracker.isCompleted(SELLER, 'verified-0')).toBe(true);
    tracker.recordAttribution(SELLER, 'next-2', W1);
    expect(tracker.isForgotten(SELLER, 'failed-0')).toBe(true);
    tracker.recordAttribution(SELLER, 'next-3', W1);
    expect(tracker.isForgotten(SELLER, 'pending-0')).toBe(true);
    expect(tracker.get('p0')?.state).toBe('pending');
  });

  it('treats a pool seller\'s claim with no id, or an id it was never sent, as untracked', () => {
    const tracker = new WorkerDeliveryTracker();
    expect(tracker.isUntrackedPoolSellerClaim(SELLER, undefined, undefined)).toBe(false);
    tracker.markSeller(SELLER);
    expect(tracker.isWorkerSeller(SELLER)).toBe(true);
    expect(tracker.isUntrackedPoolSellerClaim(SELLER, undefined, undefined)).toBe(true);
    expect(tracker.isUntrackedPoolSellerClaim(SELLER, '', undefined)).toBe(true);
    expect(tracker.isUntrackedPoolSellerClaim(SELLER, 'invented', undefined)).toBe(true);
    tracker.trackPoolSellerRequest(SELLER, 'ordinary');
    expect(tracker.isUntrackedPoolSellerClaim(SELLER, 'ordinary', undefined)).toBe(false);
    // Another seller's ordinary request is not this one's.
    expect(tracker.isUntrackedPoolSellerClaim(OTHER, 'ordinary', undefined)).toBe(false);
    tracker.markSeller(OTHER);
    expect(tracker.isUntrackedPoolSellerClaim(OTHER, 'ordinary', undefined)).toBe(true);
  });

  it('lets a re-sent id start over: as an ordinary request it drops the worker record', () => {
    const tracker = new WorkerDeliveryTracker();
    tracker.recordAttribution(SELLER, 'r1', W1);
    tracker.recordDelivery('r1', null);
    tracker.trackPoolSellerRequest(SELLER, 'r1');
    expect(tracker.get('r1')).toBeUndefined();
    expect(tracker.isUntrackedPoolSellerClaim(SELLER, 'r1', undefined)).toBe(false);
    // Sent again to a worker, it is pending again and no longer an ordinary request.
    tracker.recordAttribution(SELLER, 'r1', W2);
    expect(tracker.get('r1')?.state).toBe('pending');
  });

  it('retries on other workers through the same seller reset the record to pending', () => {
    const tracker = new WorkerDeliveryTracker();
    tracker.recordAttribution(SELLER, 'r1', W1);
    tracker.recordDelivery('r1', usage, W1);
    tracker.recordAttribution(SELLER, 'r1', W2);
    expect(tracker.get('r1')).toMatchObject({ state: 'pending', recipients: [W2.toLowerCase()] });
    expect(tracker.get('r1')?.worker).toBeUndefined();
  });

  it('retires the first seller\'s record when the same id goes to another seller', () => {
    const tracker = new WorkerDeliveryTracker();
    tracker.recordAttribution(SELLER, 'r1', W1);
    tracker.recordAttribution(OTHER, 'r1', W2);
    expect(tracker.isForgotten(SELLER, 'r1')).toBe(true);
    expect(tracker.get('r1')?.sellerPeerId).toBe(OTHER);
  });

  it('waits for a pending delivery, returns at once for another seller, and gives up after the timeout', async () => {
    const tracker = new WorkerDeliveryTracker();
    tracker.recordAttribution(SELLER, 'r1', W1);
    const waiting = tracker.awaitDelivery(SELLER, 'r1', 5_000);
    tracker.recordDelivery('r1', usage, W1);
    expect((await waiting)?.state).toBe('verified');

    tracker.recordAttribution(SELLER, 'r2', W1);
    expect((await tracker.awaitDelivery(OTHER, 'r2', 5_000))?.state).toBe('pending');
    expect((await tracker.awaitDelivery(SELLER, 'r2', 10))?.state).toBe('pending');
    expect(tracker.get('r2')?.waiters).toHaveLength(0);
    expect(await tracker.awaitDelivery(SELLER, 'unknown', 10)).toBeUndefined();
  });

  it('refuses new worker requests to a seller once too many went unpaid', () => {
    const tracker = new WorkerDeliveryTracker();
    for (let i = 0; i < 16_384; i++) {
      tracker.recordAttribution(SELLER, `u${i}`, W1);
      tracker.retire(`u${i}`);
    }
    expect(() => tracker.recordAttribution(SELLER, 'one-more', W1)).toThrow(/Too many unpaid colony-pool requests/);
    // Another seller is unaffected.
    expect(() => tracker.recordAttribution(OTHER, 'one-more', W1)).not.toThrow();
  });

  it('never evicts a verified request whose counted cost is not fully signed', () => {
    const owed = new Set<string>(['capped']);
    const tracker = new WorkerDeliveryTracker((id) => owed.has(id));
    tracker.recordAttribution(SELLER, 'capped', W1);
    tracker.recordDelivery('capped', usage, W1);
    tracker.recordAttribution(SELLER, 'paid', W1);
    tracker.recordDelivery('paid', usage, W1);
    // Fill well past the cache: the owed record stays, the paid one is retired as completed.
    for (let i = 0; i < 1_000; i++) tracker.recordAttribution(SELLER, `n${i}`, W1);
    expect(tracker.isCompleted(SELLER, 'paid')).toBe(true);
    expect(tracker.isCompleted(SELLER, 'capped')).toBe(false);
    expect(tracker.verifiedWorker('capped', SELLER)).toBe(W1.toLowerCase());
    expect(tracker.get('capped')?.usage).toEqual(usage);
    // Once paid in full it is evictable like any verified record.
    owed.delete('capped');
    tracker.recordAttribution(SELLER, 'after', W1);
    expect(tracker.isCompleted(SELLER, 'capped')).toBe(true);
  });

  it('does not let owed records take cache room from other requests', () => {
    const owed = new Set<string>();
    const tracker = new WorkerDeliveryTracker((id) => owed.has(id));
    for (let i = 0; i < 600; i++) {
      tracker.recordAttribution(SELLER, `o${i}`, W1);
      tracker.recordDelivery(`o${i}`, usage, W1);
      owed.add(`o${i}`);
    }
    // 600 owed records plus a full cache of pending ones: the pending ones evict each other, not the owed.
    for (let i = 0; i < 512; i++) tracker.recordAttribution(OTHER, `p${i}`, W1);
    tracker.recordAttribution(OTHER, 'p-next', W1);
    expect(tracker.isForgotten(OTHER, 'p0')).toBe(true);
    expect(tracker.get('p1')?.state).toBe('pending');
    for (let i = 0; i < 600; i++) expect(tracker.get(`o${i}`)?.state).toBe('verified');
  });

  it('refuses new worker requests to a seller with too many partly paid requests, not to others', () => {
    const tracker = new WorkerDeliveryTracker(() => true);
    for (let i = 0; i < 4_096; i++) {
      tracker.recordAttribution(SELLER, `o${i}`, W1);
      tracker.recordDelivery(`o${i}`, usage, W1);
    }
    expect(() => tracker.recordAttribution(SELLER, 'one-more', W1)).toThrow(/Too many partly paid colony-pool requests/);
    expect(() => tracker.recordAttribution(OTHER, 'one-more', W1)).not.toThrow();
    // None was retired to make room.
    expect(tracker.get('o0')?.state).toBe('verified');
  });
});
