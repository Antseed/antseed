import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Wallet } from 'ethers'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import type { VerifierRunManifestV1 } from './audit-artifacts.js'
import { closeFinishedAuditWindows, openAuditWindow, readAuditWindow } from './audit-window.js'
import { SELLER_RETRY_SPACING_SECONDS, epochCellKey, loadEpochState, writeEpochSubmissionManifest, type EpochCell } from './epoch-plan.js'
import { closeFinishedWindowsRecovering, recoveringFirstLooks } from './first-look-recovery.js'
import { auditFinishedAt, prepareModelAudits } from './model-audit.js'
import { FIXTURE_CONFIG, peerIdOf, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'

const LAST_ATTEMPT = Date.parse('2026-11-19T10:00:00.000Z') / 1_000

/** A first look whose DIFF submit would refuse: its evidence is gone. */
const cell: EpochCell = {
  model: 'model-a', peerId: 'aa'.repeat(20), runId: 'first', state: 'diff', attempts: 1, auditorAttempts: 0, permanent: false,
  lastAttemptAt: LAST_ATTEMPT, blame: null, reason: null, skipCode: null, action: 'done',
  result: { peerId: 'aa'.repeat(20), status: 'DIFF', evidencePath: join(tmpdir(), 'first-look-recovery-gone.json'), evidenceHash: '0x01' } as never,
}

const manifest = (extra: Partial<VerifierRunManifestV1>): VerifierRunManifestV1 => ({
  version: 1, kind: 'antseed-verifier-run-manifest', runId: 'later', state: 'completed', epoch: '32', epochSource: 'onchain',
  epochStartedAt: '', epochEndsAt: '', startedAt: new Date((LAST_ATTEMPT + SELLER_RETRY_SPACING_SECONDS + 60) * 1_000).toISOString(),
  completedAt: '', summaryPath: '', modelOrder: ['model-a'],
  models: [{ model: 'model-a', summaryPath: '', resultCount: 1, failureCount: 0, skippedCount: 0, cost: {} as never }], failureCount: 0, ...extra,
})

test('a --resume-run repair that skips a due first look never counts as passing it over; a full run does', async () => {
  const state = (manifests: VerifierRunManifestV1[]) => ({ ordinaryCells: new Map([[epochCellKey(cell.model, cell.peerId), cell]]), manifests })
  assert.equal((await recoveringFirstLooks(state([]))).size, 1, 'due for recovery')
  // A repair audits only another run's undetermined sellers: the first look is still waited for, its window held.
  assert.equal((await recoveringFirstLooks(state([manifest({ repairOf: 'earlier' })]))).size, 1)
  // A run that audited the model only for its confirmations never considered its other sellers.
  assert.equal((await recoveringFirstLooks(state([manifest({ confirmationOnly: ['model-a'] })]))).size, 1)
  // A run limited to some sellers is no full pass either.
  assert.equal((await recoveringFirstLooks(state([manifest({ selection: { peerIds: ['bb'.repeat(20)] } })]))).size, 1)
  // A run that planned the model but never finished it (its build failed): it considered nobody.
  assert.equal((await recoveringFirstLooks(state([manifest({ models: [] })]))).size, 1)
  // A full run of the model, due after the spacing, that did not plan it: no longer waited for.
  assert.equal((await recoveringFirstLooks(state([manifest({})]))).size, 0)
})

test('a completed first look written before the all-tests format is audited again in its window, and the new result is sent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-before-all-tests-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const seller = new Wallet(Wallet.createRandom().privateKey)
    const model = 'model-a'
    const epoch = '7'
    const audit = (extra: Partial<FixtureAudit> = {}): FixtureAudit => ({ agentId: '1', seller, model, service: model, verdict: 'DIFF', ...extra })
    await openAuditWindow({ evidenceDir, epoch, model, runId: 'run-1', sellers: [peerIdOf(seller)], now: () => Date.parse('2026-10-07T00:01:00.000Z') })
    // An auditor upgraded mid-epoch: its completed DIFF, hash-valid, from a CLI that wrote no `tests` format.
    await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch, auditor, audits: [audit({ beforeAllTests: true })] })
    const before = await loadEpochState(evidenceDir, epoch)
    const old = [...before.ordinaryCells!.values()][0]!
    assert.equal(old.action, 'done')
    // Submit refuses it, so the planner reads no finish time and audits the seller again, holding its window open.
    assert.equal(await auditFinishedAt(old.result!), null)
    assert.deepEqual([...(await recoveringFirstLooks(before)).keys()], [epochCellKey(model, peerIdOf(seller))])
    await closeFinishedWindowsRecovering({ evidenceDir, epoch, state: before, secondsLeftInEpoch: 86_400 })
    assert.equal((await readAuditWindow(evidenceDir, epoch, model))?.state, 'open')
    const refused = await prepareModelAudits({
      evidenceDir, banksDir, manifest: await writeEpochSubmissionManifest(evidenceDir, before), auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
    })
    assert.deepEqual(refused.audits.flatMap((entry) => entry.results), [])
    // The re-audit, after the retry spacing, writes the all-tests format: nothing is left to recover, the window
    // closes, and its DIFF is what submit sends.
    await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-2', epoch, auditor, audits: [audit()], completedAt: '2026-10-07T02:30:00.000Z' })
    const after = await loadEpochState(evidenceDir, epoch)
    assert.equal((await recoveringFirstLooks(after)).size, 0)
    await closeFinishedWindowsRecovering({ evidenceDir, epoch, state: after, secondsLeftInEpoch: 86_400 })
    assert.equal((await readAuditWindow(evidenceDir, epoch, model))?.state, 'closed')
    const sent = await prepareModelAudits({
      evidenceDir, banksDir, manifest: await writeEpochSubmissionManifest(evidenceDir, after), auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
    })
    assert.deepEqual(sent.audits.flatMap((entry) => entry.results.map((result) => [result.agentId, result.verdict])), [[1n, VERIFIER_VERDICT.DIFF]])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** A seller outage, blamed on the seller: it counts toward the seller's attempts. */
const OUTAGE = { version: 1, code: 'transport_error', summary: 'connection reset', retryable: true, source: 'transport', affectedBatchCount: 1, totalBatchCount: 1, nextAction: 'retry later' }

test('a first look written before the all-tests format on the seller\'s last attempt gets one extra attempt, and only one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-before-all-tests-extra-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const seller = new Wallet(Wallet.createRandom().privateKey)
    const model = 'model-a'
    const epoch = '7'
    const peerId = peerIdOf(seller)
    const key = epochCellKey(model, peerId)
    const audit = (extra: Partial<FixtureAudit> = {}): FixtureAudit => ({ agentId: '1', seller, model, service: model, verdict: 'DIFF', ...extra })
    const failure = { [model]: [{ peerId, agentId: '1', service: model, status: 'FAILED' as const, reason: 'connection reset', outcomeReason: OUTAGE as never }] }
    await openAuditWindow({ evidenceDir, epoch, model, runId: 'run-0', sellers: [peerId], now: () => Date.parse('2026-10-07T00:01:00.000Z') })
    // The seller's first attempt failed; its retry, on the old CLI, completed a DIFF without the format.
    await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-0', epoch, auditor, audits: [], failures: failure, completedAt: '2026-10-07T00:02:00.000Z' })
    await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch, auditor, audits: [audit({ beforeAllTests: true })], completedAt: '2026-10-07T01:00:00.000Z' })
    const used = await loadEpochState(evidenceDir, epoch)
    assert.equal(used.ordinaryCells!.get(key)!.attempts, 2, 'the seller\'s attempts are used up')
    // The extra attempt: audited again, and its window held open for it.
    assert.deepEqual([...(await recoveringFirstLooks(used)).keys()], [key])
    await closeFinishedWindowsRecovering({ evidenceDir, epoch, state: used, secondsLeftInEpoch: 86_400 })
    assert.equal((await readAuditWindow(evidenceDir, epoch, model))?.state, 'open')
    // The extra attempt fails on the seller's side: there is no other, and the window closes.
    await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-2', epoch, auditor, audits: [], failures: failure, completedAt: '2026-10-07T01:40:00.000Z' })
    const failed = await loadEpochState(evidenceDir, epoch)
    assert.equal((await recoveringFirstLooks(failed)).size, 0)
    // Had it answered, its all-tests DIFF would be the one sent.
    await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-3', epoch, auditor, audits: [audit()], completedAt: '2026-10-07T01:41:00.000Z' })
    const answered = await loadEpochState(evidenceDir, epoch)
    assert.equal((await recoveringFirstLooks(answered)).size, 0)
    await closeFinishedWindowsRecovering({ evidenceDir, epoch, state: answered, secondsLeftInEpoch: 86_400 })
    assert.equal((await readAuditWindow(evidenceDir, epoch, model))?.state, 'closed')
    const sent = await prepareModelAudits({
      evidenceDir, banksDir, manifest: await writeEpochSubmissionManifest(evidenceDir, answered), auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
    })
    assert.deepEqual(sent.audits.flatMap((entry) => entry.results.map((result) => [result.agentId, result.verdict])), [[1n, VERIFIER_VERDICT.DIFF]])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a first look written before the all-tests format whose window the old CLI closed is not audited again, and submit says why', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-before-all-tests-closed-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const seller = new Wallet(Wallet.createRandom().privateKey)
    const model = 'model-a'
    const epoch = '7'
    await openAuditWindow({ evidenceDir, epoch, model, runId: 'run-1', sellers: [peerIdOf(seller)], now: () => Date.parse('2026-10-07T00:01:00.000Z') })
    await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch, auditor, audits: [{ agentId: '1', seller, model, service: model, verdict: 'DIFF', beforeAllTests: true }] })
    const state = await loadEpochState(evidenceDir, epoch)
    // The old CLI read the result as finished and closed the window: its questions may be public since.
    await closeFinishedAuditWindows({ evidenceDir, epoch, state, secondsLeftInEpoch: 86_400 })
    assert.equal((await readAuditWindow(evidenceDir, epoch, model))?.state, 'closed')
    // Upgraded, the window stays closed, so no run asks the seller (`auditsPeer` audits only an open window's sellers).
    await closeFinishedWindowsRecovering({ evidenceDir, epoch, state, secondsLeftInEpoch: 86_400 })
    assert.equal((await readAuditWindow(evidenceDir, epoch, model))?.state, 'closed')
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest: await writeEpochSubmissionManifest(evidenceDir, state), auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
      auditWindow: (name) => readAuditWindow(evidenceDir, epoch, name),
    })
    assert.deepEqual(prepared.audits.flatMap((entry) => entry.results), [])
    assert.deepEqual(prepared.excluded.map((entry) => entry.reason), [
      'written by a CLI from before the all-tests format (an upgrade during the epoch), and its audit window closed before the seller '
        + 'could be audited again: its questions may be public, so nothing is sent for this seller this epoch, and it is audited next epoch',
    ])
    assert.deepEqual(prepared.decisions.map((entry) => entry.reasonCode), ['before-all-tests'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('submit says what becomes of a result written before the all-tests format: a first look in an open window, and a confirmation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-before-all-tests-reasons-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const first = new Wallet(Wallet.createRandom().privateKey)
    const confirmed = new Wallet(Wallet.createRandom().privateKey)
    const model = 'model-a'
    const epoch = '7'
    await openAuditWindow({ evidenceDir, epoch, model, runId: 'run-1', sellers: [peerIdOf(first)], now: () => Date.parse('2026-10-07T00:01:00.000Z') })
    await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-1', epoch, auditor, audits: [
        { agentId: '1', seller: first, model, service: model, verdict: 'DIFF', beforeAllTests: true },
        { agentId: '2', seller: confirmed, model, service: model, verdict: 'DIFF', beforeAllTests: true, confirmsDiff: true, confirming: { checks: ['kbf'], reportedAt: Date.parse('2026-10-06T22:00:00.000Z') / 1_000 } },
      ],
    })
    const state = await loadEpochState(evidenceDir, epoch)
    const reasons = async () => (await prepareModelAudits({
      evidenceDir, banksDir, manifest: await writeEpochSubmissionManifest(evidenceDir, state), auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
      auditWindow: (name) => readAuditWindow(evidenceDir, epoch, name),
    })).excluded.map((entry) => [entry.agentId, entry.reason]).sort(([left], [right]) => String(left).localeCompare(String(right)))
    // Open: the first look promises no new audit, only one while an attempt is left. A confirmation's never names a window.
    const firstLook = 'written by a CLI from before the all-tests format (an upgrade during the epoch): it is not sent; while its audit '
      + 'window is open and an attempt is left, a run audits the seller again, and only that result is sent'
    const confirmation = 'a confirmation written by a CLI from before the all-tests format (an upgrade during the epoch): it is not sent; '
      + 'while the report still waits for this auditor and its attempts are not used up, the seller is audited again for it, and only that result is sent'
    assert.deepEqual(await reasons(), [['1', firstLook], ['2', confirmation]])
    // Closed by the old CLI: the confirmation is still audited again, outside any window.
    await closeFinishedAuditWindows({ evidenceDir, epoch, state, secondsLeftInEpoch: 86_400 })
    assert.equal((await readAuditWindow(evidenceDir, epoch, model))?.state, 'closed')
    assert.deepEqual((await reasons())[1], ['2', confirmation])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('with a dry run\'s verifier.testTiming, a full run passes a first look over once the shortened retry spacing has passed', async () => {
  const state = (manifests: VerifierRunManifestV1[]) => ({ ordinaryCells: new Map([[epochCellKey(cell.model, cell.peerId), cell]]), manifests })
  // A full run five minutes after the last attempt: not due by the rules' 30 minutes, due with a one-minute spacing.
  const soon = manifest({ startedAt: new Date((LAST_ATTEMPT + 300) * 1_000).toISOString() })
  assert.equal((await recoveringFirstLooks(state([soon]))).size, 1)
  assert.equal((await recoveringFirstLooks(state([soon]), { sellerRetrySpacingSeconds: 60 })).size, 0)
})
