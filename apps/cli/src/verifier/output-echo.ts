import { canonicalJsonStringify } from '@antseed/fingerprints'
import { isSafeProbe } from '@antseed/node/payments'
import { readOutput, requestCarriesPrompt, type OutputReadingV1 } from './output-usage.js'
import { costOfRequests, requestCountOf, type AuditCostSummaryV1, type PaidRequest } from './proxy-evidence.js'
import {
  askSellerSigned,
  signedExchange,
  type SignedSellerRequestInput,
  type SignedSellerRequestV1,
} from './signed-seller-request.js'
import { generateTokenizerProbe } from './tokenizer-precheck.js'

/**
 * The echo check, rule `output-echo-v1`: does a seller bill the output tokens the model wrote?
 *
 * The seller repeats a short and a long text word for word, in three rounds. The output tokens it signs are
 * compared with this epoch's reference for the same texts. Two findings are judged apart, each with its own
 * outcome, and each only behind the model's other sellers (the crowd) and with wide margins:
 * - `growth`: the seller's count grows faster from the short to the long text than the reference's, in every
 *   round and again when asked again. A constant a host adds to every reply cancels out of the growth.
 * - `offset` (the fixed amount): the seller adds the same large amount to every reply, short and long, on both
 *   asks, far above what the model's other sellers add.
 * Anything unclear decides nothing, and only a seller that kept to the model's count passes: a confirmer must
 * not clear another auditor's finding on a reply that only failed to be a candidate.
 *
 * Every constant is here, frozen. The margins (`growthFloor`, `growthShare`, `offsetFloor`, `spreadFactor`) are
 * chosen above every honest value seen in the evals and on live sellers (constants of 3 tokens without reasoning
 * and 9 with; one relay's dropped reasoning at 16 tokens of growth), not measured bounds. The growth stands out
 * against the crowd's spread only; the seller's own steadiness is judged as a share of each round's gap, and the
 * rounds' long texts have different lengths (`longPassages`), so a factor (steady share) is told from a fixed extra
 * on long replies (a share that falls as the gap grows). Replayed on the eval's replies by the design reviewer and
 * the implementation: honest 0 flags; a 20% over-bill flagged in every decided check.
 */
export interface OutputEchoRule {
  id: 'output-echo-v1'
  /** Rounds of one short and one long text. */
  rounds: number
  /** Tokens within which two counts of one text are the same (a seller's two asks; a crowd vote's two texts). */
  tolerance: number
  /** Times the reference is asked each text; every ask must agree (exactly in `plain` mode). */
  referenceAsks: number
  /** Times a round's pair is written again before the model is left unjudged this run. */
  textTries: number
  /** The long text must measure at least this many tokens more than the short one at the reference. */
  minGap: number
  /** Passages of each round's long text (a short text is one): different lengths, so the gaps differ on purpose. */
  longPassages: number[]
  /** The largest round gap must be at least this many times the smallest, measured: close gaps cannot tell a factor from a fixed extra. */
  minGapRatio: number
  /** Reply limit of every echo request. */
  maxTokens: number
  /** A growth flag needs the growth above this many tokens, in every round. Chosen margin. */
  growthFloor: number
  /** … and above this share of the reference's gap between the two texts, in every round. Chosen margin. */
  growthShare: number
  /** An offset flag needs the fixed amount, and its lead over the other sellers' median, above this many tokens. */
  offsetFloor: number
  /** The flagged amount must exceed the other sellers' median by more than this many times their spread. */
  spreadFactor: number
  /** The smallest spread used. */
  minSpread: number
  /** Other sellers that must be measured. */
  minOthers: number
  /** Other sellers that must sign the reference's count (within the tolerance). */
  minBackers: number
  /**
   * Whether a fixed-amount finding may flag a seller or clear a waiting flag. When false it is computed, stored and
   * shown, and decides nothing: no data on live sellers is behind it yet.
   */
  offsetCounts: boolean
  /** The same for any finding of a model counted on its visible answer (`visible` mode). */
  visibleCounts: boolean
}

export const OUTPUT_ECHO_RULE: OutputEchoRule = Object.freeze({
  id: 'output-echo-v1',
  rounds: 3,
  tolerance: 2,
  referenceAsks: 2,
  textTries: 3,
  minGap: 150,
  longPassages: [3, 4, 6],
  minGapRatio: 4 / 3,
  maxTokens: 1024,
  growthFloor: 20,
  growthShare: 0.1,
  offsetFloor: 20,
  spreadFactor: 3,
  minSpread: 2,
  minOthers: 3,
  minBackers: 2,
  offsetCounts: false,
  visibleCounts: false,
})

export function outputEchoRuleById(id: string): OutputEchoRule | undefined {
  return id === OUTPUT_ECHO_RULE.id ? OUTPUT_ECHO_RULE : undefined
}

/**
 * How a model's echoes are counted this run, decided by its reference:
 * - `plain`: the reference echoes without any reasoning; a reply with a reasoning marker is not usable;
 * - `visible`: the reference itemises reasoning on every echo; the count is billed minus itemised reasoning, a
 *   reply that does not itemise is not usable, and each round's tolerance grows by its own largest itemised count.
 */
export type EchoMode = 'plain' | 'visible'

/** One reply read for the echo check. */
export interface EchoReplyV1 {
  /** The output count compared: billed (`plain`) or billed minus itemised reasoning (`visible`); null when not usable. */
  count: number | null
  /** Itemised reasoning; 0 when none. */
  reasoning: number
  /** Why the reply is not usable; null when it is. */
  unusable: string | null
}

/**
 * Reads one echo reply in a mode. Usable: signed usage, one finished answer, the text byte for byte, and the mode's
 * reasoning rule. An itemised reasoning count that is negative, not whole or above the billed count is malformed
 * usage: not usable in either mode.
 */
export function readEchoReply(reading: OutputReadingV1 | null, text: string, mode: EchoMode): EchoReplyV1 {
  const itemised = reading?.reasoningTokens ?? null
  const billed = reading?.billedOutputTokens ?? null
  const malformed = itemised !== null && (!Number.isInteger(itemised) || itemised < 0 || (billed !== null && itemised > billed))
  const reasoning = malformed || itemised === null ? 0 : itemised
  const no = (why: string): EchoReplyV1 => ({ count: null, reasoning, unusable: why })
  if (!reading || reading.shape === null || billed === null) return no('no reading')
  if (reading.estimated) return no('no signed usage')
  if (malformed) return no('malformed reasoning count')
  if (!reading.oneAnswer || reading.stops) return no('not one plain answer')
  if (!reading.finished) return no('not finished')
  if (reading.text !== text) return no('the text was changed')
  if (mode === 'plain') return reading.reasoningMarker ? no('reasoning shown') : { count: billed, reasoning: 0, unusable: null }
  if (itemised === null) return no('reasoning not itemised')
  return { count: billed - itemised, reasoning, unusable: null }
}

/** The request to repeat `text`. */
export function outputEchoPrompt(text: string): string {
  return `Repeat the text below exactly as it is written, with nothing before or after it.\n\n${text}`
}

export function outputEchoRequestBody(input: {
  service: string
  text: string
  thinking?: { overrides?: Record<string, unknown>; assistantPrefill?: string } | null
  rule?: OutputEchoRule
}): Record<string, unknown> {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  return {
    model: input.service,
    messages: [
      { role: 'user', content: outputEchoPrompt(input.text) },
      ...(input.thinking?.assistantPrefill ? [{ role: 'assistant', content: input.thinking.assistantPrefill }] : []),
    ],
    ...input.thinking?.overrides,
    max_tokens: rule.maxTokens,
    stream: false,
  }
}

/** A short text (one probe's sentences) or a long one (`passages` of them), from the pre-check's sentence writers; one line, guard-safe. */
export function writeEchoText(kind: 'short' | 'long', write: () => string = () => generateTokenizerProbe().b.trim(), passages = 4): string {
  const count = kind === 'short' ? 1 : passages
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const text = Array.from({ length: count }, write).join(' ')
    if (isSafeProbe(` ${text}`) && !/["'`]/.test(text)) return text
  }
  throw new Error('could not write an echo text the probe guard accepts')
}

/** The reference's two asks of one text. */
export interface EchoReferenceTextV1 {
  kind: 'short' | 'long'
  text: string
  asks: Array<{ count: number | null; reasoning: number; provider: string | null; unusable: string | null }>
  /** The text's count at the reference: every ask usable, from one provider, agreeing (exactly in `plain` mode); null otherwise. */
  count: number | null
  failure: string | null
}

/** Per model, run and auditor: the texts, the reference's counts and the mode, or why the check does not apply. */
export interface OutputEchoReferenceV1 {
  rule: OutputEchoRule
  upstream: unknown
  mode: EchoMode | null
  /** The one provider every reference reply came from; null when the route names none. */
  provider: string | null
  /** Short and long texts of each round. */
  rounds: Array<{ short: EchoReferenceTextV1; long: EchoReferenceTextV1 }>
  applies: boolean
  reason: string
}

/** One reference reply to an echo request: the answer's raw bytes and the request sent, or the failure. */
export type EchoReferenceAsk = (texts: readonly string[], signal?: AbortSignal) => Promise<{
  upstream: unknown
  /** The route serves one provider (a direct endpoint, a pinned peer or a provider pin); false when it may serve several. */
  oneProvider?: boolean
  results: ReadonlyArray<{ requestBody: Uint8Array; response: { statusCode: number; body: Uint8Array } | null; provider: string | null; failure: string | null }>
}>

/** The reference's count of a text from its asks, in a mode (`EchoReferenceTextV1.count`). */
export function referenceEchoCount(
  asks: EchoReferenceTextV1['asks'],
  mode: EchoMode,
  rule: OutputEchoRule = OUTPUT_ECHO_RULE,
): { count: number | null; failure: string | null } {
  if (asks.length < rule.referenceAsks) return { count: null, failure: `the reference was asked ${asks.length} of ${rule.referenceAsks} times` }
  const unusable = asks.find((ask) => ask.unusable !== null)
  if (unusable) return { count: null, failure: `the reference's echo is not usable (${unusable.unusable})` }
  if (new Set(asks.map((ask) => ask.provider)).size !== 1) return { count: null, failure: 'the reference answered from more than one provider' }
  const counts = asks.map((ask) => ask.count!)
  // In `plain` mode the reference must give one count; in `visible` mode its visible counts agree within the tolerance.
  const allowed = mode === 'plain' ? 0 : rule.tolerance
  if (Math.max(...counts) - Math.min(...counts) > allowed) return { count: null, failure: `the reference did not agree with itself (${counts.join(', ')})` }
  return { count: counts[0]!, failure: null }
}

/** The longest the reference's measurement of a model's texts may take; sellers' audits wait for it, off their clocks. */
export const ECHO_REFERENCE_TIME_LIMIT_MS = 10 * 60_000

/**
 * The growth is steady as a share of each gap: the smallest share is more than `spreadFactor` times the range of the
 * shares. Exact: shares are growth / gap of whole numbers, compared by cross multiplication, so a tie rejects.
 */
export function steadyShares(pairs: ReadonlyArray<readonly [number, number]>, rule: OutputEchoRule): boolean {
  if (pairs.length === 0) return false
  const less = (a: readonly [number, number], b: readonly [number, number]) => BigInt(a[0]) * BigInt(b[1]) < BigInt(b[0]) * BigInt(a[1])
  let min = pairs[0]!
  let max = pairs[0]!
  for (const pair of pairs) {
    if (less(pair, min)) min = pair
    if (less(max, pair)) max = pair
  }
  // min > k (max - min)  <=>  (1 + k) min > k max  <=>  (1 + k) a d > k c b, for min = a / b and max = c / d.
  const [k, scale] = rationalOf(rule.spreadFactor)
  const [a, b] = min
  const [c, d] = max
  return (BigInt(scale) + BigInt(k)) * BigInt(a) * BigInt(d) > BigInt(k) * BigInt(c) * BigInt(b)
}

/** A margin as a whole-number ratio (numerator, denominator); the rule's margins have at most three decimals. */
function rationalOf(value: number): [number, number] {
  const scale = 1000
  return [Math.round(value * scale), scale]
}

/** The largest gap is at least `minGapRatio` times the smallest. */
function gapsDiffer(gaps: readonly number[], rule: OutputEchoRule): boolean {
  return gaps.length > 0 && Math.max(...gaps) >= rule.minGapRatio * Math.min(...gaps)
}

function roundReasoning(round: { short: EchoReferenceTextV1; long: EchoReferenceTextV1 }): number {
  return Math.max(0, ...[...round.short.asks, ...round.long.asks].map((ask) => ask.reasoning))
}

/**
 * Writes the run's texts for a model and measures each on the reference, twice. The mode is the reference's:
 * `plain` when every echo is usable without reasoning, else `visible` when every echo itemises reasoning and
 * agrees with itself on its visible count. A pair without both counts, or whose gap is too narrow, is written
 * again, up to `textTries`. The check applies only when every round has both counts and its gap, every reply came
 * from one provider, and (in `visible` mode) no round's reasoning alone puts its tolerance at the growth floor.
 * Never rejects; stops at `timeLimitMs`.
 */
export async function prepareOutputEchoReference(input: {
  ask: EchoReferenceAsk
  rule?: OutputEchoRule
  write?: (kind: 'short' | 'long', round: number) => string
  timeLimitMs?: number
}): Promise<OutputEchoReferenceV1> {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  const write = input.write ?? ((kind: 'short' | 'long', round: number) => writeEchoText(kind, undefined, rule.longPassages[round] ?? 4))
  const limit = AbortSignal.timeout(input.timeLimitMs ?? ECHO_REFERENCE_TIME_LIMIT_MS)
  let upstream: unknown = null
  let oneProvider = true
  type Both = { plain: EchoReferenceTextV1; visible: EchoReferenceTextV1 }
  const measure = async (kind: 'short' | 'long', text: string): Promise<Both> => {
    const failed = (failure: string): Both => {
      const empty = { kind, text, asks: [], count: null, failure }
      return { plain: empty, visible: empty }
    }
    if (limit.aborted) return failed('the reference\'s time is up')
    let asked: Awaited<ReturnType<EchoReferenceAsk>>
    try {
      asked = await input.ask(Array.from({ length: rule.referenceAsks }, () => text), limit)
      upstream = asked.upstream
      if (asked.oneProvider === false) oneProvider = false
    } catch (error) {
      return failed(`the reference could not be asked: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300))
    }
    const inMode = (mode: EchoMode): EchoReferenceTextV1 => {
      const asks = asked.results.map((result) => {
        const reading = result.response ? readOutput(result.requestBody, result.response) : null
        const reply = result.failure ? { count: null, reasoning: 0, unusable: result.failure } : readEchoReply(reading, text, mode)
        return { count: reply.count, reasoning: reply.reasoning, provider: result.provider, unusable: reply.unusable }
      })
      const judged = referenceEchoCount(asks, mode, rule)
      return { kind, text, asks, count: judged.count, failure: judged.failure }
    }
    return { plain: inMode('plain'), visible: inMode('visible') }
  }
  const usable = (pair: Record<'short' | 'long', Both>): boolean => (['plain', 'visible'] as const).some((mode) => (
    pair.short[mode].count !== null && pair.long[mode].count !== null && pair.long[mode].count! - pair.short[mode].count! >= rule.minGap
  ))
  const measured: Array<Record<'short' | 'long', Both>> = []
  for (let round = 0; round < rule.rounds; round += 1) {
    let pair = { short: await measure('short', write('short', round)), long: await measure('long', write('long', round)) }
    for (let attempt = 1; attempt < rule.textTries && !usable(pair) && !limit.aborted; attempt += 1) {
      pair = { short: await measure('short', write('short', round)), long: await measure('long', write('long', round)) }
    }
    measured.push(pair)
  }
  const all = measured.flatMap((pair) => [pair.short, pair.long])
  const mode: EchoMode | null = all.every((text) => text.plain.count !== null) ? 'plain'
    : all.every((text) => text.visible.count !== null) ? 'visible' : null
  const rounds = measured.map((pair) => ({ short: pair.short[mode ?? 'plain'], long: pair.long[mode ?? 'plain'] }))
  const providers = [...new Set(rounds.flatMap((round) => [...round.short.asks, ...round.long.asks].map((ask) => ask.provider)))]
  const result = (applies: boolean, reason: string): OutputEchoReferenceV1 => ({
    rule, upstream, mode, provider: providers.length === 1 ? providers[0] ?? null : null, rounds, applies, reason,
  })
  if (!mode) {
    const failed = rounds.flatMap((round) => [round.short, round.long]).find((text) => text.count === null)
    return result(false, `the reference did not echo cleanly (${failed?.failure ?? 'no count'}), so the echo check does not apply to the model this run`)
  }
  // One serving provider for every text: two hosts behind one route could each add their own constant.
  if (providers.length !== 1) return result(false, 'the reference answered from more than one provider across the texts, so the echo check does not apply this run')
  if (providers[0] === null && !oneProvider) return result(false, 'the reference\'s route may serve several providers and names none, so the echo check does not apply this run')
  if (rounds.some((round) => round.long.count! - round.short.count! < rule.minGap)) {
    return result(false, `a long text measured less than ${rule.minGap} tokens more than its short one, so the echo check does not apply this run`)
  }
  if (!gapsDiffer(rounds.map((round) => round.long.count! - round.short.count!), rule)) {
    return result(false, `the rounds' gaps are too close (largest under ${rule.minGapRatio.toFixed(2)} times the smallest), so the echo check does not apply this run`)
  }
  if (mode === 'visible' && rounds.some((round) => rule.tolerance + roundReasoning(round) >= rule.growthFloor)) {
    return result(false, `the reference's own reasoning puts a round's margin at or above ${rule.growthFloor} tokens, so the echo check could not decide and does not apply this run`)
  }
  return result(true, `the reference echoes cleanly (${mode})`)
}

/** One ask of a text to the seller. */
export interface EchoSellerAskV1 {
  request: SignedSellerRequestV1
  reading: OutputReadingV1 | null
  reply: EchoReplyV1
}

/** One round: the seller's asks of the short and the long text, and what they give. */
export interface EchoRoundV1 {
  short: EchoSellerAskV1[]
  long: EchoSellerAskV1[]
  /** Growth of each ask pair: (seller − reference on long) − (seller − reference on short); null when not usable. */
  growths: Array<number | null>
  /** The round's tolerance: the rule's, plus this round's largest itemised reasoning in `visible` mode. */
  tolerance: number
  verdict: 'within' | 'over' | 'under' | 'unusable' | 'unstable'
  /** Second asks made only for the fixed amount (a candidate's every text again): never part of the growth verdict. */
  repeats?: { short: EchoSellerAskV1; long: EchoSellerAskV1 }
}

/** A vote of one of the model's other sellers: the first round's two texts, asked once. */
export interface EchoCrowdVoteV1 {
  peerId: string
  short: EchoSellerAskV1
  long: EchoSellerAskV1
  /** Null when its echoes are not usable. */
  growth: number | null
  /** Its fixed amount: the same excess on both texts within the tolerance; null when not usable or not fixed. */
  offset: number | null
  /** The largest reasoning its replies showed: itemised, or the excess of an exact echo that shows reasoning. */
  reasoning: number
  /** This check sent the vote's requests (their cost is counted here); false for a vote shared from another check. */
  sentHere: boolean
}

export interface EchoCrowdV1 {
  votes: EchoCrowdVoteV1[]
  /** Not every other seller answered within the crowd's time, or the audit stopped: nothing is decided. */
  incomplete: boolean
}

export type OutputEchoOutcome = 'flag' | 'pass' | 'inconclusive'

export interface OutputEchoV1 {
  rule: OutputEchoRule
  mode: EchoMode
  /** The overall outcome: `flag` when a finding that counts flagged; `pass` when growth (and in `plain` mode the fixed amount) passed. */
  outcome: OutputEchoOutcome
  /** What flagged; null unless the outcome is `flag`. */
  flag: 'growth' | 'offset' | null
  /** The growth's own outcome and reason. */
  growth: { outcome: OutputEchoOutcome; reason: string }
  /** The fixed amount's own outcome and reason. */
  fixedAmount: { outcome: OutputEchoOutcome; reason: string }
  reason: string
  /** The reference's counts, as measured for this run (texts and counts only). */
  reference: Array<{ short: { text: string; count: number }; long: { text: string; count: number } }>
  /** Each round's largest reasoning the reference itemised (0 in `plain` mode). Stored as measured, like its counts. */
  referenceReasoning: number[]
  /** The one provider every reference reply came from, when the route names it. */
  referenceProvider: string | null
  rounds: EchoRoundV1[]
  /** The seller's fixed amount per reply: the median excess, and whether every reply is within the tolerance of it. */
  offset: { median: number | null; fixed: boolean }
  /** This audit's pre-check matched: the seller counts fresh input like the reference. */
  precheckMatch: boolean
  /** Asked only for a seller that could be flagged. */
  crowd: EchoCrowdV1 | null
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Judges one round from its asks and the reference's counts. */
export function judgeEchoRound(input: {
  short: readonly EchoSellerAskV1[]
  long: readonly EchoSellerAskV1[]
  reference: { short: number; long: number }
  /** This round's largest itemised reasoning at the reference (`visible` mode). */
  referenceReasoning: number
  mode: EchoMode
  rule?: OutputEchoRule
}): Pick<EchoRoundV1, 'growths' | 'tolerance' | 'verdict'> {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  const asks = Math.min(input.short.length, input.long.length)
  const growths = Array.from({ length: asks }, (_ask, index) => {
    const short = input.short[index]!.reply.count
    const long = input.long[index]!.reply.count
    return short === null || long === null ? null : (long - input.reference.long) - (short - input.reference.short)
  })
  const reasoning = Math.max(input.referenceReasoning, ...[...input.short, ...input.long].map((ask) => ask.reply.reasoning))
  const tolerance = rule.tolerance + (input.mode === 'visible' ? reasoning : 0)
  const first = growths[0] ?? null
  const second = growths[1] ?? null
  if (first === null) return { growths, tolerance, verdict: 'unusable' }
  if (asks >= 2) {
    if (second === null) return { growths, tolerance, verdict: 'unusable' }
    // Every text asked twice: the seller's own two counts of each text must agree, within the rule's tolerance.
    for (const side of [input.short, input.long]) {
      if (Math.abs(side[0]!.reply.count! - side[1]!.reply.count!) > rule.tolerance) return { growths, tolerance, verdict: 'unstable' }
    }
  }
  // In `visible` mode each text is asked twice whatever it gives.
  if (input.mode === 'visible' && asks < 2) return { growths, tolerance, verdict: 'unusable' }
  // A growth far below the model's is no match either: it decides nothing.
  if (first < -tolerance) return { growths, tolerance, verdict: 'under' }
  if (first <= tolerance) return asks < 2 || Math.abs(second!) <= tolerance ? { growths, tolerance, verdict: 'within' } : { growths, tolerance, verdict: 'unstable' }
  // Over: only a growth the seller repeats is held against it; over once and within on the repeat is undecided.
  if (asks < 2) return { growths, tolerance, verdict: 'unusable' }
  if (second! <= tolerance || Math.abs(second! - first) > tolerance) return { growths, tolerance, verdict: 'unstable' }
  return { growths, tolerance, verdict: 'over' }
}

/** A crowd vote from its two replies to the first round's texts. */
export function echoCrowdVote(
  peerId: string,
  short: EchoSellerAskV1,
  long: EchoSellerAskV1,
  reference: { short: number; long: number },
  rule: OutputEchoRule = OUTPUT_ECHO_RULE,
  sentHere = true,
): EchoCrowdVoteV1 {
  const usable = short.reply.count !== null && long.reply.count !== null
  // The reasoning an exact echo shows without itemising it: what it bills above the model's count.
  const shownExcess = (ask: EchoSellerAskV1, count: number): number => (
    ask.reply.unusable === 'reasoning shown' && ask.reading?.billedOutputTokens !== null && ask.reading?.billedOutputTokens !== undefined
      ? Math.max(0, ask.reading.billedOutputTokens - count) : 0
  )
  const shortExcess = usable ? short.reply.count! - reference.short : null
  const longExcess = usable ? long.reply.count! - reference.long : null
  return {
    peerId,
    short,
    long,
    growth: usable ? longExcess! - shortExcess! : null,
    // Its fixed amount is the larger of its two excesses, so a backer has both texts within the band.
    offset: usable && Math.abs(longExcess! - shortExcess!) <= rule.tolerance
      ? (Math.abs(longExcess!) > Math.abs(shortExcess!) ? longExcess : shortExcess) : null,
    reasoning: Math.max(short.reply.reasoning, long.reply.reasoning, shownExcess(short, reference.short), shownExcess(long, reference.long)),
    sentHere,
  }
}

/**
 * Whether the crowd holds a flagged amount (`growth` or `offset`) against the seller: at least `minOthers` other
 * sellers measured, at least `minBackers` of them within the tolerance of the reference, none within the tolerance
 * of the flagged amount, and the amount more than `spreadFactor` times their spread above their median (and more
 * than `minLead` above it). Returns why not, or null when it holds.
 */
export function echoCrowdObjection(
  amount: number,
  votes: readonly (number | null)[],
  ownSpread: number,
  rule: OutputEchoRule = OUTPUT_ECHO_RULE,
  minLead = 0,
): string | null {
  const measured = votes.filter((vote): vote is number => vote !== null)
  if (measured.length < rule.minOthers) return `${measured.length} of the model's other sellers could be measured, ${rule.minOthers} are needed`
  const backers = measured.filter((vote) => Math.abs(vote) <= rule.tolerance).length
  if (backers < rule.minBackers) return `${backers} of the model's other sellers sign the reference's count, ${rule.minBackers} are needed`
  if (measured.some((vote) => Math.abs(vote - amount) <= rule.tolerance)) return 'another seller of the model signs the same amount (a shared relay, not this seller\'s doing)'
  const spread = Math.max(rule.minSpread, Math.max(...measured) - Math.min(...measured), ownSpread)
  const center = median(measured)
  if (amount - center <= rule.spreadFactor * spread) {
    return `the amount is not more than ${rule.spreadFactor} times the other sellers' spread (${spread}) above their median (${center})`
  }
  if (amount - center <= minLead) return `the amount is not more than ${minLead} tokens above the other sellers' median (${center})`
  return null
}

type Judged = Pick<OutputEchoV1, 'outcome' | 'flag' | 'reason' | 'offset' | 'growth' | 'fixedAmount'> & { needsCrowd: boolean; needsSecondAsks: boolean }

/** The outcome of a seller's echo check from its rounds, its pre-check and the crowd (`null` crowd: not asked). */
export function judgeOutputEcho(input: {
  mode: EchoMode
  reference: OutputEchoV1['reference']
  /** Each round's largest reasoning at the reference. */
  referenceReasoning: readonly number[]
  rounds: readonly Pick<EchoRoundV1, 'growths' | 'verdict' | 'short' | 'long' | 'tolerance' | 'repeats'>[]
  precheckMatch: boolean
  crowd: EchoCrowdV1 | null
  rule?: OutputEchoRule
}): Judged {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  const excessOf = (ask: EchoSellerAskV1, count: number): number | null => (ask.reply.count === null ? null : ask.reply.count - count)
  const excesses = input.rounds.flatMap((round, index) => [
    ...round.short.map((ask) => excessOf(ask, input.reference[index]!.short.count)),
    ...round.long.map((ask) => excessOf(ask, input.reference[index]!.long.count)),
    ...(round.repeats ? [excessOf(round.repeats.short, input.reference[index]!.short.count), excessOf(round.repeats.long, input.reference[index]!.long.count)] : []),
  ]).filter((value): value is number => value !== null)
  const offset = {
    median: excesses.length > 0 ? median(excesses) : null,
    fixed: excesses.length > 0 && Math.max(...excesses) - Math.min(...excesses) <= rule.tolerance,
  }
  const notDecided = (reason: string): OutputEchoV1['growth'] => ({ outcome: 'inconclusive', reason })
  const done = (growth: OutputEchoV1['growth'], fixedAmount: OutputEchoV1['fixedAmount'], extra: { needsCrowd?: boolean; needsSecondAsks?: boolean } = {}): Judged => {
    // A finding the rule does not count yet is stored and shown, and decides nothing: neither a flag nor a pass.
    const counts = (finding: 'growth' | 'offset'): boolean => (input.mode === 'visible' ? rule.visibleCounts : true)
      && (finding === 'offset' ? rule.offsetCounts : true)
    const held = (finding: 'growth' | 'offset', value: OutputEchoV1['growth']): OutputEchoV1['growth'] => (
      counts(finding) || value.outcome === 'inconclusive' ? value : notDecided(`${value.outcome}, stored and not counted yet: ${value.reason}`)
    )
    const g = held('growth', growth)
    const f = held('offset', fixedAmount)
    const flag = g.outcome === 'flag' ? 'growth' as const : f.outcome === 'flag' ? 'offset' as const : null
    // The overall pass needs every finding that counts to pass.
    const outcome: OutputEchoOutcome = flag ? 'flag'
      : g.outcome === 'pass' && (f.outcome === 'pass' || !counts('offset') || input.mode === 'visible') ? 'pass' : 'inconclusive'
    const reason = flag === 'growth' ? g.reason : flag === 'offset' ? f.reason : `growth: ${g.reason}; fixed amount: ${f.reason}`
    return { outcome, flag, reason, offset, growth: g, fixedAmount: f, needsCrowd: extra.needsCrowd ?? false, needsSecondAsks: extra.needsSecondAsks ?? false }
  }
  const unclear = input.rounds.find((round) => round.verdict === 'unusable' || round.verdict === 'unstable' || round.verdict === 'under')
  if (input.rounds.length < rule.rounds || unclear) {
    const why = unclear ? `a round was ${unclear.verdict}` : 'not every round was asked'
    return done(notDecided(why), notDecided(why))
  }
  const sellerReasoning = Math.max(0, ...input.rounds.flatMap((round) => [...round.short, ...round.long].map((ask) => ask.reply.reasoning)))
  const crowdReasoning = Math.max(0, ...(input.crowd?.votes ?? []).map((vote) => vote.reasoning))
  const reasoningSeen = Math.max(0, ...input.referenceReasoning, sellerReasoning, crowdReasoning)
  const allGrowths = input.rounds.flatMap((round) => round.growths.filter((growth): growth is number => growth !== null))
  const minGrowth = Math.min(...allGrowths)

  // Growth: a pass is every round within a margin below the growth floor; a candidate is every round over.
  const growthCandidate = input.rounds.every((round) => round.verdict === 'over')
  const growthPass = input.rounds.every((round) => round.verdict === 'within' && round.tolerance < rule.growthFloor)
  // Fixed amount (plain mode only): a pass is a median excess at or below the floor; a candidate is the same amount
  // above it on every reply, every text asked twice.
  const offsetJudged = input.mode === 'plain' && offset.median !== null
  const offsetPass = offsetJudged && offset.median! <= rule.offsetFloor
  const offsetCandidate = offsetJudged && offset.fixed && offset.median! > rule.offsetFloor
  const allAskedTwice = input.rounds.every((round) => (round.short.length >= 2 && round.long.length >= 2) || round.repeats !== undefined)
  // Every repeat must be readable: an unreadable one leaves the fixed amount undecided.
  const repeatsUnreadable = input.rounds.some((round) => round.repeats && (round.repeats.short.reply.count === null || round.repeats.long.reply.count === null))

  let growth: OutputEchoV1['growth'] = growthPass ? { outcome: 'pass', reason: 'the seller bills the model\'s growth' }
    : notDecided(growthCandidate ? 'a candidate' : 'the growth is neither within the margin in every round nor over in every round')
  let fixedAmount: OutputEchoV1['fixedAmount'] = !offsetJudged ? notDecided('not judged in visible mode')
    : offsetPass ? { outcome: 'pass', reason: `the seller adds ${offset.median} tokens or fewer` }
      : notDecided(offsetCandidate ? 'a candidate' : 'the amount above the floor is not the same on every reply')
  if (!growthCandidate && !offsetCandidate) return done(growth, fixedAmount)
  if (!input.precheckMatch) {
    const why = 'this audit\'s pre-check did not match, so the seller\'s tokenizer is not known to be the reference\'s'
    return done(growthCandidate ? notDecided(why) : growth, offsetCandidate ? notDecided(why) : fixedAmount)
  }
  if (offsetCandidate && !allAskedTwice) return done(growth, notDecided('a candidate, to be asked every text again'), { needsSecondAsks: true })
  if (offsetCandidate && repeatsUnreadable) {
    fixedAmount = notDecided('a repeat of a text could not be read')
    // Nothing is left for the crowd to decide about the fixed amount: it is not asked for it.
    if (!growthCandidate) return done(growth, fixedAmount)
  }
  if (!input.crowd || input.crowd.incomplete) {
    const why = input.crowd ? 'not every other seller of the model answered in time' : 'the model\'s other sellers were not asked'
    return done(growthCandidate ? notDecided(why) : growth, offsetCandidate ? notDecided(why) : fixedAmount, { needsCrowd: !input.crowd })
  }
  if (growthCandidate) {
    const gaps = input.reference.map((round) => round.long.count - round.short.count)
    const margin = input.rounds.every((round, index) => round.growths.every((value) => value === null
      || (value > rule.growthFloor && value > rule.growthShare * gaps[index]!)))
    // Steady as a share of the gap: a factor keeps its share, a fixed extra on long replies loses it as the gap grows.
    const shares = input.rounds.flatMap((round, index) => round.growths.flatMap((value) => (value === null ? [] : [value / gaps[index]!])))
    const steady = steadyShares(input.rounds.flatMap((round, index) => round.growths.flatMap((value) => (value === null ? [] : [[value, gaps[index]!] as const]))), rule)
    const objection = !margin
      ? `the growth is not above ${rule.growthFloor} tokens and ${rule.growthShare * 100}% of the reference's gap in every round`
      : !steady
        ? `the growth is not steady as a share of the texts' gaps (from ${(Math.min(...shares) * 100).toFixed(1)}% to ${(Math.max(...shares) * 100).toFixed(1)}%)`
        : minGrowth <= rule.tolerance + reasoningSeen
          ? `the growth is not above the ${reasoningSeen} tokens of reasoning seen on these texts`
          : echoCrowdObjection(minGrowth, input.crowd.votes.map((vote) => vote.growth), 0, rule)
    growth = objection
      ? notDecided(objection)
      : { outcome: 'flag', reason: `the seller's output grows ${minGrowth} or more tokens faster than the model's from a short to a long reply, in every round, twice` }
  }
  if (offsetCandidate && !repeatsUnreadable) {
    const ownSpread = Math.max(...excesses) - Math.min(...excesses)
    const objection = offset.median! <= rule.tolerance + reasoningSeen
      ? `the amount is not above the ${reasoningSeen} tokens of reasoning seen on these texts`
      : echoCrowdObjection(offset.median!, input.crowd.votes.map((vote) => vote.offset), ownSpread, rule, rule.offsetFloor)
    fixedAmount = objection
      ? notDecided(objection)
      : { outcome: 'flag', reason: `the seller adds ${offset.median} tokens to every reply, short and long, twice, far above the model's other sellers` }
  }
  return done(growth, fixedAmount, { needsCrowd: true })
}

function readAsk(request: SignedSellerRequestV1, text: string, mode: EchoMode): EchoSellerAskV1 {
  const exchange = signedExchange(request)
  const reading = exchange ? readOutput(exchange.requestBody, exchange.response) : null
  const reply = exchange ? readEchoReply(reading, text, mode) : { count: null, reasoning: 0, unusable: request.failureReason ?? 'no signed answer' }
  return { request, reading, reply }
}

/** Asks the seller one text and reads it. */
async function askEcho(input: SignedSellerRequestInput, text: string, mode: EchoMode, thinking: Parameters<typeof outputEchoRequestBody>[0]['thinking'], rule: OutputEchoRule): Promise<EchoSellerAskV1> {
  const request = await askSellerSigned(input, outputEchoRequestBody({ service: input.service, text, thinking: thinking ?? null, rule }))
  return readAsk(request, text, mode)
}

function referenceView(reference: OutputEchoReferenceV1): OutputEchoV1['reference'] {
  return reference.rounds.map((round) => ({
    short: { text: round.short.text, count: round.short.count! },
    long: { text: round.long.text, count: round.long.count! },
  }))
}

/** The reason stored when the audit stopped before the check could decide. */
export const ECHO_STOPPED_REASON = 'the audit stopped before the check decided'
/** The reason stored when work for the fixed amount alone was stopped so that the questions keep their time. */
export const ECHO_SET_ASIDE_REASON = 'set aside so that the questions keep their time'
/** The longest the work for a fixed amount alone may take (its repeats and its crowd). */
export const ECHO_OFFSET_ONLY_TIME_LIMIT_MS = 5 * 60_000

/**
 * The findings of a check whose audit stopped: each finding keeps what it was decided as before any extra ask and
 * the crowd (`before`), unless that changed afterwards; a flag always needs the crowd, so it never stands.
 */
export function stoppedEcho(
  before: Pick<OutputEchoV1, 'growth' | 'fixedAmount'>,
  after: Pick<OutputEchoV1, 'growth' | 'fixedAmount'>,
  mode: EchoMode,
  rule: OutputEchoRule = OUTPUT_ECHO_RULE,
  why: string = ECHO_STOPPED_REASON,
): Pick<OutputEchoV1, 'outcome' | 'flag' | 'reason' | 'growth' | 'fixedAmount'> {
  const stopped = { outcome: 'inconclusive' as const, reason: why }
  const keep = (first: OutputEchoV1['growth'], last: OutputEchoV1['growth']) => (
    first.outcome !== 'flag' && canonicalJsonStringify(first) === canonicalJsonStringify(last) ? first : stopped
  )
  const growth = keep(before.growth, after.growth)
  const fixedAmount = keep(before.fixedAmount, after.fixedAmount)
  const offsetCounts = rule.offsetCounts && mode === 'plain'
  const outcome = growth.outcome === 'pass' && (fixedAmount.outcome === 'pass' || !offsetCounts) && (mode === 'plain' || rule.visibleCounts) ? 'pass' as const : 'inconclusive' as const
  // A pass kept through the stop says what passed; the rest says why it decided nothing.
  return { outcome, flag: null, reason: outcome === 'pass' ? `${growth.reason}; the rest was ${why === ECHO_STOPPED_REASON ? 'stopped with the audit' : why}` : why, growth, fixedAmount }
}

/**
 * Runs the echo check on one seller. A round is asked once, and again when it is over (always twice in `visible`
 * mode, and every text twice for a fixed-amount candidate). The crowd is asked only when the seller could be
 * flagged. Nothing is decided once the audit has stopped. Never rejects.
 */
export async function runOutputEcho(input: SignedSellerRequestInput & {
  reference: OutputEchoReferenceV1
  thinking?: Parameters<typeof outputEchoRequestBody>[0]['thinking']
  precheckMatch: boolean
  /** The crowd's votes on the first round's texts, asked of the model's other sellers; asking stops at `stop`. */
  crowd: (stop?: AbortSignal) => Promise<EchoCrowdV1>
  /**
   * Fires when work for the fixed amount alone must stop so that the questions keep their time (the audit's
   * `spare`). That work runs off the seller's idle clock and stops here without stopping the audit.
   */
  spare?: () => AbortSignal
  rule?: OutputEchoRule
}): Promise<OutputEchoV1 | null> {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  const reference = input.reference
  if (!reference.applies || !reference.mode) return null
  const mode = reference.mode
  const view = referenceView(reference)
  const referenceReasoning = reference.rounds.map(roundReasoning)
  const rounds: EchoRoundV1[] = []
  const judgeRound = (index: number, short: EchoSellerAskV1[], long: EchoSellerAskV1[]) => judgeEchoRound({
    short, long, reference: { short: view[index]!.short.count, long: view[index]!.long.count }, referenceReasoning: referenceReasoning[index]!, mode, rule,
  })
  for (const [index, texts] of view.entries()) {
    const short = [await askEcho(input, texts.short.text, mode, input.thinking, rule)]
    const long = [await askEcho(input, texts.long.text, mode, input.thinking, rule)]
    let judged = judgeRound(index, short, long)
    const firstGrowth = judged.growths[0] ?? null
    if (firstGrowth !== null && (mode === 'visible' || firstGrowth > judged.tolerance)) {
      short.push(await askEcho(input, texts.short.text, mode, input.thinking, rule))
      long.push(await askEcho(input, texts.long.text, mode, input.thinking, rule))
      judged = judgeRound(index, short, long)
    }
    rounds.push({ short, long, ...judged })
    if (judged.verdict === 'unusable' || judged.verdict === 'unstable') break
  }
  let crowd: EchoCrowdV1 | null = null
  const judge = () => judgeOutputEcho({ mode, reference: view, referenceReasoning, rounds, precheckMatch: input.precheckMatch, crowd, rule })
  let judged = judge()
  // What was decided before any extra ask or crowd: a stop later does not undo it (`stoppedEcho`).
  const before = judged
  // Work for the fixed amount alone (the growth is no candidate) runs off the seller's idle clock, within its own
  // time and the audit's spare time: when that runs out it stops, and the audit goes on to the questions.
  const offsetOnly = !rounds.every((round) => round.verdict === 'over')
  const spare = offsetOnly
    ? AbortSignal.any([AbortSignal.timeout(ECHO_OFFSET_ONLY_TIME_LIMIT_MS), ...(input.spare ? [input.spare()] : input.signal ? [input.signal] : [])])
    : null
  const extraInput: SignedSellerRequestInput = spare ? { ...input, clock: undefined, signal: spare } as SignedSellerRequestInput : input
  if (judged.needsSecondAsks) {
    // A fixed amount rests on every text asked twice: a single reply decides nothing. These repeats are its own and
    // never touch the growth's rounds.
    for (const [index, round] of rounds.entries()) {
      if (round.short.length >= 2 && round.long.length >= 2) continue
      if (spare?.aborted) break
      round.repeats = {
        short: await askEcho(extraInput, view[index]!.short.text, mode, input.thinking, rule),
        long: await askEcho(extraInput, view[index]!.long.text, mode, input.thinking, rule),
      }
    }
    judged = judge()
  }
  if (judged.needsCrowd && !spare?.aborted) {
    crowd = await input.crowd(spare ?? undefined)
    judged = judge()
  }
  // A decision that needed work after the audit stopped is no decision; one made before it stands.
  if (input.signal?.aborted) judged = { ...judged, ...stoppedEcho(before, judged, mode, rule) }
  else if (spare?.aborted) judged = { ...judged, ...stoppedEcho(before, judged, mode, rule, ECHO_SET_ASIDE_REASON) }
  return {
    rule, mode, outcome: judged.outcome, flag: judged.flag, growth: judged.growth, fixedAmount: judged.fixedAmount, reason: judged.reason,
    reference: view, referenceReasoning, referenceProvider: reference.provider, rounds, offset: judged.offset, precheckMatch: input.precheckMatch, crowd,
  }
}

/** Asks one other seller the first round's two texts, once each, as a crowd vote. Never rejects. */
export async function askEchoVote(
  input: SignedSellerRequestInput,
  reference: OutputEchoReferenceV1,
  thinking: Parameters<typeof outputEchoRequestBody>[0]['thinking'],
  rule: OutputEchoRule = OUTPUT_ECHO_RULE,
): Promise<EchoCrowdVoteV1> {
  const view = referenceView(reference)[0]!
  const mode = reference.mode ?? 'plain'
  const short = await askEcho(input, view.short.text, mode, thinking, rule)
  const long = await askEcho(input, view.long.text, mode, thinking, rule)
  return echoCrowdVote(input.peerId, short, long, { short: view.short.count, long: view.long.count }, rule)
}

const peerKey = (peerId: string): string => peerId.toLowerCase().replace(/^0x/, '')

/**
 * Recomputes a stored echo check from the bytes the seller and the crowd signed, as `verifier submit` does before
 * it sends the result. The reference's counts and reasoning are taken as stored, as the pre-check's are: they are
 * the auditor's own measurement. Throws when anything stored differs from what the bytes and the rule give.
 */
export function validateOutputEcho(record: OutputEchoV1, auditedPeerId?: string): void {
  const rule = outputEchoRuleById(record.rule?.id)
  if (!rule) throw new Error(`unknown echo check rule ${String(record.rule?.id)}`)
  if (canonicalJsonStringify(record.rule) !== canonicalJsonStringify(rule)) throw new Error('the echo check rule differs from the one this CLI knows')
  if (record.mode !== 'plain' && record.mode !== 'visible') throw new Error('the echo check has no mode')
  if (!Array.isArray(record.reference) || record.reference.length !== rule.rounds) throw new Error('the echo check has no reference for every round')
  for (const round of record.reference) {
    for (const side of [round.short, round.long]) {
      if (!isSafeProbe(` ${side.text}`) || !Number.isInteger(side.count)) throw new Error('an echo text or its reference count is not valid')
    }
    if (round.long.count - round.short.count < rule.minGap) throw new Error('an echo round\'s texts are too close at the reference')
  }
  if (!gapsDiffer(record.reference.map((round) => round.long.count - round.short.count), rule)) throw new Error('the echo check\'s round gaps are too close to each other')
  const reasoning = record.referenceReasoning
  if (!Array.isArray(reasoning) || reasoning.length !== rule.rounds
    || reasoning.some((value) => !Number.isInteger(value) || value < 0 || (record.mode === 'plain' && value !== 0))) {
    throw new Error('the echo check\'s reference reasoning is not valid')
  }
  if (!Array.isArray(record.rounds) || record.rounds.length > rule.rounds) throw new Error('the echo check has more rounds than its rule')
  const requestIds = requestsOf(record).flatMap((request) => request.requestIds)
  if (new Set(requestIds).size !== requestIds.length) throw new Error('an echo check repeats a request ID: every ask must be its own request')
  const signedIds = requestsOf(record).flatMap((request) => (request.responseAuth?.requestId ? [request.responseAuth.requestId] : []))
  if (new Set(signedIds).size !== signedIds.length) throw new Error('an echo check repeats an authenticated request ID')
  if (requestsOf(record).some((request) => request.responseAuth?.requestId && !request.requestIds.includes(request.responseAuth.requestId))) {
    throw new Error('an echo check\'s authenticated request is not one of its tries')
  }
  // A finding the compiled rule does not count can never be stored as a flag or a pass.
  const counted = (finding: 'growth' | 'offset'): boolean => (record.mode === 'visible' ? rule.visibleCounts : true) && (finding === 'offset' ? rule.offsetCounts : true)
  for (const [finding, value] of [['growth', record.growth], ['offset', record.fixedAmount]] as const) {
    if (value?.outcome !== 'inconclusive' && !counted(finding)) throw new Error(`the echo check's ${finding} is not counted under its rule, but is stored as ${String(value?.outcome)}`)
  }
  const signedBy = (ask: EchoSellerAskV1, peerId: string | undefined, who: string): void => {
    if (!peerId || ask.request.responseAuth?.status !== 'verified') return
    const signer = ask.request.responseAuth.record?.sellerPeerId
    if (typeof signer !== 'string' || peerKey(signer) !== peerKey(peerId)) throw new Error(`an echo reply of ${who} is not signed by it`)
  }
  const reread = (ask: EchoSellerAskV1, text: string): EchoSellerAskV1 => {
    const again = readAsk(ask.request, text, record.mode)
    if (canonicalJsonStringify(again.reading) !== canonicalJsonStringify(ask.reading) || canonicalJsonStringify(again.reply) !== canonicalJsonStringify(ask.reply)) {
      throw new Error('an echo reading differs from the signed bytes')
    }
    const exchange = signedExchange(ask.request)
    if (exchange && !requestCarriesPrompt(exchange.requestBody, outputEchoPrompt(text))) throw new Error('an echo request is not the one the seller signed')
    return again
  }
  for (const [index, round] of record.rounds.entries()) {
    const texts = record.reference[index]!
    const repeats = round.repeats ? [[[round.repeats.short], texts.short.text], [[round.repeats.long], texts.long.text]] as const : []
    for (const [asks, text] of [[round.short, texts.short.text], [round.long, texts.long.text], ...repeats] as const) {
      for (const ask of asks) {
        reread(ask, text)
        signedBy(ask, auditedPeerId, 'the audited seller')
      }
    }
    const judged = judgeEchoRound({ short: round.short, long: round.long, reference: { short: texts.short.count, long: texts.long.count }, referenceReasoning: reasoning[index]!, mode: record.mode, rule })
    if (canonicalJsonStringify(judged.growths) !== canonicalJsonStringify(round.growths) || judged.verdict !== round.verdict || judged.tolerance !== round.tolerance) {
      throw new Error('an echo round does not give its stored verdict')
    }
  }
  if (record.crowd) {
    const first = record.reference[0]!
    const peers = new Set(auditedPeerId ? [peerKey(auditedPeerId)] : [])
    for (const vote of record.crowd.votes) {
      if (typeof vote.peerId !== 'string' || peers.has(peerKey(vote.peerId))) throw new Error('an echo crowd vote is the audited seller\'s, or a second vote of one seller')
      peers.add(peerKey(vote.peerId))
      const short = reread(vote.short, first.short.text)
      const long = reread(vote.long, first.long.text)
      signedBy(vote.short, vote.peerId, 'a crowd seller')
      signedBy(vote.long, vote.peerId, 'a crowd seller')
      const again = echoCrowdVote(vote.peerId, short, long, { short: first.short.count, long: first.long.count }, rule, vote.sentHere)
      if (again.growth !== vote.growth || again.offset !== vote.offset || again.reasoning !== vote.reasoning) throw new Error('an echo crowd vote does not follow from its replies')
    }
  }
  // A check that failed before asking anything is inconclusive with no rounds.
  if (record.rounds.length === 0) {
    if (record.outcome !== 'inconclusive' || record.flag !== null || record.growth.outcome !== 'inconclusive' || record.fixedAmount.outcome !== 'inconclusive') {
      throw new Error('an echo check without rounds must be inconclusive in every finding')
    }
    return
  }
  const judged = judgeOutputEcho({ mode: record.mode, reference: record.reference, referenceReasoning: reasoning, rounds: record.rounds, precheckMatch: record.precheckMatch, crowd: record.crowd, rule })
  const same = judged.outcome === record.outcome && judged.flag === record.flag
    && canonicalJsonStringify([judged.growth, judged.fixedAmount, judged.offset, judged.reason]) === canonicalJsonStringify([record.growth, record.fixedAmount, record.offset, record.reason])
  if (same) return
  // A stopped check: what it was before any extra ask and the crowd is recomputed from its first replies alone.
  for (const why of [ECHO_STOPPED_REASON, ECHO_SET_ASIDE_REASON]) {
    if (!String(record.reason).includes(why === ECHO_STOPPED_REASON ? 'stopped' : why)) continue
    const first = judgeOutputEcho({
      mode: record.mode, reference: record.reference, referenceReasoning: reasoning, precheckMatch: record.precheckMatch, crowd: null, rule,
      rounds: record.rounds.map(({ repeats: _repeats, ...round }) => round),
    })
    const expected = stoppedEcho(first, judged, record.mode, rule, why)
    if (canonicalJsonStringify([expected.outcome, expected.flag, expected.reason, expected.growth, expected.fixedAmount, judged.offset])
      === canonicalJsonStringify([record.outcome, record.flag, record.reason, record.growth, record.fixedAmount, record.offset])) return
  }
  throw new Error(`the echo check outcome is ${record.outcome}, its rounds give ${judged.outcome}`)
}

function requestsOf(record: OutputEchoV1): SignedSellerRequestV1[] {
  return [
    ...record.rounds.flatMap((round) => [...round.short, ...round.long, ...(round.repeats ? [round.repeats.short, round.repeats.long] : [])].map((ask) => ask.request)),
    ...(record.crowd?.votes ?? []).flatMap((vote) => [vote.short.request, vote.long.request]),
  ]
}

/** The requests this check sent: its own asks and the crowd votes it asked (a shared vote is counted where it was sent). */
function sentRequests(record: OutputEchoV1): SignedSellerRequestV1[] {
  return [
    ...record.rounds.flatMap((round) => [...round.short, ...round.long, ...(round.repeats ? [round.repeats.short, round.repeats.long] : [])].map((ask) => ask.request)),
    ...(record.crowd?.votes ?? []).filter((vote) => vote.sentHere).flatMap((vote) => [vote.short.request, vote.long.request]),
  ]
}

export function outputEchoRequestCount(record: OutputEchoV1): number {
  return requestCountOf(outputEchoPaidRequests(record))
}

/** Every request the echo check paid for, in order: the seller's, then the crowd votes it sent itself. */
export function outputEchoPaidRequests(record: OutputEchoV1): PaidRequest[] {
  return sentRequests(record).map((request) => ({ requestCount: request.requestIds.length, attemptCosts: request.attemptCosts }))
}

/** What the echo check's requests cost, the crowd votes it sent included. They are paid for like question batches. */
export function outputEchoCost(record: OutputEchoV1): AuditCostSummaryV1 {
  return costOfRequests(outputEchoPaidRequests(record))
}

/** The echo check as an audit's summary carries it. */
export interface OutputEchoSummary {
  rule: string
  outcome: OutputEchoOutcome
  flag: OutputEchoV1['flag']
  growth: OutputEchoOutcome
  fixedAmount: OutputEchoOutcome
  reason: string
  growths: Array<Array<number | null>>
  offset: number | null
}

export function summarizeOutputEcho(record: OutputEchoV1): OutputEchoSummary {
  return {
    rule: record.rule.id,
    outcome: record.outcome,
    flag: record.flag,
    growth: record.growth.outcome,
    fixedAmount: record.fixedAmount.outcome,
    reason: record.reason,
    growths: record.rounds.map((round) => round.growths),
    offset: record.offset.median,
  }
}

export function describeOutputEchoFlag(record: Pick<OutputEchoV1, 'rule' | 'reason'>): string {
  return `echo check (${record.rule.id}): ${record.reason}; its questions were not asked`
}

/** The longest the model's other sellers are waited for, as for the pre-check's crowd. */
export const ECHO_CROWD_TIME_LIMIT_MS = 5 * 60_000

/** The echo check of one model's sellers in one run: the texts and the reference once, the crowd's votes shared. */
export interface OutputEchoScreen<Settings> {
  /** The texts and the reference's counts, measured once (first caller's settings). Never rejects. */
  ready: (settings: Settings) => Promise<OutputEchoReferenceV1>
  /** One seller's check; null when the check does not apply to the model this run. Never rejects. */
  check: (
    seller: { peerId: string; service: string; serviceAliases?: readonly string[] },
    settings: Settings,
    options: {
      thinking: Parameters<typeof outputEchoRequestBody>[0]['thinking']
      /** The thinking setting the model's other sellers are asked with: the reference's (the audited seller gets its own). */
      crowdThinking: Parameters<typeof outputEchoRequestBody>[0]['thinking']
      precheckMatch: boolean
      clock?: SignedSellerRequestInput['clock']
      /** The audit's spare time for work on the fixed amount alone (`runOutputEcho`). */
      spare?: () => AbortSignal
    },
  ) => Promise<OutputEchoV1 | null>
}

export function createOutputEchoScreen<Settings>(input: {
  /** The model's sellers the buyer would audit this run, the crowd (`tokenizerPrecheckSellers`). */
  sellers: ReadonlyArray<{ peerId: string; service: string; serviceAliases?: readonly string[] }>
  proxyBaseUrl: string
  responseAuthReader: SignedSellerRequestInput['responseAuthReader']
  limiter: SignedSellerRequestInput['limiter']
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  /** The reference's echo replies for the model, on the route of the audit's question set. */
  ask: (settings: Settings) => EchoReferenceAsk
  rule?: OutputEchoRule
  crowdTimeLimitMs?: number
  referenceTimeLimitMs?: number
  /** Told the reference record once it is prepared (the run writes it beside the model's audits). */
  onReady?: (reference: OutputEchoReferenceV1) => void
}): OutputEchoScreen<Settings> {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  let prepared: Promise<OutputEchoReferenceV1> | null = null
  const ready = (settings: Settings): Promise<OutputEchoReferenceV1> => {
    prepared ??= prepareOutputEchoReference({
      ask: input.ask(settings), rule, ...(input.referenceTimeLimitMs !== undefined ? { timeLimitMs: input.referenceTimeLimitMs } : {}),
    }).catch((error: unknown): OutputEchoReferenceV1 => ({
      rule, upstream: null, mode: null, provider: null, rounds: [], applies: false,
      reason: `the reference could not be asked (${error instanceof Error ? error.message : String(error)}), so the echo check does not apply this run`,
    })).then((reference) => {
      try { input.onReady?.(reference) } catch { /* a report is never a reason to fail the check */ }
      return reference
    })
    return prepared
  }
  // One vote per other seller and run, shared by every check of the model that needs it. A vote that measured
  // nothing is dropped, so the next check that needs it asks again.
  const votes = new Map<string, Promise<EchoCrowdVoteV1>>()
  const request = (seller: { peerId: string; service: string; serviceAliases?: readonly string[] }, signal?: AbortSignal): SignedSellerRequestInput => ({
    proxyBaseUrl: input.proxyBaseUrl,
    peerId: seller.peerId,
    service: seller.service,
    ...(seller.serviceAliases ? { serviceAliases: seller.serviceAliases } : {}),
    responseAuthReader: input.responseAuthReader,
    limiter: input.limiter,
    ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    ...(signal ? { signal } : {}),
  })
  return {
    ready,
    async check(seller, settings, options) {
      const reference = await ready(settings)
      if (!reference.applies) return null
      const stop = options.clock?.signal
      const crowd = async (sooner?: AbortSignal): Promise<EchoCrowdV1> => {
        const limit = AbortSignal.timeout(input.crowdTimeLimitMs ?? ECHO_CROWD_TIME_LIMIT_MS)
        const ends = AbortSignal.any([limit, ...(stop ? [stop] : []), ...(sooner ? [sooner] : [])])
        const others = input.sellers.filter((other) => peerKey(other.peerId) !== peerKey(seller.peerId))
        const asked = others.map((other) => {
          const key = peerKey(other.peerId)
          const shared = votes.get(key)
          if (shared) return shared.then((vote) => ({ ...vote, sentHere: false }))
          // Queued asks stop with the crowd's time, so no paid request is left running after it.
          const pending = askEchoVote(request(other, limit), reference, options.crowdThinking, rule)
          votes.set(key, pending)
          void pending.then((vote) => { if (vote.growth === null && votes.get(key) === pending) votes.delete(key) })
          return pending
        })
        const settled = await Promise.race([
          Promise.all(asked),
          new Promise<'late'>((resolve) => {
            if (ends.aborted) resolve('late')
            else ends.addEventListener('abort', () => resolve('late'), { once: true })
          }),
        ])
        if (settled === 'late') {
          const done = await Promise.all(asked.map((vote) => Promise.race([vote, Promise.resolve(null)])))
          return { votes: done.filter((vote): vote is EchoCrowdVoteV1 => vote !== null), incomplete: true }
        }
        return { votes: settled, incomplete: false }
      }
      const failed = (why: string): OutputEchoV1 => {
        const reason = why.slice(0, 300)
        return {
          rule, mode: reference.mode!, outcome: 'inconclusive', flag: null, reason,
          growth: { outcome: 'inconclusive', reason }, fixedAmount: { outcome: 'inconclusive', reason },
          reference: referenceView(reference), referenceReasoning: reference.rounds.map(roundReasoning), referenceProvider: reference.provider,
          rounds: [], offset: { median: null, fixed: false }, precheckMatch: options.precheckMatch, crowd: null,
        }
      }
      return runOutputEcho({
        ...request(seller),
        ...(options.clock ? { clock: options.clock, signal: options.clock.signal } : {}),
        reference,
        thinking: options.thinking,
        precheckMatch: options.precheckMatch,
        crowd,
        ...(options.spare ? { spare: options.spare } : {}),
        rule,
      }).catch((error: unknown) => failed(`the check failed: ${error instanceof Error ? error.message : String(error)}`))
    },
  }
}
