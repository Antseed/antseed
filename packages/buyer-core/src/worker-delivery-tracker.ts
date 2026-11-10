import { buyerFault } from './errors.js';
import type { WorkerUsage } from './worker-e2e.js';

const MAX_WORKER_DELIVERIES = 512;
/**
 * Worker requests per seller whose delivery record was evicted unpaid. Their
 * ids are kept (across sessions) so a late NeedAuth for one is still refused;
 * past this many the buyer stops sending that seller worker requests rather
 * than forget one.
 */
const MAX_FORGOTTEN_WORKER_REQUESTS = 16_384;
/**
 * Worker requests per seller that were verified and paid (or verified and
 * free), kept so a later NeedAuth claiming one again is refused. Oldest first
 * out; they never count toward MAX_FORGOTTEN_WORKER_REQUESTS.
 */
const MAX_COMPLETED_WORKER_REQUESTS = 16_384;
/**
 * Worker requests per seller that verified but are not yet fully signed: not
 * counted yet, or counted with a remainder (a NeedAuth or post-response
 * signing capped at the reserve ceiling). They are never evicted: their cost
 * is still owed to their worker. Past this many the buyer stops sending that
 * seller worker requests.
 */
const MAX_OWED_WORKER_REQUESTS = 4_096;
/** Per pool seller: its other (non-worker) requests a NeedAuth may name, oldest dropped first. */
const MAX_POOL_SELLER_REQUESTS = 16_384;

/**
 * A request encrypted to a colony-pool worker: pending until the buyer has
 * checked the worker's sealed answer, then verified (with the usage the worker
 * authenticated) or failed. Only a verified answer is paid for.
 */
export interface WorkerDelivery {
  sellerPeerId: string;
  /** The workers the request was encrypted for (lowercase); only one of them can answer. */
  recipients: string[];
  /** The recipient whose sealed answer verified: its signed amount is attributed to it. */
  worker?: string;
  state: 'pending' | 'verified' | 'failed';
  /** Sent as a free request: a verified answer owes nothing. */
  free?: boolean;
  usage?: WorkerUsage;
  waiters: Array<() => void>;
}

/**
 * What a buyer knows about the requests it sent colony-pool sellers
 * (docs/protocol/colony-pool.md, "Payment for pool requests"): each worker
 * request's delivery, the worker requests it retired (paid, or evicted
 * unpaid), and the other requests it sent pool sellers. It lives as long as
 * the node, not a payment session, so a pool cannot get a request paid on a
 * later channel that this one refused. Pricing and signing decisions stay
 * with the payment manager.
 */
export class WorkerDeliveryTracker {
  /** requestId -> whether the worker's sealed answer verified. */
  private readonly _deliveries = new Map<string, WorkerDelivery>();
  /** sellerPeerId -> worker requests evicted from _deliveries before they were paid; never paid. */
  private readonly _forgotten = new Map<string, Set<string>>();
  /** sellerPeerId -> worker requests retired verified (paid in full, or free); not paid again. */
  private readonly _completed = new Map<string, Set<string>>();
  /** Sellers announcing colony-pool workers: a delivered cost they claim must name a request the buyer sent them. */
  private readonly _workerSellers = new Set<string>();
  /** pool seller -> requests the buyer sent it that went to an ordinary provider (not encrypted to a worker). */
  private readonly _poolSellerRequests = new Map<string, Set<string>>();
  /**
   * sellerPeerId -> its verified paid (not free) records: the only ones that
   * can be owed, so the owed limits read these instead of every record. A
   * record paid in full is usually retired at once, so they are few.
   */
  private readonly _verifiedPaid = new Map<string, Set<string>>();
  private _verifiedPaidCount = 0;

  /**
   * `owes(requestId)` tells whether a request's cost is not yet fully signed:
   * not counted yet, or counted with a remainder (the payment manager's
   * accounting). Such a verified record stays until it is paid in full:
   * evicting it as completed would refuse its cost and lose its worker's
   * attribution.
   */
  constructor(private readonly _owes: (requestId: string) => boolean = () => false) {}

  /** A verified paid answer whose cost is not yet fully signed. */
  private _owed(requestId: string, delivery: WorkerDelivery): boolean {
    return delivery.state === 'verified' && !delivery.free && this._owes(requestId);
  }

  /** Keep `_verifiedPaid` in step with a live record's state and free flag. */
  private _index(requestId: string, delivery: WorkerDelivery, live = true): void {
    const verifiedPaid = live && delivery.state === 'verified' && !delivery.free;
    let ids = this._verifiedPaid.get(delivery.sellerPeerId);
    if (verifiedPaid && !ids?.has(requestId)) {
      if (!ids) {
        ids = new Set();
        this._verifiedPaid.set(delivery.sellerPeerId, ids);
      }
      ids.add(requestId);
      this._verifiedPaidCount += 1;
    } else if (!verifiedPaid && ids?.delete(requestId)) {
      this._verifiedPaidCount -= 1;
      if (ids.size === 0) this._verifiedPaid.delete(delivery.sellerPeerId);
    }
  }

  private _countOwed(ids: Iterable<string>): number {
    let owed = 0;
    for (const id of ids) if (this._owes(id)) owed += 1;
    return owed;
  }

  /** Records whose cost is not yet fully signed, across sellers. */
  private _owedCount(): number {
    let owed = 0;
    for (const ids of this._verifiedPaid.values()) owed += this._countOwed(ids);
    return owed;
  }

  get(requestId: string): WorkerDelivery | undefined {
    return this._deliveries.get(requestId);
  }

  /** The worker to credit for `requestId`: only for the seller it went to, and only once its answer verified. */
  verifiedWorker(requestId: string | undefined, sellerPeerId: string | undefined): string | undefined {
    const delivery = requestId != null ? this._deliveries.get(requestId) : undefined;
    return delivery && delivery.sellerPeerId === sellerPeerId && delivery.state === 'verified' ? delivery.worker : undefined;
  }

  /** A request was encrypted for these pool workers; it is pending until recordDelivery. */
  recordAttribution(sellerPeerId: string, requestId: string, workers: string | readonly string[], free = false): void {
    this._workerSellers.add(sellerPeerId);
    this._poolSellerRequests.get(sellerPeerId)?.delete(requestId);
    const recipients = (typeof workers === 'string' ? [workers] : [...workers]).map((w) => w.toLowerCase());
    // A retry on other workers starts over; NeedAuths already waiting keep waiting.
    const delivery = this._deliveries.get(requestId);
    if (delivery && delivery.sellerPeerId === sellerPeerId) {
      delivery.recipients = recipients;
      delivery.free = free;
      delete delivery.worker;
      delivery.state = 'pending';
      delete delivery.usage;
      this._index(requestId, delivery);
      return;
    }
    if ((this._forgotten.get(sellerPeerId)?.size ?? 0) >= MAX_FORGOTTEN_WORKER_REQUESTS) {
      throw buyerFault(
        `[BuyerPayment] Too many unpaid colony-pool requests to ${sellerPeerId.slice(0, 12)}...; refusing further worker requests to it`,
        'buyer-session-state',
      );
    }
    const sellerVerifiedPaid = this._verifiedPaid.get(sellerPeerId);
    if ((sellerVerifiedPaid?.size ?? 0) >= MAX_OWED_WORKER_REQUESTS && this._countOwed(sellerVerifiedPaid!) >= MAX_OWED_WORKER_REQUESTS) {
      throw buyerFault(
        `[BuyerPayment] Too many partly paid colony-pool requests to ${sellerPeerId.slice(0, 12)}...; refusing further worker requests to it until the reserve grows`,
        'buyer-session-state',
      );
    }
    // The same request retried through another seller: the first seller's record is retired, not dropped.
    if (delivery) this.retire(requestId);
    // Owed records don't take cache room: they are bounded per seller above.
    if (
      this._deliveries.size - this._verifiedPaidCount >= MAX_WORKER_DELIVERIES
      || this._deliveries.size - this._owedCount() >= MAX_WORKER_DELIVERIES
    ) this._evict();
    // The buyer is sending this id again: the new record gates its payment from here on.
    this._forgotten.get(sellerPeerId)?.delete(requestId);
    this._completed.get(sellerPeerId)?.delete(requestId);
    this._deliveries.set(requestId, { sellerPeerId, recipients, state: 'pending', free, waiters: [] });
  }

  /**
   * The seller covered `requestId` from a free allowance: its verified answer
   * owes nothing, so it no longer counts toward the owed limit and can be
   * retired (as completed, so a later NeedAuth naming it is still refused).
   */
  markFree(sellerPeerId: string, requestId: string): void {
    const delivery = this._deliveries.get(requestId);
    if (delivery?.sellerPeerId !== sellerPeerId) return;
    delivery.free = true;
    this._index(requestId, delivery);
  }

  /**
   * Make room by retiring the oldest verified record that owes nothing (paid
   * in full, or free), else the oldest failed one, else the oldest pending
   * one. A verified record whose cost is not fully signed is never evicted. Retiring never
   * forgets it was a worker request (see retire).
   */
  private _evict(): void {
    let failed: string | undefined;
    let pending: string | undefined;
    for (const [requestId, delivery] of this._deliveries) {
      if (delivery.state === 'verified') {
        if (this._owed(requestId, delivery)) continue;
        return this.retire(requestId);
      }
      if (delivery.state === 'failed') failed ??= requestId;
      else pending ??= requestId;
    }
    const victim = failed ?? pending;
    if (victim !== undefined) this.retire(victim);
  }

  /**
   * Drop a delivery record, keeping its id so a later NeedAuth naming it is
   * refused rather than validated as an ordinary request: a verified answer
   * joins the seller's completed set (it was paid, or was free), anything
   * else the forgotten set, which counts toward MAX_FORGOTTEN_WORKER_REQUESTS.
   */
  retire(requestId: string): void {
    const delivery = this._deliveries.get(requestId);
    if (!delivery) return;
    const verified = delivery.state === 'verified';
    if (!verified) this._settle(requestId, 'failed');
    this._index(requestId, delivery, false);
    this._deliveries.delete(requestId);
    const sets = verified ? this._completed : this._forgotten;
    let ids = sets.get(delivery.sellerPeerId);
    if (!ids) {
      ids = new Set();
      sets.set(delivery.sellerPeerId, ids);
    }
    ids.add(requestId);
    if (verified && ids.size > MAX_COMPLETED_WORKER_REQUESTS) {
      ids.delete(ids.values().next().value!);
    }
  }

  /** The seller announces colony-pool workers (see BuyerPaymentManager.markWorkerSeller). */
  markSeller(sellerPeerId: string): void {
    this._workerSellers.add(sellerPeerId);
  }

  isWorkerSeller(sellerPeerId: string): boolean {
    return this._workerSellers.has(sellerPeerId);
  }

  /** The buyer sent a pool seller a request that is not encrypted to a worker (an ordinary provider of that seller). */
  trackPoolSellerRequest(sellerPeerId: string, requestId: string): void {
    this._workerSellers.add(sellerPeerId);
    // The buyer is sending this id again, now not to a worker: this attempt gates its payment
    // from here on (as recordAttribution does for a worker attempt).
    const delivery = this._deliveries.get(requestId);
    if (delivery?.sellerPeerId === sellerPeerId) {
      this._settle(requestId, 'failed');
      this._index(requestId, delivery, false);
      this._deliveries.delete(requestId);
    }
    this._forgotten.get(sellerPeerId)?.delete(requestId);
    this._completed.get(sellerPeerId)?.delete(requestId);
    let ids = this._poolSellerRequests.get(sellerPeerId);
    if (!ids) {
      ids = new Set();
      this._poolSellerRequests.set(sellerPeerId, ids);
    }
    ids.delete(requestId);
    ids.add(requestId);
    if (ids.size > MAX_POOL_SELLER_REQUESTS) ids.delete(ids.values().next().value!);
  }

  /**
   * A pool seller's claim for a request the buyer cannot tie to anything it
   * sent that seller. Worker requests (live, forgotten or completed) are
   * judged by their own checks, so they are not untracked here.
   */
  isUntrackedPoolSellerClaim(sellerPeerId: string, requestId: string | undefined, delivery: WorkerDelivery | undefined): boolean {
    if (!this._workerSellers.has(sellerPeerId)) return false;
    if (requestId == null || requestId === '') return true;
    if (delivery) return false;
    if (this.isForgotten(sellerPeerId, requestId) || this.isCompleted(sellerPeerId, requestId)) return false;
    return !(this._poolSellerRequests.get(sellerPeerId)?.has(requestId) ?? false);
  }

  isForgotten(sellerPeerId: string, requestId: string | undefined): boolean {
    return requestId != null && (this._forgotten.get(sellerPeerId)?.has(requestId) ?? false);
  }

  isCompleted(sellerPeerId: string, requestId: string | undefined): boolean {
    return requestId != null && (this._completed.get(sellerPeerId)?.has(requestId) ?? false);
  }

  /**
   * The buyer checked the worker's sealed answer: `usage` is what the
   * answering `worker` authenticated, or null when it did not verify. An answer
   * from a worker the request was not encrypted for (or, with several
   * recipients, an unnamed one) counts as failed.
   */
  recordDelivery(requestId: string, usage: WorkerUsage | null, worker?: string | null): void {
    const delivery = this._deliveries.get(requestId);
    const answered = worker?.toLowerCase() ?? (delivery?.recipients.length === 1 ? delivery.recipients[0] : undefined);
    if (usage && delivery && answered && delivery.recipients.includes(answered)) {
      this._settle(requestId, 'verified', usage, answered);
    } else {
      this._settle(requestId, 'failed');
    }
  }

  private _settle(requestId: string, state: 'verified' | 'failed', usage?: WorkerUsage, worker?: string): void {
    const delivery = this._deliveries.get(requestId);
    if (!delivery) return;
    delivery.state = state;
    if (usage) delivery.usage = usage;
    if (worker) delivery.worker = worker;
    this._index(requestId, delivery);
    const waiters = delivery.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  /** The request's delivery once it is no longer pending (or the wait ran out); undefined for other requests. */
  async awaitDelivery(sellerPeerId: string, requestId: string, timeoutMs: number): Promise<WorkerDelivery | undefined> {
    const delivery = this._deliveries.get(requestId);
    // Another seller's request is refused at once; there is nothing to wait for.
    if (!delivery || delivery.state !== 'pending' || delivery.sellerPeerId !== sellerPeerId) return delivery;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = delivery.waiters.indexOf(done);
        if (index >= 0) delivery.waiters.splice(index, 1);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      delivery.waiters.push(done);
    });
    return delivery;
  }
}
