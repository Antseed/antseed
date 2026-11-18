import { canonicalJsonStringify } from '@antseed/fingerprints'
import { isSafeProbe } from '@antseed/node/payments'
import { readOutput, requestCarriesPrompt, type OutputReadingV1 } from './output-usage.js'
import type { AuditCostSummaryV1 } from './proxy-evidence.js'
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
 * compared with this epoch's reference for the same texts. Two things can flag, each only behind the model's
 * other sellers (the crowd) and with wide margins:
 * - `growth`: the seller's count grows faster from the short to the long text than the reference's, in every
 *   round and again when asked again. A constant a host adds to every reply cancels out of the growth.
 * - `offset`: the seller adds the same large amount to every reply, short and long, far above what the model's
 *   other sellers add.
 * Nothing else ever flags; anything unclear decides nothing.
 *
 * Every constant is here, frozen. The margins (`growthFloor`, `growthShare`, `offsetFloor`, `spreadFactor`) are
 * chosen above every honest value seen in the evals and on live sellers (constants of 3 tokens without reasoning
 * and 9 with; one relay's dropped reasoning at 16 tokens of growth), not measured bounds.
 */
export interface OutputEchoRule {
  id: 'output-echo-v1'
  /** Rounds of one short and one long text. */
  rounds: number
  /** Tokens within which two counts are the same. The tokenizer pre-check's. */
  tolerance: number
  /** Times the reference is asked each text; every ask must agree. */
  referenceAsks: number
  /** Times a text is written before the model is left unjudged by this check this run. */
  textTries: number
  /** The long text must measure at least this many tokens more than the short one at the reference. */
  minGap: number
  /** Reply limit of every echo request. */
  maxTokens: number
  /** A growth flag needs the growth above this many tokens, in every round. Chosen margin. */
  growthFloor: number
  /** … and above this share of the reference's gap between the two texts, in every round. Chosen margin. */
  growthShare: number
  /** An offset flag needs the fixed amount above this many tokens. Chosen margin. */
  offsetFloor: number
  /** The flagged amount must exceed the other sellers' median by more than this many times their spread. */
  spreadFactor: number
  /** The smallest spread used. */
  minSpread: number
  /** Other sellers that must be measured. */
  minOthers: number
  /** Other sellers that must sign the reference's count (within the tolerance). */
  minBackers: number
}

export const OUTPUT_ECHO_RULE: OutputEchoRule = Object.freeze({
  id: 'output-echo-v1',
  rounds: 3,
  tolerance: 2,
  referenceAsks: 2,
  textTries: 3,
  minGap: 150,
  maxTokens: 1024,
  growthFloor: 20,
  growthShare: 0.1,
  offsetFloor: 20,
  spreadFactor: 3,
  minSpread: 2,
  minOthers: 3,
  minBackers: 2,
})

export function outputEchoRuleById(id: string): OutputEchoRule | undefined {
  return id === OUTPUT_ECHO_RULE.id ? OUTPUT_ECHO_RULE : undefined
}

/**
 * How a model's echoes are counted this run, decided by its reference:
 * - `plain`: the reference echoes without any reasoning; a reply with a reasoning marker is not usable;
 * - `visible`: the reference itemises reasoning on every echo; the count is billed minus itemised reasoning, a
 *   reply that does not itemise is not usable, and each round's tolerance grows by its largest itemised count.
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

/** Reads one echo reply in a mode. Usable: signed usage, one finished answer, the text byte for byte, and the mode's reasoning rule. */
export function readEchoReply(reading: OutputReadingV1 | null, text: string, mode: EchoMode): EchoReplyV1 {
  const reasoning = reading?.reasoningTokens ?? 0
  const no = (why: string): EchoReplyV1 => ({ count: null, reasoning, unusable: why })
  if (!reading || reading.shape === null || reading.billedOutputTokens === null) return no('no reading')
  if (reading.estimated) return no('no signed usage')
  if (!reading.oneAnswer || reading.stops) return no('not one plain answer')
  if (!reading.finished) return no('not finished')
  if (reading.text !== text) return no('the text was changed')
  if (mode === 'plain') {
    return reading.reasoningMarker ? no('reasoning shown') : { count: reading.billedOutputTokens, reasoning: 0, unusable: null }
  }
  if (reading.reasoningTokens === null) return no('reasoning not itemised')
  return { count: reading.billedOutputTokens - reading.reasoningTokens, reasoning, unusable: null }
}

/** The request to repeat `text`, with the seller's own thinking settings. */
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

/** A short text (one probe's sentences) or a long one (four), from the pre-check's sentence writers; one line, guard-safe. */
export function writeEchoText(kind: 'short' | 'long', write: () => string = () => generateTokenizerProbe().b.trim()): string {
  const count = kind === 'short' ? 1 : 4
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
  /** The text's count at the reference: every ask usable, from one provider, within the tolerance; null otherwise. */
  count: number | null
  failure: string | null
}

/** Per model, run and auditor: the texts, the reference's counts and the mode, or why the check does not apply. */
export interface OutputEchoReferenceV1 {
  rule: OutputEchoRule
  upstream: unknown
  mode: EchoMode | null
  /** Short and long texts of each round. */
  rounds: Array<{ short: EchoReferenceTextV1; long: EchoReferenceTextV1 }>
  applies: boolean
  reason: string
}

/** One reference reply to an echo request: the answer's raw bytes and the request sent, or the failure. */
export type EchoReferenceAsk = (texts: readonly string[], signal?: AbortSignal) => Promise<{
  upstream: unknown
  results: ReadonlyArray<{ requestBody: Uint8Array; response: { statusCode: number; body: Uint8Array } | null; provider: string | null; failure: string | null }>
}>

/** The reference's count of a text from its asks, in a mode (`EchoReferenceTextV1.count`). */
export function referenceEchoCount(asks: EchoReferenceTextV1['asks'], rule: OutputEchoRule = OUTPUT_ECHO_RULE): { count: number | null; failure: string | null } {
  if (asks.length < rule.referenceAsks) return { count: null, failure: `the reference was asked ${asks.length} of ${rule.referenceAsks} times` }
  const unusable = asks.find((ask) => ask.unusable !== null)
  if (unusable) return { count: null, failure: `the reference's echo is not usable (${unusable.unusable})` }
  const providers = new Set(asks.map((ask) => ask.provider))
  if (providers.size !== 1) return { count: null, failure: 'the reference answered from more than one provider' }
  const counts = asks.map((ask) => ask.count!)
  if (Math.max(...counts) - Math.min(...counts) > rule.tolerance) return { count: null, failure: `the reference did not agree with itself (${counts.join(', ')})` }
  return { count: counts[0]!, failure: null }
}

/**
 * Writes the run's texts for a model and measures each on the reference, twice. The mode is the reference's:
 * `plain` when every echo is usable without reasoning, else `visible` when every echo itemises reasoning and
 * agrees with itself on its visible count. A text without a count is written again, up to `textTries`. The
 * check applies only when every round has both counts and a gap of at least `minGap`. Never rejects.
 */
export async function prepareOutputEchoReference(input: {
  ask: EchoReferenceAsk
  rule?: OutputEchoRule
  write?: (kind: 'short' | 'long') => string
}): Promise<OutputEchoReferenceV1> {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  const write = input.write ?? ((kind: 'short' | 'long') => writeEchoText(kind))
  let upstream: unknown = null
  const measure = async (kind: 'short' | 'long', text: string): Promise<{ plain: EchoReferenceTextV1; visible: EchoReferenceTextV1 }> => {
    const texts = Array.from({ length: rule.referenceAsks }, () => text)
    let asked: Awaited<ReturnType<EchoReferenceAsk>>
    try {
      asked = await input.ask(texts)
      upstream = asked.upstream
    } catch (error) {
      const failure = `the reference could not be asked: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300)
      const empty = { kind, text, asks: [], count: null, failure }
      return { plain: empty, visible: empty }
    }
    const inMode = (mode: EchoMode): EchoReferenceTextV1 => {
      const asks = asked.results.map((result) => {
        const reading = result.response ? readOutput(result.requestBody, result.response) : null
        const reply = result.failure ? { count: null, reasoning: 0, unusable: result.failure } : readEchoReply(reading, text, mode)
        return { count: reply.count, reasoning: reply.reasoning, provider: result.provider, unusable: reply.unusable }
      })
      const judged = referenceEchoCount(asks, rule)
      return { kind, text, asks, count: judged.count, failure: judged.failure }
    }
    return { plain: inMode('plain'), visible: inMode('visible') }
  }
  const measured: Array<Record<'short' | 'long', { plain: EchoReferenceTextV1; visible: EchoReferenceTextV1 }>> = []
  for (let round = 0; round < rule.rounds; round += 1) {
    const pair = {} as Record<'short' | 'long', { plain: EchoReferenceTextV1; visible: EchoReferenceTextV1 }>
    for (const kind of ['short', 'long'] as const) {
      let result = await measure(kind, write(kind))
      for (let attempt = 1; attempt < rule.textTries && result.plain.count === null && result.visible.count === null; attempt += 1) {
        result = await measure(kind, write(kind))
      }
      pair[kind] = result
    }
    measured.push(pair)
  }
  const all = measured.flatMap((pair) => [pair.short, pair.long])
  const mode: EchoMode | null = all.every((text) => text.plain.count !== null) ? 'plain'
    : all.every((text) => text.visible.count !== null) ? 'visible' : null
  const rounds = measured.map((pair) => ({ short: pair.short[mode ?? 'plain'], long: pair.long[mode ?? 'plain'] }))
  if (!mode) {
    const failed = rounds.flatMap((round) => [round.short, round.long]).find((text) => text.count === null)
    return { rule, upstream, mode, rounds, applies: false, reason: `the reference did not echo cleanly (${failed?.failure ?? 'no count'}), so the echo check does not apply to the model this run` }
  }
  const narrow = rounds.find((round) => round.long.count! - round.short.count! < rule.minGap)
  if (narrow) {
    return { rule, upstream, mode, rounds, applies: false, reason: `a long text measured less than ${rule.minGap} tokens more than its short one, so the echo check does not apply this run` }
  }
  return { rule, upstream, mode, rounds, applies: true, reason: `the reference echoes cleanly (${mode})` }
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
  /** The round's tolerance: the rule's, plus its largest itemised reasoning in `visible` mode. */
  tolerance: number
  verdict: 'within' | 'over' | 'unusable' | 'unstable'
}

/** A vote of one of the model's other sellers: the first round's two texts, asked once. */
export interface EchoCrowdVoteV1 {
  peerId: string
  short: EchoSellerAskV1
  long: EchoSellerAskV1
  /** Null when its echoes are not usable. */
  growth: number | null
  /** Its excess on the short text; null when not usable. */
  offset: number | null
  /** The largest reasoning its replies showed: itemised, or the excess of a reply with a reasoning marker. */
  reasoning: number
}

export interface EchoCrowdV1 {
  votes: EchoCrowdVoteV1[]
  /** Not every other seller answered within the crowd's time: nothing is decided. */
  incomplete: boolean
}

export type OutputEchoOutcome = 'flag' | 'pass' | 'inconclusive'

export interface OutputEchoV1 {
  rule: OutputEchoRule
  mode: EchoMode
  outcome: OutputEchoOutcome
  /** What flagged; null unless the outcome is `flag`. */
  flag: 'growth' | 'offset' | null
  reason: string
  /** The reference's counts, as measured for this run (texts and counts only). */
  reference: Array<{ short: { text: string; count: number }; long: { text: string; count: number } }>
  /** The largest reasoning the reference itemised on these texts (0 in `plain` mode). Stored as measured, like its counts. */
  referenceReasoning: number
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
  /** The largest itemised reasoning of the reference's asks of these two texts (`visible` mode). */
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
  // In `visible` mode each text is asked twice whatever it gives, and the seller's own two visible counts must agree.
  if (input.mode === 'visible') {
    if (second === null) return { growths, tolerance, verdict: 'unusable' }
    for (const side of [input.short, input.long]) {
      if (Math.abs(side[0]!.reply.count! - side[1]!.reply.count!) > rule.tolerance) return { growths, tolerance, verdict: 'unstable' }
    }
  }
  if (first <= tolerance) return { growths, tolerance, verdict: 'within' }
  // Over: only a growth the seller repeats is held against it.
  if (second === null) return { growths, tolerance, verdict: 'unusable' }
  if (second <= tolerance) return { growths, tolerance, verdict: 'within' }
  if (Math.abs(second - first) > tolerance) return { growths, tolerance, verdict: 'unstable' }
  return { growths, tolerance, verdict: 'over' }
}

/** A crowd vote from its two replies to the first round's texts. */
export function echoCrowdVote(
  peerId: string,
  short: EchoSellerAskV1,
  long: EchoSellerAskV1,
  reference: { short: number; long: number },
): EchoCrowdVoteV1 {
  const usable = short.reply.count !== null && long.reply.count !== null
  const markedExcess = (ask: EchoSellerAskV1, count: number): number => (
    ask.reading?.reasoningMarker && ask.reading.billedOutputTokens !== null ? Math.max(0, ask.reading.billedOutputTokens - count) : 0
  )
  return {
    peerId,
    short,
    long,
    growth: usable ? (long.reply.count! - reference.long) - (short.reply.count! - reference.short) : null,
    offset: usable ? short.reply.count! - reference.short : null,
    reasoning: Math.max(short.reply.reasoning, long.reply.reasoning, markedExcess(short, reference.short), markedExcess(long, reference.long)),
  }
}

/**
 * Whether the crowd holds a flagged amount (`growth` or `offset`) against the seller:
 * at least `minOthers` other sellers measured, at least `minBackers` of them within the tolerance of the
 * reference, none within the tolerance of the flagged amount, and the amount more than `spreadFactor` times their
 * spread above their median. Returns why not, or null when it holds.
 */
export function echoCrowdObjection(
  amount: number,
  votes: readonly (number | null)[],
  ownSpread: number,
  rule: OutputEchoRule = OUTPUT_ECHO_RULE,
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
  return null
}

/** The outcome of a seller's echo check from its rounds, its pre-check and the crowd (`null` crowd: not asked). */
export function judgeOutputEcho(input: {
  mode: EchoMode
  reference: OutputEchoV1['reference']
  /** The largest reasoning the reference showed on these texts. */
  referenceReasoning: number
  rounds: readonly Pick<EchoRoundV1, 'growths' | 'verdict' | 'short' | 'long'>[]
  precheckMatch: boolean
  crowd: EchoCrowdV1 | null
  rule?: OutputEchoRule
}): { outcome: OutputEchoOutcome; flag: OutputEchoV1['flag']; reason: string; offset: OutputEchoV1['offset']; needsCrowd: boolean } {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  const excesses = input.rounds.flatMap((round, index) => [
    ...round.short.map((ask) => (ask.reply.count === null ? null : ask.reply.count - input.reference[index]!.short.count)),
    ...round.long.map((ask) => (ask.reply.count === null ? null : ask.reply.count - input.reference[index]!.long.count)),
  ]).filter((value): value is number => value !== null)
  const offset = {
    median: excesses.length > 0 ? median(excesses) : null,
    fixed: excesses.length > 0 && Math.max(...excesses) - Math.min(...excesses) <= rule.tolerance,
  }
  const unclear = input.rounds.find((round) => round.verdict === 'unusable' || round.verdict === 'unstable')
  if (input.rounds.length < rule.rounds || unclear) {
    return { outcome: 'inconclusive', flag: null, offset, needsCrowd: false, reason: unclear ? `a round was ${unclear.verdict}` : 'not every round was asked' }
  }
  const sellerReasoning = Math.max(0, ...input.rounds.flatMap((round) => [...round.short, ...round.long].map((ask) => ask.reply.reasoning)))
  const crowdReasoning = Math.max(0, ...(input.crowd?.votes ?? []).map((vote) => vote.reasoning))
  const reasoningSeen = Math.max(input.referenceReasoning, sellerReasoning, crowdReasoning)

  const minGrowth = Math.min(...input.rounds.map((round) => Math.min(...round.growths.filter((growth): growth is number => growth !== null))))
  const growthCandidate = input.rounds.every((round) => round.verdict === 'over')
  const offsetCandidate = input.mode === 'plain' && offset.fixed && offset.median !== null && offset.median > rule.offsetFloor
  if (!growthCandidate && !offsetCandidate) return { outcome: 'pass', flag: null, offset, needsCrowd: false, reason: 'the seller bills the model\'s growth' }
  if (!input.precheckMatch) return { outcome: 'inconclusive', flag: null, offset, needsCrowd: false, reason: 'this audit\'s pre-check did not match, so the seller\'s tokenizer is not known to be the reference\'s' }
  if (!input.crowd) return { outcome: 'inconclusive', flag: null, offset, needsCrowd: true, reason: 'the model\'s other sellers were not asked' }
  if (input.crowd.incomplete) return { outcome: 'inconclusive', flag: null, offset, needsCrowd: true, reason: 'not every other seller of the model answered in time' }

  const reasons: string[] = []
  if (growthCandidate) {
    const gaps = input.reference.map((round) => round.long.count - round.short.count)
    const ownSpread = Math.max(...input.rounds.flatMap((round) => round.growths.filter((growth): growth is number => growth !== null)))
      - minGrowth
    const margin = input.rounds.every((round, index) => round.growths.every((growth) => growth === null
      || (growth > rule.growthFloor && growth > rule.growthShare * gaps[index]!)))
    const objection = !margin
      ? `the growth is not above ${rule.growthFloor} tokens and ${rule.growthShare * 100}% of the reference's gap in every round`
      : minGrowth <= rule.tolerance + reasoningSeen
        ? `the growth is not above the ${reasoningSeen} tokens of reasoning seen on these texts`
        : echoCrowdObjection(minGrowth, input.crowd.votes.map((vote) => vote.growth), ownSpread, rule)
    if (!objection) {
      return { outcome: 'flag', flag: 'growth', offset, needsCrowd: true, reason: `the seller's output grows ${minGrowth} or more tokens faster than the model's from a short to a long reply, in every round, twice` }
    }
    reasons.push(`growth: ${objection}`)
  }
  if (offsetCandidate) {
    const ownSpread = Math.max(...excesses) - Math.min(...excesses)
    const objection = offset.median! <= rule.tolerance + reasoningSeen
      ? `the amount is not above the ${reasoningSeen} tokens of reasoning seen on these texts`
      : echoCrowdObjection(offset.median!, input.crowd.votes.map((vote) => vote.offset), ownSpread, rule)
    if (!objection) {
      return { outcome: 'flag', flag: 'offset', offset, needsCrowd: true, reason: `the seller adds ${offset.median} tokens to every reply, far above the model's other sellers` }
    }
    reasons.push(`offset: ${objection}`)
  }
  return { outcome: 'inconclusive', flag: null, offset, needsCrowd: true, reason: reasons.join('; ') }
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

function referenceReasoningOf(reference: OutputEchoReferenceV1): number {
  return Math.max(0, ...reference.rounds.flatMap((round) => [...round.short.asks, ...round.long.asks].map((ask) => ask.reasoning)))
}

/**
 * Runs the echo check on one seller. A round is asked once, and again when it is over (always twice in `visible`
 * mode). The crowd is asked only when the seller could be flagged. Never rejects.
 */
export async function runOutputEcho(input: SignedSellerRequestInput & {
  reference: OutputEchoReferenceV1
  thinking?: Parameters<typeof outputEchoRequestBody>[0]['thinking']
  precheckMatch: boolean
  /** The crowd's votes on the first round's texts, asked of the model's other sellers. */
  crowd: () => Promise<EchoCrowdV1>
  rule?: OutputEchoRule
}): Promise<OutputEchoV1 | null> {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  const reference = input.reference
  if (!reference.applies || !reference.mode) return null
  const mode = reference.mode
  const view = referenceView(reference)
  const referenceReasoning = referenceReasoningOf(reference)
  const rounds: EchoRoundV1[] = []
  for (const texts of view) {
    const counts = { short: texts.short.count, long: texts.long.count }
    const short = [await askEcho(input, texts.short.text, mode, input.thinking, rule)]
    const long = [await askEcho(input, texts.long.text, mode, input.thinking, rule)]
    let judged = judgeEchoRound({ short, long, reference: counts, referenceReasoning, mode, rule })
    // Asked again when it is over, and always in `visible` mode, where the seller's own two counts must agree.
    const firstGrowth = judged.growths[0] ?? null
    if (firstGrowth !== null && (mode === 'visible' || firstGrowth > judged.tolerance)) {
      short.push(await askEcho(input, texts.short.text, mode, input.thinking, rule))
      long.push(await askEcho(input, texts.long.text, mode, input.thinking, rule))
      judged = judgeEchoRound({ short, long, reference: counts, referenceReasoning, mode, rule })
    }
    rounds.push({ short, long, ...judged })
    if (judged.verdict === 'unusable' || judged.verdict === 'unstable') break
  }
  let crowd: EchoCrowdV1 | null = null
  let judged = judgeOutputEcho({ mode, reference: view, referenceReasoning, rounds, precheckMatch: input.precheckMatch, crowd, rule })
  if (judged.needsCrowd) {
    crowd = await input.crowd()
    judged = judgeOutputEcho({ mode, reference: view, referenceReasoning, rounds, precheckMatch: input.precheckMatch, crowd, rule })
  }
  return { rule, mode, outcome: judged.outcome, flag: judged.flag, reason: judged.reason, reference: view, referenceReasoning, rounds, offset: judged.offset, precheckMatch: input.precheckMatch, crowd }
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
  return echoCrowdVote(input.peerId, short, long, { short: view.short.count, long: view.long.count })
}

/**
 * Recomputes a stored echo check from the bytes the seller and the crowd signed, as `verifier submit` does before
 * it sends the result. The reference's counts are taken as stored, as the pre-check's are. Throws when anything
 * stored differs from what the bytes and the rule give.
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
  const requestIds = requestsOf(record).flatMap((request) => request.requestIds)
  if (new Set(requestIds).size !== requestIds.length) throw new Error('an echo check repeats a request ID: every ask must be its own request')
  const reread = (ask: EchoSellerAskV1, text: string): EchoSellerAskV1 => {
    const again = readAsk(ask.request, text, record.mode)
    if (canonicalJsonStringify(again.reading) !== canonicalJsonStringify(ask.reading) || canonicalJsonStringify(again.reply) !== canonicalJsonStringify(ask.reply)) {
      throw new Error('an echo reading differs from the signed bytes')
    }
    const exchange = signedExchange(ask.request)
    if (exchange && !requestCarriesPrompt(exchange.requestBody, outputEchoPrompt(text))) throw new Error('an echo request is not the one the seller signed')
    return again
  }
  const referenceReasoning = record.referenceReasoning
  if (!Number.isInteger(referenceReasoning) || referenceReasoning < 0 || (record.mode === 'plain' && referenceReasoning !== 0)) {
    throw new Error('the echo check\'s reference reasoning is not valid')
  }
  if (record.rounds.length > rule.rounds) throw new Error('the echo check has more rounds than its rule')
  for (const [index, round] of record.rounds.entries()) {
    const texts = record.reference[index]!
    round.short.forEach((ask) => reread(ask, texts.short.text))
    round.long.forEach((ask) => reread(ask, texts.long.text))
    const judged = judgeEchoRound({ short: round.short, long: round.long, reference: { short: texts.short.count, long: texts.long.count }, referenceReasoning, mode: record.mode, rule })
    if (canonicalJsonStringify(judged.growths) !== canonicalJsonStringify(round.growths) || judged.verdict !== round.verdict || judged.tolerance !== round.tolerance) {
      throw new Error('an echo round does not give its stored verdict')
    }
  }
  if (record.crowd) {
    const first = record.reference[0]!
    for (const vote of record.crowd.votes) {
      if (auditedPeerId && vote.peerId.toLowerCase().replace(/^0x/, '') === auditedPeerId.toLowerCase().replace(/^0x/, '')) {
        throw new Error('the audited seller votes in its own crowd')
      }
      const short = reread(vote.short, first.short.text)
      const long = reread(vote.long, first.long.text)
      const again = echoCrowdVote(vote.peerId, short, long, { short: first.short.count, long: first.long.count })
      if (again.growth !== vote.growth || again.offset !== vote.offset || again.reasoning !== vote.reasoning) throw new Error('an echo crowd vote does not follow from its replies')
    }
  }
  const judged = judgeOutputEcho({ mode: record.mode, reference: record.reference, referenceReasoning, rounds: record.rounds, precheckMatch: record.precheckMatch, crowd: record.crowd, rule })
  if (judged.outcome !== record.outcome || judged.flag !== record.flag) throw new Error(`the echo check outcome is ${record.outcome}, its rounds give ${judged.outcome}`)
}

function requestsOf(record: OutputEchoV1): SignedSellerRequestV1[] {
  return [
    ...record.rounds.flatMap((round) => [...round.short, ...round.long].map((ask) => ask.request)),
    ...(record.crowd?.votes ?? []).flatMap((vote) => [vote.short.request, vote.long.request]),
  ]
}

export function outputEchoRequestCount(record: OutputEchoV1): number {
  return requestsOf(record).reduce((total, request) => total + request.requestIds.length, 0)
}

/** What the echo check's requests cost, the crowd's included. They are paid for like question batches. */
export function outputEchoCost(record: OutputEchoV1): AuditCostSummaryV1 {
  const requests = requestsOf(record)
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

/** The echo check as an audit's summary carries it. */
export interface OutputEchoSummary {
  rule: string
  outcome: OutputEchoOutcome
  flag: OutputEchoV1['flag']
  reason: string
  growths: Array<Array<number | null>>
  offset: number | null
}

export function summarizeOutputEcho(record: OutputEchoV1): OutputEchoSummary {
  return {
    rule: record.rule.id,
    outcome: record.outcome,
    flag: record.flag,
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
      precheckMatch: boolean
      clock?: SignedSellerRequestInput['clock']
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
}): OutputEchoScreen<Settings> {
  const rule = input.rule ?? OUTPUT_ECHO_RULE
  const key = (peerId: string): string => peerId.toLowerCase().replace(/^0x/, '')
  let prepared: Promise<OutputEchoReferenceV1> | null = null
  const ready = (settings: Settings): Promise<OutputEchoReferenceV1> => {
    prepared ??= prepareOutputEchoReference({ ask: input.ask(settings), rule }).catch((error: unknown): OutputEchoReferenceV1 => ({
      rule, upstream: null, mode: null, rounds: [], applies: false,
      reason: `the reference could not be asked (${error instanceof Error ? error.message : String(error)}), so the echo check does not apply this run`,
    }))
    return prepared
  }
  // One vote per other seller and run, shared by every check of the model that needs it.
  const votes = new Map<string, Promise<EchoCrowdVoteV1>>()
  const request = (seller: { peerId: string; service: string; serviceAliases?: readonly string[] }): SignedSellerRequestInput => ({
    proxyBaseUrl: input.proxyBaseUrl,
    peerId: seller.peerId,
    service: seller.service,
    ...(seller.serviceAliases ? { serviceAliases: seller.serviceAliases } : {}),
    responseAuthReader: input.responseAuthReader,
    limiter: input.limiter,
    ...(input.requestTimeoutMs !== undefined ? { requestTimeoutMs: input.requestTimeoutMs } : {}),
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
  })
  return {
    ready,
    async check(seller, settings, options) {
      const reference = await ready(settings)
      if (!reference.applies) return null
      const crowd = async (): Promise<EchoCrowdV1> => {
        const others = input.sellers.filter((other) => key(other.peerId) !== key(seller.peerId))
        const asked = others.map((other) => {
          let pending = votes.get(key(other.peerId))
          if (!pending) {
            pending = askEchoVote(request(other), reference, null, rule)
            votes.set(key(other.peerId), pending)
          }
          return pending
        })
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), input.crowdTimeLimitMs ?? ECHO_CROWD_TIME_LIMIT_MS) })
        const settled = await Promise.race([Promise.all(asked), late])
        clearTimeout(timer)
        if (settled === 'late') {
          const done = await Promise.all(asked.map((vote) => Promise.race([vote, Promise.resolve(null)])))
          return { votes: done.filter((vote): vote is EchoCrowdVoteV1 => vote !== null), incomplete: true }
        }
        return { votes: settled, incomplete: false }
      }
      return runOutputEcho({
        ...request(seller),
        ...(options.clock ? { clock: options.clock, signal: options.clock.signal } : {}),
        reference,
        thinking: options.thinking,
        precheckMatch: options.precheckMatch,
        crowd,
        rule,
      }).catch((error: unknown): OutputEchoV1 => ({
        rule, mode: reference.mode!, outcome: 'inconclusive', flag: null,
        reason: `the check failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
        reference: reference.rounds.map((round) => ({ short: { text: round.short.text, count: round.short.count! }, long: { text: round.long.text, count: round.long.count! } })),
        referenceReasoning: Math.max(0, ...reference.rounds.flatMap((round) => [...round.short.asks, ...round.long.asks].map((ask) => ask.reasoning))),
        rounds: [], offset: { median: null, fixed: false }, precheckMatch: options.precheckMatch, crowd: null,
      }))
    },
  }
}
