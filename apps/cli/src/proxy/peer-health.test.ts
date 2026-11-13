import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recordPeerFailureEntry,
  clearPeerHealthEntry,
  isCoolingDown,
  parsePersistedPeerHealth,
  prunePeerHealth,
  computeCooldownMs,
  reasonEscalates,
  PEER_HEALTH_WINDOW_MS,
  PEER_HEALTH_COALESCE_MS,
  PEER_HEALTH_MAX_COOLDOWN_MS,
  PEER_HEALTH_RETENTION_MS,
  PEER_HEALTH_MAX_ENTRIES,
  type PeerHealthEntry,
} from './peer-health.js'

const NOW = 1_700_000_000_000
const A = 'a'.repeat(40)

function escalatingFailures(count: number, startAt = NOW, stepMs = 2_000): PeerHealthEntry {
  let entry: PeerHealthEntry | undefined
  for (let i = 0; i < count; i += 1) {
    entry = recordPeerFailureEntry(entry, 'request-failed', startAt + i * stepMs, true)
  }
  return entry!
}

test('reasonEscalates only admits reasons that indicate the peer is down', () => {
  assert.equal(reasonEscalates('request-failed'), true)
  assert.equal(reasonEscalates('seller-5xx'), true)
  assert.equal(reasonEscalates('seller-timeout'), true)
  assert.equal(reasonEscalates('seller-busy'), false)
  assert.equal(reasonEscalates('buyer-local'), false)
})

test('computeCooldownMs matches the shared escalation curve and its ceiling', () => {
  assert.equal(computeCooldownMs(2), 0)
  assert.equal(computeCooldownMs(3), 30_000)
  assert.equal(computeCooldownMs(4), 60_000)
  assert.equal(computeCooldownMs(5), 120_000)
  assert.equal(computeCooldownMs(7), 480_000)
  assert.equal(computeCooldownMs(50), PEER_HEALTH_MAX_COOLDOWN_MS)
})

test('a peer cools down only on the third failure in the window', () => {
  const after1 = recordPeerFailureEntry(undefined, 'request-failed', NOW, true)
  assert.equal(after1.failureStreak, 1)
  assert.equal(isCoolingDown(after1, NOW), false)

  const after2 = recordPeerFailureEntry(after1, 'request-failed', NOW + 2_000, true)
  assert.equal(isCoolingDown(after2, NOW + 2_000), false)

  const after3 = recordPeerFailureEntry(after2, 'request-failed', NOW + 4_000, true)
  assert.equal(after3.failureStreak, 3)
  assert.equal(after3.cooldownUntil, NOW + 4_000 + 30_000)
  assert.equal(isCoolingDown(after3, NOW + 4_000), true)
})

test('further failures double the cooldown', () => {
  const after4 = escalatingFailures(4)
  assert.equal(after4.cooldownUntil - after4.lastFailureAt, 60_000)
  const after5 = escalatingFailures(5)
  assert.equal(after5.cooldownUntil - after5.lastFailureAt, 120_000)
})

test('a non-escalating failure updates diagnostics but never the streak or cooldown', () => {
  const escalated = escalatingFailures(2)
  const suppressed = recordPeerFailureEntry(escalated, 'seller-busy', NOW + 10_000, false)

  assert.equal(suppressed.failureStreak, escalated.failureStreak)
  assert.equal(suppressed.cooldownUntil, escalated.cooldownUntil)
  assert.equal(suppressed.lastReason, 'seller-busy')
  assert.equal(suppressed.lastFailureAt, NOW + 10_000)
})

test('a diagnostic-only failure does not coalesce away the next escalating failure', () => {
  const diagnostic = recordPeerFailureEntry(undefined, 'seller-busy', NOW, false)
  const escalated = recordPeerFailureEntry(diagnostic, 'request-failed', NOW + 100, true)

  assert.equal(escalated.failureStreak, 1)
  assert.equal(escalated.episodeStartedAt, NOW + 100)
})

test('failures inside the coalesce window count as a single episode', () => {
  let entry = recordPeerFailureEntry(undefined, 'request-failed', NOW, true)
  entry = recordPeerFailureEntry(entry, 'request-failed', NOW + 100, true)
  entry = recordPeerFailureEntry(entry, 'request-failed', NOW + 200, true)

  assert.equal(entry.failureStreak, 1)
  assert.equal(isCoolingDown(entry, NOW + 200), false)
})

test('the coalesce window is anchored to the episode start', () => {
  let entry = recordPeerFailureEntry(undefined, 'request-failed', NOW, true)
  entry = recordPeerFailureEntry(entry, 'request-failed', NOW + PEER_HEALTH_COALESCE_MS - 100, true)
  entry = recordPeerFailureEntry(entry, 'request-failed', NOW + PEER_HEALTH_COALESCE_MS + 100, true)

  assert.equal(entry.failureStreak, 2)
  assert.equal(entry.episodeStartedAt, NOW + PEER_HEALTH_COALESCE_MS + 100)
})

test('a lapsed window starts a fresh streak instead of compounding', () => {
  const twoFailures = escalatingFailures(2)
  const muchLater = recordPeerFailureEntry(
    twoFailures, 'request-failed', twoFailures.lastFailureAt + PEER_HEALTH_WINDOW_MS + 1, true,
  )
  assert.equal(muchLater.failureStreak, 1)
  assert.equal(muchLater.cooldownUntil, 0)
})

test('a backwards clock jump resets the window rather than compounding', () => {
  const twoFailures = escalatingFailures(2)
  const backwards = recordPeerFailureEntry(twoFailures, 'request-failed', NOW - 60_000, true)
  assert.equal(backwards.failureStreak, 1)
  assert.equal(backwards.cooldownUntil, 0)
})

test('a success clears the streak and releases the cooldown', () => {
  const cooling = escalatingFailures(3)
  assert.equal(isCoolingDown(cooling, cooling.lastFailureAt), true)

  const recovered = clearPeerHealthEntry(cooling, cooling.lastFailureAt + 1_000)
  assert.equal(recovered.failureStreak, 0)
  assert.equal(recovered.cooldownUntil, 0)
  assert.equal(recovered.lastSuccessAt, cooling.lastFailureAt + 1_000)
  assert.equal(isCoolingDown(recovered, recovered.lastSuccessAt), false)
})

test('isCoolingDown rejects an impossibly distant cooldown', () => {
  const entry: PeerHealthEntry = {
    ...escalatingFailures(3),
    cooldownUntil: NOW + PEER_HEALTH_MAX_COOLDOWN_MS * 10,
  }
  assert.equal(isCoolingDown(entry, NOW), false)
})

test('parsePersistedPeerHealth ignores junk input', () => {
  assert.equal(parsePersistedPeerHealth(null, NOW).size, 0)
  assert.equal(parsePersistedPeerHealth('nope', NOW).size, 0)
  assert.equal(parsePersistedPeerHealth({}, NOW).size, 0)
  assert.equal(parsePersistedPeerHealth({ peerHealth: [] }, NOW).size, 0)
  assert.equal(parsePersistedPeerHealth({ peerHealth: 'x' }, NOW).size, 0)
})

test('parsePersistedPeerHealth rejects malformed peer ids and entries', () => {
  const parsed = parsePersistedPeerHealth({
    peerHealth: {
      'not-a-peer-id': { lastFailureAt: NOW - 1_000, failureStreak: 3 },
      [`0x${'a'.repeat(40)}`]: { lastFailureAt: NOW - 1_000, failureStreak: 3 },
      [A]: 'not-an-object',
    },
  }, NOW)
  assert.equal(parsed.size, 0)
})

test('parsePersistedPeerHealth restores a live cooldown unchanged', () => {
  const cooldownUntil = NOW + 20_000
  const parsed = parsePersistedPeerHealth({
    peerHealth: {
      [A.toUpperCase()]: {
        failureStreak: 3, windowStartedAt: NOW - 5_000, lastFailureAt: NOW - 1_000,
        lastReason: 'seller-5xx', cooldownUntil, lastSuccessAt: 0,
      },
    },
  }, NOW)

  const entry = parsed.get(A)
  assert.ok(entry)
  assert.equal(entry.cooldownUntil, cooldownUntil)
  assert.equal(entry.failureStreak, 3)
  assert.equal(entry.lastReason, 'seller-5xx')
})

test('parsePersistedPeerHealth drops an expired or impossible cooldown', () => {
  const expired = parsePersistedPeerHealth({
    peerHealth: { [A]: { failureStreak: 3, lastFailureAt: NOW - 1_000, cooldownUntil: NOW - 1 } },
  }, NOW)
  assert.equal(expired.get(A)?.cooldownUntil, 0)

  const absurd = parsePersistedPeerHealth({
    peerHealth: {
      [A]: {
        failureStreak: 3,
        lastFailureAt: NOW - 1_000,
        cooldownUntil: NOW + PEER_HEALTH_MAX_COOLDOWN_MS * 100,
      },
    },
  }, NOW)
  assert.equal(absurd.get(A)?.cooldownUntil, 0)
})

test('parsePersistedPeerHealth discards entries stamped in the future', () => {
  const parsed = parsePersistedPeerHealth({
    peerHealth: { [A]: { failureStreak: 3, lastFailureAt: NOW + 60_000 } },
  }, NOW)
  assert.equal(parsed.size, 0)
})

test('parsePersistedPeerHealth coerces non-finite numbers and unknown reasons', () => {
  const parsed = parsePersistedPeerHealth({
    peerHealth: {
      [A]: {
        failureStreak: 'lots', windowStartedAt: Number.NaN, lastFailureAt: NOW - 1_000,
        lastReason: 'made-up-reason', cooldownUntil: Number.POSITIVE_INFINITY,
        lastSuccessAt: -5,
      },
    },
  }, NOW)

  const entry = parsed.get(A)
  assert.ok(entry)
  assert.equal(entry.failureStreak, 0)
  assert.equal(entry.windowStartedAt, 0)
  assert.equal(entry.lastReason, 'request-failed')
  assert.equal(entry.cooldownUntil, 0)
  assert.equal(entry.lastSuccessAt, 0)
})

test('parsePersistedPeerHealth forgets entries past the retention window', () => {
  const parsed = parsePersistedPeerHealth({
    peerHealth: { [A]: { failureStreak: 3, lastFailureAt: NOW - PEER_HEALTH_RETENTION_MS - 1 } },
  }, NOW)
  assert.equal(parsed.size, 0)
})

test('prunePeerHealth caps the map keeping the most recently active peers', () => {
  const entries = new Map<string, PeerHealthEntry>()
  const total = PEER_HEALTH_MAX_ENTRIES + 10
  for (let i = 0; i < total; i += 1) {
    const peerId = i.toString(16).padStart(40, '0')
    entries.set(peerId, {
      failureStreak: 1, windowStartedAt: 0, lastFailureAt: NOW - (total - i) * 1_000,
      episodeStartedAt: NOW - (total - i) * 1_000,
      lastReason: 'request-failed', cooldownUntil: 0, lastSuccessAt: 0,
    })
  }

  const pruned = prunePeerHealth(entries, NOW)
  assert.equal(pruned.size, PEER_HEALTH_MAX_ENTRIES)
  // The freshest peer survives; the stalest is evicted.
  assert.ok(pruned.has((total - 1).toString(16).padStart(40, '0')))
  assert.equal(pruned.has((0).toString(16).padStart(40, '0')), false)
})
