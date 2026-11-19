import { createHash, createHmac } from 'node:crypto'
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
import { ConcurrencyLimiter } from './audit-concurrency.js'
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
  /**
   * The seed of this model audit and stage, derived from the auditor's private master for the epoch (`flipsSeed`):
   * publishing it reveals no other audit's pairs.
   */
  seed: string
  stage: FlipsStage
  /** Pairs chosen by hand for a dry run (`FlipsProbe`); such a check is a diagnostic and never counts. */
  pairs?: FlipsPair[]
}

/** The seed of one model audit and stage, from the auditor's private master for the epoch. */
export function flipsSeed(master: string, input: { model: string; epoch: string; runId: string; stage: FlipsStage }): string {
  return createHmac('sha256', master)
    .update(['antseed-flips-seed-v1', input.model.toLowerCase(), input.epoch, input.runId, input.stage].join('|'))
    .digest('hex')
}

/** The pairs of a draw: distinct pairs of the stage's pool, chosen by the hash of the draw; or its chosen pairs. */
export function drawFlipsPairs(draw: FlipsDrawV1, rule: FlipsRule = FLIPS_RULE): FlipsPair[] {
  if (draw.pairs) return draw.pairs.map((pair) => [pair[0], pair[1]] as FlipsPair)
  const pool = flipsPool(draw.stage)
  if (pool.length < rule.pairsPerCheck) throw new Error('the FLIPS word list has too few pairs')
  const seed = createHash('sha256')
    .update(['antseed-flips-pairs-v1', draw.auditor.toLowerCase(), draw.model.toLowerCase(), draw.epoch, draw.seed, draw.stage].join('|'))
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
  /** The answer shows reasoning: a count, reasoning fields, or a `<think>` block written into its text. */
  reasoning: boolean
  /** Its text holds a `<think>` block: reasoning written into the answer, which would be scored as symbols. */
  thinkBlock: boolean
  /** The reasoning tokens it itemises (0 when none). */
  reasoningTokens?: number
  failure: string | null
  /** The body this reply was asked with, as sent (JSON): every slot is compared with the sellers' body. */
  request: string
}

/** One pair of the reference: its replies in slot order, each with the body it was sent. */
export interface FlipsReferencePairV1 {
  words: FlipsPair
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
  /** Dry run only: the confirmation-stage sample on fresh pairs that followed a first flag. A diagnostic. */
  followUp?: FlipsV1
  /** No result because the seller reasons where the reference does not, with the reasoning token counts of both sides. */
  profileMismatch?: {
    code: 'seller-reasons'
    sellerReasoningTokens: number
    sellerReplies: number
    referenceReasoningTokens: number
    referenceReplies: number
  }
}

export interface FlipsSummary {
  rule: string
  /** The model it was drawn for: whether it counts is the rule's for this model. */
  model: string
  /** Chosen dry-run pairs: a diagnostic that never counts. */
  probe?: true
  stage: FlipsStage
  outcome: FlipsOutcome
  counted: boolean
  p: number | null
  score: number | null
  reason: string
}

/**
 * A request as the seller and the reference must share it: the whole body but for the model name, the provider pin and
 * `stream`, which the transport sets. An override, an omission, a prefill or a token floor all show here.
 */
function requestShape(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { model: _model, provider: _provider, stream: _stream, ...shape } = body as Record<string, unknown>
  return canonicalJsonStringify(shape)
}

const parseJson = (bytes: Uint8Array | string): unknown => {
  try {
    return JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

/**
 * The finish reason of an answer in the Chat Completions terms the calibration used: Chat's own `finish_reason`, an
 * Anthropic Messages `stop_reason`, or a Responses `status` with its `incomplete_details`. Null when it has none.
 */
export function finishReasonOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const body = answer as { choices?: Array<{ finish_reason?: unknown }>; stop_reason?: unknown; status?: unknown; incomplete_details?: { reason?: unknown } | null }
  const chat = body.choices?.[0]?.finish_reason
  if (typeof chat === 'string') return chat
  const stop = body.stop_reason
  if (typeof stop === 'string') {
    return stop === 'max_tokens' ? 'length' : stop === 'refusal' ? 'content_filter' : stop === 'end_turn' || stop === 'stop_sequence' ? 'stop' : stop
  }
  if (typeof body.status === 'string') {
    if (body.status === 'completed') return 'stop'
    const reason = body.incomplete_details?.reason
    return reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content_filter' : typeof reason === 'string' ? reason : body.status
  }
  return null
}

/**
 * The reply of one answer from its own bytes: its text and finish reason, whether it shows reasoning, and whether its
 * text holds a `<think>` block (a host that ignores the reasoning field can write the model's reasoning into the
 * answer). `content` is null when the answer has no readable text.
 */
export function readFlipsAnswer(
  requestBody: Uint8Array,
  response: { statusCode: number; body: Uint8Array } | null,
): { reply: FlipsReplyV1; reasoning: boolean; thinkBlock: boolean; reasoningTokens: number } {
  if (!response || response.statusCode !== 200) return { reply: { content: null, finishReason: null }, reasoning: false, thinkBlock: false, reasoningTokens: 0 }
  const reading = readOutput(requestBody, response)
  const finish = finishReasonOf(parseJson(response.body))
  const thinkBlock = typeof reading.text === 'string' && /<\/?think\b/i.test(reading.text)
  return {
    reply: { content: reading.text, finishReason: finish },
    reasoning: reading.reasoningMarker || thinkBlock,
    thinkBlock,
    reasoningTokens: reading.reasoningTokens ?? 0,
  }
}

/** A seller slot's answer, from the bytes the seller signed; null when it has no verified reply. */
function sellerAnswer(slot: FlipsSellerSlotV1): { reply: FlipsReplyV1; reasoning: boolean; thinkBlock: boolean; reasoningTokens: number; requestBody: unknown } | null {
  const exchange = signedExchange(slot.request)
  if (!exchange) return null
  return { ...readFlipsAnswer(exchange.requestBody, exchange.response), requestBody: parseJson(exchange.requestBody) }
}

/**
 * What makes a reference unusable, checked before any seller is asked: the pairs and their size, every reply read
 * (a failed or unreadable one leaves the pair short), no reasoning written into an answer, one proven provider across
 * both pairs (a named one, or a route pinned to one), and every slot asked exactly the sellers' body. Null when usable.
 */
export function flipsReferenceProblem(
  reference: { draw: FlipsDrawV1; service: string; referenceOneProvider: boolean; pairs: readonly FlipsReferencePairV1[] },
  rule: FlipsRule = FLIPS_RULE,
): string | null {
  if (reference.pairs.length !== rule.pairsPerCheck) return `${reference.pairs.length} word pairs, the rule asks ${rule.pairsPerCheck}`
  for (const pair of reference.pairs) {
    const label = `${pair.words[0]}/${pair.words[1]}`
    if (!isValidFlipsPair(pair.words)) return `the word pair ${label} cannot be read back`
    if (pair.replies.length !== rule.referenceRepliesPerPair) return `${label}: ${pair.replies.length} reference replies, the rule asks ${rule.referenceRepliesPerPair}`
    if (pair.replies.some((reply) => reply.content === null)) return `${label}: a reference reply could not be read`
    if (pair.replies.some((reply) => reply.thinkBlock === true)) return `${label}: a reference reply writes its reasoning into its answer`
    const expected = requestShape(flipsRequestBody(reference.draw.model, reference.service, pair.words, rule))
    if (pair.replies.some((reply) => requestShape(parseJson(reply.request)) !== expected)) return `${label}: the reference was not asked the sellers' request`
  }
  const providers = new Set(reference.pairs.flatMap((pair) => pair.replies.map((reply) => reply.provider)))
  if (providers.size > 1 || (!reference.referenceOneProvider && providers.has(null))) return 'the reference\'s replies do not come from one proven provider'
  return null
}

/** The judgement of a FLIPS check from what it stores: outcome, counting, score, p and why. Pure. */
export function judgeFlips(
  record: Pick<FlipsV1, 'draw' | 'service' | 'referenceOneProvider' | 'pairs'>,
  rule: FlipsRule = FLIPS_RULE,
): Pick<FlipsV1, 'outcome' | 'counted' | 'score' | 'scoreMax' | 'p' | 'reason' | 'profileMismatch'> {
  // A dry run's chosen pairs are a diagnostic: they never count.
  const counted = flipsCounts(record.draw.model, rule) && record.draw.pairs === undefined
  const none = (reason: string) => ({ outcome: 'inconclusive' as const, counted, score: null, scoreMax: null, p: null, reason })
  const stage = record.draw.stage
  const replies = rule.repliesPerPair[stage]
  if (record.pairs.length !== rule.pairsPerCheck) return none(`${record.pairs.length} word pairs, the rule asks ${rule.pairsPerCheck}`)
  const problem = flipsReferenceProblem({ draw: record.draw, service: record.service, referenceOneProvider: record.referenceOneProvider, pairs: record.pairs.map((pair) => pair.reference) }, rule)
  if (problem) return none(problem)
  const samples = []
  for (const pair of record.pairs) {
    const label = `${pair.words[0]}/${pair.words[1]}`
    if (pair.seller.length !== replies) return none(`${label}: ${pair.seller.length} seller slots, the stage asks ${replies}`)
    const expected = requestShape(flipsRequestBody(record.draw.model, record.service, pair.words, rule))
    const answers = pair.seller.map(sellerAnswer)
    if (answers.some((answer) => answer === null)) return none(`${label}: a scheduled slot has no reply`)
    // A signed answer with no readable text is never dropped from the sample: the check has no result.
    if (answers.some((answer) => answer!.reply.content === null)) return none(`${label}: a signed answer has no readable text`)
    if (answers.some((answer) => answer!.thinkBlock)) return none(`${label}: a seller answer writes its reasoning into its text`)
    if (answers.some((answer) => requestShape(answer!.requestBody) !== expected)) return none(`${label}: a seller request is not the reference's`)
    // The reasoning profile is the reference's, as a whole: a reference that reasons in some replies and not in others
    // is no profile, and a seller that reasons where the reference never does is another profile.
    const reasoningReplies = pair.reference.replies.filter((reply) => reply.reasoning).length
    if (reasoningReplies > 0 && reasoningReplies < pair.reference.replies.length) return none(`${label}: the reference reasons in some replies and not in others`)
    if (reasoningReplies === 0 && answers.some((answer) => answer!.reasoning)) {
      // Its own code with the counts of both sides: honest hosts that ignore the reasoning setting land here, and so do
      // swaps that reason where the claimed model does not; the dry run decides on those numbers whether it stays so.
      const sellerTokens = answers.reduce((total, answer) => total + answer!.reasoningTokens, 0)
      const referenceTokens = pair.reference.replies.reduce((total, reply) => total + (reply.reasoningTokens ?? 0), 0)
      return {
        ...none(`${label}: the seller reasons where the reference does not (${sellerTokens} reasoning tokens over ${answers.length} replies against ${referenceTokens} over ${pair.reference.replies.length}), so its request profile has no reference`),
        profileMismatch: { code: 'seller-reasons', sellerReasoningTokens: sellerTokens, sellerReplies: answers.length, referenceReasoningTokens: referenceTokens, referenceReplies: pair.reference.replies.length },
      }
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
  const outcome: FlipsOutcome = p <= rule.bar[stage] ? 'flag' : p > rule.passAbove ? 'pass' : 'inconclusive'
  const reason = outcome === 'flag'
    ? `scored ${judged.score.toFixed(2)} (p ${p.toExponential(2)}), at most the ${stage} bar ${rule.bar[stage]}`
    : outcome === 'pass'
      ? `scored ${judged.score.toFixed(2)} (p ${p.toFixed(3)}), above ${rule.passAbove}`
      : `scored ${judged.score.toFixed(2)} (p ${p.toFixed(4)}), between the bar and the pass`
  return { outcome, counted, score: judged.score, scoreMax: judged.scoreMax, p, reason }
}

export function summarizeFlips(record: FlipsV1): FlipsSummary {
  return {
    rule: record.rule, model: record.draw.model, ...(record.draw.pairs ? { probe: true as const } : {}), stage: record.draw.stage,
    outcome: record.outcome, counted: record.counted, p: record.p, score: record.score, reason: record.reason,
  }
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
  if (record.followUp) validateFlips(record.followUp)
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
        replies: results.map((result) => {
          const answer = readFlipsAnswer(result.requestBody, result.response)
          return {
            ...answer.reply, provider: result.provider, reasoning: answer.reasoning, thinkBlock: answer.thinkBlock, reasoningTokens: answer.reasoningTokens,
            failure: result.failure, request: decoder.decode(result.requestBody),
          }
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

/** How long one seller's FLIPS may take, its seller slots at a time, and the reference's own limit. */
export const FLIPS_TIME_LIMIT_MS = 5 * 60_000
export const FLIPS_SLOTS_AT_ONCE = 2
export const FLIPS_REFERENCE_TIME_LIMIT_MS = 10 * 60_000

/** Dry run only: chosen pairs, a stage for every check, and a fresh-pairs follow-up after each first flag. */
export interface FlipsProbe {
  pairs?: FlipsPair[]
  stage?: FlipsStage
  followUpFirstFlags?: boolean
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
  auditor: string
  epoch: string
  /** The seed of this model audit and a stage (`flipsSeed`). */
  seedFor: (stage: FlipsStage) => string
  proxyBaseUrl: string
  responseAuthReader: SignedSellerRequestInput['responseAuthReader']
  limiter: SignedSellerRequestInput['limiter']
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  ask: (settings: Settings) => (bodies: readonly Record<string, unknown>[], signal: AbortSignal) => ReturnType<Parameters<typeof prepareFlipsReference>[0]['ask']>
  rule?: FlipsRule
  probe?: FlipsProbe
  onReady?: (reference: FlipsReferenceV1) => void
  timeLimitMs?: number
  referenceTimeLimitMs?: number
}): FlipsScreen<Settings> {
  const rule = input.rule ?? FLIPS_RULE
  const references = new Map<FlipsStage, Promise<FlipsReferenceV1>>()
  const drawOf = (stage: FlipsStage): FlipsDrawV1 => ({
    auditor: input.auditor, model: input.model, epoch: input.epoch, seed: input.seedFor(stage), stage,
    ...(input.probe?.pairs ? { pairs: input.probe.pairs } : {}),
  })
  const referenceFor = (stage: FlipsStage, service: string, settings: Settings): Promise<FlipsReferenceV1> => {
    let reference = references.get(stage)
    if (!reference) {
      // The reference has its own time limit and is cancelled at it: it never holds a lane past it.
      const signal = AbortSignal.timeout(input.referenceTimeLimitMs ?? FLIPS_REFERENCE_TIME_LIMIT_MS)
      reference = prepareFlipsReference({
        model: input.model, service, stage, pairs: drawFlipsPairs(drawOf(stage), rule),
        ask: (bodies) => input.ask(settings)(bodies, signal), rule,
      }).then((prepared) => {
        input.onReady?.(prepared)
        return prepared
      })
      references.set(stage, reference)
    }
    return reference
  }
  // At most this many of one seller's slots are out at once, within the run's own limit.
  const sellerLimiter = (): SignedSellerRequestInput['limiter'] => {
    const own = new ConcurrencyLimiter(FLIPS_SLOTS_AT_ONCE)
    return { run: (task) => own.run(() => input.limiter.run(task)) } as SignedSellerRequestInput['limiter']
  }
  const one = async (seller: Parameters<FlipsScreen<Settings>['check']>[0], settings: Settings, stage: FlipsStage, options: Parameters<FlipsScreen<Settings>['check']>[2]): Promise<FlipsV1> => {
    const draw = drawOf(stage)
    const prepared = await referenceFor(stage, seller.service, settings)
    const problem = flipsReferenceProblem({ draw, service: seller.service, referenceOneProvider: prepared.oneProvider, pairs: prepared.pairs }, rule)
    const stored = {
      rule: rule.id, draw, service: seller.service, referenceUpstream: prepared.upstream, referenceOneProvider: prepared.oneProvider,
    }
    if (problem) {
      // The reference is checked before the seller is asked: an unusable one costs the seller nothing.
      const pairs = prepared.pairs.map((reference) => ({ words: reference.words, reference, seller: [] }))
      return { ...stored, pairs, reasks: 0, ...judgeFlips({ ...stored, pairs }, rule), reason: problem }
    }
    // FLIPS has its own time: when it runs out, the earlier tests stand and FLIPS has no result.
    const timeLimit = AbortSignal.timeout(input.timeLimitMs ?? FLIPS_TIME_LIMIT_MS)
    return runFlips({
      seller: {
        proxyBaseUrl: input.proxyBaseUrl,
        responseAuthReader: input.responseAuthReader,
        limiter: sellerLimiter(),
        peerId: seller.peerId,
        service: seller.service,
        serviceAliases: seller.serviceAliases ?? [],
        ...(input.requestTimeoutMs ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
        ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        signal: options.signal ? AbortSignal.any([options.signal, timeLimit]) : timeLimit,
      },
      draw,
      reference: prepared,
      rule,
    })
  }
  return {
    async check(seller, settings, options) {
      const stage = input.probe?.stage ?? options.stage
      try {
        const record = await one(seller, settings, stage, options)
        // Dry run: a first flag is followed at once by a confirmation-size sample on fresh pairs, read by hand.
        if (input.probe?.followUpFirstFlags && stage === 'first' && record.outcome === 'flag') {
          return { ...record, followUp: await one(seller, settings, 'confirm', options) }
        }
        return record
      } catch (error) {
        // While FLIPS does not count, a failure of it is no diagnostic, never an aborted audit.
        if (!flipsCounts(input.model, rule)) return null
        throw error
      }
    },
  }
}
