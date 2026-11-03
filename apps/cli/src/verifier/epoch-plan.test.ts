import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from './audit-artifacts.js'
import {
  AUDITOR_FAILURE_ATTEMPTS,
  CONFIRMATION_ATTEMPTS,
  countPlan,
  epochCellKey,
  heldForConfirmationRecheck,
  SELLER_RETRY_SPACING_SECONDS,
  sellerRetryDueAt,
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
  assert.equal(action('b').action, 'done', 'our buyer refuses it on every attempt: not retried')
  assert.equal(action('b').permanent, true)
  assert.equal(action('b').attempts, 0, 'failures caused by the auditor do not use up the seller\'s retries')
  assert.equal(action('b').auditorAttempts, 2)
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
  assert.deepEqual(countPlan(cells.values()), { done: 6, retryAuditor: 1, retrySeller: 1, extend: 0, audit: 1 })
})

test('a failure caused by the auditor does not use up the seller\'s retry', () => {
  // Epoch 29 on mainnet: our buyer proxy mixed up request IDs, then the seller timed out once.
  const ourAuthBug = {
    code: 'response_auth_invalid', source: 'response_auth', retryable: true, affectedBatchCount: 21, totalBatchCount: 21,
    nextAction: 'resume audit', summary: 'buyer proxy request ID mismatch (a06e1ead != b7ecb4bc)',
  } as const
  const deadline = { ...sellerDown, code: 'deadline_exceeded', summary: 'seller sent no answer for 600000ms' } as const
  // Runs four hours apart, so each seller failure counts (SELLER_RETRY_SPACING_SECONDS).
  const cell = (...reasons: Array<typeof ourAuthBug | typeof deadline>) => mergeEpochRuns(EPOCH, reasons.map((reason, index) => (
    run(`r${index}`, `2026-10-28T${String(4 * index).padStart(2, '0')}:00:00.000Z`, [{ model: 'm', results: [result('a', 'UNDETERMINED', { outcomeReason: reason })] }])
  ))).get(epochCellKey('m', 'a'))!

  const afterOurBug = cell(ourAuthBug, ourAuthBug, deadline)
  assert.equal(afterOurBug.blame, 'seller')
  assert.equal(afterOurBug.attempts, 1)
  assert.equal(afterOurBug.action, 'retry', 'only one of the three audits was the seller\'s failure')
  assert.equal(cell(ourAuthBug, deadline, deadline).action, 'done', 'two seller failures finish the cell')

  // Failures and runtime skips caused by the auditor are left out too.
  const cells = mergeEpochRuns(EPOCH, [run('r0', '2026-10-28T20:00:00.000Z', [{
    model: 'm',
    failures: [
      { peerId: 'b', agentId: '2', service: 'svc', status: 'FAILED', reason: 'no probe bank exists for m' },
      { peerId: 'c', agentId: '3', service: 'svc', status: 'FAILED', reason: 'seller closed the stream', outcomeReason: sellerDown },
    ],
  }])])
  assert.equal(cells.get(epochCellKey('m', 'b'))!.attempts, 0)
  assert.equal(cells.get(epochCellKey('m', 'c'))!.attempts, 1)
})

test('seller failures less than SELLER_RETRY_SPACING_SECONDS apart count as one, and the retry waits for it', () => {
  // Epoch 29: GesundAI's upstream usage limit was still on when its retry ran two hours later.
  const failure = (runId: string, at: string) => run(runId, at, [{
    model: 'm', results: [result('a', 'UNDETERMINED', { outcomeReason: sellerDown })],
  }])
  assert.equal(SELLER_RETRY_SPACING_SECONDS, 3 * 60 * 60)
  const close = mergeEpochRuns(EPOCH, [
    failure('r1', '2026-10-28T14:23:00.000Z'),
    failure('r2', '2026-10-28T16:17:00.000Z'),
  ]).get(epochCellKey('m', 'a'))!
  assert.equal(close.attempts, 1)
  assert.equal(close.action, 'retry')
  assert.equal(sellerRetryDueAt(close), Date.parse('2026-10-28T16:17:00.000Z') / 1_000 + SELLER_RETRY_SPACING_SECONDS)
  // An auditor failure has no such wait.
  const ours = mergeEpochRuns(EPOCH, [run('r1', '2026-10-28T14:23:00.000Z', [{
    model: 'm', results: [result('b', 'UNDETERMINED', { outcomeReason: { ...sellerDown, summary: 'seller audit reached its time limit of 3600000ms' } })],
  }])]).get(epochCellKey('m', 'b'))!
  assert.equal(ours.blame, 'auditor')
  assert.equal(sellerRetryDueAt(ours), null)
})

test('the fixed audit deadline of earlier releases was the auditor\'s limit; no answer for the idle limit is the seller\'s', () => {
  assert.equal(failureBlame({ code: 'deadline_exceeded', summary: 'seller audit deadline exceeded after 600000ms' }), 'auditor')
  assert.equal(failureBlame({ code: 'deadline_exceeded', summary: 'seller audit reached its time limit of 3600000ms' }), 'auditor')
  assert.equal(failureBlame({ code: 'deadline_exceeded', summary: 'seller sent no answer for 600000ms' }), 'seller')
})

test('failures caused by the auditor are retried up to AUDITOR_FAILURE_ATTEMPTS times per epoch', () => {
  // Epoch 29 e2e: a seller our side kept failing was audited again every five-minute run.
  const ourTimeout = {
    code: 'request_timeout', source: 'transport', retryable: true, affectedBatchCount: 17, totalBatchCount: 17,
    nextAction: 'resume audit', summary: 'buyer proxy request timed out after 120000ms',
  } as const
  const cell = (count: number) => mergeEpochRuns(EPOCH, Array.from({ length: count }, (_, index) => (
    run(`r${index}`, `2026-10-28T2${index}:00:00.000Z`, [{ model: 'm', results: [result('a', 'UNDETERMINED', { outcomeReason: ourTimeout })] }])
  ))).get(epochCellKey('m', 'a'))!
  assert.equal(AUDITOR_FAILURE_ATTEMPTS, 3)
  assert.equal(cell(AUDITOR_FAILURE_ATTEMPTS - 1).action, 'retry')
  assert.equal(cell(AUDITOR_FAILURE_ATTEMPTS).action, 'done')
  assert.equal(cell(AUDITOR_FAILURE_ATTEMPTS).attempts, 0, 'still none of the seller\'s retries used')
  // A failure that repeats on every attempt is not retried at all.
  const refused = mergeEpochRuns(EPOCH, [run('r0', '2026-10-28T20:00:00.000Z', [{
    model: 'm',
    failures: [{ peerId: 'b', agentId: '2', service: 'svc', status: 'FAILED', reason: buyerRefused.summary, outcomeReason: buyerRefused }],
  }])]).get(epochCellKey('m', 'b'))!
  assert.equal(refused.blame, 'auditor')
  assert.equal(refused.action, 'done')
})

test('an UNDETERMINED caused by the auditor is never submitted', async () => {
  // Epoch 29 e2e: our buyer refused NovaRoute AI, and its "coverage 0" UNDETERMINED was submitted.
  const directory = await mkdtemp(join(tmpdir(), 'epoch-plan-auditor-'))
  try {
    const runs = [run('r1', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [
      result('a', 'UNDETERMINED', { outcomeReason: buyerRefused }),
      result('b', 'UNDETERMINED', { outcomeReason: sellerDown }),
      result('c', 'SAME'),
    ] }])]
    const state = { epoch: EPOCH, manifests: runs.map((entry) => entry.manifest), cells: mergeEpochRuns(EPOCH, runs) }
    const { writeJsonAtomic } = await import('./atomic-files.js')
    const path = join(directory, 'r1.summary.json')
    await writeJsonAtomic(path, runs[0]!.summaries[0])
    runs[0]!.manifest.models = [{ model: 'm', summaryPath: path } as VerifierRunManifestV1['models'][number]]
    const manifest = await writeEpochSubmissionManifest(directory, state)
    const summary = JSON.parse(await readFile(manifest.models[0]!.summaryPath, 'utf8')) as ModelAuditSummaryV1
    assert.deepEqual(summary.results.map((entry) => entry.peerId), ['b', 'c'], 'the seller\'s own failure and the SAME are submitted')
    assert.deepEqual(summary.failures.map((entry) => entry.peerId), ['a'])
    assert.match(summary.failures[0]!.reason, /^not submitted: UNDETERMINED caused by this auditor .*not retried/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
  const spaced = [0, 4].map((hour, index) => run(`s${index}`, `2026-10-28T0${hour}:00:00.000Z`, [{
    model: 'm', results: [result('a', 'UNDETERMINED', { outcomeReason: sellerDown })],
  }]))
  assert.equal(cell(spaced, 'a').action, 'done')
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

test('a confirmation whose close-call extension failed is retried; a decided or non-confirming one is done', () => {
  const extension = (extra: Partial<NonNullable<ModelVerificationTargetResult['extension']>> = {}) => ({
    rule: 'kbf-extension-v2', auditId: 'x', status: 'UNDETERMINED', referenceId: 'ref', probeCount: 10, parsedProbeCount: 10,
    correctProbeCount: 10, responseAuthVerified: true, stats: null, cost: emptyAuditCostSummary(), evidencePath: '/x', evidenceHash: '0x01',
    firstLook: { status: 'UNDETERMINED', pValue: 0.5 },
    pooled: { selfHamming: 0, selfTotal: 0, targetHamming: 0, targetTotal: 0, pValueBinomial: 0.5, verdict: 'UNDETERMINED', verdictReason: null },
    ...extra,
  }) as unknown as NonNullable<ModelVerificationTargetResult['extension']>
  // The close call waited for its extra questions in one run and was extended in the next.
  const cell = (last: ModelVerificationTargetResult) => mergeEpochRuns(EPOCH, [
    run('r0', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [result('a', 'UNDETERMINED', { confirmsDiff: true, extensionPending: { reason: 'close call', since: '' } } as Partial<ModelVerificationTargetResult>)] }]),
    run('r1', '2026-10-28T21:00:00.000Z', [{ model: 'm', results: [last] }]),
  ]).get(epochCellKey('m', 'a'))!

  // Extra sets that failed (an outcome reason) or answered without verified ResponseAuth.
  const timedOut = cell(result('a', 'UNDETERMINED', { confirmsDiff: true, outcomeReason: sellerDown, extension: extension() }))
  assert.equal(timedOut.action, 'retry')
  assert.equal(heldForConfirmationRecheck(timedOut), true)
  const unverified = cell(result('a', 'UNDETERMINED', { confirmsDiff: true, extension: extension({ responseAuthVerified: false }) }))
  assert.equal(unverified.action, 'retry')
  assert.equal(heldForConfirmationRecheck(unverified), true)
  // A close call still undecided after answering every extra question is final.
  const tie = cell(result('a', 'UNDETERMINED', { confirmsDiff: true, extension: extension() }))
  assert.equal(tie.action, 'done')
  assert.equal(heldForConfirmationRecheck(tie), false)
  // Not a confirmation: no waiting DIFF depends on it, so a failed extension is not audited again.
  assert.equal(cell(result('a', 'UNDETERMINED', { outcomeReason: sellerDown, extension: extension() })).action, 'done')
})

test('a result of the retired DIFF self-recheck that ended UNDETERMINED is audited again', () => {
  const legacy = (status: ModelVerificationTargetResult['status']) => ({
    ...result('a', status),
    recheck: { status: 'SAME', auditId: 'r', evidencePath: '/r', evidenceHash: '0x02' },
  }) as ModelVerificationTargetResult
  const cell = (last: ModelVerificationTargetResult) => (
    mergeEpochRuns(EPOCH, [run('r0', '2026-10-28T20:00:00.000Z', [{ model: 'm', results: [last] }])]).get(epochCellKey('m', 'a'))!
  )
  assert.equal(cell(legacy('UNDETERMINED')).action, 'audit')
  // Both checks found DIFF: the result is the first check's DIFF, which is still valid.
  assert.equal(cell(legacy('DIFF')).action, 'done')
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
