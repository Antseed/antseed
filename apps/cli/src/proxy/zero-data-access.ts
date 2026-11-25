import {
  E2EE_ATTESTATION_PATH,
  E2eeError,
  E2eeSseDecryptor,
  createE2eeNonce,
  createE2eeSession,
  decryptChatCompletionResponse,
  e2eeRequestHeaders,
  encryptChatCompletionRequest,
  verifyUpstreamE2eeAttestation,
  type E2eeQuoteVerifier,
  type E2eeSession,
} from '@antseed/node'
import type { PeerInfo, SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '@antseed/node'
import { TEE_VERIFIER_ID } from '@antseed/node/tee-status'
import { importPluginModule } from '../plugins/loader.js'

/** The service category a seller announces for a service whose upstream encrypts end to end. */
export const E2EE_SERVICE_CATEGORY = 'e2ee'
/** How long a verified model key is reused before the buyer attests again with a fresh nonce. */
const ATTESTED_KEY_TTL_MS = 10 * 60_000
/** How long a failed attestation keeps the service out of zero-data-access routing. */
const FAILURE_TTL_MS = 5 * 60_000

export function isE2eeOffer(offer: { categories?: readonly string[] } | null | undefined): boolean {
  return offer?.categories?.some((category) => category.toLowerCase() === E2EE_SERVICE_CATEGORY) ?? false
}

export interface ZeroDataAccessDeps {
  /** Sends a free control-plane GET to the seller and returns its response. */
  fetchFromPeer(peer: PeerInfo, path: string, buyerIdentity: string | undefined): Promise<{ statusCode: number; body: Uint8Array }>
  /** The DCAP check, loaded on first use (the antseed-verifier's). */
  loadQuoteVerifier(): Promise<E2eeQuoteVerifier>
  now?: () => number
}

interface AttestedKey {
  modelPublicKey: string
  expiresAt: number
}

/**
 * Attests a seller's end-to-end encrypted service and hands out per-request
 * sessions. The seller relays the upstream attestation; the buyer checks it
 * itself, so a seller cannot substitute a key it controls.
 */
export class ZeroDataAccess {
  private readonly keys = new Map<string, AttestedKey>()
  private readonly pending = new Map<string, Promise<string>>()
  private readonly failures = new Map<string, { reason: string; until: number }>()
  private quoteVerifier: Promise<E2eeQuoteVerifier> | null = null

  constructor(private readonly deps: ZeroDataAccessDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private static key(peerId: string, serviceId: string, buyerIdentity: string | undefined): string {
    return `${peerId.toLowerCase()}|${serviceId}|${buyerIdentity ?? ''}`
  }

  /** Why this service recently failed its attestation, if it did. */
  failure(peerId: string, serviceId: string): string | undefined {
    const now = this.now()
    for (const [key, entry] of this.failures) {
      if (entry.until <= now) this.failures.delete(key)
    }
    return this.failures.get(`${peerId.toLowerCase()}|${serviceId}`)?.reason
  }

  /** A fresh per-request session for an attested model key; attests when no verified key is cached. */
  async session(peer: PeerInfo, serviceId: string, buyerIdentity?: string): Promise<E2eeSession> {
    const peerId = peer.peerId
    const key = ZeroDataAccess.key(peerId, serviceId, buyerIdentity)
    const cached = this.keys.get(key)
    if (cached && cached.expiresAt > this.now()) return createE2eeSession(cached.modelPublicKey)
    let attesting = this.pending.get(key)
    if (!attesting) {
      attesting = this.attest(peer, serviceId, buyerIdentity)
        .then((modelPublicKey) => {
          this.keys.set(key, { modelPublicKey, expiresAt: this.now() + ATTESTED_KEY_TTL_MS })
          this.failures.delete(`${peerId.toLowerCase()}|${serviceId}`)
          return modelPublicKey
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error)
          this.failures.set(`${peerId.toLowerCase()}|${serviceId}`, { reason, until: this.now() + FAILURE_TTL_MS })
          throw error
        })
        .finally(() => this.pending.delete(key))
      this.pending.set(key, attesting)
    }
    return createE2eeSession(await attesting)
  }

  private async attest(peer: PeerInfo, serviceId: string, buyerIdentity: string | undefined): Promise<string> {
    const nonce = createE2eeNonce()
    const path = `${E2EE_ATTESTATION_PATH}?service=${encodeURIComponent(serviceId)}&nonce=${nonce}`
    const response = await this.deps.fetchFromPeer(peer, path, buyerIdentity)
    if (response.statusCode !== 200) {
      throw new E2eeError(`the seller answered the attestation request with HTTP ${response.statusCode}`)
    }
    let attestation: Record<string, unknown>
    try {
      attestation = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>
    } catch {
      throw new E2eeError('the attestation is not JSON')
    }
    this.quoteVerifier ??= this.deps.loadQuoteVerifier().catch((error: unknown) => {
      this.quoteVerifier = null
      throw error
    })
    const verified = await verifyUpstreamE2eeAttestation(attestation, nonce, await this.quoteVerifier)
    return verified.modelPublicKey
  }
}

/**
 * The request with every message encrypted and the scheme's headers added.
 * Throws E2eeError when the request cannot be fully encrypted.
 */
export async function encryptRequest(request: SerializedHttpRequest, session: E2eeSession): Promise<SerializedHttpRequest> {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>
  } catch {
    throw new E2eeError('An end-to-end encrypted request needs a JSON body.')
  }
  const encrypted = await encryptChatCompletionRequest(body, session)
  const headers = { ...request.headers }
  delete headers['content-length']
  return {
    ...request,
    headers: { ...headers, ...e2eeRequestHeaders(session) },
    body: new TextEncoder().encode(JSON.stringify(encrypted)),
  }
}

/** A buffered response with its message contents decrypted; error and non-JSON bodies pass unchanged. */
export async function decryptResponse(response: SerializedHttpResponse, session: E2eeSession): Promise<SerializedHttpResponse> {
  if (response.statusCode < 200 || response.statusCode >= 300) return response
  const text = new TextDecoder().decode(response.body)
  if (!text.trimStart().startsWith('{')) {
    const decryptor = new E2eeSseDecryptor(session)
    const out = (await decryptor.push(text)) + (await decryptor.flush())
    return { ...response, body: new TextEncoder().encode(out) }
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    return response
  }
  await decryptChatCompletionResponse(body, session)
  return { ...response, body: new TextEncoder().encode(JSON.stringify(body)) }
}

/**
 * Decrypts a streamed response chunk by chunk, in order. Each chunk's text is
 * decrypted before the next one starts, so chunks never overtake each other.
 */
export function createStreamDecryptor(session: E2eeSession): {
  push(chunk: Uint8Array): Promise<Uint8Array>
  flush(): Promise<Uint8Array>
} {
  const sse = new E2eeSseDecryptor(session)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  return {
    async push(chunk) {
      return encoder.encode(await sse.push(decoder.decode(chunk, { stream: true })))
    },
    async flush() {
      const tail = await sse.push(decoder.decode())
      return encoder.encode(tail + await sse.flush())
    },
  }
}

/**
 * Decrypts a streamed response as its chunks arrive and writes each one in the
 * order it came, though decryption is async. The first chunk that does not
 * decrypt ends it: nothing later is written, `onError` hears of it at once and
 * `drain()` throws it. Nothing more is decrypted once `stopped()` is true.
 */
export function createOrderedStreamDecryptor(session: E2eeSession, sink: {
  write(chunk: SerializedHttpResponseChunk): void
  stopped(): boolean
  onError(error: unknown): void
}): {
  push(chunk: SerializedHttpResponseChunk): void
  /** Resolves once every pushed chunk was written; throws the first failure. */
  drain(): Promise<void>
} {
  const decryptor = createStreamDecryptor(session)
  let queue: Promise<void> = Promise.resolve()
  const failures: unknown[] = []
  return {
    push(chunk) {
      queue = queue.then(async () => {
        if (failures.length > 0 || sink.stopped()) return
        const data = await decryptor.push(chunk.data)
        const tail = chunk.done ? await decryptor.flush() : new Uint8Array()
        sink.write({ ...chunk, data: tail.length > 0 ? Buffer.concat([data, tail]) : data })
      }).catch((error: unknown) => {
        failures.push(error)
        sink.onError(error)
      })
    },
    async drain() {
      await queue
      if (failures.length > 0) throw failures[0]
    },
  }
}

/**
 * The antseed-verifier's DCAP check (Intel signature chain, TCB status, TD
 * report), loaded from the installed plugin at its pinned version. Its own
 * TCB policy decides what is acceptable, as for seller TEE attestation.
 */
export async function loadVerifierQuoteCheck(): Promise<E2eeQuoteVerifier> {
  const { mod } = await importPluginModule(TEE_VERIFIER_ID)
  const verifyQuote = mod['defaultVerifyQuote']
  const isTcbAcceptable = mod['isTcbAcceptable']
  if (typeof verifyQuote !== 'function' || typeof isTcbAcceptable !== 'function') {
    throw new E2eeError(`the installed ${TEE_VERIFIER_ID} has no DCAP check`)
  }
  return async (quote) => {
    const verdict = await (verifyQuote as (q: Uint8Array, c: undefined, now: number) => Promise<{
      status: string
      td: { reportData: Uint8Array; debug: boolean | null } | null
    }>)(quote, undefined, Math.floor(Date.now() / 1000))
    return {
      status: verdict.status,
      acceptable: (isTcbAcceptable as (status: string) => boolean)(verdict.status),
      reportData: verdict.td?.reportData ?? null,
      debug: verdict.td?.debug ?? null,
    }
  }
}
