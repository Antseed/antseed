import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { KeyedRelayProcess, resolveKeyedRelayBinary } from '@antseed/keyed-relay'
import { KeyedPlaintextSocket, keyedRequestBodyFromFields, keyedRequestFields, keyedRevealRanges } from './keyed-relay-client.js'
import {
  BLIND_RELAY_CREDENTIAL_PATH,
  buyerFault,
  exposedResponseHeaders,
  faultAttributionOf,
  isBlindRelayOffer,
  isKeyedRequestTerms,
  keyedRefusalCode,
  ANTSEED_FAULT_ATTRIBUTION_HEADER,
  RELAY_RESPONSE_WAIT_MS,
  type BlindRelayCredential,
  type FaultAttribution,
  type KeyedRefusalCode,
  type PeerInfo,
  type RelayedResponse,
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
/** How long getting a credential and a relay stream may take in all, before any of the request is sent. */
const SETUP_TIMEOUT_MS = 45_000
/** A seller that rejects this many credentials in one request as unknown or expired has none a stream opens on. */
const MAX_REJECTED_CREDENTIALS = 2
/** How long the TLS handshake and the key proof may take. */
const KEYED_READY_TIMEOUT_MS = 30_000
/** How long the seller may take to check the request and forward it. */
const KEYED_ADMIT_TIMEOUT_MS = 90_000
/** How long revealing the billing ranges may take. */
const KEYED_REVEAL_TIMEOUT_MS = 30_000
/**
 * As for a request a seller answers itself: how long the answer may take to start, how long it may pause, and how long it may run.
 * The first two are the wait the relay stream stays open through with nothing on it (`RELAY_RESPONSE_WAIT_MS`), never longer.
 */
const RESPONSE_TIMEOUT_MS = RELAY_RESPONSE_WAIT_MS
const STREAM_IDLE_TIMEOUT_MS = RELAY_RESPONSE_WAIT_MS
const MAX_STREAM_DURATION_MS = 30 * 60_000
/** How long a request waits before it is sent again, after a seller refused it while a channel top-up was mining. */
const TOP_UP_RETRY_MS = 2_000
/** The one request the seller writes the head of. */
const KEYED_REQUEST_PATH = '/v1/chat/completions'

/**
 * Thrown before anything reached the upstream, so the caller may try another
 * seller. `attribution` is `buyer` when this buyer could send the request to
 * no seller: the caller then counts no failure against this one.
 */
export class BlindRelayError extends Error {
  constructor(
    message: string,
    readonly attribution: FaultAttribution = 'unknown',
    readonly detail: {
      /** The seller refused the request for a reason that passes: it is sent once more. */
      refusal?: KeyedRefusalCode
      /** The answer to the credential request that is the buyer's own to see: a payment it could not make. */
      response?: SerializedHttpResponse
    } = {},
  ) {
    super(message)
    this.name = 'BlindRelayError'
  }
}

export interface BlindRelayDeps {
  /**
   * A paid request to the seller (the credential route); 402 handling and payment come from the node.
   * With a `channelBinding` it goes only over the connection that binding names, and fails as the buyer's own otherwise.
   */
  sendRequest(peer: PeerInfo, request: SerializedHttpRequest, buyerIdentity: string | undefined, channelBinding?: string): Promise<SerializedHttpResponse>
  /** Opens a relay stream, under the same rule for `channelBinding`. */
  openRelayStream(peer: PeerInfo, streamId: string, credentialId: string, buyerIdentity: string | undefined, channelBinding?: string): Promise<Duplex>
  recordRelayedResponse(
    peer: PeerInfo,
    relayed: RelayedResponse,
    buyerIdentity: string | undefined,
  ): void
  /** The sidecar binary; defaults to the installed one. Null turns the relay off. */
  keyedRelayBinary?: string | null
  /** Tests only: a root certificate (PEM) the keyed sidecar trusts besides the system's. */
  keyedRelayExtraRootsPem?: string
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long an admitted request may wait for its answer to start. */
  responseTimeoutMs?: number
  /** How long a started answer may pause. */
  streamIdleTimeoutMs?: number
  /** How long an answer may run in all. */
  maxStreamDurationMs?: number
}

export interface BlindRelaySendOptions {
  /** The client's own signal: once it aborts, nothing more is asked of the seller. */
  signal?: AbortSignal
  /** The connection the seller's TEE attestation covered: the credential and the stream use that connection only. */
  channelBinding?: string
}

/** Who a request is for, and over which connection: what a held credential is good for. */
interface RelayTarget {
  peer: PeerInfo
  service: string
  buyerIdentity: string | undefined
  channelBinding: string | undefined
}

const GIVEN_UP = 'the request was given up while the relay was set up'

/** The error for a request that reached no upstream; `message` quotes the seller's refusal when it refused. */
function notSent(message: string): BlindRelayError {
  const refusal = keyedRefusalCode(message)
  return new BlindRelayError(message, 'unknown', refusal ? { refusal } : {})
}

export interface BlindRelayCallbacks {
  /**
   * Called before a stream opens under an ID other than the request's (a second attempt's): the seller charges
   * that attempt under `billingId`, so whoever follows the request's spend follows that ID too.
   */
  onAttempt?(billingId: string): void
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
  private readonly _held = new Map<string, BlindRelayCredential[]>()
  private readonly _minting = new Map<string, Promise<BlindRelayCredential>>()
  private _resolvedBinary: { path: string | null } | null = null

  constructor(private readonly _deps: BlindRelayDeps) {}

  private _now(): number {
    return this._deps.now?.() ?? Date.now()
  }

  private _sleep(ms: number): Promise<void> {
    return this._deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** The sidecar binary, looked up once. */
  private _binary(): string | null {
    this._resolvedBinary ??= { path: this._deps.keyedRelayBinary === undefined ? resolveKeyedRelayBinary() : this._deps.keyedRelayBinary }
    return this._resolvedBinary.path
  }

  /** Why this buyer can use no seller-blind service (it has no sidecar), or null when it can. */
  unavailable(): string | null {
    return this._binary() ? null : 'this buyer has no keyed-relay sidecar installed'
  }

  /** Credentials are held per connection binding too: one minted on another connection is never used for a bound request. */
  private static _key({ peer, service, buyerIdentity, channelBinding }: RelayTarget): string {
    return `${peer.peerId.toLowerCase()}|${service}|${buyerIdentity ?? ''}|${channelBinding ?? ''}`
  }

  private _live(key: string): BlindRelayCredential[] {
    const now = this._now()
    const live = (this._held.get(key) ?? []).filter((held) => held.expiresAt - now > MIN_REMAINING_MS)
    this._held.set(key, live)
    return live
  }

  private async _mint({ peer, service, buyerIdentity, channelBinding }: RelayTarget): Promise<BlindRelayCredential> {
    const response = await this._deps.sendRequest(peer, {
      requestId: randomUUID(),
      method: 'POST',
      path: BLIND_RELAY_CREDENTIAL_PATH,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: service })),
    }, buyerIdentity, channelBinding)
    const text = new TextDecoder().decode(response.body)
    if (response.statusCode !== 200) {
      let reason = text.slice(0, 200)
      try {
        reason = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? reason
      } catch { /* not JSON */ }
      const message = `the seller minted no credential (HTTP ${response.statusCode}: ${reason})`
      // What the node could not pay, or refused as the buyer's own: the caller answers with it, as for any other request.
      if (response.statusCode === 402 || response.headers[ANTSEED_FAULT_ATTRIBUTION_HEADER] === 'buyer') {
        throw new BlindRelayError(message, 'buyer', { response })
      }
      throw new BlindRelayError(message)
    }
    const credential = JSON.parse(text) as BlindRelayCredential
    if (typeof credential.credentialId !== 'string'
      || typeof credential.upstream?.host !== 'string' || typeof credential.upstream.baseUrl !== 'string'
      || typeof credential.upstream.model !== 'string' || typeof credential.upstream.path !== 'string'
      || !Number.isFinite(credential.expiresAt) || !isKeyedRequestTerms(credential.request)) {
      throw new BlindRelayError('the seller answered with a malformed credential')
    }
    // One that is never used would be asked for again, request after request.
    if (credential.expiresAt - this._now() <= MIN_REMAINING_MS) {
      throw new BlindRelayError('the seller minted a credential that is about to expire')
    }
    const base = new URL(credential.upstream.baseUrl)
    // TLS goes to the host the seller relays to, and its certificate must be that host's.
    if (base.protocol !== 'https:' || base.hostname !== credential.upstream.host) {
      throw new BlindRelayError('the credential names an upstream the relay does not reach')
    }
    return credential
  }

  /** The credential being minted for `key`, shared by the requests that wait for one. It is held once minted, whoever still waits. */
  private _minted(key: string, target: RelayTarget): Promise<BlindRelayCredential> {
    let minting = this._minting.get(key)
    if (!minting) {
      let timer: ReturnType<typeof setTimeout> | undefined
      minting = Promise.race([
        this._mint(target),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new BlindRelayError('the seller took too long to mint a credential')), MINT_TIMEOUT_MS)
          timer.unref()
        }),
      ]).then((held) => {
        this._held.set(key, [...this._live(key), held])
        return held
      }).finally(() => {
        clearTimeout(timer)
        this._minting.delete(key)
      })
      this._minting.set(key, minting)
    }
    return minting
  }

  /**
   * `work`, unless `signal` aborts or `deadline` (on the wall clock, when
   * there is one) passes first: the request then fails without waiting for
   * it, and `late` gets a result that still arrives.
   */
  private _unlessGivenUp<T>(work: Promise<T>, signal: AbortSignal | undefined, deadline: number | undefined, late?: (value: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        settle()
      }
      const onAbort = (): void => finish(() => reject(new BlindRelayError(GIVEN_UP)))
      const timer = deadline === undefined
        ? undefined
        : setTimeout(() => finish(() => reject(new BlindRelayError('the seller took too long to set up the relay'))), Math.max(0, deadline - Date.now()))
      timer?.unref()
      signal?.addEventListener('abort', onAbort, { once: true })
      work.then(
        (value) => {
          if (settled) late?.(value)
          else finish(() => resolve(value))
        },
        (error: unknown) => finish(() => reject(error)),
      )
      if (signal?.aborted) onAbort()
    })
  }

  /**
   * Opens a relay stream on an idle credential, minting one when none is
   * idle. It ends within SETUP_TIMEOUT_MS whatever the seller answers, and as
   * soon as `signal` aborts.
   */
  private async _openStream(target: RelayTarget, streamId: string, signal: AbortSignal | undefined): Promise<{ credential: BlindRelayCredential; stream: Duplex }> {
    const { peer, buyerIdentity, channelBinding } = target
    const key = BlindRelayClient._key(target)
    const busyDeadline = this._now() + BUSY_WAIT_MS
    const setupDeadline = this._now() + SETUP_TIMEOUT_MS
    const wallDeadline = Date.now() + SETUP_TIMEOUT_MS
    let rejected = 0
    for (;;) {
      if (signal?.aborted) throw new BlindRelayError(GIVEN_UP)
      if (this._now() >= setupDeadline) throw new BlindRelayError('the seller took too long to set up the relay')
      for (const held of this._live(key)) {
        try {
          const opening = this._deps.openRelayStream(peer, streamId, held.credentialId, buyerIdentity, channelBinding)
          return { credential: held, stream: await this._unlessGivenUp(opening, signal, wallDeadline, (late) => late.destroy()) }
        } catch (error) {
          // The buyer's own: a stream limit, or a connection other than the attested one. No seller is blamed.
          if (error instanceof BlindRelayError || faultAttributionOf(error) === 'buyer') throw error
          const message = error instanceof Error ? error.message : String(error)
          if (/unknown credential|credential expired/.test(message)) {
            this._held.set(key, this._live(key).filter((other) => other !== held))
            rejected += 1
            if (rejected >= MAX_REJECTED_CREDENTIALS) throw new BlindRelayError(`the seller minted no credential a stream opens on (${message})`)
          } else if (!/credential busy/.test(message)) {
            throw new BlindRelayError(`the seller did not open a relay stream (${message})`)
          }
        }
      }
      if (this._live(key).length < MAX_CREDENTIALS) {
        const mine = !this._minting.has(key)
        const minting = this._minted(key, target)
        // Another request's mint may fail for a reason of its own: this one then asks itself.
        await this._unlessGivenUp(mine ? minting : minting.catch(() => {}), signal, wallDeadline)
        continue
      }
      // The buyer holds MAX_CREDENTIALS streams to a seller: more requests at once than that is its own limit.
      if (this._now() >= busyDeadline) throw buyerFault('every relay credential stayed busy', 'buyer-stream-limit')
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
    options: BlindRelaySendOptions = {},
  ): Promise<SerializedHttpResponse> {
    const { signal, channelBinding } = options
    // What this buyer cannot send to any seller fails here, before a seller is asked for anything.
    if (request.path.split('?')[0] !== KEYED_REQUEST_PATH) {
      throw buyerFault(`the blind relay carries only ${KEYED_REQUEST_PATH}, not ${request.path.split('?')[0]}`, 'invalid-request')
    }
    let fields: ReturnType<typeof keyedRequestFields>
    try {
      fields = keyedRequestFields(request.body)
    } catch (error) {
      throw buyerFault(error instanceof Error ? error.message : String(error), 'invalid-request')
    }
    const binary = this._binary()
    if (!binary) throw new BlindRelayError(this.unavailable() ?? '', 'buyer')
    const target: RelayTarget = { peer, service, buyerIdentity, channelBinding }
    for (let attempt = 0; ; attempt += 1) {
      try {
        // A second attempt is a stream of its own, for the seller and for the charge it sends.
        const streamId = attempt === 0 && request.requestId ? request.requestId : randomUUID()
        if (streamId !== request.requestId) callbacks.onAttempt?.(streamId)
        return await this._sendOnce(target, streamId, request.requestId, fields, binary, callbacks, signal)
      } catch (error) {
        if (!(error instanceof BlindRelayError)) throw error
        if (error.detail.response) return { ...error.detail.response, requestId: request.requestId }
        const { refusal } = error.detail
        // A refused request reached no upstream, so sending it again is safe. Once: a seller that refuses again is left.
        if (!refusal || attempt > 0 || signal?.aborted) throw error
        if (refusal === 'channel_exhausted') {
          // The seller is closing the channel. A new credential is asked for: the node pays for it on a new channel.
          this._held.delete(BlindRelayClient._key(target))
        } else {
          await this._sleep(TOP_UP_RETRY_MS)
        }
      }
    }
  }

  private async _sendOnce(
    target: RelayTarget,
    streamId: string,
    requestId: string,
    fields: ReturnType<typeof keyedRequestFields>,
    binary: string,
    callbacks: BlindRelayCallbacks,
    signal: AbortSignal | undefined,
  ): Promise<SerializedHttpResponse> {
    const { peer, service, buyerIdentity } = target
    const { credential, stream } = await this._openStream(target, streamId, signal)
    let sidecar: KeyedRelayProcess | null = null
    /** Set once the answer is handed over: the billing reveal then ends the sidecar and the stream. */
    let revealing = false
    const close = (): void => {
      sidecar?.kill()
      stream.destroy()
    }
    try {
      // Given up as the stream opened: no sidecar is started for it.
      if (signal?.aborted) throw new BlindRelayError(GIVEN_UP)
      const prepared = keyedRequestBodyFromFields(fields, credential.upstream.model, credential.request)
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
        // The wait has its own deadline. A request given up meanwhile ends here: the sidecar and the stream close below.
        await this._unlessGivenUp(relay.waitFor('ready', KEYED_READY_TIMEOUT_MS), signal, undefined)
      } catch (error) {
        if (error instanceof BlindRelayError) throw error
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
      const responseTimeoutMs = this._deps.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS
      const streamIdleTimeoutMs = this._deps.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
      const maxStreamDurationMs = this._deps.maxStreamDurationMs ?? MAX_STREAM_DURATION_MS
      /** The wait for the next part of the answer, and the answer's whole run. */
      let waiting: ReturnType<typeof setTimeout> | undefined
      let running: ReturnType<typeof setTimeout> | undefined
      return await new Promise<SerializedHttpResponse>((resolve, reject) => {
        let started = false
        // Past admission the request may have reached the upstream: a plain error, not one that says nothing was sent.
        const endsWithin = (ms: number, message: string): ReturnType<typeof setTimeout> => {
          const timer = setTimeout(() => {
            reject(new Error(`${message} within ${ms} ms`))
            outgoing.destroy()
          }, ms)
          timer.unref()
          return timer
        }
        socket.once('requestWritten', ({ headerLength, length }: { headerLength: number; length: number }) => {
          relay.revealRequest(length, [[0, headerLength], [length - prepared.tailLength, prepared.tailLength]])
          relay.waitFor('admitted', KEYED_ADMIT_TIMEOUT_MS).then(() => {
            if (!started) waiting = endsWithin(responseTimeoutMs, 'the seller forwarded the request and no answer came')
          }, (error: unknown) => {
            // The seller holds the request until it admits it: nothing reached the upstream.
            reject(notSent(`the seller did not forward the request (${error instanceof Error ? error.message : String(error)})`))
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
          clearTimeout(waiting)
          waiting = endsWithin(streamIdleTimeoutMs, 'the answer started and no more of it came')
          running = endsWithin(maxStreamDurationMs, 'the answer did not end')
          const statusCode = incoming.statusCode ?? 502
          // As from a seller that answers itself: nothing of the seller's upstream account reaches the client.
          const responseHeaders = exposedResponseHeaders(flatHeaders(incoming.headers))
          callbacks.onResponseStart?.({ requestId, statusCode, headers: responseHeaders, body: new Uint8Array(0) })
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => {
            clearTimeout(waiting)
            waiting = endsWithin(streamIdleTimeoutMs, 'the answer started and no more of it came')
            chunks.push(chunk)
            callbacks.onResponseChunk?.({ requestId, data: new Uint8Array(chunk), done: false })
          })
          incoming.on('end', () => {
            const response: SerializedHttpResponse = { requestId, statusCode, headers: responseHeaders, body: new Uint8Array(Buffer.concat(chunks)) }
            // Priced before the reveal, so the seller's charge finds the buyer's own cost.
            this._deps.recordRelayedResponse(peer, { requestId: streamId, service, requestBody: prepared.body, response }, buyerIdentity)
            callbacks.onResponseChunk?.({ requestId, data: new Uint8Array(0), done: true })
            // The client has its answer; the reveal the seller bills by follows once the upstream closes.
            revealing = true
            void relay.waitFor('responseEnd', KEYED_REVEAL_TIMEOUT_MS)
              .then(() => {
                const done = relay.waitFor('done', KEYED_REVEAL_TIMEOUT_MS)
                relay.reveal(keyedRevealRanges(socket.received, statusCode, prepared.stream))
                return done
              })
              .catch(() => {})
              .finally(close)
            resolve(response)
          })
          incoming.on('error', reject)
        })
        outgoing.on('error', (error) => {
          reject(started ? error : notSent(`the upstream could not be reached through the relay (${error.message})`))
        })
        outgoing.end(Buffer.from(prepared.body))
      }).finally(() => {
        clearTimeout(waiting)
        clearTimeout(running)
      })
    } finally {
      if (!revealing) close()
    }
  }
}
