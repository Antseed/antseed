import assert from 'node:assert/strict'
import test from 'node:test'
import { getAddress, ZeroHash } from 'ethers'
import {
  VERIFIER_VERDICT,
  modelHash,
  serviceHash,
  type AuditorSetEvent,
  type ServiceAuditedEvent,
  type VerifierVerdict,
} from '@antseed/node/payments'
import { alreadyOnChainFilter, revocationPositions, type SubmissionCandidate } from './submission-delta.js'

const A = getAddress('0x00000000000000000000000000000000000000a1')
const B = getAddress('0x00000000000000000000000000000000000000b2')
const C = getAddress('0x00000000000000000000000000000000000000c3')
const EPOCH = 7n
const MODEL = modelHash('model-a')
const SERVICE = serviceHash('model-a')
/** Block timestamps are the block number times 100. */
const timeOf = (block: number): number => block * 100

let logIndex = 0
function report(auditor: string, verdict: VerifierVerdict, block: number, round = 0, agentId = 1n): ServiceAuditedEvent {
  logIndex += 1
  return {
    agentId, serviceHash: SERVICE, auditor, modelHash: MODEL, verdict, round, reports: 1,
    required: verdict === VERIFIER_VERDICT.DIFF ? 2 : 1, blockNumber: block, logIndex, transactionHash: '0x',
  }
}

const candidate = (verdict: VerifierVerdict, auditedAt = 0, agentId = 1n): SubmissionCandidate => ({
  agentId, serviceHash: SERVICE, verdict, auditedAt,
})

interface Chain {
  round?: number
  status?: { modelHash: string; verdict: VerifierVerdict; epoch: bigint }
  auditorSet?: AuditorSetEvent[]
}

function filterFor(events: ServiceAuditedEvent[], chain: Chain = {}) {
  const reads: string[] = []
  const filter = alreadyOnChainFilter({
    events,
    auditor: A,
    epoch: EPOCH,
    reader: {
      reportRound: async () => { reads.push('round'); return chain.round ?? 0 },
      serviceStatusByHash: async () => {
        reads.push('status')
        return chain.status ?? { modelHash: ZeroHash, verdict: VERIFIER_VERDICT.NONE as VerifierVerdict, epoch: 0n }
      },
      blockTimestamp: async (block) => timeOf(block),
    },
    auditorSetEvents: async () => { reads.push('auditorSet'); return chain.auditorSet ?? [] },
  })
  return { filter: (candidates: SubmissionCandidate[]) => filter(MODEL, candidates), reads }
}

const auditorSet = (auditor: string, approved: boolean, block: number): AuditorSetEvent => ({
  auditor, approved, blockNumber: block, logIndex: 0, timestamp: timeOf(block), transactionHash: '0x',
})

test('a result this auditor already reported in the current round is left out', async () => {
  const { filter } = filterFor([report(A, VERIFIER_VERDICT.DIFF, 10)])
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.DIFF)]), [true], 'a waiting DIFF 1/2 is not re-sent')
})

test('a changed verdict is sent', async () => {
  const { filter, reads } = filterFor([report(A, VERIFIER_VERDICT.DIFF, 10)])
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.SAME)]), [false])
  assert.deepEqual(reads, [], 'nothing is read for a result that is new anyway')
})

test('the latest report decides: a verdict changed back is sent again', async () => {
  const { filter } = filterFor([report(A, VERIFIER_VERDICT.DIFF, 10), report(A, VERIFIER_VERDICT.SAME, 11)])
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.DIFF)]), [false])
})

test('a confirmation of another auditor\'s DIFF is sent', async () => {
  const { filter } = filterFor([report(B, VERIFIER_VERDICT.DIFF, 10)])
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.DIFF)]), [false])
})

test('after a confirmed DIFF starts a new round, neither auditor re-sends its DIFF', async () => {
  const events = [report(A, VERIFIER_VERDICT.DIFF, 10), report(B, VERIFIER_VERDICT.DIFF, 12)]
  const chain = { round: 1, status: { modelHash: MODEL, verdict: VERIFIER_VERDICT.DIFF as VerifierVerdict, epoch: EPOCH } }
  const { filter } = filterFor(events, chain)
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.DIFF, timeOf(20))]), [true], 'even a newer audit adds nothing')
  const asB = alreadyOnChainFilter({
    events, auditor: B, epoch: EPOCH,
    reader: { reportRound: async () => 1, serviceStatusByHash: async () => chain.status, blockTimestamp: async (block) => timeOf(block) },
    auditorSetEvents: async () => [],
  })
  assert.deepEqual(await asB(MODEL, [candidate(VERIFIER_VERDICT.DIFF)]), [true])
})

test('a result recorded in an earlier epoch is reported again this epoch', async () => {
  const { filter } = filterFor([], {
    round: 1, status: { modelHash: MODEL, verdict: VERIFIER_VERDICT.SAME, epoch: EPOCH - 1n },
  })
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.SAME)]), [false])
})

test('an audit made before a DIFF change is not re-sent to count in the new round', async () => {
  // A said SAME; B and C then recorded a DIFF, which starts round 1. A's old SAME no longer counts and
  // must not be carried over: only a fresh audit can support clearing the DIFF.
  const events = [report(A, VERIFIER_VERDICT.SAME, 10), report(B, VERIFIER_VERDICT.DIFF, 12), report(C, VERIFIER_VERDICT.DIFF, 13)]
  const { filter } = filterFor(events, {
    round: 1, status: { modelHash: MODEL, verdict: VERIFIER_VERDICT.DIFF, epoch: EPOCH },
  })
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.SAME, timeOf(9))]), [true], 'the audit already submitted')
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.SAME, timeOf(20))]), [false], 'a re-audit after the DIFF, e.g. a confirmation')
})

test('a report dropped by an auditor revocation is sent again', async () => {
  const events = [report(A, VERIFIER_VERDICT.DIFF, 10)]
  const revoked = [auditorSet(A, true, 1), auditorSet(B, true, 1), auditorSet(C, true, 1), auditorSet(C, false, 11)]
  const { filter, reads } = filterFor(events, { round: 1, auditorSet: revoked })
  assert.deepEqual(await filter([candidate(VERIFIER_VERDICT.DIFF, timeOf(9))]), [false])
  assert.ok(reads.includes('auditorSet'))
  const before = filterFor(events, { round: 1, auditorSet: [auditorSet(C, true, 1), auditorSet(C, false, 9)] })
  assert.deepEqual(await before.filter([candidate(VERIFIER_VERDICT.DIFF, timeOf(9))]), [true], 'a revocation before the report does not explain the new round')
})

test('only an approved auditor set to unapproved counts as a revocation', () => {
  assert.deepEqual(revocationPositions([
    auditorSet(B, false, 1),
    auditorSet(C, true, 2),
    auditorSet(C, false, 3),
    auditorSet(C, false, 4),
  ]), [{ blockNumber: 3, logIndex: 0 }])
})

test('flags follow the candidates and other sellers are independent', async () => {
  const { filter } = filterFor([report(A, VERIFIER_VERDICT.SAME, 10, 0, 1n), report(A, VERIFIER_VERDICT.SAME, 10, 0, 2n)])
  assert.deepEqual(await filter([
    candidate(VERIFIER_VERDICT.SAME, 0, 1n),
    candidate(VERIFIER_VERDICT.DIFF, 0, 2n),
    candidate(VERIFIER_VERDICT.SAME, 0, 3n),
  ]), [true, false, false])
})
