import { randomUUID } from 'node:crypto'
import type { KbfModel } from '@antseed/node/payments'
import {
  isKbfSamplingFieldRejection,
  isKbfThinkingSuppressionRejection,
} from '@antseed/fingerprints'
import { buildKbfAuditChatBody } from '../kbf-audit-request.js'
import type { ResponseAuthReader } from '../response-auth-reader.js'
import type { CollectedSliceV1, EnvelopeSliceV1, RoundTargetV1, SliceExchangeV1 } from './types.js'
import { targetKey } from './types.js'

const BATCH_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 180_000

export interface CollectorContext {
  /** Buyer proxy base URL, e.g. http://127.0.0.1:8377. */
  buyerUrl: string
  responseAuth: ResponseAuthReader
  log: (message: string) => void
  fetchImpl?: typeof fetch
  /**
   * The targets this collector may pay for now, by its own audit policy (current prices against
   * its audit caps): checked before every phase's purchases, never taken from the publisher.
   */
  affordable: (targets: RoundTargetV1[], models: KbfModel[]) => Promise<RoundTargetV1[]>
}

/** Resume and deadline hooks for `collectSlice`. */
export interface CollectSliceOptions {
  /** Batches already bought (null: tried and failed), e.g. from a checkpoint; never bought again. */
  done?: ReadonlyMap<number, SliceExchangeV1 | null>
  /** Called after each batch is bought, before the next one starts, to checkpoint it. */
  onBatch?: (batchIndex: number, exchange: SliceExchangeV1 | null) => Promise<void>
  /**
   * Called before every outbound request, retries included: false stops buying (the phase is
   * about to end or the request budget is spent). It must count the request durably before
   * returning true, since a seller may charge for a request whose signed response never arrives.
   */
  beforeRequest?: () => Promise<boolean>
}

/**
 * Buys one slice from its seller through the buyer proxy, pinned to that seller, and keeps the
 * seller-signed record of every batch. A batch is retried only when there is no usable signed
 * response (transport error, non-200, missing signature); the first signed 200 is kept, so a
 * collector never picks among several answers.
 */
export async function collectSlice(
  slice: EnvelopeSliceV1,
  context: CollectorContext,
  options: CollectSliceOptions = {},
): Promise<CollectedSliceV1> {
  const exchanges: SliceExchangeV1[] = []
  for (const batch of slice.batches) {
    if (options.done?.has(batch.batchIndex)) {
      const previous = options.done.get(batch.batchIndex)
      if (previous) exchanges.push(previous)
      continue
    }
    const exchange = await collectBatch(slice, batch, context, options.beforeRequest)
    // Stopped before the batch got a signed answer: leave it unrecorded, so a later pass may retry it.
    if (exchange === STOPPED) break
    await options.onBatch?.(batch.batchIndex, exchange)
    if (exchange) exchanges.push(exchange)
  }
  return { targetKey: targetKey(slice.target), sliceIndex: slice.sliceIndex, exchanges }
}

const STOPPED = Symbol('stopped')

async function collectBatch(
  slice: EnvelopeSliceV1,
  batch: EnvelopeSliceV1['batches'][number],
  context: CollectorContext,
  beforeRequest: (() => Promise<boolean>) | undefined,
): Promise<SliceExchangeV1 | null | typeof STOPPED> {
  const fetchImpl = context.fetchImpl ?? fetch
  let omitSampling = false
  let omitThinking = false
  for (let attempt = 1; attempt <= BATCH_ATTEMPTS; attempt++) {
    if (beforeRequest && !await beforeRequest()) return STOPPED
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
      // Adapting the request format is not an attempt at an answer: each adaptation happens once,
      // and the batch still gets all its attempts afterwards.
      if (!omitSampling && isKbfSamplingFieldRejection(status, errorText)) { omitSampling = true; attempt--; continue }
      if (!omitThinking && isKbfThinkingSuppressionRejection(status, errorText)) { omitThinking = true; attempt--; continue }
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
  return JSON.stringify(buildKbfAuditChatBody(slice.target.service, batch.probes, {
    maxTokens: slice.request.maxTokens,
    promptVariantId: batch.promptVariantId,
    temperature: 0,
    thinking: options.omitThinking
      ? null
      : { overrides: slice.request.thinkingOverrides, assistantPrefill: slice.request.assistantPrefill },
    omitSampling: options.omitSampling,
  }))
}
