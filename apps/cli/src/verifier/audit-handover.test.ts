import assert from 'node:assert/strict'
import test from 'node:test'
import { modelHash } from '@antseed/node/payments'
import { VERIFIER_VERDICT, serviceHash, type ServiceAuditedEvent } from '@antseed/node/payments'
import { auditorRotationForModel } from './audit-assignment.js'
import { CONFIRMATION_WINDOW_SECONDS, epochReports, pendingConfirmations } from './pending-confirmations.js'
import {
  auditHandovers,
  countingModelAudits,
  describeHandover,
  handoverModelsFor,
  handoverStage,
  loadEpochModelAudits,
  type HandoverInput,
} from './audit-handover.js'

// Sorted by address, as the rotation sorts them.
const AUDITORS = [
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
].sort((left, right) => (left.toLowerCase() < right.toLowerCase() ? -1 : 1))
const MODELS = ['model-a', 'model-b', 'model-c']
const START = 1_000_000
const LENGTH = 604_800
const EPOCH = 30

const rotationOf = (model: string) => auditorRotationForModel(model, { auditors: AUDITORS, epoch: EPOCH, availableModels: MODELS })
const audit = (model: string, auditor: string) => ({ modelHash: modelHash(model), auditor })
const modelEvent = (model: string, auditor: string, transactionHash = '0x1', epoch = BigInt(EPOCH)) => ({
  modelHash: modelHash(model), auditor, epoch, evidenceHash: '0x', evidenceUri: '', resultCount: 1, blockNumber: 1, logIndex: 0, transactionHash,
})
const serviceEvent = (
  model: string, auditor: string, agentId: number, verdict: ServiceAuditedEvent['verdict'], transactionHash = '0x1', blockNumber = 1,
): ServiceAuditedEvent => ({
  agentId: BigInt(agentId), serviceHash: serviceHash(model), auditor, modelHash: modelHash(model), verdict,
  round: 0, reports: 1, required: 1, blockNumber, logIndex: agentId, transactionHash,
})
/** `real` sellers with a SAME and the rest UNDETERMINED, as one auditor's audit of one model. */
const auditWith = (real: number, sellers: number, auditor = AUDITORS[0]!) => {
  const results = Array.from({ length: sellers }, (_, index) => serviceEvent(
    'model-a', auditor, index + 1, index < real ? VERIFIER_VERDICT.SAME : VERIFIER_VERDICT.UNDETERMINED,
  ))
  return countingModelAudits([modelEvent('model-a', auditor)], results)
}
const input = (overrides: Partial<HandoverInput>): HandoverInput => ({
  auditors: AUDITORS,
  epoch: EPOCH,
  availableModels: MODELS,
  audits: [],
  epochStartedAt: START,
  epochEndsAt: START + LENGTH,
  now: START + LENGTH / 2,
  ...overrides,
})

test('stage: nothing before halfway, 1 from halfway, 2 from three quarters', () => {
  assert.equal(handoverStage(START, START + LENGTH, START), 0)
  assert.equal(handoverStage(START, START + LENGTH, START + LENGTH / 2 - 1), 0)
  assert.equal(handoverStage(START, START + LENGTH, START + LENGTH / 2), 1)
  assert.equal(handoverStage(START, START + LENGTH, START + LENGTH * 0.75 - 1), 1)
  assert.equal(handoverStage(START, START + LENGTH, START + LENGTH * 0.75), 2)
  assert.equal(handoverStage(START, START + LENGTH, START + LENGTH + 10), 2)
  assert.equal(handoverStage(START, START, START + 10), 0, 'an empty epoch has no stage')
})

test('before halfway nothing is handed over, whoever is missing', () => {
  const [first] = rotationOf('model-a')
  const others = AUDITORS.filter((auditor) => auditor !== first)
  assert.deepEqual(auditHandovers(input({
    now: START + LENGTH / 2 - 1,
    audits: others.map((auditor) => audit('model-b', auditor)),
  })), [])
})

test('from halfway an unaudited model goes to the next active auditor in its rotation', () => {
  const [assigned, next, after] = rotationOf('model-a') as [string, string, string]
  const audits = [audit('model-b', next), audit('model-c', after)]
  const handovers = auditHandovers(input({ audits, availableModels: ['model-a'], now: START + LENGTH / 2 }))
  assert.deepEqual(handovers, [{ model: 'model-a', assignedAuditor: assigned, standIn: next, stage: 1, revoked: false }])
  assert.deepEqual(handoverModelsFor(next, input({ audits, availableModels: ['model-a'] })).map((entry) => entry.model), ['model-a'])
  assert.deepEqual(handoverModelsFor(after, input({ audits, availableModels: ['model-a'] })), [])
  assert.deepEqual(handoverModelsFor(assigned, input({ audits, availableModels: ['model-a'] })), [])
})

test('from three quarters it goes to the one after, and stays with the only active candidate', () => {
  const [, next, after] = rotationOf('model-a') as [string, string, string]
  const both = [audit('model-b', next), audit('model-c', after)]
  const late = input({ audits: both, availableModels: ['model-a'], now: START + LENGTH * 0.75 })
  assert.deepEqual(auditHandovers(late).map((entry) => [entry.standIn, entry.stage]), [[after, 2]])
  const onlyNext = input({ audits: [audit('model-b', next)], availableModels: ['model-a'], now: START + LENGTH * 0.75 })
  assert.deepEqual(auditHandovers(onlyNext).map((entry) => [entry.standIn, entry.stage]), [[next, 2]])
})

test('a model audited this epoch by its auditor or by a stand-in is not handed over', () => {
  const [assigned, next, after] = rotationOf('model-a') as [string, string, string]
  const active = [audit('model-b', next), audit('model-c', after)]
  assert.deepEqual(auditHandovers(input({ audits: [...active, audit('model-a', assigned)], availableModels: ['model-a'] })), [])
  assert.deepEqual(auditHandovers(input({ audits: [...active, audit('model-a', next)], availableModels: ['model-a'] })), [])
  assert.deepEqual(auditHandovers(input({ audits: [...active, audit('MODEL-A', after)], availableModels: ['model-a'] })), [],
    'the model name is hashed in lower case, as `modelHash` does')
})

test('an auditor with no audit this epoch is never a stand-in', () => {
  const [, next, after] = rotationOf('model-a') as [string, string, string]
  const onlyAfter = input({ audits: [audit('model-b', after)], availableModels: ['model-a'] })
  assert.deepEqual(auditHandovers(onlyAfter).map((entry) => entry.standIn), [after])
  assert.deepEqual(handoverModelsFor(next, onlyAfter), [])
  assert.deepEqual(auditHandovers(input({ audits: [], availableModels: ['model-a'] })), [], 'nobody active, nobody stands in')
})

test('every auditor computes the same stand-ins, whatever the input order or address case', () => {
  const [, next] = rotationOf('model-a') as [string, string]
  const audits = [audit('model-b', next.toLowerCase()), audit('model-c', next)]
  const expected = auditHandovers(input({ audits }))
  assert.ok(expected.length >= 1)
  assert.deepEqual(auditHandovers(input({
    audits: [...audits].reverse(),
    auditors: [...AUDITORS].reverse().map((auditor) => auditor.toLowerCase()),
    availableModels: [...MODELS].reverse(),
  })), expected)
})

test('loadEpochModelAudits reads from the epoch’s first block and keeps only this epoch’s events', async () => {
  const calls: unknown[] = []
  const records = await loadEpochModelAudits({
    epoch: '30',
    epochStartedAt: START,
    deploymentBlock: 7,
    reader: {
      firstBlockAtOrAfter: async (timestamp, floor) => {
        calls.push(['first', timestamp, floor])
        return 120
      },
      queryModelAudits: async (filter, fromBlock, toBlock) => {
        calls.push(['query', filter, fromBlock, toBlock])
        return [modelEvent('model-a', AUDITORS[0]!, '0xa', 30n), modelEvent('model-b', AUDITORS[1]!, '0xb', 29n)]
      },
      queryServiceAudits: async (_agent, _service, fromBlock, toBlock) => {
        calls.push(['services', fromBlock, toBlock])
        return [
          serviceEvent('model-a', AUDITORS[0]!, 1, VERIFIER_VERDICT.SAME, '0xa'),
          serviceEvent('model-b', AUDITORS[1]!, 1, VERIFIER_VERDICT.SAME, '0xb'),
        ]
      },
    },
  })
  assert.deepEqual(calls, [['first', START, 7], ['query', {}, 120, 'latest'], ['services', 120, 'latest']])
  assert.deepEqual(records, [{ modelHash: modelHash('model-a'), auditor: AUDITORS[0] }])
})

// Liveness edge cases.

test('with one approved auditor there is nobody to stand in', () => {
  const [only] = AUDITORS as [string]
  assert.deepEqual(auditHandovers(input({ auditors: [only], audits: [], now: START + LENGTH - 1 })), [])
  assert.deepEqual(auditHandovers(input({ auditors: [only], audits: [audit('model-b', only)], now: START + LENGTH - 1 })), [])
})

test('with two auditors the active one stands in for every model of the absent one, at both stages', () => {
  const pair = AUDITORS.slice(0, 2) as [string, string]
  const rotation = { auditors: pair, epoch: EPOCH, availableModels: MODELS }
  const [active, absent] = pair
  const absentModels = MODELS.filter((model) => auditorRotationForModel(model, rotation)[0] === absent)
  const activeModels = MODELS.filter((model) => !absentModels.includes(model))
  assert.ok(absentModels.length >= 1 && activeModels.length >= 1)
  const audits = activeModels.map((model) => audit(model, active))
  for (const [now, stage] of [[START + LENGTH / 2, 1], [START + LENGTH * 0.75, 2]] as const) {
    assert.deepEqual(auditHandovers(input({ auditors: pair, audits, now })),
      absentModels.map((model) => ({ model, assignedAuditor: absent, standIn: active, stage, revoked: false })))
  }
})

test('an active auditor that has not audited one of its own models yet still hands it over', () => {
  // Being active (an audit of another model this epoch) does not excuse a model left unaudited.
  const [assigned, next] = rotationOf('model-a') as [string, string]
  const audits = [audit('model-b', assigned), audit('model-c', next)]
  assert.deepEqual(auditHandovers(input({ audits, availableModels: ['model-a'] })),
    [{ model: 'model-a', assignedAuditor: assigned, standIn: next, stage: 1, revoked: false }])
})

test('a model audited by an auditor approved after the epoch started is not handed over', () => {
  const [, next] = rotationOf('model-a') as [string, string]
  const newcomer = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'
  assert.ok(!AUDITORS.includes(newcomer))
  const audits = [audit('model-b', next), audit('model-a', newcomer)]
  assert.deepEqual(auditHandovers(input({ audits, availableModels: ['model-a'] })), [])
  // The newcomer is not in this epoch's rotation, so it is never a stand-in either.
  const onlyNewcomer = input({ audits: [audit('model-b', newcomer)], availableModels: ['model-a'] })
  assert.deepEqual(auditHandovers(onlyNewcomer), [])
})

test('an audit from an earlier epoch does not count: the loader drops it, so the model is handed over', async () => {
  const [assigned, next] = rotationOf('model-a') as [string, string]
  const audits = await loadEpochModelAudits({
    reader: {
      firstBlockAtOrAfter: async () => 0,
      queryModelAudits: async () => [modelEvent('model-a', assigned, '0xa', BigInt(EPOCH - 1)), modelEvent('model-b', next, '0xb')],
      queryServiceAudits: async () => [
        serviceEvent('model-a', assigned, 1, VERIFIER_VERDICT.SAME, '0xa'),
        serviceEvent('model-b', next, 1, VERIFIER_VERDICT.SAME, '0xb'),
      ],
    },
    epoch: EPOCH,
    epochStartedAt: START,
  })
  assert.deepEqual(auditHandovers(input({ audits, availableModels: ['model-a'] })).map((entry) => entry.standIn), [next])
})

test('a stand-in that has audited the model is done, even while the first stand-in stays silent into the last quarter', () => {
  const [, next, after] = rotationOf('model-a') as [string, string, string]
  const audits = [audit('model-b', next), audit('model-c', after), audit('model-a', after)]
  assert.deepEqual(auditHandovers(input({ audits, availableModels: ['model-a'], now: START + LENGTH - 1 })), [])
})

test('every model gets a stand-in when several auditors are absent, and no stand-in is an absent auditor', () => {
  // Only one of four auditors is active: it stands in for every model it was not assigned.
  const [active] = AUDITORS as [string]
  const own = MODELS.filter((model) => rotationOf(model)[0] === active)
  const audits = own.length > 0 ? own.map((model) => audit(model, active)) : [audit('model-a', active)]
  const handovers = auditHandovers(input({ audits, now: START + LENGTH * 0.75 }))
  const unaudited = MODELS.filter((model) => !audits.some((entry) => entry.modelHash === modelHash(model)))
  assert.deepEqual(handovers.map((entry) => entry.model), unaudited)
  assert.ok(handovers.every((entry) => entry.standIn === active && entry.assignedAuditor !== active))
})

test('an audit counts from 20% of its sellers with a SAME or DIFF, in whole numbers', () => {
  assert.deepEqual(auditWith(0, 40), [], 'all UNDETERMINED: it learned nothing')
  assert.deepEqual(auditWith(7, 40), [], '17.5%')
  assert.equal(auditWith(8, 40).length, 1, 'exactly 20%')
  assert.equal(auditWith(3, 15).length, 1, 'exactly 20%, where 15 * 0.2 is a little above 3 in floating point')
  assert.deepEqual(auditWith(1, 6), [], '16.7%')
  assert.equal(auditWith(1, 5).length, 1)
  assert.equal(auditWith(1, 1).length, 1)
})

test('a DIFF is a real answer, and an auditor\'s latest report on a seller is the one that counts', () => {
  const [auditor] = AUDITORS as [string]
  const audits = [modelEvent('model-a', auditor, '0x1'), modelEvent('model-a', auditor, '0x2')]
  assert.equal(countingModelAudits(audits, [serviceEvent('model-a', auditor, 1, VERIFIER_VERDICT.DIFF)]).length, 2)
  assert.equal(countingModelAudits(audits, [
    serviceEvent('model-a', auditor, 1, VERIFIER_VERDICT.UNDETERMINED, '0x1', 1),
    serviceEvent('model-a', auditor, 1, VERIFIER_VERDICT.SAME, '0x2', 2),
  ]).length, 2, 'a retry that got an answer rescues the audit')
  assert.deepEqual(countingModelAudits(audits, [
    serviceEvent('model-a', auditor, 1, VERIFIER_VERDICT.SAME, '0x1', 1),
    serviceEvent('model-a', auditor, 1, VERIFIER_VERDICT.UNDETERMINED, '0x2', 2),
  ]), [])
})

test('reports outside this epoch\'s model audits are ignored, and an audit of only unknown agents does not count', () => {
  const [auditor] = AUDITORS as [string]
  assert.deepEqual(countingModelAudits([modelEvent('model-a', auditor, '0x1')], [
    serviceEvent('model-a', auditor, 1, VERIFIER_VERDICT.SAME, '0xlater'),
  ]), [])
})

test('an audit that learned nothing does not end the model: the stand-in still takes it, and its auditor is not active', () => {
  const [assigned, next] = rotationOf('model-a') as [string, string]
  const audits = [...auditWith(0, 40, assigned), audit('model-b', next)]
  assert.deepEqual(auditHandovers(input({ audits, availableModels: ['model-a', 'model-b'] })).map((entry) => [entry.model, entry.standIn]),
    [['model-a', next]])
  assert.deepEqual(auditHandovers(input({ audits: auditWith(0, 40, next), availableModels: ['model-a'] })), [], 'no active stand-in')
})

test('a revoked auditor\'s model moves at once, before halfway', () => {
  const [assigned, next] = rotationOf('model-a') as [string, string]
  const early = { now: START + 60, audits: [audit('model-b', next)], availableModels: ['model-a'] }
  assert.deepEqual(auditHandovers(input(early)), [], 'not revoked: it waits for halfway')
  const handovers = auditHandovers(input({ ...early, revoked: new Set([assigned]) }))
  assert.deepEqual(handovers, [{ model: 'model-a', assignedAuditor: assigned, standIn: next, stage: 1, revoked: true }])
  assert.match(describeHandover(handovers[0]!), /was revoked this epoch/)
})

test('a revoked auditor is never a stand-in, and its finished audits stand', () => {
  const [assigned, next, third] = rotationOf('model-a') as [string, string, string]
  const audits = [audit('model-b', next), audit('model-c', third)]
  assert.deepEqual(auditHandovers(input({ audits, availableModels: ['model-a'], revoked: new Set([next]) })).map((entry) => entry.standIn), [third])
  assert.deepEqual(auditHandovers(input({
    now: START + 60, audits: [audit('model-a', assigned), audit('model-b', next)], availableModels: ['model-a'], revoked: new Set([assigned]),
  })), [])
})

test('a stand-in\'s DIFF on a handed-over model is confirmed by the next auditor, without waiting for the absent one', () => {
  const [absent, standIn, third, fourth] = rotationOf('model-a') as [string, string, string, string]
  const now = START + LENGTH / 2
  const diff: ServiceAuditedEvent = {
    agentId: 1n, serviceHash: serviceHash('model-a'), auditor: standIn, modelHash: modelHash('model-a'),
    verdict: VERIFIER_VERDICT.DIFF, round: 0, reports: 1, required: 2, blockNumber: 1, logIndex: 0, transactionHash: '0x',
  }
  const pendingFor = (auditor: string, at = now) => pendingConfirmations({
    reports: epochReports([diff]), epoch: EPOCH, blockTimestamps: new Map([[1, now]]), now: at,
    auditor, auditors: AUDITORS, auditedModels: MODELS,
  })[0]!
  // The rotation names the absent auditor as the confirmer, since the stand-in is second in it.
  assert.equal(pendingFor(third).confirmer, absent)
  // Its turn runs out unanswered, and then the next auditor is asked, not every auditor.
  const later = now + CONFIRMATION_WINDOW_SECONDS
  assert.deepEqual([standIn, third, fourth].map((auditor) => pendingFor(auditor, later).mine), [false, true, false])
})
