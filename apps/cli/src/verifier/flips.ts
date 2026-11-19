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
import { readAnswerText } from './output-usage.js'
import { costOfRequests, requestCountOf, type AuditCostSummaryV1, type PaidRequest } from './proxy-evidence.js'
import {
  SIGNED_REQUEST_TRIES,
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
  /** Pairs chosen by hand for a dry run (`FlipsProbe`). */
  pairs?: FlipsPair[]
  /** Asked by a dry-run probe (chosen pairs, a forced stage or a follow-up): a diagnostic that never counts. */
  probe?: true
  /** Pairs the draw leaves out: a follow-up draws none of its first check's pairs. */
  excluding?: FlipsPair[]
}

/** A route that names no provider and is not proven to serve one: FLIPS cannot score on it at all. */
export const FLIPS_ROUTE_NOT_SUPPORTED = 'not supported on this route: the reference route names no provider and is not proven to serve one, so its replies do not come from one proven provider'

/** Whether a draw was made by a dry-run probe: such a check never counts, whatever the rule. */
export function isProbeDraw(draw: Pick<FlipsDrawV1, 'pairs' | 'probe'>): boolean {
  return draw.probe === true || draw.pairs !== undefined
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
  const left = new Set((draw.excluding ?? []).map((pair) => [...pair].sort().join('/')))
  const pool = flipsPool(draw.stage).filter((pair) => !left.has([...pair].sort().join('/')))
  if (pool.length < rule.pairsPerCheck) throw new Error('the FLIPS word list has too few pairs')
  const seed = createHash('sha256')
    .update(['antseed-flips-pairs-v1', draw.auditor.toLowerCase(), draw.model.toLowerCase(), draw.epoch, draw.seed, draw.stage,
      ...(draw.excluding ? [left.size ? [...left].sort().join(',') : ''] : [])].join('|'))
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
  /** Requests the reference was sent for this reply, and how many of them were answered with a rate limit. */
  tries?: number
  rateLimited?: number
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
  /**
   * The bounds of the one reference call that asked every pair of this model and stage, on the auditor's clock (ms):
   * its first request and its last answer (the same on every pair). For a report of the reference's age; no judgement
   * reads it. Absent on records written before it, or when the clock gave no valid bounds.
   */
  referenceBatch?: { startedAt: number; finishedAt: number }
}

/** The reference of one model, stage and run. */
export interface FlipsReferenceV1 {
  stage: FlipsStage
  upstream: unknown
  /** The route serves one provider (pinned), so unnamed answers are one provider's. */
  oneProvider: boolean
  pairs: FlipsReferencePairV1[]
  /** How the reference was asked: requests sent counting tries, rate-limit answers among them, and seconds taken. */
  asked?: { tries: number; rateLimited: number; seconds: number }
}

/** One scheduled slot of the seller: its signed request, or null when it never got a reply within the budget. */
export interface FlipsSellerSlotV1 {
  request: SignedSellerRequestV1
  /**
   * Every ask of the slot in order: the scheduled one, then a re-ask only after an ask with no reply. Each with the
   * auditor's time it was sent, its request IDs and the costs of its tries; together they are `request`'s.
   */
  asks?: FlipsSlotAskV1[]
}

export interface FlipsSlotAskV1 {
  reason: 'scheduled' | 'no-reply'
  /** When the auditor sent it (ms). */
  sentAt: number
  requestIds: string[]
  attemptCosts: SignedSellerRequestV1['attemptCosts']
  /** It got a verified reply. */
  answered: boolean
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
  /** Dry run only: why the follow-up of a first flag has no record; the first flag stands. */
  followUpFailed?: string
  /** When the seller's FLIPS started and ended, by the auditor's clock (ms): what it added to the audit. */
  timing?: { startedAt: number; finishedAt: number }
  /** How many replies on each side show reasoning, and their reasoning tokens: also where both sides reason. */
  reasoningCounts?: Omit<FlipsProfileMismatch, 'code' | 'diagnosticScoreIgnoringProfile'>
  /** A probe's settings (canonical JSON): a carried probe is reused only for the same settings. */
  probeSettings?: string
  /**
   * No result because the seller's reasoning profile is not the reference's: it reasons where the reference does not,
   * does not where the reference does, or does in some replies only. With the counts of both sides.
   */
  profileMismatch?: FlipsProfileMismatch
}

export interface FlipsProfileMismatch {
  code: 'seller-reasons' | 'seller-does-not-reason' | 'seller-mixed'
  /**
   * Dry run only: what the sample would have scored had the profiles matched, for deciding the profile rule. Never an
   * outcome: no verdict, what-if view or confirmation reads it. Null when the sample could not be scored either.
   */
  diagnosticScoreIgnoringProfile?: { score: number; scoreMax: number | null; p: number } | null
  sellerReasoningReplies: number
  sellerReplies: number
  sellerReasoningTokens: number
  referenceReasoningReplies: number
  referenceReplies: number
  referenceReasoningTokens: number
}

/**
 * A reasoning profile across all replies of a check, both pairs: `reasons` when at least 90% of them show reasoning,
 * `plain` when at most 10% do, `mixed` in between. The eval scored a reference that reasons in nearly every reply.
 */
export const FLIPS_REASONING_SHARE = Object.freeze({ plainAtMost: 0.1, reasonsAtLeast: 0.9 })

function reasoningProfile(reasoning: number, replies: number): 'plain' | 'reasons' | 'mixed' {
  const share = replies === 0 ? 0 : reasoning / replies
  return share <= FLIPS_REASONING_SHARE.plainAtMost ? 'plain' : share >= FLIPS_REASONING_SHARE.reasonsAtLeast ? 'reasons' : 'mixed'
}

/** A reply longer than this is never scored: no honest reply of a FLIPS request comes near it, and the score is quadratic. */
export const FLIPS_REPLY_MAX_CHARS = 6_000

/** Whether a stored value has the shape of a FLIPS record: a carried or checkpointed one that does not is dropped. */
export function isFlipsRecord(value: unknown, depth = 0): value is FlipsV1 {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<FlipsV1>
  // A follow-up has no follow-up of its own: the depth is checked before descending, so no stored record nests deep.
  if (record.followUp !== undefined && depth > 0) return false
  const draw = record.draw as Partial<FlipsDrawV1> | undefined
  const bounded = (number: unknown, most: number): boolean => typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= most
  const finite = (cost: unknown): boolean => typeof cost === 'object' && cost !== null
    && ['inputTokens', 'outputTokens', 'totalTokens'].every((key) => bounded((cost as Record<string, unknown>)[key], FLIPS_MAX_STORED.tokens))
    && bounded((cost as Record<string, unknown>)['estimatedCostUsd'], FLIPS_MAX_STORED.costUsd)
  // Bounded: a stored record is never larger than the rule asks, with every try's cost a real, bounded number.
  const slotOk = (slot: unknown): boolean => {
    const request = (slot as FlipsSellerSlotV1 | null)?.request
    return typeof request === 'object' && request !== null
      && Array.isArray(request.requestIds) && request.requestIds.length <= FLIPS_MAX_STORED.triesPerSlot && request.requestIds.every((id) => typeof id === 'string')
      && Array.isArray(request.attemptCosts) && request.attemptCosts.length <= FLIPS_MAX_STORED.triesPerSlot && request.attemptCosts.every(finite)
      && asksOk((slot as FlipsSellerSlotV1).asks)
  }
  const asksOk = (asks: unknown): boolean => asks === undefined || (Array.isArray(asks) && asks.length <= FLIPS_REASK_BUDGET + 1
    && asks.every((entry) => typeof entry === 'object' && entry !== null && (entry.reason === 'scheduled' || entry.reason === 'no-reply')
      && Number.isSafeInteger(entry.sentAt) && typeof entry.answered === 'boolean'
      && Array.isArray(entry.requestIds) && entry.requestIds.every((id: unknown) => typeof id === 'string')
      && Array.isArray(entry.attemptCosts) && entry.attemptCosts.every(finite)))
  const replyOk = (reply: unknown): boolean => {
    const stored = reply as Partial<FlipsReferenceReplyV1> | null
    return typeof stored === 'object' && stored !== null
      && (stored.reasoningTokens === undefined || bounded(stored.reasoningTokens, FLIPS_MAX_STORED.tokens))
  }
  const counts = record.reasoningCounts as Record<string, unknown> | undefined
  const mismatch = record.profileMismatch as Record<string, unknown> | undefined
  const countsOk = (numbers: Record<string, unknown> | undefined): boolean => numbers === undefined || (typeof numbers === 'object' && numbers !== null
    && Object.entries(numbers).every(([key, number]) => key === 'code' || key === 'diagnosticScoreIgnoringProfile' || bounded(number, FLIPS_MAX_STORED.totalTokens)))
  const shapeOk = typeof record.rule === 'string' && typeof record.service === 'string' && typeof record.outcome === 'string'
    && typeof draw === 'object' && draw !== null && typeof draw.model === 'string' && typeof draw.epoch === 'string'
    && typeof draw.auditor === 'string' && typeof draw.seed === 'string' && (draw.stage === 'first' || draw.stage === 'confirm')
    && Array.isArray(record.pairs) && record.pairs.length <= FLIPS_MAX_STORED.pairs && record.pairs.every((pair) => (
      typeof pair === 'object' && pair !== null && Array.isArray(pair.words) && pair.words.length === 2 && pair.words.every((word) => typeof word === 'string')
      && Array.isArray(pair.seller) && pair.seller.length <= FLIPS_MAX_STORED.sellerSlots && pair.seller.every(slotOk)
      && Array.isArray(pair.reference?.replies) && pair.reference.replies.length <= FLIPS_MAX_STORED.referenceReplies && pair.reference.replies.every(replyOk)
    ))
    && countsOk(counts) && countsOk(mismatch)
    && (record.followUp === undefined || isFlipsRecord(record.followUp, depth + 1))
  if (!shapeOk || depth > 0) return shapeOk
  // The record goes into files whose hash must not fail: it must be canonical JSON, every number finite.
  try {
    canonicalJsonStringify(record)
    return true
  } catch {
    return false
  }
}


export interface FlipsSummary {
  rule: string
  /** The model it was drawn for: whether it counts is the rule's for this model. */
  model: string
  /** Asked by a dry-run probe: a diagnostic that never counts. */
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
  _requestBody: Uint8Array,
  response: { statusCode: number; body: Uint8Array } | null,
): { reply: FlipsReplyV1; reasoning: boolean; thinkBlock: boolean; reasoningTokens: number } {
  const none = { reply: { content: null, finishReason: null }, reasoning: false, thinkBlock: false, reasoningTokens: 0 }
  if (!response || response.statusCode !== 200) return none
  // Read from the answer's own bytes, independent of billing: an answer without usage is still an answer.
  const read = readAnswerText(response.body)
  if (!read) return none
  const finish = read.filtered ? 'content_filter' : finishReasonOf(parseJson(response.body))
  const thinkBlock = typeof read.text === 'string' && /<\/?think\b/i.test(read.text)
  return {
    reply: { content: read.text, finishReason: finish },
    reasoning: read.reasoningMarker || thinkBlock,
    thinkBlock,
    reasoningTokens: read.reasoningTokens,
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
    if (pair.replies.some((reply) => (reply.content?.length ?? 0) > FLIPS_REPLY_MAX_CHARS)) return `${label}: a reference reply is longer than ${FLIPS_REPLY_MAX_CHARS} characters`
    const expected = requestShape(flipsRequestBody(reference.draw.model, reference.service, pair.words, rule))
    if (pair.replies.some((reply) => requestShape(parseJson(reply.request)) !== expected)) return `${label}: the reference was not asked the sellers' request`
  }
  const providers = new Set(reference.pairs.flatMap((pair) => pair.replies.map((reply) => reply.provider)))
  if (!reference.referenceOneProvider && providers.size === 1 && providers.has(null)) return FLIPS_ROUTE_NOT_SUPPORTED
  if (providers.size > 1 || (!reference.referenceOneProvider && providers.has(null))) return 'the reference\'s replies do not come from one proven provider'
  // One reasoning profile across both pairs: reasons in at least 90% of the replies, or in at most 10%.
  const replies = reference.pairs.flatMap((pair) => pair.replies)
  const reasoning = replies.filter((reply) => reply.reasoning).length
  if (reasoningProfile(reasoning, replies.length) === 'mixed') {
    return `the reference reasons in ${reasoning} of ${replies.length} replies: neither at most ${FLIPS_REASONING_SHARE.plainAtMost * 100}% nor at least ${FLIPS_REASONING_SHARE.reasonsAtLeast * 100}%`
  }
  return null
}

/** The judgement of a FLIPS check from what it stores: outcome, counting, score, p and why. Pure. */
export function judgeFlips(
  record: Pick<FlipsV1, 'draw' | 'service' | 'referenceOneProvider' | 'pairs'>,
  rule: FlipsRule = FLIPS_RULE,
): Pick<FlipsV1, 'outcome' | 'counted' | 'score' | 'scoreMax' | 'p' | 'reason' | 'profileMismatch' | 'reasoningCounts'> {
  // A dry run's probe is a diagnostic: it never counts.
  const counted = flipsCounts(record.draw.model, rule) && !isProbeDraw(record.draw)
  const none = (reason: string) => ({ outcome: 'inconclusive' as const, counted, score: null, scoreMax: null, p: null, reason })
  const stage = record.draw.stage
  const replies = rule.repliesPerPair[stage]
  if (record.pairs.length !== rule.pairsPerCheck) return none(`${record.pairs.length} word pairs, the rule asks ${rule.pairsPerCheck}`)
  const problem = flipsReferenceProblem({ draw: record.draw, service: record.service, referenceOneProvider: record.referenceOneProvider, pairs: record.pairs.map((pair) => pair.reference) }, rule)
  if (problem) return none(problem)
  const read = []
  for (const pair of record.pairs) {
    const label = `${pair.words[0]}/${pair.words[1]}`
    if (pair.seller.length !== replies) return none(`${label}: ${pair.seller.length} seller slots, the stage asks ${replies}`)
    const expected = requestShape(flipsRequestBody(record.draw.model, record.service, pair.words, rule))
    const answers = pair.seller.map(sellerAnswer)
    if (answers.some((answer) => answer === null)) return none(`${label}: a scheduled slot has no reply`)
    const signed = answers as NonNullable<(typeof answers)[number]>[]
    // A signed answer with no readable text is never dropped from the sample: the check has no result.
    if (signed.some((answer) => answer.reply.content === null)) return none(`${label}: a signed answer has no readable text`)
    if (signed.some((answer) => answer.thinkBlock)) return none(`${label}: a seller answer writes its reasoning into its text`)
    if (signed.some((answer) => answer.reply.content!.length > FLIPS_REPLY_MAX_CHARS)) return none(`${label}: a seller answer is longer than ${FLIPS_REPLY_MAX_CHARS} characters`)
    if (signed.some((answer) => requestShape(answer.requestBody) !== expected)) return none(`${label}: a seller request is not the reference's`)
    read.push({ pair, answers: signed })
  }
  // The reasoning profile, across both pairs and in both directions: the seller's must be the reference's. Honest hosts
  // that ignore the reasoning setting land here, and so do swaps that reason where the claimed model does not; each
  // case keeps its own code and the counts of both sides, so the dry run decides on those numbers whether it stays so.
  const referenceReplies = record.pairs.flatMap((pair) => pair.reference.replies)
  const sellerAnswers = read.flatMap((entry) => entry.answers)
  const referenceReasoning = referenceReplies.filter((reply) => reply.reasoning).length
  const sellerReasoning = sellerAnswers.filter((answer) => answer.reasoning).length
  const referenceProfile = reasoningProfile(referenceReasoning, referenceReplies.length)
  const sellerProfile = reasoningProfile(sellerReasoning, sellerAnswers.length)
  const reasoningCounts = {
    sellerReasoningReplies: sellerReasoning,
    sellerReplies: sellerAnswers.length,
    sellerReasoningTokens: sellerAnswers.reduce((total, answer) => total + answer.reasoningTokens, 0),
    referenceReasoningReplies: referenceReasoning,
    referenceReplies: referenceReplies.length,
    referenceReasoningTokens: referenceReplies.reduce((total, reply) => total + (reply.reasoningTokens ?? 0), 0),
  }
  const samples = read.map(({ pair, answers }) => ({
    pair: pair.words,
    reference: pair.reference.replies.map((reply) => ({ content: reply.content, finishReason: reply.finishReason })),
    seller: answers.map((answer) => answer.reply),
  }))
  if (sellerProfile !== referenceProfile) {
    const code = sellerProfile === 'mixed' ? 'seller-mixed' as const : sellerProfile === 'reasons' ? 'seller-reasons' as const : 'seller-does-not-reason' as const
    // The profile is the only reason left: the score it would have had is kept beside it for the dry run, apart from
    // the outcome fields.
    const ignoring = judgeFlipsCheck(samples, rule)
    const mismatch: FlipsProfileMismatch = {
      code, ...reasoningCounts,
      diagnosticScoreIgnoringProfile: ignoring.outcome === 'scored' && ignoring.score !== null && ignoring.p !== null
        ? { score: ignoring.score, scoreMax: ignoring.scoreMax, p: ignoring.p }
        : null,
    }
    const what = code === 'seller-reasons' ? 'the seller reasons where the reference does not'
      : code === 'seller-does-not-reason' ? 'the seller does not reason where the reference does' : 'the seller reasons in some replies and not in others'
    return {
      ...none(`${what} (${mismatch.sellerReasoningReplies} of ${mismatch.sellerReplies} replies, ${mismatch.sellerReasoningTokens} reasoning tokens, against ${mismatch.referenceReasoningReplies} of ${mismatch.referenceReplies}, ${mismatch.referenceReasoningTokens}), so its request profile has no reference`),
      profileMismatch: mismatch,
      reasoningCounts,
    }
  }
  const judged = judgeFlipsCheck(samples, rule)
  if (judged.outcome !== 'scored' || judged.p === null || judged.score === null) return { ...none(judged.reasons.join('; ') || 'no score'), reasoningCounts }
  const p = judged.p
  const outcome: FlipsOutcome = p <= rule.bar[stage] ? 'flag' : p > rule.passAbove ? 'pass' : 'inconclusive'
  const reason = outcome === 'flag'
    ? `scored ${judged.score.toFixed(2)} (p ${p.toExponential(2)}), at most the ${stage} bar ${rule.bar[stage]}`
    : outcome === 'pass'
      ? `scored ${judged.score.toFixed(2)} (p ${p.toFixed(3)}), above ${rule.passAbove}`
      : `scored ${judged.score.toFixed(2)} (p ${p.toFixed(4)}), between the bar and the pass`
  return { outcome, counted, score: judged.score, scoreMax: judged.scoreMax, p, reason, reasoningCounts }
}

export function summarizeFlips(record: FlipsV1): FlipsSummary {
  return {
    rule: record.rule, model: record.draw.model, ...(isProbeDraw(record.draw) ? { probe: true as const } : {}), stage: record.draw.stage,
    outcome: record.outcome, counted: record.counted, p: record.p, score: record.score, reason: record.reason,
  }
}

/** A FLIPS flag in plain words, for the verdict reason. */
export function describeFlipsFlag(record: Pick<FlipsV1, 'rule' | 'reason'>): string {
  return `randomness check (${record.rule}): ${record.reason}`
}

/** Every seller request FLIPS paid for, in slot order. */
export function flipsPaidRequests(record: FlipsV1): PaidRequest[] {
  return [
    ...record.pairs.flatMap((pair) => pair.seller.map((slot) => ({ requestCount: slot.request.requestIds.length, attemptCosts: slot.request.attemptCosts }))),
    // A dry run's follow-up is paid for by the same audit.
    ...(record.followUp ? flipsPaidRequests(record.followUp) : []),
  ]
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
  // Re-asks keep to the budget, and, where the asks are stored, each one follows an ask that got no reply.
  if (!Number.isInteger(record.reasks) || record.reasks < 0 || record.reasks > FLIPS_REASK_BUDGET) throw new Error('a FLIPS check re-asks more slots than its budget')
  const slots = record.pairs.flatMap((pair) => pair.seller)
  if (slots.some((slot) => slot.asks !== undefined)) {
    let reasked = 0
    for (const slot of slots) {
      const asks = slot.asks
      if (!asks || asks.length === 0 || asks[0]!.reason !== 'scheduled') throw new Error('a FLIPS slot does not start with its scheduled ask')
      for (let index = 1; index < asks.length; index += 1) {
        if (asks[index]!.reason !== 'no-reply' || asks[index - 1]!.answered) throw new Error('a FLIPS slot was asked again after a reply')
        if (asks[index]!.sentAt < asks[index - 1]!.sentAt) throw new Error('a FLIPS slot\'s asks are out of order')
      }
      reasked += asks.length - 1
      if (canonicalJsonStringify(asks.flatMap((entry) => entry.requestIds)) !== canonicalJsonStringify(slot.request.requestIds)
        || canonicalJsonStringify(asks.flatMap((entry) => entry.attemptCosts)) !== canonicalJsonStringify(slot.request.attemptCosts)) {
        throw new Error('a FLIPS slot\'s asks are not its requests')
      }
      if (asks.at(-1)!.answered !== (signedExchange(slot.request) !== null)) throw new Error('a FLIPS slot\'s last ask is not its reply')
    }
    if (reasked !== record.reasks) throw new Error('a FLIPS check\'s re-asks are not the ones its slots store')
  }
  if (record.followUp) {
    validateFlips(record.followUp)
    if (!isProbeDraw(record.followUp.draw)) throw new Error('a FLIPS follow-up is not marked as a probe')
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
    results: Array<{
      requestBody: Uint8Array
      /** What was asked, before a protocol's own rewrite: compared with the sellers' body. */
      askedBody?: Uint8Array
      response: { statusCode: number; body: Uint8Array } | null
      provider: string | null
      failure: string | null
      /** Requests sent for this reply, and how many of them were answered with a rate limit. */
      tries?: number
      rateLimited?: number
    }>
  }>
  rule?: FlipsRule
  now?: () => number
}): Promise<FlipsReferenceV1> {
  const rule = input.rule ?? FLIPS_RULE
  const now = input.now ?? Date.now
  const bodies = input.pairs.flatMap((pair) => Array.from({ length: rule.referenceRepliesPerPair }, () => flipsRequestBody(input.model, input.service, pair, rule)))
  const startedAt = now()
  const asked = await input.ask(bodies)
  const finishedAt = now()
  const decoder = new TextDecoder()
  return {
    stage: input.stage,
    upstream: asked.upstream,
    oneProvider: asked.oneProvider,
    asked: {
      tries: asked.results.reduce((total, result) => total + (result.tries ?? 1), 0),
      rateLimited: asked.results.reduce((total, result) => total + (result.rateLimited ?? 0), 0),
      seconds: Math.round((finishedAt - startedAt) / 100) / 10,
    },
    pairs: input.pairs.map((pair, pairIndex) => {
      const results = asked.results.slice(pairIndex * rule.referenceRepliesPerPair, (pairIndex + 1) * rule.referenceRepliesPerPair)
      return {
        words: pair,
        // The smaller as the start: a clock that steps back during the call never makes the bounds invalid.
        ...(Number.isSafeInteger(startedAt) && Number.isSafeInteger(finishedAt) && startedAt >= 0 && finishedAt >= 0
          ? { referenceBatch: { startedAt: Math.min(startedAt, finishedAt), finishedAt: Math.max(startedAt, finishedAt) } } : {}),
        replies: results.map((result) => {
          const answer = readFlipsAnswer(result.requestBody, result.response)
          return {
            ...answer.reply, provider: result.provider, reasoning: answer.reasoning, thinkBlock: answer.thinkBlock, reasoningTokens: answer.reasoningTokens,
            ...(result.tries !== undefined ? { tries: result.tries } : {}), ...(result.rateLimited !== undefined ? { rateLimited: result.rateLimited } : {}),
            failure: result.failure, request: decoder.decode(result.askedBody ?? result.requestBody),
          }
        }),
      }
    }),
  }
}

/** Slots asked again in one check, at most: only slots that got no reply at all. */
export const FLIPS_REASK_BUDGET = 4

/** The most a stored FLIPS record holds: any more is no record of this build. */
const FLIPS_MAX_STORED = Object.freeze({
  pairs: 4,
  sellerSlots: 64,
  referenceReplies: 64,
  /** A slot's first request and every re-ask (all may fall on one slot), each with its signed request's tries. */
  triesPerSlot: SIGNED_REQUEST_TRIES * (FLIPS_REASK_BUDGET + 1),
  tokens: 10_000_000,
  totalTokens: 1_000_000_000,
  costUsd: 1_000,
})

/** One seller's FLIPS on a prepared reference. Never rejects. */
export async function runFlips(input: {
  seller: Omit<SignedSellerRequestInput, 'peerId' | 'service' | 'serviceAliases'> & { peerId: string; service: string; serviceAliases?: readonly string[] }
  draw: FlipsDrawV1
  reference: FlipsReferenceV1
  rule?: FlipsRule
  now?: () => number
}): Promise<FlipsV1> {
  const rule = input.rule ?? FLIPS_RULE
  const replies = rule.repliesPerPair[input.draw.stage]
  const ask = (pair: FlipsPair) => askSellerSigned(
    { ...input.seller, serviceAliases: input.seller.serviceAliases ?? [] } as SignedSellerRequestInput,
    flipsRequestBody(input.draw.model, input.seller.service, pair, rule),
  )
  const answered = (request: SignedSellerRequestV1): boolean => signedExchange(request) !== null
  const now = input.now ?? Date.now
  const asked = async (pair: FlipsPair, reason: FlipsSlotAskV1['reason']) => {
    const sentAt = now()
    const request = await ask(pair)
    const entry: FlipsSlotAskV1 = { reason, sentAt, requestIds: [...request.requestIds], attemptCosts: [...request.attemptCosts], answered: answered(request) }
    return { request, entry }
  }
  const pairs: FlipsPairV1[] = await Promise.all(input.reference.pairs.map(async (reference) => ({
    words: reference.words,
    reference,
    seller: await Promise.all(Array.from({ length: replies }, async () => {
      const first = await asked(reference.words, 'scheduled')
      return { request: first.request, asks: [first.entry] }
    })),
  })))
  let reasks = 0
  for (const pair of pairs) {
    for (const slot of pair.seller) {
      while (!answered(slot.request) && reasks < FLIPS_REASK_BUDGET && !input.seller.signal?.aborted) {
        reasks += 1
        const again = await asked(pair.words, 'no-reply')
        // The tries of a slot are paid for and counted, so they stay with it, each ask in order.
        slot.request = {
          ...again.request,
          requestIds: [...slot.request.requestIds, ...again.request.requestIds],
          attemptCosts: [...slot.request.attemptCosts, ...again.request.attemptCosts],
        }
        slot.asks = [...slot.asks ?? [], again.entry]
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

/** Why a model and stage has no FLIPS result this run: logged once and stored by the caller. */
export interface FlipsUnavailable {
  stage: FlipsStage | 'follow-up'
  code: 'reference-failed' | 'reference-unusable' | 'route-not-supported' | 'check-failed' | 'follow-up-failed'
  detail: string
}

/** The FLIPS of one model's sellers in one run: the reference once per stage, then each seller. */
export interface FlipsScreen<Settings> {
  /** A dry-run probe is on: a carried record that is not a probe's is asked again. */
  probing: boolean
  /** The probe's settings (canonical JSON), null without one: a carried probe of other settings is asked again. */
  probeSettings: string | null
  /** Asks the reference of a stage now, while the questions run; its failure is reported, never thrown. */
  warm: (service: string, settings: Settings, stage: FlipsStage) => void
  check: (
    seller: { peerId: string; service: string; serviceAliases?: readonly string[] },
    settings: Settings,
    options: { stage: FlipsStage; clock?: SignedSellerRequestInput['clock']; signal?: AbortSignal },
  ) => Promise<FlipsV1 | null>
}

type DrawKind = FlipsStage | 'follow-up'

export function createFlipsScreen<Settings>(input: {
  model: string
  auditor: string
  epoch: string
  /** The seed of this model audit and a stage (`flipsSeed`). */
  seedFor: (stage: FlipsStage) => string
  proxyBaseUrl: string
  responseAuthReader: SignedSellerRequestInput['responseAuthReader']
  /** FLIPS's own limiter: its seller requests never queue behind or ahead of the questions. */
  limiter: SignedSellerRequestInput['limiter']
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  ask: (settings: Settings) => (bodies: readonly Record<string, unknown>[], signal: AbortSignal) => ReturnType<Parameters<typeof prepareFlipsReference>[0]['ask']>
  rule?: FlipsRule
  probe?: FlipsProbe
  onReady?: (reference: FlipsReferenceV1) => void
  /** Once per model, stage and reason: why a check of it has no result. */
  onUnavailable?: (event: FlipsUnavailable) => void
  timeLimitMs?: number
  referenceTimeLimitMs?: number
}): FlipsScreen<Settings> {
  const rule = input.rule ?? FLIPS_RULE
  const probe = input.probe
  const probing = probe !== undefined
  const probeSettings = probe ? canonicalJsonStringify(probe) : null
  const references = new Map<DrawKind, Promise<FlipsReferenceV1>>()
  const failedReferences = new Set<DrawKind>()
  const reported = new Set<string>()
  const unavailable = (event: FlipsUnavailable): void => {
    const key = `${event.stage}|${event.code}|${event.detail}`
    if (reported.has(key)) return
    reported.add(key)
    try {
      input.onUnavailable?.(event)
    } catch {
      // A report is best effort.
    }
  }
  const firstStage: FlipsStage = probe?.stage ?? 'first'
  const drawOf = (kind: DrawKind): FlipsDrawV1 => {
    const base = { auditor: input.auditor, model: input.model, epoch: input.epoch }
    if (kind === 'follow-up') {
      // Fresh pairs: the confirmation pool, and none of the first check's pairs, also when those were chosen.
      return { ...base, seed: input.seedFor('confirm'), stage: 'confirm', probe: true, excluding: drawFlipsPairs(drawOf(firstStage), rule) }
    }
    return {
      ...base, seed: input.seedFor(kind), stage: kind,
      ...(probing ? { probe: true as const } : {}),
      ...(probe?.pairs ? { pairs: probe.pairs } : {}),
    }
  }
  const referenceFor = (kind: DrawKind, service: string, settings: Settings): Promise<FlipsReferenceV1> => {
    let reference = references.get(kind)
    if (!reference) {
      // The reference has its own time limit and is cancelled at it: it never holds a lane past it. A failed one is
      // kept for the run (it is not paid for twice), and reported once.
      const signal = AbortSignal.timeout(input.referenceTimeLimitMs ?? FLIPS_REFERENCE_TIME_LIMIT_MS)
      const draw = drawOf(kind)
      reference = prepareFlipsReference({
        model: input.model, service, stage: draw.stage, pairs: drawFlipsPairs(draw, rule),
        ask: (bodies) => input.ask(settings)(bodies, signal), rule,
      }).then((prepared) => {
        try {
          input.onReady?.(prepared)
        } catch {
          // Storing the reference beside the audits is best effort.
        }
        // Checked as soon as it is ready, so an unusable reference is reported even when no seller reaches FLIPS.
        const problem = flipsReferenceProblem({ draw, service, referenceOneProvider: prepared.oneProvider, pairs: prepared.pairs }, rule)
        if (problem) unavailable({ stage: kind, code: problem === FLIPS_ROUTE_NOT_SUPPORTED ? 'route-not-supported' : 'reference-unusable', detail: problem })
        return prepared
      })
      reference.catch((error: unknown) => {
        failedReferences.add(kind)
        unavailable({ stage: kind, code: 'reference-failed', detail: errorText(error) })
      })
      references.set(kind, reference)
    }
    return reference
  }
  // At most this many of one seller's slots are out at once, within FLIPS's own limit. Every wait for a slot ends at
  // FLIPS's time limit: a task that gets its slot after it never starts.
  const sellerLimiter = (signal: AbortSignal): SignedSellerRequestInput['limiter'] => {
    const own = new ConcurrencyLimiter(FLIPS_SLOTS_AT_ONCE)
    const started = <T>(task: () => Promise<T>) => () => {
      if (signal.aborted) return Promise.reject(new Error('the randomness check\'s time is up'))
      return task()
    }
    return {
      run: <T>(task: () => Promise<T>) => untilAborted(own.run(started(() => input.limiter.run(started(task)))), signal),
    } as SignedSellerRequestInput['limiter']
  }
  const one = async (
    kind: DrawKind,
    seller: Parameters<FlipsScreen<Settings>['check']>[0],
    settings: Settings,
    options: Parameters<FlipsScreen<Settings>['check']>[2],
    signal: AbortSignal,
  ): Promise<FlipsV1> => {
    const draw = drawOf(kind)
    // The wait for the reference is in FLIPS's time too (a follow-up's is asked only now).
    const prepared = await untilAborted(referenceFor(kind, seller.service, settings), signal)
    const problem = flipsReferenceProblem({ draw, service: seller.service, referenceOneProvider: prepared.oneProvider, pairs: prepared.pairs }, rule)
    const stored = {
      rule: rule.id, draw, service: seller.service, referenceUpstream: prepared.upstream, referenceOneProvider: prepared.oneProvider,
    }
    if (problem) {
      // The reference is checked before the seller is asked: an unusable one costs the seller nothing.
      unavailable({ stage: kind, code: problem === FLIPS_ROUTE_NOT_SUPPORTED ? 'route-not-supported' : 'reference-unusable', detail: problem })
      const pairs = prepared.pairs.map((reference) => ({ words: reference.words, reference, seller: [] }))
      return { ...stored, pairs, reasks: 0, ...judgeFlips({ ...stored, pairs }, rule), reason: problem }
    }
    return runFlips({
      seller: {
        proxyBaseUrl: input.proxyBaseUrl,
        responseAuthReader: input.responseAuthReader,
        limiter: sellerLimiter(signal),
        peerId: seller.peerId,
        service: seller.service,
        serviceAliases: seller.serviceAliases ?? [],
        ...(input.requestTimeoutMs ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
        ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        signal,
      },
      draw,
      reference: prepared,
      rule,
    })
  }
  return {
    probing,
    probeSettings,
    warm(service, settings, stage) {
      try {
        referenceFor(probe?.stage ?? stage, service, settings).catch(() => undefined)
      } catch (error) {
        unavailable({ stage: probe?.stage ?? stage, code: 'reference-failed', detail: errorText(error) })
      }
    },
    async check(seller, settings, options) {
      const stage = probe?.stage ?? options.stage
      // FLIPS has its own time, the follow-up included: when it runs out, the earlier tests stand and FLIPS has no result.
      const timeLimit = AbortSignal.timeout(input.timeLimitMs ?? FLIPS_TIME_LIMIT_MS)
      const signal = options.signal ? AbortSignal.any([options.signal, timeLimit]) : timeLimit
      const startedAt = Date.now()
      // A record no required write could hold (an unbounded number, say) is dropped here, and says so.
      const stamped = (record: FlipsV1): FlipsV1 | null => {
        const finished = { ...record, timing: { startedAt, finishedAt: Date.now() }, ...(probeSettings ? { probeSettings } : {}) }
        if (isFlipsRecord(finished)) return finished
        unavailable({ stage, code: 'check-failed', detail: 'the record is outside the bounds any stored record keeps, so it is not stored' })
        return null
      }
      let record: FlipsV1
      try {
        record = await one(stage, seller, settings, options, signal)
      } catch (error) {
        // While FLIPS does not count, a failure of it is no diagnostic, never an aborted audit; it is reported.
        if (flipsCounts(input.model, rule) && !probing) throw error
        // A failed reference is reported once by itself; any other failure here (a reference still out at the time
        // limit included), never by waiting for it.
        await Promise.resolve()
        if (!failedReferences.has(stage)) unavailable({ stage, code: 'check-failed', detail: errorText(error) })
        return null
      }
      // Dry run: a first flag is followed at once by a confirmation-size sample on fresh pairs, read by hand.
      if (probe?.followUpFirstFlags && stage === 'first' && record.outcome === 'flag') {
        try {
          return stamped({ ...record, followUp: await one('follow-up', seller, settings, options, signal) })
        } catch (error) {
          unavailable({ stage: 'follow-up', code: 'follow-up-failed', detail: errorText(error) })
          return stamped({ ...record, followUpFailed: errorText(error) })
        }
      }
      return stamped(record)
    },
  }
}

/** Waits for `promise`, or rejects once `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('the randomness check\'s time is up'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('the randomness check\'s time is up'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}
