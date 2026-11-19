import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import type { VerifierRunManifestV1 } from './audit-artifacts.js'
import { SELLER_RETRY_SPACING_SECONDS, epochCellKey, type EpochCell } from './epoch-plan.js'
import { recoveringFirstLooks } from './first-look-recovery.js'

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
