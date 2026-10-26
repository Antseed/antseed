import type { MeteringStorage } from '@antseed/node/metering';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Rows land after their request finishes, so leave a margin before treating a range as final. */
export const METERING_SETTLE_MS = 120_000;
/** Anything older is read in one query; long-lived sellers have indexed, sparse history there. */
const BACKFILL_MS = 2 * 365 * DAY_MS;

export interface MeteringCounts {
  requests: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
  receiptCents: number;
}

type MeteringReader = Pick<MeteringStorage, 'getEventTokenSummary' | 'getSessionSummary' | 'getSessionsInsertedAfter' | 'getTotalCost'>;

const zero = (): MeteringCounts => ({ requests: 0, tokens: 0, inputTokens: 0, outputTokens: 0, sessions: 0, receiptCents: 0 });

function addRange(into: MeteringCounts, metering: MeteringReader, startMs: number, endMs: number): void {
  const events = metering.getEventTokenSummary(startMs, endMs);
  into.requests += events.totalRequests;
  into.tokens += events.totalTokens;
  into.inputTokens += events.inputTokens;
  into.outputTokens += events.outputTokens;
  into.receiptCents += metering.getTotalCost(startMs, endMs);
}

const utcDayStart = (ms: number): number => ms - (ms % DAY_MS);

/**
 * All-time and today's metering totals, kept incrementally. Summing the whole
 * metering DB on every scrape blocks the exporter for minutes on a busy seller
 * (multi-GB metering.db), so each pass reads only the rows added since the
 * last one, an hour of data per query, yielding between queries so /healthz
 * keeps answering. Rows pruned later stay counted (the totals are counters).
 * Sessions are counted by insertion (a never-reused sequence), since a session row lands with
 * the start time of a request that may have finished minutes later.
 */
export class MeteringTotals {
  private _total = zero();
  private _today = zero();
  private _todayStart = 0;
  private _coveredTo: number | null = null;
  private _sessionCursor = 0;
  private _running: Promise<void> | null = null;

  /** Totals through the last completed pass, or null before the first one finishes. */
  snapshot(): { total: MeteringCounts; today: MeteringCounts; coveredTo: number } | null {
    if (this._coveredTo === null) return null;
    return { total: { ...this._total }, today: { ...this._today }, coveredTo: this._coveredTo };
  }

  /** Start a pass unless one is running; resolves when it finishes. */
  refresh(open: () => MeteringReader & { close(): void }, now = Date.now()): Promise<void> {
    this._running ??= this._catchUp(open, now).finally(() => {
      this._running = null;
    });
    return this._running;
  }

  private async _catchUp(open: () => MeteringReader & { close(): void }, now: number): Promise<void> {
    const target = now - METERING_SETTLE_MS;
    const metering = open();
    try {
      const total = this._coveredTo === null ? zero() : { ...this._total };
      let from = this._coveredTo;
      if (from === null) {
        from = target - BACKFILL_MS;
        addRange(total, metering, 0, from);
      }
      // Chunks end on hour boundaries, so none straddles midnight: on a new day
      // today restarts from zero and picks up the chunks from midnight on.
      const todayStart = utcDayStart(target);
      const today = this._todayStart === todayStart ? { ...this._today } : zero();
      for (let start = from; start < target;) {
        const end = Math.min(start - (start % HOUR_MS) + HOUR_MS, target);
        const chunk = zero();
        addRange(chunk, metering, start, end);
        for (const key of Object.keys(chunk) as Array<keyof MeteringCounts>) {
          total[key] += chunk[key];
          if (start >= todayStart) today[key] += chunk[key];
        }
        start = end;
        await new Promise((resolve) => setImmediate(resolve));
      }
      const sessions = metering.getSessionsInsertedAfter(this._sessionCursor);
      total.sessions += sessions.count;
      today.sessions = metering.getSessionSummary(todayStart, now).channelCount;
      this._sessionCursor = sessions.lastRowid;
      this._total = total;
      this._today = today;
      this._todayStart = todayStart;
      this._coveredTo = Math.max(from, target);
    } finally {
      metering.close();
    }
  }
}
