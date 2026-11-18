import { randomUUID } from 'node:crypto'
import { decodeHttpRequest, decodeHttpResponse } from '@antseed/node'
import type { AuditTaskLimiter } from './audit-concurrency.js'
import { sanitizeOutcomeSummary } from './outcome-reason.js'
import {
  parseProxyAuditExchangeCost,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditExchangeCostV1,
} from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import type { TokenizerPrecheckClock } from './tokenizer-precheck.js'
import { asError } from './utils.js'

/**
 * One request to the audited seller through the buyer proxy, pinned to it, with the bytes it signed
 * captured: the same path as the tokenizer pre-check's requests (`askSeller` in `tokenizer-precheck.ts`),
 * for a body the caller writes. The output-token checks read the answer from `responseAuth.signedPreimages`.
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
  clock?: TokenizerPrecheckClock
}

/** Times one request is sent before it counts as failed, as for the pre-check. */
export const SIGNED_REQUEST_TRIES = 2
const SIGNED_REQUEST_TIMEOUT_MS = 60_000

/** Sends `body` to `/v1/chat/completions` of the buyer proxy. Never rejects: a failure is in `failureReason`. */
export async function askSellerSigned(input: SignedSellerRequestInput, body: Record<string, unknown>): Promise<SignedSellerRequestV1> {
  const record: SignedSellerRequestV1 = { requestIds: [], statusCode: null, attemptCosts: [], responseAuth: null, failureReason: null }
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const timeoutMs = Math.min(input.requestTimeoutMs ?? SIGNED_REQUEST_TIMEOUT_MS, SIGNED_REQUEST_TIMEOUT_MS)
  for (let attempt = 1; attempt <= SIGNED_REQUEST_TRIES; attempt += 1) {
    if (input.signal?.aborted) {
      record.failureReason = 'the audit was stopped'
      break
    }
    const requestId = randomUUID()
    record.requestIds.push(requestId)
    record.responseAuth = null
    let out = false
    let answered = false
    try {
      const { response, text } = await input.limiter.run(async () => {
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
          body: bytes,
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

/** Total cost of the requests' tries. */
export function signedRequestsCost(requests: readonly SignedSellerRequestV1[]): ProxyAuditExchangeCostV1[] {
  return requests.flatMap((request) => request.attemptCosts)
}

function withoutPreimages<T extends { requestPreimage?: unknown; responsePreimage?: unknown }>(
  record: T,
): Omit<T, 'requestPreimage' | 'responsePreimage'> {
  const { requestPreimage: _request, responsePreimage: _response, ...rest } = record
  return rest
}
