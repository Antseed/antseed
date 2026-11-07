import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { DSTACK_RUNTIME_EVENT_TYPE, composeHashFromEventLog, parseDstackEventLog, runtimeEventDigest, rtmr3Events, type DstackEvent } from './dstack-event-log.js'

const COMPOSE = 'ab'.repeat(32)

function event(name: string, payloadHex: string, version?: number): DstackEvent {
  const digest = runtimeEventDigest(name, Buffer.from(payloadHex, 'hex'), version ?? 1).toString('hex')
  return { imr: 3, event_type: DSTACK_RUNTIME_EVENT_TYPE, digest, event: name, event_payload: payloadHex, ...(version ? { version } : {}) }
}

/** RTMR3 as dstack extends it: start from zeros, extend with each event digest in order. */
function replay(events: DstackEvent[]): Buffer {
  return events.reduce((mr, e) => createHash('sha384').update(Buffer.concat([mr, Buffer.from(e.digest, 'hex')])).digest(), Buffer.alloc(48))
}

function bootLog(version?: number, extra: DstackEvent[] = []): DstackEvent[] {
  return [
    event('system-preparing', '', version),
    event('app-id', '11'.repeat(20), version),
    event('compose-hash', COMPOSE, version),
    ...extra,
    event('instance-id', '22'.repeat(20), version),
    event('boot-mr-done', '', version),
    event('key-provider', Buffer.from('{"name":"kms"}').toString('hex'), version),
  ]
}

describe('dstack runtime event digests', () => {
  it('v1 hashes event_type_le ‖ ":" ‖ name ‖ ":" ‖ payload', () => {
    const expected = createHash('sha384').update(Buffer.concat([
      Buffer.from([0x01, 0x00, 0x00, 0x08]), Buffer.from(':app-id:'), Buffer.from([0xde, 0xad, 0xbe, 0xef]),
    ])).digest()
    expect(runtimeEventDigest('app-id', Buffer.from('deadbeef', 'hex'), 1).equals(expected)).toBe(true)
  })

  it('v2 hashes the canonical JSON dstack documents', () => {
    const expected = createHash('sha384').update('{"name":"compose-hash","payload":"abcd","type":134217729}').digest()
    expect(runtimeEventDigest('compose-hash', Buffer.from('abcd', 'hex'), 2).equals(expected)).toBe(true)
  })
})

describe('composeHashFromEventLog', () => {
  for (const version of [undefined, 2]) {
    it(`returns the compose hash when the log replays to RTMR3 (digest v${version ?? 1})`, () => {
      const log = bootLog(version)
      expect(composeHashFromEventLog(log, replay(log))).toEqual({ composeHash: COMPOSE })
    })
  }

  it('rejects a log whose payloads were changed (digests are recomputed, not trusted)', () => {
    const log = bootLog()
    const rtmr3 = replay(log)
    const forged = log.map((e) => (e.event === 'compose-hash' ? { ...e, event_payload: 'cd'.repeat(32) } : e))
    expect(composeHashFromEventLog(forged, rtmr3)).toEqual({ error: "dstack event log does not replay to the quote's RTMR3" })
  })

  it('rejects a log that does not match the quote', () => {
    expect(composeHashFromEventLog(bootLog(), Buffer.alloc(48, 1))).toMatchObject({ error: expect.stringMatching(/does not replay/) })
  })

  it('rejects a CVM that ran init scripts outside the compose file', () => {
    const log = bootLog(undefined, [event('init-script-hash', '33'.repeat(32))])
    expect(composeHashFromEventLog(log, replay(log))).toEqual({ error: 'the CVM ran init scripts outside the approved compose file' })
  })

  it('rejects an init script disguised by moving a ":" between name and payload (same v1 digest)', () => {
    const scriptHash = '3a' + '44'.repeat(31)
    const real = bootLog(undefined, [event('init-script-hash', scriptHash)])
    const rtmr3 = replay(real)
    // "init-script-hash" + ":" + "3a44…" and "init-script-hash:" + ":" + "44…" hash identically.
    const disguised = real.map((e) => (e.event === 'init-script-hash' ? { ...e, event: 'init-script-hash:', event_payload: scriptHash.slice(2) } : e))
    expect(runtimeEventDigest('init-script-hash:', Buffer.from(scriptHash.slice(2), 'hex'), 1)
      .equals(runtimeEventDigest('init-script-hash', Buffer.from(scriptHash, 'hex'), 1))).toBe(true)
    expect(composeHashFromEventLog(disguised, rtmr3)).toEqual({ error: 'malformed dstack event log' })
    expect(composeHashFromEventLog(real, rtmr3)).toEqual({ error: 'the CVM ran init scripts outside the approved compose file' })
  })

  it('ignores a compose-hash event emitted after boot (only boot measurements count)', () => {
    const log = [...bootLog(), event('compose-hash', 'cd'.repeat(32))]
    expect(composeHashFromEventLog(log, replay(log))).toEqual({ composeHash: COMPOSE })
  })

  it('requires boot to have completed', () => {
    const log = bootLog().filter((e) => e.event !== 'boot-mr-done')
    expect(composeHashFromEventLog(log, replay(log))).toMatchObject({ error: expect.stringMatching(/no boot-mr-done/) })
  })

  it('rejects malformed entries', () => {
    expect(() => parseDstackEventLog('{}')).toThrow('event log is not an array')
    expect(() => parseDstackEventLog([{ event: 'app-id' }])).toThrow('event log entry is not a dstack event')
    expect(parseDstackEventLog(JSON.stringify(bootLog()))).toEqual(bootLog())
    expect(composeHashFromEventLog([{ ...event('app-id', '00'), event_type: 1 }], Buffer.alloc(48))).toEqual({ error: 'malformed dstack event log' })
  })

  it('rtmr3Events keeps only RTMR3 entries from the agent log', () => {
    const raw = JSON.stringify([{ imr: 0, event_type: 1, digest: '', event: '', event_payload: '' }, ...bootLog()])
    expect(rtmr3Events(raw)).toHaveLength(bootLog().length)
  })
})
