import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { VerifierRunManifestV1 } from './audit-artifacts.js'
import {
  MIN_SECONDS_FOR_ANOTHER_ROUND,
  auditWindowSellersLeft,
  closeFinishedAuditWindows,
  openAuditWindow,
  readAuditWindow,
  windowIncludesSeller,
} from './audit-window.js'
import { epochCellKey, type EpochCell, type EpochCellAction, type EpochState } from './epoch-plan.js'

const A = 'aa'.repeat(20)
const B = 'bb'.repeat(20)
const LATE = 'cc'.repeat(20)

function cell(peerId: string, action: EpochCellAction): EpochCell {
  return {
    model: 'model-a', peerId, runId: 'run-1', state: action === 'done' ? 'same' : 'failed', attempts: 1, auditorAttempts: 0,
    permanent: false, lastAttemptAt: null, blame: null, reason: null, skipCode: null, result: null, action,
  }
}

function state(cells: EpochCell[], runIds: string[] = ['run-1']): Pick<EpochState, 'cells' | 'manifests'> {
  return {
    cells: new Map(cells.map((entry) => [epochCellKey(entry.model, entry.peerId), entry])),
    manifests: runIds.map((runId) => ({ runId, startedAt: '2026-11-05T00:00:00.000Z', modelOrder: ['model-a'] }) as VerifierRunManifestV1),
  }
}

async function withDir(body: (evidenceDir: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-audit-window-'))
  try { await body(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('the first run opens a model\'s window with its sellers; a later run keeps them, so a late seller is not in it', () => withDir(async (evidenceDir) => {
  const now = () => Date.parse('2026-11-05T00:00:00.000Z')
  const opened = await openAuditWindow({ evidenceDir, epoch: '7', model: 'model-a', runId: 'run-1', sellers: [`0x${A.toUpperCase()}`, B], now })
  assert.equal(opened.state, 'open')
  assert.deepEqual(opened.sellers, [A, B])
  const again = await openAuditWindow({ evidenceDir, epoch: '7', model: 'model-a', runId: 'run-2', sellers: [A, B, LATE] })
  assert.deepEqual(again, opened)
  assert.equal(windowIncludesSeller(again, LATE), false)
  assert.deepEqual(await readAuditWindow(evidenceDir, '7', 'model-a'), opened)
  assert.equal(await readAuditWindow(evidenceDir, '8', 'model-a'), null)
}))

test('a window stays open while a seller has a retry or a close call left, and closes once none has', () => withDir(async (evidenceDir) => {
  const window = await openAuditWindow({ evidenceDir, epoch: '7', model: 'model-a', runId: 'run-1', sellers: [A, B] })
  assert.deepEqual(auditWindowSellersLeft(window, state([cell(A, 'done'), cell(B, 'retry')])), [B])
  assert.deepEqual(auditWindowSellersLeft(window, state([cell(A, 'done'), cell(B, 'extend')])), [B])
  // A seller with no result after a completed run was not reachable again: it is done.
  assert.deepEqual(auditWindowSellersLeft(window, state([cell(A, 'done')])), [])
  // Before any run of the window completed (the first one was interrupted), it is not.
  assert.deepEqual(auditWindowSellersLeft(window, state([], [])), [A, B])

  const hours = 10 * 60 * 60
  assert.deepEqual(await closeFinishedAuditWindows({
    evidenceDir, epoch: '7', state: state([cell(A, 'done'), cell(B, 'retry')]), secondsLeftInEpoch: hours,
  }), [])
  const [closed] = await closeFinishedAuditWindows({
    evidenceDir, epoch: '7', state: state([cell(A, 'done'), cell(B, 'done')]), secondsLeftInEpoch: hours,
  })
  assert.equal(closed?.state, 'closed')
  assert.equal(closed?.closeReason, 'every seller of the window is finished')
  assert.equal((await readAuditWindow(evidenceDir, '7', 'model-a'))?.state, 'closed')
}))

test('near the end of the epoch every open window closes, with what is left undecided', () => withDir(async (evidenceDir) => {
  await openAuditWindow({ evidenceDir, epoch: '7', model: 'model-a', runId: 'run-1', sellers: [A, B] })
  const [closed] = await closeFinishedAuditWindows({
    evidenceDir, epoch: '7', state: state([cell(A, 'done'), cell(B, 'retry')]), secondsLeftInEpoch: MIN_SECONDS_FOR_ANOTHER_ROUND - 1,
  })
  assert.match(closed?.closeReason ?? '', /epoch is nearly over; 1 seller\(s\) left undecided/)
}))
