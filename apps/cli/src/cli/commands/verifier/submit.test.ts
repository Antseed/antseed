import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelAuditLedgerEntryV1, PreparedModelAudit } from '../../../verifier/model-audit.js'
import { modelAuditEvidencePath } from '../../../verifier/model-audit.js'
import { standingSubmissions, withLedgerKey } from './submit.js'

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
