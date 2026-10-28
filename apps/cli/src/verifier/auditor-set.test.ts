import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AuditorSetEvent } from '@antseed/node/payments'
import { AUDITOR_SET_CONFIRMATION_BLOCKS, approvedAuditorsAt, auditorSetCachePath, loadAuditorSetEvents, type AuditorSetEventSource } from './auditor-set.js'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'
const C = '0x3333333333333333333333333333333333333333'

function event(auditor: string, approved: boolean, blockNumber: number, timestamp: number, logIndex = 0): AuditorSetEvent {
  return { auditor, approved, blockNumber, logIndex, timestamp, transactionHash: `0x${blockNumber.toString(16)}` }
}

test('approved auditors are replayed up to the epoch start, sorted by address', () => {
  const events = [
    event(C, true, 10, 100),
    event(A, true, 11, 110),
    event(B, true, 12, 120),
    event(C, false, 13, 130),
    event(C, true, 20, 200),
  ]
  assert.deepEqual(approvedAuditorsAt(events, 115), [A, C])
  assert.deepEqual(approvedAuditorsAt(events, 150), [A, B])
  assert.deepEqual(approvedAuditorsAt(events, 200), [A, B], 'a change at the epoch start counts from the next epoch')
  assert.deepEqual(approvedAuditorsAt(events, 201), [A, B, C])
  assert.deepEqual(approvedAuditorsAt([...events].reverse(), 150), [A, B], 'input order does not matter')
})

test('within one block, the later log wins', () => {
  assert.deepEqual(approvedAuditorsAt([event(A, false, 5, 50, 2), event(A, true, 5, 50, 1)], 60), [])
})

function source(events: AuditorSetEvent[], latest: number) {
  const calls: Array<[number | undefined, number | 'latest' | undefined]> = []
  const reader: AuditorSetEventSource & { calls: typeof calls; latest: number } = {
    contractAddress: '0x27f93f9c110595e148f127732bafe20722572f66',
    latest,
    calls,
    async latestBlockNumber() { return this.latest },
    async queryAuditorSetEvents(fromBlock, toBlock) {
      calls.push([fromBlock, toBlock])
      return events.filter((entry) => entry.blockNumber >= (fromBlock ?? 0) && entry.blockNumber <= Number(toBlock))
    },
  }
  return reader
}

test('events are cached and only new blocks are read again', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'auditor-set-'))
  try {
    const events = [event(A, true, 100, 1_000), event(B, true, 1_000, 10_000)]
    const reader = source(events, 1_000)
    assert.deepEqual(await loadAuditorSetEvents(reader, dataDir), events)
    assert.deepEqual(reader.calls, [[undefined, 1_000]], 'the first call scans from the deployment block')
    const cached = JSON.parse(await readFile(auditorSetCachePath(dataDir), 'utf8'))
    assert.equal(cached.scannedThrough, 1_000 - AUDITOR_SET_CONFIRMATION_BLOCKS)
    assert.equal(cached.events.length, 1, 'events near the head are not cached yet')

    reader.latest = 2_000
    assert.deepEqual(await loadAuditorSetEvents(reader, dataDir), events)
    assert.deepEqual(reader.calls[1], [1_000 - AUDITOR_SET_CONFIRMATION_BLOCKS + 1, 2_000])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a cache for another contract is ignored', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'auditor-set-'))
  try {
    await loadAuditorSetEvents(source([event(A, true, 1, 1)], 500), dataDir)
    const other = source([event(B, true, 2, 2)], 500)
    ;(other as { contractAddress: string }).contractAddress = '0x' + '44'.repeat(20)
    assert.deepEqual((await loadAuditorSetEvents(other, dataDir)).map((entry) => entry.auditor), [B])
    assert.deepEqual(other.calls, [[undefined, 500]])
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
