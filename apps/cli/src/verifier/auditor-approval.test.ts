import assert from 'node:assert/strict'
import test from 'node:test'
import { auditorRemovedMessage, createAuditorApprovalGate } from './auditor-approval.js'

function clock(start = 1_000_000) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

test('an approved auditor is read once per minute, however often the gate is asked', async () => {
  const time = clock()
  let reads = 0
  const gate = createAuditorApprovalGate({ read: async () => { reads += 1; return true }, now: time.now })
  assert.equal(await gate(), 'approved')
  assert.equal(await gate(), 'approved')
  time.advance(59_000)
  assert.equal(await gate(), 'approved')
  assert.equal(reads, 1)
  time.advance(2_000)
  assert.equal(await gate(), 'approved')
  assert.equal(reads, 2)
})

test('a removal is noticed at the next read and then kept without asking again', async () => {
  const time = clock()
  let approved = true
  let reads = 0
  const gate = createAuditorApprovalGate({ read: async () => { reads += 1; return approved }, now: time.now })
  assert.equal(await gate(), 'approved')
  approved = false
  assert.equal(await gate(), 'approved', 'inside the minute the last answer stands')
  time.advance(61_000)
  assert.equal(await gate(), 'revoked')
  approved = true
  time.advance(600_000)
  assert.equal(await gate(), 'revoked', 'a run that saw the removal does not start paying again')
  assert.equal(reads, 2)
})

test('a chain that cannot be read never stops the run, and warns once per streak', async () => {
  const time = clock()
  let fail = true
  const warnings: string[] = []
  const gate = createAuditorApprovalGate({
    read: async () => { if (fail) throw new Error('rpc timeout'); return true },
    now: time.now,
    warn: (message) => warnings.push(message),
  })
  assert.equal(await gate(), 'unknown')
  time.advance(61_000)
  assert.equal(await gate(), 'unknown')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /rpc timeout.*the run goes on/)
  fail = false
  time.advance(61_000)
  assert.equal(await gate(), 'approved')
  fail = true
  time.advance(61_000)
  assert.equal(await gate(), 'unknown')
  assert.equal(warnings.length, 2, 'a new streak warns again')
})

test('callers that ask at the same moment share one read', async () => {
  let reads = 0
  let release!: (value: boolean) => void
  const gate = createAuditorApprovalGate({
    read: () => { reads += 1; return new Promise<boolean>((resolve) => { release = resolve }) },
  })
  const answers = [gate(), gate(), gate()]
  // The read starts on the first call's microtask; let it begin before answering it.
  await Promise.resolve()
  release(false)
  assert.deepEqual(await Promise.all(answers), ['revoked', 'revoked', 'revoked'])
  assert.equal(reads, 1)
})

test('the stop message names the auditor and the epoch and says nothing more can be sent', () => {
  const message = auditorRemovedMessage('0x1000000000000000000000000000000000000001', '33')
  assert.match(message, /0x1000000000000000000000000000000000000001 was removed as an approved auditor during epoch 33/)
  assert.match(message, /cannot be sent/)
})
