import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Wallet } from 'ethers'
import { VERIFIER_VERDICT, modelHash, serviceHash } from '@antseed/node/payments'
import { MIN_SECONDS_FOR_ANOTHER_ROUND, closeFinishedAuditWindows, openAuditWindow, readAuditWindow } from './audit-window.js'
import { confirmationHoldReason, confirmationTurnKey, confirmationsHoldingSubmit } from './confirmation-hold.js'
import { SELLER_RETRY_SPACING_SECONDS, decideRetryGiveUps, loadEpochState, retryGiveUpCells, writeEpochSubmissionManifest, writeRetryGiveUps, type EpochState } from './epoch-plan.js'
import { FLIPS_AUDITOR_FAILURE, FLIPS_WAITING_FOR_REFERENCE } from './flips.js'
import { opinionKey } from './third-opinion.js'
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
    const holds = confirmationsHoldingSubmit({ state, secondsLeftInEpoch, stillMine: null })
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
  return { evidenceDir, banksDir, auditor, first, confirmed, state, prepare, sent, reaudit }
}

test('a confirmation waiting for its re-audit holds its model\'s submit, though the audit window is closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-hold-'))
  try {
    const { state, prepare, sent } = await waitingConfirmation(directory)
    const holds = confirmationsHoldingSubmit({ state, secondsLeftInEpoch: 86_400, stillMine: null })
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
    assert.equal(confirmationsHoldingSubmit({ state: after, secondsLeftInEpoch: 86_400, stillMine: null }).size, 0)
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
    assert.equal(confirmationsHoldingSubmit({ state, secondsLeftInEpoch: MIN_SECONDS_FOR_ANOTHER_ROUND, stillMine: null }).size, 1)
    assert.equal(confirmationsHoldingSubmit({ state, secondsLeftInEpoch: MIN_SECONDS_FOR_ANOTHER_ROUND - 1, stillMine: null }).size, 0)
    const prepared = await prepare(state, MIN_SECONDS_FOR_ANOTHER_ROUND - 1)
    assert.deepEqual(sent(prepared), [[1n, VERIFIER_VERDICT.SAME]])
    assert.ok(prepared.excluded.some((entry) => entry.agentId === '2'), 'the failed confirmation attempt is never sent')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const holding = (state: EpochState, stillMine: Parameters<typeof confirmationsHoldingSubmit>[0]['stillMine'] = null) => (
  [...confirmationsHoldingSubmit({ state, secondsLeftInEpoch: 86_400, stillMine }).keys()]
)

test('a confirmation holds only while its report is still this auditor\'s turn and not settled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-hold-turn-'))
  try {
    const { state } = await waitingConfirmation(directory)
    // The report as the contract names it: agent 2, the service's and the model's hashes.
    const turn = opinionKey('2', serviceHash(MODEL), modelHash(MODEL))
    const cell = [...state.reportCells!.values()][0]!
    assert.equal(confirmationTurnKey(cell), turn)
    assert.deepEqual(holding(state, (candidate) => confirmationTurnKey(candidate) === turn), [MODEL])
    // Its 12 hours passed, another auditor's turn came, or the contract settled it: no run audits it again.
    assert.deepEqual(holding(state, () => false), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a confirmation a later run of the model passed over (with --no-confirm, say) holds nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-hold-passed-'))
  try {
    const { evidenceDir, banksDir, auditor, first } = await waitingConfirmation(directory)
    // A run of the model 38 minutes later, past the confirmation's re-check spacing, that audited only A again.
    await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-2', epoch: EPOCH, auditor, completedAt: '2026-10-07T00:40:00.000Z',
      audits: [{ agentId: '1', seller: first, model: MODEL, service: MODEL, verdict: 'SAME', auditSalt: 'again' }],
    })
    assert.deepEqual(holding(await loadEpochState(evidenceDir, EPOCH)), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a confirmation failing on the auditor\'s side holds for the auditor\'s attempts only, and one not started for its FLIPS reference not at all', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-hold-auditor-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const confirmed = new Wallet(Wallet.createRandom().privateKey)
    const failure = (reason: string, outcomeReason?: unknown) => ({ [MODEL]: [{
      peerId: peerIdOf(confirmed), agentId: '2', service: MODEL, status: 'FAILED' as const, reason,
      confirming: ['kbf' as const], confirmingReportedAt: REPORTED_AT, ...(outcomeReason ? { outcomeReason: outcomeReason as never } : {}),
    }] })
    // The auditor's own failure: never one of the report's attempts.
    const lockTimeout = (minutes: number) => writeSignedAuditRun({
      evidenceDir, banksDir, runId: `run-${minutes}`, epoch: EPOCH, auditor, audits: [], completedAt: `2026-10-07T00:${String(minutes).padStart(2, '0')}:00.000Z`,
      failures: failure('payment lock timed out', { ...OUTAGE, code: 'payment_lock_timeout', summary: 'payment lock timed out' }),
    })
    await lockTimeout(2)
    await lockTimeout(20)
    const twice = await loadEpochState(evidenceDir, EPOCH)
    assert.deepEqual([...twice.reportCells!.values()].map((cell) => [cell.attempts, cell.auditorAttempts, cell.action]), [[0, 2, 'retry']])
    assert.deepEqual(holding(twice), [MODEL])
    // The third: the report stays open in the plan, but it no longer holds its model to the end of the epoch.
    await lockTimeout(40)
    const thrice = await loadEpochState(evidenceDir, EPOCH)
    assert.deepEqual([...thrice.reportCells!.values()].map((cell) => [cell.attempts, cell.auditorAttempts, cell.action]), [[0, 3, 'retry']])
    assert.deepEqual(holding(thrice), [])
    // Not started because its FLIPS reference was not whole: nothing was asked, so nothing waits (as the window reads it).
    const other = join(directory, 'other')
    await writeSignedAuditRun({
      evidenceDir: other, banksDir, runId: 'run-1', epoch: EPOCH, auditor, audits: [],
      failures: failure(`${FLIPS_AUDITOR_FAILURE}: ${FLIPS_WAITING_FOR_REFERENCE}`),
    })
    const notStarted = await loadEpochState(other, EPOCH)
    assert.deepEqual([...notStarted.reportCells!.values()].map((cell) => [cell.blame, cell.action]), [['auditor', 'retry']])
    assert.deepEqual(holding(notStarted), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a confirmation of a seller that no longer offers the model is given up, though this auditor\'s own first look of it is finished', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-confirmation-hold-gone-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const seller = new Wallet(Wallet.createRandom().privateKey)
    const peerId = peerIdOf(seller)
    await openAuditWindow({ evidenceDir, epoch: EPOCH, model: MODEL, runId: 'run-1', sellers: [peerId], now: () => Date.parse('2026-10-07T00:01:00.000Z') })
    // This auditor's first look of the seller is a SAME; then a report on it came, and its confirmation failed once.
    await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch: EPOCH, auditor, audits: [{ agentId: '2', seller, model: MODEL, service: MODEL, verdict: 'SAME' }] })
    await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-2', epoch: EPOCH, auditor, audits: [], completedAt: '2026-10-07T00:20:00.000Z',
      failures: { [MODEL]: [{ peerId, agentId: '2', service: MODEL, status: 'FAILED' as const, reason: 'connection reset', outcomeReason: OUTAGE as never, confirming: ['kbf'], confirmingReportedAt: REPORTED_AT }] },
    })
    const state = await loadEpochState(evidenceDir, EPOCH)
    assert.equal(state.cells.get([...state.cells.keys()][0]!)!.action, 'done', 'the seller\'s latest cell reads done')
    assert.deepEqual(holding(state), [MODEL])
    // A run with a fresh peer list, past the spacing, where the seller no longer offers the model.
    const nowSeconds = Date.parse('2026-10-07T00:20:00.000Z') / 1_000 + SELLER_RETRY_SPACING_SECONDS + 60
    const { entries, added } = decideRetryGiveUps({ cells: retryGiveUpCells(state), nowSeconds, offersModel: () => false, windowClosed: () => true })
    assert.equal(added.length, 1)
    await writeRetryGiveUps(evidenceDir, EPOCH, entries)
    const gone = await loadEpochState(evidenceDir, EPOCH)
    assert.ok([...gone.reportCells!.values()][0]!.givenUp)
    assert.deepEqual(holding(gone), [])
    // Listed again, its retry is back on, and it holds again.
    const back = decideRetryGiveUps({ cells: retryGiveUpCells(gone), nowSeconds: nowSeconds + 60, offersModel: () => true, windowClosed: () => true })
    assert.equal(back.restored.length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
