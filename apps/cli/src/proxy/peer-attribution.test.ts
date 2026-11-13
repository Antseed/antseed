import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PeerAttributionTracker,
  CORROBORATION_WINDOW_MS,
  CORRELATION_WINDOW_MS,
  HEARTBEAT_MS,
  SUSPEND_JUMP_MS,
} from './peer-attribution.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

function fail(tracker: PeerAttributionTracker, peerId: string, now: number) {
  return tracker.classify({ peerId, reasonEscalates: true, fault: 'unknown', now })
}

test('a failure never escalates without a prior success anywhere', () => {
  const tracker = new PeerAttributionTracker()
  const { verdict } = fail(tracker, A, 1_000_000)
  assert.deepEqual(verdict, { escalate: false, suppressedBy: 'no-corroborating-success' })
})

test('a recent success on another peer lets the failure escalate', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(B, 1_000_000)
  const { verdict } = fail(tracker, A, 1_001_000)
  assert.deepEqual(verdict, { escalate: true })
})

test('a success on the failing peer itself does not vouch for the buyer', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(A, 1_000_000)
  const { verdict } = fail(tracker, A, 1_001_000)
  assert.deepEqual(verdict, { escalate: false, suppressedBy: 'no-corroborating-success' })
})

test('a success older than the corroboration window stops vouching', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(B, 1_000_000)
  const { verdict } = fail(tracker, A, 1_000_000 + CORROBORATION_WINDOW_MS + 1)
  assert.deepEqual(verdict, { escalate: false, suppressedBy: 'no-corroborating-success' })
})

test('three distinct peers failing together blames the buyer and rolls them back', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(D, 1_000_000)

  assert.deepEqual(fail(tracker, A, 1_000_100).verdict, { escalate: true })
  assert.deepEqual(fail(tracker, B, 1_000_200).verdict, { escalate: true })

  const third = fail(tracker, C, 1_000_300)
  assert.deepEqual(third.verdict, { escalate: false, suppressedBy: 'correlated-failure' })
  assert.deepEqual([...third.rollbackPeerIds].sort(), [A, B, C].sort())
})

test('repeated failures on a single peer do not trip correlation suppression', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(D, 1_000_000)

  for (let i = 1; i <= 5; i += 1) {
    const { verdict } = fail(tracker, A, 1_000_000 + i * 1_000)
    assert.deepEqual(verdict, { escalate: true }, `failure ${i} should still escalate`)
  }
})

test('failures spread beyond the correlation window are not correlated', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(D, 1_000_000)

  // Three distinct peers, but far enough apart that they are three separate
  // incidents rather than one buyer-side outage. Each is judged on its own.
  const spacing = CORRELATION_WINDOW_MS + 1_000
  assert.deepEqual(fail(tracker, A, 1_000_100).verdict, { escalate: true })
  assert.deepEqual(fail(tracker, B, 1_000_100 + spacing).verdict, { escalate: true })
  assert.deepEqual(fail(tracker, C, 1_000_100 + spacing * 2).verdict, { escalate: true })
})

test('suppression persists for the window after a correlation trip', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(D, 1_000_000)
  fail(tracker, A, 1_000_100)
  fail(tracker, B, 1_000_200)
  fail(tracker, C, 1_000_300)

  const later = fail(tracker, A, 1_000_400)
  assert.deepEqual(later.verdict, { escalate: false, suppressedBy: 'correlated-failure' })
})

test('a buyer-attributed fault never escalates, even with corroboration', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(B, 1_000_000)
  const { verdict } = tracker.classify({
    peerId: A, reasonEscalates: true, fault: 'buyer', now: 1_001_000,
  })
  assert.deepEqual(verdict, { escalate: false, suppressedBy: 'buyer-fault' })
})

test('a non-escalating reason is recorded but never cools a peer down', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(B, 1_000_000)
  const { verdict } = tracker.classify({
    peerId: A, reasonEscalates: false, fault: 'peer', now: 1_001_000,
  })
  assert.deepEqual(verdict, { escalate: false, suppressedBy: 'non-escalating-reason' })
})

test('a wall-clock jump reads as suspend, quarantines, and rolls back the storm', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(D, 1_000_000)
  assert.equal(tracker.onHeartbeat(1_000_000), null)

  // Two peers fail as the machine goes down; the jump is noticed on the next tick.
  fail(tracker, A, 1_000_100)
  fail(tracker, B, 1_000_200)

  const wake = 1_000_200 + HEARTBEAT_MS + SUSPEND_JUMP_MS + 1_000
  const result = tracker.onHeartbeat(wake)
  assert.ok(result, 'expected the clock jump to be detected')
  assert.deepEqual([...result.rollbackPeerIds].sort(), [A, B].sort())

  const afterWake = fail(tracker, C, wake + 100)
  assert.deepEqual(afterWake.verdict, { escalate: false, suppressedBy: 'suspend-detected' })
})

test('a normal heartbeat cadence is not mistaken for suspend', () => {
  const tracker = new PeerAttributionTracker()
  assert.equal(tracker.onHeartbeat(1_000_000), null)
  assert.equal(tracker.onHeartbeat(1_000_000 + HEARTBEAT_MS), null)
  assert.equal(tracker.onHeartbeat(1_000_000 + HEARTBEAT_MS * 2 + 500), null)
})

test('isBuyerHealthy tracks corroboration and suppression', () => {
  const tracker = new PeerAttributionTracker()
  assert.equal(tracker.isBuyerHealthy(1_000_000), false)

  tracker.recordSuccess(B, 1_000_000)
  assert.equal(tracker.isBuyerHealthy(1_000_100), true)
  assert.equal(tracker.isBuyerHealthy(1_000_000 + CORROBORATION_WINDOW_MS + 1), false)

  fail(tracker, A, 1_000_100)
  fail(tracker, B, 1_000_200)
  fail(tracker, C, 1_000_300)
  assert.equal(tracker.isBuyerHealthy(1_000_400), false)
})

test('snapshot reports the active suppression window and clears once it lapses', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(D, 1_000_000)
  fail(tracker, A, 1_000_100)
  fail(tracker, B, 1_000_200)
  fail(tracker, C, 1_000_300)

  const during = tracker.snapshot(1_000_400)
  assert.ok(during.suppressedUntil > 1_000_400)
  assert.equal(during.lastSuppressedBy, 'correlated-failure')
  assert.equal(during.lastAnySuccessAt, 1_000_000)

  const after = tracker.snapshot(1_000_300 + 120_000)
  assert.equal(after.suppressedUntil, 0)
})

test('a backwards clock jump does not strand failures in the correlation buffer', () => {
  const tracker = new PeerAttributionTracker()
  tracker.recordSuccess(D, 2_000_000)
  fail(tracker, A, 2_000_100)
  fail(tracker, B, 2_000_200)

  // Clock steps backwards past the earlier marks; they must be discarded, so
  // this third distinct peer does not trip correlation on stale data.
  const { verdict } = fail(tracker, C, 1_000_000)
  assert.notEqual(
    verdict.escalate === false ? verdict.suppressedBy : null,
    'correlated-failure',
  )
})
