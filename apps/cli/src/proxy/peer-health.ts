/**
 * Per-peer failure bookkeeping and cooldown state for the buyer proxy.
 *
 * A peer that stops responding should stop being picked, but only temporarily:
 * peers go offline for legitimate reasons, so there is no permanent auto-ban.
 * Whether a failure is even allowed to escalate is decided separately, by
 * `peer-attribution.ts` — this module owns the state machine, not the blame.
 *
 * Cooldown is always advisory. The proxy still dispatches to a cooling-down
 * peer when a request names it, so a pinned conversation keeps working and no
 * amount of cooldown can deadlock routing.
 */

// The escalation curve is defined once in
// `packages/router-core/src/peer-metrics.ts` (`computeFailureCooldownMs`).
// These constants mirror it; router-core is not a dependency of the CLI and a
// six-line curve does not justify making it one. Keep the two in step.
const MAX_FAILURES = 3
const BASE_COOLDOWN_MS = 30_000
const MAX_DOUBLINGS = 4

/** Failures older than this start a fresh streak rather than compounding. */
export const PEER_HEALTH_WINDOW_MS = 5 * 60_000
/** Concurrent requests failing together count as one episode, not several. */
export const PEER_HEALTH_COALESCE_MS = 1_000
/** Ceiling on any single cooldown, and the sanity bound for persisted values. */
export const PEER_HEALTH_MAX_COOLDOWN_MS = 8 * 60_000
/** How long an idle entry is kept before it is forgotten entirely. */
export const PEER_HEALTH_RETENTION_MS = 24 * 60 * 60_000
/** Upper bound on tracked peers, newest failures retained. */
export const PEER_HEALTH_MAX_ENTRIES = 512

export type PeerFailureReason =
  /** Transport threw, timed out, or the connection died mid-request. */
  | 'request-failed'
  /** Seller answered 500/502/503/504. */
  | 'seller-5xx'
  /** Seller answered 408. */
  | 'seller-timeout'
  /** Seller answered 429 — capacity pressure, not death. Never escalates. */
  | 'seller-busy'
  /** Our own wallet, deposits, config or state machine. Never escalates. */
  | 'buyer-local'

const FAILURE_REASONS: readonly PeerFailureReason[] = [
  'request-failed', 'seller-5xx', 'seller-timeout', 'seller-busy', 'buyer-local',
]

/** Whether a reason is even a candidate for cooling a peer down. */
export function reasonEscalates(reason: PeerFailureReason): boolean {
  return reason === 'request-failed' || reason === 'seller-5xx' || reason === 'seller-timeout'
}

export type PeerHealthEntry = {
  failureStreak: number
  windowStartedAt: number
  /** Start of the current coalesced failure episode. */
  episodeStartedAt: number
  lastFailureAt: number
  lastReason: PeerFailureReason
  /** 0 when the peer is not cooling down. */
  cooldownUntil: number
  /** 0 when the peer has never answered us. */
  lastSuccessAt: number
}

export function computeCooldownMs(failureStreak: number): number {
  if (!Number.isFinite(failureStreak) || failureStreak < MAX_FAILURES) return 0
  const penaltyPower = Math.min(MAX_DOUBLINGS, Math.trunc(failureStreak) - MAX_FAILURES)
  return Math.min(BASE_COOLDOWN_MS * (2 ** penaltyPower), PEER_HEALTH_MAX_COOLDOWN_MS)
}

function emptyEntry(): PeerHealthEntry {
  return {
    failureStreak: 0,
    windowStartedAt: 0,
    episodeStartedAt: 0,
    lastFailureAt: 0,
    lastReason: 'request-failed',
    cooldownUntil: 0,
    lastSuccessAt: 0,
  }
}

/**
 * Fold a failure into a peer's health.
 *
 * `escalate` comes from the attribution gates: when false the failure is still
 * recorded for diagnostics and UI, but the streak and cooldown stay put.
 */
export function recordPeerFailureEntry(
  previous: PeerHealthEntry | undefined,
  reason: PeerFailureReason,
  now: number,
  escalate: boolean,
): PeerHealthEntry {
  const prev = previous ?? emptyEntry()

  if (!escalate) {
    return { ...prev, lastFailureAt: now, lastReason: reason }
  }

  // Two requests to the same dead peer failing together are one episode; without
  // this they would skip a doubling step each time concurrency rises.
  const episodeStartedAt = prev.episodeStartedAt
  if (episodeStartedAt > 0 && now - episodeStartedAt < PEER_HEALTH_COALESCE_MS && now >= prev.lastFailureAt) {
    return { ...prev, lastFailureAt: now, lastReason: reason }
  }

  const windowLapsed = prev.lastFailureAt <= 0
    || now - prev.lastFailureAt > PEER_HEALTH_WINDOW_MS
    // Clock stepped backwards; the old window is meaningless.
    || now < prev.lastFailureAt

  const failureStreak = windowLapsed ? 1 : prev.failureStreak + 1
  const cooldownMs = computeCooldownMs(failureStreak)

  return {
    failureStreak,
    windowStartedAt: windowLapsed ? now : (prev.windowStartedAt || now),
    episodeStartedAt: now,
    lastFailureAt: now,
    lastReason: reason,
    cooldownUntil: cooldownMs > 0 ? now + cooldownMs : 0,
    lastSuccessAt: prev.lastSuccessAt,
  }
}

/**
 * Any response from a peer is proof of life, so a success wipes the streak and
 * releases the cooldown. `lastSuccessAt` is kept for diagnostics.
 */
export function clearPeerHealthEntry(
  previous: PeerHealthEntry | undefined,
  now: number,
): PeerHealthEntry {
  return {
    ...(previous ?? emptyEntry()),
    failureStreak: 0,
    windowStartedAt: 0,
    episodeStartedAt: 0,
    cooldownUntil: 0,
    lastSuccessAt: now,
  }
}

export function isCoolingDown(entry: PeerHealthEntry | undefined, now: number): boolean {
  if (!entry || entry.cooldownUntil <= now) return false
  // A corrupt or clock-skewed future value must not hold a peer hostage.
  return entry.cooldownUntil - now <= PEER_HEALTH_MAX_COOLDOWN_MS
}

/** Whether an entry still carries information worth persisting. */
function isEntryMeaningful(entry: PeerHealthEntry, now: number): boolean {
  if (entry.cooldownUntil > now) return true
  const lastActivity = Math.max(entry.lastFailureAt, entry.lastSuccessAt)
  if (lastActivity <= 0) return false
  return now - lastActivity < PEER_HEALTH_RETENTION_MS
}

/** Drop stale entries and cap the map, keeping the most recently active peers. */
export function prunePeerHealth(
  entries: Map<string, PeerHealthEntry>,
  now: number,
): Map<string, PeerHealthEntry> {
  const kept = [...entries.entries()].filter(([, entry]) => isEntryMeaningful(entry, now))
  if (kept.length > PEER_HEALTH_MAX_ENTRIES) {
    kept.sort((a, b) =>
      Math.max(b[1].lastFailureAt, b[1].lastSuccessAt)
      - Math.max(a[1].lastFailureAt, a[1].lastSuccessAt))
    kept.length = PEER_HEALTH_MAX_ENTRIES
  }
  return new Map(kept)
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Parse the `peerHealth` map out of a buyer.state.json blob.
 *
 * Cooldown survives a restart — a peer that died ten seconds before we exited is
 * still dead — but is never extended or resurrected by one: anything expired,
 * impossibly far in the future, or stamped after `now` is discarded.
 */
export function parsePersistedPeerHealth(
  parsed: unknown,
  now: number = Date.now(),
): Map<string, PeerHealthEntry> {
  const result = new Map<string, PeerHealthEntry>()
  if (!parsed || typeof parsed !== 'object') return result

  const raw = (parsed as { peerHealth?: unknown }).peerHealth
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result

  for (const [rawPeerId, rawEntry] of Object.entries(raw as Record<string, unknown>)) {
    const peerId = rawPeerId.toLowerCase()
    if (!/^[0-9a-f]{40}$/.test(peerId)) continue
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue

    const entry = rawEntry as Record<string, unknown>
    const lastFailureAt = finiteNonNegative(entry.lastFailureAt)
    const lastSuccessAt = finiteNonNegative(entry.lastSuccessAt)

    // Timestamps ahead of the clock mean the entry cannot be reasoned about.
    if (lastFailureAt > now || lastSuccessAt > now) continue

    const rawStreak = finiteNonNegative(entry.failureStreak)
    const failureStreak = Math.min(64, Math.trunc(rawStreak))
    const lastReason = FAILURE_REASONS.includes(entry.lastReason as PeerFailureReason)
      ? (entry.lastReason as PeerFailureReason)
      : 'request-failed'

    const rawCooldown = finiteNonNegative(entry.cooldownUntil)
    const cooldownUntil = rawCooldown > now && rawCooldown - now <= PEER_HEALTH_MAX_COOLDOWN_MS
      ? rawCooldown
      : 0

    const candidate: PeerHealthEntry = {
      failureStreak,
      windowStartedAt: Math.min(finiteNonNegative(entry.windowStartedAt), now),
      episodeStartedAt: Math.min(
        finiteNonNegative(entry.episodeStartedAt) || lastFailureAt,
        now,
      ),
      lastFailureAt,
      lastReason,
      cooldownUntil,
      lastSuccessAt,
    }
    if (!isEntryMeaningful(candidate, now)) continue
    result.set(peerId, candidate)
  }

  return prunePeerHealth(result, now)
}

export function serializePeerHealth(
  entries: Map<string, PeerHealthEntry>,
): Record<string, PeerHealthEntry> {
  return Object.fromEntries(entries)
}
