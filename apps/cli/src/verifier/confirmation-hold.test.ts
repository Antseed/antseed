import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Wallet } from 'ethers'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import { MIN_SECONDS_FOR_ANOTHER_ROUND, closeFinishedAuditWindows, openAuditWindow, readAuditWindow } from './audit-window.js'
import { confirmationHoldReason, confirmationsHoldingSubmit } from './confirmation-hold.js'
import { loadEpochState, writeEpochSubmissionManifest, type EpochState } from './epoch-plan.js'
import { prepareModelAudits } from './model-audit.js'
import { FIXTURE_CONFIG, peerIdOf, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'

const MODEL = 'model-a'
const EPOCH = '7'
/** The chain time of the report the confirmation answers: two hours before the fixture epoch's first run. */
const REPORTED_AT = Date.parse('2026-10-06T22:00:00.000Z') / 1_000
/** A seller outage, blamed on the seller: an attempt of the confirmation that decides nothing. */
const OUTAGE = { version: 1, code: 'transport_error', summary: 'connection reset', retryable: true, source: 'transport', affectedBatchCount: 1, totalBatchCount: 1, nextAction: 'retry later' }

/**
 * An epoch where the model's audit window is finished (seller A's first look is SAME) while the confirmation of
 * seller B's report has started: its first attempt failed on the seller's side, and it waits to be audited again.
 */
async function waitingConfirmation(directory: string) {
  const evidenceDir = join(directory, 'evidence')
  const banksDir = join(directory, 'banks')
  const auditor = new Wallet(Wallet.createRandom().privateKey)
  const first = new Wallet(Wallet.createRandom().privateKey)
  const confirmed = new Wallet(Wallet.createRandom().privateKey)
  const audit = (extra: Partial<FixtureAudit> & Pick<FixtureAudit, 'agentId' | 'seller' | 'verdict'>): FixtureAudit => ({ model: MODEL, service: MODEL, ...extra })
  const confirmation = { checks: ['kbf' as const], reportedAt: REPORTED_AT }
  await openAuditWindow({ evidenceDir, epoch: EPOCH, model: MODEL, runId: 'run-1', sellers: [peerIdOf(first)], now: () => Date.parse('2026-10-07T00:01:00.000Z') })
  await writeSignedAuditRun({
    evidenceDir, banksDir, runId: 'run-1', epoch: EPOCH, auditor, audits: [audit({ agentId: '1', seller: first, verdict: 'SAME' })],
    failures: { [MODEL]: [{
      peerId: peerIdOf(confirmed), agentId: '2', service: MODEL, status: 'FAILED' as const, reason: 'connection reset', outcomeReason: OUTAGE as never,
      confirming: ['kbf'], confirmingReportedAt: REPORTED_AT,
    }] },
  })
  const prepare = async (state: EpochState, secondsLeftInEpoch: number) => {
    const holds = confirmationsHoldingSubmit(state, secondsLeftInEpoch)
    return prepareModelAudits({
      evidenceDir, banksDir, manifest: await writeEpochSubmissionManifest(evidenceDir, state), auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
      auditWindow: (model) => readAuditWindow(evidenceDir, EPOCH, model),
      confirmationHold: (model) => confirmationHoldReason(holds.get(model.toLowerCase())),
    })
  }
  const sent = (prepared: Awaited<ReturnType<typeof prepare>>) => prepared.audits.flatMap((entry) => entry.results.map((result) => [result.agentId, result.verdict]))
  const reaudit = () => writeSignedAuditRun({
    evidenceDir, banksDir, runId: 'run-2', epoch: EPOCH, auditor, completedAt: '2026-10-07T00:40:00.000Z',
    audits: [audit({ agentId: '2', seller: confirmed, verdict: 'DIFF', confirmsDiff: true, confirming: confirmation })],
  })
  const state = await loadEpochState(evidenceDir, EPOCH)
  // The window holds nobody: A is finished, and B is a confirmation, outside it.
  await closeFinishedAuditWindows({ evidenceDir, epoch: EPOCH, state, secondsLeftInEpoch: 86_400 })
  assert.equal((await readAuditWindow(evidenceDir, EPOCH, MODEL))?.state, 'closed')
  return { evidenceDir, state, prepare, sent, reaudit }
}

test('a confirmation waiting for its re-audit holds its model\'s submit, though the audit window is closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-hold-'))
  try {
    const { state, prepare, sent } = await waitingConfirmation(directory)
    const holds = confirmationsHoldingSubmit(state, 86_400)
    assert.deepEqual([...holds.keys()], [MODEL])
    assert.deepEqual(holds.get(MODEL)!.map((cell) => [cell.attempts, cell.action]), [[1, 'retry']])
    const prepared = await prepare(state, 86_400)
    // A's SAME would publish the model's questions, which B's confirmation is asked again: nothing is sent yet.
    assert.deepEqual(sent(prepared), [])
    const first = prepared.decisions.find((entry) => entry.agentId === '1')!
    assert.deepEqual([first.decision, first.reasonCode], ['held', 'confirmation-waiting'])
    assert.match(prepared.excluded.find((entry) => entry.agentId === '1')!.reason,
      /^held: 1 confirmation\(s\) of this model wait to be audited again \([0-9a-f]{12} after attempt 1 of 3\)/)
    assert.ok(prepared.heldBack.some((line) => line.startsWith(`${MODEL} 1: held for the model's confirmations`)))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('after the confirmation\'s re-audit, the model\'s submit sends its results and the confirmation together', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-hold-after-'))
  try {
    const { evidenceDir, prepare, sent, reaudit } = await waitingConfirmation(directory)
    await reaudit()
    const after = await loadEpochState(evidenceDir, EPOCH)
    assert.equal(confirmationsHoldingSubmit(after, 86_400).size, 0)
    assert.deepEqual(sent(await prepare(after, 86_400)), [[1n, VERIFIER_VERDICT.SAME], [2n, VERIFIER_VERDICT.DIFF]])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the end-of-epoch cut-off releases the hold: the model\'s results are sent, the waiting confirmation is not', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-hold-cutoff-'))
  try {
    const { state, prepare, sent } = await waitingConfirmation(directory)
    // Up to the cut-off the model is held; past it, as an audit window closes, nothing waits any more.
    assert.equal(confirmationsHoldingSubmit(state, MIN_SECONDS_FOR_ANOTHER_ROUND).size, 1)
    assert.equal(confirmationsHoldingSubmit(state, MIN_SECONDS_FOR_ANOTHER_ROUND - 1).size, 0)
    const prepared = await prepare(state, MIN_SECONDS_FOR_ANOTHER_ROUND - 1)
    assert.deepEqual(sent(prepared), [[1n, VERIFIER_VERDICT.SAME]])
    assert.ok(prepared.excluded.some((entry) => entry.agentId === '2'), 'the failed confirmation attempt is never sent')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
