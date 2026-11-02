import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from './audit-artifacts.js'
import {
  CONFIRMATION_ATTEMPTS,
  countPlan,
  epochCellKey,
  heldForConfirmationRecheck,
  epochModelRows,
  failureBlame,
  mergeEpochRuns,
  writeEpochSubmissionManifest,
} from './epoch-plan.js'
import type { ModelVerificationTargetResult } from './model-run.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'

const EPOCH = '28'

function result(peerId: string, status: ModelVerificationTargetResult['status'], extra: Partial<ModelVerificationTargetResult> = {}): ModelVerificationTargetResult {
  return {
    peerId, displayName: null, agentId: '1', service: 'svc', status, auditId: `audit-${peerId}-${status}`,
    parsedProbeCount: 10, probeCount: 10, correctProbeCount: 10, incorrectProbeCount: 0, correctRate: 1,
    requestCount: 1, cost: emptyAuditCostSummary(), evidencePath: `/e/${peerId}`, evidenceHash: '0x00', ...extra,
  }
}

function run(runId: string, completedAt: string, summaries: Array<Partial<ModelAuditSummaryV1> & { model: string }>) {
  const manifest = {
    version: 1, kind: 'antseed-verifier-run-manifest', runId, state: 'completed', epoch: EPOCH,
    epochSource: 'onchain', epochStartedAt: '2026-10-28T09:54:21.000Z', epochEndsAt: '2026-10-29T09:54:21.000Z',
    startedAt: completedAt, completedAt, summaryPath: '', modelOrder: summaries.map((entry) => entry.model),
    models: [], failureCount: 0,
  } as VerifierRunManifestV1
  return {
    manifest,
    summaries: summaries.map((entry) => ({
      version: 1, kind: 'antseed-verifier-model-summary', runId, epoch: EPOCH, startedAt: completedAt, completedAt,
      results: [], failures: [], skipped: [], cost: emptyAuditCostSummary(), ...entry,
    }) as ModelAuditSummaryV1),
  }
}

const buyerRefused = {
  code: 'transport_error', source: 'transport', retryable: true, affectedBatchCount: 1, totalBatchCount: 1,
  nextAction: 'retry later', summary: 'Pinned peer 593831042384... is outside your buyer routing policy. Pick a different service',
} as const
const sellerDown = { ...buyerRefused, summary: 'Oops, pinned peer could not complete the request.' }

test('failure blame: our buyer, deposit, payment lock and bank are the auditor; transport and auth are the seller', () => {
  assert.equal(failureBlame(buyerRefused), 'auditor')
  assert.equal(failureBlame({ code: 'payment_lock_timeout' }), 'auditor')
  assert.equal(failureBlame({ code: 'audit_failed' }, 'no probe bank exists for glm-5.3'), 'auditor')
  assert.equal(failureBlame(null, 'BANK_EXHAUSTED: 0 probes not yet assigned to seller aa remain for kimi-k3 epoch 29'), 'auditor')
  assert.equal(failureBlame(sellerDown), 'seller')
  assert.equal(failureBlame({ code: 'response_auth_invalid', summary: 'channel_id_mismatch' }), 'seller')
  assert.equal(failureBlame({ code: 'malformed_output' }), 'seller')
  assert.equal(failureBlame({ code: 'audit_failed' }, 'something odd'), 'unclear')
  assert.equal(failureBlame(null), 'unclear')
})

test('the latest result per model and seller wins and decides the action', () => {
  const cells = mergeEpochRuns(EPOCH, [
    run('r1', '2026-10-28T20:00:00.000Z', [{
      model: 'm',
      results: [
        result('a', 'SAME'),
        result('b', 'UNDETERMINED', { outcomeReason: buyerRefused }),
        result('c', 'UNDETERMINED', { outcomeReason: sellerDown }),
        result('d', 'UNDETERMINED', { outcomeReason: sellerDown }),
        result('e', 'DIFF'),
        result('f', 'UNDETERMINED'),
        result('g', 'DIFF'),
      ],
      skipped: [{
        peerId: 'h', displayName: null, agentId: '8', service: 'svc', status: 'SKIPPED', code: 'price_above_reference',
        reason: 'too expensive', source: 'preflight', auditId: null, evidencePath: null, evidenceHash: null,
      }],
      failures: [{ peerId: 'i', agentId: '9', service: 'svc', status: 'FAILED', reason: 'no probe bank exists for m' }],
    }]),
    run('r2', '2026-10-28T23:00:00.000Z', [{
      model: 'm',
      results: [
        result('b', 'UNDETERMINED', { outcomeReason: buyerRefused }),
        result('d', 'UNDETERMINED', { outcomeReason: sellerDown }),
      ],
    }]),
  ])
  const action = (peer: string) => cells.get(epochCellKey('m', peer))!
  assert.equal(action('a').action, 'done')
  assert.equal(action('b').action, 'retry', 'our buyer refused it: retried every run')
  assert.equal(action('b').attempts, 2)
  assert.equal(action('c').action, 'retry', 'seller failed once: one retry')
  assert.equal(action('d').action, 'done', 'seller failed twice: finished for this epoch')
  assert.equal(action('e').state, 'diff', 'a first DIFF is final for this auditor; another auditor confirms it')
  assert.equal(action('e').action, 'done')
  assert.equal(action('f').action, 'done', 'answered but too close to call: asking again repeats it')
  assert.equal(action('g').state, 'diff')
  assert.equal(action('g').action, 'done')
  assert.equal(action('h').action, 'audit', 'a price skip is re-evaluated each run')
  assert.equal(action('i').action, 'retry')
  assert.equal(action('i').blame, 'auditor')
  assert.deepEqual(countPlan(cells.values()), { done: 5, retryAuditor: 2, retrySeller: 1, extend: 0, audit: 1 })
})

test('a later SAME replaces an earlier UNDETERMINED, and a later first DIFF replaces a SAME', () => {
  const cells = mergeEpochRuns(EPOCH, [
    run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [
      result('a', 'UNDETERMINED', { outcomeReason: sellerDown }),
      result('b', 'SAME'),
    ] }]),
    run('r2', '2026-10-28T21:00:00.000Z', [{ model: 'm', results: [
      result('a', 'SAME'),
      result('b', 'DIFF'),
    ] }]),
  ])
  assert.equal(cells.get(epochCellKey('m', 'a'))!.state, 'same')
  assert.equal(cells.get(epochCellKey('m', 'b'))!.state, 'diff')
  const [row] = epochModelRows(cells.values())
  assert.deepEqual({ ...row }, { model: 'm', same: 1, diff: 1, undetermined: 0, closeCalls: 0, failed: 0, skipped: 0, left: 0 })
})

test('runs of another epoch or with a mismatched run id are ignored', () => {
  const other = run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [result('a', 'SAME')] }])
  other.summaries[0]!.epoch = '27'
  assert.equal(mergeEpochRuns(EPOCH, [other]).size, 0)
})

test('the epoch submission manifest holds the merged result per seller and changes id with each run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'epoch-plan-'))
  try {
    const runs = [
      run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [
        result('a', 'UNDETERMINED', { outcomeReason: buyerRefused }),
        result('b', 'SAME'),
      ] }]),
      run('r2', '2026-10-28T21:00:00.000Z', [{ model: 'm', results: [result('a', 'SAME')] }]),
    ]
    const state = { epoch: EPOCH, manifests: runs.map((entry) => entry.manifest), cells: mergeEpochRuns(EPOCH, runs) }
    // Summaries come from disk in the real flow; point the manifests at written files.
    const { writeJsonAtomic } = await import('./atomic-files.js')
    for (const entry of runs) {
      const path = join(directory, `${entry.manifest.runId}.summary.json`)
      await writeJsonAtomic(path, entry.summaries[0])
      entry.manifest.models = [{ model: 'm', summaryPath: path } as VerifierRunManifestV1['models'][number]]
    }
    const manifest = await writeEpochSubmissionManifest(directory, state)
    assert.equal(manifest.epoch, EPOCH)
    assert.equal(manifest.startedAt, '2026-10-28T20:00:00.000Z')
    assert.equal(manifest.completedAt, '2026-10-28T21:00:00.000Z')
    const summary = JSON.parse(await readFile(manifest.models[0]!.summaryPath, 'utf8')) as ModelAuditSummaryV1
    assert.equal(summary.runId, manifest.runId)
    assert.deepEqual(summary.results.map((entry) => [entry.peerId, entry.status]), [['a', 'SAME'], ['b', 'SAME']])
    const fewer = await writeEpochSubmissionManifest(directory, { ...state, manifests: [runs[0]!.manifest] })
    assert.notEqual(fewer.runId, manifest.runId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a close call waiting for extra questions is pending_extension, not submitted, and counted as left', () => {
  const grey = {
    decisionRule: 'kbf-extension-v1' as const,
    responseAuthVerified: true,
    stats: { selfHamming: 30, selfTotal: 300, targetHamming: 22, targetTotal: 100, selfCoverage: 1, targetCoverage: 1, p0Cp99: 0.155, pValueBinomial: 0.05 },
  }
  const cells = mergeEpochRuns(EPOCH, [
    run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [
      result('a', 'SAME'),
      result('b', 'SAME', { ...grey, extensionPending: { reason: 'no fresh questions', since: 'x' } }),
    ] }]),
  ])
  const cell = cells.get(epochCellKey('m', 'b'))!
  assert.equal(cell.state, 'pending_extension')
  assert.equal(cell.action, 'extend')
  assert.equal(cell.reason, 'no fresh questions')
  assert.equal(countPlan(cells.values()).extend, 1)
  const [row] = epochModelRows(cells.values())
  assert.deepEqual({ ...row }, { model: 'm', same: 1, diff: 0, undetermined: 0, closeCalls: 1, failed: 0, skipped: 0, left: 1 })
})

test('a confirmation\'s UNDETERMINED from a failure is held and retried up to CONFIRMATION_ATTEMPTS; a close call is not', () => {
  const confirming = (peerId: string, extra: Partial<ModelVerificationTargetResult> = {}) => (
    result(peerId, 'UNDETERMINED', { outcomeReason: sellerDown, confirmsDiff: true, ...extra })
  )
  const attempts = (count: number, last: ModelVerificationTargetResult) => Array.from({ length: count }, (_, index) => (
    run(`r${index}`, `2026-10-28T2${index}:00:00.000Z`, [{ model: 'm', results: [index === count - 1 ? last : confirming(last.peerId)] }])
  ))
  const cell = (runs: ReturnType<typeof run>[], peerId: string) => mergeEpochRuns(EPOCH, runs).get(epochCellKey('m', peerId))!
  assert.equal(CONFIRMATION_ATTEMPTS, 3)

  // An ordinary seller failure is done after two attempts; a confirmation gets a third.
  const second = cell(attempts(2, confirming('a')), 'a')
  assert.equal(second.action, 'retry')
  assert.equal(heldForConfirmationRecheck(second), true)
  assert.equal(cell(attempts(2, result('a', 'UNDETERMINED', { outcomeReason: sellerDown })), 'a').action, 'done')
  // After the last attempt the UNDETERMINED is submitted.
  const third = cell(attempts(3, confirming('a')), 'a')
  assert.equal(third.action, 'done')
  assert.equal(heldForConfirmationRecheck(third), false)
  // A re-check that answers decides the cell.
  assert.equal(cell(attempts(2, result('a', 'DIFF', { confirmsDiff: true })), 'a').state, 'diff')
  // A close call that stayed undecided after its extra questions is final: asking again repeats it.
  const tie = cell(attempts(1, result('a', 'UNDETERMINED', { confirmsDiff: true })), 'a')
  assert.equal(tie.action, 'done')
  assert.equal(heldForConfirmationRecheck(tie), false)
})

test('the submission leaves out a held confirmation UNDETERMINED and says why', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'epoch-plan-held-'))
  try {
    const runs = [run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [
      result('a', 'UNDETERMINED', { outcomeReason: sellerDown, confirmsDiff: true }),
      result('b', 'UNDETERMINED', { outcomeReason: sellerDown }),
    ] }])]
    const state = { epoch: EPOCH, manifests: runs.map((entry) => entry.manifest), cells: mergeEpochRuns(EPOCH, runs) }
    const { writeJsonAtomic } = await import('./atomic-files.js')
    const path = join(directory, 'r1.summary.json')
    await writeJsonAtomic(path, runs[0]!.summaries[0])
    runs[0]!.manifest.models = [{ model: 'm', summaryPath: path } as VerifierRunManifestV1['models'][number]]
    const manifest = await writeEpochSubmissionManifest(directory, state)
    const summary = JSON.parse(await readFile(manifest.models[0]!.summaryPath, 'utf8')) as ModelAuditSummaryV1
    // Only the ordinary UNDETERMINED is submitted (and retried); the confirmation's waits for its re-check.
    assert.deepEqual(summary.results.map((entry) => entry.peerId), ['b'])
    assert.deepEqual(summary.failures.map((entry) => entry.peerId), ['a'])
    assert.match(summary.failures[0]!.reason, /^held: UNDETERMINED .*\(attempt 1 of 3\)$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
