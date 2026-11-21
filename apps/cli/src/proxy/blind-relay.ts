import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import {
  BLIND_RELAY_CREDENTIAL_PATH,
  isBlindRelayOffer,
  type BlindRelayCredential,
  type PeerInfo,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
  type SerializedHttpResponseChunk,
} from '@antseed/node'

export { isBlindRelayOffer }

/** A credential is not used with less life left than this. */
const MIN_REMAINING_MS = 30_000
/** The most credentials the buyer holds per seller, service and identity (the seller allows 4 per buyer). */
const MAX_CREDENTIALS = 2
/** A busy credential (its last request still being billed) is retried this often, up to the wait below. */
const BUSY_RETRY_MS = 500
const BUSY_WAIT_MS = 12_000
const MINT_TIMEOUT_MS = 30_000

/** Thrown before anything reached the upstream, so the caller may try another seller. */
export class BlindRelayError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message)
    this.name = 'BlindRelayError'
  }
}

export interface BlindRelayDeps {
  /** A paid request to the seller (the credential route); 402 handling and payment come from the node. */
  sendRequest(peer: PeerInfo, request: SerializedHttpRequest, buyerIdentity: string | undefined): Promise<SerializedHttpResponse>
  openRelayStream(peer: PeerInfo, streamId: string, credentialId: string, buyerIdentity: string | undefined): Promise<Duplex>
  recordRelayedResponse(
    peer: PeerInfo,
    relayed: { requestId: string; service: string; requestBody: Uint8Array; response: SerializedHttpResponse },
    buyerIdentity: string | undefined,
  ): void
  /** Tests: replaces the TLS client run inside the relay stream. */
  secureConnect?: (stream: Duplex, host: string) => Duplex
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface HeldCredential {
  credential: BlindRelayCredential
}

export interface BlindRelayCallbacks {
  onResponseStart?(response: SerializedHttpResponse): void
  onResponseChunk?(chunk: SerializedHttpResponseChunk): void
}

const DROPPED_REQUEST_HEADERS = new Set([
  'authorization', 'host', 'content-length', 'connection', 'cookie', 'proxy-authorization',
  'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'accept-encoding',
])

/** The upstream URL path for a buyer path: `/v1/chat/completions` on base `/v1/openai` is `/v1/openai/chat/completions`. */
export function upstreamPath(baseUrl: string, path: string): string {
  if (!path.startsWith('/v1/')) throw new BlindRelayError(`the blind relay carries only /v1/ requests, not ${path.split('?')[0]}`, 400)
  return `${new URL(baseUrl).pathname.replace(/\/+$/, '')}${path.slice(3)}`
}

/** The request as the upstream gets it: its model, the credential, no Antseed or hop headers, and usage in a stream. */
export function upstreamRequest(
  request: SerializedHttpRequest,
  credential: BlindRelayCredential,
): { path: string; headers: Record<string, string>; body: Uint8Array } {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase()
    if (DROPPED_REQUEST_HEADERS.has(lower) || lower.startsWith('x-antseed-')) continue
    headers[lower] = value
  }
  let body = request.body
  if (body.length > 0) {
    let json: Record<string, unknown>
    try {
      json = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>
    } catch {
      throw new BlindRelayError('the blind relay needs a JSON request body', 400)
    }
    json['model'] = credential.upstream.model
    // The buyer prices the request from the usage it reads, so a stream must carry it.
    if (json['stream'] === true) {
      const options = typeof json['stream_options'] === 'object' && json['stream_options'] !== null ? json['stream_options'] as Record<string, unknown> : {}
      json['stream_options'] = { ...options, include_usage: true }
    }
    body = new TextEncoder().encode(JSON.stringify(json))
    headers['content-type'] = 'application/json'
  }
  headers['authorization'] = `Bearer ${credential.credential}`
  headers['host'] = credential.upstream.host
  headers['content-length'] = String(body.length)
  // One request per stream: the upstream closes, the stream ends, and the seller bills it.
  headers['connection'] = 'close'
  headers['accept-encoding'] = 'identity'
  return { path: upstreamPath(credential.upstream.baseUrl, request.path), headers, body }
}

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

/**
 * The buyer's side of the seller-blind relay. It gets a scoped upstream
 * credential from the seller (a paid request, free in itself), then sends
 * each request to the upstream over TLS it runs itself, through a raw relay
 * stream on the seller: the seller forwards ciphertext only and never sees
 * the conversation. The buyer prices each answer from its own usage figure,
 * and signs the seller's charge for it only up to that price.
 */
export class BlindRelayClient {
  private readonly _held = new Map<string, HeldCredential[]>()
  private readonly _minting = new Map<string, Promise<HeldCredential>>()

  constructor(private readonly _deps: BlindRelayDeps) {}

  private _now(): number {
    return this._deps.now?.() ?? Date.now()
  }

  private _sleep(ms: number): Promise<void> {
    return this._deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms))
  }

  private static _key(peer: PeerInfo, service: string, buyerIdentity: string | undefined): string {
    return `${peer.peerId.toLowerCase()}|${service}|${buyerIdentity ?? ''}`
  }

  private _live(key: string): HeldCredential[] {
    const now = this._now()
    const live = (this._held.get(key) ?? []).filter((held) => held.credential.expiresAt - now > MIN_REMAINING_MS)
    this._held.set(key, live)
    return live
  }

  private async _mint(peer: PeerInfo, service: string, buyerIdentity: string | undefined): Promise<HeldCredential> {
    const response = await this._deps.sendRequest(peer, {
      requestId: randomUUID(),
      method: 'POST',
      path: BLIND_RELAY_CREDENTIAL_PATH,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: service })),
    }, buyerIdentity)
    const text = new TextDecoder().decode(response.body)
    if (response.statusCode !== 200) {
      let reason = text.slice(0, 200)
      try {
        reason = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? reason
      } catch { /* not JSON */ }
      throw new BlindRelayError(`the seller minted no credential (HTTP ${response.statusCode}: ${reason})`, response.statusCode === 409 ? 503 : 502)
    }
    const credential = JSON.parse(text) as BlindRelayCredential
    if (typeof credential.credentialId !== 'string' || typeof credential.credential !== 'string'
      || typeof credential.upstream?.host !== 'string' || typeof credential.upstream.baseUrl !== 'string'
      || typeof credential.upstream.model !== 'string' || !Number.isFinite(credential.expiresAt)) {
      throw new BlindRelayError('the seller answered with a malformed credential')
    }
    const base = new URL(credential.upstream.baseUrl)
    // TLS goes to the host the seller relays to, and its certificate must be that host's.
    if (base.protocol !== 'https:' || base.hostname !== credential.upstream.host) {
      throw new BlindRelayError('the credential names an upstream the relay does not reach')
    }
    return { credential }
  }

  /** Opens a relay stream on an idle credential, minting one when none is idle. */
  private async _openStream(peer: PeerInfo, service: string, streamId: string, buyerIdentity: string | undefined): Promise<{ held: HeldCredential; stream: Duplex }> {
    const key = BlindRelayClient._key(peer, service, buyerIdentity)
    const deadline = this._now() + BUSY_WAIT_MS
    for (;;) {
      for (const held of this._live(key)) {
        try {
          return { held, stream: await this._deps.openRelayStream(peer, streamId, held.credential.credentialId, buyerIdentity) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/unknown credential|credential expired/.test(message)) {
            this._held.set(key, this._live(key).filter((other) => other !== held))
          } else if (!/credential busy/.test(message)) {
            throw new BlindRelayError(`the seller did not open a relay stream (${message})`)
          }
        }
      }
      if (this._live(key).length < MAX_CREDENTIALS) {
        let minting = this._minting.get(key)
        if (!minting) {
          minting = Promise.race([
            this._mint(peer, service, buyerIdentity),
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new BlindRelayError('the seller took too long to mint a credential')), MINT_TIMEOUT_MS).unref()),
          ]).finally(() => this._minting.delete(key))
          this._minting.set(key, minting)
          const held = await minting
          this._held.set(key, [...this._live(key), held])
        } else {
          await minting.catch(() => {})
        }
        continue
      }
      if (this._now() >= deadline) throw new BlindRelayError('every relay credential stayed busy', 503)
      await this._sleep(BUSY_RETRY_MS)
    }
  }

  /**
   * Sends one request to the upstream through the seller's relay and returns
   * the whole answer, streaming it through `callbacks` as it arrives. Throws
   * BlindRelayError when nothing reached the upstream.
   */
  async send(
    peer: PeerInfo,
    service: string,
    request: SerializedHttpRequest,
    buyerIdentity: string | undefined,
    callbacks: BlindRelayCallbacks = {},
    signal?: AbortSignal,
  ): Promise<SerializedHttpResponse> {
    const streamId = request.requestId || randomUUID()
    const { held, stream } = await this._openStream(peer, service, streamId, buyerIdentity)
    const upstream = upstreamRequest(request, held.credential)
    const host = held.credential.upstream.host
    let tls: Duplex | null = null
    try {
      // TLS to the upstream, checked against the system's CAs for `host`: the seller relays ciphertext only.
      tls = this._deps.secureConnect?.(stream, host) ?? tlsConnect({ socket: stream, servername: host, ALPNProtocols: ['http/1.1'] })
      const socket = tls as Socket
      return await new Promise<SerializedHttpResponse>((resolve, reject) => {
        let started = false
        const outgoing = httpRequest({
          method: request.method,
          path: upstream.path,
          headers: upstream.headers,
          // No agent: Node then connects through this, never by itself.
          createConnection: () => socket,
          ...(signal ? { signal } : {}),
        }, (incoming) => {
          started = true
          const statusCode = incoming.statusCode ?? 502
          const headers = flatHeaders(incoming.headers)
          callbacks.onResponseStart?.({ requestId: request.requestId, statusCode, headers, body: new Uint8Array(0) })
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
            callbacks.onResponseChunk?.({ requestId: request.requestId, data: new Uint8Array(chunk), done: false })
          })
          incoming.on('end', () => {
            const response: SerializedHttpResponse = { requestId: request.requestId, statusCode, headers, body: new Uint8Array(Buffer.concat(chunks)) }
            // Priced before the stream closes, so the seller's charge finds the buyer's own cost.
            this._deps.recordRelayedResponse(peer, { requestId: streamId, service, requestBody: upstream.body, response }, buyerIdentity)
            callbacks.onResponseChunk?.({ requestId: request.requestId, data: new Uint8Array(0), done: true })
            resolve(response)
          })
          incoming.on('error', reject)
        })
        outgoing.on('error', (error) => {
          reject(started ? error : new BlindRelayError(`the upstream could not be reached through the relay (${error.message})`))
        })
        outgoing.end(Buffer.from(upstream.body))
      })
    } finally {
      tls?.destroy()
      stream.destroy()
    }
  }
}
