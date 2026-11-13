import assert from 'node:assert/strict'
import test from 'node:test'
import { getAddress } from 'ethers'
import {
  VERIFIER_VERDICT,
  modelHash,
  serviceHash,
  type ServiceAuditedEvent,
  type VerifierVerdict,
} from '@antseed/node/payments'
import { auditorRotationForModel, confirmationAssignments } from './audit-assignment.js'
import {
  confirmationTargetsByModel,
  dropSettledConfirmations,
  epochReports,
  loadEpochReports,
  localResultAnswersConfirmation,
  ownLatestReports,
  ownResultTallies,
  reportKey,
  pendingConfirmations,
  verdictTallies,
} from './pending-confirmations.js'

const A = getAddress('0x00000000000000000000000000000000000000a1')
const B = getAddress('0x00000000000000000000000000000000000000b2')
const C = getAddress('0x00000000000000000000000000000000000000c3')
const MODELS = ['model-a', 'model-b']
const STARTED = 1_000
const ENDS = 2_000
const EARLY = 1_100
const LATE = 1_600

let logIndex = 0
function audited(input: {
  auditor: string
  agentId?: bigint
  model?: string
  service?: string
  verdict: VerifierVerdict
  required?: number
  round?: number
}): ServiceAuditedEvent {
  logIndex += 1
  return {
    agentId: input.agentId ?? 1n,
    serviceHash: serviceHash(input.service ?? input.model ?? 'model-a'),
    auditor: input.auditor,
    modelHash: modelHash(input.model ?? 'model-a'),
    verdict: input.verdict,
    round: input.round ?? 0,
    reports: 0,
    required: input.required ?? (input.verdict === VERIFIER_VERDICT.DIFF ? 2 : 1),
    blockNumber: 1,
    logIndex,
    transactionHash: '0x',
  }
}

function pendingFor(auditor: string, events: ServiceAuditedEvent[], options: { epoch?: number; now?: number; auditors?: string[] } = {}) {
  return pendingConfirmations({
    reports: epochReports(events),
    epoch: options.epoch ?? 7,
    epochStartedAt: STARTED,
    epochEndsAt: ENDS,
    now: options.now ?? EARLY,
    auditor,
    auditors: options.auditors ?? [A, B],
    auditedModels: MODELS,
  })
}

test('the rotation gives each model a primary auditor and a confirmer, and swaps them every epoch', () => {
  // Auditors sort by address and models by name; in epoch e model i starts at auditor (i + e) mod A.
  assert.deepEqual(auditorRotationForModel('model-a', { auditors: [B, A], epoch: 7, availableModels: MODELS }), [B, A])
  assert.deepEqual(auditorRotationForModel('model-b', { auditors: [B, A], epoch: 7, availableModels: MODELS }), [A, B])
  assert.deepEqual(auditorRotationForModel('model-a', { auditors: [A, B], epoch: 8, availableModels: MODELS }), [A, B])
  assert.deepEqual(auditorRotationForModel('MODEL-B', { auditors: [A, B], epoch: 8, availableModels: MODELS }), [B, A])
  assert.deepEqual(auditorRotationForModel('model-a', { auditors: [A, B, C], epoch: 7, availableModels: MODELS }), [B, C, A])
  assert.deepEqual(auditorRotationForModel('unknown', { auditors: [A, B], epoch: 7, availableModels: MODELS }), [])
})

test('verifier assignment names each model\'s confirmer: the next auditor in its rotation', () => {
  assert.deepEqual([...confirmationAssignments({ auditors: [A, B], epoch: 7, availableModels: MODELS })], [[A, ['model-a']], [B, ['model-b']]])
  assert.deepEqual([...confirmationAssignments({ auditors: [A, B], epoch: 8, availableModels: MODELS })], [[A, ['model-b']], [B, ['model-a']]])
  assert.deepEqual([...confirmationAssignments({ auditors: [A, B, C], epoch: 7, availableModels: MODELS })], [[A, ['model-b']], [B, []], [C, ['model-a']]])
  assert.deepEqual([...confirmationAssignments({ auditors: [A], epoch: 7, availableModels: MODELS })], [[A, []]], 'nobody confirms alone')
})

test('with two auditors each one confirms the other\'s DIFFs, and the roles swap the next epoch', () => {
  // Epoch 7: B audits model-a and A audits model-b (see the rotation above).
  const epoch7 = [
    audited({ auditor: B, model: 'model-a', verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: A, model: 'model-b', verdict: VERIFIER_VERDICT.DIFF }),
  ]
  const forA = pendingFor(A, epoch7)
  const forB = pendingFor(B, epoch7)
  assert.deepEqual(forA.map((entry) => [entry.model, entry.confirmer, entry.mine]), [['model-a', A, true], ['model-b', B, false]])
  assert.deepEqual(forB.map((entry) => [entry.model, entry.confirmer, entry.mine]), [['model-a', A, false], ['model-b', B, true]])
  assert.deepEqual(forA[0]!.waiting, [{ verdict: 'DIFF', reports: 1, required: 2 }])
  assert.deepEqual(forA[0]!.reporters, [B])

  // Epoch 8: A audits model-a, so B confirms it.
  const epoch8 = [audited({ auditor: A, model: 'model-a', verdict: VERIFIER_VERDICT.DIFF })]
  assert.deepEqual(pendingFor(B, epoch8, { epoch: 8 }).map((entry) => [entry.model, entry.confirmer, entry.mine]), [['model-a', B, true]])
  assert.equal(pendingFor(A, epoch8, { epoch: 8 })[0]!.mine, false, 'an auditor never confirms its own report')
})

test('a report the confirmer already answered waits for the next auditor in the rotation', () => {
  const auditors = [A, B, C]
  // model-a in epoch 7 with three auditors: B, then C, then A.
  const disagreed = [
    audited({ auditor: B, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: C, verdict: VERIFIER_VERDICT.SAME }),
  ]
  const forA = pendingFor(A, disagreed, { auditors })
  assert.equal(forA.length, 1)
  assert.equal(forA[0]!.confirmer, A, 'the third auditor breaks the tie')
  assert.equal(forA[0]!.mine, true)
  assert.deepEqual(forA[0]!.waiting, [{ verdict: 'DIFF', reports: 1, required: 2 }])

  const everyone = [...disagreed, audited({ auditor: A, verdict: VERIFIER_VERDICT.SAME })]
  const after = pendingFor(A, everyone, { auditors })
  assert.equal(after[0]!.confirmer, null, 'nobody is left to confirm it')
  assert.equal(after[0]!.mine, false)
})

test('a report from an auditor outside the rotation goes to the model\'s primary auditor first', () => {
  const events = [audited({ auditor: C, verdict: VERIFIER_VERDICT.DIFF })]
  assert.equal(pendingFor(B, events)[0]!.confirmer, B)
  assert.equal(pendingFor(B, events)[0]!.mine, true)
  assert.equal(pendingFor(A, events)[0]!.mine, false)
})

test('from halfway through the epoch any auditor that has not reported may confirm', () => {
  const auditors = [A, B, C]
  const events = [audited({ auditor: B, verdict: VERIFIER_VERDICT.DIFF })]
  assert.equal(pendingFor(A, events, { auditors })[0]!.mine, false, 'C is the confirmer')
  assert.equal(pendingFor(A, events, { auditors, now: LATE })[0]!.mine, true)
  assert.equal(pendingFor(B, events, { auditors, now: LATE })[0]!.mine, false, 'still not its own report')
})

test('only verdicts with fewer reports than they need wait', () => {
  const events = [
    audited({ auditor: A, agentId: 1n, verdict: VERIFIER_VERDICT.SAME }),
    audited({ auditor: A, agentId: 2n, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: B, agentId: 2n, verdict: VERIFIER_VERDICT.DIFF }),
    // A SAME against a live DIFF needs as many auditors as the DIFF.
    audited({ auditor: A, agentId: 3n, verdict: VERIFIER_VERDICT.SAME, required: 2 }),
  ]
  const pending = pendingFor(C, events, { auditors: [A, B, C] })
  assert.deepEqual(pending.map((entry) => [entry.agentId, entry.waiting]), [[3n, [{ verdict: 'SAME', reports: 1, required: 2 }]]])
})

test('an auditor that changes its report moves its support', () => {
  const reports = epochReports([
    audited({ auditor: A, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: A, verdict: VERIFIER_VERDICT.SAME }),
    audited({ auditor: B, verdict: VERIFIER_VERDICT.DIFF }),
  ])
  assert.deepEqual(verdictTallies([...reports.values()][0]!), [
    { verdict: 'DIFF', reports: 1, required: 2 },
    { verdict: 'SAME', reports: 1, required: 1 },
  ])
})

test('reports from before the service\'s verdict moved into or out of DIFF no longer count', () => {
  const events = [
    audited({ auditor: A, verdict: VERIFIER_VERDICT.SAME }),
    audited({ auditor: B, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: C, verdict: VERIFIER_VERDICT.DIFF }),
    // The DIFF was recorded: the contract started round 1, where A's SAME does not count.
    audited({ auditor: C, verdict: VERIFIER_VERDICT.SAME, round: 1, required: 2 }),
  ]
  const report = [...epochReports(events).values()]
  assert.equal(report.length, 1)
  assert.equal(report[0]!.round, 1)
  assert.deepEqual(verdictTallies(report[0]!), [{ verdict: 'SAME', reports: 1, required: 2 }])
  const pending = pendingFor(B, events, { auditors: [A, B, C] })
  assert.deepEqual(pending.map((entry) => [entry.reporters, entry.confirmer, entry.mine]), [[[C], B, true]],
    'B reported only in the earlier round, so it can confirm in this one')
})

test('confirmation targets keep only this auditor\'s confirmations, under a configured service', () => {
  const pending = pendingFor(A, [
    audited({ auditor: B, agentId: 1n, model: 'model-a', service: 'served-a', verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: B, agentId: 2n, model: 'model-a', service: 'unknown', verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: A, agentId: 3n, model: 'model-b', verdict: VERIFIER_VERDICT.DIFF }),
  ])
  const targets = confirmationTargetsByModel(pending, (model) => (model === 'model-a' ? ['model-a', 'Served-A'] : [model]))
  assert.deepEqual([...targets.keys()], ['model-a'])
  assert.deepEqual([...targets.get('model-a')!.values()], [
    { agentId: 1n, service: 'Served-A', waiting: [{ verdict: 'DIFF', reports: 1, required: 2 }], ownReportedAt: null },
  ])
})

test('own result tallies show what this auditor submitted and what still waits', () => {
  const reports = epochReports([
    audited({ auditor: A, agentId: 1n, verdict: VERIFIER_VERDICT.SAME }),
    audited({ auditor: A, agentId: 2n, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: B, agentId: 3n, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: A, agentId: 3n, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: A, agentId: 4n, model: 'model-b', verdict: VERIFIER_VERDICT.DIFF }),
  ])
  assert.deepEqual(
    ownResultTallies({ reports, auditor: A, modelHash: modelHash('model-a') }).map((entry) => [entry.agentId, entry.tally]),
    [
      [1n, { verdict: 'SAME', reports: 1, required: 1 }],
      [2n, { verdict: 'DIFF', reports: 1, required: 2 }],
      [3n, { verdict: 'DIFF', reports: 2, required: 2 }],
    ],
  )
})

test('epoch reports are read from the epoch\'s first block, never before the deployment', async () => {
  const calls: unknown[] = []
  const reports = await loadEpochReports({
    reader: {
      async firstBlockAtOrAfter(timestamp, floor) {
        calls.push(['first', timestamp, floor])
        return 42
      },
      async queryServiceAudits(agentId, service, fromBlock, toBlock) {
        calls.push(['query', agentId, service, fromBlock, toBlock])
        return [audited({ auditor: B, verdict: VERIFIER_VERDICT.DIFF })]
      },
    },
    epochStartedAt: STARTED,
    deploymentBlock: 7,
  })
  assert.deepEqual(calls, [['first', STARTED, 7], ['query', null, null, 42, 'latest']])
  assert.equal(reports.size, 1)
})

test('a waiting report is dropped once the contract no longer counts it or its verdict is already recorded', async () => {
  const events = [
    audited({ auditor: B, agentId: 1n, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: B, agentId: 2n, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: B, agentId: 3n, verdict: VERIFIER_VERDICT.DIFF }),
    audited({ auditor: B, agentId: 4n, verdict: VERIFIER_VERDICT.DIFF }),
  ]
  const pending = pendingFor(A, events)
  assert.deepEqual(pending.map((entry) => [entry.agentId, entry.mine]), [[1n, true], [2n, true], [3n, true], [4n, true]])
  const kept = await dropSettledConfirmations(pending, {
    // Agent 2: a DIFF was recorded or an auditor revoked since, so the round moved on.
    reportRound: async (agentId) => (agentId === 2n ? 1 : 0),
    serviceStatusByHash: async (agentId) => ({
      // Agent 3: DIFF already recorded this epoch (a resent report after its confirmation).
      // Agent 4: DIFF recorded last epoch; this epoch's DIFF still needs confirming to stay live.
      verdict: agentId === 3n || agentId === 4n ? VERIFIER_VERDICT.DIFF : VERIFIER_VERDICT.SAME,
      epoch: agentId === 3n ? 7n : 6n,
    }),
  }, 7n)
  assert.deepEqual(kept.map((entry) => entry.agentId), [1n, 4n])
})

test('this auditor\'s latest report block per service, across report rounds', () => {
  const events = [
    { ...audited({ auditor: A, verdict: VERIFIER_VERDICT.SAME, round: 0 }), blockNumber: 10 },
    { ...audited({ auditor: B, verdict: VERIFIER_VERDICT.DIFF, round: 0 }), blockNumber: 12 },
    { ...audited({ auditor: A, verdict: VERIFIER_VERDICT.SAME, round: 1 }), blockNumber: 20 },
    { ...audited({ auditor: A, agentId: 2n, verdict: VERIFIER_VERDICT.SAME }), blockNumber: 15 },
    { ...audited({ auditor: B, agentId: 3n, verdict: VERIFIER_VERDICT.SAME }), blockNumber: 16 },
  ]
  const reports = ownLatestReports(events, A.toLowerCase())
  assert.equal(reports.get(reportKey(1n, serviceHash('model-a'), modelHash('model-a')))?.blockNumber, 20)
  assert.equal(reports.get(reportKey(1n, serviceHash('model-a'), modelHash('model-a')))?.round, 1)
  assert.equal(reports.get(reportKey(2n, serviceHash('model-a'), modelHash('model-a')))?.blockNumber, 15)
  assert.equal(reports.has(reportKey(3n, serviceHash('model-a'), modelHash('model-a'))), false)
})

test('a finished local result answers a confirmation only for the reported service and when not yet submitted', () => {
  const target = { agentId: 1n, service: 'Served-A', waiting: [{ verdict: 'SAME' as const, reports: 1, required: 2 }] }
  // Never reported on it: a finished result for the service is submitted next and counts.
  assert.equal(localResultAnswersConfirmation({ ...target, ownReportedAt: null }, { service: 'served-a', completedAt: 500 }), true)
  // A result for another alias adds nothing to this service's tally.
  assert.equal(localResultAnswersConfirmation({ ...target, ownReportedAt: null }, { service: 'served-b', completedAt: 500 }), false)
  assert.equal(localResultAnswersConfirmation({ ...target, ownReportedAt: null }, null), false)
  // Reported in a round the contract no longer counts: the old result was that report; audit again.
  assert.equal(localResultAnswersConfirmation({ ...target, ownReportedAt: 600 }, { service: 'Served-A', completedAt: 500 }), false)
  // A result newer than that report (the re-audit) is submitted next.
  assert.equal(localResultAnswersConfirmation({ ...target, ownReportedAt: 600 }, { service: 'Served-A', completedAt: 700 }), true)
})
