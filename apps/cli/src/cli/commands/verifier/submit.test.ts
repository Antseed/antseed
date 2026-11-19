import assert from 'node:assert/strict'
import test from 'node:test'
import { verifierVerdict } from '@antseed/node/payments'
import type { AuditPublicationV1, ModelAuditLedgerEntryV1, ModelAuditLedgerV1, PreparedModelAudit } from '../../../verifier/model-audit.js'
import { modelAuditEvidencePath } from '../../../verifier/model-audit.js'
import { earlierAttemptToCheck, sameSellerResults, sendModelAudits, standingSubmissions, withLedgerKey, type SendLoopDeps } from './submit.js'

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
    // A real reference, validated on reuse as everywhere (its content id recomputed).
    const { referenceFixture } = await import('../../../verifier/model-audit-fixtures.test-support.js')
    const kbf = referenceFixture('model-a', 10)
    const document = (extra: Record<string, unknown> = {}) => ({
      version: 1, kind: 'antseed-verifier-model-audit-evidence', model: 'model-a', modelHash: '0x' + 'cd'.repeat(32), epoch: '7',
      results: [row], references: [{ referenceId: kbf.referenceId, queryProfileHash: '0x00', probeCount: kbf.probes.length, path: 'references/ref-1.json' }], ...extra,
    })
    const earlier = document()
    const earlierPath = join(directory, 'earlier', 'evidence.json')
    await mkdir(join(directory, 'earlier', 'references'), { recursive: true })
    await writeFile(earlierPath, canonicalJsonStringify(earlier))
    await writeFile(join(directory, 'earlier', 'references', 'ref-1.json'), JSON.stringify(kbf))
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
    assert.deepEqual((reused as { references: Array<{ reference: { referenceId: string } }> }).references.map((entry) => entry.reference.referenceId), [kbf.referenceId])
    // A damaged reference file that keeps its id: its content id no longer matches, so no reuse.
    await writeFile(join(directory, 'earlier', 'references', 'ref-1.json'), JSON.stringify({ ...kbf, probes: kbf.probes.map((probe, index) => (index === 0 ? { ...probe, id: 'changed' } : probe)) }))
    const damagedFresh = fresh()
    const [notDamaged] = await reuseLedgerEvidence([damagedFresh], ledgerWith('pending'))
    assert.equal(notDamaged, damagedFresh)
    await writeFile(join(directory, 'earlier', 'references', 'ref-1.json'), JSON.stringify(kbf))
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
    // A raw exchange file that is there but not the recorded bytes: no reuse either.
    await writeFile(join(directory, 'earlier', 'references', 'exchanges.jsonl'), 'other bytes')
    const corrupt = document({ referenceEvidence: [{ path: 'references/exchanges.jsonl', sha256: `sha256:${'00'.repeat(32)}` }] })
    const corruptPath = join(directory, 'earlier', 'corrupt.json')
    await writeFile(corruptPath, canonicalJsonStringify(corrupt))
    const freshThird = fresh([row], { referenceEvidence: [{ path: 'references/exchanges.jsonl', sha256: `sha256:${'00'.repeat(32)}` }] })
    const [notCorrupt] = await reuseLedgerEvidence([freshThird], ledgerWith('pending', canonicalHashBytes32(corrupt), corruptPath))
    assert.equal(notCorrupt, freshThird)
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

// The send loop (`sendModelAudits`) with the chain, files and publisher stood in.
const sendLoop = () => {
  const ledger = { models: {} as Record<string, ModelAuditLedgerEntryV1> } as ModelAuditLedgerV1
  const calls = { lookups: [] as string[], evidence: 0, published: [] as string[], sent: [] as Array<{ evidenceHash: string; evidenceUri: string }>, warned: [] as string[] }
  const looked: Record<string, { transactionHash: string; blockNumber: number } | null | Error> = {}
  const deps: SendLoopDeps = {
    findSubmission: async (value) => {
      calls.lookups.push(value.evidenceHash)
      const found = looked[value.evidenceHash] ?? null
      if (found instanceof Error) throw found
      return found
    },
    writeEvidence: async () => { calls.evidence += 1 },
    publish: async (value) => {
      calls.published.push(value.evidenceHash)
      return { evidenceHash: value.evidenceHash, cid: `cid-${value.evidenceHash}`, uri: `ipfs://cid-${value.evidenceHash}` } as AuditPublicationV1
    },
    writeLedger: async () => {},
    recheckBeforeSend: async () => null,
    submit: async (value, evidenceUri) => {
      calls.sent.push({ evidenceHash: value.evidenceHash, evidenceUri })
      return { transactionHash: `0xtx-${value.evidenceHash}`, blockNumber: 42 }
    },
    warn: (line) => { calls.warned.push(line) },
    log: () => {},
    submitAgain: 'antseed verifier submit --run-id run-1',
  }
  return { ledger, calls, looked, deps }
}
const sendable = (evidenceHash: string): PreparedModelAudit => ({
  ...audit(evidenceHash), model: 'model-a', modelHash: '0x' + 'aa'.repeat(32), expectedEpoch: 3n,
  results: [{ agentId: 7n, serviceHash: '0x' + 'bb'.repeat(32), verdict: verifierVerdict('DIFF') }],
} as unknown as PreparedModelAudit)
const earlierAttempt = (status: ModelAuditLedgerEntryV1['status']): ModelAuditLedgerEntryV1 => ({
  key: 'model-a', model: 'model-a', modelHash: '0x' + 'aa'.repeat(32), evidenceHash: '0x01', evidencePath: '/evidence/earlier.json',
  resultCount: 1, evidenceUri: 'ipfs://cid-0x01', publication: { evidenceHash: '0x01', cid: 'cid-0x01', uri: 'ipfs://cid-0x01' } as AuditPublicationV1,
  status, transactionHash: null, blockNumber: null, error: null, lastAttemptAt: '2026-11-19T00:00:00.000Z',
})

test('send loop: an earlier attempt whose evidence is on chain is recorded, nothing is sent, and the submit asks to be run again', async () => {
  const { ledger, calls, looked, deps } = sendLoop()
  const previous = earlierAttempt('pending')
  ledger.models['model-a'] = previous
  looked['0x01'] = { transactionHash: '0xearlier', blockNumber: 40 }
  const tally = await sendModelAudits([{ audit: sendable('0x02'), previous }], ledger, deps)
  assert.deepEqual(calls.lookups, ['0x01'], 'only the earlier evidence is looked up')
  assert.equal(calls.sent.length, 0)
  assert.equal(calls.evidence, 0, 'the fresh evidence is not even written')
  assert.deepEqual(calls.published, [])
  assert.equal(ledger.models['model-a']!.status, 'submitted')
  assert.equal(ledger.models['model-a']!.evidenceHash, '0x01', 'the entry is the earlier attempt, now on chain')
  assert.equal(ledger.models['model-a']!.transactionHash, '0xearlier')
  assert.equal(ledger.models['model-a']!.blockNumber, 40)
  assert.equal(tally.recovered, 1)
  assert.equal(tally.rerun, 1, 'the rest goes out only with another submit')
  assert.equal(tally.submitted, 0)
  assert.equal(tally.unsent.length, 1)
  assert.match(calls.warned.join('\n'), /antseed verifier submit --run-id run-1/)
})

test('send loop: an earlier attempt not on chain gives way to the fresh evidence, sent with its own publication', async () => {
  const { ledger, calls, deps } = sendLoop()
  const previous = earlierAttempt('failed')
  ledger.models['model-a'] = previous
  const tally = await sendModelAudits([{ audit: sendable('0x02'), previous }], ledger, deps)
  assert.deepEqual(calls.lookups, ['0x01', '0x02'], 'the earlier evidence first, then this evidence')
  assert.deepEqual(calls.published, ['0x02'], 'the earlier publication names other evidence, so this one is published')
  assert.deepEqual(calls.sent, [{ evidenceHash: '0x02', evidenceUri: 'ipfs://cid-0x02' }])
  const entry = ledger.models['model-a']!
  assert.equal(entry.status, 'submitted')
  assert.equal(entry.evidenceHash, '0x02')
  assert.equal(entry.evidenceUri, 'ipfs://cid-0x02')
  assert.equal(entry.publication?.evidenceHash, '0x02')
  assert.equal(entry.transactionHash, '0xtx-0x02')
  assert.equal(entry.blockNumber, 42)
  assert.equal(tally.submitted, 1)
  assert.equal(tally.rerun, 0)
  assert.deepEqual(tally.unsent, [])
})

test('send loop: when the chain cannot be read for an earlier attempt, nothing is sent and its entry stays to be checked again', async () => {
  const { ledger, calls, looked, deps } = sendLoop()
  const previous = earlierAttempt('pending')
  ledger.models['model-a'] = previous
  looked['0x01'] = new Error('RPC unavailable')
  const tally = await sendModelAudits([{ audit: sendable('0x02'), previous }], ledger, deps)
  assert.equal(calls.sent.length, 0)
  assert.equal(calls.evidence, 0)
  assert.deepEqual(calls.published, [])
  const entry = ledger.models['model-a']!
  assert.equal(entry.evidenceHash, '0x01', 'still the earlier attempt, so the next submit looks it up again')
  assert.equal(entry.publication?.evidenceHash, '0x01')
  assert.equal(entry.status, 'failed')
  assert.match(entry.error!, /RPC unavailable/)
  assert.equal(tally.failed, 1)
  assert.equal(tally.submitted, 0)
  assert.match(tally.unsent[0]!, /RPC unavailable/)
})
