import { createHash } from 'node:crypto'

/**
 * dstack (Phala) CVMs measure the app into RTMR3 at boot as runtime events: app-id, compose-hash
 * (SHA-256 of app-compose.json, which pins the container images and their config), init scripts,
 * instance-id, then boot-mr-done. RTMR3 differs per instance, so a buyer replays the event log to
 * RTMR3 and reads the compose hash from it instead of pinning RTMR3.
 */

/** dstack's runtime event type (not a TCG type). */
export const DSTACK_RUNTIME_EVENT_TYPE = 0x08000001

/** Generous bound on the RTMR3 events a seller may send; dstack emits under ten at boot. */
const MAX_RTMR3_EVENTS = 64

/** One event-log entry as the dstack guest agent returns it (bytes hex-encoded). */
export interface DstackEvent {
  imr: number
  event_type: number
  digest: string
  event: string
  event_payload: string
  /** Digest format: absent or 1 = binary preimage, 2 = canonical JSON. */
  version?: number
}

/** The SHA-384 digest dstack extends RTMR3 with for a runtime event (v1 binary or v2 canonical JSON preimage). */
export function runtimeEventDigest(name: string, payload: Buffer, version: number): Buffer {
  if (version === 2) {
    // JCS (RFC 8785): keys sorted, no whitespace. JSON.stringify serializes the string values the same way.
    const canonical = `{"name":${JSON.stringify(name)},"payload":${JSON.stringify(payload.toString('hex'))},"type":${DSTACK_RUNTIME_EVENT_TYPE}}`
    return createHash('sha384').update(canonical, 'utf8').digest()
  }
  const type = Buffer.alloc(4)
  type.writeUInt32LE(DSTACK_RUNTIME_EVENT_TYPE, 0)
  return createHash('sha384').update(Buffer.concat([type, Buffer.from(':'), Buffer.from(name, 'utf8'), Buffer.from(':'), payload])).digest()
}

/**
 * Parse a dstack event log (the JSON string or its decoded array) and check each entry's shape;
 * replay checks the contents. Throws on anything else.
 */
export function parseDstackEventLog(eventLog: unknown): DstackEvent[] {
  const parsed: unknown = typeof eventLog === 'string' ? JSON.parse(eventLog) : eventLog
  if (!Array.isArray(parsed)) throw new Error('event log is not an array')
  for (const e of parsed) {
    if (!e || typeof e !== 'object' || typeof e.imr !== 'number' || typeof e.event_type !== 'number'
      || typeof e.event !== 'string' || typeof e.event_payload !== 'string') {
      throw new Error('event log entry is not a dstack event')
    }
  }
  return parsed as DstackEvent[]
}

/** The RTMR3 events from a dstack event log (the JSON string or its parsed array). */
export function rtmr3Events(eventLog: unknown): DstackEvent[] {
  return parseDstackEventLog(eventLog).filter((e) => e.imr === 3)
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/
/**
 * dstack event names are kebab-case. The v1 digest preimage is `type ‖ ":" ‖ name ‖ ":" ‖ payload`
 * with no lengths, so a name holding ":" could move bytes between name and payload without
 * changing the digest (e.g. "init-script-hash:" with the payload's leading ":" removed). Only
 * names without delimiters are accepted, which makes every preimage split one way.
 */
const EVENT_NAME = /^[a-z0-9][a-z0-9-]*$/

/**
 * Replay a dstack RTMR3 event log against the quote's (DCAP-verified) RTMR3 and return the app's
 * compose hash. Every digest is recomputed from the event's name and payload, so a matching RTMR3
 * authenticates each event as dstack measured it. It fails when:
 *   - the replay does not reproduce RTMR3;
 *   - boot did not finish (no boot-mr-done), or there is not exactly one compose-hash before it;
 *   - any init script ran: init scripts are measured outside the compose file, so an approved
 *     compose hash would not cover them.
 */
export function composeHashFromEventLog(events: readonly DstackEvent[], rtmr3: Uint8Array): { composeHash: string } | { error: string } {
  if (events.length > MAX_RTMR3_EVENTS) return { error: 'malformed dstack event log' }
  let mr = Buffer.alloc(48)
  for (const e of events) {
    if (e.event_type !== DSTACK_RUNTIME_EVENT_TYPE || !EVENT_NAME.test(e.event) || !HEX.test(e.event_payload)) {
      return { error: 'malformed dstack event log' }
    }
    if (e.version !== undefined && e.version !== 1 && e.version !== 2) return { error: `unknown dstack event log version ${String(e.version)}` }
    const digest = runtimeEventDigest(e.event, Buffer.from(e.event_payload, 'hex'), e.version ?? 1)
    mr = createHash('sha384').update(Buffer.concat([mr, digest])).digest()
  }
  if (!mr.equals(Buffer.from(rtmr3))) return { error: 'dstack event log does not replay to the quote\'s RTMR3' }

  const boot = events
  const done = boot.findIndex((e) => e.event === 'boot-mr-done')
  if (done < 0) return { error: 'dstack boot did not complete (no boot-mr-done event)' }
  const measured = boot.slice(0, done)
  if (measured.some((e) => e.event === 'init-script-hash')) return { error: 'the CVM ran init scripts outside the approved compose file' }
  const compose = measured.filter((e) => e.event === 'compose-hash')
  if (compose.length !== 1 || compose[0]!.event_payload.length !== 64) return { error: 'dstack event log has no single compose-hash event' }
  return { composeHash: compose[0]!.event_payload.toLowerCase() }
}
