import { Duplex } from 'node:stream'
import type { KeyedRelayExit, KeyedRelayProcess } from '@antseed/keyed-relay'
import { KEYED_REQUEST_TAIL_FIELDS, keyedRequestTailFields, type KeyedRequestTerms } from '@antseed/node'

/** Request headers the seller writes itself, so the buyer never sends them. */
const SELLER_WRITTEN_HEADERS = new Set(['host', 'connection', 'authorization', 'proxy-authorization'])

/** A keyed request body as the seller checks it, and what the buyer reveals of it. */
export interface KeyedRequestBody {
  body: Uint8Array
  /** Bytes at the end of `body` the seller checks: its last fields and the closing brace. */
  tailLength: number
  stream: boolean
  /** The output-token limit those fields name, or null for none. */
  maxTokens: number | null
}

/**
 * The fields of a chat completions body the keyed relay can carry, and the
 * output-token limit it asks for. Throws on a body no seller relays, whatever
 * its terms: not a JSON object, more than one choice, a malformed limit.
 */
export function keyedRequestFields(body: Uint8Array): { fields: Record<string, unknown>; asked: number | null } {
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new Error('the keyed relay needs a JSON request body')
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('the keyed relay needs a JSON object body')
  const fields = { ...(json as Record<string, unknown>) }
  if (fields['n'] !== undefined && fields['n'] !== 1) throw new Error('the keyed relay serves one choice per request (n = 1)')
  const asked = fields['max_completion_tokens'] ?? fields['max_tokens'] ?? null
  if (asked !== null && !(typeof asked === 'number' && Number.isSafeInteger(asked) && asked > 0)) {
    throw new Error('the output-token limit must be a positive integer')
  }
  return { fields, asked: asked as number | null }
}

/**
 * Rewrites a chat completions body for the keyed relay: the fields the seller
 * checks (`keyedRequestTailFields`: the service's model, the token limit, one
 * choice, usage in a stream, the seller's pinned fields) move to the end,
 * where the buyer reveals them, and nowhere else. A token limit above the
 * seller's cap is lowered to it; with a cap and no limit, the cap is the limit.
 */
export function keyedRequestBody(body: Uint8Array, model: string, terms: KeyedRequestTerms): KeyedRequestBody {
  return keyedRequestBodyFromFields(keyedRequestFields(body), model, terms)
}

/** `keyedRequestBody` for a body `keyedRequestFields` already read. */
export function keyedRequestBodyFromFields(parsed: ReturnType<typeof keyedRequestFields>, model: string, terms: KeyedRequestTerms): KeyedRequestBody {
  const fields = { ...parsed.fields }
  let maxTokens = parsed.asked
  if (terms.maxTokens !== undefined) maxTokens = maxTokens === null ? terms.maxTokens : Math.min(maxTokens, terms.maxTokens)
  const stream = fields['stream'] === true
  for (const name of [...KEYED_REQUEST_TAIL_FIELDS, ...Object.keys(terms.pinned ?? {})]) delete fields[name]
  const last = keyedRequestTailFields(terms, { model, maxTokens, stream })
  const rest = JSON.stringify(fields)
  const text = rest === '{}' ? `{${last}}` : `${rest.slice(0, -1)},${last}}`
  const tail = rest === '{}' ? text : `,${last}}`
  return { body: new TextEncoder().encode(text), tailLength: Buffer.byteLength(tail), stream, maxTokens }
}

/**
 * The buyer's plaintext side of a keyed relay stream, as a socket for Node's
 * HTTP client. The seller already wrote the request line, `Host`, its
 * credential and `Connection: close` as the session's first record, so the
 * request head Node writes loses its request line and those headers, and the
 * rest (the other headers, the blank line, the body) follows the seller's
 * head. Once `bodyLength` body bytes are written it emits `requestWritten`
 * (`{ headerLength, length }`), for the request reveal. Every response byte
 * is kept, raw, to pick the ranges to reveal for billing. It fails when the
 * sidecar exits before the response ended.
 */
export class KeyedPlaintextSocket extends Duplex {
  private _head: Buffer | null = Buffer.alloc(0)
  private _received: Buffer[] = []
  private _written = 0
  /** Bytes of the header block this socket forwarded (its headers and the blank line); -1 until known. */
  headerLength = -1

  constructor(
    private readonly _sidecar: Pick<KeyedRelayProcess, 'writeApp' | 'on'>,
    private readonly _bodyLength: number,
  ) {
    super()
    _sidecar.on('app', (data: Buffer) => {
      this._received.push(data)
      this.push(data)
    })
    let ended = false
    _sidecar.on('appEnd', () => {
      ended = true
      this.push(null)
    })
    // A sidecar that stops mid-answer sends no end: without this the request would never finish.
    _sidecar.on('exit', (exit: KeyedRelayExit) => {
      if (!ended) this.destroy(new Error(`the relay ended before the answer did (${exit.stderr || `exit ${exit.code}`})`))
    })
  }

  /** The raw response so far: status line, headers, body with its framing. */
  get received(): Buffer {
    return Buffer.concat(this._received)
  }

  override _read(): void {}

  private _forward(data: Buffer): void {
    this._sidecar.writeApp(data)
    this._written += data.length
    if (this._written === this.headerLength + this._bodyLength) {
      this.emit('requestWritten', { headerLength: this.headerLength, length: this._written })
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this._head === null) {
      this._forward(chunk)
      callback()
      return
    }
    this._head = Buffer.concat([this._head, chunk])
    const end = this._head.indexOf('\r\n\r\n')
    if (end < 0) {
      callback()
      return
    }
    const lines = this._head.subarray(0, end).toString('latin1').split('\r\n').slice(1)
    const kept = lines.filter((line) => !SELLER_WRITTEN_HEADERS.has(line.slice(0, line.indexOf(':')).trim().toLowerCase()))
    const rest = this._head.subarray(end + 4)
    this._head = null
    const headers = Buffer.from(kept.map((line) => `${line}\r\n`).join('') + '\r\n', 'latin1')
    this.headerLength = headers.length
    this._forward(Buffer.concat([headers, rest]))
    callback()
  }
}

/** A run of body bytes: where it sits in the body without chunk framing, and in the raw response. */
interface BodyPiece {
  at: number
  rawAt: number
  length: number
}

/**
 * The response body without its chunk framing, and where each piece of it
 * sits in the raw response. `complete` is false for a chunked body that
 * stopped before its last (empty) chunk: what follows the pieces is then not
 * known to be framing.
 */
function responseBody(text: string, bodyStart: number, chunked: boolean): { body: string; pieces: BodyPiece[]; complete: boolean } {
  if (!chunked) return { body: text.slice(bodyStart), pieces: [{ at: 0, rawAt: bodyStart, length: text.length - bodyStart }], complete: true }
  const pieces: BodyPiece[] = []
  let body = ''
  for (let at = bodyStart; ;) {
    const lineEnd = text.indexOf('\r\n', at)
    const size = lineEnd < 0 ? null : /^([0-9a-f]+)(?:;.*)?$/i.exec(text.slice(at, lineEnd))
    if (!size) return { body, pieces, complete: false }
    const length = Number.parseInt(size[1]!, 16)
    const start = lineEnd + 2
    // After the last chunk come trailers, which a chat completions upstream does not send, and the blank line.
    if (length === 0) return { body, pieces, complete: text.slice(start) === '\r\n' }
    if (start + length > text.length) return { body, pieces, complete: false }
    pieces.push({ at: body.length, rawAt: start, length })
    body += text.slice(start, start + length)
    at = start + length + 2
  }
}

/** The last `marker` that starts a line of `body` at or before `from`, or -1. */
function lastLineStart(body: string, marker: string, from: number): number {
  for (let at = body.lastIndexOf(marker, from); at >= 0; at = body.lastIndexOf(marker, at - 1)) {
    if (at === 0 || body[at - 1] === '\n' || body[at - 1] === '\r') return at
  }
  return -1
}

/** The last `"usage":` key of `body` that holds an object (a stream says `"usage":null` on the events before its last), or -1. */
function lastUsage(body: string): number {
  for (let at = body.lastIndexOf('"usage":'); at >= 0; at = at === 0 ? -1 : body.lastIndexOf('"usage":', at - 1)) {
    if (/^"usage":\s*\{/.test(body.slice(at, at + 16))) return at
  }
  return -1
}

/** Fields of a response that name it and the model that answered: the only text a billing reveal shows. */
const RESPONSE_LABEL_FIELDS = new Set(['id', 'object', 'model', 'system_fingerprint', 'service_tier', 'obfuscation'])
const RESPONSE_LABEL_MAX_LENGTH = 256

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Nothing: null, an empty string, or an object or array holding nothing. */
function blank(value: unknown): boolean {
  if (value === null || value === '') return true
  return typeof value === 'object' && Object.values(value as object).every(blank)
}

/** Numbers, booleans and nulls, alone or in objects and arrays: no text. */
function figures(value: unknown): boolean {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true
  return typeof value === 'object' && Object.values(value as object).every(figures)
}

/** A choice that says how the answer ended and carries none of it. */
function choiceWithoutAnswer(choice: unknown): boolean {
  if (!isRecord(choice)) return false
  return Object.entries(choice).every(([name, value]) => {
    if (name === 'index') return typeof value === 'number'
    if (name === 'finish_reason') return value === null || (typeof value === 'string' && /^[a-z_]{1,32}$/i.test(value))
    if (name === 'delta' || name === 'message') {
      return isRecord(value) && Object.entries(value).every(([field, part]) => (field === 'role' ? typeof part === 'string' && /^[a-z]{1,16}$/.test(part) : blank(part)))
    }
    return blank(value)
  })
}

/**
 * Whether a response object, or the last fields of one, holds nothing of the
 * answer: usage figures, the response's own labels, and choices that carry no
 * text. Anything it does not know fails, so a field an upstream adds is never
 * revealed by default.
 */
function withoutAnswer(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([name, field]) => {
    if (name === 'usage') return figures(field)
    if (name === 'choices') return Array.isArray(field) && field.every(choiceWithoutAnswer)
    if (typeof field === 'string' && field !== '') return RESPONSE_LABEL_FIELDS.has(name) && field.length <= RESPONSE_LABEL_MAX_LENGTH
    return figures(field) || blank(field)
  })
}

function parsedOrNull(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

/** Whether every line of a stream's `tail` is blank, the end marker, or an event without any of the answer. */
function streamTailWithoutAnswer(tail: string): boolean {
  return tail.split(/\r\n|\r|\n/).every((line) => {
    if (line === '') return true
    if (!line.startsWith('data:')) return false
    const data = line.slice(5).trim()
    return data === '[DONE]' || withoutAnswer(parsedOrNull(data))
  })
}

/**
 * The response ranges the buyer reveals to the seller for billing, as
 * (offset, length) in the raw response: the status line, and for a success
 * the usage figure to the end of the response. For a request that asked for
 * a stream that is the last event with a usage figure, from the `data:` its
 * line starts with, or only the `data: [DONE]` line when no event has one, so
 * the seller sees it was a stream. For one body it is the `"usage":` key
 * onward.
 *
 * Both are found in the body without its chunk framing. There the upstream
 * escapes line breaks and quotes inside JSON strings, so model output can
 * neither start a line with `data:` nor write a `"usage":` key: the reveal
 * never starts inside the answer.
 *
 * What would be revealed is then read, and revealed only when it holds none
 * of the answer (`withoutAnswer`): an upstream that puts the usage on the
 * event with the answer's last words, or sends more of the answer after it,
 * reveals the status line only. So does an answer in another form than the
 * request asked for, and a body that stopped before its end. The seller then
 * bills within the request it checked.
 */
export function keyedRevealRanges(raw: Buffer, statusCode: number, stream: boolean): Array<[number, number]> {
  const text = raw.toString('latin1')
  const statusEnd = text.indexOf('\r\n')
  if (statusEnd <= 0) return []
  const ranges: Array<[number, number]> = [[0, statusEnd]]
  if (statusCode < 200 || statusCode >= 300) return ranges
  const headerEnd = text.indexOf('\r\n\r\n')
  if (headerEnd < 0) return ranges
  const chunked = /\r\ntransfer-encoding:[^\r\n]*\bchunked\b/i.test(text.slice(0, headerEnd))
  const { body, pieces, complete } = responseBody(text, headerEnd + 4, chunked)
  if (!complete) return ranges
  const usageAt = lastUsage(body)
  let at: number
  if (stream) at = usageAt >= 0 ? lastLineStart(body, 'data:', usageAt) : lastLineStart(body, 'data: [DONE]', body.length)
  else at = usageAt
  const piece = pieces.find((candidate) => at >= candidate.at && at < candidate.at + candidate.length)
  if (!piece) return ranges
  // The body is latin1 here, one character a byte: read what would be revealed as the UTF-8 it is.
  const tail = Buffer.from(body.slice(at), 'latin1').toString('utf8')
  if (!(stream ? streamTailWithoutAnswer(tail) : withoutAnswer(parsedOrNull(`{${tail}`)))) return ranges
  const rawAt = piece.rawAt + (at - piece.at)
  ranges.push([rawAt, raw.length - rawAt])
  return ranges
}
