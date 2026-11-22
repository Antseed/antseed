import { randomInt } from 'node:crypto'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { encodeHttpResponse } from '@antseed/node'
import { PROBE_GUARD_RANGES, isSafeProbe, signedResponseInputUsage } from '@antseed/node/payments'
import type { AuditTaskLimiter } from '../../audit-concurrency.js'
import {
  costOfRequests,
  requestCountOf,
  type AuditCostSummaryV1,
  type PaidRequest,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditExchangeCostV1,
} from '../../proxy-evidence.js'
import type { ResponseAuthReader } from '../../response-auth-reader.js'
import type { SellerClock } from '../shared/seller-clock.js'
import { SIGNED_REQUEST_TRIES, sendSignedRequest, signedExchange } from '../shared/signed-seller-request.js'
import { requestAsksOnly } from './tokenizer-request.js'
import { asError } from '../../utils.js'

/**
 * The tokenizer pre-check: a cheap screen `verifier run` runs before a seller's KBF questions.
 *
 * A round sends a message A, then A followed by B, to the seller and to the model's reference endpoint. The
 * difference in input tokens is B's length in the tokenizer that ran; the chat template and any hidden system
 * prompt are in both requests and cancel out. A seller whose signed difference is off the reference's in every
 * round, the same way when asked again, is not counting with the model's tokenizer: it serves another model, or
 * signs usage that is not the model's. That is a flag, and the audit's verdict is a DIFF; the questions and the other
 * tests still run beside it (rule `all-tests-v1`), so the evidence holds every test's result.
 *
 * The check only ever adds a DIFF. A match proves little (models of one family share a tokenizer, and a seller
 * can compute the model's count itself), so a match is a pass and decides nothing on its own. Anything
 * unclear decides nothing either: a failed request, no signed usage, a count that changes between two asks of the
 * same text (hidden input that varies), a count that is off while the response reports cached input (upstream
 * caches move with every request, and gateways differ in whether a count includes them), a pair whose second
 * count is not above its first, or a reference that cannot be relied on: one that does not agree with itself,
 * reports cached input or answers from two providers.
 *
 * A reference can also be wrong while it agrees with itself, so a seller off it in every round is held against
 * the model's other sellers before it is a mismatch (`tokenizerCrowd`): another seller must sign the reference's
 * count, and the sellers on one other count must not outnumber those on the reference's.
 */
export interface TokenizerPrecheckRule {
  id: string
  /** Rounds a mismatch needs: the seller must be off the reference in every one. */
  rounds: number
  /**
   * How far a seller's difference may be from the reference's and still count as the model's tokenizer, and how
   * far its own asks of one round may be apart and still count as one answer.
   */
  toleranceTokens: number
  /** Times the reference is asked each pair; its differences must all be equal. */
  referenceAsks: number
  /** Times a seller off the reference is asked a round's pair; the round counts only when its differences agree. */
  sellerAsks: number
  /**
   * Sellers that must sign one same count, off the reference's, before they can outvote it. They do when they
   * are also more than the sellers that sign the reference's count. Two: two honest sellers outvote a wrong
   * reference that one other seller shares (a reseller of the reference's own host), and a lone seller off the
   * reference cannot outvote one that signs its count.
   */
  outvoteSellers: number
  /**
   * Other sellers of the model that must sign the reference's count in the same run before a seller off it is a
   * mismatch. Without one nothing in the run backs the reference, so a model with a single seller never gets a
   * pre-check DIFF.
   */
  corroboratingSellers: number
  /** Reply limit of every request. Lower limits cut reasoning models off before they report usage. */
  maxTokens: number
  /**
   * A pair whose two answers (A, and A + B) report the same cached amount is kept (`tokenizer-precheck-v3`): the cache
   * cancels out of the difference, whether the count includes it or leaves it out. Without it any cached input leaves
   * the pair without a measurement, which leaves a model whose reference always reports cached input without a test.
   */
  sameCacheCancels?: true
}

/** The first rule, a tolerance of 2 tokens. A used rule is never edited: stored evidence names its rule by id. */
export const TOKENIZER_PRECHECK_RULE_V1: TokenizerPrecheckRule = Object.freeze({
  id: 'tokenizer-precheck-v1',
  rounds: 3,
  toleranceTokens: 2,
  referenceAsks: 2,
  sellerAsks: 2,
  outvoteSellers: 2,
  corroboratingSellers: 1,
  maxTokens: 64,
})

/**
 * The rule new audits use: `tokenizer-precheck-v1` with an exact count (`toleranceTokens` 0). A swap is often off the
 * model's count by one or two tokens on a short text, which a tolerance of 2 let through. Every round must still be off
 * for a mismatch, and the model's other sellers must still back the reference. The same tolerance applies throughout:
 * a seller whose two asks of one text sign counts one token apart is unstable (hidden input that varies), so the round
 * decides nothing; and a crowd seller backs the reference only by signing its exact count.
 */
export const TOKENIZER_PRECHECK_RULE_V2: TokenizerPrecheckRule = Object.freeze({
  ...TOKENIZER_PRECHECK_RULE_V1,
  id: 'tokenizer-precheck-v2',
  toleranceTokens: 0,
})

/**
 * The rule new audits use: `tokenizer-precheck-v2` (an exact count) that keeps a pair whose two answers report the same
 * cached amount (`sameCacheCancels`). A pair whose answers report different amounts, or one only, still decides nothing.
 */
export const TOKENIZER_PRECHECK_RULE: TokenizerPrecheckRule = Object.freeze({
  ...TOKENIZER_PRECHECK_RULE_V2,
  id: 'tokenizer-precheck-v3',
  sameCacheCancels: true,
})

const RULES: ReadonlyMap<string, TokenizerPrecheckRule> = new Map([TOKENIZER_PRECHECK_RULE_V1, TOKENIZER_PRECHECK_RULE_V2, TOKENIZER_PRECHECK_RULE].map((rule) => [rule.id, rule]))

/** Two answers' cache members, equal and not empty: the same cached amount, which cancels out of their difference. */
export function sameCache(left: Readonly<Record<string, number>> | undefined, right: Readonly<Record<string, number>> | undefined): boolean {
  if (!left || !right || Object.keys(left).length === 0) return false
  return canonicalJsonStringify(left) === canonicalJsonStringify(right)
}

/** What `cacheBlocks` reads of a request: whether its answer reports cached input, and the cached amounts. */
type CacheOfRequest = Pick<TokenizerSellerRequestV1, 'cachedInput' | 'cache'>

/** Whether a seller's pair is left without a measurement by its cache: cached input that does not cancel out. */
export function cacheBlocks(
  ask: { base: CacheOfRequest; probed?: CacheOfRequest | null },
  rule: TokenizerPrecheckRule = TOKENIZER_PRECHECK_RULE,
): boolean {
  if (!ask.base.cachedInput && !ask.probed?.cachedInput) return false
  return !(rule.sameCacheCancels === true && ask.probed !== null && ask.probed !== undefined && sameCache(ask.base.cache, ask.probed.cache))
}

/** The rule stored evidence was judged by; undefined for an id this CLI does not know. */
export function tokenizerPrecheckRuleById(id: string): TokenizerPrecheckRule | undefined {
  return RULES.get(id)
}

/**
 * `mismatch`: off the reference in every round of the rule, with the model's other sellers backing the reference
 * (a DIFF). `match`: within the tolerance in a round. `inconclusive`: neither, because a round could not be
 * measured, the seller's counts were not stable, or the model's other sellers do not back the reference.
 */
export type TokenizerPrecheckOutcome = 'match' | 'mismatch' | 'inconclusive'

/**
 * One round: `match` when an ask is within the tolerance of the reference; `off` when every ask of the rule is
 * off it and they agree with each other; `unstable` when they are off it and disagree; `unmeasured` when the
 * reference or an ask has no difference, or an ask that is off reports cached input.
 */
export type TokenizerRoundVerdict = 'match' | 'off' | 'unstable' | 'unmeasured'

export interface TokenizerProbeV1 {
  /** Sent in both requests, so whatever it counts as cancels out. */
  a: string
  /** Appended to `a` in the second request; the text the counts are compared on (`isSafeProbe`). */
  b: string
}

/** One ask of the reference: the request with A and the request with A + B. */
export interface TokenizerReferenceAskV1 {
  /** The input tokens for A and for A + B; null where the endpoint reported none. */
  baseTokens: number | null
  probedTokens: number | null
  /** One of the two answers reports cached input. */
  cachedInput: boolean
  /** The cache members each answer reports above zero (A, then A + B); absent in records from before it was kept. */
  cache?: [Readonly<Record<string, number>>, Readonly<Record<string, number>>]
  /** The provider that answered A and the one that answered A + B; null where the endpoint named none. */
  providers: [string | null, string | null]
}

/** The reference's measurement of one probe. */
export interface TokenizerReferenceRoundV1 {
  asks: TokenizerReferenceAskV1[]
  /**
   * B's length in the reference model's tokenizer: the difference every ask gave. Null when they are not all
   * readable, growing, free of cached input, from one provider and equal (`referenceDelta`).
   */
  delta: number | null
  failure: string | null
}

/** The probes of one run and model, with the reference's measurement of each. */
export interface TokenizerPrecheckReferenceV1 {
  /** Where the reference was asked (`ReferenceUpstreamProvenanceV1`); null when it could not be asked at all. */
  upstream: unknown
  probes: TokenizerProbeV1[]
  rounds: TokenizerReferenceRoundV1[]
}

/** One request to the seller, with every try. */
export interface TokenizerSellerRequestV1 {
  requestIds: string[]
  statusCode: number | null
  /** The input tokens in the response the seller signed; null when it has none that can be read. */
  signedInputTokens: number | null
  /** The signed response reports cached input. Its count can match the model's, and is never held against the seller. */
  cachedInput: boolean
  /** The cache members the signed response reports above zero, by path; absent in records from before it was kept. */
  cache?: Record<string, number>
  attemptCosts: ProxyAuditExchangeCostV1[]
  /** The ResponseAuth of the last try, with the exact bytes the seller signed. */
  responseAuth: ProxyAuditEvidenceExchangeV1['responseAuth'] | null
  failureReason: string | null
}

/** One ask of a round's pair: the request with A, the request with A + B, and the difference the seller signed. */
export interface TokenizerSellerAskV1 {
  base: TokenizerSellerRequestV1
  /** Null when the base request gave no count, so the second request was not sent. */
  probed: TokenizerSellerRequestV1 | null
  /** Null when a count is missing, or the count for A + B is not above the count for A (`sellerDelta`). */
  delta: number | null
}

export interface TokenizerPrecheckRoundV1 extends TokenizerProbeV1 {
  reference: TokenizerReferenceRoundV1
  /** The seller's asks of this round, in order. Empty when it was not asked: an earlier round decided, or the reference has no difference. */
  seller: TokenizerSellerAskV1[]
}

/** Another seller of the model that signed the reference's count for the first round's text: the pair it signed. */
export interface TokenizerBackerV1 {
  peerId: string
  /** The service it was asked as. */
  service: string
  ask: TokenizerSellerAskV1
}

/**
 * What the model's sellers signed for the first round's text in this run, next to the reference: the check on
 * the reference itself. It is asked when a seller is off the reference in every round, of the model's sellers the
 * buyer would audit (`auditableSellers`). `corroborated` when at least `corroboratingSellers` of them sign
 * the reference's count. `outvoted` when at least `outvoteSellers` of them sign one same count that is not the
 * reference's, and they are more than the sellers that sign the reference's.
 */
export interface TokenizerCrowdV1 {
  /**
   * Each seller's first-round difference, this seller's included, in ascending order; null where none could be
   * read or the pair reports cached input. No seller is named here.
   */
  deltas: Array<number | null>
  /** Sellers whose first-round difference could be read. */
  measured: number
  /** Of those, the ones within the tolerance of the reference. */
  agree: number
  /** The largest group off the reference whose differences are within the tolerance of each other. */
  largestGroup: number
  /** That group's smallest difference; null when no seller is off the reference. */
  groupDelta: number | null
  corroborated: boolean
  outvoted: boolean
  /** The requests this check sent to the model's other sellers for it, each with its tries and what they cost. */
  requests: Array<{ requestCount: number; attemptCosts: ProxyAuditExchangeCostV1[] }>
  /**
   * Every seller counted in `agree`, with the pair it signed, so `verifier submit` can check from the seller's own
   * evidence that another seller backs the reference.
   */
  backers: TokenizerBackerV1[]
}

/** A seller's pre-check, as stored in its audit evidence. */
export interface TokenizerPrecheckV1 {
  rule: TokenizerPrecheckRule
  outcome: TokenizerPrecheckOutcome
  /** Why nothing was decided; null for a match or a mismatch. */
  reason: string | null
  referenceUpstream: unknown
  rounds: TokenizerPrecheckRoundV1[]
  /** Set when the seller was off in every round: what the model's sellers signed (see `TokenizerCrowdV1`). */
  crowd?: TokenizerCrowdV1
  /**
   * Set instead of `crowd` when the model's other sellers were asked but the check ended without their tally (the
   * audit stopped, or they did not all answer in time): the requests already sent to them, which were paid.
   */
  crowdRequests?: TokenizerCrowdV1['requests']
}

/** The crowd's time ran out with a vote still out: nothing is decided. Carries the requests already paid. */
export class TokenizerCrowdIncomplete extends Error {
  constructor(message: string, readonly requests: TokenizerCrowdV1['requests']) {
    super(message)
  }
}

/** A round's differences: the reference's, and the seller's for each ask, in order. */
export interface TokenizerRoundDeltas {
  referenceDelta: number | null
  sellerDeltas: ReadonlyArray<number | null>
  /** For each ask, whether one of its responses reports cached input. Absent: none does. */
  cachedAsks?: ReadonlyArray<boolean>
}

export function judgeTokenizerRound(
  round: TokenizerRoundDeltas,
  rule: TokenizerPrecheckRule = TOKENIZER_PRECHECK_RULE,
): TokenizerRoundVerdict {
  const reference = round.referenceDelta
  if (reference === null) return 'unmeasured'
  const asks = round.sellerDeltas.slice(0, rule.sellerAsks)
  if (asks.some((delta) => delta !== null && Math.abs(delta - reference) <= rule.toleranceTokens)) return 'match'
  const deltas = asks.filter((delta): delta is number => delta !== null)
  if (deltas.length < rule.sellerAsks) return 'unmeasured'
  // A count that is off while the cache was in play says nothing about the tokenizer.
  if (round.cachedAsks?.slice(0, rule.sellerAsks).some(Boolean)) return 'unmeasured'
  return Math.max(...deltas) - Math.min(...deltas) <= rule.toleranceTokens ? 'off' : 'unstable'
}

/**
 * The outcome of the rounds asked, in order, as the run asks them: the first round that matches ends the check
 * as a match, the first that is unstable or unmeasured ends it undecided, and a mismatch needs every round of
 * the rule off. A mismatch here still has to stand against the model's other sellers (`tokenizerCrowdObjection`).
 */
export function judgeTokenizerPrecheck(
  rounds: ReadonlyArray<TokenizerRoundDeltas>,
  rule: TokenizerPrecheckRule = TOKENIZER_PRECHECK_RULE,
): TokenizerPrecheckOutcome {
  const asked = rounds.slice(0, rule.rounds)
  for (const round of asked) {
    const verdict = judgeTokenizerRound(round, rule)
    if (verdict === 'match') return 'match'
    if (verdict !== 'off') return 'inconclusive'
  }
  return asked.length === rule.rounds ? 'mismatch' : 'inconclusive'
}

/**
 * The check on the reference: the first-round differences of the model's sellers in one run, next to the
 * reference's. An endpoint can serve another tokenizer than the model sellers run (a silent model update,
 * another build behind the same name) and still agree with itself, and every honest seller would then look off.
 * Honest sellers of one model sign one count. So a seller off the reference is only held to it when another
 * seller signs the reference's count, and when more sellers agree on another count than on the reference's, it
 * is the reference that is wrong. A group of colluding sellers smaller than the honest ones cannot outvote it.
 * `backers` are the sellers within the tolerance of the reference, with their signed pairs; they are stored as
 * given (`validateTokenizerPrecheck` checks them against the tallies).
 */
export function tokenizerCrowd(
  sellerDeltas: ReadonlyArray<number | null>,
  reference: number,
  rule: TokenizerPrecheckRule = TOKENIZER_PRECHECK_RULE,
  requests: TokenizerCrowdV1['requests'] = [],
  backers: TokenizerBackerV1[] = [],
): TokenizerCrowdV1 {
  const measured = sellerDeltas.filter((delta): delta is number => delta !== null).sort((left, right) => left - right)
  const off = measured.filter((delta) => Math.abs(delta - reference) > rule.toleranceTokens)
  let largestGroup = 0
  let groupDelta: number | null = null
  for (let start = 0, end = 0; start < off.length; start += 1) {
    while (end < off.length && off[end]! - off[start]! <= rule.toleranceTokens) end += 1
    if (end - start > largestGroup) [largestGroup, groupDelta] = [end - start, off[start]!]
  }
  const agree = measured.length - off.length
  return {
    deltas: [...measured, ...new Array<null>(sellerDeltas.length - measured.length).fill(null)],
    measured: measured.length, agree, largestGroup, groupDelta,
    corroborated: agree >= rule.corroboratingSellers,
    outvoted: largestGroup >= rule.outvoteSellers && largestGroup > agree,
    requests,
    backers,
  }
}

/**
 * A seller's first-round pair as a vote in the crowd: its difference, or null when it has none or reports cached
 * input. The same reading for a seller's own first ask and for an ask sent for another seller's crowd.
 */
export function tokenizerVote(ask: TokenizerSellerAskV1 | null | undefined, rule: TokenizerPrecheckRule = TOKENIZER_PRECHECK_RULE): number | null {
  if (!ask || ask.delta === null || cacheBlocks(ask, rule)) return null
  return ask.delta
}

/**
 * Why a seller off the reference in every round is not a mismatch: the model's other sellers were not asked, they
 * outvote the reference, or none of them signs the reference's count. Null when the mismatch stands.
 */
export function tokenizerCrowdObjection(
  crowd: TokenizerCrowdV1 | undefined,
  reference: number | null,
  rule: TokenizerPrecheckRule = TOKENIZER_PRECHECK_RULE,
): string | null {
  if (!crowd) return 'the model\'s other sellers were not asked, so nothing backs the reference'
  if (crowd.outvoted) {
    return `${crowd.largestGroup} of the model's sellers sign ${crowd.groupDelta} input tokens where the reference counts ${reference} `
      + `and ${crowd.agree} sign the reference's count: the reference is not the model they serve`
  }
  if (!crowd.corroborated) {
    return `no other seller of the model signed the reference's count (${reference}) in this run `
      + `(${crowd.measured} of ${crowd.deltas.length} could be read, this one included), so nothing backs the reference`
  }
  // The rule's own numbers, so a stored crowd that claims more than its tallies give does not stand.
  return crowd.agree >= rule.corroboratingSellers ? null : 'the stored crowd does not back the reference'
}

/**
 * The difference every ask of the reference gave, or null with why there is none. The reference is read like a
 * seller: an ask without a count, with cached input, or whose count for A + B is not above its count for A is no
 * measurement. Its asks must also all come from one provider, since two deployments of a model can each agree
 * with themselves on different counts.
 */
export function referenceDelta(
  asks: TokenizerReferenceRoundV1['asks'],
  rule: TokenizerPrecheckRule = TOKENIZER_PRECHECK_RULE,
): { delta: number | null; failure: string | null } {
  if (asks.length < rule.referenceAsks) return { delta: null, failure: `the reference was asked ${asks.length} of ${rule.referenceAsks} times` }
  if (asks.some((ask) => ask.baseTokens === null || ask.probedTokens === null)) return { delta: null, failure: 'the reference reported no input tokens' }
  // Cached input leaves an ask without a measurement, unless both its answers report the same cached amount and the
  // rule lets that cancel out (`sameCacheCancels`).
  if (asks.some((ask) => ask.cachedInput !== false && !(rule.sameCacheCancels === true && sameCache(ask.cache?.[0], ask.cache?.[1])))) {
    return { delta: null, failure: 'the reference reported cached input' }
  }
  const providers = [...new Set(asks.flatMap((ask) => (Array.isArray(ask.providers) ? ask.providers : [undefined])))]
  if (providers.length !== 1 || providers[0] === undefined) {
    return { delta: null, failure: `the reference answered from more than one provider (${providers.map((provider) => provider ?? 'unnamed').join(', ')})` }
  }
  if (asks.some((ask) => ask.probedTokens! <= ask.baseTokens!)) return { delta: null, failure: 'the reference counted no more tokens with the follow-up than without' }
  const deltas = asks.map((ask) => ask.probedTokens! - ask.baseTokens!)
  return deltas.every((delta) => delta === deltas[0])
    ? { delta: deltas[0]!, failure: null }
    : { delta: null, failure: `the reference did not agree with itself (${deltas.join(', ')})` }
}

/**
 * Asks the reference for the input tokens of each content, in order; a failed request has null tokens. Each
 * result says whether the answer reports cached input and which provider gave it, when the endpoint names one.
 * `signal` is aborted when the measurement's time is up: no request should be tried again after it.
 */
export type TokenizerReferenceAsk = (contents: readonly string[], signal?: AbortSignal) => Promise<{
  upstream: unknown
  results: ReadonlyArray<{ inputTokens: number | null; cachedInput?: boolean; cache?: Readonly<Record<string, number>>; provider?: string | null; failure: string | null }>
}>

/** Probes written for one round before it is left without a reference difference. */
export const REFERENCE_PROBE_TRIES = 3

/**
 * The longest a model's reference measurement may take. Its sellers wait for it before their own clocks start,
 * so a reference that hangs holds up the model's audits, never a seller's verdict.
 */
export const REFERENCE_TIME_LIMIT_MS = 10 * 60_000

/**
 * Writes the probes of one run and model and measures each on the reference: A and A + B, `referenceAsks` times.
 * A probe the reference gives no difference for (it refused the text, reported no usage, answered from two
 * providers or did not agree with itself) is replaced by a fresh one, up to `REFERENCE_PROBE_TRIES` per round; probes
 * given by the caller are measured as they are. A round whose every single answer reports cached input is not
 * rewritten: the cache is the endpoint's, and a fresh text does not change it.
 * Never rejects: a reference that cannot be asked, or does not answer within `timeLimitMs`, leaves its rounds
 * without a difference, and every seller's pre-check undecided.
 */
export async function measureTokenizerReference(input: {
  ask: TokenizerReferenceAsk
  rule?: TokenizerPrecheckRule
  probes?: readonly TokenizerProbeV1[]
  timeLimitMs?: number
}): Promise<TokenizerPrecheckReferenceV1> {
  const rule = input.rule ?? TOKENIZER_PRECHECK_RULE
  const timeLimitMs = input.timeLimitMs ?? REFERENCE_TIME_LIMIT_MS
  const limit = AbortSignal.timeout(timeLimitMs)
  let upstream: unknown = null
  // The rounds whose every single answer reported cached input: a fresh text does not change the endpoint's cache.
  const allCached = new WeakSet<TokenizerReferenceRoundV1>()
  const measure = async (probe: TokenizerProbeV1): Promise<TokenizerReferenceRoundV1> => {
    const contents = Array.from({ length: rule.referenceAsks }, () => [probe.a, probe.a + probe.b]).flat()
    try {
      const asked = await untilAborted(input.ask(contents, limit), limit, null)
      if (!asked) return { asks: [], delta: null, failure: `the reference did not answer within ${timeLimitMs}ms` }
      upstream = asked.upstream
      const asks = Array.from({ length: rule.referenceAsks }, (_ask, ask): TokenizerReferenceAskV1 => {
        const [base, probed] = [asked.results[ask * 2], asked.results[ask * 2 + 1]]
        return {
          baseTokens: base?.inputTokens ?? null,
          probedTokens: probed?.inputTokens ?? null,
          cachedInput: base?.cachedInput === true || probed?.cachedInput === true,
          ...(base?.cache || probed?.cache ? { cache: [{ ...(base?.cache ?? {}) }, { ...(probed?.cache ?? {}) }] as [Record<string, number>, Record<string, number>] } : {}),
          providers: [base?.provider ?? null, probed?.provider ?? null],
        }
      })
      const judged = referenceDelta(asks, rule)
      const failed = asked.results.find((result) => result.failure)
      const round = { asks, delta: judged.delta, failure: judged.delta === null ? failed?.failure ?? judged.failure : null }
      if (asked.results.length > 0 && asked.results.every((result) => result.cachedInput === true)) allCached.add(round)
      return round
    } catch (error) {
      return { asks: [], delta: null, failure: `the reference could not be asked: ${asError(error).message}`.slice(0, 300) }
    }
  }
  const measured = await Promise.all(Array.from({ length: input.probes?.length ?? rule.rounds }, async (_round, index) => {
    const given = input.probes?.[index]
    let probe = given ?? generateTokenizerProbe()
    let round = await measure(probe)
    const replaceable = (measured: TokenizerReferenceRoundV1): boolean => measured.delta === null && !limit.aborted && !allCached.has(measured)
    for (let attempt = 1; !given && replaceable(round) && attempt < REFERENCE_PROBE_TRIES; attempt += 1) {
      probe = generateTokenizerProbe()
      round = await measure(probe)
    }
    return { probe, round }
  }))
  return { upstream, probes: measured.map((entry) => entry.probe), rounds: measured.map((entry) => entry.round) }
}

/** Times one request is sent to a seller before it counts as failed (`sendSignedRequest`). */
export const SELLER_REQUEST_TRIES = SIGNED_REQUEST_TRIES

/**
 * A seller's pre-check: each round's two requests through the buyer proxy, pinned to the seller with the signed
 * bytes captured. A round off the reference is asked once more, so only a count the seller repeats is held
 * against it. The seller is asked nothing unless every round has a reference difference. The check ends when a
 * round matches (the seller counts like the model), when a round cannot be measured or the seller's own asks
 * disagree (nothing is decided), or when every round of the rule is off the reference. Then the model's other
 * sellers are asked (`crowd`): it is a mismatch when they back the reference, and nothing is decided when they do
 * not, when there is nobody to ask, or when the audit stopped meanwhile. Never rejects.
 */
export async function runTokenizerPrecheck(input: {
  proxyBaseUrl: string
  peerId: string
  service: string
  /** Other names the seller may sign for the service. */
  serviceAliases?: readonly string[]
  reference: TokenizerPrecheckReferenceV1
  responseAuthReader: ResponseAuthReader
  limiter: AuditTaskLimiter
  rule?: TokenizerPrecheckRule
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  /** Stops the check; `clock.signal` when a clock is given. */
  signal?: AbortSignal
  /** The seller's audit clock, run for each request to the seller. */
  clock?: SellerClock
  /** The first round's first ask, when it was already sent (`createTokenizerPrecheckScreen`). */
  firstAsk?: TokenizerSellerAskV1
  /**
   * What the model's sellers sign for the first round's text, this seller's own first ask included; asked only
   * when this seller is off in every round.
   */
  crowd?: (own: TokenizerSellerAskV1) => Promise<TokenizerCrowdV1>
}): Promise<TokenizerPrecheckV1> {
  const rule = input.rule ?? TOKENIZER_PRECHECK_RULE
  const stop = input.clock?.signal ?? input.signal
  const sellerInput: SellerAskInput = { ...input, ...(stop ? { signal: stop } : {}) }
  const rounds: TokenizerPrecheckRoundV1[] = input.reference.probes.slice(0, rule.rounds).map((probe, index) => ({
    ...probe,
    reference: input.reference.rounds[index] ?? { asks: [], delta: null, failure: 'the reference was not asked' },
    seller: [],
  }))
  const done = (outcome: TokenizerPrecheckOutcome, reason: string | null): TokenizerPrecheckV1 => ({
    rule, outcome, reason, referenceUpstream: input.reference.upstream, rounds,
  })
  if (rounds.length < rule.rounds) return done('inconclusive', `the pre-check needs ${rule.rounds} probes; ${rounds.length} were written`)
  // A mismatch needs every round, so without a reference for one of them the seller is not asked at all.
  const unmeasured = rounds.find((round) => round.reference.delta === null)
  if (unmeasured) {
    return done('inconclusive', `no reference to compare with: ${unmeasured.reference.failure ?? 'the reference gave no difference'}`)
  }
  for (const round of rounds) {
    for (let ask = 0; ask < rule.sellerAsks; ask += 1) {
      const { base, probed, delta } = round === rounds[0] && ask === 0 && input.firstAsk ? input.firstAsk : await askSellerPair(sellerInput, rule, round)
      round.seller.push({ base, probed, delta })
      if (delta === null) {
        return done('inconclusive', base.signedInputTokens !== null && probed && probed.signedInputTokens !== null
          ? `the seller signed no more input tokens with the follow-up (${probed.signedInputTokens}) than without (${base.signedInputTokens})`
          : `the seller's signed input tokens could not be read: ${(probed ?? base).failureReason ?? 'no signed usage'}`)
      }
      const verdict = judgeTokenizerRound(roundDeltas(round, rule), rule)
      if (verdict === 'match') return done('match', null)
      if (cacheBlocks({ base, probed }, rule)) {
        return done('inconclusive', `the seller signed ${delta} input tokens where the model counts ${round.reference.delta}, `
          + 'but its response reports cached input, whose count cannot be held against it')
      }
      if (verdict === 'unstable') {
        return done('inconclusive', 'the seller signed different counts for the same text '
          + `(${round.seller.map((entry) => entry.delta).join(', ')} where the model counts ${round.reference.delta}), so its hidden input varies`)
      }
    }
  }
  // Off in every round. The reference may still be the one that is wrong: the model's other sellers say.
  let crowd: TokenizerCrowdV1 | undefined
  let unfinished: { reason: string; requests: TokenizerCrowdV1['requests'] } | null = null
  try {
    crowd = await input.crowd?.(rounds[0]!.seller[0]!)
  } catch (error) {
    unfinished = { reason: asError(error).message, requests: error instanceof TokenizerCrowdIncomplete ? error.requests : [] }
  }
  // A crowd that is not kept still cost what its asks cost.
  const paid = crowd?.requests ?? unfinished?.requests ?? []
  const ended = (reason: string): TokenizerPrecheckV1 => ({ ...done('inconclusive', reason), ...(paid.length > 0 ? { crowdRequests: paid } : {}) })
  // An audit that stopped while they were asked is over: an answer that came in for another check decides
  // nothing for this one.
  if (stop?.aborted) return ended('the audit was stopped while the model\'s other sellers were asked')
  if (unfinished) return ended(unfinished.reason)
  const objection = tokenizerCrowdObjection(crowd, rounds[0]!.reference.delta, rule)
  return { ...done(objection === null ? 'mismatch' : 'inconclusive', objection), ...(crowd ? { crowd } : {}) }
}

/** What a request to a seller needs. */
type SellerAskInput = Pick<Parameters<typeof runTokenizerPrecheck>[0],
  'proxyBaseUrl' | 'peerId' | 'service' | 'serviceAliases' | 'responseAuthReader' | 'limiter' | 'requestTimeoutMs' | 'fetchFn' | 'signal' | 'clock'>

/** One ask of a probe's pair: A, then A + B when A gave a count. `onRequest` is told each request as it ends. */
async function askSellerPair(
  input: SellerAskInput,
  rule: TokenizerPrecheckRule,
  probe: TokenizerProbeV1,
  onRequest?: (request: TokenizerSellerRequestV1) => void,
): Promise<TokenizerSellerAskV1> {
  const base = await askSeller(input, rule, probe.a)
  onRequest?.(base)
  const probed = base.signedInputTokens === null ? null : await askSeller(input, rule, probe.a + probe.b)
  if (probed) onRequest?.(probed)
  return { base, probed, delta: sellerDelta(base, probed) }
}

/**
 * The difference a pair signed. Null when a count is missing, and when the count for A + B is not above the count
 * for A: a seller that signs one fallback count for every request has measured nothing, as for the reference.
 */
function sellerDelta(base: TokenizerSellerRequestV1, probed: TokenizerSellerRequestV1 | null): number | null {
  if (base.signedInputTokens === null || !probed || probed.signedInputTokens === null) return null
  return probed.signedInputTokens > base.signedInputTokens ? probed.signedInputTokens - base.signedInputTokens : null
}

/** A seller the pre-check asks: its peer, the service it sells the model as, and other names it may sign for it. */
export interface TokenizerPrecheckSeller {
  peerId: string
  service: string
  serviceAliases?: readonly string[]
}

/** The longest the model's other sellers are waited for when a seller is off the reference in every round. */
export const CROWD_TIME_LIMIT_MS = 5 * 60_000

/** The pre-check of one model's sellers in one run (`createTokenizerPrecheckScreen`). */
export interface TokenizerPrecheckScreen<Settings> {
  /**
   * The run's probes for the model, measured on the reference once (with the first caller's settings). An audit
   * awaits it before the seller's clock starts: the wait is the auditor's, not the seller's. Never rejects when
   * the screen's `reference` never rejects.
   */
  ready: (settings: Settings) => Promise<TokenizerPrecheckReferenceV1>
  /** One seller's pre-check; never rejects. */
  check: (seller: TokenizerPrecheckSeller, settings: Settings, clock?: SellerClock) => Promise<TokenizerPrecheckV1>
}

/**
 * The pre-check of one model's sellers in one run. A seller's own check comes first and costs two requests when it
 * matches. Only when it is off the reference in every round is the crowd asked: the first round's pair goes to
 * every other listed seller of the model (a seller already measured in this run votes with that first ask), and
 * the mismatch stands only if they back the reference (`tokenizerCrowd`). The crowd runs on its own time
 * (`crowdTimeLimitMs`), not on the seller's clock. A crowd ask that fails, is late, is stopped or reports cached
 * input is not measured: it neither agrees nor disagrees, and the next check that needs it asks again. What the
 * crowd asks cost is counted in the check that sent them.
 */
export function createTokenizerPrecheckScreen<Settings>(input: {
  /**
   * The crowd: the model's sellers the buyer would audit in this run, whether or not the run audits them
   * (`auditableSellers`). One entry per peer; a peer listed twice (two names for the model) is asked and
   * counted once.
   */
  sellers: readonly TokenizerPrecheckSeller[]
  /** The run's probes for the model with the reference's measurement; called once, with the first seller's settings. */
  reference: (settings: Settings) => Promise<TokenizerPrecheckReferenceV1>
  proxyBaseUrl: string
  responseAuthReader: ResponseAuthReader
  limiter: AuditTaskLimiter
  rule?: TokenizerPrecheckRule
  requestTimeoutMs?: number
  fetchFn?: typeof fetch
  crowdTimeLimitMs?: number
  /**
   * Told when a seller off the reference in every round is not a mismatch because the model's sellers do not back
   * the reference: once when they outvote it, once when none of them signs its count.
   */
  onUnbacked?: (crowd: TokenizerCrowdV1, referenceDelta: number) => void
}): TokenizerPrecheckScreen<Settings> {
  const rule = input.rule ?? TOKENIZER_PRECHECK_RULE
  const key = (seller: Pick<TokenizerPrecheckSeller, 'peerId'>): string => peerKey(seller.peerId)
  const peers = new Map<string, TokenizerPrecheckSeller>()
  for (const seller of input.sellers) if (!peers.has(key(seller))) peers.set(key(seller), seller)
  let reference: Promise<TokenizerPrecheckReferenceV1> | null = null
  const ready = (settings: Settings): Promise<TokenizerPrecheckReferenceV1> => (reference ??= input.reference(settings))
  // Each peer's first-round first ask, measured or in flight: its own check's, or one sent for another seller's crowd.
  type Vote = { seller: TokenizerPrecheckSeller; ask: TokenizerSellerAskV1 | null }
  const votes = new Map<string, Promise<Vote>>()
  // A vote that measured nothing is dropped, so the next check that needs the crowd asks that seller again.
  const keepIfMeasured = (peer: string, entry: Promise<Vote>, vote: Vote): void => {
    if (tokenizerVote(vote.ask, rule) === null && votes.get(peer) === entry) votes.delete(peer)
  }
  const told = new Set<'outvoted' | 'uncorroborated'>()
  const askInput = (seller: TokenizerPrecheckSeller, stop: { signal?: AbortSignal; clock?: SellerClock }): SellerAskInput => ({
    proxyBaseUrl: input.proxyBaseUrl, peerId: seller.peerId, service: seller.service, serviceAliases: seller.serviceAliases,
    responseAuthReader: input.responseAuthReader, limiter: input.limiter, requestTimeoutMs: input.requestTimeoutMs, fetchFn: input.fetchFn,
    ...(stop.signal ? { signal: stop.signal } : {}),
    ...(stop.clock ? { clock: stop.clock } : {}),
  })
  const askVote = (
    seller: TokenizerPrecheckSeller, ask: SellerAskInput, probe: TokenizerProbeV1, onRequest?: (request: TokenizerSellerRequestV1) => void,
  ): Promise<Vote> => (
    askSellerPair(ask, rule, probe, onRequest).then((answer) => ({ seller, ask: answer }), () => ({ seller, ask: null }))
  )
  return {
    ready,
    async check(seller, settings, clock) {
      const measured = await ready(settings)
      const round = measured.rounds[0]
      const probe = measured.probes[0]
      if (!peers.has(key(seller))) peers.set(key(seller), seller)
      const own = clock ? { clock, signal: clock.signal } : {}
      // The seller is asked nothing unless every round has a reference (`runTokenizerPrecheck`).
      const measurable = probe !== undefined && measured.rounds.length >= rule.rounds
        && measured.rounds.slice(0, rule.rounds).every((entry) => entry.delta !== null)
      // This seller's own first ask is its vote, unless another seller's crowd already asked it: that ask was
      // paid for by the other seller's check, so this one asks again and counts its own.
      let firstAsk: TokenizerSellerAskV1 | null = null
      if (measurable) {
        const ownVote = askVote(seller, askInput(seller, own), probe)
        if (!votes.has(key(seller))) votes.set(key(seller), ownVote)
        const vote = await ownVote
        keepIfMeasured(key(seller), ownVote, vote)
        firstAsk = vote.ask
      }
      const crowd = async (ownAsk: TokenizerSellerAskV1): Promise<TokenizerCrowdV1> => {
        // The crowd's own time, cut short when this seller's audit stops. A vote that comes later is not counted.
        const timeLimitMs = input.crowdTimeLimitMs ?? CROWD_TIME_LIMIT_MS
        const limit = AbortSignal.any([AbortSignal.timeout(timeLimitMs), ...(clock ? [clock.signal] : [])])
        const requests: TokenizerCrowdV1['requests'] = []
        // A vote still out when the time is up could have outvoted the reference, so the crowd then decides
        // nothing. A vote that failed or was refused in time is only not measured.
        let pending = false
        const inTime = async (vote: Promise<Vote>): Promise<Vote | null> => {
          const answer = await untilAborted(vote, limit, null)
          if (answer === null) pending = true
          return answer
        }
        const askAfresh = async (peer: string, other: TokenizerPrecheckSeller): Promise<Vote> => {
          // The names a seller may sign are the model's, so this seller's stand for all of them.
          // The requests of this pair that have ended: a pair cut off by the crowd's time between its two requests has
          // paid for the first, so that one is counted although the pair gave no vote.
          const ended: TokenizerSellerRequestV1[] = []
          const asked = askVote(
            other, askInput({ ...other, serviceAliases: other.serviceAliases ?? seller.serviceAliases }, { signal: limit }), probe!,
            (request) => { ended.push(request) },
          )
          votes.set(peer, asked)
          void asked.then((vote) => keepIfMeasured(peer, asked, vote))
          const vote = await inTime(asked)
          const counted = vote === null ? [...ended] : vote.ask ? [vote.ask.base, ...(vote.ask.probed ? [vote.ask.probed] : [])] : []
          for (const request of counted) {
            requests.push({ requestCount: request.requestIds.length, attemptCosts: request.attemptCosts })
          }
          return vote ?? { seller: other, ask: null }
        }
        const collected = await Promise.all([...peers].map(async ([peer, other]): Promise<Vote> => {
          // In its own crowd a seller votes with its own first ask, the one its record holds.
          if (peer === key(seller)) return { seller, ask: ownAsk }
          const known = votes.get(peer)
          if (!known) return askAfresh(peer, other)
          const vote = await inTime(known)
          if (vote === null) return { seller: other, ask: null }
          if (tokenizerVote(vote.ask, rule) !== null) return vote
          // A shared ask that ended without a measure (it failed, or another check stopped it) is asked again, once:
          // a check that finds another's new ask for that seller already out waits for it.
          const replacement = votes.get(peer)
          if (replacement && replacement !== known) return (await inTime(replacement)) ?? { seller: other, ask: null }
          return askAfresh(peer, other)
        }))
        if (pending) {
          throw new TokenizerCrowdIncomplete(`not every other seller of the model answered within ${timeLimitMs}ms, `
            + 'and the ones that did not could outvote the reference', requests)
        }
        const referenceDelta = round!.delta!
        const backers = collected.flatMap((vote): TokenizerBackerV1[] => {
          const delta = tokenizerVote(vote.ask, rule)
          return key(vote.seller) !== key(seller) && delta !== null && Math.abs(delta - referenceDelta) <= rule.toleranceTokens
            ? [{ peerId: vote.seller.peerId, service: vote.seller.service, ask: vote.ask! }]
            : []
        })
        return tokenizerCrowd(collected.map((vote) => tokenizerVote(vote.ask, rule)), referenceDelta, rule, requests, backers)
      }
      const record = await runTokenizerPrecheck({ ...askInput(seller, own), reference: measured, rule, crowd, ...(firstAsk ? { firstAsk } : {}) })
      if (record.crowd && record.outcome !== 'mismatch') {
        const kind = record.crowd.outvoted ? 'outvoted' : 'uncorroborated'
        if (!told.has(kind)) {
          told.add(kind)
          input.onUnbacked?.(record.crowd, round!.delta!)
        }
      }
      return record
    },
  }
}

/**
 * One request of the pre-check (`sendSignedRequest`): a try is enough only when the response the seller signed reports
 * its input tokens, which are stored exactly as `validateTokenizerPrecheck` reads the kept bytes again, also when there
 * is no count (a response can report cached input and no count that can be read).
 */
async function askSeller(
  input: SellerAskInput,
  rule: TokenizerPrecheckRule,
  content: string,
): Promise<TokenizerSellerRequestV1> {
  const record: TokenizerSellerRequestV1 = {
    requestIds: [], statusCode: null, signedInputTokens: null, cachedInput: false, attemptCosts: [], responseAuth: null, failureReason: null,
  }
  const body = new TextEncoder().encode(JSON.stringify({
    model: input.service,
    messages: [{ role: 'user', content }],
    max_tokens: rule.maxTokens,
    stream: false,
  }))
  return sendSignedRequest(input, body, record, {
    reset: (request) => {
      request.signedInputTokens = null
      request.cachedInput = false
      delete request.cache
    },
    inspect: (request) => {
      const usage = signedUsage(request)
      request.signedInputTokens = usage.inputTokens
      request.cachedInput = usage.cachedInput
      if (usage.cachedInput) request.cache = { ...usage.cache }
      return usage.inputTokens === null ? 'the response the seller signed reports no input tokens' : null
    },
  })
}

/** A peer ID as the pre-check compares them: without `0x`, in lower case. */
function peerKey(peerId: string): string {
  return peerId.replace(/^0x/i, '').toLowerCase()
}

/** What `promise` gives, or `otherwise` once `signal` is aborted first. A rejection is passed on. */
function untilAborted<T, U>(promise: Promise<T>, signal: AbortSignal, otherwise: U): Promise<T | U> {
  if (signal.aborted) {
    // The promise is left behind here: its own rejection must be handled, or Node ends the process on it.
    promise.catch(() => undefined)
    return Promise.resolve(otherwise)
  }
  return new Promise<T | U>((resolve, reject) => {
    const stop = (): void => resolve(otherwise)
    signal.addEventListener('abort', stop, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', stop); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', stop); reject(error) },
    )
  })
}

/** A round's differences as the rule judges them. */
function roundDeltas(round: TokenizerPrecheckRoundV1, rule: TokenizerPrecheckRule): TokenizerRoundDeltas {
  return {
    referenceDelta: round.reference.delta,
    sellerDeltas: round.seller.map((ask) => ask.delta),
    // An ask whose cache does not cancel out (`cacheBlocks`): its count is never held against the seller.
    cachedAsks: round.seller.map((ask) => cacheBlocks(ask, rule)),
  }
}

/** What a stored request's signed response carries for the pre-check, read as the run read it. */
function signedUsage(request: TokenizerSellerRequestV1): { inputTokens: number | null; cachedInput: boolean; cache: Readonly<Record<string, number>> } {
  const preimages = request.responseAuth?.status === 'verified' ? request.responseAuth.signedPreimages : null
  return preimages ? signedResponseInputUsage(Buffer.from(preimages.responseBase64, 'base64')) : { inputTokens: null, cachedInput: false, cache: {} }
}

/** Every request the pre-check sent to the seller, tried or answered. */
function sellerRequests(record: TokenizerPrecheckV1): TokenizerSellerRequestV1[] {
  return record.rounds.flatMap((round) => round.seller.flatMap((ask) => [ask.base, ...(ask.probed ? [ask.probed] : [])]))
}

/** The requests the pre-check sent, counting retries: to the seller, and to the model's other sellers for the crowd. */
export function tokenizerPrecheckRequestCount(record: TokenizerPrecheckV1): number {
  return requestCountOf(tokenizerPrecheckPaidRequests(record))
}

/** Every request the pre-check paid for, in order: the seller's, then those to the model's other sellers. */
export function tokenizerPrecheckPaidRequests(record: TokenizerPrecheckV1): PaidRequest[] {
  return [
    ...sellerRequests(record).map((request) => ({ requestCount: request.requestIds.length, attemptCosts: request.attemptCosts })),
    ...crowdRequests(record),
  ]
}

/** The requests sent to the model's other sellers for this check, whether or not their tally was kept. */
function crowdRequests(record: TokenizerPrecheckV1): TokenizerCrowdV1['requests'] {
  return record.crowd?.requests ?? record.crowdRequests ?? []
}

/** What the pre-check's requests cost, the crowd's included. They are paid for like question batches. */
export function tokenizerPrecheckCost(record: TokenizerPrecheckV1): AuditCostSummaryV1 {
  return costOfRequests(tokenizerPrecheckPaidRequests(record))
}

/**
 * A pre-check as an audit's summary carries it. A mismatch has the counts of each round, so the model report and
 * the overview can say what the seller signed next to what the model counts without opening the evidence.
 */
export interface TokenizerPrecheckSummary {
  rule: string
  outcome: TokenizerPrecheckOutcome
  /** Per round, the input tokens the seller signed for the added text. Set on a mismatch. */
  sellerTokens?: number[]
  /** Per round, the input tokens the model counts for it (the reference's). Set on a mismatch. */
  modelTokens?: number[]
}

export function summarizeTokenizerPrecheck(record: TokenizerPrecheckV1): TokenizerPrecheckSummary {
  return {
    rule: record.rule.id,
    outcome: record.outcome,
    ...(record.outcome === 'mismatch' ? {
      sellerTokens: record.rounds.map((round) => round.seller[0]!.delta!),
      modelTokens: record.rounds.map((round) => round.reference.delta!),
    } : {}),
  }
}

/** A pre-check DIFF in plain words, for the run log, the model report and the overview. */
export function describeTokenizerCounts(summary: { sellerTokens?: readonly number[]; modelTokens?: readonly number[] }): string {
  return summary.sellerTokens?.length && summary.modelTokens?.length
    ? `signed ${summary.sellerTokens.join('/')} input tokens where the model counts ${summary.modelTokens.join('/')}`
    : 'its signed input tokens are not the model\'s'
}

/** One line for the verdict reason and the run log: what the seller signed in each round next to what the model counts. */
export function describeTokenizerMismatch(record: TokenizerPrecheckV1): string {
  const seller = record.rounds.map((round) => round.seller[0]?.delta ?? '?').join('/')
  const reference = record.rounds.map((round) => round.reference.delta ?? '?').join('/')
  return `tokenizer pre-check (${record.rule.id}): the seller signed ${seller} input tokens, each ${record.rule.sellerAsks} times over, `
    + `for text the model counts as ${reference}: off by more than ${record.rule.toleranceTokens} in every round`
    + `${record.crowd ? `, while ${record.crowd.agree} of the model's other sellers signed the model's count` : ''}`
}

/**
 * Checks that a stored pre-check follows from what it stores: the rule is one this CLI knows, every count is the
 * one in the bytes the seller signed under a verified ResponseAuth for the round's own text (A, or A + B; for a
 * backing seller, the first round's), no request is counted twice, the reference's
 * differences are its asks', the seller was asked exactly as the run asks (nothing after the ask that ended the
 * check), the crowd's tallies are its differences' and every backing seller's pair is stored and holds, and the
 * outcome is the rule's. Throws otherwise, so a DIFF is never submitted on a pre-check that does not hold.
 * It checks the stored values against each other; it does not verify the signatures again.
 * `auditedPeerId` is the seller the evidence is about: no other seller's pair may be its own.
 */
export function validateTokenizerPrecheck(record: TokenizerPrecheckV1, auditedPeerId?: string): void {
  const rule = tokenizerPrecheckRuleById(record.rule?.id)
  // Stored evidence is canonical JSON, so its keys are not in the rule's order.
  if (!rule || canonicalJsonStringify(rule) !== canonicalJsonStringify(record.rule)) throw new Error('tokenizer pre-check uses an unknown rule')
  if (record.rounds.length > rule.rounds) throw new Error('tokenizer pre-check has more rounds than its rule')
  const requestIds = sellerRequests(record).flatMap((request) => request.requestIds)
  if (new Set(requestIds).size !== requestIds.length) throw new Error('tokenizer pre-check counts one request more than once')
  const judged = record.rounds.map((round, index): TokenizerRoundDeltas => {
    const where = `tokenizer pre-check round ${index + 1}`
    if (!isSafeProbe(round.b)) throw new Error(`${where} compares text the probe guard refuses`)
    const reference = referenceDelta(round.reference.asks, rule).delta
    if (reference !== round.reference.delta) throw new Error(`${where}: the reference difference does not follow from its asks`)
    if (round.seller.length > rule.sellerAsks) throw new Error(`${where}: the seller was asked more often than the rule allows`)
    for (const ask of round.seller) {
      for (const [request, content] of askedTexts(ask, round)) {
        if (!signedAsStored(request)) throw new Error(`${where}: the seller's input tokens are not the ones in its signed responses`)
        if (!signedFor(request, content)) throw new Error(`${where}: the seller's signed request is not the round's text`)
      }
      if (sellerDelta(ask.base, ask.probed) !== ask.delta) throw new Error(`${where}: the seller's difference does not follow from its signed responses`)
    }
    return { ...roundDeltas(round, rule), referenceDelta: reference }
  })
  // The run's own stop rules. Without a reference for every round the seller is asked nothing. Otherwise each
  // round is asked until an ask ends the check (no count, within the tolerance, cached input while off, or two
  // asks that disagree); a round that ends nothing is asked as often as the rule says; nothing is asked after.
  const everyReference = judged.length === rule.rounds && judged.every((round) => round.referenceDelta !== null)
  let ended = !everyReference
  for (const [index, round] of record.rounds.entries()) {
    const where = `tokenizer pre-check round ${index + 1}`
    if (ended) {
      if (round.seller.length > 0) throw new Error(`${where}: the seller was asked after the check had ended`)
      continue
    }
    if (round.seller.length === 0) throw new Error(`${where}: the seller was not asked a round the check had not ended before`)
    for (const [ask, entry] of round.seller.entries()) {
      if (ended) throw new Error(`${where}: the seller was asked after the check had ended`)
      const verdict = judgeTokenizerRound({
        referenceDelta: judged[index]!.referenceDelta,
        sellerDeltas: judged[index]!.sellerDeltas.slice(0, ask + 1),
        cachedAsks: judged[index]!.cachedAsks?.slice(0, ask + 1),
      }, rule)
      if (entry.delta === null || verdict === 'match' || verdict === 'unstable' || cacheBlocks(entry, rule)) ended = true
    }
    if (!ended && round.seller.length < rule.sellerAsks) throw new Error(`${where}: the seller was asked fewer times than the rule asks`)
  }
  // As the run judges: the rounds the seller was asked, in order.
  const firstUnasked = record.rounds.findIndex((round) => round.seller.length === 0)
  const asked = firstUnasked === -1 ? judged : judged.slice(0, firstUnasked)
  const judgedOutcome = judgeTokenizerPrecheck(asked, rule)
  const crowd = record.crowd
  // The requests of a crowd whose tally was not kept: only for a seller off in every round that was not decided.
  if (record.crowdRequests && (crowd || judgedOutcome !== 'mismatch' || record.outcome !== 'inconclusive')) {
    throw new Error('tokenizer pre-check stores the requests of a crowd it does not leave undecided')
  }
  if (crowd) {
    // The crowd is asked only for a seller off in every round, and holds that seller's own first difference.
    const firstRound = judged[0]?.referenceDelta ?? null
    if (judgedOutcome !== 'mismatch' || firstRound === null) throw new Error('tokenizer pre-check stores a crowd for a seller that was not off in every round')
    const tallied = tokenizerCrowd(crowd.deltas, firstRound, rule, crowd.requests, crowd.backers)
    if (canonicalJsonStringify(tallied) !== canonicalJsonStringify(crowd)) throw new Error('tokenizer pre-check crowd does not follow from its differences')
    if (!crowd.deltas.includes(record.rounds[0]!.seller[0]!.delta)) throw new Error('tokenizer pre-check crowd leaves out the seller\'s own difference')
    validateTokenizerBackers(crowd, record.rounds[0]!, firstRound, rule, new Set(requestIds), auditedPeerId)
  }
  // A seller off in every round is a mismatch only when the model's other sellers back the reference.
  const outcome = judgedOutcome === 'mismatch' && tokenizerCrowdObjection(crowd, judged[0]!.referenceDelta, rule) !== null ? 'inconclusive' : judgedOutcome
  if (outcome !== record.outcome) throw new Error(`tokenizer pre-check outcome ${record.outcome} does not follow from its rounds (${outcome})`)
}

/** An ask's requests with the text each was sent: A for the base request, A + B for the one with the follow-up. */
function askedTexts(ask: Pick<TokenizerSellerAskV1, 'base' | 'probed'>, probe: TokenizerProbeV1): Array<[TokenizerSellerRequestV1, string]> {
  return [[ask.base, probe.a], ...(ask.probed ? [[ask.probed, probe.a + probe.b] as [TokenizerSellerRequestV1, string]] : [])]
}

/**
 * Whether a request whose signed response gives a count or a cache was sent `content`, read from the request bytes the
 * seller signed with that response: so a count is the one the seller signed for the text the record compares, never one
 * it signed for another prompt. A request whose signed response gives neither measures nothing.
 */
function signedFor(request: TokenizerSellerRequestV1, content: string): boolean {
  const usage = signedUsage(request)
  if (usage.inputTokens === null && !usage.cachedInput) return true
  const exchange = signedExchange(request)
  return exchange !== null && requestAsksOnly(exchange.requestBody, content)
}

/** Whether a stored request's count and cache flag are the ones its kept signed response gives. */
function signedAsStored(request: TokenizerSellerRequestV1): boolean {
  const signed = signedUsage(request)
  // A stored cache is the signed one; a record from before it was kept has none, and then never cancels.
  const cacheAsSigned = request.cache === undefined || canonicalJsonStringify(request.cache) === canonicalJsonStringify(signed.cache)
  return signed.inputTokens === request.signedInputTokens && signed.cachedInput === request.cachedInput && cacheAsSigned
}

/**
 * The crowd's backing sellers, against its tallies: one stored pair for every seller counted on the reference's
 * count, each from another peer than the audited seller and than each other, signed under a verified ResponseAuth
 * by that peer for the first round's exact texts, read from the kept bytes, without cached input, and within the
 * tolerance of the reference.
 */
function validateTokenizerBackers(
  crowd: TokenizerCrowdV1,
  probe: TokenizerProbeV1,
  referenceDelta: number,
  rule: TokenizerPrecheckRule,
  requestIds: Set<string>,
  auditedPeerId: string | undefined,
): void {
  const backers = Array.isArray(crowd.backers) ? crowd.backers : []
  if (backers.length !== crowd.agree) {
    throw new Error(`tokenizer pre-check crowd counts ${crowd.agree} seller(s) on the reference's count but holds the signed answers of ${backers.length}`)
  }
  const peers = new Set(auditedPeerId ? [peerKey(auditedPeerId)] : [])
  const unclaimed = [...crowd.deltas]
  for (const [index, backer] of backers.entries()) {
    const where = `tokenizer pre-check backing seller ${index + 1}`
    if (typeof backer.peerId !== 'string' || peers.has(peerKey(backer.peerId))) {
      throw new Error(`${where} is the audited seller or another backing seller`)
    }
    peers.add(peerKey(backer.peerId))
    const { ask } = backer
    if (!ask?.probed) throw new Error(`${where} has no signed pair`)
    if (cacheBlocks(ask, rule)) throw new Error(`${where}: its response reports cached input`)
    for (const [request, content] of askedTexts(ask, probe)) {
      if (!signedAsStored(request)) throw new Error(`${where}: its input tokens are not the ones in its signed responses`)
      if (!signedFor(request, content)) throw new Error(`${where}: its signed request is not the first round's text`)
      const signer = request.responseAuth?.record?.sellerPeerId
      if (typeof signer !== 'string' || peerKey(signer) !== peerKey(backer.peerId)) throw new Error(`${where}: its responses are not signed by it`)
      for (const id of request.requestIds) {
        if (requestIds.has(id)) throw new Error(`${where}: counts a request more than once`)
        requestIds.add(id)
      }
    }
    if (ask.delta === null || sellerDelta(ask.base, ask.probed) !== ask.delta || Math.abs(ask.delta - referenceDelta) > rule.toleranceTokens) {
      throw new Error(`${where} does not sign the reference's count`)
    }
    const at = unclaimed.indexOf(ask.delta)
    if (at === -1) throw new Error(`${where}: its difference is not among the crowd's`)
    unclaimed.splice(at, 1)
  }
}

// ── probes ───────────────────────────────────────────────────────────────────────────────────────

/** A random integer in [0, max). */
type RandomInt = (max: number) => number

const OPENERS = [
  'Quick question about something from last week, can you help me check it?',
  'I am sorting out some paperwork and need a second pair of eyes on the details below.',
  'Could you look over these notes and tell me if anything seems wrong?',
  'I am planning the next few days and want to make sure I have this right.',
  'Before I send this on, can you confirm the details make sense?',
  'A colleague passed this along and I am not sure what to make of it.',
  'I need to reply to a message today and want to get the facts straight first.',
  'Can you help me keep track of a few things I was told on the phone?',
]
// Sentences of A between its opener and its ask, each with details written fresh, so no two runs send one same A.
const DETAILS: Array<(write: { id: () => string; digits: (count: number) => string; date: () => string; isoDate: () => string; time: () => string; weekday: () => string; name: () => string }) => string> = [
  (write) => `It is about case ${write.id()} from ${write.date()}.`,
  (write) => `My notes are from ${write.weekday()} at ${write.time()}, file ${write.digits(6)}.`,
  (write) => `It concerns ${write.name()} and ticket ${write.digits(7)}.`,
  (write) => `The folder is marked ${write.id()} and dated ${write.isoDate()}.`,
  (write) => `I wrote it down on ${write.date()} around ${write.time()}, under number ${write.digits(5)}.`,
  (write) => `${write.name()} sent it on ${write.weekday()}, reference ${write.id()}.`,
]
const ASKS = [
  'Please reply in one short sentence.',
  'A one line answer is enough.',
  'Keep the answer to a single short sentence, please.',
  'Just a brief confirmation is fine.',
]
const LONG_WORDS = [
  'otorhinolaryngologist', 'pseudohypoparathyroidism', 'electroencephalography', 'counterrevolutionaries',
  'incomprehensibilities', 'spectrophotofluorometrically', 'thyroparathyroidectomized', 'psychoneuroendocrinological',
  'immunoelectrophoretically', 'dichlorodifluoromethane', 'hepaticocholangiogastrostomy', 'uncharacteristically',
]
const NAMES = [
  'Krzysztof Wojciechowski', 'Siobhan Fitzgerald', 'Nguyen Thanh Phuong', 'Oluwaseun Adebayo', 'Xiomara Echeverria',
  'Tadeusz Szymanowski', 'Anneliese Schwarzkopf', 'Bartholomew Featherstonehaugh', 'Yevgenia Kuznetsova', 'Thandiwe Nkosazana',
]
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const CURRENCIES = ['euros', 'dollars', 'pounds', 'francs', '€', '£']
// Faces and gestures the probe guard accepts: no skin tones, no variation selectors.
const EMOJI = ['😀', '😅', '🙂', '😊', '🙏', '😉', '👍']
const CONSONANTS = 'bdfgklmnprstvz'
const VOWELS = 'aeiou'
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

/**
 * A fresh probe, written locally so it costs nothing and no seller has seen it. A is a short everyday message with
 * details of its own, so it is not one of a few fixed strings a seller could know or an upstream cache could hold.
 * B is what the counts are compared on: a few sentences of plain prose with numbers, identifiers, a rare long word, a
 * made-up word, a name, an emoji and one sentence in Korean or Japanese, which tokenizers of different families
 * split very differently, all within what the probe guard accepts (`isSafeProbe`).
 */
export function generateTokenizerProbe(random: RandomInt = randomInt): TokenizerProbeV1 {
  const pick = <T>(values: readonly T[]): T => values[random(values.length)]!
  const digits = (count: number): string => Array.from({ length: count }, () => String(random(10))).join('')
  const letters = (count: number): string => Array.from({ length: count }, () => LETTERS[random(LETTERS.length)]).join('')
  const id = (): string => `${letters(2)}-${digits(5)}-${letters(2)}`
  const amount = (): string => `${1 + random(9)},${digits(3)}.${digits(2)} ${pick(CURRENCIES)}`
  const date = (): string => `${1 + random(28)} ${pick(MONTHS)} ${2024 + random(4)}`
  const isoDate = (): string => `${2024 + random(4)}-${String(1 + random(12)).padStart(2, '0')}-${String(1 + random(28)).padStart(2, '0')}`
  const time = (): string => `${String(random(24)).padStart(2, '0')}:${String(random(60)).padStart(2, '0')}`
  const madeUpWord = (): string => {
    const syllables = Array.from({ length: 3 + random(3) }, () => CONSONANTS[random(CONSONANTS.length)]! + VOWELS[random(VOWELS.length)]!).join('')
    return syllables[0]!.toUpperCase() + syllables.slice(1) + CONSONANTS[random(CONSONANTS.length)]!
  }
  const english: Array<() => string> = [
    () => `The reference is ${id()} and I paid ${amount()} on ${date()} ${pick(EMOJI)}`,
    () => `Parcel ${digits(4)} ${digits(4)} ${digits(4)} weighs ${1 + random(40)}.${digits(2)} kg and should arrive before ${time()} on ${pick(WEEKDAYS)}.`,
    () => `My contact there is ${pick(NAMES)}, extension ${digits(5)}, who used the word ${pick(LONG_WORDS)} twice.`,
    () => `Invoice ${id()} for ${amount()} is still open, budget code ${digits(2)}-${digits(4)}-${letters(2)}, remaining ${amount()}.`,
    () => `Please also note the ${madeUpWord()} account, number ${digits(10)}, opened on ${isoDate()} ${pick(EMOJI)}`,
    () => `The meeting moved to room ${digits(4)} at ${time()}, and ${pick(NAMES)} will bring the ${pick(LONG_WORDS)} report.`,
    () => `The ${madeUpWord()} order ${letters(3)}${digits(6)} ships from warehouse ${digits(3)} on ${date()}.`,
  ]
  const other: Array<() => string> = [
    () => `예약 번호는 ${id()} 이고 요금은 ${1 + random(9)},${digits(3)},${digits(3)}원 입니다 ${pick(EMOJI)}`,
    () => `서울에서 부산까지 ${1 + random(5)}시간 ${digits(2)}분 걸리고 좌석은 ${1 + random(18)}호차 ${digits(2)}번 입니다.`,
    () => `予約番号は ${id()} で、料金は ${1 + random(9)},${digits(3)}円です。`,
    () => `東京から大阪まで ${1 + random(5)}時間 ${digits(2)}分かかります ${pick(EMOJI)}`,
  ]
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const order = [...english]
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = random(index + 1)
      ;[order[index], order[swap]] = [order[swap]!, order[index]!]
    }
    const sentences = order.slice(0, 4).map((write) => write())
    sentences.splice(random(sentences.length + 1), 0, pick(other)())
    const b = ` ${sentences.join(' ')}`
    if (!isSafeProbe(b)) continue
    const detail = pick(DETAILS)({ id, digits, date, isoDate, time, weekday: () => pick(WEEKDAYS), name: () => pick(NAMES) })
    return { a: `${pick(OPENERS)} ${detail} ${pick(ASKS)}`, b }
  }
  throw new Error('could not write a tokenizer probe the probe guard accepts')
}

/**
 * The pre-check's block of the rules fingerprint (`RecordCheck.fingerprint`), with the fixed inputs it is judged on
 * below: a change to its rule, a limit or what the code gives for one of these inputs changes the pinned rules hash.
 */
export function tokenizerPrecheckFingerprint(): Record<string, unknown> {
  // The pre-check before a seller's questions: its rule and retry limits, the probe guard's table, a probe
  // written from a fixed sequence (so the probe writer is part of the rules), and what the rule, the reference
  // agreement, the crowd, the probe guard and the signed-usage reader give for fixed inputs.
  return {
    rule: TOKENIZER_PRECHECK_RULE,
    referenceProbeTries: REFERENCE_PROBE_TRIES,
    sellerRequestTries: SELLER_REQUEST_TRIES,
    probeGuardRanges: PROBE_GUARD_RANGES,
    probes: SAMPLE_PROBE_SEEDS.map((seed) => generateTokenizerProbe(fixedSequence(seed))),
    judged: SAMPLE_TOKENIZER_ROUNDS.map((rounds) => judgeTokenizerPrecheck(rounds)),
    referenceDeltas: SAMPLE_REFERENCE_ASKS.map((asks) => referenceDelta(asks).delta),
    // A pair whose two answers report the same cached amount is kept (tokenizer-precheck-v3); different amounts, one
    // side only, or no stored cache are not.
    cacheCancels: [
      [{ cached_tokens: 64 }, { cached_tokens: 64 }], [{ cached_tokens: 64 }, { cached_tokens: 70 }], [{ cached_tokens: 64 }, undefined], [undefined, undefined],
    ].map(([base, probed]) => cacheBlocks({
      base: { cachedInput: base !== undefined, ...(base ? { cache: base } : {}) },
      probed: { cachedInput: probed !== undefined, ...(probed ? { cache: probed } : {}) },
    })),
    cachedReference: referenceDelta([1, 2].map(() => ({
      baseTokens: 140, probedTokens: 157, cachedInput: true, cache: [{ cached_tokens: 128 }, { cached_tokens: 128 }] as [Record<string, number>, Record<string, number>], providers: ['Provider-A', 'Provider-A'] as [string, string],
    }))).delta,
    // Whether a seller off a reference of 119 in every round is a mismatch, next to the model's sellers'
    // first-round differences: they must back the reference and must not outvote it.
    crowds: SAMPLE_TOKENIZER_CROWDS.map((deltas) => {
      const crowd = tokenizerCrowd(deltas, 119)
      return [crowd.corroborated, crowd.outvoted, tokenizerCrowdObjection(crowd, 119) === null]
    }),
    guarded: SAMPLE_PROBE_TEXTS.map((text) => isSafeProbe(text)),
    signedUsage: SAMPLE_USAGE_BODIES.map((body) => signedResponseInputUsage(encodeHttpResponse({
      requestId: 'sample', statusCode: 200, headers: {}, body: new TextEncoder().encode(body),
    }))),
  }
}

/**
 * Pre-check rounds (the reference's difference, then the seller's for each ask) around the tolerance: a match on
 * the first or the second ask, three rounds off, a match after two rounds off, too few rounds, an ask without a
 * count, a seller whose two asks disagree, a round without a reference, and counts with cached input (one that
 * matches, one that is off).
 */
const SAMPLE_TOKENIZER_ROUNDS: ReadonlyArray<ReadonlyArray<{ referenceDelta: number | null; sellerDeltas: Array<number | null>; cachedAsks?: boolean[] }>> = [
  [{ referenceDelta: 100, sellerDeltas: [100] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 102] }],
  [{ referenceDelta: 100, sellerDeltas: [103, 104] }, { referenceDelta: 90, sellerDeltas: [87, 86] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  [{ referenceDelta: 100, sellerDeltas: [103, 104] }, { referenceDelta: 90, sellerDeltas: [87, 86] }, { referenceDelta: 80, sellerDeltas: [120, 82] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 140] }, { referenceDelta: 90, sellerDeltas: [130, 130] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 140] }, { referenceDelta: 90, sellerDeltas: [130, null] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 143] }, { referenceDelta: 90, sellerDeltas: [130, 130] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 140] }, { referenceDelta: 90, sellerDeltas: [130, 130] }, { referenceDelta: 80, sellerDeltas: [120] }],
  [{ referenceDelta: null, sellerDeltas: [140, 140] }, { referenceDelta: 90, sellerDeltas: [130, 130] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  [{ referenceDelta: 100, sellerDeltas: [101], cachedAsks: [true] }],
  [{ referenceDelta: 100, sellerDeltas: [140, 140], cachedAsks: [false, true] }, { referenceDelta: 90, sellerDeltas: [130, 130] }, { referenceDelta: 80, sellerDeltas: [120, 120] }],
  // One token off in every round, the same way twice: a mismatch only under an exact count (tokenizer-precheck-v2).
  [{ referenceDelta: 100, sellerDeltas: [101, 101] }, { referenceDelta: 90, sellerDeltas: [91, 91] }, { referenceDelta: 80, sellerDeltas: [81, 81] }],
  // Two rounds off, then the exact count: a match.
  [{ referenceDelta: 100, sellerDeltas: [101, 101] }, { referenceDelta: 90, sellerDeltas: [91, 91] }, { referenceDelta: 80, sellerDeltas: [80] }],
]

/**
 * Sellers' first-round differences: most on another count, a minority on another count, a tie, two sellers both
 * off, scattered counts, one seller alone, one seller off with one on the reference's count, one off with the
 * others unreadable, and two on another count against one on the reference's.
 */
const SAMPLE_TOKENIZER_CROWDS: ReadonlyArray<Array<number | null>> = [
  [132, 132, 133, 132, 119, 120, null],
  [132, 132, 132, 119, 119, 119, 118],
  [132, 132, 132, 119, 119, 119],
  [132, 132],
  [130, 133, 136, 119],
  [132],
  [132, 121],
  [132, null, null],
  [132, 132, 119],
  // One seller off with one on the reference's exact count (tokenizer-precheck-v2: only the exact count backs it).
  [132, 119],
]

const referenceAsk = (baseTokens: number | null, probedTokens: number | null, extra: Partial<TokenizerReferenceAskV1> = {}): TokenizerReferenceAskV1 => ({
  baseTokens, probedTokens, cachedInput: false, providers: ['Provider-A', 'Provider-A'], ...extra,
})

/**
 * Reference asks (input tokens for A and for A + B): agreeing, disagreeing, unreadable, not growing, asked once,
 * with cached input, from two providers, and from an endpoint that names no provider.
 */
const SAMPLE_REFERENCE_ASKS: ReadonlyArray<TokenizerReferenceAskV1[]> = [
  [referenceAsk(26, 143), referenceAsk(26, 143)],
  [referenceAsk(26, 143), referenceAsk(26, 144)],
  [referenceAsk(26, 143), referenceAsk(null, 143)],
  [referenceAsk(26, 26), referenceAsk(26, 26)],
  [referenceAsk(26, 143)],
  [referenceAsk(26, 143), referenceAsk(26, 143, { cachedInput: true })],
  [referenceAsk(26, 143), referenceAsk(26, 143, { providers: ['Provider-A', 'Provider-B'] })],
  [referenceAsk(26, 143, { providers: [null, null] }), referenceAsk(26, 143, { providers: [null, null] })],
]

/** Seeds of the probes the fingerprint holds, each written from `fixedSequence`. */
const SAMPLE_PROBE_SEEDS: readonly number[] = [1, 2, 3, 4]

/** A fixed sequence of picks in place of the probe writer's random ones. */
export function fixedSequence(seed: number): (max: number) => number {
  let state = seed >>> 0
  return (max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return Math.floor((state / 0x1_0000_0000) * max)
  }
}

/** Probe text on both sides of the probe guard. */
const SAMPLE_PROBE_TEXTS: readonly string[] = [
  ' The reference is ZX-48217-QK and I paid 1,249.50 € on 14 March 2026 😀',
  ' 예약 번호는 AB-12345-CD 이고 요금은 59,800원 입니다',
  ' 予約番号は AB-12345-CD で、料金は 9,800円です。',
  'No leading space',
  ' it\'s a contraction',
  ' a <|control|> token',
  ' ESPAÑA in capitals',
  ' thumbs up 👍\u{1f3fb}',
]

/** Signed response bodies the usage reader reads, and ones it refuses. */
const SAMPLE_USAGE_BODIES: readonly string[] = [
  '{"usage":{"prompt_tokens":143,"completion_tokens":40}}',
  '{"usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":1}}',
  '{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4}}}',
  '{"usage":{"prompt_tokens":15,"prompt_tokens":20}}',
  '{"usage":{"prompt_tokens":1e3}}',
  '{"usage":{"prompt_tokens":0,"completion_tokens":0}}',
  '{"usage":{"prompt_tokens":120,"prompt_tokens_details":{"cached_tokens":108}}}',
  '{"usage":{"prompt_tokens":802,"prompt_tokens_details":{"cached_tokens":0,"cache_write_tokens":770}}}',
  '{"choices":[]}',
  '{"usage":{"prompt_tokens":0,"prompt_tokens_details":{"cached_tokens":12}}}',
  '{"usage":{"prompt_tokens":123}',
  'data: {"usage":{"prompt_tokens":15}}',
  '{"error":{"message":"upstream overloaded"},"usage":{"prompt_tokens":40}}',
]
