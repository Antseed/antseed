import type { PeerId } from "../types/peer.js";

/** How long a seller keeps an inbound buyer connection with no traffic and nothing open on it. */
export const DEFAULT_INBOUND_IDLE_TIMEOUT_MS = 30 * 60_000;

interface Tracked {
  conn: { close(): void };
  lastActivityAt: number;
  inFlight: number;
}

export interface InboundIdleTrackerOptions {
  idleTimeoutMs: number;
  /**
   * Whether the buyer holds something a disconnect would end (a paid channel,
   * a free usage session). Such connections are left open: closing them has
   * on-chain effects, and the channel's own idle timers end them.
   */
  holdsSession: (peerId: PeerId) => boolean;
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

  /** Closes every idle connection that holds no session; returns the buyers closed. */
  sweep(): PeerId[] {
    const cutoff = this._now() - this._options.idleTimeoutMs;
    const closed: PeerId[] = [];
    for (const [peerId, entry] of this._tracked) {
      if (entry.inFlight > 0 || entry.lastActivityAt > cutoff) continue;
      if (this._options.holdsSession(peerId)) continue;
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
