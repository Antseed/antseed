import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelAuditLedgerEntryV1, PreparedModelAudit } from '../../../verifier/model-audit.js'
import { modelAuditEvidencePath } from '../../../verifier/model-audit.js'
import { earlierAttemptToCheck, sameSellerResults, standingSubmissions, withLedgerKey } from './submit.js'

const audit = (evidenceHash: string): PreparedModelAudit => ({
  key: 'model-a',
  evidenceHash,
  evidencePath: modelAuditEvidencePath('/evidence', 'run-1', 'model-a'),
} as PreparedModelAudit)

const entry = (evidenceHash: string, status: ModelAuditLedgerEntryV1['status']): ModelAuditLedgerEntryV1 => ({
  evidenceHash, status,
} as ModelAuditLedgerEntryV1)

test('a model audit keeps its ledger key unless that key was already submitted with other evidence', () => {
  assert.equal(withLedgerKey(audit('0x01'), { models: {} }, '/evidence', 'run-1').key, 'model-a')
  assert.equal(
    withLedgerKey(audit('0x01'), { models: { 'model-a': entry('0x01', 'submitted') } }, '/evidence', 'run-1').key,
    'model-a', 'the same evidence is recognised as already submitted',
  )
  assert.equal(
    withLedgerKey(audit('0x02'), { models: { 'model-a': entry('0x01', 'failed') } }, '/evidence', 'run-1').key,
    'model-a', 'a retry re-sends the earlier evidence under its key',
  )
  const next = withLedgerKey(audit('0x03'), {
    models: { 'model-a': entry('0x01', 'submitted'), 'model-a~2': entry('0x02', 'submitted') },
  }, '/evidence', 'run-1')
  assert.equal(next.key, 'model-a~3', 'a later delta of the same epoch submission gets its own key')
  assert.equal(next.evidencePath, modelAuditEvidencePath('/evidence', 'run-1', 'model-a~3'))
})

test('a retry sends what was prepared now and checks the chain for an earlier attempt\'s other evidence first', () => {
  assert.equal(earlierAttemptToCheck(null, audit('0x02')), null, 'no earlier attempt: nothing to check')
  assert.equal(earlierAttemptToCheck(entry('0x01', 'submitted'), audit('0x02')), null, 'a submitted attempt has its own key')
  assert.equal(earlierAttemptToCheck(entry('0x02', 'pending'), audit('0x02')), null, 'the same evidence is found by its own hash')
  // A pending attempt for {A} and a fresh preparation {A, B}: the fresh one is sent once {A} is known not to be on-chain.
  assert.equal(earlierAttemptToCheck(entry('0x01', 'pending'), audit('0x02')), '0x01')
  assert.equal(earlierAttemptToCheck(entry('0x01', 'failed'), audit('0x02')), '0x01', 'a failed attempt may have been sent too')
  assert.equal(earlierAttemptToCheck(entry('0xAB', 'pending'), audit('0xab')), null, 'hashes compare without case')
})

test('earlier evidence replaces a fresh preparation only with exactly the same seller results', () => {
  const result = (agentId: string, extra: Record<string, unknown> = {}) => ({
    agentId, serviceHash: `0x${agentId}`, verdict: 'DIFF', audit: { evidenceHash: `0xe${agentId}` }, flaggedBy: ['kbf'], ...extra,
  }) as never
  assert.equal(sameSellerResults([result('1'), result('2')], [result('2'), result('1')]), true, 'order does not matter')
  // An unsent attempt for {A} must not replace a fresh {A, B}: B would drop out of what is sent.
  assert.equal(sameSellerResults([result('1')], [result('1'), result('2')]), false)
  assert.equal(sameSellerResults([result('1'), result('2')], [result('1')]), false)
  assert.equal(sameSellerResults([result('1')], [result('1', { passedBy: ['tokens'] })]), false, 'every field counts')
  assert.equal(sameSellerResults([result('1')], [result('1', { auditedAt: 7 })]), false, 'the audit time counts')
  assert.equal(sameSellerResults([result('1'), result('1')], [result('1'), result('2')]), false, 'a result twice is not two')
})

test('a submission made before the latest auditor revocation no longer stands', () => {
  const submission = (blockNumber: number, logIndex: number, evidenceHash: string) => ({ blockNumber, logIndex, evidenceHash })
  const submissions = [submission(10, 0, '0x01'), submission(20, 3, '0x02'), submission(30, 0, '0x03')]
  const set = (blockNumber: number, logIndex: number, auditor: string, approved: boolean) => ({
    auditor, approved, blockNumber, logIndex, transactionHash: '0x', timestamp: 0,
  })
  assert.deepEqual(standingSubmissions(submissions, []), submissions, 'without revocations every submission stands')
  assert.deepEqual(
    standingSubmissions(submissions, [set(5, 0, '0xc', true), set(20, 1, '0xc', false)]).map((entry) => entry.evidenceHash),
    ['0x02', '0x03'], 'the revocation reset the round for the submission before it, so its evidence can be sent again',
  )
  assert.deepEqual(
    standingSubmissions(submissions, [set(25, 0, '0xd', false)]),
    submissions, 'unapproving an auditor that was never approved resets nothing',
  )
})

test('a submission that timed out says nothing is lost and what happens next', async () => {
  const { describeSubmissionFailure } = await import('./submit.js')
  const timeout = Object.assign(new Error('request timeout (code=TIMEOUT, version=6.16.0)'), { code: 'TIMEOUT' })
  const text = describeSubmissionFailure(timeout)
  assert.match(text, /^not confirmed: the RPC did not answer in time/)
  assert.match(text, /checks the chain first and sends it only if it is not there/)
  assert.match(text, /--rpc-url/)
  assert.match(text, /request timeout \(code=TIMEOUT/)
  assert.match(describeSubmissionFailure(new Error('on-chain epoch unavailable (timed out after 10000 ms)')), /^not confirmed/)
})

test('any other failed submission keeps its reason and says it is retried', async () => {
  const { describeSubmissionFailure } = await import('./submit.js')
  const text = describeSubmissionFailure(new Error('execution reverted: NotApprovedAuditor()'))
  assert.match(text, /^submission failed \(continuing\): execution reverted: NotApprovedAuditor\(\)\./)
  assert.match(text, /tries again/)
})

test('a transaction sent but not mined says it is not sent again while pending', async () => {
  const { describeSubmissionFailure } = await import('./submit.js')
  const { ReceiptWaitTimeoutError } = await import('@antseed/node/payments')
  const text = describeSubmissionFailure(new ReceiptWaitTimeoutError(['0x01', '0x02'], 600_000))
  assert.match(text, /^sent \(0x02\) but not mined within 10 min/)
  assert.match(text, /Nothing is sent again while it is pending/)
  assert.doesNotMatch(text, /unknown whether the transaction was sent/)
})

test('a wallet with a transaction still pending is told apart from one whose last transaction just mined', async () => {
  const { pendingTransactionCount } = await import('./submit.js')
  const counts = (...answers: Array<[number, number] | Error>) => {
    let read = 0
    return {
      provider: {
        getTransactionCount: async (_address: string, tag: string) => {
          const answer = answers[Math.min(Math.floor(read++ / 2), answers.length - 1)]!
          if (answer instanceof Error) throw answer
          return tag === 'pending' ? answer[0] : answer[1]
        },
      },
    } as never
  }
  assert.equal(await pendingTransactionCount(counts([5, 5]), '0x1', 0), 0)
  assert.equal(await pendingTransactionCount(counts([6, 5], [6, 5]), '0x1', 0), 1)
  assert.equal(await pendingTransactionCount(counts([6, 5], [6, 6]), '0x1', 0), 0, 'a node a block behind is read again')
  assert.equal(await pendingTransactionCount(counts(new Error('rpc down')), '0x1', 0), null, 'unreadable is not "nothing pending"')
})

test('the first submit of an epoch warns once about the last epoch\'s runs that were never submitted', async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { warnUnsentPreviousEpoch } = await import('./submit.js')
  const dir = await mkdtemp(join(tmpdir(), 'antseed-submit-unsent-'))
  try {
    await mkdir(join(dir, 'runs'), { recursive: true })
    await writeFile(join(dir, 'runs', 'r1.json'), JSON.stringify({
      kind: 'antseed-verifier-run-manifest', runId: `0x${'c'.repeat(64)}`, epoch: '4', completedAt: '2026-11-01T23:50:00.000Z', models: [],
    }))
    const warnings: string[] = []
    await warnUnsentPreviousEpoch(dir, 5n, (text) => warnings.push(text))
    await warnUnsentPreviousEpoch(dir, 5n, (text) => warnings.push(text))
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /^Epoch 4 ended with results that may never have reached the chain/)
    await warnUnsentPreviousEpoch(dir, 0n, (text) => warnings.push(text))
    assert.equal(warnings.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('right before a send, a result another auditor judged meanwhile, or whose confirmation turn ended, holds the model back', async () => {
  const { recheckAuditBeforeSend } = await import('./submit.js')
  const { VERIFIER_VERDICT, modelHash, serviceHash } = await import('@antseed/node/payments')
  const { opinionKey } = await import('../../../verifier/third-opinion.js')
  const ME = '0x' + '1'.repeat(40)
  const OTHER = '0x' + '2'.repeat(40)
  const model = modelHash('model-a')
  const service = serviceHash('model-a')
  // Its evidence's results matter only to the same-check rule, which this test does not pass.
  const audit = { modelHash: model, results: [{ agentId: 7n, serviceHash: service, verdict: VERIFIER_VERDICT.SAME }], evidence: { results: [] } }
  const report = (verdict: number, reports: number, required: number) => ({
    agentId: 7n, serviceHash: service, auditor: OTHER, modelHash: model, verdict, round: 0, reports, required,
    blockNumber: 10, logIndex: 0, transactionHash: '0x01',
  }) as never
  const none = async () => new Set<string>()

  assert.equal(await recheckAuditBeforeSend({ audit, auditor: ME, readEvents: async () => [], readMyConfirmations: none }), null)
  assert.match(
    await recheckAuditBeforeSend({ audit, auditor: ME, readEvents: async () => [report(VERIFIER_VERDICT.SAME, 1, 1)], readMyConfirmations: none }) ?? '',
    /^1 of its 1 result\(s\) changed since it was prepared \(already judged/,
  )
  const waiting = async () => [report(VERIFIER_VERDICT.DIFF, 1, 2)]
  const mine = async () => new Set([opinionKey(7n, service, model)])
  assert.equal(await recheckAuditBeforeSend({ audit, auditor: ME, readEvents: waiting, readMyConfirmations: mine }), null, 'still this auditor\'s turn')
  assert.match(await recheckAuditBeforeSend({ audit, auditor: ME, readEvents: waiting, readMyConfirmations: none }) ?? '', /waits for its confirmer/)
  assert.match(
    await recheckAuditBeforeSend({ audit, auditor: ME, readEvents: async () => { throw new Error('rpc down') }, readMyConfirmations: none }) ?? '',
    /could not re-read this epoch's reports right before sending \(rpc down\)/,
    'a failed read holds the send back',
  )  // A result this auditor has reported since the preparation (an earlier attempt under another key, mined meanwhile)
  // is not sent a second time.
  assert.equal(await recheckAuditBeforeSend({ audit, auditor: ME, readEvents: async () => [], readMyConfirmations: none, alreadyOnChain: () => (async (_model: string, candidates: readonly unknown[]) => candidates.map(() => false)) as never }), null)
  assert.match(
    await recheckAuditBeforeSend({ audit, auditor: ME, readEvents: async () => [], readMyConfirmations: none, alreadyOnChain: () => (async (_model: string, candidates: readonly unknown[]) => candidates.map(() => true)) as never }) ?? '',
    /1 result\(s\) this auditor has reported since it was prepared/,
  )
  // Each row is judged with its own stored audit time, as the preparation judged it (never 0).
  const { resultTimeKey } = await import('../../../verifier/model-audit.js')
  const seen: number[] = []
  await recheckAuditBeforeSend({
    audit: { ...audit, auditedAt: { [resultTimeKey(7n, service)]: 1_800_000_123 } }, auditor: ME, readEvents: async () => [], readMyConfirmations: none,
    alreadyOnChain: () => (async (_model: string, candidates: ReadonlyArray<{ auditedAt: number }>) => { seen.push(...candidates.map((candidate) => candidate.auditedAt)); return candidates.map(() => false) }) as never,
  })
  assert.deepEqual(seen, [1_800_000_123])
})

test('a retry reuses an earlier attempt\'s evidence only for the same results, model and epoch, with its reference files; an unreadable one is never a stop', async () => {
  const { reuseLedgerEvidence } = await import('./submit.js')
  const { canonicalHashBytes32, canonicalJsonStringify } = await import('@antseed/fingerprints')
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = await mkdtemp(join(tmpdir(), 'antseed-submit-reuse-'))
  try {
    const row = { agentId: '7', serviceHash: '0x' + 'ab'.repeat(32), verdict: 'SAME' }
    const document = (extra: Record<string, unknown> = {}) => ({
      version: 1, kind: 'antseed-verifier-model-audit-evidence', model: 'model-a', modelHash: '0x' + 'cd'.repeat(32), epoch: '7',
      results: [row], references: [{ referenceId: 'ref-1', queryProfileHash: '0x00', probeCount: 10, path: 'references/ref-1.json' }], ...extra,
    })
    const earlier = document()
    const earlierPath = join(directory, 'earlier', 'evidence.json')
    await mkdir(join(directory, 'earlier', 'references'), { recursive: true })
    await writeFile(earlierPath, canonicalJsonStringify(earlier))
    await writeFile(join(directory, 'earlier', 'references', 'ref-1.json'), JSON.stringify({ referenceId: 'ref-1' }))
    const fresh = (results = [row], extra: Record<string, unknown> = {}) => {
      const evidence = document({ results, generatedAt: 'now', ...extra })
      return {
        key: 'model-a', model: 'model-a', modelHash: evidence.modelHash, expectedEpoch: 7n, evidence, evidenceHash: canonicalHashBytes32(evidence),
        evidencePath: join(directory, 'fresh.json'), results: [], references: [], auditEvidencePaths: [], referenceEvidence: [],
      } as never
    }
    const ledgerWith = (status: string, evidenceHash = canonicalHashBytes32(earlier), evidencePath = earlierPath) => ({
      version: 1, models: { 'model-a': { status, evidenceHash, evidencePath } },
    }) as never
    // The same results: the earlier evidence is sent, with the reference file it names.
    const [reused] = await reuseLedgerEvidence([fresh()], ledgerWith('pending'))
    assert.equal((reused as { evidenceHash: string }).evidenceHash, canonicalHashBytes32(earlier))
    assert.deepEqual((reused as { references: Array<{ reference: unknown }> }).references.map((entry) => entry.reference), [{ referenceId: 'ref-1' }])
    // Other results, another epoch or model: what was prepared now.
    for (const other of [fresh([{ ...row, verdict: 'DIFF' }]), fresh([row], { epoch: '8' }), fresh([row], { modelHash: '0x' + 'ef'.repeat(32) })]) {
      const [kept] = await reuseLedgerEvidence([other], ledgerWith('pending'))
      assert.equal((kept as { evidenceHash: string }).evidenceHash, (other as { evidenceHash: string }).evidenceHash)
    }
    // An unreadable earlier file, even of a pending entry, is no stop: what was prepared now goes on.
    const prepared = fresh()
    const [fallback] = await reuseLedgerEvidence([prepared], ledgerWith('pending', canonicalHashBytes32(earlier), join(directory, 'missing.json')))
    assert.equal(fallback, prepared)
    // A raw reference exchange file the earlier document names is gone: the whole bundle is not there, so no reuse.
    const incomplete = document({ referenceEvidence: [{ path: 'references/exchanges-gone.jsonl' }] })
    const incompletePath = join(directory, 'earlier', 'incomplete.json')
    await writeFile(incompletePath, canonicalJsonStringify(incomplete))
    const freshAgain = fresh([row], { referenceEvidence: [{ path: 'references/exchanges-gone.jsonl' }] })
    const [notReused] = await reuseLedgerEvidence([freshAgain], ledgerWith('pending', canonicalHashBytes32(incomplete), incompletePath))
    assert.equal(notReused, freshAgain)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('one submit per data dir: a second one gets no lock until the first releases it', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { acquireSubmitLock } = await import('./submit.js')
  const dir = await mkdtemp(join(tmpdir(), 'antseed-submit-lock-'))
  try {
    const first = await acquireSubmitLock(dir)
    assert.ok(first)
    assert.equal(await acquireSubmitLock(dir), null)
    first.releaseSync()
    const again = await acquireSubmitLock(dir)
    assert.ok(again)
    await again.release()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
