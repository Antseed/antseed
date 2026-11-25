import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelAuditLedgerEntryV1, PreparedModelAudit } from '../../../verifier/model-audit.js'
import { modelAuditEvidencePath } from '../../../verifier/model-audit.js'
import { VerifierEventCache, type RawEventSource } from '../../../verifier/event-cache.js'
import type { ModelAuditedEvent } from '@antseed/node/payments'
import { ownEpochSubmissions, standingSubmissions, withLedgerKey } from './submit.js'

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
  const audit = { modelHash: model, results: [{ agentId: 7n, serviceHash: service, verdict: VERIFIER_VERDICT.SAME }] }
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
  )
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

test('this auditor\'s own submissions are read from the epoch\'s first block, not from the contract\'s deployment', async () => {
  const deploymentBlock = 1_000
  const epochFirstBlock = 40_000
  const me = '0x' + '1'.repeat(40)
  const other = '0x' + '2'.repeat(40)
  const modelA = '0x' + 'aa'.repeat(32)
  const modelB = '0x' + 'bb'.repeat(32)
  const submission = (blockNumber: number, auditor: string, modelHash: string, evidenceHash: string): ModelAuditedEvent => ({
    modelHash, auditor, epoch: 7n, evidenceHash, evidenceUri: '', resultCount: 1, blockNumber, logIndex: 0, transactionHash: '0x01',
  })
  const events = [
    submission(5_000, me, modelA, '0x01'), // an earlier epoch: the contract would reject it now
    submission(45_000, me, modelA, '0x02'), // this epoch, e.g. sent by an attempt that crashed before recording it
    submission(46_000, other, modelA, '0x03'),
    submission(47_000, me, modelB, '0x04'),
  ]
  const reads: Array<[number, number]> = []
  const raw: RawEventSource = {
    contractAddress: '0x' + '86'.repeat(20),
    deploymentBlock,
    async queryServiceAudits() { return [] },
    async queryModelAudits(_filter, from = deploymentBlock, to = 'latest') {
      const end = to === 'latest' ? 50_000 : to
      reads.push([from, end])
      return events.filter((event) => event.blockNumber >= from && event.blockNumber <= end)
    },
    async firstBlockAtOrAfter() { return epochFirstBlock },
    async latestBlockNumber() { return 50_000 },
    provider: { getBlock: async (block: number) => ({ timestamp: block * 10, hash: `0x${block.toString(16)}` }) },
  }
  const cache = new VerifierEventCache(raw, null)
  // What `verifier run` and the epoch reads of `submit` leave in the cache: this epoch's window.
  await cache.modelAudits({}, epochFirstBlock)
  reads.length = 0
  const reader = { queryModelAudits: cache.modelAudits.bind(cache) }
  const noAuditorSetEvents = async () => []

  const mine = await ownEpochSubmissions({ reader, auditor: me, epochFirstBlock, auditorSetEvents: noAuditorSetEvents })
  const ofModel = await ownEpochSubmissions({ reader, auditor: me, model: modelA, epochFirstBlock, auditorSetEvents: noAuditorSetEvents })

  const older = reads.filter(([from]) => from < epochFirstBlock)
  assert.deepEqual(older, [], `no ModelAudited read starts before the epoch's first block ${epochFirstBlock} (reads: ${JSON.stringify(reads)})`)
  assert.equal(cache.stats.modelRanges, 3, 'the warm-up, then only the reorg tail once per lookup')
  assert.deepEqual(mine.map((event) => event.evidenceHash), ['0x02', '0x04'], 'this epoch\'s submissions of every model are found')
  assert.deepEqual(ofModel.map((event) => event.evidenceHash), ['0x02'], 'a standing submission of one model is still found')

  // A revocation after it still makes a submission of this epoch stand no longer.
  const revokedAfter = await ownEpochSubmissions({
    reader, auditor: me, epochFirstBlock,
    auditorSetEvents: async () => [
      { auditor: other, approved: true, blockNumber: 2_000, logIndex: 0, transactionHash: '0x', timestamp: 0 },
      { auditor: other, approved: false, blockNumber: 46_500, logIndex: 0, transactionHash: '0x', timestamp: 0 },
    ],
  })
  assert.deepEqual(revokedAfter.map((event) => event.evidenceHash), ['0x04'])
})
