import { randomUUID } from 'node:crypto'
import { decodeHttpRequest, decodeHttpResponse } from '@antseed/node'
import type { AuditTaskLimiter } from '../../audit-concurrency.js'
import { sanitizeOutcomeSummary } from '../../outcome-reason.js'
import {
  parseProxyAuditExchangeCost,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditExchangeCostV1,
} from '../../proxy-evidence.js'
import type { ResponseAuthReader } from '../../response-auth-reader.js'
import type { SellerClock } from './seller-clock.js'
import { asError } from '../../utils.js'

/**
 * One request to the audited seller through the buyer proxy, pinned to it, with the bytes it signed
 * captured (`sendSignedRequest`, the tokenizer pre-check's path too), for a body the caller writes. The
 * output-token checks read the answer from `responseAuth.signedPreimages`.
 */
export interface SignedSellerRequestV1 {
  requestIds: string[]
  statusCode: number | null
  attemptCosts: ProxyAuditExchangeCostV1[]
  /** The ResponseAuth of the last try, with the exact bytes the seller signed. */
  responseAuth: ProxyAuditEvidenceExchangeV1['responseAuth'] | null
  failureReason: string | null
}

export interface SignedSellerRequestInput {
  proxyBaseUrl: string
  peerId: string
  service: string
  serviceAliases?: readonly string[]
  responseAuthReader: ResponseAuthReader
  limiter: AuditTaskLimiter
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  /** Stops the request; no try starts after it. */
  signal?: AbortSignal
  /** The seller's audit clock: it runs only while this request is out. */
  clock?: SellerClock
  /** Called each time a try leaves for the seller, after any wait for a slot of the limiter. */
  onSend?: () => void
}

/** Times one request is sent before it counts as failed: the pre-check's and the output checks' alike. */
export const SIGNED_REQUEST_TRIES = 2
const SIGNED_REQUEST_TIMEOUT_MS = 60_000

/** What a caller of `sendSignedRequest` adds to each try: its own fields of the record and when an answer is enough. */
export interface SignedRequestHooks<SellerRequest extends SignedSellerRequestV1> {
  /** Clears the caller's own fields at the start of every try, so the record holds what the last try's answer gave. */
  reset?: (record: SellerRequest) => void
  /**
   * Reads a try's verified signed answer into the caller's fields: null when it is enough, or why it is not, and the
   * request is tried again (within `SIGNED_REQUEST_TRIES`).
   */
  inspect?: (record: SellerRequest) => string | null
}

/**
 * The one way an audit request reaches the seller: through the buyer proxy, pinned to the seller, with the bytes it
 * signed captured, tried up to `SIGNED_REQUEST_TRIES` times. It runs the seller's clock only while a try is out, from
 * when it leaves the limiter to its ResponseAuth, counts every try's cost (an answer after the audit was stopped too,
 * which then measures nothing), asks again after a 429, a 5xx, an answer without this request's ID or without a
 * verified ResponseAuth, and stops at any other 4xx. Never rejects: a failure is in `failureReason`.
 */
export async function sendSignedRequest<SellerRequest extends SignedSellerRequestV1>(
  input: SignedSellerRequestInput,
  body: Uint8Array,
  record: SellerRequest,
  hooks: SignedRequestHooks<SellerRequest> = {},
): Promise<SellerRequest> {
  const timeoutMs = Math.min(input.requestTimeoutMs ?? SIGNED_REQUEST_TIMEOUT_MS, SIGNED_REQUEST_TIMEOUT_MS)
  for (let attempt = 1; attempt <= SIGNED_REQUEST_TRIES; attempt += 1) {
    if (input.signal?.aborted) {
      record.failureReason = 'the audit was stopped'
      break
    }
    const requestId = randomUUID()
    record.requestIds.push(requestId)
    // The record holds the last try: its ResponseAuth, and what the caller read from it.
    record.responseAuth = null
    hooks.reset?.(record)
    let out = false
    let answered = false
    try {
      const { response, text } = await input.limiter.run(async () => {
        input.onSend?.()
        const live = input.clock?.start()
        out = input.clock !== undefined
        const signals = [AbortSignal.timeout(timeoutMs), ...(live ? [live] : []), ...(input.signal ? [input.signal] : [])]
        const answer = await (input.fetchFn ?? fetch)(`${input.proxyBaseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-antseed-pin-peer': input.peerId,
            'x-antseed-request-id': requestId,
            'x-antseed-capture-response-auth-preimages': '1',
          },
          body,
          signal: AbortSignal.any(signals),
        })
        return { response: answer, text: await answer.text() }
      })
      record.statusCode = response.status
      const cost = parseProxyAuditExchangeCost(Object.fromEntries(response.headers.entries()))
      if (cost) record.attemptCosts.push(cost)
      // Paid for and counted, but read as nothing: the check was stopped while it was out.
      if (input.signal?.aborted) {
        record.failureReason = 'the audit was stopped'
        break
      }
      if (response.status !== 200) {
        const detail = sanitizeOutcomeSummary(text).slice(0, 160)
        record.failureReason = `the seller answered HTTP ${response.status}${detail ? `: ${detail}` : ''}`
        // Any other 4xx is the seller refusing the request; asking again gives the same answer.
        if (response.status !== 429 && response.status < 500) break
        continue
      }
      if (response.headers.get('x-antseed-request-id') !== requestId) {
        record.failureReason = 'the buyer proxy answered without this request\'s ID'
        continue
      }
      answered = true
      const evidence = await input.responseAuthReader.waitForVerified({
        requestId,
        sellerPeerId: input.peerId,
        advertisedService: input.service,
        serviceAliases: input.serviceAliases,
        signal: input.signal,
      })
      record.responseAuth = {
        requestId: evidence.requestId,
        status: evidence.status,
        record: evidence.responseAuth ? withoutPreimages(evidence.responseAuth) : null,
        signedPreimages: evidence.signedPreimages ? { ...evidence.signedPreimages, hashAlgorithm: 'keccak256' } : null,
        failureReason: evidence.failureReason,
      }
      if (evidence.status !== 'verified' || !evidence.signedPreimages) {
        record.failureReason = evidence.failureReason ?? 'the answer has no verified ResponseAuth'
        continue
      }
      const notEnough = hooks.inspect?.(record) ?? null
      if (notEnough !== null) {
        record.failureReason = notEnough
        continue
      }
      record.failureReason = null
      return record
    } catch (error) {
      record.failureReason = `request failed: ${asError(error).message}`.slice(0, 300)
    } finally {
      if (out) input.clock!.finish(answered)
    }
  }
  return record
}

/** Sends `body` to `/v1/chat/completions` of the buyer proxy; any verified signed answer is enough. Never rejects. */
export async function askSellerSigned(input: SignedSellerRequestInput, body: Record<string, unknown>): Promise<SignedSellerRequestV1> {
  const record: SignedSellerRequestV1 = { requestIds: [], statusCode: null, attemptCosts: [], responseAuth: null, failureReason: null }
  return sendSignedRequest(input, new TextEncoder().encode(JSON.stringify(body)), record)
}

/**
 * The body the seller received and the status and body it answered, decoded from the bytes its verified
 * ResponseAuth signed; null for a request without them, or bytes that do not decode.
 */
export function signedExchange(request: SignedSellerRequestV1): { requestBody: Uint8Array; response: { statusCode: number; body: Uint8Array } } | null {
  const preimages = request.responseAuth?.status === 'verified' ? request.responseAuth.signedPreimages : null
  if (!preimages) return null
  try {
    const sent = decodeHttpRequest(Buffer.from(preimages.requestBase64, 'base64'))
    const answered = decodeHttpResponse(Buffer.from(preimages.responseBase64, 'base64'))
    return { requestBody: sent.body, response: { statusCode: answered.statusCode, body: answered.body } }
  } catch {
    return null
  }
}

function withoutPreimages<T extends { requestPreimage?: unknown; responsePreimage?: unknown }>(
  record: T,
): Omit<T, 'requestPreimage' | 'responsePreimage'> {
  const { requestPreimage: _request, responsePreimage: _response, ...rest } = record
  return rest
}
