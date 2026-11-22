import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { KeyedRelayProcess, resolveKeyedRelayBinary } from '@antseed/keyed-relay'
import { KeyedPlaintextSocket, keyedRequestBody, keyedRevealRanges, type KeyedRequestBody } from './keyed-relay-client.js'
import {
  BLIND_RELAY_CREDENTIAL_PATH,
  isBlindRelayOffer,
  isKeyedRequestTerms,
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
/** How long the TLS handshake and the key proof may take. */
const KEYED_READY_TIMEOUT_MS = 30_000
/** How long the seller may take to check the request and forward it. */
const KEYED_ADMIT_TIMEOUT_MS = 90_000
/** How long revealing the billing ranges may take. */
const KEYED_REVEAL_TIMEOUT_MS = 30_000
/** The one request the seller writes the head of. */
const KEYED_REQUEST_PATH = '/v1/chat/completions'

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
  /** The sidecar binary; defaults to the installed one. Null turns the relay off. */
  keyedRelayBinary?: string | null
  /** Tests only: a root certificate (PEM) the keyed sidecar trusts besides the system's. */
  keyedRelayExtraRootsPem?: string
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

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

/**
 * The buyer's side of the seller-blind relay. It gets a credential handle
 * from the seller (a paid request, free in itself), then sends each request
 * to the upstream over TLS its sidecar runs, through a raw relay stream on
 * the seller: the seller forwards ciphertext only and never sees the
 * conversation, and the buyer never sees the seller's upstream credential.
 * The buyer prices each answer from its own usage figure, and signs the
 * seller's charge for it only up to that price.
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
    if (typeof credential.credentialId !== 'string'
      || typeof credential.upstream?.host !== 'string' || typeof credential.upstream.baseUrl !== 'string'
      || typeof credential.upstream.model !== 'string' || typeof credential.upstream.path !== 'string'
      || !Number.isFinite(credential.expiresAt) || !isKeyedRequestTerms(credential.request)) {
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
   *
   * The seller keeps its own upstream credential. The buyer's sidecar runs TLS
   * to the upstream through the relay and proves the session keys to the
   * seller's sidecar in zero knowledge, so the seller can write the request
   * head with its credential as the first record without reading the session;
   * the buyer never sees that record. The buyer then sends the rest of the
   * request and reveals its headers and the body's last fields (model, token
   * limit, usage in a stream), which the seller checks before forwarding any
   * of it. It reads the answer and reveals only the status line and the usage
   * figure it is billed by.
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
    const { held: { credential }, stream } = await this._openStream(peer, service, streamId, buyerIdentity)
    let sidecar: KeyedRelayProcess | null = null
    try {
      if (request.path.split('?')[0] !== KEYED_REQUEST_PATH) {
        throw new BlindRelayError(`this seller relays only ${KEYED_REQUEST_PATH}, not ${request.path.split('?')[0]}`, 400)
      }
      let prepared: KeyedRequestBody
      try {
        prepared = keyedRequestBody(request.body, credential.upstream.model, credential.request)
      } catch (error) {
        throw new BlindRelayError(error instanceof Error ? error.message : String(error), 400)
      }
      const binary = this._deps.keyedRelayBinary === undefined ? resolveKeyedRelayBinary() : this._deps.keyedRelayBinary
      if (!binary) throw new BlindRelayError('this buyer has no keyed-relay sidecar installed')
      sidecar = KeyedRelayProcess.spawn('buyer', binary)
      const relay = sidecar
      stream.pipe(relay.peer)
      relay.peer.pipe(stream)
      stream.on('error', () => relay.kill())
      relay.startBuyer({
        serverName: credential.upstream.host,
        ...(this._deps.keyedRelayExtraRootsPem ? { extraRootsPem: this._deps.keyedRelayExtraRootsPem } : {}),
      })
      try {
        await relay.waitFor('ready', KEYED_READY_TIMEOUT_MS)
      } catch (error) {
        // Nothing beyond the seller's head reached the upstream: no request was made.
        throw new BlindRelayError(`the relay did not start (${error instanceof Error ? error.message : String(error)})`)
      }
      const socket = new KeyedPlaintextSocket(relay, prepared.body.length)
      // Only headers the seller relays: anything else would fail its check.
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-length': String(prepared.body.length),
        accept: prepared.stream ? 'text/event-stream' : 'application/json',
      }
      return await new Promise<SerializedHttpResponse>((resolve, reject) => {
        let started = false
        socket.once('requestWritten', ({ headerLength, length }: { headerLength: number; length: number }) => {
          relay.revealRequest(length, [[0, headerLength], [length - prepared.tailLength, prepared.tailLength]])
          relay.waitFor('admitted', KEYED_ADMIT_TIMEOUT_MS).catch((error: unknown) => {
            // The seller holds the request until it admits it: nothing reached the upstream.
            reject(new BlindRelayError(`the seller did not forward the request (${error instanceof Error ? error.message : String(error)})`))
            outgoing.destroy()
          })
        })
        const outgoing = httpRequest({
          method: 'POST',
          path: credential.upstream.path,
          headers,
          setHost: false,
          createConnection: () => socket as unknown as Socket,
          ...(signal ? { signal } : {}),
        }, (incoming) => {
          started = true
          const statusCode = incoming.statusCode ?? 502
          const responseHeaders = flatHeaders(incoming.headers)
          callbacks.onResponseStart?.({ requestId: request.requestId, statusCode, headers: responseHeaders, body: new Uint8Array(0) })
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
            callbacks.onResponseChunk?.({ requestId: request.requestId, data: new Uint8Array(chunk), done: false })
          })
          incoming.on('end', () => {
            const response: SerializedHttpResponse = { requestId: request.requestId, statusCode, headers: responseHeaders, body: new Uint8Array(Buffer.concat(chunks)) }
            // Priced before the reveal, so the seller's charge finds the buyer's own cost.
            this._deps.recordRelayedResponse(peer, { requestId: streamId, service, requestBody: prepared.body, response }, buyerIdentity)
            callbacks.onResponseChunk?.({ requestId: request.requestId, data: new Uint8Array(0), done: true })
            void relay.waitFor('responseEnd', KEYED_REVEAL_TIMEOUT_MS)
              .then(() => {
                const done = relay.waitFor('done', KEYED_REVEAL_TIMEOUT_MS)
                relay.reveal(keyedRevealRanges(socket.received, statusCode))
                return done
              })
              .catch(() => {})
              .finally(() => resolve(response))
          })
          incoming.on('error', reject)
        })
        outgoing.on('error', (error) => {
          reject(started ? error : new BlindRelayError(`the upstream could not be reached through the relay (${error.message})`))
        })
        outgoing.end(Buffer.from(prepared.body))
      })
    } finally {
      sidecar?.kill()
      stream.destroy()
    }
  }
}
