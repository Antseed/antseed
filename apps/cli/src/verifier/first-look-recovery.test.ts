import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { Wallet } from 'ethers'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import type { VerifierRunManifestV1 } from './audit-artifacts.js'
import { openAuditWindow, readAuditWindow } from './audit-window.js'
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
