import { parseKbfAnswers, type KbfProbe } from '@antseed/fingerprints'
import { decodeHttpRequest, decodeHttpResponse, verifyResponseAuth } from '@antseed/node'
import { extractCompletionText } from '../model-run.js'
import { auditRequestProblem } from './request-check.js'
import type { EnvelopeSliceV1, PlannedBatchV1, RoundTargetV1, SliceExchangeV1 } from './types.js'

export type ExchangeCheck =
  | { ok: true; answers: Array<number | null> }
  | { ok: false; reason: string }

/**
 * Checks one seller response with nothing but its published bytes:
 * - the seller's signature covers exactly these request and response bytes;
 * - it was signed by the target seller for the target service, with HTTP 200;
 * - the request is exactly the planned audit request (see `auditRequestProblem`).
 * Answers are parsed from the signed response bytes, so every verifier reads the same answers.
 * Never throws: anything malformed is a failed check.
 */
export function checkExchange(
  exchange: SliceExchangeV1,
  target: RoundTargetV1,
  batch: PlannedBatchV1,
  probes: readonly KbfProbe[],
  settings: EnvelopeSliceV1['request'],
): ExchangeCheck {
  try {
    return check(exchange, target, batch, probes, settings)
  } catch (error) {
    return { ok: false, reason: `malformed exchange: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function check(
  exchange: SliceExchangeV1,
  target: RoundTargetV1,
  batch: PlannedBatchV1,
  probes: readonly KbfProbe[],
  settings: EnvelopeSliceV1['request'],
): ExchangeCheck {
  let request
  let response
  try {
    request = decodeHttpRequest(Buffer.from(exchange.requestBase64, 'base64'))
    response = decodeHttpResponse(Buffer.from(exchange.responseBase64, 'base64'))
  } catch (error) {
    return { ok: false, reason: `undecodable exchange: ${error instanceof Error ? error.message : String(error)}` }
  }
  const auth = exchange.responseAuth
  if (auth.requestId !== exchange.requestId) return { ok: false, reason: 'request id mismatch' }
  if (auth.advertisedService.trim().toLowerCase() !== target.service.trim().toLowerCase()) {
    return { ok: false, reason: 'signed for another service' }
  }
  const verified = verifyResponseAuth(auth, {
    request,
    response,
    buyerPeerId: auth.buyerPeerId,
    sellerPeerId: target.peerId,
    advertisedService: auth.advertisedService,
  })
  if (!verified.valid) return { ok: false, reason: `seller signature: ${verified.reason}` }
  if (response.statusCode !== 200) return { ok: false, reason: `HTTP ${response.statusCode}` }

  const requestProblem = auditRequestProblem({
    path: request.path,
    body: request.body,
    service: target.service,
    probes,
    promptVariantId: batch.promptVariantId,
    settings,
  })
  if (requestProblem) return { ok: false, reason: requestProblem }

  const text = extractCompletionText(response.body)
  if (text === null) return { ok: false, reason: 'no completion text' }
  return { ok: true, answers: parseKbfAnswers(text, probes.length) }
}
