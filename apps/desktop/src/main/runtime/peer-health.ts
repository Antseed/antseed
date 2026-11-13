/** Shape of one entry in buyer.state.json's `peerHealth` map. */
export type RawPeerHealth = {
  cooldownUntil?: unknown;
  failureStreak?: unknown;
  lastReason?: unknown;
};

export type PeerHealthView = {
  cooldownUntil: number | null;
  failureStreak: number;
  lastFailureReason: string | null;
};

/**
 * Normalize one raw health entry.
 *
 * An expired cooldown is surfaced as null rather than left for consumers to
 * compare against the clock, so a stale timestamp can never read as "still
 * cooling down".
 */
export function readPeerHealth(raw: RawPeerHealth | undefined, now: number): PeerHealthView {
  if (!raw || typeof raw !== 'object') {
    return { cooldownUntil: null, failureStreak: 0, lastFailureReason: null };
  }
  const cooldownUntil = typeof raw.cooldownUntil === 'number' && Number.isFinite(raw.cooldownUntil)
    && raw.cooldownUntil > now
    ? raw.cooldownUntil
    : null;
  const failureStreak = typeof raw.failureStreak === 'number' && Number.isFinite(raw.failureStreak)
    ? Math.max(0, Math.trunc(raw.failureStreak))
    : 0;
  return {
    cooldownUntil,
    failureStreak,
    lastFailureReason: typeof raw.lastReason === 'string' ? raw.lastReason : null,
  };
}
