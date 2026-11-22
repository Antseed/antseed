import { Duplex } from 'node:stream'
import type { KeyedRelayProcess } from '@antseed/keyed-relay'
import { KEYED_REQUEST_TAIL_FIELDS, keyedRequestTailFields, type KeyedRequestTerms } from '@antseed/node'

/** Request headers the seller writes itself, so the buyer never sends them. */
const SELLER_WRITTEN_HEADERS = new Set(['host', 'connection', 'authorization', 'proxy-authorization'])

/** A keyed request body as the seller checks it, and what the buyer reveals of it. */
export interface KeyedRequestBody {
  body: Uint8Array
  /** Bytes at the end of `body` the seller checks: its last fields and the closing brace. */
  tailLength: number
  stream: boolean
}

/**
 * Rewrites a chat completions body for the keyed relay: the fields the seller
 * checks (`keyedRequestTailFields`: the service's model, the token limit, one
 * choice, usage in a stream, the seller's pinned fields) move to the end,
 * where the buyer reveals them, and nowhere else. A token limit above the
 * seller's cap is lowered to it; with a cap and no limit, the cap is the limit.
 */
export function keyedRequestBody(body: Uint8Array, model: string, terms: KeyedRequestTerms): KeyedRequestBody {
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
  let maxTokens = asked as number | null
  if (terms.maxTokens !== undefined) maxTokens = maxTokens === null ? terms.maxTokens : Math.min(maxTokens, terms.maxTokens)
  const stream = fields['stream'] === true
  for (const name of [...KEYED_REQUEST_TAIL_FIELDS, ...Object.keys(terms.pinned ?? {})]) delete fields[name]
  const last = keyedRequestTailFields(terms, { model, maxTokens, stream })
  const rest = JSON.stringify(fields)
  const text = rest === '{}' ? `{${last}}` : `${rest.slice(0, -1)},${last}}`
  const tail = rest === '{}' ? text : `,${last}}`
  return { body: new TextEncoder().encode(text), tailLength: Buffer.byteLength(tail), stream }
}

/**
 * The buyer's plaintext side of a keyed relay stream, as a socket for Node's
 * HTTP client. The seller already wrote the request line, `Host`, its
 * credential and `Connection: close` as the session's first record, so the
 * request head Node writes loses its request line and those headers, and the
 * rest (the other headers, the blank line, the body) follows the seller's
 * head. Once `bodyLength` body bytes are written it emits `requestWritten`
 * (`{ headerLength, length }`), for the request reveal. Every response byte
 * is kept, raw, to pick the ranges to reveal for billing.
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
    _sidecar.on('appEnd', () => this.push(null))
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

/**
 * The response ranges the buyer reveals to the seller for billing, as
 * (offset, length) in the raw response: the status line, and for a success
 * the usage figure to the end of the response. That is the last stream event
 * that has one (`data:` ...), or the body from its `"usage":` key; a stream
 * with no usage shows only its `data: [DONE]` end, so the seller sees it was
 * a stream. None can be forged by model output, which the upstream escapes
 * inside JSON strings.
 */
export function keyedRevealRanges(raw: Buffer, statusCode: number): Array<[number, number]> {
  const text = raw.toString('latin1')
  const statusEnd = text.indexOf('\r\n')
  if (statusEnd <= 0) return []
  const ranges: Array<[number, number]> = [[0, statusEnd]]
  if (statusCode < 200 || statusCode >= 300) return ranges
  const headerEnd = text.indexOf('\r\n\r\n')
  if (headerEnd < 0) return ranges
  const usageAt = text.lastIndexOf('"usage":')
  if (usageAt <= headerEnd) {
    const done = text.lastIndexOf('data: [DONE]')
    if (done > headerEnd) ranges.push([done, raw.length - done])
    return ranges
  }
  const eventStart = text.lastIndexOf('data:', usageAt)
  const start = eventStart > headerEnd ? eventStart : usageAt
  ranges.push([start, raw.length - start])
  return ranges
}
