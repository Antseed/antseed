import assert from 'node:assert/strict'
import test from 'node:test'
import { computeKbfVerdict, type FingerprintStats, type KbfReferenceV1 } from '@antseed/fingerprints'
import { needsExtension, stageOneVerdict } from './close-call.js'
import { runDiffRechecks } from './diff-recheck.js'
import { combineExtension, runExtensionRounds } from './extension-round.js'
import { finalAuditVerdict } from './model-audit.js'
import type { ModelVerificationSkip, ModelVerificationTargetResult } from './model-run.js'
import { BANK_EXHAUSTED } from './probe-bank.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'

const SELF = { selfHamming: 30, selfTotal: 300 } // 10% self-error over 100 probes x 3 runs

/** A first audit of 100 probes with `wrong` mismatches, scored as a real audit would be. */
function audit(peer: string, wrong: number, options: { rule?: boolean; answered?: number } = {}): ModelVerificationTargetResult {
  const answered = options.answered ?? 100
  const vector = Array.from({ length: 100 }, (_, index) => index >= answered ? null : index < wrong ? 0 : 1)
  const verdict = computeKbfVerdict({ ...SELF, targetMatchVector: vector, minCoverage: 0.5, minDiffCoverage: 0.8 })
  const stats: FingerprintStats = { ...verdict.stats, selfCoverage: 1 }
  return {
    peerId: peer.repeat(40).slice(0, 40),
    displayName: null,
    agentId: '7',
    service: 'model-a',
    status: verdict.verdict as ModelVerificationTargetResult['status'],
    auditId: `audit-${peer}-${wrong}`,
    parsedProbeCount: answered,
    probeCount: 100,
    correctProbeCount: answered - Math.min(wrong, answered),
    incorrectProbeCount: Math.min(wrong, answered),
    correctRate: (answered - Math.min(wrong, answered)) / answered,
    requestCount: 10,
    cost: emptyAuditCostSummary(),
    evidencePath: `/evidence/${peer}-${wrong}.json`,
    evidenceHash: `0x${peer.repeat(64).slice(0, 64)}`,
    stats,
    responseAuthVerified: true,
    ...(options.rule === false ? {} : { decisionRule: 'kbf-extension-v1' as const }),
  }
}

const reference = { referenceId: 'sha256:extension', probes: Array.from({ length: 100 }, () => ({})) } as unknown as KbfReferenceV1

async function run(input: {
  results: ModelVerificationTargetResult[]
  extensionWrong?: Record<string, number | 'SKIPPED' | 'THROW'>
  exhausted?: Set<string>
  enroll?: (() => Promise<void>) | null
}) {
  const logs: string[] = []
  const verified: string[] = []
  const outcome = await runExtensionRounds({
    results: input.results,
    reserve: async (first) => {
      if (input.exhausted?.has(first.peerId)) throw new Error(`${BANK_EXHAUSTED}: 20 probes remain`)
      return { reference, auditId: `extension-${first.peerId}` }
    },
    enroll: input.enroll ?? null,
    verify: async (first): Promise<ModelVerificationTargetResult | ModelVerificationSkip> => {
      verified.push(first.peerId)
      const wrong = input.extensionWrong?.[first.peerId] ?? 10
      if (wrong === 'THROW') throw new Error('reference endpoint down')
      if (wrong === 'SKIPPED') {
        return {
          peerId: first.peerId, displayName: null, agentId: first.agentId, service: first.service,
          status: 'SKIPPED', code: 'missing_response_auth', reason: 'no ResponseAuth', source: 'runtime',
          auditId: null, evidencePath: null, evidenceHash: null,
        }
      }
      const { decisionRule: _rule, ...second } = audit(first.peerId[0]!, wrong)
      return { ...second, peerId: first.peerId, auditId: `second-${first.peerId}` }
    },
    concurrency: async (tasks) => { for (const task of tasks) await task() },
    log: (message) => logs.push(message),
  })
  return { outcome, logs, verified }
}

test('the grey zone is 0.005 <= p < 0.20 with enough answers, and only under the close-call rule', () => {
  // 10% self-error over 300 runs: CP99 upper bound ~0.155.
  const clearSame = audit('a', 12)
  const grey = audit('b', 22)
  const clearDiff = audit('c', 35)
  assert.ok(clearSame.stats!.pValueBinomial! >= 0.2)
  assert.ok(grey.stats!.pValueBinomial! >= 0.005 && grey.stats!.pValueBinomial! < 0.2)
  assert.ok(clearDiff.stats!.pValueBinomial! < 0.005)
  assert.equal(needsExtension(clearSame), false)
  assert.equal(needsExtension(grey), true)
  assert.equal(needsExtension(clearDiff), false)
  // Legacy results (no decisionRule) keep the single-look rule.
  assert.equal(needsExtension(audit('d', 22, { rule: false })), false)
  // Coverage below 0.5 is UNDETERMINED, never extended.
  assert.equal(needsExtension(audit('e', 10, { answered: 40 })), false)
  // A set whose ResponseAuth failed is UNDETERMINED whatever its p-value.
  assert.equal(needsExtension({ ...grey, responseAuthVerified: false }), false)
})

test('a close call is not submitted until extended; a clear first look is decided as before', () => {
  const grey = audit('b', 22)
  assert.equal(stageOneVerdict(grey), null)
  assert.equal(finalAuditVerdict(grey), null)
  assert.equal(finalAuditVerdict(audit('a', 12)), 'SAME')
  assert.equal(finalAuditVerdict(audit('c', 35)), null, 'a clear DIFF still waits for its recheck')
  assert.equal(stageOneVerdict(audit('c', 35)), 'DIFF')
})

test('only close calls are extended; the pooled verdict decides stage 1', async () => {
  const clearSame = audit('a', 12)
  const greyHonest = audit('b', 22)
  const greyBad = audit('c', 22)
  const clearDiff = audit('d', 35)
  const { outcome, verified, logs } = await run({
    results: [clearSame, greyHonest, greyBad, clearDiff],
    extensionWrong: { [greyHonest.peerId]: 10, [greyBad.peerId]: 30 },
  })
  assert.deepEqual(verified, [greyHonest.peerId, greyBad.peerId])
  assert.equal(outcome.results[0], clearSame)
  assert.equal(outcome.results[3], clearDiff)
  const honest = outcome.results[1]!
  assert.equal(honest.status, 'SAME')
  assert.equal(honest.extension?.pooled.targetHamming, 32)
  assert.equal(honest.extension?.pooled.targetTotal, 200)
  assert.equal(honest.extension?.pooled.selfTotal, 600)
  assert.equal(honest.extension?.firstLook.pValue, greyHonest.stats!.pValueBinomial)
  assert.equal(finalAuditVerdict(honest), 'SAME')
  const bad = outcome.results[2]!
  assert.equal(bad.status, 'DIFF')
  assert.equal(stageOneVerdict(bad), 'DIFF')
  assert.equal(finalAuditVerdict(bad), null, 'a pooled DIFF still needs the recheck')
  assert.deepEqual(
    { extended: outcome.stats.extended, same: outcome.stats.same, diff: outcome.stats.diff, pending: outcome.stats.pending },
    { extended: 2, same: 1, diff: 1, pending: 0 },
  )
  assert.ok(logs.some((line) => line.includes('goes to the recheck')))
})

test('a pooled DIFF goes on to the recheck; a close call still extending does not', async () => {
  const greyBad = audit('c', 22)
  const greyWaiting = audit('e', 22)
  const { outcome } = await run({
    results: [greyBad, greyWaiting],
    extensionWrong: { [greyBad.peerId]: 30 },
    exhausted: new Set([greyWaiting.peerId]),
  })
  const rechecked: string[] = []
  const after = await runDiffRechecks({
    results: outcome.results,
    reserve: async (first) => ({ reference, auditId: `recheck-${first.peerId}` }),
    enroll: null,
    verify: async (first) => {
      rechecked.push(first.peerId)
      return { ...audit(first.peerId[0]!, 40), peerId: first.peerId, auditId: `third-${first.peerId}` }
    },
    concurrency: async (tasks) => { for (const task of tasks) await task() },
    log: () => {},
  })
  assert.deepEqual(rechecked, [greyBad.peerId])
  assert.equal(after.results[0]!.status, 'DIFF')
  assert.ok(after.results[0]!.extension)
  assert.equal(after.results[0]!.recheck?.status, 'DIFF')
  assert.equal(finalAuditVerdict(after.results[0]!), 'DIFF')
  assert.ok(after.results[1]!.extensionPending)
  assert.equal(finalAuditVerdict(after.results[1]!), null)
})

test('a close call stays pending when its extra questions cannot run, and is extended later', async () => {
  const noProbes = audit('a', 22)
  const failed = audit('b', 22)
  const skipped = audit('c', 22)
  const { outcome, logs } = await run({
    results: [noProbes, failed, skipped],
    exhausted: new Set([noProbes.peerId]),
    extensionWrong: { [failed.peerId]: 'THROW', [skipped.peerId]: 'SKIPPED' },
  })
  assert.equal(outcome.stats.pending, 3)
  assert.equal(outcome.stats.extended, 0)
  for (const result of outcome.results) {
    assert.ok(result.extensionPending, 'kept with extensionPending')
    assert.equal(result.extension, undefined)
    assert.equal(finalAuditVerdict(result), null, 'not submitted')
  }
  assert.match(outcome.results[0]!.extensionPending!.reason, /enrollment is off/)
  assert.match(outcome.results[1]!.extensionPending!.reason, /reference endpoint down/)
  assert.match(outcome.results[2]!.extensionPending!.reason, /skipped/)
  assert.ok(logs.some((line) => line.includes('not submitted')))

  // The next run of the epoch extends it without repeating the first audit; `since` is kept.
  const since = outcome.results[1]!.extensionPending!.since
  const later = await run({ results: [outcome.results[1]!] })
  assert.equal(later.outcome.results[0]!.extensionPending, undefined)
  assert.equal(later.outcome.results[0]!.auditId, failed.auditId)
  assert.ok(later.outcome.results[0]!.extension)
  assert.ok(since)
})

test('a close call short of fresh probes enrolls, then extends', async () => {
  const grey = audit('a', 22)
  const exhausted = new Set([grey.peerId])
  let enrollments = 0
  const { outcome } = await run({
    results: [grey],
    exhausted,
    enroll: async () => { enrollments += 1; exhausted.clear() },
  })
  assert.equal(enrollments, 1)
  assert.ok(outcome.results[0]!.extension)
})

test('an extension whose answers lack verified ResponseAuth cannot decide: UNDETERMINED', () => {
  const grey = audit('a', 22)
  const second = { ...audit('a', 10), responseAuthVerified: false, status: 'UNDETERMINED' as const }
  const combined = combineExtension(grey, second, 'sha256:extension')
  assert.equal(combined.status, 'UNDETERMINED')
  assert.equal(combined.extension?.pooled.verdict, 'UNDETERMINED')
  assert.equal(finalAuditVerdict(combined), 'UNDETERMINED')
})
