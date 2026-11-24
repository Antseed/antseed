import assert from 'node:assert/strict'
import test from 'node:test'
import { flaggingChecks, passedChecks } from '../../audit-checks.js'
import { encodeHttpResponse } from '@antseed/node'
import { isSafeProbe } from '@antseed/node/payments'
import { ConcurrencyLimiter } from '../../audit-concurrency.js'
import { needsExtension } from '../../close-call.js'
import { finalAuditVerdict, validateAuditMatchesSummary } from '../../model-audit.js'
import type { ResponseAuthReader } from '../../response-auth-reader.js'
import { BACKER_ID, MODEL_TOKENIZER, OTHER_TOKENIZER, PEER_ID, PROBES, PROBE_COUNT, SERVICE, audit, measuredReference, referenceAsk, seller, signedRecord, signedRequestBase64, tokenizer } from '../../seller-audit.test-support.js'
import {
  TOKENIZER_PRECHECK_RULE,
  cacheBlocks,
  cacheShownInCount,
  createTokenizerPrecheckScreen,
  describeTokenizerMismatch,
  generateTokenizerProbe,
  judgeTokenizerPrecheck,
  judgeTokenizerRound,
  REFERENCE_ROUTE_AMBIGUOUS,
  measureTokenizerReference,
  referenceDelta,
  runTokenizerPrecheck,
  tokenizerCrowd,
  tokenizerPrecheckRuleById,
  tokenizerPrecheckCost,
  tokenizerPrecheckRequestCount,
  validateTokenizerPrecheck,
  type TokenizerBackerV1,
  type TokenizerPrecheckReferenceV1,
  type TokenizerPrecheckRule,
  type TokenizerPrecheckV1,
  type TokenizerReferenceAsk,
  type TokenizerReferenceAskV1,
} from './tokenizer-precheck.js'
import type { SellerClock } from '../shared/seller-clock.js'

/**
 * The first-round pair of a seller of the model that counts like the reference, signed by `peerId`: what a
 * backing seller's vote holds. It is that seller's own pre-check, which matches in its first ask.
 */
async function backingAsk(reference: TokenizerPrecheckReferenceV1, peerId: string): Promise<TokenizerBackerV1> {
  const backer = seller({ usage: (content) => 40 + MODEL_TOKENIZER(content), peerId })
  const record = await runTokenizerPrecheck({
    proxyBaseUrl: 'http://127.0.0.1:8390/', peerId, service: SERVICE, reference,
    responseAuthReader: backer.responseAuthReader, limiter: new ConcurrencyLimiter(2), fetchFn: backer.fetchFn,
  })
  assert.equal(record.outcome, 'match')
  return { peerId, service: SERVICE, ask: record.rounds[0]!.seller[0]! }
}

/**
 * One seller's pre-check. When it is off in every round, the model's other sellers are `backers` sellers that
 * sign the reference's count for the first round's text, each with its signed pair.
 */
async function precheck(
  target: ReturnType<typeof seller>,
  reference?: TokenizerPrecheckReferenceV1,
  options: { backers?: number; signal?: AbortSignal; rule?: TokenizerPrecheckRule } = {},
): Promise<TokenizerPrecheckV1> {
  const measured = reference ?? await measuredReference()
  const rule = options.rule ?? TOKENIZER_PRECHECK_RULE
  return runTokenizerPrecheck({
    ...(options.rule ? { rule } : {}),
    proxyBaseUrl: 'http://127.0.0.1:8390/',
    peerId: PEER_ID,
    service: SERVICE,
    reference: measured,
    responseAuthReader: target.responseAuthReader,
    limiter: new ConcurrencyLimiter(2),
    fetchFn: target.fetchFn,
    ...(options.signal ? { signal: options.signal } : {}),
    crowd: async (own) => {
      const backers = await Promise.all(Array.from({ length: options.backers ?? 1 }, (_entry, index) => (
        backingAsk(measured, `${String(index + 3).padStart(2, '0')}`.repeat(20))
      )))
      return tokenizerCrowd([own.delta, ...backers.map((backer) => backer.ask.delta)], measured.rounds[0]!.delta!, rule, [], backers)
    },
  })
}

/** One ask of the reference: the counts for A and for A + B, from one provider and without cached input. */
const asked = (baseTokens: number | null, probedTokens: number | null, extra: Partial<TokenizerReferenceAskV1> = {}): TokenizerReferenceAskV1 => ({
  baseTokens, probedTokens, cachedInput: false, providers: ['Provider-A', 'Provider-A'], ...extra,
})

/** The rule with a tolerance of 2 tokens, to test how a tolerance is applied (the rule counts exactly). */
const TOLERANT = Object.freeze({ ...TOKENIZER_PRECHECK_RULE, toleranceTokens: 2 })
/** The rule without keeping a pair whose two answers report the same cached amount. */
const WITHOUT_SAME_CACHE = Object.freeze({ ...TOKENIZER_PRECHECK_RULE, sameCacheCancels: undefined })

test('a round is off only when the seller is asked twice, is off the reference both times and agrees with itself', () => {
  // Under a tolerance of 2 tokens.
  const judgeTolerantRound = (input: Parameters<typeof judgeTokenizerRound>[0]) => judgeTokenizerRound(input, TOLERANT)
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [100] }), 'match')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [102] }), 'match')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [98] }), 'match')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [103] }), 'unmeasured', 'one ask off proves nothing yet')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [140, 101] }), 'match', 'the second ask counted like the model')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [140, 140] }), 'off')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [140, 142] }), 'off', 'its asks may differ by the tolerance')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [140, 143] }), 'unstable')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [125, 64] }), 'unstable')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [140, null] }), 'unmeasured')
  assert.equal(judgeTolerantRound({ referenceDelta: 100, sellerDeltas: [] }), 'unmeasured')
  assert.equal(judgeTolerantRound({ referenceDelta: null, sellerDeltas: [140, 140] }), 'unmeasured')
})

test('a seller is a mismatch only when every round of the rule is off', () => {
  // Under a tolerance of 2 tokens.
  const judgeTolerantPrecheck = (input: Parameters<typeof judgeTokenizerPrecheck>[0]) => judgeTokenizerPrecheck(input, TOLERANT)
  const off = { referenceDelta: 100, sellerDeltas: [140, 140] }
  assert.equal(judgeTolerantPrecheck([off, off, off]), 'mismatch')
  assert.equal(judgeTolerantPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [140, 102] }]), 'match', 'within the tolerance once is a match')
  assert.equal(judgeTolerantPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [103, 104] }]), 'mismatch', 'one past the tolerance is off')
  assert.equal(judgeTolerantPrecheck([off, off]), 'inconclusive', 'two rounds prove nothing')
  assert.equal(judgeTolerantPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [140, null] }]), 'inconclusive')
  assert.equal(judgeTolerantPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [140, 90] }]), 'inconclusive', 'counts that change between asks')
  assert.equal(judgeTolerantPrecheck([off, off, { referenceDelta: null, sellerDeltas: [140, 140] }]), 'inconclusive')
  // In the order the run asks: a round that decides nothing ends the check, whatever a later round would say.
  assert.equal(judgeTolerantPrecheck([{ referenceDelta: 100, sellerDeltas: [140, 90] }, { referenceDelta: 100, sellerDeltas: [100] }]), 'inconclusive')
  assert.equal(judgeTolerantPrecheck([]), 'inconclusive')
})

test('the reference has a difference only when every ask is readable, grows with the follow-up and agrees', () => {
  assert.equal(referenceDelta([asked(26, 143), asked(26, 143)]).delta, 117)
  // A different wrapper on the second ask still gives the same difference.
  assert.equal(referenceDelta([asked(26, 143), asked(30, 147)]).delta, 117)
  assert.match(referenceDelta([asked(26, 143), asked(26, 144)]).failure!, /did not agree with itself \(117, 118\)/)
  assert.match(referenceDelta([asked(26, 143), asked(null, 143)]).failure!, /no input tokens/)
  assert.match(referenceDelta([asked(26, 26), asked(26, 26)]).failure!, /no more tokens/)
  assert.match(referenceDelta([asked(26, 143)]).failure!, /asked 1 of 2 times/)
})

test('a reference that reports cached input, or answers from two providers, has no difference though it agrees with itself', () => {
  // An upstream cache: both asks agree, and both may be shifted by the same amount.
  assert.match(referenceDelta([asked(26, 143, { cachedInput: true }), asked(26, 143, { cachedInput: true })]).failure!, /reported cached input/)
  assert.match(referenceDelta([asked(26, 143), asked(26, 143, { cachedInput: true })]).failure!, /reported cached input/)
  // A is always answered by one deployment and A + B by another, whose template adds ten tokens: 117 both times.
  const twoBackends = asked(26, 143, { providers: ['Provider-A', 'Provider-B'] })
  assert.match(referenceDelta([twoBackends, twoBackends]).failure!, /more than one provider \(Provider-A, Provider-B\)/)
  assert.match(referenceDelta([asked(26, 143), asked(26, 143, { providers: ['Provider-B', 'Provider-B'] })]).failure!, /more than one provider/)
  // An answer that names no provider beside ones that do is not known to be the same one.
  assert.match(referenceDelta([asked(26, 143), asked(26, 143, { providers: ['Provider-A', null] })]).failure!, /more than one provider \(Provider-A, unnamed\)/)
  // An endpoint that never names a provider (a model maker's own API) is one route.
  const unnamed = asked(26, 143, { providers: [null, null] })
  assert.equal(referenceDelta([unnamed, unnamed]).delta, 117)
  // A stored ask without the two fields is not taken for a clean one.
  const bare = { baseTokens: 26, probedTokens: 143 } as unknown as TokenizerReferenceAskV1
  assert.equal(referenceDelta([bare, bare]).delta, null)
})

test('a route that may serve several providers and names none in a round measures nothing, though it agrees with itself', async () => {
  // Every answer agrees and names no provider. On a route known to serve one host that is a measurement; on one that
  // may serve several (a router not pinned to one), A and A + B could come from two deployments.
  const unnamed = (oneProvider: boolean | undefined) => async (contents: readonly string[]) => ({
    upstream: null, ...(oneProvider === undefined ? {} : { oneProvider }),
    results: contents.map((content) => ({ inputTokens: MODEL_TOKENIZER(content), cachedInput: false, provider: null, failure: null })),
  })
  const probes = PROBES.slice(0, 3)
  const several = await measureTokenizerReference({ ask: unnamed(false), probes })
  assert.deepEqual(several.rounds.map((round) => [round.delta, round.ambiguous, round.failure]),
    probes.map(() => [null, true, REFERENCE_ROUTE_AMBIGUOUS]))
  for (const oneProvider of [true, undefined]) {
    const one = await measureTokenizerReference({ ask: unnamed(oneProvider), probes })
    assert.deepEqual(one.rounds.map((round) => [round.delta, round.ambiguous]), probes.map(({ a, b }) => [MODEL_TOKENIZER(a + b) - MODEL_TOKENIZER(a), undefined]), String(oneProvider))
  }
  // Named answers on such a route are judged as before: one provider measures.
  const named = await measureTokenizerReference({
    ask: async (contents) => ({ upstream: null, oneProvider: false, results: contents.map((content) => ({ inputTokens: MODEL_TOKENIZER(content), cachedInput: false, provider: 'Provider-A', failure: null })) }),
    probes,
  })
  assert.ok(named.rounds.every((round) => round.delta !== null && round.ambiguous === undefined))
  // Stored: a round marked ambiguous has no difference, whatever its asks give; a round marked so that claims one is refused.
  const asked = await precheck(seller({ usage: OTHER_TOKENIZER }), several)
  const seller_ = asked
  assert.equal(seller_.outcome, 'inconclusive')
  assert.doesNotThrow(() => validateTokenizerPrecheck(seller_))
  const claimed = structuredClone(seller_)
  claimed.rounds[0]!.reference.delta = MODEL_TOKENIZER(claimed.rounds[0]!.a + claimed.rounds[0]!.b) - MODEL_TOKENIZER(claimed.rounds[0]!.a)
  assert.throws(() => validateTokenizerPrecheck(claimed), /the reference difference does not follow from its asks/)
})

test('a probe the reference reports cached input for is replaced like a refused one', async () => {
  const cachedFor = new Set<string>()
  const reference = await measureTokenizerReference({
    ask: async (contents) => {
      // The first text of the run hits the endpoint's cache on its second ask.
      const hit = cachedFor.size === 0
      if (hit) cachedFor.add(contents[0]!)
      return {
        upstream: null,
        results: contents.map((content, index) => ({
          inputTokens: MODEL_TOKENIZER(content) + (hit && index >= 2 ? 13 : 0), cachedInput: hit && index >= 2, provider: 'Provider-A', failure: null,
        })),
      }
    },
  })
  assert.equal(cachedFor.size, 1)
  assert.ok(reference.probes.every((probe) => !cachedFor.has(probe.a)), 'the probe with cached input is not kept')
  assert.deepEqual(reference.rounds.map((round) => round.delta), reference.probes.map(({ a, b }) => MODEL_TOKENIZER(a + b) - MODEL_TOKENIZER(a)))
  assert.deepEqual(reference.rounds[0]!.asks[0], { ...asked(MODEL_TOKENIZER(reference.probes[0]!.a), MODEL_TOKENIZER(reference.probes[0]!.a + reference.probes[0]!.b)) })
})

test('a round whose every reference ask reports cached input is not rewritten: a fresh text does not change the endpoint\'s cache', async () => {
  let asks = 0
  const reference = await measureTokenizerReference({
    ask: async (contents) => {
      asks += 1
      return { upstream: null, results: contents.map((content) => ({ inputTokens: MODEL_TOKENIZER(content), cachedInput: true, provider: 'Provider-A', failure: null })) }
    },
  })
  assert.equal(asks, 3, 'one probe per round')
  assert.deepEqual(reference.rounds.map((round) => round.failure), new Array(3).fill('the reference reported cached input'))
  // Only the longer requests cached: that hit may be the text's, so the probe is replaced, three times at most.
  let longOnly = 0
  await measureTokenizerReference({
    ask: async (contents) => {
      longOnly += 1
      return { upstream: null, results: contents.map((content, index) => ({ inputTokens: MODEL_TOKENIZER(content), cachedInput: index % 2 === 1, provider: 'Provider-A', failure: null })) }
    },
  })
  assert.equal(longOnly, 9)
})

test('a reference that does not answer within the time limit leaves its rounds without a difference, and is asked nothing more', async () => {
  const signals: Array<AbortSignal | undefined> = []
  const started = Date.now()
  const reference = await measureTokenizerReference({
    timeLimitMs: 30,
    ask: async (contents, signal) => {
      signals.push(signal)
      await new Promise((resolve) => setTimeout(resolve, 200))
      return referenceAsk()(contents)
    },
  })
  assert.ok(Date.now() - started < 190, 'not waited for')
  assert.equal(signals.length, 3, 'no probe written again after the time is up')
  assert.ok(signals.every((signal) => signal?.aborted))
  assert.deepEqual(reference.rounds.map((round) => round.failure), new Array(3).fill('the reference did not answer within 30ms'))
})

test('every generated probe compares text the probe guard accepts, and no two are the same', () => {
  const probes = Array.from({ length: 400 }, () => generateTokenizerProbe())
  for (const { a, b } of probes) {
    assert.ok(isSafeProbe(b), b)
    assert.ok(a.length > 20 && !a.endsWith(' '))
    const words = b.trim().split(/\s+/).length
    assert.ok(words >= 30 && words <= 110, `${words} words: ${b}`)
  }
  assert.equal(new Set(probes.map((probe) => probe.b)).size, probes.length)
  // A has details of its own too: it is not one of a few fixed strings.
  assert.ok(new Set(probes.map((probe) => probe.a)).size >= probes.length - 2)
  // Every template, filler and position, whatever the random draws.
  for (const fixed of [0, 1, 2, 3, 5, 7, 11]) {
    assert.ok(isSafeProbe(generateTokenizerProbe((max) => fixed % max).b))
    assert.ok(isSafeProbe(generateTokenizerProbe((max) => max - 1 - (fixed % max)).b))
  }
})

test('the reference is asked every pair twice and gives the model\'s difference for each probe', async () => {
  const asked: string[] = []
  const reference = await measureTokenizerReference({
    probes: PROBES,
    ask: async (contents) => {
      asked.push(...contents)
      return referenceAsk()(contents)
    },
  })
  assert.equal(asked.length, 12)
  for (const { a, b } of PROBES) assert.equal(asked.filter((content) => content === a).length + asked.filter((content) => content === a + b).length, 4)
  assert.deepEqual(reference.rounds.map((round) => round.delta), PROBES.map(({ a, b }) => MODEL_TOKENIZER(a + b) - MODEL_TOKENIZER(a)))
  assert.deepEqual(reference.upstream, { name: 'referenceEndpoint' })
})

test('a reference that reports no usage, or cannot be asked, leaves its rounds without a difference', async () => {
  const zeroOnce = await measureTokenizerReference({
    probes: PROBES,
    ask: async (contents) => ({
      upstream: null,
      // The second probe's first request came back without usage.
      results: contents.map((content, index) => (content === PROBES[1]!.a && index === 0
        ? { inputTokens: null, failure: 'the reference endpoint reported zero input tokens' }
        : { inputTokens: MODEL_TOKENIZER(content), failure: null })),
    }),
  })
  assert.deepEqual(zeroOnce.rounds.map((round) => round.delta === null), [false, true, false])
  assert.match(zeroOnce.rounds[1]!.failure!, /zero input tokens/)
  const down = await measureTokenizerReference({ probes: PROBES, ask: async () => { throw new Error('no reference credits') } })
  assert.deepEqual(down.rounds.map((round) => round.delta), [null, null, null])
  assert.match(down.rounds[0]!.failure!, /could not be asked: no reference credits/)
  assert.equal(down.probes.length, 3)
})

test('a probe the reference gives no difference for is replaced by a fresh one, three times at most', async () => {
  // The reference refuses the first two texts it is shown (a content filter), then answers.
  const refused = new Set<string>()
  const replaced = await measureTokenizerReference({
    ask: async (contents) => {
      const refuse = refused.size < 2 && !refused.has(contents[0]!)
      if (refuse) refused.add(contents[0]!)
      return {
        upstream: { name: 'referenceEndpoint' },
        results: contents.map((content) => (refused.has(contents[0]!)
          ? { inputTokens: null, failure: 'reference endpoint returned no text content: refusal' }
          : { inputTokens: MODEL_TOKENIZER(content), failure: null })),
      }
    },
  })
  assert.equal(refused.size, 2)
  assert.deepEqual(replaced.rounds.map((round) => round.delta !== null), [true, true, true])
  assert.ok(replaced.probes.every((probe) => !refused.has(probe.a)), 'the refused probes are not the ones kept')
  assert.deepEqual(replaced.rounds.map((round) => round.delta), replaced.probes.map(({ a, b }) => MODEL_TOKENIZER(a + b) - MODEL_TOKENIZER(a)))

  // A reference that refuses everything: three probes per round, then no difference.
  let asks = 0
  const never = await measureTokenizerReference({
    ask: async (contents) => {
      asks += 1
      return { upstream: null, results: contents.map(() => ({ inputTokens: null, failure: 'refusal' })) }
    },
  })
  assert.equal(asks, 9)
  assert.deepEqual(never.rounds.map((round) => round.delta), [null, null, null])
  assert.equal(never.probes.length, 3)
})

test('without probes given, a reference measurement writes one fresh probe per round', async () => {
  const reference = await measureTokenizerReference({ ask: referenceAsk() })
  assert.equal(reference.probes.length, TOKENIZER_PRECHECK_RULE.rounds)
  assert.ok(reference.rounds.every((round) => round.delta !== null && round.delta > 0))
})

test('an honest seller matches in the first round, whatever hidden prompt it adds, and is asked nothing more', async () => {
  // The seller's own system prompt and chat template add 250 tokens to every request.
  const target = seller({ usage: (content) => 250 + MODEL_TOKENIZER(content) })
  const record = await precheck(target)
  assert.equal(record.outcome, 'match')
  assert.equal(record.reason, null)
  assert.deepEqual(target.contents, [PROBES[0]!.a, PROBES[0]!.a + PROBES[0]!.b])
  assert.equal(record.rounds[0]!.seller.length, 1)
  assert.equal(record.rounds[0]!.seller[0]!.delta, record.rounds[0]!.reference.delta)
  assert.deepEqual(record.rounds.slice(1).map((round) => round.seller), [[], []])
  assert.equal(tokenizerPrecheckRequestCount(record), 2)
  assert.equal(tokenizerPrecheckCost(record).pricedExchangeCount, 2)
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
})

test('a seller counting with another tokenizer is a mismatch after every round is asked twice, with the signed bytes kept', async () => {
  const target = seller({ usage: (content) => 12 + OTHER_TOKENIZER(content) })
  const record = await precheck(target)
  assert.equal(record.outcome, 'mismatch')
  assert.equal(target.contents.length, 12)
  for (const [index, round] of record.rounds.entries()) {
    assert.deepEqual(target.contents.slice(index * 4, index * 4 + 4), [round.a, round.a + round.b, round.a, round.a + round.b])
    assert.equal(round.seller.length, 2)
    assert.equal(round.seller[0]!.delta, round.seller[1]!.delta)
    assert.ok(Math.abs(round.seller[0]!.delta! - round.reference.delta!) > TOKENIZER_PRECHECK_RULE.toleranceTokens)
    assert.equal(round.seller[0]!.base.responseAuth!.status, 'verified')
    assert.ok(round.seller[1]!.probed!.responseAuth!.signedPreimages!.responseBase64.length > 10)
  }
  assert.match(describeTokenizerMismatch(record), new RegExp(
    `the seller signed ${record.rounds.map((round) => round.seller[0]!.delta).join('/')} input tokens, each 2 times over, `
    + `for text the model counts as ${record.rounds.map((round) => round.reference.delta).join('/')}: off by more than ${TOKENIZER_PRECHECK_RULE.toleranceTokens} in every round, `
    + 'while 1 of the model\'s other sellers signed the model\'s count$',
  ))
  assert.equal(record.crowd!.corroborated, true)
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
})

test('a seller off the reference in every round is not a mismatch when no other seller of the model backs the reference', async () => {
  // The model's only seller, or a run in which nobody else could be read.
  const alone = await precheck(seller({ usage: OTHER_TOKENIZER }), undefined, { backers: 0 })
  assert.equal(alone.outcome, 'inconclusive')
  assert.match(alone.reason!, /^no other seller of the model signed the reference's count \(\d+\) in this run \(1 of 1 could be read, this one included\), so nothing backs the reference$/)
  assert.deepEqual(alone.rounds.map((round) => round.seller.length), [2, 2, 2])
  assert.equal(alone.crowd!.corroborated, false)
  assert.doesNotThrow(() => validateTokenizerPrecheck(alone))
  // Stored as a mismatch, it does not hold.
  assert.throws(() => validateTokenizerPrecheck({ ...alone, outcome: 'mismatch', reason: null }), /outcome mismatch does not follow from its rounds \(inconclusive\)/)

  // Without anybody to ask, the same.
  const target = seller({ usage: OTHER_TOKENIZER })
  const unasked = await runTokenizerPrecheck({
    proxyBaseUrl: 'http://127.0.0.1:8390/', peerId: PEER_ID, service: SERVICE, reference: await measuredReference(),
    responseAuthReader: target.responseAuthReader, limiter: new ConcurrencyLimiter(2), fetchFn: target.fetchFn,
  })
  assert.equal(unasked.outcome, 'inconclusive')
  assert.match(unasked.reason!, /the model's other sellers were not asked/)
  assert.equal(unasked.crowd, undefined)
  assert.doesNotThrow(() => validateTokenizerPrecheck(unasked))
})

test('a seller that signs no more input for the longer request has measured nothing, however often it repeats it', async () => {
  // A gateway that signs one fallback count for every request: a difference of zero, the same on every ask.
  const flat = seller({ usage: () => 512 })
  const record = await precheck(flat)
  assert.equal(record.outcome, 'inconclusive')
  assert.match(record.reason!, /^the seller signed no more input tokens with the follow-up \(512\) than without \(512\)$/)
  assert.equal(record.rounds[0]!.seller[0]!.delta, null)
  assert.equal(flat.contents.length, 2)
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
  // Stored as a difference of zero, it would be off the reference.
  const claimed = structuredClone(record)
  claimed.rounds[0]!.seller[0]!.delta = 0
  assert.throws(() => validateTokenizerPrecheck(claimed), /difference does not follow/)
  // Fewer tokens for more text is no measurement either.
  const shrinking = seller({ usage: (content) => 2_000 - MODEL_TOKENIZER(content) })
  assert.equal((await precheck(shrinking)).outcome, 'inconclusive')
})

test('a signed response that reports cached input and no count that can be read is stored as the check at submit reads it', async () => {
  for (const usage of [
    { cached_tokens: 1 },
    { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 12 } },
    // Gemini's own usage shape.
    { promptTokenCount: 40, cachedContentTokenCount: 30 },
  ]) {
    const target = seller({ usage: () => usage })
    const record = await precheck(target)
    assert.equal(record.outcome, 'inconclusive')
    const base = record.rounds[0]!.seller[0]!.base
    assert.deepEqual([base.signedInputTokens, base.cachedInput, base.responseAuth!.status], [null, true, 'verified'])
    assert.doesNotThrow(() => validateTokenizerPrecheck(record), JSON.stringify(usage))
  }
  // The last try is what the record holds: a first try with cached input and a second that fails outright.
  const thenDown = seller({ usage: () => ({ cached_tokens: 1 }), status: (call) => (call === 2 ? 503 : 200) })
  const record = await precheck(thenDown)
  const base = record.rounds[0]!.seller[0]!.base
  assert.deepEqual([base.signedInputTokens, base.cachedInput, base.responseAuth, base.requestIds.length], [null, false, null, 2])
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
})

test('a pre-check whose audit was stopped sends nothing more', async () => {
  const stopped = new AbortController()
  stopped.abort()
  const target = seller({ usage: OTHER_TOKENIZER })
  const record = await precheck(target, undefined, { signal: stopped.signal })
  assert.equal(record.outcome, 'inconclusive')
  assert.match(record.reason!, /the audit was stopped/)
  assert.equal(target.contents.length, 0)
  // Stopped after the first round: the rounds already signed stay, and nothing is decided.
  const midway = new AbortController()
  const later = seller({ usage: (content, call) => { if (call === 4) midway.abort(); return OTHER_TOKENIZER(content) } })
  const partial = await precheck(later, undefined, { signal: midway.signal })
  assert.equal(partial.outcome, 'inconclusive')
  assert.equal(later.contents.length, 4)
  assert.doesNotThrow(() => validateTokenizerPrecheck(partial))
})

test('a seller within the tolerance in a later round, or on its second ask, is a match', async () => {
  // Off in the first two rounds (requests 1 to 8), the model's count in the third.
  const later = seller({ usage: (content, call) => (call <= 8 ? OTHER_TOKENIZER(content) : 1 + MODEL_TOKENIZER(content)) })
  const laterRecord = await precheck(later)
  assert.equal(laterRecord.outcome, 'match')
  assert.equal(later.contents.length, 10)
  assert.doesNotThrow(() => validateTokenizerPrecheck(laterRecord))

  // One pair went through a backend that counts differently; asked again, the seller counts like the model.
  const second = seller({ usage: (content, call) => (call <= 2 ? OTHER_TOKENIZER(content) : MODEL_TOKENIZER(content)) })
  const secondRecord = await precheck(second)
  assert.equal(secondRecord.outcome, 'match')
  assert.equal(second.contents.length, 4)
  assert.equal(secondRecord.rounds[0]!.seller.length, 2)
  assert.doesNotThrow(() => validateTokenizerPrecheck(secondRecord))
})

test('a seller whose count for the same text changes between asks decides nothing, however far off it is', async () => {
  // Hidden input that varies from request to request: a wrapper of 40 to 400 tokens, different every time.
  const wrappers = [40, 395, 61, 120]
  const target = seller({ usage: (content, call) => wrappers[call - 1]! + MODEL_TOKENIZER(content) })
  const record = await precheck(target)
  assert.equal(record.outcome, 'inconclusive')
  const [first, second] = record.rounds[0]!.seller.map((ask) => ask.delta)
  assert.match(record.reason!, new RegExp(
    `the seller signed different counts for the same text \\(${first}, ${second} where the model counts ${record.rounds[0]!.reference.delta}\\), so its hidden input varies`,
  ))
  assert.equal(target.contents.length, 4, 'the first round twice, and no other round')
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
})

test('a count with cached input can match the model, and is never held against the seller when it is off', async () => {
  // Upstreams that cache every prompt report the hit on each request; the count still covers the whole input.
  const cached = (tokens: number, cachedTokens = 64) => ({ prompt_tokens: tokens, completion_tokens: 3, prompt_tokens_details: { cached_tokens: cachedTokens } })
  const honest = seller({ usage: (content) => cached(900 + MODEL_TOKENIZER(content)) })
  const matched = await precheck(honest)
  assert.equal(matched.outcome, 'match')
  assert.equal(honest.contents.length, 2)
  assert.deepEqual([matched.rounds[0]!.seller[0]!.base.cachedInput, matched.rounds[0]!.seller[0]!.probed!.cachedInput], [true, true])
  assert.doesNotThrow(() => validateTokenizerPrecheck(matched))

  // A gateway that leaves the cached part out of its count: where the cache ends moves with the text, so the
  // difference is off by a little every time, the same way when asked again.
  // It reports the part it left out, which moves with the text: the two answers of a pair report different cached
  // amounts, so the cache does not cancel out (`sameCache`).
  const netOfCache = seller({ usage: (content) => cached(MODEL_TOKENIZER(content) - Math.round(content.length / 12), Math.round(content.length / 12)) })
  const undecided = await precheck(netOfCache)
  assert.equal(undecided.outcome, 'inconclusive')
  const round = undecided.rounds[0]!
  assert.match(undecided.reason!, new RegExp(
    `^the seller signed ${round.seller[0]!.delta} input tokens where the model counts ${round.reference.delta}, `
    + 'but its response reports cached input, whose count cannot be held against it$',
  ))
  assert.equal(netOfCache.contents.length, 2, 'not asked again: the cache would be in play again')
  assert.doesNotThrow(() => validateTokenizerPrecheck(undecided))

  // Only the longer request was cached (a cache write this time).
  const probedOnly = seller({
    usage: (content, call) => (call % 2 === 1
      ? OTHER_TOKENIZER(content)
      : { prompt_tokens: OTHER_TOKENIZER(content), prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 770 } }),
  })
  assert.equal((await precheck(probedOnly)).outcome, 'inconclusive')
  assert.equal(probedOnly.contents.length, 2)

  // A stored record cannot drop the cache from a response that reports it, and so turn it into a mismatch.
  const claimed = structuredClone(undecided)
  claimed.rounds[0]!.seller[0]!.probed!.cachedInput = false
  assert.throws(() => validateTokenizerPrecheck(claimed), /not the ones in its signed responses/)
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [140, 140], cachedAsks: [false, true] }), 'unmeasured')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [140, 140], cachedAsks: [false, false] }), 'off')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [100], cachedAsks: [true] }), 'match', 'a count with cached input that is the model\'s matches')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [99], cachedAsks: [true] }, TOLERANT), 'match', 'within a tolerance too')
})

test('a response signed without usage, or with a zero count, decides nothing after one more try', async () => {
  for (const usage of [null, 0]) {
    const target = seller({ usage: () => usage })
    const record = await precheck(target)
    assert.equal(record.outcome, 'inconclusive')
    assert.match(record.reason!, /signed input tokens could not be read: the response the seller signed reports no input tokens/)
    assert.deepEqual(target.contents, [PROBES[0]!.a, PROBES[0]!.a], 'the base request twice, never the follow-up')
    assert.equal(record.rounds[0]!.seller[0]!.probed, null)
    assert.equal(record.rounds[0]!.seller[0]!.base.requestIds.length, 2)
    assert.doesNotThrow(() => validateTokenizerPrecheck(record))
  }
})

test('a count of zero after a readable base request is unreadable, never a difference', async () => {
  // A gateway reports zero usage for a reply cut off before the upstream sent any: only the follow-up here.
  const target = seller({ usage: (content, call) => (call === 1 ? MODEL_TOKENIZER(content) : 0) })
  const record = await precheck(target)
  assert.equal(record.outcome, 'inconclusive')
  assert.equal(record.rounds[0]!.seller[0]!.delta, null)
  assert.equal(target.contents.length, 3)
})

test('a failed request is tried once more; a refusal is not, and its reason is kept', async () => {
  const flaky = seller({ usage: MODEL_TOKENIZER, status: (call) => (call === 1 ? 502 : 200) })
  const recovered = await precheck(flaky)
  assert.equal(recovered.outcome, 'match')
  assert.equal(flaky.contents.length, 3)
  assert.equal(recovered.rounds[0]!.seller[0]!.base.requestIds.length, 2)

  const refusing = seller({ usage: MODEL_TOKENIZER, status: () => 402 })
  const refused = await precheck(refusing)
  assert.equal(refused.outcome, 'inconclusive')
  assert.match(refused.reason!, /the seller answered HTTP 402: unavailable$/)
  assert.equal(refusing.contents.length, 1)

  const down = seller({ usage: MODEL_TOKENIZER, status: () => 503 })
  assert.equal((await precheck(down)).outcome, 'inconclusive')
  assert.equal(down.contents.length, 2)
})

test('an answer without a verified ResponseAuth decides nothing', async () => {
  const target = seller({ usage: OTHER_TOKENIZER, auth: 'invalid' })
  const record = await precheck(target)
  assert.equal(record.outcome, 'inconclusive')
  assert.match(record.reason!, /bad signature/)
  assert.equal(record.rounds[0]!.seller[0]!.base.signedInputTokens, null)
})

test('without a reference difference the seller is not asked at all', async () => {
  const target = seller({ usage: OTHER_TOKENIZER })
  const noReference = await measureTokenizerReference({ probes: PROBES, ask: async () => { throw new Error('reference endpoint down') } })
  const record = await precheck(target, noReference)
  assert.equal(record.outcome, 'inconclusive')
  assert.match(record.reason!, /no reference to compare with: the reference could not be asked: reference endpoint down/)
  assert.equal(target.contents.length, 0)
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))

  // The second round's reference is missing: a mismatch needs every round, so the first is not asked either.
  const partial = await measuredReference()
  partial.rounds[1] = { asks: [], delta: null, failure: 'the reference did not agree with itself (10, 11)' }
  const cheater = seller({ usage: OTHER_TOKENIZER })
  const undecided = await precheck(cheater, partial)
  assert.equal(undecided.outcome, 'inconclusive')
  assert.match(undecided.reason!, /no reference to compare with: the reference did not agree with itself \(10, 11\)/)
  assert.equal(cheater.contents.length, 0)
  assert.doesNotThrow(() => validateTokenizerPrecheck(undecided))
  // Stored with the first round asked anyway, it is not what the run writes.
  const asked = await precheck(seller({ usage: OTHER_TOKENIZER }))
  assert.throws(() => validateTokenizerPrecheck({ ...undecided, rounds: [{ ...undecided.rounds[0]!, seller: asked.rounds[0]!.seller }, ...undecided.rounds.slice(1)] }), /asked after the check had ended/)
})

test('a stored pre-check that does not follow from its signed responses is refused', async () => {
  const record = await precheck(seller({ usage: OTHER_TOKENIZER }))
  const edit = (change: (copy: TokenizerPrecheckV1) => void): TokenizerPrecheckV1 => {
    const copy = structuredClone(record)
    change(copy)
    return copy
  }
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[1]!.seller[0]!.probed!.signedInputTokens! += 30 })), /not the ones in its signed responses/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[1]!.seller[1]!.delta! += 30 })), /difference does not follow/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[2]!.reference.delta! -= 40 })), /reference difference does not follow/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[0]!.seller[0]!.base.responseAuth!.status = 'invalid' })), /not the ones in its signed responses/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rule = { ...copy.rule, toleranceTokens: 1 } })), /unknown rule/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rule = { ...copy.rule, id: 'tokenizer-precheck-v0' } })), /unknown rule/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[0]!.b = ' it\'s not guarded' })), /probe guard refuses/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.outcome = 'match' })), /outcome match does not follow/)
  // A mismatch claimed on two rounds, or on rounds asked once: shapes the run never writes.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[2]!.seller = []; delete copy.crowd })), /round 3: the seller was not asked a round the check had not ended before/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[2]!.seller.pop(); delete copy.crowd })), /round 3: the seller was asked fewer times than the rule asks/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[2]!.seller.pop() })), /round 3: the seller was asked fewer times than the rule asks/)
  // One signed pair counted as both asks of a round, or a fourth round.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[0]!.seller[1] = copy.rounds[0]!.seller[0]! })), /counts one request more than once/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[1]!.seller[0]!.probed!.requestIds = [...copy.rounds[1]!.seller[0]!.base.requestIds] })), /counts one request more than once/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => {
    const third = structuredClone(copy.rounds[0]!.seller[0]!)
    third.base.requestIds = ['third-base']
    third.probed!.requestIds = ['third-probed']
    copy.rounds[0]!.seller.push(third)
  })), /asked more often than the rule allows/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds.push({ ...copy.rounds[0]!, seller: [] }) })), /more rounds than its rule/)
  // A reference that reported cached input, or answered from two providers, stored as a clean one.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[0]!.reference.asks[1]!.cachedInput = true })), /reference difference does not follow/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rounds[0]!.reference.asks[1]!.providers = ['Provider-B', 'Provider-B'] })), /reference difference does not follow/)
  // A crowd whose tallies are not its differences', that leaves the seller out, or that is dropped.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.agree += 1 })), /crowd does not follow from its differences/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.corroborated = false })), /crowd does not follow from its differences/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => {
    copy.crowd = tokenizerCrowd([copy.rounds[0]!.reference.delta, copy.rounds[0]!.reference.delta], copy.rounds[0]!.reference.delta!)
  })), /crowd leaves out the seller's own difference/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { delete copy.crowd })), /outcome mismatch does not follow from its rounds \(inconclusive\)/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => {
    copy.crowd = tokenizerCrowd([copy.rounds[0]!.seller[0]!.delta], copy.rounds[0]!.reference.delta!)
  })), /outcome mismatch does not follow from its rounds \(inconclusive\)/)
  const honest = await precheck(seller({ usage: MODEL_TOKENIZER }))
  assert.throws(() => validateTokenizerPrecheck({ ...honest, outcome: 'mismatch' }), /outcome mismatch does not follow/)
  assert.throws(() => validateTokenizerPrecheck({ ...honest, crowd: record.crowd! }), /stores a crowd for a seller that was not off in every round/)
})

test('a stored pre-check whose signed exchanges asked other text than its probes is refused', async () => {
  const record = await precheck(seller({ usage: OTHER_TOKENIZER }))
  assert.equal(record.outcome, 'mismatch')
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
  // Other probes of the same lengths: a tokenizer that counts by length signs the same differences for them, so only
  // the text the seller was asked tells these exchanges apart from the probes the record names.
  const otherProbes = PROBES.map((probe) => ({ a: probe.a.replace(/e/g, 'o'), b: probe.b.replace(/e/g, 'o') }))
  assert.ok(otherProbes.every((probe, index) => probe.b !== PROBES[index]!.b && isSafeProbe(probe.b)))
  const otherReference = await measureTokenizerReference({ ask: referenceAsk(), probes: otherProbes })
  const other = await precheck(seller({ usage: OTHER_TOKENIZER }), otherReference)
  assert.equal(other.outcome, 'mismatch')
  assert.deepEqual(other.rounds.map((round) => round.seller.map((ask) => ask.delta)), record.rounds.map((round) => round.seller.map((ask) => ask.delta)))
  const swapped = (change: (copy: TokenizerPrecheckV1) => void): TokenizerPrecheckV1 => {
    const copy = structuredClone(record)
    change(copy)
    return copy
  }
  // A repeated ask of a round that is a signed exchange for another text.
  assert.throws(() => validateTokenizerPrecheck(swapped((copy) => { copy.rounds[1]!.seller[1] = structuredClone(other.rounds[1]!.seller[1]!) })),
    /round 2: the seller's signed request is not the round's text/)
  // The first ask's request with the follow-up, from another text.
  assert.throws(() => validateTokenizerPrecheck(swapped((copy) => { copy.rounds[0]!.seller[0]!.probed = structuredClone(other.rounds[0]!.seller[0]!.probed) })),
    /round 1: the seller's signed request is not the round's text/)
  // A round's base request, signed for another text.
  assert.throws(() => validateTokenizerPrecheck(swapped((copy) => {
    const ask = copy.rounds[2]!.seller[0]!
    ask.base = structuredClone(other.rounds[2]!.seller[0]!.base)
  })), /round 3: the seller's signed request is not the round's text/)
  // A backing seller whose signed pair is for another first-round text than this record's.
  const backer = await backingAsk(otherReference, record.crowd!.backers[0]!.peerId)
  assert.equal(backer.ask.delta, record.crowd!.backers[0]!.ask.delta)
  assert.throws(() => validateTokenizerPrecheck(swapped((copy) => { copy.crowd!.backers[0] = backer })),
    /backing seller 1: its signed request is not the first round's text/)
})

test('a stored pre-check whose signed request holds the round\'s text and other input is refused, in every shape', async () => {
  const record = await precheck(seller({ usage: OTHER_TOKENIZER }))
  assert.equal(record.outcome, 'mismatch')
  const text = PROBES[0]!.a + PROBES[0]!.b
  // The first round's request with the follow-up, its signed bytes swapped for `body`.
  const asked = (body: Record<string, unknown>): TokenizerPrecheckV1 => {
    const copy = structuredClone(record)
    const request = copy.rounds[0]!.seller[0]!.probed!
    request.responseAuth!.signedPreimages!.requestBase64 = signedRequestBase64(request.responseAuth!.requestId!, new TextEncoder().encode(JSON.stringify(body)))
    return copy
  }
  const user = { role: 'user', content: text }
  // The round's text alone, in each shape the buyer proxy translates to: Chat, Messages text blocks, Responses.
  for (const body of [
    { model: 'm', messages: [user], max_tokens: 64 },
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }], max_tokens: 64 },
    { model: 'm', input: text, max_output_tokens: 64 },
    { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], max_output_tokens: 64 },
    // Members the proxy adds when it translates: none of them is input the model counts.
    { model: 'm', messages: [user], max_tokens: 64, stream: true, stream_options: { include_usage: true }, prompt_cache_key: 'k', metadata: { user_id: 'u' }, user: 'u', temperature: 1 },
  ]) assert.doesNotThrow(() => validateTokenizerPrecheck(asked(body)), JSON.stringify(body))
  const refused = /round 1: the seller's signed request is not the round's text/
  const shapes: Array<[string, Record<string, unknown>]> = [
    ['a system turn', { model: 'm', messages: [{ role: 'system', content: 'Be brief.' }, user] }],
    ['a developer turn', { model: 'm', messages: [{ role: 'developer', content: 'Be brief.' }, user] }],
    ['an assistant turn', { model: 'm', messages: [user, { role: 'assistant', content: 'ok' }] }],
    ['a top-level system', { model: 'm', system: 'Be brief.', messages: [user] }],
    ['a top-level system as blocks', { model: 'm', system: [{ type: 'text', text: 'Be brief.' }], messages: [user] }],
    ['Responses instructions', { model: 'm', instructions: 'Be brief.', input: text }],
    ['tools', { model: 'm', messages: [user], tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }],
    ['a non-text part beside the text', { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] }],
    ['the text split over two parts', { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: PROBES[0]!.a }, { type: 'text', text: PROBES[0]!.b }] }] }],
    ['a second user turn', { model: 'm', messages: [user, user] }],
    ['an earlier response it continues', { model: 'm', previous_response_id: 'resp_1', input: text }],
    // Any member not known to add nothing: a response schema, a Responses text format, Messages output config, MCP
    // servers, a turn's name.
    ['a response schema', { model: 'm', messages: [user], response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } } }],
    ['a Responses text format', { model: 'm', input: text, text: { format: { type: 'json_schema', name: 'x', schema: { type: 'object' } } } }],
    ['Messages output config', { model: 'm', messages: [user], output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } }],
    ['MCP servers', { model: 'm', messages: [user], mcp_servers: [{ type: 'url', url: 'https://mcp.example.com', name: 'x' }] }],
    ['a turn with a name', { model: 'm', messages: [{ ...user, name: 'Example User' }] }],
    // A text part may carry only its type, its text and a cache breakpoint: any other member may be input too.
    ['a text part with a member besides its text', { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text, citations: [{ type: 'text', text: 'more input' }] }] }] }],
    ['a Responses text part with a member besides its text', { model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text, annotations: [{ type: 'text', text: 'more input' }] }] }] }],
  ]
  for (const [shape, body] of shapes) assert.throws(() => validateTokenizerPrecheck(asked(body)), refused, shape)
})

test('a stored pre-check is asked as the run asks: nothing after the ask that ended it', async () => {
  // An unreadable first ask ends the check; a matching second ask after it is not what the run writes.
  const unreadable = await precheck(seller({ usage: (content, call) => (call <= 2 ? null : MODEL_TOKENIZER(content)) }))
  assert.equal(unreadable.outcome, 'inconclusive')
  assert.equal(unreadable.rounds[0]!.seller.length, 1)
  assert.doesNotThrow(() => validateTokenizerPrecheck(unreadable))
  const matched = await precheck(seller({ usage: MODEL_TOKENIZER }))
  const appended = structuredClone(unreadable)
  appended.rounds[0]!.seller.push(matched.rounds[0]!.seller[0]!)
  appended.outcome = 'match'
  appended.reason = null
  assert.throws(() => validateTokenizerPrecheck(appended), /round 1: the seller was asked after the check had ended/)
  // A match ends it too: a later round answered after it (signed for that round's own text) does not stand.
  const secondFirst = await measureTokenizerReference({ ask: referenceAsk(), probes: [PROBES[1]!, PROBES[0]!, PROBES[2]!] })
  const secondAsked = await precheck(seller({ usage: MODEL_TOKENIZER }), secondFirst)
  const later = structuredClone(matched)
  later.rounds[1]!.seller = structuredClone(secondAsked.rounds[0]!.seller)
  assert.throws(() => validateTokenizerPrecheck(later), /round 2: the seller was asked after the check had ended/)
})

test('a pre-check DIFF holds the signed pair of another seller on the reference\'s count, and submit checks it', async () => {
  const record = await precheck(seller({ usage: OTHER_TOKENIZER }), undefined, { backers: 2 })
  assert.equal(record.outcome, 'mismatch')
  assert.equal(record.crowd!.backers.length, 2)
  for (const backer of record.crowd!.backers) {
    assert.equal(backer.ask.delta, record.rounds[0]!.reference.delta)
    assert.equal(backer.ask.base.responseAuth!.record!.sellerPeerId, backer.peerId)
  }
  assert.doesNotThrow(() => validateTokenizerPrecheck(record, PEER_ID))
  const edit = (change: (copy: TokenizerPrecheckV1) => void): TokenizerPrecheckV1 => {
    const copy = structuredClone(record)
    change(copy)
    return copy
  }
  // A tally of backers without their signed pairs.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.backers.pop() })), /counts 2 seller\(s\) on the reference's count but holds the signed answers of 1/)
  // The audited seller, or one seller twice, backing the reference.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.backers[0]!.peerId = PEER_ID }), PEER_ID), /backing seller 1 is the audited seller or another backing seller/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.backers[1]!.peerId = `0x${copy.crowd!.backers[0]!.peerId.toUpperCase()}` })), /backing seller 2 is the audited seller or another backing seller/)
  // A pair signed by another peer than the one named.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.backers[0]!.peerId = BACKER_ID })), /backing seller 1: its responses are not signed by it/)
  // Counts that are not the signed bytes', a cache flag dropped, a difference that is not the reference's.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.backers[0]!.ask.probed!.signedInputTokens! += 30 })), /backing seller 1: its input tokens are not the ones in its signed responses/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.backers[0]!.ask.delta! += 30 })), /backing seller 1 does not sign the reference's count/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.crowd!.backers[0]!.ask.probed = null })), /backing seller 1 has no signed pair/)
  // One backer's pair counted as the other's, or as the seller's own request.
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => {
    copy.crowd!.backers[1]!.ask = structuredClone(copy.crowd!.backers[0]!.ask)
    for (const request of [copy.crowd!.backers[1]!.ask.base, copy.crowd!.backers[1]!.ask.probed!]) request.responseAuth!.record!.sellerPeerId = copy.crowd!.backers[1]!.peerId
  })), /backing seller 2: counts a request more than once/)
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => {
    copy.crowd!.backers[0]!.ask.base.requestIds = [...copy.rounds[0]!.seller[0]!.base.requestIds]
  })), /backing seller 1: counts a request more than once/)
})

// ── the model's sellers against the reference ────────────────────────────────────────────────────

test('the rule counts exactly: one token off is off, two asks one token apart are unstable, and only the exact count backs the reference', () => {
  assert.deepEqual([TOKENIZER_PRECHECK_RULE.id, TOKENIZER_PRECHECK_RULE.toleranceTokens, TOKENIZER_PRECHECK_RULE.sameCacheCancels], ['tokenizer-precheck-v1', 0, true])
  assert.equal(tokenizerPrecheckRuleById('tokenizer-precheck-v1'), TOKENIZER_PRECHECK_RULE)
  assert.equal(tokenizerPrecheckRuleById('tokenizer-precheck-v2'), undefined, 'an id this CLI does not know')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [100] }), 'match')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [101] }), 'unmeasured', 'one token off is no match: it is asked again')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [101, 101] }), 'off')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [101, 102] }), 'unstable', 'two asks one token apart are no one answer')
  const off = { referenceDelta: 100, sellerDeltas: [101, 101] }
  assert.equal(judgeTokenizerPrecheck([off, off, off]), 'mismatch', 'still every round off')
  assert.equal(judgeTokenizerPrecheck([off, off]), 'inconclusive')
  assert.equal(judgeTokenizerPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [100] }]), 'match')
  // Only the exact count backs the reference, and only one same count is a group.
  assert.equal(tokenizerCrowd([119, 120], 119).agree, 1)
  assert.equal(tokenizerCrowd([131, 132, 119], 119).outvoted, false, 'two counts one token apart are no group')
  assert.equal(tokenizerCrowd([132, 132, 119], 119).outvoted, true)
})

test('a seller one token off the model is a mismatch; a tolerance of 2 tokens would have let it match', async () => {
  const oneOff = () => seller({ usage: (content) => 1 + MODEL_TOKENIZER(content) + (content.length > 40 ? 1 : 0) })
  const tolerant = await precheck(oneOff(), undefined, { rule: TOLERANT })
  assert.equal(tolerant.outcome, 'match')
  const exact = await precheck(oneOff())
  assert.deepEqual([exact.rule.id, exact.outcome], [TOKENIZER_PRECHECK_RULE.id, 'mismatch'])
  assert.doesNotThrow(() => validateTokenizerPrecheck(exact))
})

test('sellers outvote the reference when two or more agree on another count and outnumber those on the reference\'s', () => {
  const crowd = (deltas: Array<number | null>) => {
    const { deltas: _deltas, requests: _requests, backers: _backers, ...tally } = tokenizerCrowd(deltas, 119, TOLERANT)
    return tally
  }
  // Under a tolerance of 2 tokens. The reference endpoint counts 119; thirteen sellers sign 132, two sign the reference's count.
  assert.deepEqual(crowd([...new Array<number>(13).fill(132), 119, 120, null, 740]), { measured: 16, agree: 2, largestGroup: 13, groupDelta: 132, corroborated: true, outvoted: true })
  // Sellers within the tolerance of each other are one group.
  assert.equal(crowd([131, 132, 133, 119]).outvoted, true)
  assert.equal(crowd([130, 133, 136, 119]).outvoted, false, 'three different counts are no group')
  // Honest sellers outnumber a group that signs another count: the group is what is wrong.
  assert.deepEqual(crowd([132, 132, 132, 119, 119, 119, 118]), { measured: 7, agree: 4, largestGroup: 3, groupDelta: 132, corroborated: true, outvoted: false })
  assert.equal(crowd([132, 132, 132, 119, 119, 119]).outvoted, false, 'a tie stays with the reference')
  // Two honest sellers outvote a wrong reference that one other seller shares (a reseller of its host).
  assert.deepEqual(crowd([132, 132, 119]), { measured: 3, agree: 1, largestGroup: 2, groupDelta: 132, corroborated: true, outvoted: true })
  assert.deepEqual(crowd([132, 132]), { measured: 2, agree: 0, largestGroup: 2, groupDelta: 132, corroborated: false, outvoted: true })
  // A lone seller off the reference never outvotes it, and one seller on the reference's count backs it.
  assert.deepEqual(crowd([132, 119]), { measured: 2, agree: 1, largestGroup: 1, groupDelta: 132, corroborated: true, outvoted: false })
  assert.equal(crowd([132, 132, 119, 119]).outvoted, false, 'a tie stays with the reference')
  assert.deepEqual(crowd([132]), { measured: 1, agree: 0, largestGroup: 1, groupDelta: 132, corroborated: false, outvoted: false })
  assert.deepEqual(crowd([null, null]), { measured: 0, agree: 0, largestGroup: 0, groupDelta: null, corroborated: false, outvoted: false })
  // The stored differences are in ascending order with the unreadable ones last, so no seller can be told by its place.
  assert.deepEqual(tokenizerCrowd([132, null, 119, 121], 119, TOLERANT).deltas, [119, 121, 132, null])
})

/** A seller's audit clock driven by `signal` alone: what a test's audit deadline looks like to the pre-check. */
function clockOf(signal: AbortSignal | undefined): SellerClock | undefined {
  return signal ? { signal, start: () => signal, finish: () => undefined } : undefined
}

/**
 * A model's sellers behind one buyer proxy: each signs the count its `usage` gives for a request (null: a response
 * without usage; an object: that usage; 'down': the request fails), possibly after a wait. `listed` are the
 * sellers the run knows of, every one by default.
 */
function market(
  sellers: Record<string, (content: string) => number | null | 'down' | Record<string, unknown> | Promise<number | null | 'down'>>,
  listed?: Array<{ peerId: string; service: string }>,
  options: { crowdTimeLimitMs?: number; authDelayMs?: Record<string, number> } = {},
) {
  const peers = Object.keys(sellers)
  const signed = new Map<string, number | null | Record<string, unknown>>()
  const asked = new Map<string, string[]>(peers.map((peer) => [peer, []]))
  const bodies = new Map<string, Uint8Array>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
    bodies.set(requestId, init!.body as Uint8Array)
    const peer = headers.get('x-antseed-pin-peer')!
    const content = (JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as { messages: Array<{ content: string }> }).messages[0]!.content
    asked.get(peer)!.push(content)
    const usage = await sellers[peer]!(content)
    if (usage === 'down') return new Response('unavailable', { status: 402 })
    signed.set(requestId, usage)
    return Response.json({}, {
      headers: {
        'x-antseed-request-id': requestId,
        'x-antseed-input-tokens': '100',
        'x-antseed-output-tokens': '10',
        'x-antseed-total-tokens': '110',
        'x-antseed-input-usd-per-million': '1',
        'x-antseed-output-usd-per-million': '2',
        'x-antseed-estimated-cost-usd': '0.00012',
      },
    })
  }
  const responseAuthReader: ResponseAuthReader = {
    async waitForVerified(input) {
      // A seller whose ResponseAuth comes late: its answer has arrived and is priced before it is authenticated.
      const delay = options.authDelayMs?.[input.sellerPeerId]
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      const tokens = signed.get(input.requestId)
      const usage = tokens === null || tokens === undefined ? {} : { usage: typeof tokens === 'number' ? { prompt_tokens: tokens } : tokens }
      return {
        requestId: input.requestId,
        status: 'verified',
        responseAuth: signedRecord(input),
        signedPreimages: {
          encoding: 'antseed-http-codec-v1',
          signatureEncoding: 'antseed-response-auth-signing-v1',
          requestBase64: signedRequestBase64(input.requestId, bodies.get(input.requestId)),
          responseBase64: Buffer.from(encodeHttpResponse({
            requestId: input.requestId, statusCode: 200, headers: {},
            body: new TextEncoder().encode(JSON.stringify(usage)),
          })).toString('base64'),
          responseAuthSigningBase64: 'AA==',
          requestHash: `0x${'44'.repeat(32)}`,
          responseHash: `0x${'55'.repeat(32)}`,
        },
        failureReason: null,
      }
    },
    close() {},
  }
  let referenceAsks = 0
  const unbacked: Array<{ outvoted: boolean; largestGroup: number; agree: number; referenceDelta: number }> = []
  const screen = createTokenizerPrecheckScreen<null>({
    sellers: listed ?? peers.map((peerId) => ({ peerId, service: SERVICE })),
    proxyBaseUrl: 'http://127.0.0.1:8390',
    responseAuthReader,
    limiter: new ConcurrencyLimiter(4),
    fetchFn,
    ...(options.crowdTimeLimitMs ? { crowdTimeLimitMs: options.crowdTimeLimitMs } : {}),
    onUnbacked: (crowd, referenceDelta) => unbacked.push({ outvoted: crowd.outvoted, largestGroup: crowd.largestGroup, agree: crowd.agree, referenceDelta }),
    reference: async () => {
      referenceAsks += 1
      return measuredReference()
    },
  })
  const check = (peerId: string, signal?: AbortSignal) => screen.check({ peerId, service: SERVICE }, null, clockOf(signal))
  const requests = (peerId: string): number => asked.get(peerId)!.length
  return { check, asked, requests, unbacked, referenceAsks: () => referenceAsks }
}

test('a seller that matches costs two requests, and no other seller of the model is asked for it', async () => {
  const sellers = market({ a: MODEL_TOKENIZER, b: MODEL_TOKENIZER, c: OTHER_TOKENIZER })
  const record = await sellers.check('a')
  assert.equal(record.outcome, 'match')
  assert.equal(record.crowd, undefined)
  assert.deepEqual([sellers.requests('a'), sellers.requests('b'), sellers.requests('c')], [2, 0, 0])
  assert.equal(tokenizerPrecheckRequestCount(record), 2)
})

test('when most of a model\'s sellers sign one count that is not the reference\'s, the reference is wrong and nobody is a mismatch', async () => {
  // The reference endpoint serves a newer build with another tokenizer; the sellers run the model as released.
  const released = tokenizer(3.2)
  const sellers = market({ a: released, b: released, c: (content) => 400 + released(content), d: released, late: MODEL_TOKENIZER })
  // The run audits one seller only (a retry, a confirmation, `--peer`): the crowd is still every seller of the model.
  const record = await sellers.check('a')
  assert.equal(record.outcome, 'inconclusive')
  assert.match(record.reason!, /^4 of the model's sellers sign \d+ input tokens where the reference counts \d+ and 1 sign the reference's count: the reference is not the model they serve$/)
  const own = record.rounds[0]!.seller[0]!.delta!
  assert.deepEqual(
    [record.crowd!.measured, record.crowd!.agree, record.crowd!.largestGroup, record.crowd!.groupDelta, record.crowd!.corroborated, record.crowd!.outvoted],
    [5, 1, 4, own, true, true],
  )
  assert.deepEqual(record.crowd!.deltas, [record.rounds[0]!.reference.delta, own, own, own, own].sort((left, right) => left! - right!))
  // Its own rounds were all off, twice each: only the crowd keeps it from a mismatch, and the evidence says so.
  assert.deepEqual(record.rounds.map((round) => round.seller.length), [2, 2, 2])
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
  assert.throws(() => validateTokenizerPrecheck({ ...record, crowd: { ...record.crowd!, outvoted: false } }), /crowd does not follow from its differences/)
  // The four other sellers were asked the first round's pair once, and those eight requests are this check's.
  assert.deepEqual(['a', 'b', 'c', 'd', 'late'].map(sellers.requests), [12, 2, 2, 2, 2])
  assert.equal(record.crowd!.requests.length, 8)
  assert.equal(tokenizerPrecheckRequestCount(record), 20)
  assert.equal(tokenizerPrecheckCost(record).pricedExchangeCount, 20)
  // Another seller of the run gets the same answer from the asks already made, and the reference was measured
  // once. Its own check asks its own requests: the pair the crowd sent it was paid for by the first check.
  const next = await sellers.check('c')
  assert.equal(next.outcome, 'inconclusive')
  assert.equal(next.crowd!.requests.length, 0)
  assert.equal((await sellers.check('late')).outcome, 'match')
  assert.equal(sellers.referenceAsks(), 1)
  assert.deepEqual(['a', 'b', 'c', 'd', 'late'].map(sellers.requests), [12, 2, 14, 2, 4])
  // The run is told once, however many sellers the reference is outvoted for.
  assert.deepEqual(sellers.unbacked, [{ outvoted: true, largestGroup: 4, agree: 1, referenceDelta: record.rounds[0]!.reference.delta }])
})

test('two honest sellers of a model whose reference is wrong are not a mismatch, even when a third seller shares the reference', async () => {
  // Both agree with each other in every ask, and nobody signs the reference's count.
  const released = tokenizer(3.2)
  const sellers = market({ a: released, b: (content) => 35 + released(content) })
  for (const peer of ['a', 'b']) {
    const record = await sellers.check(peer)
    assert.equal(record.outcome, 'inconclusive')
    assert.match(record.reason!, /^2 of the model's sellers sign \d+ input tokens where the reference counts \d+ and 0 sign the reference's count/)
    assert.deepEqual([record.crowd!.agree, record.crowd!.largestGroup, record.crowd!.corroborated, record.crowd!.outvoted], [0, 2, false, true])
    assert.doesNotThrow(() => validateTokenizerPrecheck(record))
  }
  assert.deepEqual(sellers.unbacked.map((told) => told.outvoted), [true])

  // A third seller resells the reference's own host and signs its count: the two honest sellers still outvote it.
  const shared = market({ a: released, b: (content) => 35 + released(content), reseller: MODEL_TOKENIZER })
  for (const peer of ['a', 'b']) {
    const record = await shared.check(peer)
    assert.equal(record.outcome, 'inconclusive')
    assert.deepEqual([record.crowd!.agree, record.crowd!.largestGroup, record.crowd!.corroborated, record.crowd!.outvoted], [1, 2, true, true])
    assert.equal(record.crowd!.backers.length, 1)
    assert.doesNotThrow(() => validateTokenizerPrecheck(record))
  }
})

test('a seller off the reference is a mismatch when the model\'s other sellers sign the reference\'s count', async () => {
  const sellers = market({
    honest1: MODEL_TOKENIZER, honest2: (content) => 90 + MODEL_TOKENIZER(content), honest3: MODEL_TOKENIZER,
    // Two sellers reselling one upstream that serves another model, and one on its own.
    resold1: OTHER_TOKENIZER, resold2: OTHER_TOKENIZER, other: tokenizer(3),
    silent: () => null,
  })
  const resold = await sellers.check('resold1')
  assert.equal(resold.outcome, 'mismatch')
  assert.equal(resold.reason, null)
  assert.deepEqual(
    [resold.crowd!.deltas.length, resold.crowd!.measured, resold.crowd!.agree, resold.crowd!.largestGroup, resold.crowd!.groupDelta, resold.crowd!.corroborated, resold.crowd!.outvoted],
    [7, 6, 3, 2, resold.rounds[0]!.seller[0]!.delta, true, false],
  )
  assert.match(describeTokenizerMismatch(resold), /while 3 of the model's other sellers signed the model's count/)
  assert.doesNotThrow(() => validateTokenizerPrecheck(resold))
  // Five sellers signed the pair; the silent one was asked its first request twice and never the second.
  assert.equal(resold.crowd!.requests.length, 11)
  assert.equal(resold.crowd!.requests.reduce((total, request) => total + request.requestCount, 0), 12)
  assert.equal(tokenizerPrecheckRequestCount(resold), 12 + 12)
  const other = await sellers.check('other')
  assert.equal(other.outcome, 'mismatch')
  const honest = await sellers.check('honest2')
  assert.equal(honest.outcome, 'match')
  assert.equal(honest.crowd, undefined)
  assert.deepEqual(sellers.unbacked, [])
  // A seller that could not be read for one check is asked again for the next; the others once.
  assert.deepEqual(
    ['honest1', 'honest2', 'honest3', 'resold1', 'resold2', 'other', 'silent'].map(sellers.requests),
    [2, 4, 2, 12, 2, 14, 4],
  )
})

test('two sellers checked at once share the crowd\'s asks', async () => {
  const sellers = market({ honest1: MODEL_TOKENIZER, honest2: MODEL_TOKENIZER, off1: OTHER_TOKENIZER, off2: tokenizer(3) })
  const [first, second] = await Promise.all([sellers.check('off1'), sellers.check('off2')])
  assert.deepEqual([first.outcome, second.outcome], ['mismatch', 'mismatch'])
  assert.deepEqual([sellers.requests('honest1'), sellers.requests('honest2'), sellers.requests('off1'), sellers.requests('off2')], [2, 2, 12, 12])
  // Each crowd request is counted in one check only.
  assert.equal(first.crowd!.requests.length + second.crowd!.requests.length, 4)
  for (const record of [first, second]) assert.doesNotThrow(() => validateTokenizerPrecheck(record))
})

test('a crowd ask that fails, or is stopped, is not measured: it neither backs the reference nor votes against it', async () => {
  // The only seller on the reference's count refuses the request.
  const refusing = market({ off: OTHER_TOKENIZER, honest: () => 'down' })
  const undecided = await refusing.check('off')
  assert.equal(undecided.outcome, 'inconclusive')
  assert.deepEqual([undecided.crowd!.deltas.length, undecided.crowd!.measured, undecided.crowd!.agree, undecided.crowd!.corroborated], [2, 1, 0, false])
  assert.match(undecided.reason!, /\(1 of 2 could be read, this one included\)/)
  assert.doesNotThrow(() => validateTokenizerPrecheck(undecided))

  // The audit stops while the crowd is asked: the answers that come after count for nothing, nothing more is
  // sent, and nothing is decided.
  const deadline = new AbortController()
  const slowly = async (content: string): Promise<number> => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    return MODEL_TOKENIZER(content)
  }
  const sellers = market({
    off: (content) => {
      if (sellers.requests('off') === 12) setTimeout(() => deadline.abort(), 10)
      return OTHER_TOKENIZER(content)
    },
    honest1: slowly, honest2: slowly,
  })
  const stopped = await sellers.check('off', deadline.signal)
  assert.equal(stopped.outcome, 'inconclusive')
  assert.match(stopped.reason!, /^the audit was stopped while the model's other sellers were asked$/)
  assert.equal(stopped.crowd, undefined)
  assert.deepEqual([sellers.requests('honest1'), sellers.requests('honest2')], [1, 1], 'the first request each, and not the second')
  assert.doesNotThrow(() => validateTokenizerPrecheck(stopped))
  // The next check asks them: a stopped ask is not kept as their answer.
  assert.equal((await sellers.check('off')).outcome, 'mismatch')
  assert.deepEqual([sellers.requests('honest1'), sellers.requests('honest2')], [3, 3])
})

test('a check whose audit stops while it waits for another check\'s ask is no mismatch, whatever that ask says later', async () => {
  // The only seller on the reference's count answers its own first ask late. Another check, off in every round,
  // waits on that same ask for its crowd, and its audit stops before the answer comes.
  let release: () => void = () => undefined
  const late = new Promise<void>((resolve) => { release = resolve })
  const deadline = new AbortController()
  const sellers = market({
    honest: async (content) => { await late; return MODEL_TOKENIZER(content) },
    off: (content) => {
      if (sellers.requests('off') === 12) setTimeout(() => { deadline.abort(); setTimeout(release, 20) }, 20)
      return OTHER_TOKENIZER(content)
    },
  })
  const honest = sellers.check('honest')
  const off = await sellers.check('off', deadline.signal)
  assert.equal(off.outcome, 'inconclusive')
  assert.match(off.reason!, /the audit was stopped while the model's other sellers were asked/)
  assert.equal(off.crowd, undefined)
  assert.equal((await honest).outcome, 'match')
  assert.equal(sellers.requests('honest'), 2, 'asked once, by its own check')
})

test('a crowd vote whose pair reports cached input that does not cancel neither backs the reference nor helps outvote it', async () => {
  // A cached amount that moves with the text: the two answers of a pair report different amounts.
  const cached = (tokens: number) => ({ prompt_tokens: tokens, prompt_tokens_details: { cached_tokens: tokens } })
  // The only other seller on the reference's count reports a cache hit: nothing backs the reference.
  const unbacked = market({ off: OTHER_TOKENIZER, honest: (content) => cached(MODEL_TOKENIZER(content)) })
  const alone = await unbacked.check('off')
  assert.equal(alone.outcome, 'inconclusive')
  assert.deepEqual([alone.crowd!.measured, alone.crowd!.agree, alone.crowd!.corroborated, alone.crowd!.backers.length], [1, 0, false, 0])
  assert.doesNotThrow(() => validateTokenizerPrecheck(alone))
  // Two sellers on the off seller's count with cache hits do not outvote the one clean seller on the reference's.
  const outvoting = market({
    off: OTHER_TOKENIZER, copy1: (content) => cached(OTHER_TOKENIZER(content)), copy2: (content) => cached(OTHER_TOKENIZER(content)), honest: MODEL_TOKENIZER,
  })
  const record = await outvoting.check('off')
  assert.equal(record.outcome, 'mismatch')
  assert.deepEqual([record.crowd!.measured, record.crowd!.agree, record.crowd!.largestGroup, record.crowd!.outvoted], [2, 1, 1, false])
  assert.doesNotThrow(() => validateTokenizerPrecheck(record, 'off'))
  // A cached vote is asked again by the next check that needs the crowd.
  await outvoting.check('off')
  assert.deepEqual([outvoting.requests('copy1'), outvoting.requests('honest')], [4, 2])
})

test('a pair whose two answers report the same cached amount is kept, for the reference, the seller and the crowd', async () => {
  // The pair helper: equal, non-empty cache members cancel; one side only, or different amounts, do not.
  const ask = (baseCache: Record<string, number> | undefined, probedCache: Record<string, number> | undefined) => ({
    base: { cachedInput: baseCache !== undefined, ...(baseCache ? { cache: baseCache } : {}) },
    probed: { cachedInput: probedCache !== undefined, ...(probedCache ? { cache: probedCache } : {}) },
  }) as never
  assert.equal(cacheBlocks(ask(undefined, undefined)), false, 'no cache, nothing to block')
  assert.equal(cacheBlocks(ask({ cached_tokens: 64 }, { cached_tokens: 64 })), false, 'the same amount cancels')
  assert.equal(cacheBlocks(ask({ cached_tokens: 64 }, { cached_tokens: 64 }), WITHOUT_SAME_CACHE), true, 'not without the rule\'s same-cache part')
  assert.equal(cacheBlocks(ask({ cached_tokens: 64 }, { cached_tokens: 70 })), true)
  assert.equal(cacheBlocks(ask({ cached_tokens: 64 }, undefined)), true)
  assert.equal(cacheBlocks({ base: { cachedInput: true }, probed: { cachedInput: true } } as never), true, 'a record from before the cache was kept never cancels')
  // The reference: every answer reports the same cached amount, which the count includes. The rule measures it; without its same-cache part it does not.
  const sameCached = (count = MODEL_TOKENIZER): TokenizerReferenceAsk => async (contents) => ({
    upstream: { name: 'referenceEndpoint' },
    results: contents.map((content) => ({ inputTokens: 7 + count(content), cachedInput: true, cache: { 'prompt_tokens_details.cached_tokens': 512 }, failure: null })),
  })
  const reference = await measureTokenizerReference({ ask: sameCached(), probes: PROBES })
  assert.ok(reference.rounds.every((round) => round.delta !== null), 'measured')
  const withoutSameCache = await measureTokenizerReference({ ask: sameCached(), probes: PROBES, rule: WITHOUT_SAME_CACHE })
  assert.ok(withoutSameCache.rounds.every((round) => round.delta === null && /cached input/.test(round.failure ?? '')), 'no measurement without it')
  // A seller on another tokenizer whose answers report the same cached amount: off in every round, a mismatch once the
  // model's other sellers back the reference, also with a cache of their own.
  const cachedUsage = (tokens: number) => ({ prompt_tokens: tokens, prompt_tokens_details: { cached_tokens: 512 } })
  const off = await precheck(seller({ usage: (content) => cachedUsage(7 + OTHER_TOKENIZER(content)) }), reference)
  assert.equal(off.outcome, 'mismatch')
  assert.deepEqual(off.rounds[0]!.seller[0]!.base.cache, { 'prompt_tokens_details.cached_tokens': 512 })
  assert.doesNotThrow(() => validateTokenizerPrecheck(off))
  // A seller that counts like the model, with the same cache: a match.
  const honest = await precheck(seller({ usage: (content) => cachedUsage(7 + MODEL_TOKENIZER(content)) }), reference)
  assert.equal(honest.outcome, 'match')
  assert.doesNotThrow(() => validateTokenizerPrecheck(honest))
  // A stored cache that is not the signed one is refused.
  const edited = structuredClone(off)
  edited.rounds[0]!.seller[0]!.base.cache = { 'prompt_tokens_details.cached_tokens': 600 }
  assert.throws(() => validateTokenizerPrecheck(edited), /not the ones in its signed responses/)
})

test('a reference whose counts stay while its cached amount moves is measured: its count includes the cache', async () => {
  const cached = (base: number, probed: number) => [{ 'prompt_tokens_details.cached_tokens': base }, { 'prompt_tokens_details.cached_tokens': probed }] as [Record<string, number>, Record<string, number>]
  const at = (baseTokens: number, probedTokens: number, cache: [Record<string, number>, Record<string, number>]) => asked(baseTokens, probedTokens, { cachedInput: true, cache })
  // Grok 4.7 on xAI, as stored: a cached prompt of the host's own on every answer, and more of A + B cached when the
  // text is asked again. The same counts on both asks.
  const grok = [at(1280, 1417, cached(1152, 1152)), at(1280, 1417, cached(1152, 1408))]
  assert.equal(cacheShownInCount(grok), true)
  assert.equal(referenceDelta(grok).delta, 137)
  // The cache of A moving shows it as well.
  assert.equal(referenceDelta([at(1289, 1436, cached(1152, 1152)), at(1289, 1436, cached(1280, 1152))]).delta, 147)
  // Not without the rule's part: the cache does not cancel within the second ask.
  assert.match(referenceDelta(grok, { ...TOKENIZER_PRECHECK_RULE, cacheShownInCount: undefined }).failure!, /reported cached input/)
  // A count that leaves the cache out moves with it (here by the 256 more tokens cached): no measurement.
  assert.equal(cacheShownInCount([at(1280, 1417, cached(1152, 1152)), at(1280, 1161, cached(1152, 1408))]), false)
  assert.match(referenceDelta([at(1280, 1417, cached(1152, 1152)), at(1280, 1161, cached(1152, 1408))]).failure!, /reported cached input/)
  // The same uneven cache on both asks shows nothing: a count that leaves it out is shifted the same way on each.
  assert.equal(cacheShownInCount([at(1280, 1417, cached(1152, 1280)), at(1280, 1417, cached(1152, 1280))]), false)
  assert.match(referenceDelta([at(1280, 1417, cached(1152, 1280)), at(1280, 1417, cached(1152, 1280))]).failure!, /reported cached input/)
  // Records without cache amounts, and a single ask, show nothing.
  assert.equal(cacheShownInCount([asked(26, 143, { cachedInput: true }), asked(26, 143, { cachedInput: true })]), false)
  assert.equal(cacheShownInCount([grok[0]!]), false)
  // Two providers are still refused.
  assert.match(referenceDelta([grok[0]!, { ...grok[1]!, providers: ['xAI', 'Other'] }]).failure!, /more than one provider/)

  // Measured end to end: a host whose hidden prompt is always cached and that caches more of a text asked again.
  let sent = 0
  const seen = new Map<string, number>()
  const movingCache: TokenizerReferenceAsk = async (contents) => ({
    upstream: { name: 'referenceEndpoint' },
    results: contents.map((content) => {
      sent += 1
      const times = (seen.get(content) ?? 0) + 1
      seen.set(content, times)
      return { inputTokens: 1240 + MODEL_TOKENIZER(content), cachedInput: true, cache: { 'prompt_tokens_details.cached_tokens': times > 1 ? 1280 : 1152 }, provider: 'xAI', failure: null }
    }),
  })
  const reference = await measureTokenizerReference({ ask: movingCache, probes: PROBES })
  assert.deepEqual(reference.rounds.map((round) => round.delta), PROBES.map(({ a, b }) => MODEL_TOKENIZER(a + b) - MODEL_TOKENIZER(a)))
  assert.equal(sent, PROBES.length * 4, 'each round asked once')
  // A seller is judged as before: one off the reference with a cache that does not cancel decides nothing.
  const cachedUsage = (tokens: number, amount: number) => ({ prompt_tokens: tokens, prompt_tokens_details: { cached_tokens: amount } })
  let asks = 0
  const off = await precheck(seller({ usage: (content) => cachedUsage(1240 + OTHER_TOKENIZER(content), ++asks % 2 === 0 ? 1280 : 1152) }), reference)
  assert.equal(off.outcome, 'inconclusive')
  assert.doesNotThrow(() => validateTokenizerPrecheck(off))
  const honest = await precheck(seller({ usage: (content) => cachedUsage(1240 + MODEL_TOKENIZER(content), 1152) }), reference)
  assert.equal(honest.outcome, 'match')
  assert.doesNotThrow(() => validateTokenizerPrecheck(honest))
})

test('a seller whose own first ask failed is asked again for a later crowd, and can back the reference then', async () => {
  let calls = 0
  const sellers = market({ honest: (content) => (++calls === 1 ? 'down' : MODEL_TOKENIZER(content)), off: OTHER_TOKENIZER })
  const first = await sellers.check('honest')
  assert.equal(first.outcome, 'inconclusive')
  assert.equal(sellers.requests('honest'), 1)
  const record = await sellers.check('off')
  assert.equal(record.outcome, 'mismatch')
  assert.equal(sellers.requests('honest'), 3)
  assert.equal(record.crowd!.backers[0]!.peerId, 'honest')
  assert.doesNotThrow(() => validateTokenizerPrecheck(record, 'off'))
})

test('checks that wait on one shared ask that measured nothing share one new ask of that seller', async () => {
  // The only seller on the reference's count refuses its own first ask, late; two off sellers' crowds wait on it.
  let calls = 0
  const sellers = market({
    honest: async (content) => {
      if (++calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        return 'down'
      }
      return MODEL_TOKENIZER(content)
    },
    off1: OTHER_TOKENIZER,
    off2: tokenizer(3),
  })
  const honest = sellers.check('honest')
  const [first, second] = await Promise.all([sellers.check('off1'), sellers.check('off2')])
  assert.deepEqual([first.outcome, second.outcome], ['mismatch', 'mismatch'])
  assert.equal((await honest).outcome, 'inconclusive')
  assert.equal(sellers.requests('honest'), 3, 'its own refused request, and one new pair for both checks')
  for (const record of [first, second]) assert.doesNotThrow(() => validateTokenizerPrecheck(record))
})

test('a crowd not complete within its time decides nothing, and what it already cost is kept', async () => {
  const late = (count: (content: string) => number) => async (content: string): Promise<number> => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    return count(content)
  }
  // A wrong reference that one seller shares answers at once; two honest sellers on the off seller's count answer
  // after the crowd's time. Their votes would outvote the reference, so the partial 1 against 1 decides nothing.
  const sellers = market({ off: OTHER_TOKENIZER, backer: MODEL_TOKENIZER, honest1: late(OTHER_TOKENIZER), honest2: late(OTHER_TOKENIZER) }, undefined, { crowdTimeLimitMs: 50 })
  const started = Date.now()
  const record = await sellers.check('off')
  assert.ok(Date.now() - started < 190, 'not waited past the crowd\'s time')
  assert.equal(record.outcome, 'inconclusive')
  assert.match(record.reason!, /^not every other seller of the model answered within 50ms, and the ones that did not could outvote the reference$/)
  assert.equal(record.crowd, undefined)
  // The backer's pair was answered and paid: it stays in the count and the cost. The two late sellers' first requests
  // were sent and not answered in time: they are counted as sent, with no cost known.
  assert.equal(record.crowdRequests!.length, 4)
  assert.equal(tokenizerPrecheckRequestCount(record), 16)
  assert.equal(tokenizerPrecheckCost(record).pricedExchangeCount, 14)
  assert.equal(tokenizerPrecheckCost(record).missingCostExchangeCount, 2)
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
  assert.throws(() => validateTokenizerPrecheck({ ...record, outcome: 'mismatch', reason: null }), /stores the requests of a crowd it does not leave undecided/)
  // A pair cut off by the crowd's time between its two requests: the first was answered and paid, so it is counted.
  let halfCalls = 0
  const half = async (content: string): Promise<number> => {
    halfCalls += 1
    if (halfCalls > 1) await new Promise((resolve) => setTimeout(resolve, 200))
    return OTHER_TOKENIZER(content)
  }
  const cut = await market({ off: OTHER_TOKENIZER, backer: MODEL_TOKENIZER, half }, undefined, { crowdTimeLimitMs: 50 }).check('off')
  assert.equal(cut.outcome, 'inconclusive')
  assert.equal(cut.crowdRequests!.length, 4, 'the backer\'s pair, and both requests of the pair that was cut off')
  assert.equal(tokenizerPrecheckRequestCount(cut), 16)
  assert.equal(tokenizerPrecheckCost(cut).pricedExchangeCount, 15, 'the first request of the pair was answered and priced; the second was still out')
  assert.doesNotThrow(() => validateTokenizerPrecheck(cut))
  // An answer that had arrived when the crowd's time ran out, its ResponseAuth still awaited: it was paid for, so its
  // cost is counted although the request had not ended.
  const awaited = await market({ off: OTHER_TOKENIZER, backer: MODEL_TOKENIZER, slow: OTHER_TOKENIZER }, undefined, { crowdTimeLimitMs: 50, authDelayMs: { slow: 300 } }).check('off')
  assert.equal(awaited.outcome, 'inconclusive')
  assert.equal(awaited.crowdRequests!.length, 3, 'the backer\'s pair, and the request whose answer had arrived')
  assert.equal(tokenizerPrecheckCost(awaited).pricedExchangeCount, 15)
  assert.equal(tokenizerPrecheckCost(awaited).missingCostExchangeCount, 0)
  assert.doesNotThrow(() => validateTokenizerPrecheck(awaited))
  // A refused vote in time is only not measured: the crowd is complete, and the backer makes it a mismatch.
  const refused = market({ off: OTHER_TOKENIZER, backer: MODEL_TOKENIZER, gone: () => 'down' }, undefined, { crowdTimeLimitMs: 50 })
  assert.equal((await refused.check('off')).outcome, 'mismatch')
})

test('a seller listed under several names for the model is asked and counted once', async () => {
  // Three sellers on another count would outvote the reference; one seller with three names does not.
  const sellers = market(
    { off: OTHER_TOKENIZER, honest: MODEL_TOKENIZER, target: tokenizer(3) },
    [
      { peerId: 'off', service: SERVICE }, { peerId: 'off', service: `${SERVICE}-fast` }, { peerId: '0xOFF', service: `${SERVICE}-latest` },
      { peerId: 'honest', service: SERVICE }, { peerId: 'target', service: SERVICE },
    ],
  )
  const record = await sellers.check('target')
  assert.equal(record.outcome, 'mismatch')
  assert.deepEqual([record.crowd!.deltas.length, record.crowd!.measured, record.crowd!.agree, record.crowd!.largestGroup], [3, 3, 1, 1])
  assert.equal(sellers.requests('off'), 2)
})

test('a model\'s only seller is never a pre-check mismatch, listed or not', async () => {
  const target = seller({ usage: OTHER_TOKENIZER })
  const told: boolean[] = []
  const screen = createTokenizerPrecheckScreen<null>({
    sellers: [], proxyBaseUrl: 'http://127.0.0.1:8390', responseAuthReader: target.responseAuthReader,
    limiter: new ConcurrencyLimiter(2), fetchFn: target.fetchFn, reference: async () => measuredReference(),
    onUnbacked: (crowd) => told.push(crowd.outvoted),
  })
  const record = await screen.check({ peerId: PEER_ID, service: SERVICE }, null)
  assert.equal(record.outcome, 'inconclusive')
  assert.match(record.reason!, /no other seller of the model signed the reference's count/)
  assert.deepEqual([record.crowd!.deltas.length, record.crowd!.measured, record.crowd!.corroborated], [1, 1, false])
  assert.equal(target.contents.length, 12)
  assert.deepEqual(told, [false])
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
})

// ── in a seller audit ────────────────────────────────────────────────────────────────────────────

test('a seller whose signed input tokens are not the model\'s is DIFF, and its questions are still asked and kept apart', async () => {
  const { result, evidence, questionRequests, precheckRequests, backerRequests } = await audit({ usage: OTHER_TOKENIZER })
  assert.equal(result.status, 'DIFF')
  // Every test runs: the questions are asked beside the mismatch, and their own verdict is stored apart.
  assert.ok(questionRequests.length > 0)
  assert.equal(result.questionsStatus, 'SAME')
  assert.equal(evidence.result.verdict, 'SAME', 'the evidence\'s result is the questions\' own')
  assert.equal(evidence.tests, 'all-tests-v1')
  assert.equal(precheckRequests.length, 12)
  // The model's other seller was asked the first round's pair, and signs the reference's count.
  assert.equal(backerRequests.length, 2)
  assert.equal(result.tokenizerPrecheck!.outcome, 'mismatch')
  // Its twelve requests and the two to the other seller are counted and paid for with this audit, beside the batches.
  assert.equal(result.requestCount, questionRequests.length + 14)
  assert.equal(result.cost.pricedExchangeCount, 14)
  assert.equal(evidence.tokenizerPrecheck!.outcome, 'mismatch')
  // The pre-check is the one that flagged; the questions passed and are never named as flagging.
  assert.deepEqual(flaggingChecks(evidence, result.questionsStatus!), ['tokens'])
  assert.deepEqual(passedChecks(evidence, result.questionsStatus!), ['kbf'])
  assert.equal(needsExtension({ ...result, decisionRule: 'kbf-extension-v2' }), false)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  // One decision all the way: a summary whose ResponseAuth state is not its evidence's is refused, and the verdict
  // submitted is the decision's, never a stored status.
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, responseAuthVerified: false }), /ResponseAuth state is not its evidence's/)
  assert.equal(finalAuditVerdict({ ...result, status: 'SAME' } as never), 'DIFF')
})

test('the seller\'s clock runs only while a pre-check request to it is out: the reference and the crowd are the auditor\'s time', async () => {
  // A reference that takes longer than the seller's idle limit: before, every seller of the model timed out
  // ("seller sent no answer") without being asked anything.
  const slowReference = await audit({ usage: MODEL_TOKENIZER, referenceDelayMs: 300, auditTimeoutMs: 100 })
  assert.equal(slowReference.result.status, 'SAME')
  assert.equal(slowReference.result.outcomeReason, null)
  assert.equal(slowReference.result.tokenizerPrecheck!.outcome, 'match')
  assert.ok(slowReference.questionRequests.length > 0)
  // The model's other seller answers the crowd's pair slower than the idle limit: the audit still ends in a DIFF.
  const slowCrowd = await audit({ usage: OTHER_TOKENIZER, backerDelayMs: 150, auditTimeoutMs: 100 })
  assert.equal(slowCrowd.result.status, 'DIFF')
  assert.equal(slowCrowd.result.tokenizerPrecheck!.outcome, 'mismatch')
  assert.doesNotThrow(() => validateAuditMatchesSummary(slowCrowd.evidence, slowCrowd.result))
})

test('a seller that counts like the model is asked its questions and judged on them, with the pre-check in its evidence', async () => {
  const { result, evidence, questionRequests, precheckRequests } = await audit({ usage: (content) => 300 + MODEL_TOKENIZER(content) })
  assert.equal(result.status, 'SAME')
  assert.equal(precheckRequests.length, 2)
  assert.ok(questionRequests.length > 0)
  assert.deepEqual(result.tokenizerPrecheck, { rule: TOKENIZER_PRECHECK_RULE.id, outcome: 'match' })
  assert.equal(result.parsedProbeCount, PROBE_COUNT)
  assert.equal(evidence.tokenizerPrecheck!.outcome, 'match')
  assert.equal(evidence.exchanges.length, questionRequests.length)
  // The pre-check's two requests are paid for and counted with the audit.
  assert.equal(result.cost.pricedExchangeCount, 2)
  assert.equal(result.requestCount, questionRequests.length + 2)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  // The summary's pre-check must be its evidence's.
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, tokenizerPrecheck: undefined }), /summary's tokenizer pre-check is not the one in its evidence/)
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, tokenizerPrecheck: { ...result.tokenizerPrecheck!, outcome: 'mismatch' } }), /summary's tokenizer pre-check is not the one in its evidence/)
})

test('the only seller of a model that is off the reference is asked its questions: nothing backs the reference', async () => {
  const { result, evidence, questionRequests, precheckRequests } = await audit({ usage: OTHER_TOKENIZER, backer: false })
  // The pre-check is active (its reference measured every round) and decided nothing for this seller: no SAME.
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.questionsStatus, 'SAME')
  assert.deepEqual(result.inactive?.map((entry) => entry.check), ['output-cap', 'output-echo', 'output-offset', 'flips'])
  assert.equal(precheckRequests.length, 12)
  assert.ok(questionRequests.length > 0)
  assert.deepEqual(result.tokenizerPrecheck, { rule: TOKENIZER_PRECHECK_RULE.id, outcome: 'inconclusive' })
  assert.match(evidence.tokenizerPrecheck!.reason!, /no other seller of the model signed the reference's count/)
  assert.equal(result.requestCount, questionRequests.length + 12)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
})

test('a signed response with cached input and no count leaves a result that can be submitted', async () => {
  // A cheating seller could otherwise send this once and keep every verdict of its questions from being sent.
  // It is submitted as UNDETERMINED: the pre-check is active and had no result, and only the seller's SAME is lost.
  const { result, evidence } = await audit({ usage: () => ({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 12 } }) })
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.questionsStatus, 'SAME')
  assert.equal(evidence.tokenizerPrecheck!.outcome, 'inconclusive')
  assert.equal(evidence.tokenizerPrecheck!.rounds[0]!.seller[0]!.base.cachedInput, true)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
})

test('a pre-check that decides nothing keeps the seller from SAME, and its questions are still asked', async () => {
  const { result, evidence, questionRequests } = await audit({ usage: () => 0 })
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.questionsStatus, 'SAME')
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  assert.ok(questionRequests.length > 0)
  assert.deepEqual(result.tokenizerPrecheck, { rule: TOKENIZER_PRECHECK_RULE.id, outcome: 'inconclusive' })
  assert.match(evidence.tokenizerPrecheck!.reason!, /could not be read/)
})
