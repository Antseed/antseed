import assert from 'node:assert/strict'
import test from 'node:test'
import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { combineDiffRecheck, RECHECK_ENROLLMENT_ROUNDS, runDiffRechecks } from './diff-recheck.js'
import type { ModelVerificationSkip, ModelVerificationTargetResult } from './model-run.js'
import { BANK_EXHAUSTED } from './probe-bank.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'

function result(peer: string, status: ModelVerificationTargetResult['status']): ModelVerificationTargetResult {
  return {
    peerId: peer.repeat(40).slice(0, 40),
    displayName: null,
    agentId: '7',
    service: 'model-a',
    status,
    auditId: `audit-${peer}-${status}`,
    parsedProbeCount: 100,
    probeCount: 100,
    correctProbeCount: status === 'SAME' ? 98 : 70,
    incorrectProbeCount: status === 'SAME' ? 2 : 30,
    correctRate: status === 'SAME' ? 0.98 : 0.7,
    requestCount: 10,
    cost: emptyAuditCostSummary(),
    evidencePath: `/evidence/${peer}-${status}.json`,
    evidenceHash: `0x${peer.repeat(64).slice(0, 64)}`,
  }
}

const reference = { referenceId: 'sha256:recheck', probes: Array.from({ length: 100 }, () => ({})) } as unknown as KbfReferenceV1

async function run(input: {
  results: ModelVerificationTargetResult[]
  recheckVerdicts?: Record<string, ModelVerificationTargetResult['status'] | 'SKIPPED'>
  exhausted?: Set<string>
  enroll?: (() => Promise<void>) | null
}) {
  const logs: string[] = []
  const verified: string[] = []
  const outcome = await runDiffRechecks({
    results: input.results,
    reserve: async (first) => {
      if (input.exhausted?.has(first.peerId)) throw new Error(`${BANK_EXHAUSTED}: 20 probes remain`)
      return { reference, auditId: `recheck-${first.peerId}` }
    },
    enroll: input.enroll ?? null,
    verify: async (first): Promise<ModelVerificationTargetResult | ModelVerificationSkip> => {
      verified.push(first.peerId)
      const verdict = input.recheckVerdicts?.[first.peerId] ?? 'DIFF'
      if (verdict === 'SKIPPED') {
        return {
          peerId: first.peerId, displayName: null, agentId: first.agentId, service: first.service,
          status: 'SKIPPED', code: 'missing_response_auth', reason: 'no ResponseAuth', source: 'runtime',
          auditId: null, evidencePath: null, evidenceHash: null,
        }
      }
      return { ...result(first.peerId[0]!, verdict), peerId: first.peerId, auditId: `second-${first.peerId}` }
    },
    concurrency: async (tasks) => { for (const task of tasks) await task() },
    log: (message) => logs.push(message),
  })
  return { outcome, logs, verified }
}

test('only DIFF results are rechecked; a recheck DIFF confirms the DIFF', async () => {
  const same = result('a', 'SAME')
  const diff = result('b', 'DIFF')
  const { outcome, verified, logs } = await run({ results: [same, diff] })
  assert.deepEqual(verified, [diff.peerId])
  assert.equal(outcome.results[0], same)
  assert.equal(outcome.results[1]!.status, 'DIFF')
  assert.equal(outcome.results[1]!.recheck?.status, 'DIFF')
  assert.equal(outcome.results[1]!.auditId, diff.auditId)
  assert.equal(outcome.stats.confirmed, 1)
  assert.ok(logs.some((line) => line.includes('confirmed DIFF')))
})

test('a recheck SAME or UNDETERMINED turns the DIFF into UNDETERMINED', async () => {
  const toSame = result('b', 'DIFF')
  const toUndetermined = result('c', 'DIFF')
  const { outcome, logs } = await run({
    results: [toSame, toUndetermined],
    recheckVerdicts: { [toSame.peerId]: 'SAME', [toUndetermined.peerId]: 'UNDETERMINED' },
  })
  assert.deepEqual(outcome.results.map((entry) => entry.status), ['UNDETERMINED', 'UNDETERMINED'])
  assert.deepEqual(outcome.results.map((entry) => entry.recheck?.status), ['SAME', 'UNDETERMINED'])
  assert.equal(outcome.stats.notConfirmed, 2)
  assert.equal(outcome.stats.confirmed, 0)
  assert.ok(logs.some((line) => line.includes('recheck UNDETERMINED → not confirmed')))
})

test('a DIFF without fresh questions is kept, waiting for its recheck, when enrollment is off', async () => {
  const diff = result('b', 'DIFF')
  const { outcome, verified, logs } = await run({ results: [diff], exhausted: new Set([diff.peerId]) })
  assert.deepEqual(verified, [])
  assert.equal(outcome.results.length, 1)
  assert.equal(outcome.results[0]!.status, 'DIFF')
  assert.equal(outcome.results[0]!.recheck, undefined)
  assert.match(outcome.results[0]!.recheckPending!.reason, /no fresh questions left and enrollment is off/)
  assert.equal(outcome.stats.pending, 1)
  assert.ok(logs.some((line) => line.includes('DIFF kept, not submitted')))
})

test('exhausted rechecks enroll fresh questions once when that is enough, then recheck', async () => {
  const first = result('b', 'DIFF')
  const second = result('c', 'DIFF')
  const exhausted = new Set([first.peerId, second.peerId])
  let enrollments = 0
  const { outcome, verified } = await run({
    results: [first, second],
    exhausted,
    enroll: async () => { enrollments += 1; exhausted.clear() },
  })
  assert.equal(enrollments, 1)
  assert.deepEqual(verified, [first.peerId, second.peerId])
  assert.deepEqual(outcome.results.map((entry) => entry.status), ['DIFF', 'DIFF'])
})

test('a seller still short of unseen questions after one enrollment triggers another, up to the limit', async () => {
  const first = result('b', 'DIFF')
  const stuck = result('c', 'DIFF')
  const exhausted = new Set([first.peerId, stuck.peerId])
  let enrollments = 0
  const { outcome, verified } = await run({
    results: [first, stuck],
    exhausted,
    // The first enrollment is enough for one seller; the second one never gets enough.
    enroll: async () => { enrollments += 1; if (enrollments === 2) exhausted.delete(first.peerId) },
  })
  assert.equal(enrollments, RECHECK_ENROLLMENT_ROUNDS)
  assert.deepEqual(verified, [first.peerId])
  assert.deepEqual(outcome.results.map((entry) => [entry.peerId, entry.status, Boolean(entry.recheck), Boolean(entry.recheckPending)]), [
    [first.peerId, 'DIFF', true, false],
    [stuck.peerId, 'DIFF', false, true],
  ])
  assert.match(outcome.results[1]!.recheckPending!.reason, /BANK_EXHAUSTED/)
})

test('a failed enrollment, a skipped recheck or a recheck error keeps the first DIFF waiting for its recheck', async () => {
  const exhaustedDiff = result('b', 'DIFF')
  const skippedDiff = result('c', 'DIFF')
  const { outcome } = await run({
    results: [exhaustedDiff, skippedDiff],
    exhausted: new Set([exhaustedDiff.peerId]),
    enroll: async () => { throw new Error('budget exhausted') },
    recheckVerdicts: { [skippedDiff.peerId]: 'SKIPPED' },
  })
  assert.deepEqual(outcome.results.map((entry) => entry.status), ['DIFF', 'DIFF'])
  assert.match(outcome.results[0]!.recheckPending!.reason, /enrollment failed: budget exhausted/)
  assert.match(outcome.results[1]!.recheckPending!.reason, /recheck skipped: no ResponseAuth/)
  assert.equal(outcome.stats.pending, 2)
})

test('a recheck that throws keeps the DIFF waiting too', async () => {
  const diff = result('b', 'DIFF')
  const outcome = await runDiffRechecks({
    results: [diff],
    reserve: async () => ({ reference, auditId: 'recheck-b' }),
    enroll: null,
    verify: async () => { throw new Error('reference endpoint 402: out of credits') },
    concurrency: async (tasks) => { for (const task of tasks) await task() },
    log: () => undefined,
  })
  assert.equal(outcome.results[0]!.status, 'DIFF')
  assert.match(outcome.results[0]!.recheckPending!.reason, /recheck failed: reference endpoint 402/)
})

test('a DIFF carried over from an earlier run keeps its first wait time, and a later recheck clears the wait', async () => {
  const carried = { ...result('b', 'DIFF'), recheckPending: { reason: 'earlier', since: '2026-10-27T00:00:00.000Z' } }
  const stillStuck = await run({ results: [carried], exhausted: new Set([carried.peerId]) })
  assert.equal(stillStuck.outcome.results[0]!.recheckPending!.since, '2026-10-27T00:00:00.000Z')

  const settled = await run({ results: [carried], recheckVerdicts: { [carried.peerId]: 'SAME' } })
  assert.deepEqual(settled.verified, [carried.peerId])
  assert.equal(settled.outcome.results[0]!.status, 'UNDETERMINED')
  assert.equal(settled.outcome.results[0]!.recheck?.status, 'SAME')
  assert.equal(settled.outcome.results[0]!.recheckPending, undefined)
})

test('an already rechecked DIFF is not rechecked again', async () => {
  const confirmed = combineDiffRecheck(result('b', 'DIFF'), result('b', 'DIFF'), 'sha256:x')
  const { verified, outcome } = await run({ results: [confirmed] })
  assert.deepEqual(verified, [])
  assert.equal(outcome.results[0], confirmed)
})
