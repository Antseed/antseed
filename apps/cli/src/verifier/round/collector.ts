import { randomUUID } from 'node:crypto'
import {
  buildKbfChatRequestBody,
  isKbfSamplingFieldRejection,
  isKbfThinkingSuppressionRejection,
} from '@antseed/fingerprints'
import type { ResponseAuthReader } from '../response-auth-reader.js'
import type { CollectedSliceV1, EnvelopeSliceV1, SliceExchangeV1 } from './types.js'
import { targetKey } from './types.js'

const BATCH_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 180_000

export interface CollectorContext {
  /** Buyer proxy base URL, e.g. http://127.0.0.1:8377. */
  buyerUrl: string
  responseAuth: ResponseAuthReader
  log: (message: string) => void
  fetchImpl?: typeof fetch
}

/**
 * Buys one slice from its seller through the buyer proxy, pinned to that seller, and keeps the
 * seller-signed record of every batch. A batch is retried only when there is no usable signed
 * response (transport error, non-200, missing signature); the first signed 200 is kept, so a
 * collector never picks among several answers.
 */
export async function collectSlice(slice: EnvelopeSliceV1, context: CollectorContext): Promise<CollectedSliceV1> {
  const exchanges: SliceExchangeV1[] = []
  for (const batch of slice.batches) {
    const exchange = await collectBatch(slice, batch, context)
    if (exchange) exchanges.push(exchange)
  }
  return { targetKey: targetKey(slice.target), sliceIndex: slice.sliceIndex, exchanges }
}

async function collectBatch(
  slice: EnvelopeSliceV1,
  batch: EnvelopeSliceV1['batches'][number],
  context: CollectorContext,
): Promise<SliceExchangeV1 | null> {
  const fetchImpl = context.fetchImpl ?? fetch
  let omitSampling = false
  let omitThinking = false
  for (let attempt = 1; attempt <= BATCH_ATTEMPTS; attempt++) {
    const requestId = randomUUID()
    const body = requestBody(slice, batch, { omitSampling, omitThinking })
    let status = 0
    let errorText = ''
    try {
      const response = await fetchImpl(`${context.buyerUrl.replace(/\/+$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-antseed-pin-peer': slice.target.peerId,
          'x-antseed-capture-response-auth-preimages': '1',
          'x-antseed-request-id': requestId,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      status = response.status
      errorText = await response.text()
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error)
    }
    if (status === 400 || status === 422) {
      if (!omitSampling && isKbfSamplingFieldRejection(status, errorText)) { omitSampling = true; continue }
      if (!omitThinking && isKbfThinkingSuppressionRejection(status, errorText)) { omitThinking = true; continue }
    }
    if (status !== 200) {
      context.log(`batch ${batch.batchIndex} of ${targetKey(slice.target)}: HTTP ${status || 'error'} ${errorText.slice(0, 160)}`)
      continue
    }
    const evidence = await context.responseAuth.waitForVerified({
      requestId,
      sellerPeerId: slice.target.peerId,
      advertisedService: slice.target.service,
    })
    if (evidence.status !== 'verified' || !evidence.responseAuth || !evidence.signedPreimages) {
      context.log(`batch ${batch.batchIndex} of ${targetKey(slice.target)}: no verified seller signature (${evidence.failureReason ?? evidence.status})`)
      continue
    }
    const record = evidence.responseAuth
    return {
      batchIndex: batch.batchIndex,
      requestId,
      responseAuth: {
        version: record.version,
        requestId: record.requestId,
        ...(record.channelId ? { channelId: record.channelId } : {}),
        buyerPeerId: record.buyerPeerId,
        sellerPeerId: record.sellerPeerId,
        advertisedService: record.advertisedService,
        provider: record.provider,
        statusCode: record.statusCode,
        requestHash: record.requestHash,
        responseHash: record.responseHash,
        responseStartedAt: record.responseStartedAt,
        responseCompletedAt: record.responseCompletedAt,
        signature: record.signature,
      },
      requestBase64: evidence.signedPreimages.requestBase64,
      responseBase64: evidence.signedPreimages.responseBase64,
    }
  }
  return null
}

function requestBody(
  slice: EnvelopeSliceV1,
  batch: EnvelopeSliceV1['batches'][number],
  options: { omitSampling: boolean; omitThinking: boolean },
): string {
  const chat = buildKbfChatRequestBody(slice.target.service, batch.probes, {
    maxTokens: slice.request.maxTokens,
    variantId: batch.promptVariantId,
  })
  const body: Record<string, unknown> = {
    ...chat,
    ...(!options.omitThinking && slice.request.assistantPrefill
      ? { messages: [...chat.messages, { role: 'assistant', content: slice.request.assistantPrefill }] }
      : {}),
    ...(options.omitThinking ? {} : slice.request.thinkingOverrides),
    temperature: 0,
    stream: false,
  }
  if (options.omitSampling) delete body['temperature']
  return JSON.stringify(body)
}
