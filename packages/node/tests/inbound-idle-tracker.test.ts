import { describe, expect, it } from 'vitest';
import { InboundIdleTracker } from '../src/p2p/inbound-idle-tracker.js';

const IDLE_MS = 30 * 60_000;

function setup(holding: Set<string> = new Set()) {
  let now = 0;
  const closed: string[] = [];
  const tracker = new InboundIdleTracker({ idleTimeoutMs: IDLE_MS, holdsSession: (peerId) => holding.has(peerId), now: () => now });
  const conn = (peerId: string) => ({ close: () => { closed.push(peerId); } });
  return { tracker, closed, conn, advance: (ms: number) => { now += ms; } };
}

describe('InboundIdleTracker', () => {
  it('closes a connection idle for the timeout', () => {
    const { tracker, closed, conn, advance } = setup();
    tracker.track('a', conn('a'));
    tracker.track('b', conn('b'));
    advance(IDLE_MS - 1);
    tracker.touch('b');
    advance(1);

    expect(tracker.sweep()).toEqual(['a']);
    expect(closed).toEqual(['a']);
    expect(tracker.size).toBe(1);
  });

  it('keeps a connection whose buyer holds a channel or free usage session', () => {
    const { tracker, closed, conn, advance } = setup(new Set(['paying']));
    tracker.track('paying', conn('paying'));
    advance(IDLE_MS * 10);

    expect(tracker.sweep()).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('keeps a connection while a request is in flight, and counts idle time from when it finishes', () => {
    const { tracker, closed, conn, advance } = setup();
    tracker.track('a', conn('a'));
    const finished = tracker.begin('a');
    advance(IDLE_MS * 2);
    expect(tracker.sweep()).toEqual([]);

    finished();
    finished();
    advance(IDLE_MS - 1);
    expect(tracker.sweep()).toEqual([]);
    advance(1);
    expect(tracker.sweep()).toEqual(['a']);
    expect(closed).toEqual(['a']);
  });

  it('ignores a stale untrack after the buyer reconnected', () => {
    const { tracker, conn, advance } = setup();
    const first = conn('a');
    tracker.track('a', first);
    tracker.track('a', conn('a'));
    tracker.untrack('a', first);
    advance(IDLE_MS);

    expect(tracker.sweep()).toEqual(['a']);
  });
});
