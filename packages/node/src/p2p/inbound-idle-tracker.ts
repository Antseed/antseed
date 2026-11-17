import type { PeerId } from "../types/peer.js";

/** How long a seller keeps an inbound buyer connection with no traffic and nothing open on it. */
export const DEFAULT_INBOUND_IDLE_TIMEOUT_MS = 30 * 60_000;
/**
 * How long a seller keeps an idle connection whose buyer has only a free usage
 * session open. Free buyers are the many that connect once and stay away, so
 * without an end a seller's connection count grows for as long as it runs.
 */
export const FREE_SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60_000;

interface Tracked {
  conn: { close(): void };
  lastActivityAt: number;
  inFlight: number;
}

export interface InboundIdleTrackerOptions {
  idleTimeoutMs: number;
  /**
   * How long an idle connection is kept for what the buyer has open on it, when
   * that is longer than `idleTimeoutMs`. Infinity for a paid channel: closing
   * the connection would end it, and its own idle timers do that. A fixed time
   * for a free usage session, which the buyer opens again when it returns. 0
   * for a buyer with nothing open.
   */
  sessionHoldMs: (peerId: PeerId) => number;
  now?: () => number;
}

/**
 * Seller side: closes inbound buyer connections that have carried no traffic
 * for `idleTimeoutMs`. A buyer keeps its connection open between requests and
 * pings it to keep it alive, so without this a seller holds one connection per
 * buyer that ever connected. Keepalive frames are not traffic.
 */
export class InboundIdleTracker {
  private readonly _tracked = new Map<PeerId, Tracked>();
  private readonly _now: () => number;

  constructor(private readonly _options: InboundIdleTrackerOptions) {
    this._now = _options.now ?? Date.now;
  }

  track(peerId: PeerId, conn: { close(): void }): void {
    this._tracked.set(peerId, { conn, lastActivityAt: this._now(), inFlight: 0 });
  }

  /** Stops tracking, unless a newer connection from the same buyer replaced `conn`. */
  untrack(peerId: PeerId, conn: { close(): void }): void {
    if (this._tracked.get(peerId)?.conn === conn) this._tracked.delete(peerId);
  }

  touch(peerId: PeerId): void {
    const entry = this._tracked.get(peerId);
    if (entry) entry.lastActivityAt = this._now();
  }

  /** Marks work in progress (a request being served); the connection is not idle until the returned callback runs. */
  begin(peerId: PeerId): () => void {
    const entry = this._tracked.get(peerId);
    if (!entry) return () => {};
    entry.inFlight += 1;
    entry.lastActivityAt = this._now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.inFlight -= 1;
      entry.lastActivityAt = this._now();
    };
  }

  /** Closes every connection idle for longer than its buyer's session holds it; returns the buyers closed. */
  sweep(): PeerId[] {
    const now = this._now();
    const closed: PeerId[] = [];
    for (const [peerId, entry] of this._tracked) {
      const idleMs = now - entry.lastActivityAt;
      if (entry.inFlight > 0 || idleMs < this._options.idleTimeoutMs) continue;
      if (idleMs < this._options.sessionHoldMs(peerId)) continue;
      this._tracked.delete(peerId);
      closed.push(peerId);
      entry.conn.close();
    }
    return closed;
  }

  get size(): number {
    return this._tracked.size;
  }
}
