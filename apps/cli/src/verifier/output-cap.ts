import { randomInt } from 'node:crypto'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { isSafeProbe } from '@antseed/node/payments'
import { readOutput, requestCarriesPrompt, type OutputReadingV1 } from './output-usage.js'
import type { AuditCostSummaryV1, ProxyAuditExchangeCostV1 } from './proxy-evidence.js'
import {
  askSellerSigned,
  signedExchange,
  type SignedSellerRequestInput,
  type SignedSellerRequestV1,
} from './signed-seller-request.js'
import {
  generateTokenizerProbe,
  measureTokenizerReference,
  referenceDelta,
  TOKENIZER_PRECHECK_RULE,
  type TokenizerPrecheckRule,
  type TokenizerReferenceAsk,
  type TokenizerReferenceRoundV1,
} from './tokenizer-precheck.js'

/**
 * The cap check, rule `output-cap-v1`: does a seller bill beyond the reply limit it was given?
 *
 * The seller is asked for a long, plain answer under a small limit. Billed output above the limit is
 * not enough: some hosts honestly bill reasoning outside it, and usage fields can be relabelled. The
 * flag rests on what the seller delivered under its signature: its visible answer, measured in the
 * model's tokenizer at this epoch's reference (A, then A + answer, as the tokenizer pre-check measures
 * text), must be more than twice the limit, and again when asked again. An honest engine stops at the
 * limit, so its answer measures the limit or less.
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
  /** Times the reference measures an answer: every measurement must agree. The pre-check's. */
  referenceAsks: number
}

export const OUTPUT_CAP_RULE: OutputCapRule = Object.freeze({
  id: 'output-cap-v1',
  minCap: 16,
  maxCap: 48,
  tolerance: 2,
  flagFactor: 2,
  sellerAsks: 2,
  referenceAsks: 2,
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

/** The reference's measurement of one delivered answer: A, then A + answer. */
export interface OutputCapMeasurementV1 {
  /** The route may serve several providers and named none: the measurement's host is unknown, so it measures nothing. */
  ambiguous?: true
  a: string
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
  /** The seller's thinking suppression (overrides and an assistant prefill), as for its questions. */
  thinking?: { overrides?: Record<string, unknown>; assistantPrefill?: string } | null
}): Record<string, unknown> {
  return {
    model: input.service,
    messages: [
      { role: 'user', content: input.prompt },
      ...(input.thinking?.assistantPrefill ? [{ role: 'assistant', content: input.thinking.assistantPrefill }] : []),
    ],
    ...input.thinking?.overrides,
    max_tokens: input.cap,
    stream: false,
  }
}

/** The measured length of an answer at the reference; null when it was not measured or the measurement does not agree. */
export function measuredTokens(measurement: OutputCapMeasurementV1 | null, rule: OutputCapRule = OUTPUT_CAP_RULE): number | null {
  if (!measurement || measurement.ambiguous) return null
  return referenceDelta(measurement.reference.asks, measurementRule(rule)).delta
}

/** The pre-check's measurement rule, with this rule's number of reference asks. */
function measurementRule(rule: OutputCapRule): TokenizerPrecheckRule {
  return { ...TOKENIZER_PRECHECK_RULE, referenceAsks: rule.referenceAsks }
}

/**
 * The text of an answer to measure: one billed above its limit, or with `withinToo` any readable answer (a dry
 * pass's diagnostic, which shows measured next to billed for answers that kept to the limit; it changes no class).
 */
export function answerToMeasure(reading: OutputReadingV1 | null, cap: number, rule: OutputCapRule = OUTPUT_CAP_RULE, withinToo = false): string | null {
  if (!readable(reading, cap)) return null
  if (!withinToo && reading!.billedOutputTokens! <= cap + rule.tolerance) return null
  // Measured without its outer whitespace, which can only make it shorter.
  const text = reading!.text?.trim()
  if (!text) return null
  const b = ` ${text}`
  return isSafeProbe(b) ? b : null
}

function readable(reading: OutputReadingV1 | null, cap: number): boolean {
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
  const billed = reading!.billedOutputTokens!
  const limit = cap + rule.tolerance
  if (billed <= limit) return 'within'
  if (measured !== null && measured > rule.flagFactor * cap) return 'cap-ignored'
  const reasoning = reading!.reasoningTokens
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

/** Measures `b` at the reference after a fresh `a`; the measurement is kept whatever it gives. */
async function measureAnswer(ask: TokenizerReferenceAsk, b: string, rule: OutputCapRule): Promise<OutputCapMeasurementV1> {
  const a = generateTokenizerProbe().a
  // A route that may serve several providers and names none leaves the measurement's host unknown: no measurement.
  let ambiguous = false
  const measured = await measureTokenizerReference({
    ask: async (contents, signal) => {
      const asked = await ask(contents, signal) as Awaited<ReturnType<TokenizerReferenceAsk>> & { oneProvider?: boolean }
      if (asked.oneProvider === false && asked.results.every((result) => !result.provider)) ambiguous = true
      return asked
    },
    probes: [{ a, b }],
    rule: measurementRule(rule),
  })
  const round = measured.rounds[0]!
  return ambiguous
    ? { ambiguous: true, a, b, reference: { ...round, delta: null, failure: 'the reference\'s route may serve several providers and names none' } }
    : { a, b, reference: round }
}

/**
 * Whether the cap check applies to the model this epoch: the reference must measure a count in words
 * cleanly (two equal measurements from one provider, no cached input). Never rejects.
 */
export async function prepareOutputCapReference(input: { ask: TokenizerReferenceAsk; askReply: CapReferenceReply; rule?: OutputCapRule }): Promise<OutputCapReferenceV1> {
  const rule = input.rule ?? OUTPUT_CAP_RULE
  // The lowest limit a seller can draw: a host with a floor above twice it would have its honest sellers flagged, and
  // declines here instead.
  const cap = rule.minCap
  const { prompt } = outputCapPrompt()
  const notApplying = (why: string, measurement: OutputCapMeasurementV1 | null, ownReply: OutputCapReferenceV1['ownReply']): OutputCapReferenceV1 => ({
    rule, upstream: null, applies: false, measurement, ownReply, reason: `${why}, so the cap check does not apply to the model this run`,
  })
  let replied: Awaited<ReturnType<CapReferenceReply>>
  let failure: string | null = null
  try {
    replied = await input.askReply(prompt, cap)
  } catch (error) {
    replied = null
    failure = (error instanceof Error ? error.message : String(error)).slice(0, 300)
  }
  if (replied && replied.oneProvider === false && !replied.provider) {
    return notApplying('the reference\'s route may serve several providers and names none', null, { cap, billed: null, reasoning: null, measured: null })
  }
  const reading = replied ? readOutput(replied.requestBody, replied.response) : null
  if (reading && reading.cap !== null && reading.cap > cap) {
    return notApplying(`the reference's route raises the reply limit to ${reading.cap}`, null, { cap, billed: null, reasoning: null, measured: null })
  }
  if (!readable(reading, cap)) {
    return notApplying(`the reference's own answer to a capped request could not be read${failure ? ` (${failure})` : ''}`, null, { cap, billed: null, reasoning: null, measured: null })
  }
  const billed = reading!.billedOutputTokens!
  const reasoning = reading!.reasoningTokens
  const b = answerToMeasure(reading, cap, rule, true)
  if (!b) return notApplying('the reference\'s own answer could not be measured', null, { cap, billed, reasoning, measured: null })
  const measurement = await measureAnswer(input.ask, b, rule)
  const measured = measuredTokens(measurement, rule)
  const ownReply = { cap, billed, reasoning, measured }
  if (measured === null) return notApplying(`the reference could not measure its own answer (${measurement.reference.failure ?? 'no difference'})`, measurement, ownReply)
  // The model's own host keeps the limit: what an honest seller passing the request through delivers.
  if (billed > cap + rule.tolerance && measured > rule.flagFactor * cap) {
    return notApplying(`the model's own host billed ${billed} on a limit of ${cap} with an answer of ${measured}`, measurement, ownReply)
  }
  // The scale: the answer measures what the host billed for it, so a seller's measured answer means what it says.
  const visible = billed - (reasoning ?? 0)
  if (Math.abs(measured - visible) > rule.tolerance) {
    return notApplying(`the reference's own answer measures ${measured} where it billed ${visible} for it`, measurement, ownReply)
  }
  return { rule, upstream: null, applies: true, measurement, ownReply, reason: `the reference kept a limit of ${cap} (billed ${billed}) and its answer measures ${measured}` }
}

/** Runs the cap check on one seller. Never rejects: a failure is an inconclusive outcome. */
export async function runOutputCap(input: SignedSellerRequestInput & {
  reference: OutputCapReferenceV1
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
  const requestIds = record.asks.flatMap((ask) => ask.request.requestIds)
  if (new Set(requestIds).size !== requestIds.length) throw new Error('a cap check repeats a request ID: two asks must be two requests')
  const signedIds = record.asks.flatMap((ask) => (ask.request.responseAuth?.requestId ? [ask.request.responseAuth.requestId] : []))
  if (new Set(signedIds).size !== signedIds.length) throw new Error('a cap check repeats an authenticated request ID: two asks must be two signed requests')
  if (record.asks.length > 1 && new Set(record.asks.map((ask) => ask.prompt)).size !== record.asks.length) throw new Error('a cap check asked the same request twice')
  if (record.asks.some((ask) => ask.request.responseAuth?.requestId && !ask.request.requestIds.includes(ask.request.responseAuth.requestId))) {
    throw new Error('a cap check\'s authenticated request is not one of its tries')
  }
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
  return record.asks.reduce((total, ask) => total + ask.request.requestIds.length, 0)
}

export function outputCapCosts(record: OutputCapV1): ProxyAuditExchangeCostV1[] {
  return record.asks.flatMap((ask) => ask.request.attemptCosts)
}

/** One plain line for the verdict reason and the report. */
export function describeOutputCapFlag(record: OutputCapV1): string {
  const parts = record.asks.map((ask) => {
    const measured = measuredTokens(ask.measurement, record.rule)
    return `billed ${ask.reading?.billedOutputTokens ?? '?'} output tokens on a limit of ${ask.cap}, and the answer alone measures ${measured ?? '?'}`
  })
  return `cap check (${record.rule.id}): ${parts.join('; asked again, ')}: the reply limit was ignored; its questions were not asked`
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
  const requests = record.asks.map((ask) => ask.request)
  const priced = requests.flatMap((request) => request.attemptCosts)
  return {
    inputTokens: priced.reduce((total, cost) => total + cost.inputTokens, 0),
    outputTokens: priced.reduce((total, cost) => total + cost.outputTokens, 0),
    totalTokens: priced.reduce((total, cost) => total + cost.totalTokens, 0),
    estimatedCostUsd: priced.reduce((total, cost) => total + cost.estimatedCostUsd, 0),
    pricedExchangeCount: requests.filter((request) => request.attemptCosts.length > 0).length,
    missingCostExchangeCount: requests.filter((request) => request.attemptCosts.length === 0).length,
  }
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
      rule, upstream: null, applies: false, measurement: null, ownReply: null,
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
        reference,
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
