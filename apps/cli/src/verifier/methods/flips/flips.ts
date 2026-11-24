import { createHash, createHmac } from 'node:crypto'
import { THINKING_DISCOVERY_RULE, THINKING_DISCOVERY_RULES, canonicalJsonStringify, isKbfTokenLimitFinishReason, type ThinkingDiscoveryRuleId } from '@antseed/fingerprints'
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import {
  FLIPS_REQUESTS,
  FLIPS_RULE,
  flipsCounts,
  flipsFixedSetting,
  flipsRequestBody,
  flipsRuleById,
  holdsNoSequence,
  isValidFlipsPair,
  judgeFlipsCheck,
  type FlipsPair,
  type FlipsReplyV1,
  type FlipsRule,
} from './flips-score.js'
import { ConcurrencyLimiter } from '../../audit-concurrency.js'
import { askedAsReference, describeSetting, isAllowedSetting, requestCarries, strategySetting, type ThinkingSetting } from '../../audit-thinking.js'
import { readAnswerText } from '../shared/output-usage.js'
import { untilAborted } from '../../utils.js'
import { costOfRequests, requestCountOf, type AuditCostSummaryV1, type PaidRequest } from '../../proxy-evidence.js'
import {
  SIGNED_REQUEST_TRIES,
  askSellerSigned,
  signedExchange,
  signedRequestFailure,
  type SignedSellerRequestInput,
  type SignedSellerRequestV1,
} from '../shared/signed-seller-request.js'

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
 * - A slot with no reply at all after a failure that can pass (a 429, a 5xx, a timeout, no ResponseAuth) is asked again
 *   within a budget; a refusal (any other 4xx) gives the same answer and is not. An empty, filtered or short reply is
 *   never asked again: it counts as the rule says.
 * - Under a rule with a second look, a first audit scored between its bars asks each pair 10 more times and
 *   is judged on all its replies (`judgeFlips`).
 * - A check with a slot still unanswered, a reference pair from more than one provider, a reference request the route
 *   changed, or a seller that thinks where the reference does not, has no result.
 * - So does a seller asked with another thinking setting than the reference (`FLIPS_NOT_ASKED_AS_REFERENCE`): its
 *   discovery tries the reference's setting first, then its nearest equivalent (`"low"` for `"minimal"`, which counts as
 *   the reference's), and a seller that takes neither gives no comparable sample.
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
  /** The thinking setting every reference request carried (`FLIPS_THINKING`): its bank's, or the eval's switch. */
  thinking: ThinkingSetting
}

/** The thinking setting each side's requests carried (`FLIPS_THINKING`). */
export interface FlipsThinkingV1 {
  /** The seller's own discovered setting, or the bank's when its discovery failed. */
  seller: ThinkingSetting
  /** The bank's setting where the bank's discovery reached 0 reasoning tokens with it; else the eval's switch. */
  reference: ThinkingSetting
  /**
   * The discovery rule the seller's setting was found under (`THINKING_DISCOVERY_RULE`). Under
   * `kbf-discovery-reference-first-v1` a seller asked otherwise than the reference has no result
   * (`FLIPS_NOT_ASKED_AS_REFERENCE`). A record without it was made before, when the sides could differ, and is judged so.
   */
  discoveryRule?: ThinkingDiscoveryRuleId
}

/** Why a FLIPS check has no result when the seller's setting is not the reference's. */
export const FLIPS_NOT_ASKED_AS_REFERENCE = 'the seller could not be asked the way the reference was'

/** Whether a record's sides must be asked the same way: under the reference-first discovery rule, not before it. */
function asksAsReference(thinking: FlipsThinkingV1): boolean {
  return thinking.discoveryRule !== undefined && thinking.discoveryRule !== THINKING_DISCOVERY_RULES[0]
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
  /**
   * The thinking setting each side's requests carried. Every record an audit stores has it (`validateFlips`); a record
   * without it (an eval replay's) is read as the eval's switch on both sides, the body it was asked with.
   */
  thinking?: FlipsThinkingV1
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
  /**
   * The second look of a first audit scored between its bars (`FlipsRule.secondLook`): the slots asked of each pair on
   * top of its first ones. The record's outcome, score and p are then those of all its replies; a second look with no
   * result leaves the first look's.
   */
  secondLook?: FlipsSecondLookV1
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
  /** No result because one side of a pair has more replies without a sequence than its rule allows (`noSequence`). */
  noSequence?: FlipsNoSequence
  /** No result because the seller repeats its replies on a pair (`repeats`): a finding of its own for the report. */
  repeats?: FlipsRepeats
}

/** The more slots of a second look, per pair in the record's pair order, and the slots of them asked again. */
export interface FlipsSecondLookV1 {
  seller: FlipsSellerSlotV1[][]
  /** Slots of the second look asked again because they got no reply; within the check's one budget, with `reasks`. */
  reasks: number
}

/** A pair whose seller replies repeat one another, with the response ids those replies carry. */
export interface FlipsRepeats {
  code: 'seller-repeats'
  words: FlipsPair
  /** Seller replies with a sequence that repeat an earlier one exactly, and all seller replies with a sequence. */
  repeated: number
  replies: number
  /** The distinct response ids (`id`) of the pair's seller replies, in slot order; a reply without one is left out. */
  responseIds: string[]
}

/** A pair with too many replies that hold no sequence, on the seller's side or the reference's: a fixed code. */
export interface FlipsNoSequence {
  code: 'seller-no-sequence' | 'reference-no-sequence'
  words: FlipsPair
  /** Replies of that side of the pair without a sequence, and all its replies. */
  without: number
  replies: number
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

/**
 * Whether a reply shows reasoning for the profile: it says so (a count, reasoning fields, a `<think>` block), or, under
 * a rule with `noSequence`, it was cut at the token limit holding no sequence: the budget went to reasoning it did not
 * itemise.
 */
function showsReasoning(reply: FlipsReplyV1 & { reasoning: boolean }, pair: FlipsPair, rule: FlipsRule): boolean {
  return reply.reasoning || (rule.noSequence !== undefined && isKbfTokenLimitFinishReason(reply.finishReason) && holdsNoSequence(reply, pair, rule))
}

/**
 * A reference reply left out of the sample under a rule with `noSequence`: one that holds no sequence, or one longer than
 * `FLIPS_REPLY_MAX_CHARS`, which costs that reply only, never the whole reference (as it did under `flips-v1`).
 */
function referenceLeftOut(reply: FlipsReplyV1, pair: FlipsPair, rule: FlipsRule): boolean {
  return holdsNoSequence(reply, pair, rule) || (rule.noSequence !== undefined && (reply.content?.length ?? 0) > FLIPS_REPLY_MAX_CHARS)
}

/** The first pair whose side holds more replies without a sequence than the rule allows; null when every pair is within it. */
function noSequenceOf(
  side: 'seller' | 'reference',
  pairs: ReadonlyArray<{ words: FlipsPair; replies: readonly FlipsReplyV1[] }>,
  rule: FlipsRule,
): FlipsNoSequence | null {
  if (!rule.noSequence) return null
  for (const { words, replies } of pairs) {
    const without = replies.filter((reply) => (side === 'reference' ? referenceLeftOut(reply, words, rule) : holdsNoSequence(reply, words, rule))).length
    if (without > rule.noSequence.maxShare * replies.length) {
      return { code: side === 'seller' ? 'seller-no-sequence' : 'reference-no-sequence', words: [words[0], words[1]], without, replies: replies.length }
    }
  }
  return null
}

const describeNoSequence = (found: FlipsNoSequence): string => (
  `${found.words[0]}/${found.words[1]}: ${found.without} of ${found.replies} ${found.code === 'seller-no-sequence' ? 'seller' : 'reference'} replies hold no sequence`
)

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
  const withoutSequence = record.noSequence as Partial<FlipsNoSequence> | undefined
  const noSequenceOk = withoutSequence === undefined || (typeof withoutSequence === 'object' && withoutSequence !== null
    && (withoutSequence.code === 'seller-no-sequence' || withoutSequence.code === 'reference-no-sequence')
    && Array.isArray(withoutSequence.words) && withoutSequence.words.length === 2 && withoutSequence.words.every((word) => typeof word === 'string')
    && Number.isSafeInteger(withoutSequence.without) && Number.isSafeInteger(withoutSequence.replies)
    && bounded(withoutSequence.without, FLIPS_MAX_STORED.referenceReplies) && bounded(withoutSequence.replies, FLIPS_MAX_STORED.referenceReplies))
  const repeats = record.repeats as Partial<FlipsRepeats> | undefined
  const repeatsOk = repeats === undefined || (typeof repeats === 'object' && repeats !== null && repeats.code === 'seller-repeats'
    && Array.isArray(repeats.words) && repeats.words.length === 2 && repeats.words.every((word) => typeof word === 'string')
    && Number.isSafeInteger(repeats.repeated) && Number.isSafeInteger(repeats.replies)
    && bounded(repeats.repeated, FLIPS_MAX_STORED.sellerSlots) && bounded(repeats.replies, FLIPS_MAX_STORED.sellerSlots)
    && Array.isArray(repeats.responseIds) && repeats.responseIds.length <= FLIPS_MAX_STORED.sellerSlots
    && repeats.responseIds.every((id) => typeof id === 'string' && id.length <= FLIPS_RESPONSE_ID_MAX_CHARS))
  const counts = record.reasoningCounts as Record<string, unknown> | undefined
  const mismatch = record.profileMismatch as Record<string, unknown> | undefined
  const countsOk = (numbers: Record<string, unknown> | undefined): boolean => numbers === undefined || (typeof numbers === 'object' && numbers !== null
    && Object.entries(numbers).every(([key, number]) => key === 'code' || key === 'diagnosticScoreIgnoringProfile' || bounded(number, FLIPS_MAX_STORED.totalTokens)))
  const second = record.secondLook as Partial<FlipsSecondLookV1> | undefined
  const secondOk = second === undefined || (typeof second === 'object' && second !== null && Array.isArray(second.seller)
    && second.seller.length <= FLIPS_MAX_STORED.pairs
    && second.seller.every((slots) => Array.isArray(slots) && slots.length <= FLIPS_MAX_STORED.sellerSlots && slots.every(slotOk))
    && Number.isSafeInteger(second.reasks) && bounded(second.reasks, FLIPS_REASK_BUDGET))
  const shapeOk = typeof record.rule === 'string' && typeof record.service === 'string' && typeof record.outcome === 'string'
    && typeof draw === 'object' && draw !== null && typeof draw.model === 'string' && typeof draw.epoch === 'string'
    && typeof draw.auditor === 'string' && typeof draw.seed === 'string' && (draw.stage === 'first' || draw.stage === 'confirm')
    && Array.isArray(record.pairs) && record.pairs.length <= FLIPS_MAX_STORED.pairs && record.pairs.every((pair) => (
      typeof pair === 'object' && pair !== null && Array.isArray(pair.words) && pair.words.length === 2 && pair.words.every((word) => typeof word === 'string')
      && Array.isArray(pair.seller) && pair.seller.length <= FLIPS_MAX_STORED.sellerSlots && pair.seller.every(slotOk)
      && Array.isArray(pair.reference?.replies) && pair.reference.replies.length <= FLIPS_MAX_STORED.referenceReplies && pair.reference.replies.every(replyOk)
    ))
    && countsOk(counts) && countsOk(mismatch) && noSequenceOk && repeatsOk && secondOk
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
function sellerAnswer(slot: FlipsSellerSlotV1): { reply: FlipsReplyV1; reasoning: boolean; thinkBlock: boolean; reasoningTokens: number; requestBody: unknown; responseId: string | null } | null {
  const exchange = signedExchange(slot.request)
  if (!exchange) return null
  const body = parseJson(exchange.response.body) as { id?: unknown } | null
  const responseId = typeof body?.id === 'string' ? body.id.slice(0, FLIPS_RESPONSE_ID_MAX_CHARS) : null
  return { ...readFlipsAnswer(exchange.response), requestBody: parseJson(exchange.requestBody), responseId }
}

/** A stored response id is cut to this length. */
const FLIPS_RESPONSE_ID_MAX_CHARS = 200

/** Share of these texts that repeat an earlier one exactly. */
function repeatShare(texts: readonly string[]): number {
  return texts.length === 0 ? 0 : (texts.length - new Set(texts).size) / texts.length
}

/**
 * What makes a reference unusable, checked before any seller is asked: the pairs and their size, every reply read
 * (a failed or unreadable one leaves the pair short), no reasoning written into an answer, one proven provider across
 * both pairs (a named one, or a route pinned to one), and every slot asked exactly the sellers' body. Null when usable.
 */
export function flipsReferenceProblem(
  reference: { draw: FlipsDrawV1; service: string; referenceOneProvider: boolean; pairs: readonly FlipsReferencePairV1[]; thinking?: ThinkingSetting },
  rule: FlipsRule = FLIPS_RULE,
): string | null {
  const thinking = reference.thinking ?? flipsFixedSetting(reference.draw.model)
  if (reference.pairs.length !== rule.pairsPerCheck) return `${reference.pairs.length} word pairs, the rule asks ${rule.pairsPerCheck}`
  for (const pair of reference.pairs) {
    const label = `${pair.words[0]}/${pair.words[1]}`
    if (!isValidFlipsPair(pair.words)) return `the word pair ${label} cannot be read back`
    if (pair.replies.length !== rule.referenceRepliesPerPair) return `${label}: ${pair.replies.length} reference replies, the rule asks ${rule.referenceRepliesPerPair}`
    if (pair.replies.some((reply) => reply.content === null)) return `${label}: a reference reply could not be read`
    if (pair.replies.some((reply) => reply.thinkBlock === true)) return `${label}: a reference reply writes its reasoning into its answer`
    // Under a rule with `noSequence` an over-long reply is left out like one without a sequence (`referenceLeftOut`).
    if (!rule.noSequence && pair.replies.some((reply) => (reply.content?.length ?? 0) > FLIPS_REPLY_MAX_CHARS)) return `${label}: a reference reply is longer than ${FLIPS_REPLY_MAX_CHARS} characters`
    if (pair.replies.some((reply) => !requestCarries(parseJson(reply.request), thinking))) return `${label}: a reference request does not carry its thinking setting`
    const expected = requestShape(flipsRequestBody(reference.draw.model, reference.service, pair.words, rule, thinking))
    if (pair.replies.some((reply) => requestShape(parseJson(reply.request)) !== expected)) return `${label}: the reference was not asked the sellers' request`
  }
  const providers = new Set(reference.pairs.flatMap((pair) => pair.replies.map((reply) => reply.provider)))
  if (!reference.referenceOneProvider && providers.size === 1 && providers.has(null)) return FLIPS_ROUTE_NOT_SUPPORTED
  if (providers.size > 1 || (!reference.referenceOneProvider && providers.has(null))) return 'the reference\'s replies do not come from one proven provider'
  // Replies with no sequence: within the rule's share on every pair, or the reference has no usable sample.
  const withoutSequence = noSequenceOf('reference', reference.pairs, rule)
  if (withoutSequence) return describeNoSequence(withoutSequence)
  // One reasoning profile across both pairs: reasons in at least 90% of the replies, or in at most 10%.
  const replies = reference.pairs.flatMap((pair) => pair.replies)
  const reasoning = reference.pairs.flatMap((pair) => pair.replies.filter((reply) => showsReasoning(reply, pair.words, rule))).length
  if (reasoningProfile(reasoning, replies.length) === 'mixed') {
    return `the reference reasons in ${reasoning} of ${replies.length} replies: neither at most ${FLIPS_REASONING_SHARE.plainAtMost * 100}% nor at least ${FLIPS_REASONING_SHARE.reasonsAtLeast * 100}%`
  }
  return null
}

/**
 * Why a check's slots have no reply, across the whole check: the requests the seller refused (an HTTP 4xx other than
 * 429, which it answers the same way when asked again), with the first refusal's status and text, and the rest that
 * got no reply after every ask.
 */
function describeUnanswered(slots: readonly FlipsSellerSlotV1[]): string {
  const unanswered = slots.filter((slot) => signedExchange(slot.request) === null)
  const refused = unanswered.filter((slot) => signedRequestFailure(slot.request) === 'refused')
  const other = unanswered.filter((slot) => signedRequestFailure(slot.request) !== 'refused')
  const detail = (slot: FlipsSellerSlotV1 | undefined): string => (slot?.request.failureReason ?? 'no reply').replace(/^the seller answered /, '')
  const refusals = refused.length > 0 ? `the seller refused ${refused.length} of ${slots.length} requests (${detail(refused[0])})` : null
  const rest = other.length > 0
    ? `${refusals ? `${other.length} more slot${other.length === 1 ? '' : 's'}` : `${other.length} of ${slots.length} scheduled slots`} got no reply (${detail(other[0])})`
    : null
  return [refusals, rest].filter((part) => part !== null).join(', and ')
}

type FlipsJudged = Pick<FlipsV1, 'outcome' | 'counted' | 'score' | 'scoreMax' | 'p' | 'reason' | 'profileMismatch' | 'reasoningCounts' | 'noSequence' | 'repeats'>

/**
 * The judgement of a FLIPS check from what it stores: outcome, counting, score, p and why. Under a rule with a second
 * look, a first audit scored between its bars is judged on all its replies, its first and its second look's, against
 * the second look's bar; a second look with no result (a slot unanswered, say) leaves the first look's judgement. Pure.
 */
export function judgeFlips(
  record: Pick<FlipsV1, 'draw' | 'service' | 'referenceOneProvider' | 'pairs'> & Pick<Partial<FlipsV1>, 'secondLook' | 'thinking'>,
  rule: FlipsRule = FLIPS_RULE,
): FlipsJudged {
  const stage = record.draw.stage
  const first = judgeLook(record, rule, { replies: rule.repliesPerPair[stage], bar: rule.bar[stage], barName: `the ${stage} bar` })
  if (!flipsSecondLookDue(first, stage, rule) || !record.secondLook) return first
  const more = rule.secondLook!.morePerPair
  const pairs = record.pairs.map((pair, index) => ({ ...pair, seller: [...pair.seller, ...(record.secondLook!.seller[index] ?? [])] }))
  const replies = rule.repliesPerPair[stage] + more
  const second = judgeLook({ ...record, pairs }, rule, { replies, bar: rule.secondLook!.bar, barName: 'the second look\'s bar' })
  if (second.p === null) return { ...first, reason: `${first.reason}; its second look has no result: ${second.reason}` }
  return { ...second, reason: `second look, ${replies * rule.pairsPerCheck} replies: ${second.reason} (first look: ${first.reason})` }
}

/** The thinking setting of each side of a record: its own, or the eval's switch on both sides for a record without one. */
export function flipsThinkingOf(record: Pick<FlipsV1, 'draw'> & Pick<Partial<FlipsV1>, 'thinking'>): FlipsThinkingV1 {
  return record.thinking ?? { seller: flipsFixedSetting(record.draw.model), reference: flipsFixedSetting(record.draw.model) }
}

/** Whether a judged first audit calls for a second look under its rule: scored between its bars. */
export function flipsSecondLookDue(judged: Pick<FlipsV1, 'outcome' | 'p'>, stage: FlipsStage, rule: FlipsRule): boolean {
  return rule.secondLook !== undefined && stage === 'first' && judged.outcome === 'inconclusive' && judged.p !== null
}

/** One look of a check: `replies` seller slots per pair, judged with the calibration of that size against `bar`. */
function judgeLook(
  record: Pick<FlipsV1, 'draw' | 'service' | 'referenceOneProvider' | 'pairs'> & Pick<Partial<FlipsV1>, 'thinking'>,
  rule: FlipsRule,
  look: { replies: number; bar: number; barName: string },
): FlipsJudged {
  // A dry run's probe is a diagnostic: it never counts.
  const counted = flipsCounts(record.draw.model, rule) && !isProbeDraw(record.draw)
  const none = (reason: string) => ({ outcome: 'inconclusive' as const, counted, score: null, scoreMax: null, p: null, reason })
  const replies = look.replies
  if (record.pairs.length !== rule.pairsPerCheck) return none(`${record.pairs.length} word pairs, the rule asks ${rule.pairsPerCheck}`)
  const thinking = flipsThinkingOf(record)
  const problem = flipsReferenceProblem({ draw: record.draw, service: record.service, referenceOneProvider: record.referenceOneProvider, pairs: record.pairs.map((pair) => pair.reference), thinking: thinking.reference }, rule)
  if (problem) {
    // The reference's own replies without a sequence keep their code beside the reason.
    const withoutSequence = noSequenceOf('reference', record.pairs.map((pair) => pair.reference), rule)
    return withoutSequence && describeNoSequence(withoutSequence) === problem ? { ...none(problem), noSequence: withoutSequence } : none(problem)
  }
  const read = []
  for (const pair of record.pairs) {
    const label = `${pair.words[0]}/${pair.words[1]}`
    if (pair.seller.length !== replies) return none(`${label}: ${pair.seller.length} seller slots, the stage asks ${replies}`)
    const expected = requestShape(flipsRequestBody(record.draw.model, record.service, pair.words, rule, thinking.seller))
    const answers = pair.seller.map(sellerAnswer)
    if (answers.some((answer) => answer === null)) return none(describeUnanswered(record.pairs.flatMap((entry) => entry.seller)))
    const signed = answers as NonNullable<(typeof answers)[number]>[]
    // A signed answer with no readable text is never dropped from the sample: the check has no result.
    if (signed.some((answer) => answer.reply.content === null)) return none(`${label}: a signed answer has no readable text`)
    if (signed.some((answer) => answer.thinkBlock)) return none(`${label}: a seller answer writes its reasoning into its text`)
    if (signed.some((answer) => answer.reply.content!.length > FLIPS_REPLY_MAX_CHARS)) return none(`${label}: a seller answer is longer than ${FLIPS_REPLY_MAX_CHARS} characters`)
    if (signed.some((answer) => !requestCarries(answer.requestBody, thinking.seller))) return none(`${label}: a seller request does not carry its thinking setting`)
    if (signed.some((answer) => requestShape(answer.requestBody) !== expected)) return none(`${label}: a seller request is not the reference's`)
    read.push({ pair, answers: signed })
  }
  // Each side carried the setting it names. The seller's discovery tried the reference's first, then its nearest
  // equivalent (`"low"` for `"minimal"`); a seller that took neither was asked otherwise, and its sample is not one the
  // reference's can judge.
  if (asksAsReference(thinking) && !askedAsReference(thinking.seller, thinking.reference)) {
    return none(`${FLIPS_NOT_ASKED_AS_REFERENCE}: the seller was asked with ${describeSetting(thinking.seller)}, the reference with ${describeSetting(thinking.reference)}`)
  }
  // The reasoning profile, across both pairs and in both directions: the seller's must be the reference's. Honest hosts
  // that ignore the reasoning setting land here, and so do swaps that reason where the claimed model does not; each
  // case keeps its own code and the counts of both sides, so the dry run decides on those numbers whether it stays so.
  const referenceReplies = record.pairs.flatMap((pair) => pair.reference.replies)
  const sellerAnswers = read.flatMap((entry) => entry.answers)
  const referenceReasoning = record.pairs.flatMap((pair) => pair.reference.replies.filter((reply) => showsReasoning(reply, pair.words, rule))).length
  const sellerReasoning = read.flatMap(({ pair, answers }) => answers.filter((answer) => showsReasoning({ ...answer.reply, reasoning: answer.reasoning }, pair.words, rule))).length
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
  // Under a rule with `noSequence`, replies that hold no sequence are left out on both sides; the check keeps its
  // scheduled size for the calibration.
  const kept = (reply: FlipsReplyV1, pair: FlipsPair) => !holdsNoSequence(reply, pair, rule)
  const samples = read.map(({ pair, answers }) => ({
    pair: pair.words,
    reference: pair.reference.replies.map((reply) => ({ content: reply.content, finishReason: reply.finishReason })).filter((reply) => !referenceLeftOut(reply, pair.words, rule)),
    seller: answers.map((answer) => answer.reply).filter((reply) => kept(reply, pair.words)),
  }))
  const scheduled = replies * rule.pairsPerCheck
  // The seller's own gates: too many replies without a sequence, or repeated replies. Each withholds the result.
  const withheld = ((): Pick<FlipsV1, 'reason' | 'noSequence' | 'repeats'> | null => {
    const withoutSequence = noSequenceOf('seller', read.map(({ pair, answers }) => ({ words: pair.words, replies: answers.map((answer) => answer.reply) })), rule)
    if (withoutSequence) return { reason: describeNoSequence(withoutSequence), noSequence: withoutSequence }
    // Repeated replies, among the replies with a sequence: one stored answer is no sample of the model.
    if (!rule.repeats) return null
    for (const { pair, answers } of read) {
      const texts = (list: readonly FlipsReplyV1[], keep: (reply: FlipsReplyV1) => boolean) => list.filter(keep).map((reply) => reply.content!.trim())
      const seller = texts(answers.map((answer) => answer.reply), (reply) => kept(reply, pair.words))
      const share = repeatShare(seller)
      if (seller.length >= rule.repeats.minReplies && share >= rule.repeats.sellerShare && repeatShare(texts(pair.reference.replies, (reply) => !referenceLeftOut(reply, pair.words, rule))) < rule.repeats.referenceShare) {
        const repeats: FlipsRepeats = {
          code: 'seller-repeats', words: [pair.words[0], pair.words[1]], repeated: seller.length - new Set(seller).size, replies: seller.length,
          responseIds: [...new Set(answers.flatMap((answer) => (answer.responseId === null ? [] : [answer.responseId])))],
        }
        return { reason: `${pair.words[0]}/${pair.words[1]}: ${repeats.repeated} of ${repeats.replies} seller replies repeat another reply exactly (${repeats.responseIds.length} response id${repeats.responseIds.length === 1 ? '' : 's'})`, repeats }
      }
    }
    return null
  })()
  if (sellerProfile !== referenceProfile) {
    const code = sellerProfile === 'mixed' ? 'seller-mixed' as const : sellerProfile === 'reasons' ? 'seller-reasons' as const : 'seller-does-not-reason' as const
    // Where the profile is the only reason left, the score it would have had is kept beside it for the dry run, apart
    // from the outcome fields; none when a gate of the seller's own would withhold the result too.
    const ignoring = withheld ? null : judgeFlipsCheck(samples, rule, scheduled)
    const mismatch: FlipsProfileMismatch = {
      code, ...reasoningCounts,
      diagnosticScoreIgnoringProfile: ignoring && ignoring.outcome === 'scored' && ignoring.score !== null && ignoring.p !== null
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
  if (withheld) {
    const { reason, ...codes } = withheld
    return { ...none(reason), ...codes, reasoningCounts }
  }
  const judged = judgeFlipsCheck(samples, rule, scheduled)
  if (judged.outcome !== 'scored' || judged.p === null || judged.score === null) return { ...none(judged.reasons.join('; ') || 'no score'), reasoningCounts }
  const p = judged.p
  const outcome: FlipsOutcome = p <= look.bar ? 'flag' : p > rule.passAbove ? 'pass' : 'inconclusive'
  const reason = outcome === 'flag'
    ? `scored ${judged.score.toFixed(2)} (p ${p.toExponential(2)}), at most ${look.barName} ${look.bar}`
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
    ...flipsSellerSlots(record).map((slot) => ({ requestCount: slot.request.requestIds.length, attemptCosts: slot.request.attemptCosts })),
    // A dry run's follow-up is paid for by the same audit.
    ...(record.followUp ? flipsPaidRequests(record.followUp) : []),
  ]
}

/** Every seller slot of a check in order: each pair's, then its second look's, pair by pair. */
export function flipsSellerSlots(record: Pick<FlipsV1, 'pairs' | 'secondLook'>): FlipsSellerSlotV1[] {
  return [...record.pairs.flatMap((pair) => pair.seller), ...(record.secondLook?.seller.flat() ?? [])]
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
  // Each side's setting is one its declaration allows (`FLIPS_THINKING`): the seller's own discovered setting, or its
  // bank's when its discovery failed; the reference's bank setting, or the eval's switch for the model. The judge below
  // holds every signed seller request and every stored reference request to them (`requestCarries`).
  if (!record.thinking) throw new Error('a FLIPS check does not name the thinking setting of its requests')
  if (!isAllowedSetting(record.thinking.seller, { discovery: true, bank: true })) throw new Error('a FLIPS check names a seller thinking setting its rule does not allow')
  if (!isAllowedSetting(record.thinking.reference, { bank: true, fixed: flipsFixedSetting(record.draw.model) })) {
    throw new Error('a FLIPS check names a reference thinking setting its rule does not allow')
  }
  // Its discovery rule is one this build knows, each judged by its own (`judgeFlips`); none for a record made before.
  const discoveryRule = record.thinking.discoveryRule
  if (discoveryRule !== undefined && !(THINKING_DISCOVERY_RULES as readonly string[]).includes(discoveryRule)) {
    throw new Error(`a FLIPS check names an unknown thinking discovery rule ${String(discoveryRule)}`)
  }
  const drawn = drawFlipsPairs(record.draw, rule)
  if (canonicalJsonStringify(drawn) !== canonicalJsonStringify(record.pairs.map((pair) => pair.words))) {
    throw new Error('the FLIPS pairs are not the ones its draw gives')
  }
  if (record.pairs.some((pair) => canonicalJsonStringify(pair.reference.words) !== canonicalJsonStringify(pair.words))) {
    throw new Error('a FLIPS reference pair is not the pair it is stored with')
  }
  const ids = new Set<string>()
  for (const slot of flipsSellerSlots(record)) {
    for (const id of slot.request.requestIds) {
      if (ids.has(id)) throw new Error('a FLIPS request is counted more than once')
      ids.add(id)
    }
  }
  // A second look is stored exactly when its rule and the first look call for one: never under a rule without it,
  // and always for a first audit scored between its bars, so no record leaves out the look that would decide it.
  const second = record.secondLook
  if (second !== undefined && !rule.secondLook) throw new Error('a FLIPS check stores a second look its rule does not have')
  if (rule.secondLook) {
    const due = flipsSecondLookDue(judgeFlips({ ...record, secondLook: undefined }, rule), record.draw.stage, rule)
    if (due && !second) throw new Error('a FLIPS check scored between its bars does not store its second look')
    if (!due && second) throw new Error('a FLIPS check stores a second look its first look does not call for')
    if (second && (second.seller.length !== record.pairs.length || second.seller.some((slots) => slots.length > rule.secondLook!.morePerPair))) {
      throw new Error('a FLIPS second look holds other slots than its rule asks')
    }
  }
  if (second && (!Number.isInteger(second.reasks) || second.reasks < 0 || record.reasks + second.reasks > FLIPS_REASK_BUDGET)) {
    throw new Error('a FLIPS check re-asks more slots than its budget')
  }
  // Re-asks keep to the budget, and, where the asks are stored, each one follows an ask that got no reply.
  if (!Number.isInteger(record.reasks) || record.reasks < 0 || record.reasks > FLIPS_REASK_BUDGET) throw new Error('a FLIPS check re-asks more slots than its budget')
  const slots = flipsSellerSlots(record)
  // A record of a rule that requires them stores the asks of every slot: a record without them never skips the trail.
  if (rule.asksRequired && slots.some((slot) => !Array.isArray(slot.asks) || slot.asks.length === 0)) throw new Error('a FLIPS slot does not store its asks')
  if (slots.some((slot) => slot.asks !== undefined)) {
    // Re-asks of the first look's slots are `reasks`, those of the second look's its own.
    const reaskedOf = (list: readonly FlipsSellerSlotV1[]): number => list.reduce((total, slot) => total + Math.max(0, (slot.asks?.length ?? 1) - 1), 0)
    if (second && reaskedOf(second.seller.flat()) !== second.reasks) throw new Error('a FLIPS second look\'s re-asks are not the ones its slots store')
    for (const slot of slots) {
      const asks = slot.asks
      if (!asks || asks.length === 0 || asks[0]!.reason !== 'scheduled') throw new Error('a FLIPS slot does not start with its scheduled ask')
      for (let index = 1; index < asks.length; index += 1) {
        if (asks[index]!.reason !== 'no-reply' || asks[index - 1]!.answered) throw new Error('a FLIPS slot was asked again after a reply')
        if (asks[index]!.sentAt < asks[index - 1]!.sentAt) throw new Error('a FLIPS slot\'s asks are out of order')
      }
      if (canonicalJsonStringify(asks.flatMap((entry) => entry.requestIds)) !== canonicalJsonStringify(slot.request.requestIds)
        || canonicalJsonStringify(asks.flatMap((entry) => entry.attemptCosts)) !== canonicalJsonStringify(slot.request.attemptCosts)) {
        throw new Error('a FLIPS slot\'s asks are not its requests')
      }
      if (asks.at(-1)!.answered !== (signedExchange(slot.request) !== null)) throw new Error('a FLIPS slot\'s last ask is not its reply')
      // The signed reply is the last ask's own: its request ID is one of that ask's, not any of the slot's.
      const replyId = slot.request.responseAuth?.requestId
      if (asks.at(-1)!.answered && (typeof replyId !== 'string' || !asks.at(-1)!.requestIds.includes(replyId))) {
        throw new Error('a FLIPS slot\'s signed reply is not its last ask\'s')
      }
    }
    if (reaskedOf(record.pairs.flatMap((pair) => pair.seller)) !== record.reasks) throw new Error('a FLIPS check\'s re-asks are not the ones its slots store')
  }
  if (record.followUp) {
    validateFlips(record.followUp)
    if (!isProbeDraw(record.followUp.draw)) throw new Error('a FLIPS follow-up is not marked as a probe')
  }
  const again = judgeFlips(record, rule)
  if (again.outcome !== record.outcome || again.counted !== record.counted) throw new Error('the FLIPS outcome does not follow from its replies')
  if (canonicalJsonStringify(again.noSequence ?? null) !== canonicalJsonStringify(record.noSequence ?? null)) {
    throw new Error('the FLIPS replies without a sequence are not the ones its replies give')
  }
  if (canonicalJsonStringify(again.repeats ?? null) !== canonicalJsonStringify(record.repeats ?? null)) {
    throw new Error('the FLIPS repeated replies are not the ones its replies give')
  }
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
  /** The setting every reference request carries (`FLIPS_THINKING`). */
  thinking: ThinkingSetting
}): Promise<FlipsReferenceV1> {
  const rule = input.rule ?? FLIPS_RULE
  const now = input.now ?? Date.now
  const bodies = input.pairs.flatMap((pair) => Array.from({ length: rule.referenceRepliesPerPair }, () => flipsRequestBody(input.model, input.service, pair, rule, input.thinking)))
  const startedAt = now()
  const first = await input.ask(bodies)
  // A reference request that got no reply at all is an outage on the auditor's side, never a sample. The requests with
  // no reply are asked once more, inside the reference's own time; if the reference is still not whole it fails, and
  // where FLIPS counts no seller of the stage is started this run (`flipsReferenceDecision`). A reply that came back but
  // cannot be used (unreadable, another provider, no sequence) stays the sample's problem.
  const noReply = (result: (typeof first.results)[number] | undefined) => result === undefined || result.failure !== null || result.response === null || result.response.statusCode !== 200
  if (first.results.length !== bodies.length) throw new Error(`the reference returned ${first.results.length} replies for ${bodies.length} requests`)
  const missing = bodies.flatMap((_body, index) => (noReply(first.results[index]) ? [index] : []))
  const results = [...first.results]
  if (missing.length > 0) {
    const again = await input.ask(missing.map((index) => bodies[index]!))
    for (const [position, index] of missing.entries()) {
      const retry = again.results[position]
      const earlier = results[index]!
      if (retry && !noReply(retry)) {
        results[index] = { ...retry, tries: (earlier.tries ?? 1) + (retry.tries ?? 1), rateLimited: (earlier.rateLimited ?? 0) + (retry.rateLimited ?? 0) }
      }
    }
  }
  const unanswered = results.filter(noReply)
  if (unanswered.length > 0) {
    throw new Error(`the reference answered ${bodies.length - unanswered.length} of its ${bodies.length} requests after asking the rest again`
      + `${unanswered[0]?.failure ? ` (${unanswered[0].failure.slice(0, 200)})` : ''}`)
  }
  const asked = { ...first, results }
  const finishedAt = now()
  const decoder = new TextDecoder()
  return {
    stage: input.stage,
    thinking: input.thinking,
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
        // Only valid bounds: a clock that stepped back during the call gives none, and the stamp is left out.
        ...(Number.isSafeInteger(startedAt) && Number.isSafeInteger(finishedAt) && startedAt >= 0 && finishedAt >= startedAt
          ? { referenceBatch: { startedAt, finishedAt } } : {}),
        replies: results.map((result) => {
          const answer = readFlipsAnswer(result.response)
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

/**
 * What a stage's reference means for a seller's audit, decided once per model, stage and run before anything paid:
 * - `ready`: the reference is whole (or FLIPS does not count here): the audit runs.
 * - `without-flips`: where FLIPS counts and the reference is not whole after its one re-ask, FLIPS is not active for the
 *   model this run: every audit of the stage runs with the questions and the other tests, and FLIPS keeps no record, its
 *   reason the reference's (`flips-status.json`, `flipsWithoutRecord`). A reference never holds a model back.
 * - `not-started`: only a confirmation of a report only FLIPS flagged, which could decide nothing without FLIPS: it is
 *   not started (`FLIPS_AUDITOR_FAILURE`, nothing paid), the auditor's attempt, and the next run asks again.
 */
export type FlipsReferenceDecision = 'ready' | 'not-started' | 'without-flips'
export function flipsReferenceDecision(input: { whole: boolean; counts: boolean; probing: boolean; confirming: readonly string[] }): FlipsReferenceDecision {
  if (input.whole || !input.counts || input.probing) return 'ready'
  const onlyFlips = input.confirming.length > 0 && input.confirming.every((check) => check === 'flips')
  return onlyFlips ? 'not-started' : 'without-flips'
}

/** The text an audit not started for its reference fails with: blamed on the auditor (`failure-blame.ts`). */
export const FLIPS_AUDITOR_FAILURE = 'the randomness check could not run on the auditor\'s side'
/**
 * The detail of `FLIPS_AUDITOR_FAILURE` for a confirmation of a report only FLIPS flagged whose stage's reference is not
 * whole this run: what the run and the report show.
 */
export const FLIPS_WAITING_FOR_REFERENCE = 'waiting for its reference: it was not whole this run, so the audit was not started and nothing was paid'

/** Slots asked again in one check, at most: only slots that got no reply at all after a failure that can pass. */
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

/** One seller's FLIPS on a prepared reference. Rejects only when its signal ends while the seller's slots are out. */
export async function runFlips(input: {
  seller: Omit<SignedSellerRequestInput, 'peerId' | 'service' | 'serviceAliases'> & { peerId: string; service: string; serviceAliases?: readonly string[] }
  draw: FlipsDrawV1
  reference: FlipsReferenceV1
  /** The setting every seller request carries: the seller's own (`FLIPS_THINKING`). */
  sellerThinking: ThinkingSetting
  rule?: FlipsRule
  now?: () => number
}): Promise<FlipsV1> {
  const rule = input.rule ?? FLIPS_RULE
  const replies = rule.repliesPerPair[input.draw.stage]
  const ask = (pair: FlipsPair, onSend: () => void) => askSellerSigned(
    { ...input.seller, serviceAliases: input.seller.serviceAliases ?? [], onSend } as SignedSellerRequestInput,
    flipsRequestBody(input.draw.model, input.seller.service, pair, rule, input.sellerThinking),
  )
  const answered = (request: SignedSellerRequestV1): boolean => signedExchange(request) !== null
  const now = input.now ?? Date.now
  const asked = async (pair: FlipsPair, reason: FlipsSlotAskV1['reason']) => {
    // When the request leaves, after any wait for a slot of the limiter: the time the seller had it.
    let sentAt: number | null = null
    const request = await ask(pair, () => { sentAt ??= now() })
    const entry: FlipsSlotAskV1 = { reason, sentAt: sentAt ?? now(), requestIds: [...request.requestIds], attemptCosts: [...request.attemptCosts], answered: answered(request) }
    return { request, entry }
  }
  const scheduled = (words: FlipsPair, count: number): Promise<FlipsSellerSlotV1[]> => Promise.all(Array.from({ length: count }, async () => {
    const first = await asked(words, 'scheduled')
    return { request: first.request, asks: [first.entry] }
  }))
  // The slots with no reply after a failure that can pass are asked again, one at a time, within `budget` re-asks; a
  // refusal (an HTTP 4xx other than 429) gives the same answer and is not. Returns the re-asks made.
  const askAgain = async (words: FlipsPair, slots: readonly FlipsSellerSlotV1[], budget: number): Promise<number> => {
    let made = 0
    for (const slot of slots) {
      while (signedRequestFailure(slot.request) === 'may-pass' && made < budget && !input.seller.signal?.aborted) {
        made += 1
        const again = await asked(words, 'no-reply')
        // The tries of a slot are paid for and counted, so they stay with it, each ask in order.
        slot.request = {
          ...again.request,
          requestIds: [...slot.request.requestIds, ...again.request.requestIds],
          attemptCosts: [...slot.request.attemptCosts, ...again.request.attemptCosts],
        }
        slot.asks = [...slot.asks ?? [], again.entry]
      }
    }
    return made
  }
  const pairs: FlipsPairV1[] = await Promise.all(input.reference.pairs.map(async (reference) => ({
    words: reference.words,
    reference,
    seller: await scheduled(reference.words, replies),
  })))
  let reasks = 0
  for (const pair of pairs) reasks += await askAgain(pair.words, pair.seller, FLIPS_REASK_BUDGET - reasks)
  const stored = {
    rule: rule.id,
    draw: input.draw,
    service: input.seller.service,
    referenceUpstream: input.reference.upstream,
    referenceOneProvider: input.reference.oneProvider,
    thinking: { seller: input.sellerThinking, reference: input.reference.thinking, discoveryRule: THINKING_DISCOVERY_RULE },
    pairs,
    reasks,
  }
  const first = judgeFlips(stored, rule)
  if (!flipsSecondLookDue(first, input.draw.stage, rule)) return { ...stored, ...first }
  // Between the bars on a first audit: each pair is asked its second look's slots, and the check is judged on all its
  // replies. The re-asks of both looks share the one budget. A second look the audit's time cuts short has no result,
  // and the first look's score stands.
  const more = await Promise.all(pairs.map((pair) => scheduled(pair.words, rule.secondLook!.morePerPair)))
  let secondReasks = 0
  for (const [index, pair] of pairs.entries()) secondReasks += await askAgain(pair.words, more[index]!, FLIPS_REASK_BUDGET - reasks - secondReasks)
  const secondLook: FlipsSecondLookV1 = { seller: more, reasks: secondReasks }
  return { ...stored, secondLook, ...judgeFlips({ ...stored, secondLook }, rule) }
}

/** How long one seller's FLIPS may take, its seller slots at a time, and the reference's own limit. */
export const FLIPS_TIME_LIMIT_MS = 5 * 60_000
export const FLIPS_SLOTS_AT_ONCE = 2
/**
 * The reference's own limit, from when it is asked to its last answer, its re-ask included. It is sized to what is asked: a
 * stage's 80 requests, and both stages' 160 when a run confirms FLIPS too, through the model's own FLIPS reference limiter
 * (`flips-run.ts`) at the default 6 requests at once per model, at 15 seconds a request: 27 rounds take under 7 minutes,
 * and the re-ask of a few holes the rest. Each model has its own limiter, so no model's reference waits behind
 * another's. A reference that is still not whole at it leaves FLIPS not active for the model this run
 * (`flipsReferenceDecision`).
 */
export const FLIPS_REFERENCE_TIME_LIMIT_MS = 8 * 60_000

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
  /** The rule this screen asks by: a carried record of another rule is asked again. */
  ruleId: string
  /**
   * The decision on a stage's reference, made once per model, stage and run before any seller of it is asked anything
   * paid (`flipsReferenceDecision`). Where FLIPS counts it waits for the reference (at most `FLIPS_REFERENCE_TIME_LIMIT_MS`);
   * elsewhere it starts it and returns 'ready' at once.
   */
  referenceDecision?: (stage: FlipsStage, service: string, settings: Settings, audit: { confirming: readonly string[] }) => Promise<FlipsReferenceDecision>
  /** The probe's settings (canonical JSON), null without one: a carried probe of other settings is asked again. */
  probeSettings: string | null
  /** Asks the reference of a stage now, while the questions run; its failure is reported, never thrown. */
  warm: (service: string, settings: Settings, stage: FlipsStage) => void
  check: (
    seller: { peerId: string; service: string; serviceAliases?: readonly string[] },
    settings: Settings,
    options: {
      stage: FlipsStage
      /** The seller's own thinking setting (`FLIPS_THINKING`, resolved by the audit). */
      sellerThinking: ThinkingSetting
      clock?: SignedSellerRequestInput['clock']
      signal?: AbortSignal
    },
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
  /** The setting the reference is asked with for a question set's bank (`FLIPS_THINKING`, `resolveThinking`). */
  referenceThinking: (settings: Settings) => ThinkingSetting
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
        ask: (bodies) => input.ask(settings)(bodies, signal), rule, thinking: input.referenceThinking(settings),
      }).then((prepared) => {
        try {
          input.onReady?.(prepared)
        } catch {
          // Storing the reference beside the audits is best effort.
        }
        // Checked as soon as it is ready, so an unusable reference is reported even when no seller reaches FLIPS.
        const problem = flipsReferenceProblem({ draw, service, referenceOneProvider: prepared.oneProvider, pairs: prepared.pairs, thinking: prepared.thinking }, rule)
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
      run: <T>(task: () => Promise<T>) => untilTimeUp(own.run(started(() => input.limiter.run(started(task)))), signal),
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
    const prepared = await untilTimeUp(referenceFor(kind, seller.service, settings), signal)
    const problem = flipsReferenceProblem({ draw, service: seller.service, referenceOneProvider: prepared.oneProvider, pairs: prepared.pairs, thinking: prepared.thinking }, rule)
    const stored = {
      rule: rule.id, draw, service: seller.service, referenceUpstream: prepared.upstream, referenceOneProvider: prepared.oneProvider,
      thinking: { seller: options.sellerThinking, reference: prepared.thinking, discoveryRule: THINKING_DISCOVERY_RULE },
    }
    if (problem) {
      // The reference is checked before the seller is asked: an unusable one costs the seller nothing.
      unavailable({ stage: kind, code: problem === FLIPS_ROUTE_NOT_SUPPORTED ? 'route-not-supported' : 'reference-unusable', detail: problem })
      const pairs = prepared.pairs.map((reference) => ({ words: reference.words, reference, seller: [] }))
      return { ...stored, pairs, reasks: 0, ...judgeFlips({ ...stored, pairs }, rule), reason: problem }
    }
    // From here on FLIPS waits on the seller: a failure is the seller's time, and FLIPS has no result (`check`).
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
      sellerThinking: options.sellerThinking,
      rule,
    })
  }
  return {
    probing,
    ruleId: rule.id,
    async referenceDecision(stage, service, settings, audit) {
      const kind = probe?.stage ?? stage
      const counts = flipsCounts(input.model, rule)
      let whole = true
      const asked = (() => {
        try {
          return referenceFor(kind, service, settings)
        } catch (error) {
          unavailable({ stage: kind, code: 'reference-failed', detail: errorText(error) })
          return null
        }
      })()
      if (!counts || probing) {
        // Recorded only: never waited for; FLIPS has no result when it fails.
        asked?.catch(() => undefined)
        return 'ready'
      }
      if (asked === null) whole = false
      else await asked.then(() => undefined, () => { whole = false })
      return flipsReferenceDecision({ whole, counts, probing, confirming: audit.confirming })
    },
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
        // A failure of FLIPS never fails the audit: whether its reference is whole was decided before the seller was
        // asked anything paid (`referenceDecision`). A failure here (the seller's slots ran out FLIPS's time, or the
        // auditor's last attempt runs without a whole reference) is no result, and the other tests stand.
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

/** Waits for `promise`, or rejects once FLIPS's time is up (`signal`). */
function untilTimeUp<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return untilAborted(promise, signal, 'the randomness check\'s time is up')
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

/**
 * FLIPS's block of the rules fingerprint (`RecordCheck.fingerprint`), with the fixed inputs it is judged on below: a
 * change to its rule, a limit or what the code gives for one of these inputs changes the pinned rules hash. Its
 * description adds what its own reading of a summary gives (`FLIPS_CHECK`).
 */
export function flipsFingerprint(): Record<string, unknown> {
  // The randomness check (FLIPS): its rule (bars, pass, sizes, calibration, which models count), the eval's request of
  // each model, the word list and its two pools, and what a fixed draw gives.
  return {
    rule: FLIPS_RULE,
    requests: FLIPS_REQUESTS,
    words: FLIPS_WORDS,
    pools: [flipsPool('first'), flipsPool('confirm')],
    draw: (['first', 'confirm'] as const).map((stage) => drawFlipsPairs({ auditor: '0x00', model: 'sample', epoch: '1', seed: flipsSeed('00', { model: 'sample', epoch: '1', runId: 'r', stage }), stage })),
    reaskBudget: FLIPS_REASK_BUDGET,
    // Each side's own thinking setting in a FLIPS body (`FLIPS_THINKING`): the eval's switch, a discovered field, a prefill.
    bodies: [flipsFixedSetting('sample'), strategySetting('disable-thinking'), strategySetting('prefill'), strategySetting('bare')]
      .map((thinking) => flipsRequestBody('kimi-k3', 'svc', ['amber', 'basin'], FLIPS_RULE, thinking)),
    // Which first looks call for a second look: a first audit scored between its bars, and nothing else.
    secondLookDue: ([['inconclusive', 0.05, 'first'], ['inconclusive', null, 'first'], ['flag', 0.001, 'first'], ['pass', 0.5, 'first'], ['inconclusive', 0.05, 'confirm']] as const)
      .map(([outcome, p, stage]) => flipsSecondLookDue({ outcome, p }, stage, FLIPS_RULE)),
    reasoningShare: FLIPS_REASONING_SHARE,
    replyMaxChars: FLIPS_REPLY_MAX_CHARS,
    // A follow-up draw leaves out its first check's pairs.
    followUpDraw: drawFlipsPairs({ auditor: '0x00', model: 'sample', epoch: '1', seed: '00', stage: 'confirm', probe: true, excluding: flipsPool('confirm').slice(0, 2) }),
    limits: [FLIPS_TIME_LIMIT_MS, FLIPS_SLOTS_AT_ONCE, FLIPS_REFERENCE_TIME_LIMIT_MS],
    // One scored sample through the scorer: fixed symbol strings on both sides of one pair each.
    scored: (() => {
      const seq = (seed: number) => Array.from({ length: 64 }, (_, index) => ((seed * 7 + index * index * 3 + index) % 5) % 2 ? 'basin' : 'amber').join(' ')
      const pairs = (['first', 'second'] as const).map((_, pairIndex) => ({
        pair: (pairIndex === 0 ? ['amber', 'basin'] : ['amber', 'basin']) as [string, string],
        reference: Array.from({ length: 40 }, (_, index) => ({ content: seq(index + pairIndex * 50), finishReason: 'stop' })),
        seller: Array.from({ length: 10 }, (_, index) => ({ content: seq(index * 3 + 7 + pairIndex), finishReason: 'stop' })),
      }))
      const judged = judgeFlipsCheck(pairs)
      return [judged.outcome, judged.score === null ? null : Number(judged.score.toFixed(9)), judged.p === null ? null : Number(judged.p.toExponential(6))]
    })(),
    counts: ['minimax-m3', 'claude-opus-5.5', 'unmeasured-model'].map((model) => flipsCounts(model)),
    // What a stage's reference means for an audit, decided once per run before anything paid: run, not started, or run
    // with FLIPS at no result on the auditor's last attempt (never for a report only FLIPS flagged).
    referenceDecision: [false, true].flatMap((whole) => [false, true].flatMap((counts) => [false, true].flatMap((probing) => (
      [[], ['flips'], ['kbf', 'flips']].map((confirming) => flipsReferenceDecision({ whole, counts, probing, confirming })))))),
    // One judged record through each branch of the judge: placeholders cut at the limit, replies without a sequence on
    // either side, repeated replies, and an over-long reference reply left out.
    judged: SAMPLE_FLIPS_CHECKS.map(([name, edit]) => {
      const judged = judgeFlips(sampleFlipsRecord(edit))
      return [name, judged.outcome, judged.p === null ? null : Number(judged.p.toExponential(6)), judged.noSequence?.code ?? null,
        judged.repeats?.code ?? null, judged.profileMismatch?.code ?? null]
    }),
    // A seller asked with another setting than the reference: no result under the reference-first discovery rule, judged
    // as before under the rule before it. Each pair of sides, by discovery rule (none, the old one, this build's).
    askedAsReference: ([undefined, ...THINKING_DISCOVERY_RULES] as const).map((discoveryRule) => {
      const fixed = flipsFixedSetting('claude-opus-5.5')
      // The eval's switch for the model is effort minimal: the same request from discovery, its nearest equivalent (effort
      // low), then a different one.
      return [strategySetting('reasoning-effort-minimal'), strategySetting('reasoning-effort-low'), strategySetting('disable-thinking')].map((seller) => {
        const judged = judgeFlips({ ...sampleFlipsRecord(() => undefined, seller), thinking: { seller, reference: fixed, ...(discoveryRule ? { discoveryRule } : {}) } })
        return [discoveryRule ?? null, judged.outcome, judged.reason.startsWith(FLIPS_NOT_ASKED_AS_REFERENCE)]
      })
    }),
  }
}

/** The judge's branches, each one edit of a plain sample check (`sampleFlipsRecord`). */
type FlipsSampleEdit = (pair: { seller: Array<{ content: string; finishReason: string }>; reference: Array<{ content: string; finishReason: string }> }, index: number) => void
const SAMPLE_FLIPS_CHECKS: ReadonlyArray<readonly [string, FlipsSampleEdit]> = [
  ['plain', () => undefined],
  ['placeholders cut at the limit', (pair) => { for (const reply of pair.seller) Object.assign(reply, { content: '[No answer]', finishReason: 'length' }) }],
  ['seller replies without a sequence', (pair, index) => { if (index === 0) for (const reply of pair.seller.slice(0, 3)) reply.content = 'no.' }],
  ['reference replies without a sequence', (pair, index) => { if (index === 0) for (const reply of pair.reference.slice(0, 9)) reply.content = 'no.' }],
  ['repeated seller replies', (pair, index) => { if (index === 1) for (const reply of pair.seller.slice(1, 6)) reply.content = pair.seller[0]!.content }],
  ['an over-long reference reply', (pair, index) => { if (index === 0) pair.reference[0]!.content = 'amber '.repeat(1_100) }],
]

/**
 * A first-stage FLIPS check of fixed replies, the seller's signed, edited by one sample, to judge under this build. The
 * seller's requests carry `sellerThinking`, the eval's switch by default, as the reference's always do.
 */
function sampleFlipsRecord(edit: FlipsSampleEdit, sellerThinking?: ThinkingSetting): Pick<FlipsV1, 'draw' | 'service' | 'referenceOneProvider' | 'pairs'> {
  const model = 'claude-opus-5.5'
  const draw = { auditor: '0x00', model, epoch: '1', seed: '00', stage: 'first' as const }
  // A fixed pseudo-random sequence per reply (xorshift32 from its seed): no two replies of a side repeat.
  const sequence = (seed: number, pair: readonly [string, string]) => {
    let state = (seed + 1) * 2_654_435_761 >>> 0
    return Array.from({ length: 64 }, () => {
      state ^= state << 13; state >>>= 0
      state ^= state >>> 17
      state ^= state << 5; state >>>= 0
      return pair[state & 1]
    }).join(' ')
  }
  const encoder = new TextEncoder()
  return {
    draw, service: model, referenceOneProvider: true,
    pairs: drawFlipsPairs(draw).map((words, pairIndex) => {
      const replies = {
        seller: Array.from({ length: FLIPS_RULE.repliesPerPair.first }, (_, index) => ({ content: sequence(index * 3 + 7 + pairIndex, words), finishReason: 'stop' })),
        reference: Array.from({ length: FLIPS_RULE.referenceRepliesPerPair }, (_, index) => ({ content: sequence(index + pairIndex * 50, words), finishReason: 'stop' })),
      }
      edit(replies, pairIndex)
      const body = flipsRequestBody(model, model, words)
      const sellerBody = sellerThinking ? flipsRequestBody(model, model, words, FLIPS_RULE, sellerThinking) : body
      return {
        words,
        reference: {
          words,
          replies: replies.reference.map((reply) => ({ ...reply, provider: 'host', reasoning: false, thinkBlock: false, failure: null, request: JSON.stringify(body) })),
        },
        seller: replies.seller.map((reply, slot) => {
          const id = `sample-${pairIndex}-${slot}`
          const answer = { id, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply.content }, finish_reason: reply.finishReason }], usage: { prompt_tokens: 60, completion_tokens: 130 } }
          return {
            request: {
              requestIds: [id], statusCode: 200, failureReason: null,
              attemptCosts: [{ inputTokens: 60, outputTokens: 130, totalTokens: 190, estimatedCostUsd: 0 }],
              responseAuth: {
                requestId: id, status: 'verified', failureReason: null,
                record: { requestId: id, sellerPeerId: 'sample', advertisedService: model },
                signedPreimages: {
                  encoding: 'antseed-http-codec-v1', signatureEncoding: 'antseed-response-auth-signing-v1',
                  requestBase64: Buffer.from(encodeHttpRequest({ requestId: id, method: 'POST', path: '/v1/chat/completions', headers: {}, body: encoder.encode(JSON.stringify(sellerBody)) })).toString('base64'),
                  responseBase64: Buffer.from(encodeHttpResponse({ requestId: id, statusCode: 200, headers: {}, body: encoder.encode(JSON.stringify(answer)) })).toString('base64'),
                  responseAuthSigningBase64: 'AA==', requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}`,
                },
              },
            } as never,
          }
        }),
      }
    }),
  }
}
