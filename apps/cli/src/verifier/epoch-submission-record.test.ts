import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { epochSubmissionRunId } from './epoch-plan.js'
import {
  markUnsentReported, recordSubmitOutcome, recordSubmittedRuns, unsentEpochRuns, unsentEpochRunsMessage,
} from './epoch-submission-record.js'
import { modelAuditLedgerPath } from './model-audit.js'

async function withEvidenceDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-epoch-record-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeRun(dir: string, epoch: string, runId: string, completedAt: string): Promise<void> {
  await mkdir(join(dir, 'runs'), { recursive: true })
  await writeFile(join(dir, 'runs', `${runId}.json`), JSON.stringify({
    version: 1, kind: 'antseed-verifier-run-manifest', runId, state: 'completed', epoch, epochSource: 'onchain',
    startedAt: completedAt, completedAt, models: [], modelOrder: [],
  }))
}

const A = `0x${'a'.repeat(64)}`
const B = `0x${'b'.repeat(64)}`

test('an epoch whose runs were all submitted has nothing unsent', () => withEvidenceDir(async (dir) => {
  await writeRun(dir, '7', A, '2026-11-01T10:00:00.000Z')
  await writeRun(dir, '7', B, '2026-11-01T12:00:00.000Z')
  await recordSubmittedRuns(dir, '7', [A])
  await recordSubmittedRuns(dir, '7', [A, B])
  assert.equal(await unsentEpochRuns(dir, '7'), null)
}))

test('a run that finished after the last successful submit is reported as unsent, once', () => withEvidenceDir(async (dir) => {
  await writeRun(dir, '7', A, '2026-11-01T10:00:00.000Z')
  await writeRun(dir, '7', B, '2026-11-01T23:30:00.000Z')
  await recordSubmittedRuns(dir, '7', [A])

  const unsent = await unsentEpochRuns(dir, '7')
  assert.deepEqual(unsent, { epoch: '7', runIds: [B], lastCompletedAt: '2026-11-01T23:30:00.000Z', outstanding: null })
  const message = unsentEpochRunsMessage(unsent!)
  assert.match(message, /^Epoch 7 ended with results that may never have reached the chain, and those are lost/)
  assert.match(message, /1 run\(s\) were not covered by a submit that sent everything \(0xbbbbbbbb/)
  assert.match(message, /reported once/)

  await markUnsentReported(dir, '7')
  assert.equal(await unsentEpochRuns(dir, '7'), null, 'watch calls submit every tick; the warning is printed once')
  await recordSubmittedRuns(dir, '7', [A])
  assert.equal(await unsentEpochRuns(dir, '7'), null, 'recording again keeps the reported mark')
}))

test('an epoch with no submit at all reports every run, and one with no runs reports nothing', () => withEvidenceDir(async (dir) => {
  await writeRun(dir, '7', A, '2026-11-01T10:00:00.000Z')
  assert.deepEqual((await unsentEpochRuns(dir, '7'))?.runIds, [A])
  assert.equal(await unsentEpochRuns(dir, '8'), null)
}))

test('a data dir from before the record counts as submitted when the merged submission\'s ledger is complete', () => withEvidenceDir(async (dir) => {
  await writeRun(dir, '7', A, '2026-11-01T10:00:00.000Z')
  await writeRun(dir, '7', B, '2026-11-01T12:00:00.000Z')
  const ledger = modelAuditLedgerPath(dir, epochSubmissionRunId('7', [A, B]), 8453n, `0x${'1'.repeat(40)}`)
  await mkdir(join(ledger, '..'), { recursive: true })

  await writeFile(ledger, JSON.stringify({ models: { 'model-a': { status: 'submitted' }, 'model-b': { status: 'failed' } } }))
  assert.deepEqual((await unsentEpochRuns(dir, '7'))?.runIds, [A, B], 'a failed model is not submitted')

  await writeFile(ledger, JSON.stringify({ models: { 'model-a': { status: 'submitted' }, 'model-b': { status: 'submitted' } } }))
  assert.equal(await unsentEpochRuns(dir, '7'), null)
}))

test('what the last submit left unsent is named, and held-back results do not count as submitted', () => withEvidenceDir(async (dir) => {
  await writeRun(dir, '7', A, '2026-11-01T10:00:00.000Z')
  // A submit with nothing to send while the window is still open: the run is not covered.
  await recordSubmitOutcome(dir, '7', [A], ['claude-opus-5.5 12: its audit window is still open'], new Date('2026-11-01T11:00:00.000Z'))
  const held = await unsentEpochRuns(dir, '7')
  assert.deepEqual(held?.runIds, [A])
  assert.deepEqual(held?.outstanding, { at: '2026-11-01T11:00:00.000Z', items: ['claude-opus-5.5 12: its audit window is still open'] })
  assert.match(unsentEpochRunsMessage(held!), /Its last submit \(2026-11-01T11:00:00.000Z\) did not send: claude-opus-5.5 12: its audit window is still open\./)

  // The window closes and the next submit sends everything: nothing is outstanding.
  await recordSubmitOutcome(dir, '7', [A], [])
  assert.equal(await unsentEpochRuns(dir, '7'), null)

  // A later run whose model fails to send names the model, and the earlier run stays covered.
  await writeRun(dir, '7', B, '2026-11-01T20:00:00.000Z')
  await recordSubmitOutcome(dir, '7', [A, B], ['gemini-4-argon: failed (execution reverted)'])
  const failed = await unsentEpochRuns(dir, '7')
  assert.deepEqual(failed?.runIds, [B])
  assert.deepEqual(failed?.outstanding?.items, ['gemini-4-argon: failed (execution reverted)'])
}))
