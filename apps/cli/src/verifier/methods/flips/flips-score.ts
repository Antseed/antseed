/**
 * FLIPS: a randomness check of a seller's model.
 *
 * Each request asks the model for 64 symbols drawn at random from two words ("give 64 random symbols from {wolf,
 * pine}"). Models are bad at randomness, and each model is bad in its own way: how often it switches words, how
 * long its runs get, how it starts, how long its replies are. A check compares the seller's replies with replies
 * of the genuine model (the reference) on the same two word pairs, statistic by statistic, with Welch's t². A swap
 * shows as large t² values; an honest seller stays near the reference.
 *
 * The score is the mean over 27 statistics and both pairs of Welch t², each capped at 50. A frozen calibration per
 * check size (20 or 40 replies) turns the score into a p-value: how unusual the score is for an honest seller. The
 * calibration is a Student-t tail on the log score, fitted on the eval's honest checks.
 *
 * A pair with more than half of its replies empty, content-filtered or failed, on the seller's side or the
 * reference's, makes the check inconclusive: such a check says nothing about randomness, and it is never a flag.
 *
 * Pure: no network, no clock, no randomness. The word pairs are chosen by the caller.
 */

/** Two words a reply draws its symbols from: the first word is symbol 0, the second symbol 1. */
export type FlipsPair = readonly [string, string]

/** The 27 statistics, in the order the score reads them. */
export const FLIPS_STATISTICS = Object.freeze([
  'len', 'lenErr', 'invalid', 'monobit', 'first', 'runs', 'long0', 'long1', 'longMax',
  's2_00', 's2_01', 's2_10', 's2_11',
  's3_000', 's3_001', 's3_010', 's3_011', 's3_100', 's3_101', 's3_110', 's3_111',
  'blockChi', 'cusumF', 'cusumB', 'apen', 'dft', 'short',
] as const)

export type FlipsStatisticName = (typeof FLIPS_STATISTICS)[number]

/** A Student-t tail fitted on the log scores of honest checks of one size. */
export interface FlipsCalibration {
  /** Total replies of a check this calibration is for (both pairs together). */
  replies: number
  /** Mean of ln(score) over the honest checks. */
  location: number
  /** Predictive spread: the sample standard deviation of ln(score) times sqrt(1 + 1/n). */
  scale: number
  /** n - 1, with n the number of honest checks in the fit. */
  degreesOfFreedom: number
  /** Honest checks the fit used. */
  honestChecks: number
}

export interface FlipsRule {
  id: string
  /** Symbols each request asks for. */
  symbols: number
  /** The one-shot example in the prompt: 0 is the pair's first word, 1 its second. Fixed for every model. */
  example: readonly (0 | 1)[]
  /** Word pairs in a check. */
  pairsPerCheck: number
  /** Seller replies per pair: first audit and confirmation. */
  repliesPerPair: { first: number; confirm: number }
  /** Reference replies per pair; the eval used 20 for its most expensive models. */
  referenceRepliesPerPair: number
  /** A reply with fewer valid symbols is "short": only its length statistics and `short` are measured. */
  minSymbols: number
  /** The count of tokens that are neither word is capped here. */
  invalidCap: number
  /** Block length of the block-frequency statistic. */
  blockLength: number
  /** Significance level of the spectral (DFT) peak threshold. */
  dftAlpha: number
  /** Each statistic's Welch t² is capped here before the mean. */
  t2Cap: number
  /** Ceiling of a single uncapped t², used only for `scoreMax`. */
  t2Ceiling: number
  /** t² of a statistic that is constant on both sides but at different values (Welch's t² would be infinite). */
  zeroVarianceT2: number
  /** One calibration per check size. */
  calibrations: readonly FlipsCalibration[]
  /** p at or below which a check flags: on a first audit, and on a confirmation of a FLIPS flag (fresh pairs, 40 replies). */
  bar: { first: number; confirm: number }
  /** p at or above which a check passes; between the bar and this it decides nothing. Set from the evals. */
  passAbove: number
  /**
   * Whether a FLIPS result counts toward the audit's verdict: by default, and never for the models listed (a known
   * split between the reference and honest hosts). A check that does not count is recorded only: its outcome and p
   * are kept for the report, and the verdict reads it as having no result.
   */
  counts: { default: boolean; never: readonly string[] }
  /**
   * Replies that hold no sequence (`flips-v2` on; a rule without it scores them as short replies). A reply with fewer
   * symbols of its pair than `below` holds none: it is left out of the sample on both sides, and a pair where more
   * than `maxShare` of one side's replies hold none has no result. A reply cut at the token limit that holds none spent
   * its budget reasoning (a host's placeholder text, say), so it shows reasoning for the profile. The check's size,
   * which picks the calibration, stays the scheduled one.
   */
  noSequence?: { below: number; maxShare: number }
  /**
   * Repeated replies (`flips-v2` on): a seller that returns one stored answer to several identical requests gives no
   * sample of the model. A pair has no result when the seller has at least `minReplies` replies with a sequence and at
   * least `sellerShare` of them repeat another one exactly, while under `referenceShare` of the reference's do (a
   * reference repeats a sequence in up to a quarter of its replies on its own).
   */
  repeats?: { sellerShare: number; referenceShare: number; minReplies: number }
  /** Every seller slot stores its asks (`FlipsSellerSlotV1.asks`), so its trail is checked (`flips-v2` on). */
  asksRequired?: true
  /**
   * A confirmation of a FLIPS flag whose FLIPS is scored between its bars (above the confirmation bar, at most
   * `passAbove`) clears that flag like a pass, when every other test it repeats passed (`flips-v2` on): a score between
   * the bars is no swap by the confirmation's own bar. A FLIPS with no result still clears nothing.
   */
  confirmBetweenClears?: true
}

/**
 * The first rule, recorded only everywhere. A used rule is never edited: stored evidence names its rule by id, and a
 * record counts only as its own rule says (`method.ts`).
 *
 * Calibrations: fitted on the eval's honest checks of each size
 * (ln score, Student-t, location = mean, scale = sd · sqrt(1 + 1/n), df = n − 1).
 */
export const FLIPS_RULE_V1: FlipsRule = Object.freeze({
  id: 'flips-v1',
  symbols: 64,
  example: Object.freeze([0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0] as const),
  pairsPerCheck: 2,
  repliesPerPair: Object.freeze({ first: 10, confirm: 20 }),
  referenceRepliesPerPair: 40,
  minSymbols: 8,
  invalidCap: 20,
  blockLength: 8,
  dftAlpha: 0.05,
  t2Cap: 50,
  t2Ceiling: 400,
  zeroVarianceT2: 25,
  calibrations: Object.freeze([
    Object.freeze({ replies: 20, location: 0.32852323817245566, scale: 0.5777006307374379, degreesOfFreedom: 596, honestChecks: 597 }),
    Object.freeze({ replies: 40, location: 0.32894647048005327, scale: 0.6468710574807611, degreesOfFreedom: 250, honestChecks: 251 }),
  ]),
  // The eval replay's best pair of bars (0.5% on the first audit, 0.1% on the confirmation). A pass needs p above 10%:
  // on the eval's 40-reply checks no swap that FLIPS flags on its first audit passes there, and 90% of honest checks do. FLIPS is recorded only everywhere until the dry run meets its conditions, and never counts
  // for MiniMax M3, whose honest sellers on another host than the reference's score like a swap.
  bar: Object.freeze({ first: 0.005, confirm: 0.001 }),
  passAbove: 0.1,
  counts: Object.freeze({ default: false, never: Object.freeze(['minimax-m3']) }),
})

/**
 * The rule new audits use: `flips-v1` with FLIPS counting (never for MiniMax M3, nor for a model the eval never
 * measured), replies that hold no sequence left out (`noSequence`: a host's placeholder text, say, is no answer to
 * score) and repeated replies giving no result (`repeats`). Bars, pass and calibrations are v1's.
 */
export const FLIPS_RULE: FlipsRule = Object.freeze({
  ...FLIPS_RULE_V1,
  id: 'flips-v2',
  counts: Object.freeze({ default: true, never: Object.freeze(['minimax-m3']) }),
  noSequence: Object.freeze({ below: 8, maxShare: 0.2 }),
  // A first bar of 0.2% (v1: 0.5%): at 0.5% the eval flagged one honest check on its first audit (one the confirmation
  // passed); at 0.2% none on its test half. The confirmation bar stays 0.1%.
  bar: Object.freeze({ first: 0.002, confirm: 0.001 }),
  repeats: Object.freeze({ sellerShare: 0.5, referenceShare: 0.25, minReplies: 4 }),
  asksRequired: true,
  confirmBetweenClears: true,
})

/**
 * How each audited model, and each model the eval measured that may become one, is asked, exactly as the eval asked it: the seller and the
 * reference get the same body, because the calibration never saw temperature or the thinking parameter vary between
 * them. `reasoning` is the lowest setting the model accepted with no reasoning tokens; `maxTokens` is 220, or 900 for a
 * model that still thinks; Claude and GPT models were sent no temperature, every other model temperature 1. A model
 * missing here was never measured: it is asked like the plain models, and FLIPS is recorded only for it.
 */
export interface FlipsRequestSettings {
  reasoning: Readonly<Record<string, unknown>>
  maxTokens: number
  temperature: boolean
}

const OFF = Object.freeze({ enabled: false })
const MINIMAL = Object.freeze({ effort: 'minimal' })
const LOW = Object.freeze({ effort: 'low' })
const request = (reasoning: Readonly<Record<string, unknown>>, maxTokens: number, temperature: boolean): FlipsRequestSettings =>
  Object.freeze({ reasoning, maxTokens, temperature })

export const FLIPS_REQUESTS: Readonly<Record<string, FlipsRequestSettings>> = Object.freeze({
  'claude-fable-5.2': request(MINIMAL, 220, false),
  'claude-opus-5.5': request(MINIMAL, 220, false),
  'claude-sonnet-5.5': request(MINIMAL, 220, false),
  'deepseek-v4-pro': request(OFF, 220, true),
  'gemini-3.1-pro-preview': request(LOW, 900, true),
  'gemini-4-argon': request(MINIMAL, 220, true),
  'glm-5.3': request(LOW, 900, true),
  'gpt-6-astra': request(MINIMAL, 900, false),
  'gpt-6.1-sol': request(MINIMAL, 900, false),
  'grok-4.7': request(MINIMAL, 900, true),
  'kimi-k3': request(OFF, 220, true),
  'kimi-k3.1-pro': request(OFF, 220, true),
  'mimo-v2.6-pro': request(OFF, 220, true),
  'minimax-m3': request(OFF, 220, true),
  'qwen3.8-27b': request(OFF, 220, true),
})

/** The plain request of a model the eval never measured. */
const UNMEASURED = request(OFF, 220, true)

/** The request settings of a model (its audited-model key), and whether the eval measured it. */
export function flipsRequestFor(model: string): { settings: FlipsRequestSettings; measured: boolean } {
  const settings = FLIPS_REQUESTS[model.toLowerCase()]
  return settings ? { settings, measured: true } : { settings: UNMEASURED, measured: false }
}

/** The body of every FLIPS request of a model, the seller's and the reference's alike. */
export function flipsRequestBody(model: string, service: string, pair: FlipsPair, rule: FlipsRule = FLIPS_RULE): Record<string, unknown> {
  const { settings } = flipsRequestFor(model)
  return {
    model: service,
    messages: [{ role: 'user', content: flipsPrompt(pair, rule) }],
    max_tokens: settings.maxTokens,
    ...(settings.temperature ? { temperature: 1 } : {}),
    reasoning: { ...settings.reasoning },
    stream: false,
  }
}

/**
 * Whether FLIPS counts toward the verdict for this model (its audited-model key): when the rule counts by default,
 * the model is not one it never counts for, and the eval measured the model.
 */
export function flipsCounts(model: string, rule: FlipsRule = FLIPS_RULE): boolean {
  return rule.counts.default && !rule.counts.never.includes(model.toLowerCase()) && flipsRequestFor(model).measured
}

const RULES: ReadonlyMap<string, FlipsRule> = new Map([FLIPS_RULE_V1, FLIPS_RULE].map((rule) => [rule.id, rule]))

/** The rule stored evidence was judged by; undefined for an id this CLI does not know. */
export function flipsRuleById(id: string): FlipsRule | undefined {
  return RULES.get(id)
}

/** Characters the parser turns into spaces. A word that contains one can never be read back. */
const STRIPPED = /[`*[\]{}"'.;]/g
const SEPARATORS = /[\s,]+/

/**
 * A pair the parser can read back: two different non-empty words with no space, comma or stripped character.
 * Matching is exact and case-sensitive.
 */
export function isValidFlipsPair(pair: FlipsPair): boolean {
  const [a, b] = pair
  const ok = (w: string): boolean => w.length > 0 && !/[\s,]/.test(w) && w.replace(STRIPPED, '') === w
  return ok(a) && ok(b) && a !== b
}

/** The user message of every FLIPS request. No system message; the example is the same for every model. */
export function flipsPrompt(pair: FlipsPair, rule: FlipsRule = FLIPS_RULE): string {
  const [a, b] = pair
  const example = rule.example.map((x) => (x ? b : a)).join(' ')
  return (
    `Give a sequence of ${rule.symbols} symbols drawn uniformly at random from the set {${a}, ${b}}. ` +
    'Write the symbols separated by single spaces. Output only the sequence, with no explanation or formatting.\n' +
    `Example of the format (${rule.example.length} symbols): ${example}\n` +
    `Now give your sequence of ${rule.symbols} symbols.`
  )
}

export interface FlipsParsedReply {
  /** The reply's symbols in order: 0 for the pair's first word, 1 for its second. */
  symbols: (0 | 1)[]
  /** Tokens that are neither word (uncapped). */
  invalid: number
}

/**
 * Reads a reply into symbols. Backticks, asterisks, brackets, braces, quotes, full stops and semicolons become
 * spaces; the text is split on whitespace and commas; a token is a symbol only when it equals one of the words
 * exactly. Everything else counts as invalid.
 */
export function parseFlipsReply(content: string, pair: FlipsPair): FlipsParsedReply {
  const [a, b] = pair
  const tokens = content.replace(STRIPPED, ' ').split(SEPARATORS).filter(Boolean)
  const symbols: (0 | 1)[] = []
  let invalid = 0
  for (const t of tokens) {
    if (t === a) symbols.push(0)
    else if (t === b) symbols.push(1)
    else invalid++
  }
  return { symbols, invalid }
}

/** One reply of a FLIPS request. `content` null: the request failed and returned no reply. */
export interface FlipsReplyV1 {
  content: string | null
  finishReason: string | null
}

/**
 * Whether a reply holds no sequence under the rule (`noSequence`): fewer symbols of its pair than the rule's line.
 * Always false under a rule without it.
 */
export function holdsNoSequence(reply: FlipsReplyV1, pair: FlipsPair, rule: FlipsRule = FLIPS_RULE): boolean {
  if (!rule.noSequence) return false
  return reply.content === null || parseFlipsReply(reply.content, pair).symbols.length < rule.noSequence.below
}

/** Empty, content-filtered or failed. Counts towards the inconclusive rule. */
export function isEmptyFlipsReply(reply: FlipsReplyV1): boolean {
  return reply.content === null || reply.content.trim() === '' || reply.finishReason === 'content_filter'
}

/**
 * The 27 statistics of one reply, in `FLIPS_STATISTICS` order. NIST SP 800-22 style test statistics (raw values,
 * not p-values) of the symbol sequence, plus its length and invalid count. A reply with fewer than `minSymbols`
 * symbols gets only `len`, `lenErr`, `invalid` and `short` = 1; its other statistics are 0.
 */
export function flipsStatistics(content: string, pair: FlipsPair, rule: FlipsRule = FLIPS_RULE): number[] {
  const { symbols: x, invalid } = parseFlipsReply(content, pair)
  const n = x.length
  const f: Record<FlipsStatisticName, number> = Object.fromEntries(FLIPS_STATISTICS.map((s) => [s, 0])) as Record<FlipsStatisticName, number>
  f.len = n
  f.lenErr = Math.abs(n - rule.symbols)
  f.invalid = Math.min(invalid, rule.invalidCap)
  if (n < rule.minSymbols) {
    f.short = 1
    return FLIPS_STATISTICS.map((s) => f[s])
  }
  // monobit: normalized excess of 1s
  let ones = 0
  for (const v of x) ones += v
  f.monobit = (2 * ones - n) / Math.sqrt(n)
  f.first = x[0]!
  // runs per symbol and the longest run of each word
  let runs = 1
  let cur = 1
  const longest = [0, 0]
  for (let i = 1; i < n; i++) {
    if (x[i] === x[i - 1]) cur++
    else {
      longest[x[i - 1]!] = Math.max(longest[x[i - 1]!]!, cur)
      cur = 1
      runs++
    }
  }
  longest[x[n - 1]!] = Math.max(longest[x[n - 1]!]!, cur)
  f.runs = runs / n
  f.long0 = longest[0]!
  f.long1 = longest[1]!
  f.longMax = Math.max(longest[0]!, longest[1]!)
  // overlapping serial patterns of length 2 and 3, as frequencies (not wrapped)
  const c2 = [0, 0, 0, 0]
  const c3 = [0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i + 1 < n; i++) c2[x[i]! * 2 + x[i + 1]!]!++
  for (let i = 0; i + 2 < n; i++) c3[x[i]! * 4 + x[i + 1]! * 2 + x[i + 2]!]!++
  f.s2_00 = c2[0]! / (n - 1)
  f.s2_01 = c2[1]! / (n - 1)
  f.s2_10 = c2[2]! / (n - 1)
  f.s2_11 = c2[3]! / (n - 1)
  f.s3_000 = c3[0]! / (n - 2)
  f.s3_001 = c3[1]! / (n - 2)
  f.s3_010 = c3[2]! / (n - 2)
  f.s3_011 = c3[3]! / (n - 2)
  f.s3_100 = c3[4]! / (n - 2)
  f.s3_101 = c3[5]! / (n - 2)
  f.s3_110 = c3[6]! / (n - 2)
  f.s3_111 = c3[7]! / (n - 2)
  // block frequency chi-square over whole blocks of M symbols
  const M = rule.blockLength
  const blocks = Math.floor(n / M)
  let chi = 0
  for (let b = 0; b < blocks; b++) {
    let s = 0
    for (let k = 0; k < M; k++) s += x[b * M + k]!
    chi += (s / M - 0.5) ** 2
  }
  f.blockChi = blocks ? (4 * M * chi) / blocks : 0
  // cumulative sums: largest excursion of the ±1 walk, forward and backward, over sqrt(n)
  let s = 0
  let mx = 0
  for (const v of x) {
    s += v ? 1 : -1
    mx = Math.max(mx, Math.abs(s))
  }
  f.cusumF = mx / Math.sqrt(n)
  s = 0
  mx = 0
  for (let i = n - 1; i >= 0; i--) {
    s += x[i] ? 1 : -1
    mx = Math.max(mx, Math.abs(s))
  }
  f.cusumB = mx / Math.sqrt(n)
  // approximate entropy, m = 2, patterns wrapped around the end
  const phi = (m: number): number => {
    const counts = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      let key = 1 // leading 1 keeps patterns of one length apart
      for (let j = 0; j < m; j++) key = key * 2 + x[(i + j) % n]!
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    let t = 0
    for (const c of counts.values()) t += (c / n) * Math.log(c / n)
    return t
  }
  f.apen = phi(2) - phi(3)
  // spectral: DFT moduli of the ±1 sequence below the 95% peak threshold, as NIST's normalized difference
  const T = Math.sqrt(Math.log(1 / rule.dftAlpha) * n)
  let below = 0
  for (let k = 0; k < Math.floor(n / 2); k++) {
    let re = 0
    let im = 0
    for (let t = 0; t < n; t++) {
      const angle = (2 * Math.PI * k * t) / n
      const v = x[t] ? 1 : -1
      re += v * Math.cos(angle)
      im -= v * Math.sin(angle)
    }
    if (Math.hypot(re, im) < T) below++
  }
  const share = 1 - rule.dftAlpha
  f.dft = (below - (share * n) / 2) / Math.sqrt((n * share * rule.dftAlpha) / 4)
  return FLIPS_STATISTICS.map((name) => f[name])
}

/**
 * Welch's t² of one statistic between the reference's values and the seller's, before the cap: the squared
 * difference of the means over (var_a / n_a + var_b / n_b), with sample variances (n − 1; a lone value has
 * variance 0). Ceiling `t2Ceiling`. Null when both sides are constant at the same value (the statistic is left
 * out); `zeroVarianceT2` when both are constant at different values.
 */
export function welchT2(reference: readonly number[], seller: readonly number[], rule: FlipsRule = FLIPS_RULE): number | null {
  // A column whose values are all equal has exactly that mean and variance 0. Summing first would leave a rounding
  // error in the mean (e.g. 40 x 32/63), so two equal constants would give a tiny difference over a tiny variance: a
  // large t² where the term must be left out.
  const constant = (a: readonly number[]): boolean => a.every((v) => v === a[0])
  const mean = (a: readonly number[]): number => (constant(a) ? (a[0] as number) : a.reduce((s, v) => s + v, 0) / a.length)
  const variance = (a: readonly number[], m: number): number => (constant(a) ? 0 : a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1))
  const ma = mean(reference)
  const mb = mean(seller)
  const se = variance(reference, ma) / reference.length + variance(seller, mb) / seller.length
  if (se === 0) return ma === mb ? null : rule.zeroVarianceT2
  return Math.min((ma - mb) ** 2 / se, rule.t2Ceiling)
}

/** Statistics vectors of one pair: one row per reply. */
export interface FlipsPairStatistics {
  reference: readonly (readonly number[])[]
  seller: readonly (readonly number[])[]
}

export interface FlipsScore {
  /** Mean of the capped t² over every statistic of every pair that was not left out. Higher means more likely a swap. */
  score: number
  /** The largest single t² before the cap (diagnostic only). */
  scoreMax: number
  /** Statistic × pair terms in the mean. */
  terms: number
}

/** The score of a check from its statistics, pair by pair. Null when a pair has no reply on a side, or no term is left. */
export function flipsScoreFromStatistics(pairs: readonly FlipsPairStatistics[], rule: FlipsRule = FLIPS_RULE): FlipsScore | null {
  let total = 0
  let terms = 0
  let scoreMax = 0
  for (const { reference, seller } of pairs) {
    if (!reference.length || !seller.length) return null
    for (let k = 0; k < FLIPS_STATISTICS.length; k++) {
      const raw = welchT2(reference.map((r) => r[k]!), seller.map((r) => r[k]!), rule)
      if (raw === null) continue
      total += Math.min(raw, rule.t2Cap)
      terms++
      scoreMax = Math.max(scoreMax, raw)
    }
  }
  return terms ? { score: total / terms, scoreMax, terms } : null
}

/** One word pair of a check: the reference's replies and the seller's. */
export interface FlipsPairSampleV1 {
  pair: FlipsPair
  reference: readonly FlipsReplyV1[]
  seller: readonly FlipsReplyV1[]
}

/**
 * `scored`: a score and its p-value. `inconclusive`: a pair had more than half its replies empty, filtered or
 * failed, or there was nothing to score. Never a flag.
 */
export type FlipsOutcome = 'scored' | 'inconclusive'

export interface FlipsJudgementV1 {
  rule: string
  outcome: FlipsOutcome
  score: number | null
  scoreMax: number | null
  /** How unusual the score is for an honest seller of a check this size; null when inconclusive. */
  p: number | null
  /** Seller replies of the check, failed ones included: the size the calibration is chosen by. */
  replies: number
  /** Why the check is inconclusive; empty when scored. */
  reasons: string[]
}

/**
 * Judges one check. Failed replies (`content` null) count as empty for the inconclusive rule and are left out of
 * the statistics. Empty and content-filtered replies that did return stay in the statistics (an empty reply is
 * a short one), as in the eval.
 */
export function judgeFlipsCheck(
  pairs: readonly FlipsPairSampleV1[],
  rule: FlipsRule = FLIPS_RULE,
  /** The check's size when replies were left out of `pairs` (`noSequence`): the scheduled seller replies. */
  scheduledReplies?: number,
): FlipsJudgementV1 {
  const replies = scheduledReplies ?? pairs.reduce((s, p) => s + p.seller.length, 0)
  const reasons: string[] = []
  if (pairs.length !== rule.pairsPerCheck) reasons.push(`${pairs.length} word pairs, the rule needs ${rule.pairsPerCheck}`)
  for (const { pair, reference, seller } of pairs) {
    if (!isValidFlipsPair(pair)) reasons.push(`word pair ${pair[0]}/${pair[1]} cannot be read back`)
    for (const [side, list] of [['seller', seller], ['reference', reference]] as const) {
      const empty = list.filter(isEmptyFlipsReply).length
      if (!list.length) reasons.push(`${pair[0]}/${pair[1]}: no ${side} replies`)
      else if (empty * 2 > list.length) reasons.push(`${pair[0]}/${pair[1]}: ${empty} of ${list.length} ${side} replies empty, filtered or failed`)
    }
  }
  const inconclusive = (why: string[]): FlipsJudgementV1 => ({ rule: rule.id, outcome: 'inconclusive', score: null, scoreMax: null, p: null, replies, reasons: why })
  if (!flipsCalibrationFor(replies, rule)) reasons.push(`no calibration for ${replies} replies`)
  if (reasons.length) return inconclusive(reasons)
  const stats = (list: readonly FlipsReplyV1[], pair: FlipsPair): number[][] =>
    list.filter((r) => r.content !== null).map((r) => flipsStatistics(r.content!, pair, rule))
  const scored = flipsScoreFromStatistics(pairs.map(({ pair, reference, seller }) => ({ reference: stats(reference, pair), seller: stats(seller, pair) })), rule)
  if (!scored) return inconclusive(['no statistic could be compared'])
  return { rule: rule.id, outcome: 'scored', score: scored.score, scoreMax: scored.scoreMax, p: flipsPValue(scored.score, replies, rule), replies, reasons: [] }
}

/** The calibration for a check of this many seller replies; undefined when the rule has none for that size. */
export function flipsCalibrationFor(replies: number, rule: FlipsRule = FLIPS_RULE): FlipsCalibration | undefined {
  return rule.calibrations.find((c) => c.replies === replies)
}

/**
 * P(an honest check of this size scores at least `score`), from the frozen calibration: the upper tail of a
 * Student t at (ln score − location) / scale. Floored at 1e-300. Throws for a size the rule has no calibration for.
 */
export function flipsPValue(score: number, replies: number, rule: FlipsRule = FLIPS_RULE): number {
  const cal = flipsCalibrationFor(replies, rule)
  if (!cal) throw new RangeError(`${rule.id} has no calibration for ${replies} replies`)
  if (!Number.isFinite(score)) throw new RangeError(`FLIPS score must be finite, got ${score}`)
  const z = (Math.log(Math.max(score, 1e-6)) - cal.location) / cal.scale
  return Math.max(studentTUpperTail(z, cal.degreesOfFreedom), 1e-300)
}

// ---- Student t tail (Numerical Recipes: Lanczos log-gamma, continued-fraction incomplete beta) ----

function logGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (const v of c) ser += v / ++y
  return -tmp + Math.log((2.5066282746310005 * ser) / x)
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-15) break
  }
  return h
}

/** Regularized incomplete beta I_x(a, b). */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lbt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)
  return x < (a + 1) / (a + b + 2) ? (Math.exp(lbt) * betaContinuedFraction(a, b, x)) / a : 1 - (Math.exp(lbt) * betaContinuedFraction(b, a, 1 - x)) / b
}

/** P(T > t) for a Student t with `df` degrees of freedom. */
export function studentTUpperTail(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t))
  return t >= 0 ? tail : 1 - tail
}
