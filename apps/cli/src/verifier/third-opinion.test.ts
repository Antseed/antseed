import assert from 'node:assert/strict'
import test from 'node:test'
import { VERIFIER_VERDICT, modelHash, serviceHash, type ServiceAuditedEvent } from '@antseed/node/payments'
import { alreadyJudgedByOther, opinionKey, otherOpinions, thirdOpinionFilter, thirdOpinionReason } from './third-opinion.js'

const ME = '0x1000000000000000000000000000000000000001'
const A = '0x2000000000000000000000000000000000000002'
const B = '0x3000000000000000000000000000000000000003'
const MODEL = 'model-a'
const SERVICE = 'model-a'

let index = 0
function event(input: {
  auditor: string
  verdict: number
  reports: number
  required: number
  round?: number
  agentId?: bigint
  service?: string
}): ServiceAuditedEvent {
  index += 1
  return {
    agentId: input.agentId ?? 7n,
    serviceHash: serviceHash(input.service ?? SERVICE),
    auditor: input.auditor,
    modelHash: modelHash(MODEL),
    verdict: input.verdict as ServiceAuditedEvent['verdict'],
    round: input.round ?? 0,
    reports: input.reports,
    required: input.required,
    blockNumber: 100 + index,
    logIndex: 0,
    transactionHash: `0x${index.toString(16).padStart(64, '0')}`,
  }
}

const key = opinionKey(7n, serviceHash(SERVICE), modelHash(MODEL))

test('no report by anyone else: the first look is sent', () => {
  const opinions = otherOpinions([event({ auditor: ME, verdict: VERIFIER_VERDICT.DIFF, reports: 1, required: 2 })], ME)
  assert.equal(opinions.size, 0, 'own reports are not opinions')
  assert.equal(thirdOpinionReason(opinions.get(key), { confirmsDiff: false }), null)
})

test('another auditor\'s waiting DIFF: only the planner\'s confirmation is sent', () => {
  const opinions = otherOpinions([event({ auditor: A, verdict: VERIFIER_VERDICT.DIFF, reports: 1, required: 2 })], ME)
  assert.equal(thirdOpinionReason(opinions.get(key), { confirmsDiff: true }), null)
  assert.match(thirdOpinionReason(opinions.get(key), { confirmsDiff: false }) ?? '', /waits for its confirmer/)
})

test('the rotation\'s current confirmer may send a result the run did not flag (an owner whose stand-in reported first)', () => {
  const opinions = otherOpinions([event({ auditor: A, verdict: VERIFIER_VERDICT.DIFF, reports: 1, required: 2 })], ME)
  assert.equal(thirdOpinionReason(opinions.get(key), { confirmsDiff: false }, true), null)
  assert.notEqual(thirdOpinionReason(opinions.get(key), { confirmsDiff: false }, false), null)
})

test('another auditor\'s SAME: no second opinion on a verified seller', () => {
  const opinions = otherOpinions([event({ auditor: A, verdict: VERIFIER_VERDICT.SAME, reports: 1, required: 1 })], ME)
  assert.match(thirdOpinionReason(opinions.get(key), { confirmsDiff: true }) ?? '', /already judged/)
})

test('two opinions, in any rounds: never a third', () => {
  const opinions = otherOpinions([
    event({ auditor: A, verdict: VERIFIER_VERDICT.DIFF, reports: 1, required: 2, round: 0 }),
    event({ auditor: B, verdict: VERIFIER_VERDICT.DIFF, reports: 2, required: 2, round: 0 }),
  ], ME)
  assert.match(thirdOpinionReason(opinions.get(key), { confirmsDiff: true }) ?? '', /2 opinions .* never a third/)
})

test('a confirmed DIFF stays two opinions after the contract moved the round on', () => {
  const opinions = otherOpinions([
    event({ auditor: A, verdict: VERIFIER_VERDICT.DIFF, reports: 1, required: 2, round: 3 }),
    event({ auditor: B, verdict: VERIFIER_VERDICT.DIFF, reports: 2, required: 2, round: 3 }),
  ], ME)
  // No event in round 4 exists; the seller is still not free for a third auditor.
  assert.notEqual(thirdOpinionReason(opinions.get(key), { confirmsDiff: false }), null)
})

test('UNDETERMINED is no opinion: it neither counts nor blocks', () => {
  const opinions = otherOpinions([
    event({ auditor: A, verdict: VERIFIER_VERDICT.DIFF, reports: 1, required: 2 }),
    event({ auditor: B, verdict: VERIFIER_VERDICT.UNDETERMINED, reports: 1, required: 1 }),
  ], ME)
  assert.equal(opinions.get(key)?.size, 1)
  assert.equal(thirdOpinionReason(opinions.get(key), { confirmsDiff: true }), null, 'the next confirmer still confirms')
})

test('an auditor that changed its report counts once, with its latest verdict', () => {
  const opinions = otherOpinions([
    event({ auditor: A, verdict: VERIFIER_VERDICT.DIFF, reports: 1, required: 2 }),
    event({ auditor: A, verdict: VERIFIER_VERDICT.SAME, reports: 1, required: 1 }),
  ], ME)
  const [only] = [...opinions.get(key)!.values()]
  assert.equal(only!.verdict, VERIFIER_VERDICT.SAME)
  assert.match(thirdOpinionReason(opinions.get(key), { confirmsDiff: false }) ?? '', /already judged/)
})

test('the submit filter answers per candidate and ignores other sellers and models', async () => {
  const filter = thirdOpinionFilter({
    events: [event({ auditor: A, verdict: VERIFIER_VERDICT.SAME, reports: 1, required: 1, agentId: 7n })],
    auditor: ME,
  })
  const reasons = await filter(modelHash(MODEL), [
    { agentId: 7n, serviceHash: serviceHash(SERVICE), verdict: VERIFIER_VERDICT.DIFF, auditedAt: 1 },
    { agentId: 8n, serviceHash: serviceHash(SERVICE), verdict: VERIFIER_VERDICT.DIFF, auditedAt: 1 },
  ])
  assert.notEqual(reasons[0], null)
  assert.equal(reasons[1], null)
  const otherModel = await filter(modelHash('model-b'), [{ agentId: 7n, serviceHash: serviceHash(SERVICE), verdict: VERIFIER_VERDICT.SAME, auditedAt: 1 }])
  assert.equal(otherModel[0], null)
})

test('the submit filter lets the rotation\'s confirmer answer a waiting DIFF without the run flag', async () => {
  const events = [event({ auditor: A, verdict: VERIFIER_VERDICT.DIFF, reports: 1, required: 2, agentId: 7n })]
  const mine = new Set([opinionKey(7n, serviceHash(SERVICE), modelHash(MODEL))])
  const withMine = thirdOpinionFilter({ events, auditor: ME, myConfirmations: mine })
  const without = thirdOpinionFilter({ events, auditor: ME })
  const candidate = { agentId: 7n, serviceHash: serviceHash(SERVICE), verdict: VERIFIER_VERDICT.DIFF, auditedAt: 1 }
  assert.equal((await withMine(modelHash(MODEL), [candidate]))[0], null)
  assert.notEqual((await without(modelHash(MODEL), [candidate]))[0], null)
})

test('the planner asks per seller with every service name the model is audited under', () => {
  const opinions = otherOpinions([event({ auditor: A, verdict: VERIFIER_VERDICT.SAME, reports: 1, required: 1, service: 'alias-a' })], ME)
  assert.notEqual(alreadyJudgedByOther(opinions, 7n, [SERVICE, 'alias-a'], MODEL), null)
  assert.equal(alreadyJudgedByOther(opinions, 7n, [SERVICE], MODEL), null)
  assert.equal(alreadyJudgedByOther(opinions, 9n, [SERVICE, 'alias-a'], MODEL), null)
})
