import { randomInt } from 'node:crypto'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { isSafeProbe } from '@antseed/node/payments'
import { outputCheckRequestBody, parseObject, readOutput, requestCarriesPrompt, type OutputReadingV1, type OutputRequestThinking } from '../shared/output-usage.js'
import { costOfRequests, requestCountOf, type AuditCostSummaryV1, type PaidRequest } from '../../proxy-evidence.js'
import {
  SIGNED_REQUEST_RETRY_WAIT,
  SIGNED_REQUEST_TRIES,
  signedRequestFailure,
  signedRetryWaitMs,
  askSellerSigned,
  assertRequestIdentities,
  signedExchange,
  type SignedSellerRequestInput,
  type SignedSellerRequestV1,
} from '../shared/signed-seller-request.js'
import {
  fixedSequence,
  generateTokenizerProbe,
  measureTokenizerReference,
  referenceDelta,
  TOKENIZER_PRECHECK_RULE,
  type TokenizerPrecheckRule,
  type TokenizerReferenceAsk,
  type TokenizerReferenceRoundV1,
} from '../tokens/tokenizer-precheck.js'

/**
 * The cap check, rule `output-cap-v1`: does a seller bill beyond the reply limit it was given?
 *
 * The seller is asked for a long, plain answer under a small limit. Billed output above the limit is
 * not enough: some hosts honestly bill reasoning outside it, and usage fields can be relabelled. The
 * flag rests on what the seller delivered under its signature: its visible answer, measured in the
 * model's tokenizer at this epoch's reference (A, then A + answer, as the tokenizer pre-check measures
 * text), must be more than twice the limit, and again when asked again. An honest engine stops at the
 * limit, so its answer measures the limit or less. The check applies to a model only when its own host keeps the
 * lowest limit and shows that a measured answer means what it says (`prepareOutputCapReference`).
 *
 * Every constant is here, frozen, with its source. Inconclusive never flags.
 */
export interface OutputCapRule {
  id: 'output-cap-v1'
  /** Reply limits are drawn from this range, inclusive. Chosen; the evals used 16. */
  minCap: number
  maxCap: number
  /** Tokens above the limit that count as within it. The tokenizer pre-check's tolerance. */
  tolerance: number
  /** A flag needs the delivered answer to measure more than this many times the limit. Chosen as a margin, not measured. */
  flagFactor: number
  /** Times the seller is asked when the first answer is a flag: every one must flag. */
  sellerAsks: number
  /** Times the reference measures an answer, each after its own fresh message: every measurement must agree. The pre-check's. */
  referenceAsks: number
  /**
   * The reply limit of the reference's second answer, asked only when its answer at `minCap` shows fewer than `minCap`
   * tokens of answer (a model that reasons through the lowest limit): the scale is checked on that answer instead.
   * Chosen as the smallest limit at which every model seen reasoning through the lowest one still left an answer.
   */
  scaleCap: number
  /**
   * Billed tokens a reference reply may carry beyond its measured answer (a host's fixed framing per reply), for the scale
   * only. At most 6: an answer of `minCap` tokens measured `tolerance` above them then overstates its length at most
   * (minCap + tolerance) / (minCap - framingTokens) = 1.8 times, below `flagFactor`. Chosen above the overheads seen.
   */
  framingTokens: number
}

export const OUTPUT_CAP_RULE: OutputCapRule = Object.freeze({
  id: 'output-cap-v1',
  minCap: 16,
  maxCap: 48,
  tolerance: 2,
  flagFactor: 2,
  sellerAsks: 2,
  referenceAsks: 2,
  scaleCap: 512,
  framingTokens: 6,
})

export function outputCapRuleById(id: string): OutputCapRule | undefined {
  return id === OUTPUT_CAP_RULE.id ? OUTPUT_CAP_RULE : undefined
}

/**
 * The class of one answer to a capped request:
 * - `unread`: nothing can be read (no signed answer, estimated usage, several answers, stop sequences,
 *   a limit the translation changed, an unknown shape);
 * - `within`: billed at most the limit plus the tolerance;
 * - `reasoning-outside-cap`: billed above, billed minus itemised reasoning within, and the answer measured within
 *   the limit (honest on some hosts);
 * - `reasoning-unmeasured`: the same, but the answer could not be measured: not a pass;
 * - `unexplained`: billed above, nothing itemised, and the answer does not measure above the limit;
 * - `over-cap`: billed above, and the answer or billed minus reasoning is above the limit, but the answer is
 *   not above `flagFactor` times it; shown, never a flag;
 * - `cap-ignored`: the delivered answer alone measures more than `flagFactor` times the limit.
 */
export type OutputCapClass = 'unread' | 'within' | 'reasoning-outside-cap' | 'reasoning-unmeasured' | 'unexplained' | 'over-cap' | 'cap-ignored'

/** The reference's measurement of one delivered answer: A, then A + answer, with a fresh A for each ask. */
export interface OutputCapMeasurementV1 {
  /** The route may serve several providers and named none: the measurement's host is unknown, so it measures nothing. */
  ambiguous?: true
  /**
   * The message measured before the answer, one per reference ask, each fresh: two asks never send the same text, so a
   * host's prefix cache cannot answer the second from the first.
   */
  a: string[]
  /** The answer as measured: a space, then the visible text. */
  b: string
  reference: TokenizerReferenceRoundV1
}

export interface OutputCapAskV1 {
  prompt: string
  cap: number
  request: SignedSellerRequestV1
  reading: OutputReadingV1 | null
  /** Set when the answer was billed above the limit and its text could be sent to the reference. */
  measurement: OutputCapMeasurementV1 | null
  class: OutputCapClass
}

export type OutputCapOutcome = 'flag' | 'pass' | 'inconclusive'

export interface OutputCapV1 {
  rule: OutputCapRule
  outcome: OutputCapOutcome
  reason: string
  asks: OutputCapAskV1[]
}

/** Per model, epoch and auditor: whether the cap check applies, decided by the reference itself. */
export interface OutputCapReferenceV1 {
  rule: OutputCapRule
  upstream: unknown
  /**
   * The model's own host answered a capped request within the limit, and its answer, measured the way a seller's is,
   * is what it billed for it: then the check applies to the model this run.
   */
  applies: boolean
  reason: string
  measurement: OutputCapMeasurementV1 | null
  /** The reference's own reply to the capped request: the limit, what it billed and itemised, and what its answer measures (shown in a dry pass). */
  ownReply: { cap: number; billed: number | null; reasoning: number | null; measured: number | null } | null
  /**
   * The answer the scale was checked on: the reply at `minCap` (`limit`), or the second reply at `scaleCap` (`scale`) when
   * the first showed too little answer. Null when the check stopped before it got to the scale.
   */
  scale: {
    from: 'limit' | 'scale'
    cap: number
    billed: number | null
    reasoning: number | null
    measured: number | null
    /** The second reply's measurement; the first reply's is `measurement`. */
    measurement: OutputCapMeasurementV1 | null
  } | null
  /** The body of each request the reference was asked for a reply, in order, as sent: it shows the setting the reference got. */
  requests: unknown[]
}

/** The reference's reply to one capped request: the request sent and the answer's bytes; null when it could not be asked. */
export type CapReferenceReply = (prompt: string, cap: number, signal?: AbortSignal) => Promise<{
  requestBody: Uint8Array
  response: { statusCode: number; body: Uint8Array }
  /** The provider the answer names, and whether the route serves one provider. */
  provider?: string | null
  oneProvider?: boolean
} | null>

/** Ways of asking for a count, so the request is not one fixed sentence; each gives a long plain answer on one line. */
const CAP_PROMPTS: ReadonlyArray<(start: number) => string> = [
  (start) => `Count upward from ${start} in English words, without digits, separated by commas, on a single line. Keep counting until you are stopped. Write nothing else.`,
  (start) => `Please write the numbers from ${start} upward as English words, one after another on one line, separated by commas. Do not stop on your own and add nothing else.`,
  (start) => `Starting at ${start}, spell out each following number in English words on a single line, with commas between them. Continue as long as you can, with no other text.`,
  (start) => `List every whole number from ${start} onward written out in words, comma separated, all on one line. Go on until you run out of room and write nothing besides the list.`,
]

/** The request: a plain count in words on one line, from a random start, under the limit. */
export function outputCapPrompt(random: (max: number) => number = randomInt): { prompt: string; start: number } {
  const start = 101 + random(800)
  return { start, prompt: CAP_PROMPTS[random(CAP_PROMPTS.length)]!(start) }
}

export function outputCapLimit(rule: OutputCapRule = OUTPUT_CAP_RULE, random: (max: number) => number = randomInt): number {
  return rule.minCap + random(rule.maxCap - rule.minCap + 1)
}

/** The request body for the seller: the prompt, the limit and the seller's own thinking settings. */
export function outputCapRequestBody(input: {
  service: string
  prompt: string
  cap: number
  thinking?: OutputRequestThinking | null
}): Record<string, unknown> {
  return outputCheckRequestBody({ service: input.service, content: input.prompt, maxTokens: input.cap, thinking: input.thinking })
}

/** The measured length of an answer at the reference; null when it was not measured or the measurement does not agree. */
export function measuredTokens(measurement: OutputCapMeasurementV1 | null, rule: OutputCapRule = OUTPUT_CAP_RULE): number | null {
  if (!measurement || measurement.ambiguous) return null
  return referenceDelta(measurement.reference.asks, measurementRule(rule)).delta
}

/**
 * How the cap check measures an answer at the reference: the pre-check's measurement, with this rule's number of
 * reference asks, the reference's asks agreeing within 2 tokens and any cached input leaving the answer unmeasured. Its
 * own values, whatever the pre-check's: an answer is measured the same way when the pre-check's rule changes.
 */
function measurementRule(rule: OutputCapRule): TokenizerPrecheckRule {
  const { sameCacheCancels: _cancels, ...precheck } = TOKENIZER_PRECHECK_RULE
  return { ...precheck, toleranceTokens: 2, referenceAsks: rule.referenceAsks }
}

/**
 * The text of an answer to measure: one billed above its limit, or with `withinToo` any readable answer (a dry
 * pass's diagnostic, which shows measured next to billed for answers that kept to the limit; it changes no class).
 */
export function answerToMeasure(reading: OutputReadingV1 | null, cap: number, rule: OutputCapRule = OUTPUT_CAP_RULE, withinToo = false): string | null {
  if (!readable(reading, cap)) return null
  if (!withinToo && reading.billedOutputTokens <= cap + rule.tolerance) return null
  // Measured without its outer whitespace, which can only make it shorter.
  const text = reading.text?.trim()
  if (!text) return null
  const b = ` ${text}`
  return isSafeProbe(b) ? b : null
}

/** A reading the cap check can classify: a known shape and a billed count. */
type ReadableOutput = OutputReadingV1 & { shape: NonNullable<OutputReadingV1['shape']>; billedOutputTokens: number }

function readable(reading: OutputReadingV1 | null, cap: number): reading is ReadableOutput {
  return reading !== null
    && reading.shape !== null
    && reading.billedOutputTokens !== null
    && !reading.estimated
    && reading.oneAnswer
    && !reading.stops
    && reading.cap === cap
}

/** The class of one answer (see `OutputCapClass`). */
export function classifyCapAnswer(
  reading: OutputReadingV1 | null,
  cap: number,
  measured: number | null,
  rule: OutputCapRule = OUTPUT_CAP_RULE,
): OutputCapClass {
  if (!readable(reading, cap)) return 'unread'
  const billed = reading.billedOutputTokens
  const limit = cap + rule.tolerance
  if (billed <= limit) return 'within'
  if (measured !== null && measured > rule.flagFactor * cap) return 'cap-ignored'
  const reasoning = reading.reasoningTokens
  if (reasoning !== null && billed - reasoning <= limit && (measured === null || measured <= limit)) {
    return measured === null ? 'reasoning-unmeasured' : 'reasoning-outside-cap'
  }
  if (measured !== null && measured > limit) return 'over-cap'
  if (reasoning === null) return 'unexplained'
  return billed - reasoning > limit ? 'over-cap' : 'reasoning-unmeasured'
}

/** The outcome from the asks' classes: a flag only when every ask of the rule ignored the limit. */
export function judgeOutputCap(asks: readonly Pick<OutputCapAskV1, 'class'>[], rule: OutputCapRule = OUTPUT_CAP_RULE): { outcome: OutputCapOutcome; reason: string } {
  const [first] = asks
  if (!first || first.class === 'unread') return { outcome: 'inconclusive', reason: 'the answer could not be read' }
  // A pass is a limit the seller kept: billed within it, or above it only by itemised reasoning. An answer billed
  // over the limit that could not be measured, or measured between the limit and the flag, is not a pass: a
  // confirmer would otherwise clear another auditor's flag on an answer it never measured.
  if (first.class === 'within' || first.class === 'reasoning-outside-cap') return { outcome: 'pass', reason: `the answer was ${first.class}` }
  if (first.class !== 'cap-ignored') return { outcome: 'inconclusive', reason: `the answer was ${first.class}` }
  if (asks.length < rule.sellerAsks) return { outcome: 'inconclusive', reason: `asked ${asks.length} of ${rule.sellerAsks} times` }
  const later = asks.slice(1, rule.sellerAsks)
  if (later.some((ask) => ask.class === 'unread')) return { outcome: 'inconclusive', reason: 'the answer asked again could not be read' }
  if (later.some((ask) => ask.class !== 'cap-ignored')) return { outcome: 'inconclusive', reason: 'the limit was ignored once, not when asked again' }
  return { outcome: 'flag', reason: `the delivered answer measured more than ${rule.flagFactor} times the limit, ${rule.sellerAsks} times` }
}

/**
 * Measures `b` at the reference, each of the rule's asks after its own fresh `a` (A, then A + b): no two asks send the
 * same text, so a host that caches a prompt's prefix cannot answer the second ask from the first. The asks must agree,
 * as one round of the pre-check's asks must. The measurement is kept whatever it gives.
 */
async function measureAnswer(ask: TokenizerReferenceAsk, b: string, rule: OutputCapRule): Promise<OutputCapMeasurementV1> {
  const a: string[] = []
  while (a.length < rule.referenceAsks) {
    const fresh = generateTokenizerProbe().a
    if (!a.includes(fresh)) a.push(fresh)
  }
  // A route that may serve several providers and names none leaves the measurement's host unknown: no measurement.
  let ambiguous = false
  const measured = await measureTokenizerReference({
    ask: async (contents, signal) => {
      const asked = await ask(contents, signal)
      if (asked.oneProvider === false && asked.results.every((result) => !result.provider)) ambiguous = true
      return asked
    },
    // One probe per A, asked once each, sent together; then judged as one round.
    probes: a.map((text) => ({ a: text, b })),
    rule: { ...measurementRule(rule), referenceAsks: 1 },
  })
  const asks = measured.rounds.flatMap((round) => round.asks)
  const judged = referenceDelta(asks, measurementRule(rule))
  // A probe that gave nothing keeps its own reason (no usage, a failed request), as one round of the pre-check does.
  const failure = judged.delta === null ? (measured.rounds.find((round) => round.delta === null)?.failure ?? judged.failure) : null
  const round: TokenizerReferenceRoundV1 = { asks, delta: judged.delta, failure }
  return ambiguous
    ? { ambiguous: true, a, b, reference: { ...round, delta: null, failure: 'the reference\'s route may serve several providers and names none' } }
    : { a, b, reference: round }
}

/** Tokens of answer a reply was billed for: billed output minus itemised reasoning. */
function billedAnswer(reading: ReadableOutput): number {
  return reading.billedOutputTokens - (reading.reasoningTokens ?? 0)
}

/**
 * Which reply of the reference its scale is checked on: its reply at the lowest limit (`limit`) when that was billed for
 * at least `minCap` tokens of answer, or else a second reply at `scaleCap` (`scale`).
 */
export function capScaleFrom(billed: number, reasoning: number | null, rule: OutputCapRule = OUTPUT_CAP_RULE): 'limit' | 'scale' {
  return billed - (reasoning ?? 0) >= rule.minCap ? 'limit' : 'scale'
}

/**
 * Whether the scale holds: an answer measured at the reference is at most `tolerance` above and at most `framingTokens`
 * below what the host billed for it, on an answer of at least `minCap` billed tokens. A seller's measured answer then
 * means what it says: an honest answer that stops at the limit cannot measure over `flagFactor` times it.
 */
export function capScaleHolds(billedForAnswer: number, measured: number, rule: OutputCapRule = OUTPUT_CAP_RULE): boolean {
  return billedForAnswer >= rule.minCap && measured <= billedForAnswer + rule.tolerance && measured >= billedForAnswer - rule.framingTokens
}

/**
 * Whether the cap check applies to the model this epoch. The reference answers the count at the lowest limit a seller can
 * draw, and its host must keep it. Its answer must then show the measurement's scale: the answer, measured the way a
 * seller's is (two equal measurements from one provider, no cached input), is what the host billed for it
 * (`capScaleHolds`). A model that reasons through the lowest limit shows too little answer for that, so the reference
 * answers once more at `scaleCap` and the scale is checked there. Never rejects.
 */
export async function prepareOutputCapReference(input: { ask: TokenizerReferenceAsk; askReply: CapReferenceReply; rule?: OutputCapRule }): Promise<OutputCapReferenceV1> {
  const rule = input.rule ?? OUTPUT_CAP_RULE
  // The lowest limit a seller can draw: a host with a floor above twice it would have its honest sellers flagged, and
  // declines here instead.
  const cap = rule.minCap
  const requests: unknown[] = []
  const starts: number[] = []
  let measurement: OutputCapMeasurementV1 | null = null
  let ownReply: OutputCapReferenceV1['ownReply'] = { cap, billed: null, reasoning: null, measured: null }
  let scale: OutputCapReferenceV1['scale'] = null
  const notApplying = (why: string): OutputCapReferenceV1 => ({
    rule, upstream: null, applies: false, measurement, ownReply, scale, requests, reason: `${why}, so the cap check does not apply to the model this run`,
  })
  // One reply of the reference to the count, from a start of its own, under `limit`: its reading, or why there is none.
  const replyAt = async (limit: number, what: string): Promise<{ reading: ReadableOutput } | { why: string }> => {
    let drawn = outputCapPrompt()
    while (starts.includes(drawn.start)) drawn = outputCapPrompt()
    starts.push(drawn.start)
    let replied: Awaited<ReturnType<CapReferenceReply>>
    let failure: string | null = null
    try {
      replied = await input.askReply(drawn.prompt, limit)
    } catch (error) {
      replied = null
      failure = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    }
    if (replied) requests.push(parseObject(replied.requestBody))
    if (replied && replied.oneProvider === false && !replied.provider) return { why: 'the reference\'s route may serve several providers and names none' }
    const reading = replied ? readOutput(replied.requestBody, replied.response) : null
    if (reading && reading.cap !== null && reading.cap > limit) return { why: `the reference's route raises the reply limit to ${reading.cap}` }
    if (!readable(reading, limit)) return { why: `${what} could not be read${failure ? ` (${failure})` : ''}` }
    return { reading }
  }
  const first = await replyAt(cap, 'the reference\'s own answer to a capped request')
  if ('why' in first) return notApplying(first.why)
  const { billedOutputTokens: billed, reasoningTokens: reasoning } = first.reading
  ownReply = { cap, billed, reasoning, measured: null }
  const answer = billedAnswer(first.reading)
  // Its answer is measured when it was billed over the limit (does the host keep it?), or when the scale is checked on it.
  const scaleHere = capScaleFrom(billed, reasoning, rule) === 'limit'
  if (billed > cap + rule.tolerance || scaleHere) {
    const b = answerToMeasure(first.reading, cap, rule, true)
    if (!b) return notApplying('the reference\'s own answer could not be measured')
    measurement = await measureAnswer(input.ask, b, rule)
    const measured = measuredTokens(measurement, rule)
    ownReply = { cap, billed, reasoning, measured }
    if (measured === null) return notApplying(`the reference could not measure its own answer (${measurement.reference.failure ?? 'no difference'})`)
    // The model's own host keeps the limit: what an honest seller passing the request through delivers.
    if (billed > cap + rule.tolerance && measured > rule.flagFactor * cap) {
      return notApplying(`the model's own host billed ${billed} on a limit of ${cap} with an answer of ${measured}`)
    }
  }
  if (scaleHere) {
    const measured = ownReply.measured!
    scale = { from: 'limit', cap, billed, reasoning, measured, measurement: null }
    if (!capScaleHolds(answer, measured, rule)) return notApplying(`the reference's own answer measures ${measured} where it billed ${answer} for it`)
    return { rule, upstream: null, applies: true, measurement, ownReply, scale, requests, reason: `the reference kept a limit of ${cap} (billed ${billed}) and its answer measures ${measured}` }
  }
  // Reasoned through the lowest limit: the scale is checked on a reply with room for an answer.
  const second = await replyAt(rule.scaleCap, `the reference's answer at a limit of ${rule.scaleCap}`)
  const firstShowed = `the reference kept a limit of ${cap} (billed ${billed}) with ${answer} tokens of answer`
  if ('why' in second) return notApplying(`${firstShowed}, and ${second.why}`)
  const shown = second.reading
  const scaleAnswer = billedAnswer(shown)
  scale = { from: 'scale', cap: rule.scaleCap, billed: shown.billedOutputTokens, reasoning: shown.reasoningTokens, measured: null, measurement: null }
  if (scaleAnswer < rule.minCap) {
    return notApplying(`${firstShowed}, and ${scaleAnswer} at a limit of ${rule.scaleCap}: too little answer to check the measurement's scale on`)
  }
  const b = answerToMeasure(shown, rule.scaleCap, rule, true)
  if (!b) return notApplying(`${firstShowed}, and its answer at a limit of ${rule.scaleCap} could not be measured`)
  const scaleMeasurement = await measureAnswer(input.ask, b, rule)
  const measured = measuredTokens(scaleMeasurement, rule)
  scale = { ...scale, measured, measurement: scaleMeasurement }
  if (measured === null) {
    return notApplying(`${firstShowed}, and the reference could not measure its answer at a limit of ${rule.scaleCap} (${scaleMeasurement.reference.failure ?? 'no difference'})`)
  }
  if (!capScaleHolds(scaleAnswer, measured, rule)) {
    return notApplying(`${firstShowed}, and its answer at a limit of ${rule.scaleCap} measures ${measured} where it billed ${scaleAnswer} for it`)
  }
  return {
    rule, upstream: null, applies: true, measurement, ownReply, scale, requests,
    reason: `${firstShowed}, and at a limit of ${rule.scaleCap} its answer measures ${measured} where it billed ${scaleAnswer} for it`,
  }
}

/** Runs the cap check on one seller. Never rejects: a failure is an inconclusive outcome. */
export async function runOutputCap(input: SignedSellerRequestInput & {
  ask: TokenizerReferenceAsk
  thinking?: Parameters<typeof outputCapRequestBody>[0]['thinking']
  rule?: OutputCapRule
  /** A dry pass also measures answers that kept to the limit. */
  measureWithin?: boolean
}): Promise<OutputCapV1> {
  const rule = input.rule ?? OUTPUT_CAP_RULE
  const asks: OutputCapAskV1[] = []
  const cap = outputCapLimit(rule)
  // The reference's measurements stop when the audit stops.
  const stop = input.signal
  const ask: TokenizerReferenceAsk = stop ? (contents, signal) => input.ask(contents, signal ? AbortSignal.any([signal, stop]) : stop) : input.ask
  const firstStart: number[] = []
  try {
  for (let index = 0; index < rule.sellerAsks; index += 1) {
    // Two asks are two observations: the second counts from another start.
    let drawn = outputCapPrompt()
    while (firstStart.includes(drawn.start)) drawn = outputCapPrompt()
    firstStart.push(drawn.start)
    const { prompt } = drawn
    const request = await askSellerSigned(input, outputCapRequestBody({ service: input.service, prompt, cap, thinking: input.thinking ?? null }))
    const exchange = signedExchange(request)
    const reading = exchange ? readOutput(exchange.requestBody, exchange.response) : null
    const b = answerToMeasure(reading, cap, rule, input.measureWithin === true)
    const measurement = b ? await measureAnswer(ask, b, rule) : null
    asks.push({ prompt, cap, request, reading, measurement, class: classifyCapAnswer(reading, cap, measuredTokens(measurement, rule), rule) })
    // Asked again only when the first answer ignored the limit.
    if (asks[0]!.class !== 'cap-ignored') break
  }
  } catch (error) {
    // A check that fails is inconclusive, with the asks already paid for kept.
    return { rule, outcome: 'inconclusive', reason: `the check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), asks }
  }
  return { rule, ...judgeOutputCap(asks, rule), asks }
}

/**
 * Recomputes a stored cap check from the bytes the seller signed, as `verifier submit` does before it
 * sends the result. Throws when anything stored differs from what the bytes and the rule give.
 */
export function validateOutputCap(record: OutputCapV1): void {
  const rule = outputCapRuleById(record.rule?.id)
  if (!rule) throw new Error(`unknown cap check rule ${String(record.rule?.id)}`)
  if (canonicalJsonStringify(record.rule) !== canonicalJsonStringify(rule)) throw new Error('the cap check rule differs from the one this CLI knows')
  if (!Array.isArray(record.asks) || record.asks.length > rule.sellerAsks) throw new Error('the cap check has no asks, or too many')
  if (record.asks.length === 0) {
    // A check that failed before it asked anything is recorded as inconclusive and nothing else.
    if (record.outcome !== 'inconclusive') throw new Error('a cap check without asks must be inconclusive')
    return
  }
  assertRequestIdentities(record.asks.map((ask) => ask.request), {
    duplicateAttempt: 'a cap check repeats a request ID: two asks must be two requests',
    duplicateAuthenticated: 'a cap check repeats an authenticated request ID: two asks must be two signed requests',
    authenticatedNotAttempt: 'a cap check\'s authenticated request is not one of its tries',
  })
  if (record.asks.length > 1 && new Set(record.asks.map((ask) => ask.prompt)).size !== record.asks.length) throw new Error('a cap check asked the same request twice')
  if (record.asks.length > 1 && record.asks[0]!.class !== 'cap-ignored') throw new Error('a cap check asked again after an answer that did not ignore the limit')
  const cap = record.asks[0]!.cap
  for (const ask of record.asks) {
    if (ask.cap !== cap || !Number.isInteger(cap) || cap < rule.minCap || cap > rule.maxCap) throw new Error('a cap check ask has a limit outside the rule')
    const exchange = signedExchange(ask.request)
    const reading = exchange ? readOutput(exchange.requestBody, exchange.response) : null
    if (canonicalJsonStringify(reading) !== canonicalJsonStringify(ask.reading)) throw new Error('a cap check reading differs from the signed bytes')
    if (exchange && !requestCarriesPrompt(exchange.requestBody, ask.prompt)) throw new Error('a cap check prompt is not the one the seller signed')
    // A measurement is required for an answer billed over the limit; one of an answer within it (a dry pass) is allowed.
    const required = answerToMeasure(reading, cap, rule)
    const allowed = answerToMeasure(reading, cap, rule, true)
    if ((required !== null && ask.measurement === null) || (ask.measurement !== null && ask.measurement.b !== allowed)) {
      throw new Error('a cap check measurement is not of the answer the seller signed')
    }
    if (ask.measurement) {
      // An ambiguous route measures nothing; otherwise the stored length follows from the stored asks.
      const recomputed = ask.measurement.ambiguous ? { delta: null } : referenceDelta(ask.measurement.reference.asks, measurementRule(rule))
      if (recomputed.delta !== ask.measurement.reference.delta) throw new Error('a cap check measurement does not give its stored length')
    }
    if (classifyCapAnswer(reading, cap, measuredTokens(ask.measurement, rule), rule) !== ask.class) throw new Error('a cap check class differs from its reading')
  }
  const judged = judgeOutputCap(record.asks, rule)
  if (judged.outcome !== record.outcome) throw new Error(`the cap check outcome is ${record.outcome}, its asks give ${judged.outcome}`)
}

export function outputCapRequestCount(record: OutputCapV1): number {
  return requestCountOf(outputCapPaidRequests(record))
}

/** Every request the cap check paid for, in order. */
export function outputCapPaidRequests(record: OutputCapV1): PaidRequest[] {
  return record.asks.map((ask) => ({ requestCount: ask.request.requestIds.length, attemptCosts: ask.request.attemptCosts }))
}

/** One plain line for the verdict reason and the report. */
export function describeOutputCapFlag(record: OutputCapV1): string {
  const parts = record.asks.map((ask) => {
    const measured = measuredTokens(ask.measurement, record.rule)
    return `billed ${ask.reading?.billedOutputTokens ?? '?'} output tokens on a limit of ${ask.cap}, and the answer alone measures ${measured ?? '?'}`
  })
  return `cap check (${record.rule.id}): ${parts.join('; asked again, ')}: the reply limit was ignored`
}

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** English words for 1 to 999, as a model writes a count. */
export function numberWords(value: number): string {
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  const below = rest < 20 ? ONES[rest]! : `${TENS[Math.floor(rest / 10)]!}${rest % 10 ? `-${ONES[rest % 10]!}` : ''}`
  if (hundreds === 0) return below
  return `${ONES[hundreds]!} hundred${rest ? ` and ${below}` : ''}`
}

/** The cap check as an audit's summary carries it: enough for the report, the overview and the close-call rule. */
export interface OutputCapSummary {
  rule: string
  outcome: OutputCapOutcome
  reason: string
  /** Per ask: the limit, what was billed and what the answer measured. */
  asks: Array<{ cap: number; billed: number | null; measured: number | null; class: OutputCapClass }>
}

export function summarizeOutputCap(record: OutputCapV1): OutputCapSummary {
  return {
    rule: record.rule.id,
    outcome: record.outcome,
    reason: record.reason,
    asks: record.asks.map((ask) => ({
      cap: ask.cap,
      billed: ask.reading?.billedOutputTokens ?? null,
      measured: measuredTokens(ask.measurement, record.rule),
      class: ask.class,
    })),
  }
}

/** One plain line from a summary, for the report and the run log. */
export function describeOutputCapSummary(summary: OutputCapSummary): string {
  return summary.asks
    .map((ask) => `billed ${ask.billed ?? '?'} on a limit of ${ask.cap}, answer measures ${ask.measured ?? '?'}`)
    .join('; asked again, ')
}

/** What the cap check's requests cost. They are paid for like question batches. */
export function outputCapCost(record: OutputCapV1): AuditCostSummaryV1 {
  return costOfRequests(outputCapPaidRequests(record))
}

/** The cap check of one model's sellers in one run: the reference test once, then each seller. */
export interface OutputCapScreen<Settings> {
  /** Whether the check applies to the model this run, decided by the reference once (first caller's settings). Never rejects. */
  ready: (settings: Settings) => Promise<OutputCapReferenceV1>
  /** One seller's check; null when the check does not apply to the model. Never rejects. */
  check: (
    seller: { peerId: string; service: string; serviceAliases?: readonly string[] },
    settings: Settings,
    thinking: Parameters<typeof outputCapRequestBody>[0]['thinking'],
    clock?: SignedSellerRequestInput['clock'],
  ) => Promise<OutputCapV1 | null>
}

export function createOutputCapScreen<Settings>(input: {
  proxyBaseUrl: string
  responseAuthReader: SignedSellerRequestInput['responseAuthReader']
  limiter: SignedSellerRequestInput['limiter']
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  /** The reference's input-token measurement for the model, on the route of the audit's question set. */
  ask: (settings: Settings) => TokenizerReferenceAsk
  /** The reference's own reply to a capped request, on the same route. */
  askReply: (settings: Settings) => CapReferenceReply
  rule?: OutputCapRule
  /** A dry pass also measures answers that kept to the limit (`runOutputCap`). */
  measureWithin?: boolean
  /** Told the reference record once it is prepared (the run writes it beside the model's audits). */
  onReady?: (reference: OutputCapReferenceV1) => void
}): OutputCapScreen<Settings> {
  const rule = input.rule ?? OUTPUT_CAP_RULE
  let prepared: Promise<OutputCapReferenceV1> | null = null
  const ready = (settings: Settings): Promise<OutputCapReferenceV1> => {
    prepared ??= Promise.resolve().then(() => prepareOutputCapReference({ ask: input.ask(settings), askReply: input.askReply(settings), rule })).catch((error: unknown): OutputCapReferenceV1 => ({
      rule, upstream: null, applies: false, measurement: null, ownReply: null, scale: null, requests: [],
      reason: `the reference could not be asked (${error instanceof Error ? error.message : String(error)}), so the cap check does not apply this run`,
    })).then((reference) => {
      try { input.onReady?.(reference) } catch { /* a report is never a reason to fail the check */ }
      return reference
    })
    return prepared
  }
  return {
    ready,
    async check(seller, settings, thinking, clock) {
      const reference = await ready(settings)
      if (!reference.applies) return null
      return Promise.resolve().then(() => runOutputCap({
        proxyBaseUrl: input.proxyBaseUrl,
        peerId: seller.peerId,
        service: seller.service,
        ...(seller.serviceAliases ? { serviceAliases: seller.serviceAliases } : {}),
        responseAuthReader: input.responseAuthReader,
        limiter: input.limiter,
        ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
        ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
        ...(clock ? { clock, signal: clock.signal } : {}),
        ask: input.ask(settings),
        thinking,
        rule,
        ...(input.measureWithin ? { measureWithin: true } : {}),
      })).catch((error: unknown): OutputCapV1 => ({
        rule, outcome: 'inconclusive', asks: [],
        reason: `the check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      }))
    },
  }
}

/**
 * The cap check's block of the rules fingerprint (`RecordCheck.fingerprint`), with the fixed inputs it is judged on
 * below: a change to its rule, a limit or what the code gives for one of these inputs changes the pinned rules hash.
 */
export function outputCapFingerprint(): Record<string, unknown> {
  // The cap check: its rule, a request written from a fixed sequence, and the class and outcome it gives for
  // fixed answers (billed, itemised reasoning, measured length) on a limit of 16.
  return {
    rule: OUTPUT_CAP_RULE,
    signedRequestTries: SIGNED_REQUEST_TRIES,
    // The shared request helper's wait before a second try after a 429 or a 5xx, and which failures can pass when
    // asked again (FLIPS and the echo check ask again only those).
    signedRequestRetryWait: SIGNED_REQUEST_RETRY_WAIT,
    signedRetryWaits: ['3', '120', 'soon', null].map((header) => signedRetryWaitMs(header, 0)),
    signedRequestFailures: ([[400, 'the seller answered HTTP 400'], [429, 'the seller answered HTTP 429'], [503, 'the seller answered HTTP 503'],
      [null, 'request failed: timeout'], [200, 'the answer has no verified ResponseAuth'], [null, 'the audit was stopped']] as const)
      .map(([statusCode, failureReason]) => signedRequestFailure({ requestIds: ['r'], statusCode, attemptCosts: [], responseAuth: null, failureReason })),
    limit: outputCapLimit(OUTPUT_CAP_RULE, fixedSequence(7)),
    prompt: outputCapPrompt(fixedSequence(11)).prompt,
    words: [101, 342, 999].map(numberWords),
    classes: SAMPLE_CAP_ANSWERS.map(([billed, reasoning, measured]) => classifyCapAnswer({
      cap: 16, oneAnswer: true, stops: false, billedOutputTokens: billed, estimated: false, reasoningTokens: reasoning,
      reasoningMarker: reasoning !== null, text: 'x', finished: false, shape: 'chat',
    }, 16, measured)),
    judged: SAMPLE_CAP_ASKS.map((classes) => judgeOutputCap(classes.map((entry) => ({ class: entry }))).outcome),
    // The reference's scale: which of its replies it is checked on, and whether it holds, for fixed answers.
    scaleFrom: SAMPLE_CAP_REFERENCE_REPLIES.map(([billed, reasoning]) => capScaleFrom(billed, reasoning)),
    scaleHolds: SAMPLE_CAP_SCALES.map(([billedForAnswer, measured]) => capScaleHolds(billedForAnswer, measured)),
  }
}

/** Billed output and itemised reasoning of sample reference replies at the lowest limit. */
const SAMPLE_CAP_REFERENCE_REPLIES: ReadonlyArray<readonly [number, number | null]> = [
  [16, null], [16, 0], [16, 16], [16, 14], [10, 0], [408, 392], [921, 905],
]

/** Billed tokens of answer and measured length of sample reference answers. */
const SAMPLE_CAP_SCALES: ReadonlyArray<readonly [number, number]> = [
  [16, 16], [16, 18], [16, 19], [16, 10], [16, 9], [2, 1], [403, 398], [403, 397], [403, 396], [403, 405], [403, 406],
]

/** Billed output, itemised reasoning and measured answer length of sample answers on a limit of 16. */
const SAMPLE_CAP_ANSWERS: ReadonlyArray<readonly [number, number | null, number | null]> = [
  [16, null, null], [18, null, null], [408, 392, 9], [927, null, 6], [40, null, 30], [60, 10, 33], [927, null, 537], [927, 920, 537],
]

const SAMPLE_CAP_ASKS: ReadonlyArray<readonly OutputCapClass[]> = [
  ['within'], ['unread'], ['cap-ignored'], ['cap-ignored', 'within'], ['cap-ignored', 'unread'], ['cap-ignored', 'cap-ignored'],
]
