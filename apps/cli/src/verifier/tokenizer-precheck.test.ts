import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { flaggingChecks, passedChecks, type AuditCheckId } from './flagging-checks.js'
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, encodeHttpResponse, type PeerId, type PeerInfo, type StoredResponseAuth } from '@antseed/node'
import { isSafeProbe } from '@antseed/node/payments'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import { needsExtension } from './close-call.js'
import { validateAuditMatchesSummary } from './model-audit.js'
import { referenceFixture } from './model-audit-fixtures.test-support.js'
import { verifyModelTarget, type ModelVerificationResumeInput, type ModelVerificationSkip, type ModelVerificationTargetResult } from './model-run.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import type { ResponseAuthReader } from './response-auth-reader.js'
import {
  TOKENIZER_PRECHECK_RULE,
  createTokenizerPrecheckScreen,
  describeTokenizerMismatch,
  generateTokenizerProbe,
  judgeTokenizerPrecheck,
  judgeTokenizerRound,
  measureTokenizerReference,
  referenceDelta,
  runTokenizerPrecheck,
  tokenizerCrowd,
  tokenizerPrecheckCost,
  tokenizerPrecheckRequestCount,
  validateTokenizerPrecheck,
  type TokenizerBackerV1,
  type TokenizerPrecheckClock,
  type TokenizerPrecheckReferenceV1,
  type TokenizerPrecheckV1,
  type TokenizerProbeV1,
  type TokenizerReferenceAsk,
  type TokenizerReferenceAskV1,
} from './tokenizer-precheck.js'

const PEER_ID = '11'.repeat(20)
/** Another seller of the model, which counts like the reference. */
const BACKER_ID = '22'.repeat(20)
const SERVICE = 'example-model'
const PROBES: TokenizerProbeV1[] = [
  { a: 'First question, please reply briefly.', b: ' The reference is ZX-48217-QK and I paid 1,249.50 euros on 14 March 2026.' },
  { a: 'Second question, one line is enough.', b: ' Parcel 0049 3021 7785 weighs 12.75 kg and should arrive before 09:30 on Thursday.' },
  { a: 'Third question, keep it short.', b: ' Invoice INV-900317 for 3,407.18 dollars is still open, budget code 77-1409-XR.' },
]

/** A stand-in tokenizer: one token per `charsPerToken` characters. Different values count the same text differently. */
const tokenizer = (charsPerToken: number) => (text: string): number => Math.ceil(text.length / charsPerToken)
const MODEL_TOKENIZER = tokenizer(4)
const OTHER_TOKENIZER = tokenizer(2.5)

/** The reference endpoint: the model's tokenizer plus the endpoint's own fixed wrapper. */
const referenceAsk = (count = MODEL_TOKENIZER): TokenizerReferenceAsk => async (contents) => ({
  upstream: { name: 'referenceEndpoint' },
  results: contents.map((content) => ({ inputTokens: 7 + count(content), failure: null })),
})

async function measuredReference(count = MODEL_TOKENIZER): Promise<TokenizerPrecheckReferenceV1> {
  return measureTokenizerReference({ ask: referenceAsk(count), probes: PROBES })
}

/** The part of a ResponseAuth the pre-check keeps and checks: who signed it, for which request. */
function signedRecord(input: { requestId: string; sellerPeerId: string }) {
  return { requestId: input.requestId, sellerPeerId: input.sellerPeerId } as unknown as StoredResponseAuth
}

/**
 * A seller behind the buyer proxy. `usage(content, call)` is the input-token count it signs for a request (null
 * signs a response without usage); `status(call)` an HTTP status other than 200.
 */
function seller(options: {
  usage: (content: string, call: number) => number | null | Record<string, unknown>
  status?: (call: number) => number
  auth?: 'verified' | 'invalid'
  peerId?: string
  /** How long the seller takes to answer a request. */
  delayMs?: number
}) {
  const signed = new Map<string, number | null | Record<string, unknown>>()
  const contents: string[] = []
  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
    assert.equal(headers.get('x-antseed-pin-peer'), options.peerId ?? PEER_ID)
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    assert.equal(headers.get('x-antseed-capture-response-auth-preimages'), '1')
    const body = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as {
      model: string; messages: Array<{ role: string; content: string }>; max_tokens: number; stream: boolean
    }
    assert.deepEqual([body.model, body.max_tokens, body.stream, body.messages.length], [SERVICE, TOKENIZER_PRECHECK_RULE.maxTokens, false, 1])
    const call = contents.push(body.messages[0]!.content)
    const status = options.status?.(call) ?? 200
    if (status !== 200) return new Response('unavailable', { status })
    signed.set(requestId, options.usage(body.messages[0]!.content, call))
    return Response.json({ choices: [{ message: { content: 'ok' } }] }, {
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
      const tokens = signed.get(input.requestId)
      const body = tokens === null || tokens === undefined
        ? { choices: [{ message: { content: 'ok' } }] }
        : { choices: [{ message: { content: 'ok' } }], usage: typeof tokens === 'number' ? { prompt_tokens: tokens, completion_tokens: 3 } : tokens }
      const valid = options.auth !== 'invalid'
      return {
        requestId: input.requestId,
        status: valid ? 'verified' : 'invalid',
        responseAuth: signedRecord(input),
        signedPreimages: valid ? {
          encoding: 'antseed-http-codec-v1',
          signatureEncoding: 'antseed-response-auth-signing-v1',
          requestBase64: 'AA==',
          responseBase64: Buffer.from(encodeHttpResponse({
            requestId: input.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)),
          })).toString('base64'),
          responseAuthSigningBase64: 'AA==',
          requestHash: `0x${'44'.repeat(32)}`,
          responseHash: `0x${'55'.repeat(32)}`,
        } : null,
        failureReason: valid ? null : 'bad signature',
      }
    },
    close() {},
  }
  return { fetchFn, responseAuthReader, contents }
}

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
  options: { backers?: number; signal?: AbortSignal } = {},
): Promise<TokenizerPrecheckV1> {
  const measured = reference ?? await measuredReference()
  return runTokenizerPrecheck({
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
      return tokenizerCrowd([own.delta, ...backers.map((backer) => backer.ask.delta)], measured.rounds[0]!.delta!, TOKENIZER_PRECHECK_RULE, [], backers)
    },
  })
}

/** One ask of the reference: the counts for A and for A + B, from one provider and without cached input. */
const asked = (baseTokens: number | null, probedTokens: number | null, extra: Partial<TokenizerReferenceAskV1> = {}): TokenizerReferenceAskV1 => ({
  baseTokens, probedTokens, cachedInput: false, providers: ['Provider-A', 'Provider-A'], ...extra,
})

test('a round is off only when the seller is asked twice, is off the reference both times and agrees with itself', () => {
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [100] }), 'match')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [102] }), 'match')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [98] }), 'match')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [103] }), 'unmeasured', 'one ask off proves nothing yet')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [140, 101] }), 'match', 'the second ask counted like the model')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [140, 140] }), 'off')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [140, 142] }), 'off', 'its asks may differ by the tolerance')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [140, 143] }), 'unstable')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [125, 64] }), 'unstable')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [140, null] }), 'unmeasured')
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [] }), 'unmeasured')
  assert.equal(judgeTokenizerRound({ referenceDelta: null, sellerDeltas: [140, 140] }), 'unmeasured')
})

test('a seller is a mismatch only when every round of the rule is off', () => {
  const off = { referenceDelta: 100, sellerDeltas: [140, 140] }
  assert.equal(judgeTokenizerPrecheck([off, off, off]), 'mismatch')
  assert.equal(judgeTokenizerPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [140, 102] }]), 'match', 'within the tolerance once is a match')
  assert.equal(judgeTokenizerPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [103, 104] }]), 'mismatch', 'one past the tolerance is off')
  assert.equal(judgeTokenizerPrecheck([off, off]), 'inconclusive', 'two rounds prove nothing')
  assert.equal(judgeTokenizerPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [140, null] }]), 'inconclusive')
  assert.equal(judgeTokenizerPrecheck([off, off, { referenceDelta: 100, sellerDeltas: [140, 90] }]), 'inconclusive', 'counts that change between asks')
  assert.equal(judgeTokenizerPrecheck([off, off, { referenceDelta: null, sellerDeltas: [140, 140] }]), 'inconclusive')
  // In the order the run asks: a round that decides nothing ends the check, whatever a later round would say.
  assert.equal(judgeTokenizerPrecheck([{ referenceDelta: 100, sellerDeltas: [140, 90] }, { referenceDelta: 100, sellerDeltas: [100] }]), 'inconclusive')
  assert.equal(judgeTokenizerPrecheck([]), 'inconclusive')
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
    + `for text the model counts as ${record.rounds.map((round) => round.reference.delta).join('/')}: off by more than 2 in every round, `
    + 'while 1 of the model\'s other sellers signed the model\'s count; its questions were not asked$',
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
  const cached = (tokens: number) => ({ prompt_tokens: tokens, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 64 } })
  const honest = seller({ usage: (content) => cached(900 + MODEL_TOKENIZER(content)) })
  const matched = await precheck(honest)
  assert.equal(matched.outcome, 'match')
  assert.equal(honest.contents.length, 2)
  assert.deepEqual([matched.rounds[0]!.seller[0]!.base.cachedInput, matched.rounds[0]!.seller[0]!.probed!.cachedInput], [true, true])
  assert.doesNotThrow(() => validateTokenizerPrecheck(matched))

  // A gateway that leaves the cached part out of its count: where the cache ends moves with the text, so the
  // difference is off by a little every time, the same way when asked again.
  const netOfCache = seller({ usage: (content) => cached(MODEL_TOKENIZER(content) - Math.round(content.length / 12)) })
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
  assert.equal(judgeTokenizerRound({ referenceDelta: 100, sellerDeltas: [99], cachedAsks: [true] }), 'match')
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
  assert.throws(() => validateTokenizerPrecheck(edit((copy) => { copy.rule = { ...copy.rule, toleranceTokens: 0 } })), /unknown rule/)
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
  // A match ends it too: a later round answered after it does not stand.
  const later = structuredClone(matched)
  later.rounds[1]!.seller = structuredClone(matched.rounds[0]!.seller).map((ask) => ({
    ...ask, base: { ...ask.base, requestIds: ['other-base'] }, probed: { ...ask.probed!, requestIds: ['other-probed'] },
  }))
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

test('sellers outvote the reference when two or more agree on another count and outnumber those on the reference\'s', () => {
  const crowd = (deltas: Array<number | null>) => {
    const { deltas: _deltas, requests: _requests, backers: _backers, ...tally } = tokenizerCrowd(deltas, 119)
    return tally
  }
  // The reference endpoint counts 119; thirteen sellers sign 132, two sign the reference's count.
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
  assert.deepEqual(tokenizerCrowd([132, null, 119, 121], 119).deltas, [119, 121, 132, null])
})

/** A seller's audit clock driven by `signal` alone: what a test's audit deadline looks like to the pre-check. */
function clockOf(signal: AbortSignal | undefined): TokenizerPrecheckClock | undefined {
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
  options: { crowdTimeLimitMs?: number } = {},
) {
  const peers = Object.keys(sellers)
  const signed = new Map<string, number | null | Record<string, unknown>>()
  const asked = new Map<string, string[]>(peers.map((peer) => [peer, []]))
  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
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
      const tokens = signed.get(input.requestId)
      const usage = tokens === null || tokens === undefined ? {} : { usage: typeof tokens === 'number' ? { prompt_tokens: tokens } : tokens }
      return {
        requestId: input.requestId,
        status: 'verified',
        responseAuth: signedRecord(input),
        signedPreimages: {
          encoding: 'antseed-http-codec-v1',
          signatureEncoding: 'antseed-response-auth-signing-v1',
          requestBase64: 'AA==',
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

test('a crowd vote whose pair reports cached input neither backs the reference nor helps outvote it', async () => {
  const cached = (tokens: number) => ({ prompt_tokens: tokens, prompt_tokens_details: { cached_tokens: 32 } })
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
  // The backer's pair was answered and paid: it stays in the count and the cost.
  assert.equal(record.crowdRequests!.length, 2)
  assert.equal(tokenizerPrecheckRequestCount(record), 14)
  assert.equal(tokenizerPrecheckCost(record).pricedExchangeCount, 14)
  assert.doesNotThrow(() => validateTokenizerPrecheck(record))
  assert.throws(() => validateTokenizerPrecheck({ ...record, outcome: 'mismatch', reason: null }), /stores the requests of a crowd it does not leave undecided/)
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

const MODEL = 'example-model'
const PROBE_COUNT = 40

function auditedPeer(): PeerInfo {
  return {
    peerId: PEER_ID as PeerId,
    displayName: 'Example Seller',
    lastSeen: Date.now(),
    providers: ['test'],
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    onChainAgentId: 7,
    providerPricing: { test: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } } },
  }
}

/**
 * Audits a seller that answers every question right and signs `usage` for the pre-check's requests. The model has
 * one other seller, which counts like the reference (`backer: false`: it has none).
 */
async function audit(options: {
  usage: (content: string) => number | Record<string, unknown>
  precheck?: boolean
  extension?: boolean
  backer?: boolean
  resume?: ModelVerificationResumeInput
  /** The seller refuses its first question batch in a way that skips it: its upstream key is gone. */
  refuseQuestions?: boolean
  onReference?: () => void
  /** How long the reference measurement takes, and the seller's idle limit. */
  referenceDelayMs?: number
  auditTimeoutMs?: number
  /** How long the other seller takes to answer. */
  backerDelayMs?: number
  /** The audit confirms another auditor's DIFF that these checks flagged. */
  confirming?: AuditCheckId[]
}) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-tokenizer-precheck-'))
  const target = seller({ usage: options.usage })
  const backer = seller({ usage: MODEL_TOKENIZER, peerId: BACKER_ID, ...(options.backerDelayMs ? { delayMs: options.backerDelayMs } : {}) })
  const pinned = (init?: RequestInit) => (new Headers(init?.headers).get('x-antseed-pin-peer') === BACKER_ID ? backer : target)
  const precheckFetch: typeof fetch = async (url, init) => pinned(init).fetchFn(url, init)
  const responseAuthReader: ResponseAuthReader = {
    waitForVerified: async (input) => (input.sellerPeerId === BACKER_ID ? backer : target).responseAuthReader.waitForVerified(input),
    close() {},
  }
  const questionRequests: string[] = []
  const fetchFn: typeof fetch = async (url, init) => {
    const body = JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)) as { messages: Array<{ content: string }> }
    const prompt = body.messages.at(-1)!.content
    const values = [...prompt.matchAll(/test value (\d+) is ___/g)].map((match) => Number(match[1]))
    if (values.length === 0) return precheckFetch(url, init)
    questionRequests.push(prompt)
    if (options.refuseQuestions) return Response.json({ error: { message: 'The API key was deleted' } }, { status: 401 })
    return Response.json({ choices: [{ message: { content: values.map((value, index) => `(${index + 1}) ${value}`).join('\n') } }] }, {
      headers: { 'x-antseed-request-id': new Headers(init?.headers).get('x-antseed-request-id')! },
    })
  }
  try {
    const result = await verifyModelTarget({
      context: {
        proxy: { baseUrl: 'http://127.0.0.1:8390', statePath: join(directory, 'buyer.state.json'), pid: process.pid, peers: [auditedPeer()] },
        evidenceDir: directory,
        requestTimeoutMs: 10_000,
        auditTimeoutMs: options.auditTimeoutMs ?? 10_000,
        responseAuthReader,
        batchConcurrency: 2,
        batchConcurrencyPromotionLatencyMs: 30_000,
        batchLimiter: new ConcurrencyLimiter(2),
        fetchFn,
        sleepFn: async () => undefined,
        ...(options.precheck === false ? {} : {
          tokenizerPrecheck: createTokenizerPrecheckScreen({
            sellers: [{ peerId: PEER_ID, service: SERVICE }, ...(options.backer === false ? [] : [{ peerId: BACKER_ID, service: SERVICE }])],
            proxyBaseUrl: 'http://127.0.0.1:8390',
            responseAuthReader,
            limiter: new ConcurrencyLimiter(2),
            fetchFn: precheckFetch,
            reference: async () => {
              options.onReference?.()
              if (options.referenceDelayMs) await new Promise((resolve) => setTimeout(resolve, options.referenceDelayMs))
              return measuredReference()
            },
          }),
        }),
      },
      target: auditedPeer(),
      service: SERVICE,
      reference: referenceFixture(MODEL, PROBE_COUNT),
      ...(options.extension ? { extension: true } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.confirming ? { confirming: { checks: options.confirming } } : {}),
    })
    if (options.refuseQuestions) return { skipped: result, result: null as never, evidence: null as never, questionRequests, precheckRequests: target.contents, backerRequests: backer.contents }
    assert.notEqual(result.status, 'SKIPPED')
    const audited = result as ModelVerificationTargetResult
    const evidence = JSON.parse(await readFile(audited.evidencePath, 'utf8')) as ProxyAuditEvidenceV1
    return { skipped: null, result: audited, evidence, questionRequests, precheckRequests: target.contents, backerRequests: backer.contents }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a seller whose signed input tokens are not the model\'s is DIFF and is asked no question', async () => {
  const { result, evidence, questionRequests, precheckRequests, backerRequests } = await audit({ usage: OTHER_TOKENIZER })
  assert.equal(result.status, 'DIFF')
  assert.equal(questionRequests.length, 0)
  assert.equal(precheckRequests.length, 12)
  // The model's other seller was asked the first round's pair, and signs the reference's count.
  assert.equal(backerRequests.length, 2)
  assert.equal(result.tokenizerPrecheck!.outcome, 'mismatch')
  // Its twelve requests and the two to the other seller are counted and paid for with this audit.
  assert.deepEqual([result.parsedProbeCount, result.probeCount, result.correctRate, result.requestCount], [0, PROBE_COUNT, null, 14])
  assert.equal(result.cost.pricedExchangeCount, 14)
  assert.equal(evidence.result.verdict, 'DIFF')
  assert.match(evidence.result.verdictReason!, /^tokenizer pre-check \(tokenizer-precheck-v1\): the seller signed .* its questions were not asked$/)
  assert.deepEqual(evidence.exchanges, [])
  assert.deepEqual(evidence.result.matchVector, new Array(PROBE_COUNT).fill(null))
  assert.equal(evidence.tokenizerPrecheck!.outcome, 'mismatch')
  assert.equal(evidence.reference.probes.length, PROBE_COUNT)
  // The DIFF travels like any other: no close call to extend, and submission accepts its evidence.
  assert.equal(needsExtension({ ...result, decisionRule: 'kbf-extension-v2' }), false)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
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
  assert.deepEqual(result.tokenizerPrecheck, { rule: 'tokenizer-precheck-v1', outcome: 'match' })
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
  assert.equal(result.status, 'SAME')
  assert.equal(precheckRequests.length, 12)
  assert.ok(questionRequests.length > 0)
  assert.deepEqual(result.tokenizerPrecheck, { rule: 'tokenizer-precheck-v1', outcome: 'inconclusive' })
  assert.match(evidence.tokenizerPrecheck!.reason!, /no other seller of the model signed the reference's count/)
  assert.equal(result.requestCount, questionRequests.length + 12)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
})

test('a signed response with cached input and no count leaves a result that can be submitted', async () => {
  // A cheating seller could otherwise send this once and keep every verdict of its questions from being sent.
  const { result, evidence } = await audit({ usage: () => ({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 12 } }) })
  assert.equal(result.status, 'SAME')
  assert.equal(evidence.tokenizerPrecheck!.outcome, 'inconclusive')
  assert.equal(evidence.tokenizerPrecheck!.rounds[0]!.seller[0]!.base.cachedInput, true)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
})

test('a seller skipped at its first question still reports what its pre-check sent and cost', async () => {
  const { skipped, precheckRequests } = await audit({ usage: MODEL_TOKENIZER, refuseQuestions: true })
  assert.equal(skipped!.status, 'SKIPPED')
  assert.equal(precheckRequests.length, 2)
  const skip = skipped as ModelVerificationSkip
  assert.equal(skip.requestCount, 2)
  assert.equal(skip.cost!.pricedExchangeCount, 2)
  assert.ok(skip.cost!.estimatedCostUsd > 0)
})

test('an audit that resumes with answered batches is past the pre-check; one that resumes with none runs it', async () => {
  const first = await audit({ usage: MODEL_TOKENIZER })
  const resume = (exchanges: ProxyAuditEvidenceV1['exchanges']): ModelVerificationResumeInput => ({
    parentAuditId: first.result.auditId, reservationAuditId: first.result.auditId, parentEvidenceHash: first.result.evidenceHash, exchanges,
  })
  const answered = await audit({ usage: OTHER_TOKENIZER, resume: resume(first.evidence.exchanges.slice(0, 1)) })
  assert.equal(answered.precheckRequests.length, 0)
  assert.equal(answered.backerRequests.length, 0)
  assert.equal(answered.result.tokenizerPrecheck, undefined)
  assert.equal(answered.result.status, 'SAME')
  assert.equal(answered.questionRequests.length, first.questionRequests.length - 1)

  const unanswered = await audit({ usage: OTHER_TOKENIZER, resume: resume([]) })
  assert.equal(unanswered.result.status, 'DIFF')
  assert.equal(unanswered.precheckRequests.length, 12)
  assert.equal(unanswered.questionRequests.length, 0)
})

test('a pre-check that decides nothing leaves the seller to its questions', async () => {
  const { result, evidence, questionRequests } = await audit({ usage: () => 0 })
  assert.equal(result.status, 'SAME')
  assert.ok(questionRequests.length > 0)
  assert.deepEqual(result.tokenizerPrecheck, { rule: 'tokenizer-precheck-v1', outcome: 'inconclusive' })
  assert.match(evidence.tokenizerPrecheck!.reason!, /could not be read/)
})

test('an extra set of a close call, and an audit without the pre-check, go straight to the questions', async () => {
  let referenceAsked = 0
  const extension = await audit({ usage: OTHER_TOKENIZER, extension: true, onReference: () => { referenceAsked += 1 } })
  assert.equal(extension.result.status, 'SAME')
  assert.equal(extension.precheckRequests.length, 0)
  assert.equal(referenceAsked, 0)
  assert.equal(extension.result.tokenizerPrecheck, undefined)
  assert.equal(extension.evidence.tokenizerPrecheck, undefined)

  const off = await audit({ usage: OTHER_TOKENIZER, precheck: false })
  assert.equal(off.result.status, 'SAME')
  assert.equal(off.precheckRequests.length, 0)
})

test('submission refuses a DIFF that neither its questions nor a pre-check mismatch carries', async () => {
  const { result, evidence } = await audit({ usage: OTHER_TOKENIZER })
  const edit = (change: (copy: ProxyAuditEvidenceV1) => void): ProxyAuditEvidenceV1 => {
    const copy = structuredClone(evidence)
    change(copy)
    return copy
  }
  const { tokenizerPrecheck: _precheck, ...bare } = result
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { delete copy.tokenizerPrecheck }), bare), /DIFF without a scoreable answer or a tokenizer pre-check mismatch/)
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { delete copy.tokenizerPrecheck }), result), /summary's tokenizer pre-check is not the one in its evidence/)
  // The counts the report prints are the evidence's.
  assert.deepEqual(result.tokenizerPrecheck!.sellerTokens, evidence.tokenizerPrecheck!.rounds.map((round) => round.seller[0]!.delta))
  assert.deepEqual(result.tokenizerPrecheck!.modelTokens, evidence.tokenizerPrecheck!.rounds.map((round) => round.reference.delta))
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, tokenizerPrecheck: { ...result.tokenizerPrecheck!, modelTokens: [1, 2, 3] } }), /summary's tokenizer pre-check is not the one in its evidence/)
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { copy.tokenizerPrecheck!.rounds[0]!.seller[0]!.delta! += 9 }), result), /difference does not follow/)
  assert.throws(() => validateAuditMatchesSummary(edit((copy) => { copy.result.verdict = 'SAME' }), result), /a tokenizer pre-check mismatch is a DIFF/)
  assert.throws(() => validateAuditMatchesSummary(evidence, { ...result, status: 'SAME' }), /verdict mismatch/)
})

test('a confirmation of a DIFF the questions flagged asks the questions even when the pre-check flags first', async () => {
  // The first auditor's questions flagged the seller. Here the pre-check finds a mismatch first: it is recorded,
  // and the audit goes on to the questions, the check this confirmation must run to its end.
  const { result, evidence, questionRequests } = await audit({ usage: OTHER_TOKENIZER, confirming: ['kbf'] })
  assert.equal(result.tokenizerPrecheck!.outcome, 'mismatch')
  assert.ok(questionRequests.length > 0)
  assert.equal(result.status, 'SAME', 'the questions decide: these answers are the model\'s')
  assert.deepEqual(evidence.confirming, { checks: ['kbf'] })
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
  // At submit it names the pre-check as what flagged and the questions as passed: another check, so nothing is sent.
  assert.deepEqual(flaggingChecks(evidence, result.status), ['tokens'])
  assert.deepEqual(passedChecks(evidence, result.status), ['kbf'])
  // Without the confirmation the same evidence is not valid: a mismatch beside questions.
  const { confirming: _confirming, ...plain } = evidence
  assert.throws(() => validateAuditMatchesSummary(plain, result), /a tokenizer pre-check mismatch is a DIFF with no question asked/)
  // A confirmation of a pre-check DIFF ends at the mismatch, as a first audit does.
  const tokens = await audit({ usage: OTHER_TOKENIZER, confirming: ['tokens'] })
  assert.equal(tokens.result.status, 'DIFF')
  assert.equal(tokens.questionRequests.length, 0)
  assert.deepEqual(flaggingChecks(tokens.evidence, tokens.result.status), ['tokens'])
})

test('a confirmation of a pre-check DIFF whose pre-check did not run is an undecided attempt, never a SAME', async () => {
  // A resumed or unscreened audit runs no pre-check: the check to repeat did not decide, so the questions' SAME is
  // not this confirmation's answer. It is UNDETERMINED with a reason the epoch plan audits again, and submit sends nothing.
  const { result, evidence, questionRequests } = await audit({ usage: MODEL_TOKENIZER, precheck: false, confirming: ['tokens'] })
  assert.equal(questionRequests.length, 0, 'its questions could not decide it, so they are not asked')
  assert.equal(result.status, 'UNDETERMINED')
  assert.equal(result.outcomeReason?.code, 'confirmation_undecided')
  assert.equal(needsExtension({ ...result, decisionRule: 'kbf-extension-v2' }), false)
  assert.doesNotThrow(() => validateAuditMatchesSummary(evidence, result))
})
