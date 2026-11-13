/**
 * Deciding whether a failed request is the *peer's* fault.
 *
 * The dispatch path funnels nearly every error into a single catch, where a
 * dead seller is indistinguishable from a dropped wifi connection, a suspended
 * laptop, an unreachable chain RPC, or one of our own state-machine bugs. If we
 * cooled a peer down on every failure, closing the laptop lid would exile the
 * entire peer set — and the cooldown is persisted, so it would survive the
 * restart too.
 *
 * So attribution is evidence-based and fails safe: a failure escalates a peer's
 * cooldown only when we have positive evidence that the buyer itself is
 * healthy. Three independent gates provide that evidence, and each one alone is
 * enough to stop a buyer-side outage from mass-penalizing innocent peers.
 */

/** A success on another peer older than this no longer vouches for the buyer. */
export const CORROBORATION_WINDOW_MS = 10 * 60_000
/** Distinct peers that must fail together before we blame ourselves instead. */
export const CORRELATED_DISTINCT_PEERS = 3
/** How close together those failures must land to count as one outage. */
export const CORRELATION_WINDOW_MS = 60_000
/** How long we keep suppressing after concluding the buyer is the problem. */
export const CORRELATION_SUPPRESSION_MS = 60_000
/** Heartbeat cadence used to notice the wall clock jumping forward. */
export const HEARTBEAT_MS = 10_000
/** Extra slack past the heartbeat before a gap reads as suspend, not lag. */
export const SUSPEND_JUMP_MS = 30_000
/** Quarantine after a detected suspend, covering the wake-up failure storm. */
export const SUSPEND_QUARANTINE_MS = 60_000
/**
 * Slack applied before the last good heartbeat when rolling back a suspend. The
 * failures that matter are the ones recorded during the untrusted gap, plus any
 * that landed just as the machine was going down.
 */
export const ROLLBACK_LOOKBACK_MS = 15_000

export type AttributionSuppressionReason =
  | 'no-corroborating-success'
  | 'correlated-failure'
  | 'suspend-detected'
  | 'buyer-fault'
  | 'non-escalating-reason'

export type AttributionVerdict =
  | { escalate: true }
  | { escalate: false; suppressedBy: AttributionSuppressionReason }

export type AttributionInput = {
  peerId: string
  /** False for reasons that are informational only, e.g. 429 or a buyer fault. */
  reasonEscalates: boolean
  /** Fault attribution derived from the thrown error, when it is known. */
  fault?: 'buyer' | 'peer' | 'unknown'
  now: number
}

type FailureMark = { peerId: string; at: number }

export type AttributionSnapshot = {
  lastAnySuccessAt: number
  /** 0 when not currently suppressing. */
  suppressedUntil: number
  lastSuppressedBy: AttributionSuppressionReason | null
}

/** Bound on remembered per-peer successes; only the freshest ones matter. */
const MAX_TRACKED_SUCCESS_PEERS = 512

/**
 * Tracks the buyer-health evidence needed to attribute failures. Deliberately
 * holds no peer-health state of its own: it answers "may this failure count
 * against the peer?" and hands back the set of peers whose recent failures the
 * caller should roll back when it turns out the buyer was the problem.
 */
export class PeerAttributionTracker {
  private _lastAnySuccessAt = 0
  private readonly _lastSuccessByPeer = new Map<string, number>()
  private _recentFailures: FailureMark[] = []
  private _suppressedUntil = 0
  private _lastSuppressedBy: AttributionSuppressionReason | null = null
  private _lastHeartbeatAt: number | null = null

  /**
   * Record proof of life. Any HTTP response from a peer counts, including error
   * statuses — the peer answered, so our network, DHT, RPC and wallet are fine.
   */
  recordSuccess(peerId: string, now: number): void {
    // Re-insert so map order stays least-recently-successful first.
    this._lastSuccessByPeer.delete(peerId)
    this._lastSuccessByPeer.set(peerId, now)
    while (this._lastSuccessByPeer.size > MAX_TRACKED_SUCCESS_PEERS) {
      const oldest = this._lastSuccessByPeer.keys().next()
      if (oldest.done) break
      this._lastSuccessByPeer.delete(oldest.value)
    }
    if (now > this._lastAnySuccessAt) this._lastAnySuccessAt = now
  }

  /**
   * Decide whether a failure may escalate, and register it toward correlation
   * detection. Returns the peers to roll back when this failure is the one that
   * reveals a buyer-side outage.
   */
  classify(input: AttributionInput): { verdict: AttributionVerdict; rollbackPeerIds: string[] } {
    const { peerId, reasonEscalates, fault, now } = input

    if (fault === 'buyer') {
      return { verdict: { escalate: false, suppressedBy: 'buyer-fault' }, rollbackPeerIds: [] }
    }
    if (!reasonEscalates) {
      return { verdict: { escalate: false, suppressedBy: 'non-escalating-reason' }, rollbackPeerIds: [] }
    }

    this._pruneFailures(now)
    this._recentFailures.push({ peerId, at: now })

    // Gate 1c: the machine slept. Nothing recorded around the wake-up is
    // trustworthy, including failures that landed just before we noticed.
    if (now < this._suppressedUntil && this._lastSuppressedBy === 'suspend-detected') {
      return {
        verdict: { escalate: false, suppressedBy: 'suspend-detected' },
        rollbackPeerIds: [],
      }
    }

    // Gate 1b: several distinct peers failing at once means the common factor
    // is us. Trip suppression and undo what this outage already recorded.
    const distinctPeers = new Set(this._recentFailures.map((f) => f.peerId))
    if (distinctPeers.size >= CORRELATED_DISTINCT_PEERS) {
      this._suppressedUntil = now + CORRELATION_SUPPRESSION_MS
      this._lastSuppressedBy = 'correlated-failure'
      return {
        verdict: { escalate: false, suppressedBy: 'correlated-failure' },
        rollbackPeerIds: [...distinctPeers],
      }
    }
    if (now < this._suppressedUntil) {
      return {
        verdict: { escalate: false, suppressedBy: this._lastSuppressedBy ?? 'correlated-failure' },
        rollbackPeerIds: [],
      }
    }

    // Gate 1a: without a recent success on some *other* peer we have no proof
    // the buyer is healthy, so we cannot fairly blame this one. A buyer that
    // only ever talks to one peer never escalates it — correct, since there is
    // nothing to fail over to anyway.
    if (!this._hasCorroboratingSuccess(peerId, now)) {
      return {
        verdict: { escalate: false, suppressedBy: 'no-corroborating-success' },
        rollbackPeerIds: [],
      }
    }

    return { verdict: { escalate: true }, rollbackPeerIds: [] }
  }

  /**
   * Heartbeat tick. A wall-clock gap far larger than the cadence means the
   * process was suspended; every pending timeout and keepalive fires at once on
   * wake, so quarantine and roll back the resulting storm.
   *
   * Returns the peers to roll back, or null when nothing unusual happened.
   */
  onHeartbeat(now: number): { rollbackPeerIds: string[] } | null {
    const previous = this._lastHeartbeatAt
    this._lastHeartbeatAt = now
    if (previous === null) return null

    const elapsed = now - previous
    if (elapsed <= HEARTBEAT_MS + SUSPEND_JUMP_MS) return null

    this._suppressedUntil = now + SUSPEND_QUARANTINE_MS
    this._lastSuppressedBy = 'suspend-detected'

    // Everything recorded since the last trustworthy tick is suspect: the
    // suspend itself is what killed those requests, not the peers.
    const untrustedFrom = previous - ROLLBACK_LOOKBACK_MS
    const rollbackPeerIds = [
      ...new Set(
        this._recentFailures
          .filter((f) => f.at >= untrustedFrom)
          .map((f) => f.peerId),
      ),
    ]
    this._recentFailures = []
    return { rollbackPeerIds }
  }

  snapshot(now: number): AttributionSnapshot {
    return {
      lastAnySuccessAt: this._lastAnySuccessAt,
      suppressedUntil: now < this._suppressedUntil ? this._suppressedUntil : 0,
      lastSuppressedBy: this._lastSuppressedBy,
    }
  }

  /** Whether the buyer currently has evidence it is healthy at all. */
  isBuyerHealthy(now: number): boolean {
    return now >= this._suppressedUntil
      && this._lastAnySuccessAt > 0
      && now - this._lastAnySuccessAt <= CORROBORATION_WINDOW_MS
  }

  private _hasCorroboratingSuccess(failedPeerId: string, now: number): boolean {
    for (const [peerId, at] of this._lastSuccessByPeer) {
      if (peerId === failedPeerId) continue
      if (now - at <= CORROBORATION_WINDOW_MS && at <= now) return true
    }
    return false
  }

  private _pruneFailures(now: number): void {
    // A backwards clock jump would otherwise strand marks in the buffer.
    this._recentFailures = this._recentFailures.filter(
      (f) => f.at <= now && now - f.at <= CORRELATION_WINDOW_MS,
    )
  }
}
