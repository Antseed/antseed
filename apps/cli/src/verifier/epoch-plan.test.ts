import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from './audit-artifacts.js'
import {
  countPlan,
  epochCellKey,
  epochModelRows,
  failureBlame,
  mergeEpochRuns,
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
        result('e', 'DIFF', { recheckPending: { reason: 'no fresh questions' } as never }),
        result('f', 'UNDETERMINED'),
        result('g', 'DIFF', { recheck: { status: 'DIFF' } as never }),
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
  assert.equal(action('e').action, 'recheck')
  assert.equal(action('e').state, 'pending_diff')
  assert.equal(action('f').action, 'done', 'answered but too close to call: asking again repeats it')
  assert.equal(action('g').state, 'diff')
  assert.equal(action('g').action, 'done')
  assert.equal(action('h').action, 'audit', 'a price skip is re-evaluated each run')
  assert.equal(action('i').action, 'retry')
  assert.equal(action('i').blame, 'auditor')
  assert.deepEqual(countPlan(cells.values()), { done: 4, retryAuditor: 2, retrySeller: 1, recheck: 1, audit: 1 })
})

test('a later SAME replaces an earlier UNDETERMINED, and a later first DIFF waits for its recheck', () => {
  const cells = mergeEpochRuns(EPOCH, [
    run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [
      result('a', 'UNDETERMINED', { outcomeReason: sellerDown }),
      result('b', 'SAME'),
    ] }]),
    run('r2', '2026-10-28T21:00:00.000Z', [{ model: 'm', results: [
      result('a', 'SAME'),
      result('b', 'DIFF', { recheckPending: { reason: 'x' } as never }),
    ] }]),
  ])
  assert.equal(cells.get(epochCellKey('m', 'a'))!.state, 'same')
  assert.equal(cells.get(epochCellKey('m', 'b'))!.state, 'pending_diff')
  const [row] = epochModelRows(cells.values())
  assert.deepEqual({ ...row }, { model: 'm', same: 1, diff: 0, undetermined: 0, pendingRecheck: 1, failed: 0, skipped: 0, left: 1 })
})

test('with DIFF confirmation off, a first DIFF is done and later runs leave it alone', () => {
  const first = run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [
    result('a', 'DIFF', { diffConfirmation: 'off' }),
  ] }])
  const second = run('r2', '2026-10-28T21:00:00.000Z', [{ model: 'm', results: [] }])
  const cells = mergeEpochRuns(EPOCH, [first, second])
  const cell = cells.get(epochCellKey('m', 'a'))!
  assert.equal(cell.state, 'diff')
  assert.equal(cell.action, 'done')
  const [row] = epochModelRows(cells.values())
  assert.equal(row!.diff, 1)
  assert.equal(row!.left, 0)
  // Without the marker the same DIFF still waits for its recheck.
  const unconfirmed = mergeEpochRuns(EPOCH, [run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [result('a', 'DIFF')] }])])
  assert.equal(unconfirmed.get(epochCellKey('m', 'a'))!.state, 'pending_diff')
})

test('runs of another epoch or with a mismatched run id are ignored', () => {
  const other = run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [result('a', 'SAME')] }])
  other.summaries[0]!.epoch = '27'
  assert.equal(mergeEpochRuns(EPOCH, [other]).size, 0)
})
