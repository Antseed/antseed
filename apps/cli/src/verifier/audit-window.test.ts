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

test('a run that skipped the model does not end its window, also when that run opened it', () => withDir(async (evidenceDir) => {
  const window = await openAuditWindow({ evidenceDir, epoch: '7', model: 'model-a', runId: 'run-1', sellers: [A] })
  const otherModelOnly = {
    cells: new Map(),
    manifests: [{ runId: 'run-1', startedAt: '2026-11-05T00:00:00.000Z', modelOrder: ['model-b'] } as VerifierRunManifestV1],
  }
  assert.deepEqual(auditWindowSellersLeft(window, otherModelOnly), [A])
  // The opening run started before its window, after the model's build began.
  const opener = { ...otherModelOnly, manifests: [{ ...otherModelOnly.manifests[0]!, modelOrder: ['model-a'] }] }
  assert.deepEqual(auditWindowSellersLeft(window, opener), [])
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

test('closing a window records the sellers given up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audit-window-'))
  try {
    await openAuditWindow({ evidenceDir: directory, epoch: '7', model: 'model-a', runId: 'run-1', sellers: [A, B] })
    const givenUp = {
      ...cell(B, 'done'),
      givenUp: {
        model: 'model-a', peerId: B, displayName: null, runId: 'run-1', lastAttemptAt: 1, attempts: 1,
        givenUpAt: '2026-11-06T00:00:00.000Z', reason: 'gone',
      },
    }
    const [closed] = await closeFinishedAuditWindows({
      evidenceDir: directory, epoch: '7', state: state([cell(A, 'done'), givenUp]), secondsLeftInEpoch: 86_400,
    })
    assert.equal(closed?.state, 'closed')
    assert.deepEqual(closed?.givenUpSellers, [B])
    assert.match(closed?.closeReason ?? '', /retry given up for 1 seller/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a given-up seller does not close the window while another seller has work left', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audit-window-'))
  try {
    await openAuditWindow({ evidenceDir: directory, epoch: '7', model: 'model-a', runId: 'run-1', sellers: [A, B] })
    const closed = await closeFinishedAuditWindows({
      evidenceDir: directory, epoch: '7', state: state([cell(A, 'retry'), cell(B, 'done')]), secondsLeftInEpoch: 86_400,
    })
    assert.deepEqual(closed, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
