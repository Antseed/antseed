import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import {
  FLIPS_RULE,
  flipsCounts,
  flipsRequestBody,
  flipsRuleById,
  isValidFlipsPair,
  judgeFlipsCheck,
  type FlipsPair,
  type FlipsReplyV1,
  type FlipsRule,
} from './flips-score.js'
import { readOutput } from './output-usage.js'
import { costOfRequests, requestCountOf, type AuditCostSummaryV1, type PaidRequest } from './proxy-evidence.js'
import {
  askSellerSigned,
  signedExchange,
  type SignedSellerRequestInput,
  type SignedSellerRequestV1,
} from './signed-seller-request.js'

/**
 * FLIPS in the audit (`flips-score.ts` scores it): two word pairs, each asked of the seller `repliesPerPair` times and of
 * the reference 40 times with the same body, scored and judged against the stage's bar.
 *
 * - The pairs come from a word list written for the audit. A first audit draws from one pool and a confirmation of a
 *   FLIPS flag from the other, so a confirmation's pairs are never a first audit's, whoever ran it. The seed is the
 *   auditor, the model, the epoch and a random salt the auditor keeps for the epoch (published with its evidence), so
 *   a seller cannot compute the pairs in advance.
 * - The seller and the reference get the same body, the eval's for the model (`FLIPS_REQUESTS`). The reference is
 *   asked once per model, stage and run, shortly before its sellers, as in the eval.
 * - A slot with no reply at all (no answer, no ResponseAuth) is asked again within a budget; an empty, filtered or short
 *   reply is never asked again: it counts as the rule says. A check with a slot still unanswered, a reference pair from
 *   more than one provider, a reference request the route changed, or a seller that thinks where the reference does
 *   not, has no result.
 */

/**
 * The words of the pairs: lower-case, letters only, read back by the parser. New for the audit: only the eval's own
 * pairs were measured on honest sellers, so this list is measured in the dry run before FLIPS counts.
 */
export const FLIPS_WORDS: readonly string[] = Object.freeze([
  'amber', 'basin', 'cobalt', 'dune', 'ember', 'fjord', 'garnet', 'harbor',
  'iris', 'juniper', 'kettle', 'lantern', 'meadow', 'nickel', 'orchid', 'pebble',
  'quartz', 'raven', 'saddle', 'timber', 'umber', 'velvet', 'willow', 'yarrow',
  'acorn', 'bramble', 'cinder', 'dapple', 'falcon', 'glacier', 'hazel', 'marble',
])

/** The word pairs of a pool: consecutive words of the list; pool `first` the even pairs, pool `confirm` the odd ones. */
export function flipsPool(stage: FlipsStage): FlipsPair[] {
  const pairs: FlipsPair[] = []
  for (let index = 0; index + 1 < FLIPS_WORDS.length; index += 2) pairs.push([FLIPS_WORDS[index]!, FLIPS_WORDS[index + 1]!])
  return pairs.filter((_pair, index) => (index % 2 === 0) === (stage === 'first'))
}

export type FlipsStage = 'first' | 'confirm'

/** What the pairs of an audit are drawn from; stored in its record, so any reader draws them again. */
export interface FlipsDrawV1 {
  auditor: string
  model: string
  epoch: string
  /** 32 random bytes in hex the auditor keeps for the epoch. */
  salt: string
  stage: FlipsStage
}

/** The pairs of a draw: distinct pairs of the stage's pool, chosen by the hash of the draw. */
export function drawFlipsPairs(draw: FlipsDrawV1, rule: FlipsRule = FLIPS_RULE): FlipsPair[] {
  const pool = flipsPool(draw.stage)
  if (pool.length < rule.pairsPerCheck) throw new Error('the FLIPS word list has too few pairs')
  const seed = createHash('sha256')
    .update(['antseed-flips-pairs-v1', draw.auditor.toLowerCase(), draw.model.toLowerCase(), draw.epoch, draw.salt, draw.stage].join('|'))
    .digest()
  const remaining = [...pool]
  const chosen: FlipsPair[] = []
  for (let index = 0; chosen.length < rule.pairsPerCheck; index += 1) {
    const pick = seed.readUInt32BE((index * 4) % 28) % remaining.length
    chosen.push(remaining.splice(pick, 1)[0]!)
  }
  return chosen
}

/** One reference reply, as the reference endpoint answered. */
export interface FlipsReferenceReplyV1 {
  content: string | null
  finishReason: string | null
  /** The provider the answer names; null when it names none. */
  provider: string | null
  /** The answer shows reasoning. */
  reasoning: boolean
  failure: string | null
}

/** One pair of the reference: the body it was sent (as the route sent it) and its replies in slot order. */
export interface FlipsReferencePairV1 {
  words: FlipsPair
  /** The body of the pair's requests as sent, JSON. */
  request: string
  replies: FlipsReferenceReplyV1[]
}

/** The reference of one model, stage and run. */
export interface FlipsReferenceV1 {
  stage: FlipsStage
  upstream: unknown
  /** The route serves one provider (pinned), so unnamed answers are one provider's. */
  oneProvider: boolean
  pairs: FlipsReferencePairV1[]
}

/** One scheduled slot of the seller: its signed request, or null when it never got a reply within the budget. */
export interface FlipsSellerSlotV1 {
  request: SignedSellerRequestV1
}

export interface FlipsPairV1 {
  words: FlipsPair
  reference: FlipsReferencePairV1
  seller: FlipsSellerSlotV1[]
}

export type FlipsOutcome = 'flag' | 'pass' | 'inconclusive'

/** A seller's FLIPS, as stored in its audit evidence. */
export interface FlipsV1 {
  rule: string
  draw: FlipsDrawV1
  /** The service the seller was asked as. */
  service: string
  referenceUpstream: unknown
  referenceOneProvider: boolean
  pairs: FlipsPairV1[]
  /** Slots asked again because they got no reply at all. */
  reasks: number
  /** The judged outcome: a flag at p at most the stage's bar, a pass at p at least `passAbove`. */
  outcome: FlipsOutcome
  /** Whether it counts toward the verdict (`flipsCounts`); recorded only otherwise. */
  counted: boolean
  score: number | null
  scoreMax: number | null
  p: number | null
  reason: string
}

export interface FlipsSummary {
  rule: string
  stage: FlipsStage
  outcome: FlipsOutcome
  counted: boolean
  p: number | null
  score: number | null
  reason: string
}

/** The fields of a request that must be the same for the seller and the reference. */
function requestShape(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  return canonicalJsonStringify({
    messages: record['messages'] ?? null,
    max_tokens: record['max_tokens'] ?? null,
    temperature: record['temperature'] ?? null,
    reasoning: record['reasoning'] ?? null,
    top_p: record['top_p'] ?? null,
  })
}

const parseJson = (bytes: Uint8Array | string): unknown => {
  try {
    return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/** The reply of one answer from its own bytes: its text and finish reason, and whether it shows reasoning. */
export function readFlipsAnswer(
  requestBody: Uint8Array,
  response: { statusCode: number; body: Uint8Array } | null,
): { reply: FlipsReplyV1; reasoning: boolean } {
  if (!response || response.statusCode !== 200) return { reply: { content: null, finishReason: null }, reasoning: false }
  const reading = readOutput(requestBody, response)
  const parsed = parseJson(response.body) as { choices?: Array<{ finish_reason?: unknown }> } | null
  const finish = parsed?.choices?.[0]?.finish_reason
  return {
    reply: { content: reading.text, finishReason: typeof finish === 'string' ? finish : null },
    reasoning: reading.reasoningMarker,
  }
}

/** A seller slot's answer, from the bytes the seller signed; null when it has no verified reply. */
function sellerAnswer(slot: FlipsSellerSlotV1): { reply: FlipsReplyV1; reasoning: boolean; requestBody: unknown } | null {
  const exchange = signedExchange(slot.request)
  if (!exchange) return null
  return { ...readFlipsAnswer(exchange.requestBody, exchange.response), requestBody: parseJson(exchange.requestBody) }
}

/** The judgement of a FLIPS check from what it stores: outcome, counting, score, p and why. Pure. */
export function judgeFlips(
  record: Pick<FlipsV1, 'draw' | 'service' | 'referenceOneProvider' | 'pairs'>,
  rule: FlipsRule = FLIPS_RULE,
): Pick<FlipsV1, 'outcome' | 'counted' | 'score' | 'scoreMax' | 'p' | 'reason'> {
  const counted = flipsCounts(record.draw.model, rule)
  const none = (reason: string) => ({ outcome: 'inconclusive' as const, counted, score: null, scoreMax: null, p: null, reason })
  const stage = record.draw.stage
  const replies = rule.repliesPerPair[stage]
  if (record.pairs.length !== rule.pairsPerCheck) return none(`${record.pairs.length} word pairs, the rule asks ${rule.pairsPerCheck}`)
  const samples = []
  for (const pair of record.pairs) {
    const label = `${pair.words[0]}/${pair.words[1]}`
    if (!isValidFlipsPair(pair.words)) return none(`the word pair ${label} cannot be read back`)
    if (pair.seller.length !== replies) return none(`${label}: ${pair.seller.length} seller slots, the stage asks ${replies}`)
    if (pair.reference.replies.length !== rule.referenceRepliesPerPair) {
      return none(`${label}: ${pair.reference.replies.length} reference replies, the rule asks ${rule.referenceRepliesPerPair}`)
    }
    const providers = new Set(pair.reference.replies.map((reply) => reply.provider))
    if (providers.size > 1 || (!record.referenceOneProvider && providers.has(null))) {
      return none(`${label}: the reference's replies do not come from one provider`)
    }
    const expected = requestShape(flipsRequestBody(record.draw.model, record.service, pair.words, rule))
    if (requestShape(parseJson(pair.reference.request)) !== expected) return none(`${label}: the reference route changed the request`)
    const answers = pair.seller.map(sellerAnswer)
    if (answers.some((answer) => answer === null)) return none(`${label}: a scheduled slot has no reply`)
    if (answers.some((answer) => requestShape(answer!.requestBody) !== expected)) return none(`${label}: a seller request is not the reference's`)
    const referenceThinks = pair.reference.replies.some((reply) => reply.reasoning)
    if (!referenceThinks && answers.some((answer) => answer!.reasoning)) {
      return none(`${label}: the seller reasons where the reference does not, so its request profile has no reference`)
    }
    samples.push({
      pair: pair.words,
      reference: pair.reference.replies.map((reply) => ({ content: reply.content, finishReason: reply.finishReason })),
      seller: answers.map((answer) => answer!.reply),
    })
  }
  const judged = judgeFlipsCheck(samples, rule)
  if (judged.outcome !== 'scored' || judged.p === null || judged.score === null) return none(judged.reasons.join('; ') || 'no score')
  const p = judged.p
  const outcome: FlipsOutcome = p <= rule.bar[stage] ? 'flag' : p >= rule.passAbove ? 'pass' : 'inconclusive'
  const reason = outcome === 'flag'
    ? `scored ${judged.score.toFixed(2)} (p ${p.toExponential(2)}), at most the ${stage} bar ${rule.bar[stage]}`
    : outcome === 'pass'
      ? `scored ${judged.score.toFixed(2)} (p ${p.toFixed(3)}), at least ${rule.passAbove}`
      : `scored ${judged.score.toFixed(2)} (p ${p.toFixed(4)}), between the bar and the pass`
  return { outcome, counted, score: judged.score, scoreMax: judged.scoreMax, p, reason }
}

export function summarizeFlips(record: FlipsV1): FlipsSummary {
  return { rule: record.rule, stage: record.draw.stage, outcome: record.outcome, counted: record.counted, p: record.p, score: record.score, reason: record.reason }
}

/** A FLIPS flag in plain words, for the verdict reason. */
export function describeFlipsFlag(record: Pick<FlipsV1, 'rule' | 'reason'>): string {
  return `randomness check (${record.rule}): ${record.reason}`
}

/** Every seller request FLIPS paid for, in slot order. */
export function flipsPaidRequests(record: FlipsV1): PaidRequest[] {
  return record.pairs.flatMap((pair) => pair.seller.map((slot) => ({ requestCount: slot.request.requestIds.length, attemptCosts: slot.request.attemptCosts })))
}

export function flipsCost(record: FlipsV1): AuditCostSummaryV1 {
  return costOfRequests(flipsPaidRequests(record))
}

export function flipsRequestCount(record: FlipsV1): number {
  return requestCountOf(flipsPaidRequests(record))
}

/**
 * Recomputes a stored FLIPS check: its rule is known, its pairs are its draw's, every request ID is used once, and its
 * judgement follows from the stored replies (the seller's re-read from the bytes it signed). Throws.
 */
export function validateFlips(record: FlipsV1): void {
  const rule = flipsRuleById(record.rule)
  if (!rule) throw new Error(`unknown FLIPS rule ${record.rule}`)
  const drawn = drawFlipsPairs(record.draw, rule)
  if (canonicalJsonStringify(drawn) !== canonicalJsonStringify(record.pairs.map((pair) => pair.words))) {
    throw new Error('the FLIPS pairs are not the ones its draw gives')
  }
  if (record.pairs.some((pair) => canonicalJsonStringify(pair.reference.words) !== canonicalJsonStringify(pair.words))) {
    throw new Error('a FLIPS reference pair is not the pair it is stored with')
  }
  const ids = new Set<string>()
  for (const pair of record.pairs) {
    for (const slot of pair.seller) {
      for (const id of slot.request.requestIds) {
        if (ids.has(id)) throw new Error('a FLIPS request is counted more than once')
        ids.add(id)
      }
    }
  }
  const again = judgeFlips(record, rule)
  if (again.outcome !== record.outcome || again.counted !== record.counted) throw new Error('the FLIPS outcome does not follow from its replies')
  const close = (left: number | null, right: number | null): boolean => (
    left === right || (left !== null && right !== null && Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left)))
  )
  if (!close(again.score, record.score) || !close(again.p, record.p) || !close(again.scoreMax, record.scoreMax)) {
    throw new Error('the FLIPS score does not follow from its replies')
  }
}

/** Asks the reference the pairs of a stage: `referenceRepliesPerPair` replies per pair, each with the sellers' body. */
export async function prepareFlipsReference(input: {
  model: string
  service: string
  stage: FlipsStage
  pairs: readonly FlipsPair[]
  ask: (bodies: readonly Record<string, unknown>[]) => Promise<{
    upstream: unknown
    oneProvider: boolean
    results: Array<{ requestBody: Uint8Array; response: { statusCode: number; body: Uint8Array } | null; provider: string | null; failure: string | null }>
  }>
  rule?: FlipsRule
}): Promise<FlipsReferenceV1> {
  const rule = input.rule ?? FLIPS_RULE
  const bodies = input.pairs.flatMap((pair) => Array.from({ length: rule.referenceRepliesPerPair }, () => flipsRequestBody(input.model, input.service, pair, rule)))
  const asked = await input.ask(bodies)
  const decoder = new TextDecoder()
  return {
    stage: input.stage,
    upstream: asked.upstream,
    oneProvider: asked.oneProvider,
    pairs: input.pairs.map((pair, pairIndex) => {
      const results = asked.results.slice(pairIndex * rule.referenceRepliesPerPair, (pairIndex + 1) * rule.referenceRepliesPerPair)
      return {
        words: pair,
        request: results[0] ? decoder.decode(results[0].requestBody) : '',
        replies: results.map((result) => {
          const answer = readFlipsAnswer(result.requestBody, result.response)
          return { ...answer.reply, provider: result.provider, reasoning: answer.reasoning, failure: result.failure }
        }),
      }
    }),
  }
}

/** Slots asked again in one check, at most: only slots that got no reply at all. */
export const FLIPS_REASK_BUDGET = 4

/** One seller's FLIPS on a prepared reference. Never rejects. */
export async function runFlips(input: {
  seller: Omit<SignedSellerRequestInput, 'peerId' | 'service' | 'serviceAliases'> & { peerId: string; service: string; serviceAliases?: readonly string[] }
  draw: FlipsDrawV1
  reference: FlipsReferenceV1
  rule?: FlipsRule
}): Promise<FlipsV1> {
  const rule = input.rule ?? FLIPS_RULE
  const replies = rule.repliesPerPair[input.draw.stage]
  const ask = (pair: FlipsPair) => askSellerSigned(
    { ...input.seller, serviceAliases: input.seller.serviceAliases ?? [] } as SignedSellerRequestInput,
    flipsRequestBody(input.draw.model, input.seller.service, pair, rule),
  )
  const answered = (request: SignedSellerRequestV1): boolean => signedExchange(request) !== null
  const pairs: FlipsPairV1[] = await Promise.all(input.reference.pairs.map(async (reference) => ({
    words: reference.words,
    reference,
    seller: await Promise.all(Array.from({ length: replies }, async () => ({ request: await ask(reference.words) }))),
  })))
  let reasks = 0
  for (const pair of pairs) {
    for (const slot of pair.seller) {
      while (!answered(slot.request) && reasks < FLIPS_REASK_BUDGET && !input.seller.signal?.aborted) {
        reasks += 1
        const again = await ask(pair.words)
        // The tries of a slot are paid for and counted, so they stay with it.
        slot.request = {
          ...again,
          requestIds: [...slot.request.requestIds, ...again.requestIds],
          attemptCosts: [...slot.request.attemptCosts, ...again.attemptCosts],
        }
      }
    }
  }
  const stored = {
    rule: rule.id,
    draw: input.draw,
    service: input.seller.service,
    referenceUpstream: input.reference.upstream,
    referenceOneProvider: input.reference.oneProvider,
    pairs,
    reasks,
  }
  return { ...stored, ...judgeFlips(stored, rule) }
}

/** The FLIPS of one model's sellers in one run: the reference once per stage, then each seller. */
export interface FlipsScreen<Settings> {
  check: (
    seller: { peerId: string; service: string; serviceAliases?: readonly string[] },
    settings: Settings,
    options: { stage: FlipsStage; clock?: SignedSellerRequestInput['clock']; signal?: AbortSignal },
  ) => Promise<FlipsV1 | null>
}

export function createFlipsScreen<Settings>(input: {
  model: string
  /** The draw of the run: the auditor, the epoch and the epoch's salt. */
  auditor: string
  epoch: string
  salt: string
  proxyBaseUrl: string
  responseAuthReader: SignedSellerRequestInput['responseAuthReader']
  limiter: SignedSellerRequestInput['limiter']
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  ask: (settings: Settings) => (bodies: readonly Record<string, unknown>[]) => ReturnType<Parameters<typeof prepareFlipsReference>[0]['ask']>
  rule?: FlipsRule
  onReady?: (reference: FlipsReferenceV1) => void
}): FlipsScreen<Settings> {
  const rule = input.rule ?? FLIPS_RULE
  const references = new Map<FlipsStage, Promise<FlipsReferenceV1>>()
  const drawOf = (stage: FlipsStage): FlipsDrawV1 => ({ auditor: input.auditor, model: input.model, epoch: input.epoch, salt: input.salt, stage })
  return {
    async check(seller, settings, options) {
      let reference = references.get(options.stage)
      if (!reference) {
        const draw = drawOf(options.stage)
        reference = prepareFlipsReference({
          model: input.model, service: seller.service, stage: options.stage, pairs: drawFlipsPairs(draw, rule), ask: input.ask(settings), rule,
        }).then((prepared) => {
          input.onReady?.(prepared)
          return prepared
        })
        references.set(options.stage, reference)
      }
      let prepared: FlipsReferenceV1
      try {
        prepared = await reference
      } catch {
        return null
      }
      return runFlips({
        seller: {
          proxyBaseUrl: input.proxyBaseUrl,
          responseAuthReader: input.responseAuthReader,
          limiter: input.limiter,
          peerId: seller.peerId,
          service: seller.service,
          serviceAliases: seller.serviceAliases ?? [],
          ...(input.requestTimeoutMs ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
          ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
          ...(options.clock ? { clock: options.clock } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
        draw: drawOf(options.stage),
        reference: prepared,
        rule,
      })
    },
  }
}
