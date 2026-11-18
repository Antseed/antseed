import { randomInt } from 'node:crypto'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { isSafeProbe } from '@antseed/node/payments'
import { readOutput, type OutputReadingV1 } from './output-usage.js'
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
 * - `reasoning-outside-cap`: billed above, but billed minus itemised reasoning is within (honest on some hosts);
 * - `unexplained`: billed above, nothing itemised, and the answer does not measure above the limit;
 * - `over-cap`: billed above, and the answer or billed minus reasoning is above the limit, but the answer is
 *   not above `flagFactor` times it; shown, never a flag;
 * - `cap-ignored`: the delivered answer alone measures more than `flagFactor` times the limit.
 */
export type OutputCapClass = 'unread' | 'within' | 'reasoning-outside-cap' | 'unexplained' | 'over-cap' | 'cap-ignored'

/** The reference's measurement of one delivered answer: A, then A + answer. */
export interface OutputCapMeasurementV1 {
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
  /** The reference measured a text of the kind a seller delivers (a count in words) cleanly. */
  applies: boolean
  reason: string
  measurement: OutputCapMeasurementV1 | null
}

/** The request: a plain count in words on one line, from a random start, under the limit. */
export function outputCapPrompt(random: (max: number) => number = randomInt): { prompt: string; start: number } {
  const start = 101 + random(800)
  return {
    start,
    prompt: `Count upward from ${start} in English words, without digits, separated by commas, on a single line. `
      + 'Keep counting until you are stopped. Write nothing else.',
  }
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
  if (!measurement) return null
  return referenceDelta(measurement.reference.asks, measurementRule(rule)).delta
}

/** The pre-check's measurement rule, with this rule's number of reference asks. */
function measurementRule(rule: OutputCapRule): TokenizerPrecheckRule {
  return { ...TOKENIZER_PRECHECK_RULE, referenceAsks: rule.referenceAsks }
}

/** Whether an answer billed above its limit is to be measured, and the text that would be. */
export function answerToMeasure(reading: OutputReadingV1 | null, cap: number, rule: OutputCapRule = OUTPUT_CAP_RULE): string | null {
  if (!readable(reading, cap)) return null
  if (reading!.billedOutputTokens! <= cap + rule.tolerance) return null
  const text = reading!.text
  if (!text || text.trim().length === 0) return null
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
  if (reasoning !== null && billed - reasoning <= limit && (measured === null || measured <= limit)) return 'reasoning-outside-cap'
  if (measured !== null && measured > limit) return 'over-cap'
  if (reasoning === null) return 'unexplained'
  return billed - reasoning > limit ? 'over-cap' : 'reasoning-outside-cap'
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
  const measured = await measureTokenizerReference({
    ask,
    probes: [{ a, b }],
    rule: measurementRule(rule),
  })
  return { a, b, reference: measured.rounds[0]! }
}

/**
 * Whether the cap check applies to the model this epoch: the reference must measure a count in words
 * cleanly (two equal measurements from one provider, no cached input). Never rejects.
 */
export async function prepareOutputCapReference(input: { ask: TokenizerReferenceAsk; rule?: OutputCapRule }): Promise<OutputCapReferenceV1> {
  const rule = input.rule ?? OUTPUT_CAP_RULE
  const { start } = outputCapPrompt()
  const words = Array.from({ length: 24 }, (_word, index) => numberWords(start + index)).join(', ')
  const measurement = await measureAnswer(input.ask, ` ${words}`, rule)
  const applies = measurement.reference.delta !== null
  return {
    rule,
    upstream: null,
    applies,
    reason: applies
      ? `the reference measured a count in words as ${measurement.reference.delta} tokens`
      : `the reference could not measure a count in words (${measurement.reference.failure ?? 'no difference'}), so the cap check does not apply to the model this epoch`,
    measurement,
  }
}

/** Runs the cap check on one seller. Never rejects: a failure is an inconclusive outcome. */
export async function runOutputCap(input: SignedSellerRequestInput & {
  reference: OutputCapReferenceV1
  ask: TokenizerReferenceAsk
  thinking?: Parameters<typeof outputCapRequestBody>[0]['thinking']
  rule?: OutputCapRule
}): Promise<OutputCapV1> {
  const rule = input.rule ?? OUTPUT_CAP_RULE
  const asks: OutputCapAskV1[] = []
  const cap = outputCapLimit(rule)
  for (let index = 0; index < rule.sellerAsks; index += 1) {
    const { prompt } = outputCapPrompt()
    const request = await askSellerSigned(input, outputCapRequestBody({ service: input.service, prompt, cap, thinking: input.thinking ?? null }))
    const exchange = signedExchange(request)
    const reading = exchange ? readOutput(exchange.requestBody, exchange.response) : null
    const b = answerToMeasure(reading, cap, rule)
    const measurement = b ? await measureAnswer(input.ask, b, rule) : null
    asks.push({ prompt, cap, request, reading, measurement, class: classifyCapAnswer(reading, cap, measuredTokens(measurement, rule), rule) })
    // Asked again only when the first answer ignored the limit.
    if (asks[0]!.class !== 'cap-ignored') break
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
  if (!Array.isArray(record.asks) || record.asks.length === 0 || record.asks.length > rule.sellerAsks) throw new Error('the cap check has no asks, or too many')
  const cap = record.asks[0]!.cap
  for (const ask of record.asks) {
    if (ask.cap !== cap || !Number.isInteger(cap) || cap < rule.minCap || cap > rule.maxCap) throw new Error('a cap check ask has a limit outside the rule')
    const exchange = signedExchange(ask.request)
    const reading = exchange ? readOutput(exchange.requestBody, exchange.response) : null
    if (canonicalJsonStringify(reading) !== canonicalJsonStringify(ask.reading)) throw new Error('a cap check reading differs from the signed bytes')
    if (exchange && promptOf(exchange.requestBody) !== ask.prompt) throw new Error('a cap check prompt is not the one the seller signed')
    const b = answerToMeasure(reading, cap, rule)
    if ((b === null) !== (ask.measurement === null) || (b !== null && ask.measurement!.b !== b)) {
      throw new Error('a cap check measurement is not of the answer the seller signed')
    }
    if (ask.measurement) {
      const recomputed = referenceDelta(ask.measurement.reference.asks, measurementRule(rule))
      if (recomputed.delta !== ask.measurement.reference.delta) throw new Error('a cap check measurement does not give its stored length')
    }
    if (classifyCapAnswer(reading, cap, measuredTokens(ask.measurement, rule), rule) !== ask.class) throw new Error('a cap check class differs from its reading')
  }
  const judged = judgeOutputCap(record.asks, rule)
  if (judged.outcome !== record.outcome) throw new Error(`the cap check outcome is ${record.outcome}, its asks give ${judged.outcome}`)
}

function promptOf(requestBody: Uint8Array): string | null {
  try {
    const body = JSON.parse(new TextDecoder().decode(requestBody)) as { messages?: Array<{ role?: unknown; content?: unknown }> }
    const user = body.messages?.find((message) => message.role === 'user')
    return typeof user?.content === 'string' ? user.content : null
  } catch {
    return null
  }
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
  rule?: OutputCapRule
}): OutputCapScreen<Settings> {
  const rule = input.rule ?? OUTPUT_CAP_RULE
  let prepared: Promise<OutputCapReferenceV1> | null = null
  const ready = (settings: Settings): Promise<OutputCapReferenceV1> => {
    prepared ??= prepareOutputCapReference({ ask: input.ask(settings), rule }).catch((error: unknown): OutputCapReferenceV1 => ({
      rule, upstream: null, applies: false, measurement: null,
      reason: `the reference could not be asked (${error instanceof Error ? error.message : String(error)}), so the cap check does not apply this run`,
    }))
    return prepared
  }
  return {
    ready,
    async check(seller, settings, thinking, clock) {
      const reference = await ready(settings)
      if (!reference.applies) return null
      return runOutputCap({
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
      })
    },
  }
}
