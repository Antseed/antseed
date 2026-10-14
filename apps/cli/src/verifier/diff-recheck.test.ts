import assert from 'node:assert/strict'
import test from 'node:test'
import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { combineDiffRecheck, runDiffRechecks } from './diff-recheck.js'
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
  const { outcome } = await run({
    results: [toSame, toUndetermined],
    recheckVerdicts: { [toSame.peerId]: 'SAME', [toUndetermined.peerId]: 'UNDETERMINED' },
  })
  assert.deepEqual(outcome.results.map((entry) => entry.status), ['UNDETERMINED', 'UNDETERMINED'])
  assert.deepEqual(outcome.results.map((entry) => entry.recheck?.status), ['SAME', 'UNDETERMINED'])
  assert.equal(outcome.stats.notConfirmed, 2)
  assert.equal(outcome.failures.length, 0)
})

test('a DIFF without fresh questions submits nothing when enrollment is off', async () => {
  const diff = result('b', 'DIFF')
  const { outcome, verified } = await run({ results: [diff], exhausted: new Set([diff.peerId]) })
  assert.deepEqual(verified, [])
  assert.equal(outcome.results.length, 0)
  assert.equal(outcome.failures.length, 1)
  assert.match(outcome.failures[0]!.reason, /DIFF not confirmed: recheck skipped, no fresh questions/)
  assert.equal(outcome.stats.skipped, 1)
})

test('exhausted rechecks enroll fresh questions once, then recheck', async () => {
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

test('a failed enrollment or a skipped recheck submits nothing for that seller', async () => {
  const exhaustedDiff = result('b', 'DIFF')
  const skippedDiff = result('c', 'DIFF')
  const { outcome } = await run({
    results: [exhaustedDiff, skippedDiff],
    exhausted: new Set([exhaustedDiff.peerId]),
    enroll: async () => { throw new Error('budget exhausted') },
    recheckVerdicts: { [skippedDiff.peerId]: 'SKIPPED' },
  })
  assert.equal(outcome.results.length, 0)
  assert.deepEqual(outcome.failures.map((entry) => entry.peerId), [exhaustedDiff.peerId, skippedDiff.peerId])
  assert.match(outcome.failures[0]!.reason, /enrollment failed: budget exhausted/)
  assert.equal(outcome.stats.skipped, 2)
})

test('an already rechecked DIFF is not rechecked again', async () => {
  const confirmed = combineDiffRecheck(result('b', 'DIFF'), result('b', 'DIFF'), 'sha256:x')
  const { verified, outcome } = await run({ results: [confirmed] })
  assert.deepEqual(verified, [])
  assert.equal(outcome.results[0], confirmed)
})
