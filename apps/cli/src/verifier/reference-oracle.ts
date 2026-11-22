import type { KbfReferenceV1 } from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  askReferenceInputTokens,
  askReferenceReplies,
  type ReferenceInputTokensV1,
  type ReferenceRequestLimiter,
  type ReferenceUpstreamProvenanceV1,
} from './model-reference.js'
import type { VerifierModelCatalog } from './openrouter-catalog.js'

/**
 * The reference of a seller audit's tests: the audited model itself, asked by the auditor. A test asks it through this
 * interface and never learns where the model is hosted, so that another way of reaching the model (a seller whose
 * hosting is attested, or two references asked side by side) is another implementation and no change to a test.
 *
 * What every implementation guarantees:
 *
 * - **A bank is asked only where it was enrolled.** `bank` is a reference of the audit's question set. Its questions
 *   were answered by one source, and a test's reference is the model as that source serves it. An ask that would reach
 *   another source rejects before any request is sent: an answer from elsewhere is not that bank's reference.
 * - **It never rejects for one request.** Each ask gets one result, in the order asked. A request that failed, after
 *   the implementation's own tries, is a result with its `failure` and no answer. An ask rejects only when the
 *   reference cannot be asked at all (it is not configured, or the rule above).
 * - **`oneProvider`**: the route serves one host of the model, as far as its settings say (it is pinned to one, or it
 *   is not a router), so answers that name no provider can be read as one host's. False when it may serve several.
 * - **`provenOneProvider`**: that is known, not only set: the route is one that cannot hand the request to another host
 *   (`bankRouteOracle` says which routes are). False for an endpoint that may itself be a router. A test that vouches
 *   for answers that name no provider reads this one.
 * - **`upstream`** says where the answers came from, as a test stores it beside them. It never holds a key.
 * - **`limiter`** is where every request of the ask waits for its turn: asks given the same limiter share its cap.
 * - **`signal`**: once aborted, no request is sent or tried again, and an ask still out ends with failed results.
 */
export interface ReferenceOracle {
  /**
   * The input tokens the reference counts for each of `contents`, each sent as the only user message. The answer's
   * text is not used. `maxTokens` is the reply limit of each request; a route that needs a larger budget to answer at
   * all keeps its own.
   */
  inputTokens(
    bank: KbfReferenceV1,
    contents: readonly string[],
    options: ReferenceAskOptions & { maxTokens: number },
  ): Promise<{ upstream: ReferenceUpstreamProvenanceV1; oneProvider: boolean; results: ReferenceInputTokensV1[] }>
  /** The reference's own reply to each ask, as raw bytes with the request sent, read by the test exactly as it reads a seller's. */
  replies(
    bank: KbfReferenceV1,
    asks: ReferenceReplyAsks,
    options: ReferenceAskOptions,
  ): Promise<{ upstream: ReferenceUpstreamProvenanceV1; oneProvider: boolean; provenOneProvider: boolean; results: ReferenceReply[] }>
}

export interface ReferenceAskOptions {
  limiter: ReferenceRequestLimiter
  signal?: AbortSignal
}

/** What the reference is asked to reply to. */
export type ReferenceReplyAsks =
  /**
   * One request for each entry, the entry its only user message, with the request settings the bank recorded and this
   * reply limit (a route that needs a larger budget to answer at all keeps its own).
   */
  | { contents: readonly string[]; maxTokens: number }
  /**
   * One request for each entry, the entry its whole body, sent as it is: the route adds only what makes it this
   * reference (its model, transport and provider pin) and none of the bank's request settings, so a seller can be sent
   * the very same body. An answer that reports no usage is still an answer here: its bytes are read, never its billing.
   */
  | { bodies: readonly Record<string, unknown>[] }

/** One reply of the reference. */
export interface ReferenceReply {
  /** What was sent on the wire. */
  requestBody: Uint8Array
  /** What was asked: the body as the route made it, before a protocol's own rewrite. */
  askedBody: Uint8Array
  /** The answer's status and bytes; null when the request failed. */
  response: { statusCode: number; body: Uint8Array } | null
  /** The provider the answer names; null when it names none. */
  provider: string | null
  failure: string | null
  /** Requests sent for this reply, and how many were answered with a rate limit. */
  tries: number
  rateLimited: number
}

/**
 * The reference as the tests have always asked it: the model on the route its question bank was enrolled on (the
 * configured reference endpoint or the model's own upstream, pinned to the provider that answered the enrollment), by
 * `askReferenceInputTokens` and `askReferenceReplies`. Its route is proven to serve one provider when it is a pinned
 * Antseed peer or OpenRouter pinned to one provider.
 */
export function bankRouteOracle(input: {
  model: string
  config: VerifierCLIConfig | undefined
  /** The reference endpoint's model catalog, read for every ask (the loader shares one download). */
  catalog: () => Promise<VerifierModelCatalog | null>
  buyerProxyPort?: number
}): ReferenceOracle {
  return {
    inputTokens: async (bank, contents, options) => askReferenceInputTokens({
      model: input.model,
      settings: bank,
      contents,
      ...(options.signal ? { signal: options.signal } : {}),
      maxTokens: options.maxTokens,
      config: input.config,
      catalog: await input.catalog(),
      buyerProxyPort: input.buyerProxyPort,
      requestLimiter: options.limiter,
    }),
    replies: async (bank, asks, options) => askReferenceReplies({
      model: input.model,
      settings: bank,
      // Whole bodies go on the plain route, each carrying its own reply limit.
      ...('bodies' in asks ? { contents: [], bodies: asks.bodies, plainRoute: true } : { contents: asks.contents }),
      ...(options.signal ? { signal: options.signal } : {}),
      maxTokens: 'bodies' in asks ? 0 : asks.maxTokens,
      config: input.config,
      catalog: await input.catalog(),
      buyerProxyPort: input.buyerProxyPort,
      requestLimiter: options.limiter,
    }),
  }
}
