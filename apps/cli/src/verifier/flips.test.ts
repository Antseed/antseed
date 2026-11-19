import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import { readingsOfEvidence, verdictOf } from './audit-checks.js'
import { FLIPS_RULE, flipsCounts, flipsRequestBody, isValidFlipsPair, type FlipsPair, type FlipsRule } from './flips-score.js'
import {
  FLIPS_WORDS,
  drawFlipsPairs,
  flipsPool,
  judgeFlips,
  prepareFlipsReference,
  runFlips,
  validateFlips,
  type FlipsDrawV1,
  type FlipsReferencePairV1,
  type FlipsV1,
} from './flips.js'
import type { SignedSellerRequestV1 } from './signed-seller-request.js'

const PEER = 'ab'.repeat(20)
const MODEL = 'claude-opus-5.5'
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))
const chat = (content: string | null, finish = 'stop', reasoning = 0) => ({
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
  usage: { prompt_tokens: 60, completion_tokens: 130, ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) },
})

/** A request the seller signed: its body and its answer, as the buyer stores them. */
function signed(body: Record<string, unknown>, reply: unknown, id: string): SignedSellerRequestV1 {
  return {
    requestIds: [id], statusCode: 200, attemptCosts: [{ inputTokens: 60, outputTokens: 130, totalTokens: 190, estimatedCostUsd: 0.0001 }] as never,
    responseAuth: {
      requestId: id, status: 'verified', failureReason: null,
      record: { requestId: id, sellerPeerId: PEER, advertisedService: MODEL } as never,
      signedPreimages: {
        encoding: 'antseed-http-codec-v1', signatureEncoding: 'antseed-response-auth-signing-v1',
        requestBase64: Buffer.from(encodeHttpRequest({ requestId: id, method: 'POST', path: '/v1/chat/completions', headers: {}, body: bytes(body) })).toString('base64'),
        responseBase64: Buffer.from(encodeHttpResponse({ requestId: id, statusCode: 200, headers: {}, body: bytes(reply) })).toString('base64'),
        responseAuthSigningBase64: 'AA==', requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}`,
      },
    } as never,
    failureReason: null,
  }
}

/** Saved checks of the FLIPS eval (`fixtures/flips`), as the scorer's own tests read them. */
interface Fixture { name: string; replies: number; pairs: Array<{ pair: FlipsPair; reference: Array<{ content: string | null; finishReason: string | null }>; seller: Array<{ content: string | null; finishReason: string | null }> }> }
const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = [join(here, 'fixtures', 'flips'), join(here, '..', '..', 'src', 'verifier', 'fixtures', 'flips')].find((path) => existsSync(path))!
const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as Fixture

/** A stored check made of a saved eval check, under a rule sized to it. */
function recordOf(saved: Fixture, stage: 'first' | 'confirm' = 'first', edit: (pair: FlipsReferencePairV1, index: number) => void = () => undefined) {
  const perPair = saved.pairs[0]!.seller.length
  const rule: FlipsRule = {
    ...FLIPS_RULE,
    repliesPerPair: stage === 'first' ? { first: perPair, confirm: 20 } : { first: 10, confirm: perPair },
    referenceRepliesPerPair: saved.pairs[0]!.reference.length,
  }
  const draw: FlipsDrawV1 = { auditor: '0x00', model: MODEL, epoch: '7', salt: '00', stage }
  const pairs = saved.pairs.map((pair, pairIndex) => {
    const body = flipsRequestBody(MODEL, MODEL, pair.pair, rule)
    const reference: FlipsReferencePairV1 = {
      words: pair.pair,
      request: JSON.stringify({ ...body, model: 'vendor/route-model', provider: { only: ['host'] } }),
      replies: pair.reference.map((reply) => ({ ...reply, provider: 'host', reasoning: false, failure: null })),
    }
    edit(reference, pairIndex)
    return {
      words: pair.pair,
      reference,
      seller: pair.seller.map((reply, slot) => ({ request: signed(body, chat(reply.content, reply.finishReason ?? 'stop'), `${pairIndex}-${slot}`) })),
    }
  })
  return { record: { draw, service: MODEL, referenceOneProvider: true, pairs }, rule }
}

test('the word list is lower case and read back; the two pools share no pair, so a confirmation never asks a first audit\'s pair', () => {
  for (const word of FLIPS_WORDS) assert.match(word, /^[a-z]+$/)
  assert.equal(new Set(FLIPS_WORDS).size, FLIPS_WORDS.length)
  const first = flipsPool('first')
  const confirm = flipsPool('confirm')
  for (const pair of [...first, ...confirm]) assert.ok(isValidFlipsPair(pair))
  const key = (pair: FlipsPair) => pair.join('/')
  assert.equal(first.filter((pair) => confirm.some((other) => other.some((word) => pair.includes(word)))).length, 0, 'not even a word in common')
  assert.ok(first.length >= 4 && confirm.length >= 4)
  // The draw is fixed by the auditor, model, epoch, salt and stage, and changes with the salt.
  const draw: FlipsDrawV1 = { auditor: '0xA1', model: MODEL, epoch: '32', salt: 'aa'.repeat(32), stage: 'first' }
  assert.deepEqual(drawFlipsPairs(draw), drawFlipsPairs({ ...draw }))
  assert.equal(drawFlipsPairs(draw).length, FLIPS_RULE.pairsPerCheck)
  assert.equal(new Set(drawFlipsPairs(draw).map(key)).size, FLIPS_RULE.pairsPerCheck)
  const salts = new Set(Array.from({ length: 12 }, (_, index) => drawFlipsPairs({ ...draw, salt: index.toString(16).padStart(64, '0') }).map(key).join(',')))
  assert.ok(salts.size > 1, 'another salt draws other pairs')
  for (const pair of drawFlipsPairs(draw)) assert.ok(first.some((candidate) => key(candidate) === key(pair)))
  for (const pair of drawFlipsPairs({ ...draw, stage: 'confirm' })) assert.ok(confirm.some((candidate) => key(candidate) === key(pair)))
})

test('the request is the eval\'s for the model, the same for the seller and the reference; FLIPS counts only where the rule says', () => {
  const opus = flipsRequestBody('claude-opus-5.5', 'svc', ['amber', 'basin'])
  assert.deepEqual([opus['max_tokens'], opus['temperature'], opus['reasoning']], [220, undefined, { effort: 'minimal' }], 'no temperature for Claude')
  const grok = flipsRequestBody('grok-4.7', 'svc', ['amber', 'basin'])
  assert.deepEqual([grok['max_tokens'], grok['temperature']], [900, 1], 'a model that still thinks gets 900')
  assert.equal(flipsCounts('claude-opus-5.5'), false, 'recorded only everywhere until the dry run signs it off')
  const counting = { ...FLIPS_RULE, counts: { default: true, never: ['minimax-m3'] } }
  assert.equal(flipsCounts('claude-opus-5.5', counting), true)
  assert.equal(flipsCounts('minimax-m3', counting), false, 'never for MiniMax M3')
  assert.equal(flipsCounts('a-model-the-eval-never-measured', counting), false)
})

test('a saved swap flags at the first bar, recorded only until FLIPS counts; the verdict can be judged both ways', () => {
  const { record, rule } = recordOf(fixture('swap-caught-near-threshold'))
  const judged = judgeFlips(record, rule)
  assert.equal(judged.outcome, 'flag')
  assert.ok(judged.p! <= FLIPS_RULE.bar.first)
  assert.equal(judged.counted, false)
  const stored = { ...record, rule: rule.id, referenceUpstream: null, reasks: 0, ...judged } as FlipsV1
  const readings = readingsOfEvidence({ flips: stored, exchanges: [{}] }, 'SAME')
  const flips = readings.find((reading) => reading.check === 'flips')!
  assert.deepEqual([flips.outcome, flips.recordedOnly], ['inconclusive', 'flag'])
  assert.equal(verdictOf(readings, 'SAME').verdict, 'SAME', 'recorded only: the audit verdict ignores it')
  assert.deepEqual(verdictOf(readings, 'SAME', null, { countRecordedOnly: true }), { verdict: 'DIFF', flaggedBy: ['flips'], passedBy: ['kbf'], undecidedConfirmation: null })
})

test('an honest saved check does not flag; between the bar and the pass it decides nothing', () => {
  for (const name of ['honest-wrapper', 'honest-provider-confirm-40']) {
    const stage = name.endsWith('-40') ? 'confirm' as const : 'first' as const
    const { record, rule } = recordOf(fixture(name), stage)
    const judged = judgeFlips(record, rule)
    assert.notEqual(judged.outcome, 'flag', name)
    assert.equal(judged.outcome, judged.p! >= rule.passAbove ? 'pass' : 'inconclusive', name)
  }
})

test('no result for a partial sample, a mixed reference, a changed request, a seller that reasons alone, or an unanswered slot', () => {
  const saved = fixture('swap-caught-near-threshold')
  const reason = (edit: Parameters<typeof recordOf>[2], change?: (record: ReturnType<typeof recordOf>['record']) => void) => {
    const { record, rule } = recordOf(saved, 'first', edit)
    change?.(record)
    const judged = judgeFlips(record, rule)
    assert.equal(judged.outcome, 'inconclusive')
    assert.equal(judged.p, null)
    return judged.reason
  }
  assert.match(reason(undefined, (record) => { record.pairs[0]!.seller.pop() }), /seller slots, the stage asks/)
  assert.match(reason((pair) => { pair.replies.pop() }), /reference replies, the rule asks/)
  assert.match(reason((pair, index) => { if (index === 0) pair.replies[3]!.provider = 'other-host' }), /do not come from one provider/)
  assert.match(reason((pair) => { pair.request = JSON.stringify({ ...JSON.parse(pair.request), max_tokens: 600 }) }), /the reference route changed the request/)
  assert.match(reason(undefined, (record) => {
    const slot = record.pairs[0]!.seller[0]!
    const body = flipsRequestBody(MODEL, MODEL, record.pairs[0]!.words)
    slot.request = signed(body, chat('amber basin', 'stop', 40), 'thinks')
  }), /reasons where the reference does not/)
  assert.match(reason(undefined, (record) => { record.pairs[1]!.seller[2]!.request = { ...record.pairs[1]!.seller[2]!.request, responseAuth: null } }), /a scheduled slot has no reply/)
})

/** A seller behind the buyer proxy that answers FLIPS requests; `fail` decides which calls get no reply at all. */
function fakeSeller(answer: (call: number) => string, fail: (call: number) => boolean = () => false) {
  const signedBytes = new Map<string, { request: Uint8Array; response: Uint8Array }>()
  let calls = 0
  const fetchFn: typeof fetch = async (_url, init) => {
    const call = ++calls
    const requestId = new Headers(init?.headers).get('x-antseed-request-id')!
    if (fail(call)) return Response.json({ error: { message: 'upstream unavailable' } }, { status: 503, headers: { 'x-antseed-request-id': requestId } })
    const reply = chat(answer(call))
    signedBytes.set(requestId, {
      request: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: init!.body as Uint8Array }),
      response: encodeHttpResponse({ requestId, statusCode: 200, headers: {}, body: bytes(reply) }),
    })
    return Response.json(reply, { headers: { 'x-antseed-request-id': requestId } })
  }
  const responseAuthReader = {
    async waitForVerified(input: { requestId: string; sellerPeerId: string; advertisedService: string }) {
      const pair = signedBytes.get(input.requestId)
      if (!pair) return { requestId: input.requestId, status: 'missing' as const, responseAuth: null, signedPreimages: null, failureReason: 'no ResponseAuth' }
      return {
        requestId: input.requestId, status: 'verified' as const, failureReason: null,
        responseAuth: { requestId: input.requestId, sellerPeerId: input.sellerPeerId, advertisedService: input.advertisedService },
        signedPreimages: {
          encoding: 'antseed-http-codec-v1' as const, signatureEncoding: 'antseed-response-auth-signing-v1' as const,
          requestBase64: Buffer.from(pair.request).toString('base64'), responseBase64: Buffer.from(pair.response).toString('base64'),
          responseAuthSigningBase64: 'AA==', requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}`,
        },
      }
    },
    close() {},
  } as never
  return { fetchFn, responseAuthReader, calls: () => calls }
}

/** Random-looking symbols of a pair, from a seed: what a model writes when asked. */
const symbols = (pair: FlipsPair, seed: number): string => Array.from({ length: 64 }, (_, index) => pair[((seed * 7 + index * index * 3 + index) % 5) % 2]).join(' ')

async function stored(seller: ReturnType<typeof fakeSeller>) {
  const draw: FlipsDrawV1 = { auditor: '0xA1', model: MODEL, epoch: '32', salt: 'cd'.repeat(32), stage: 'first' }
  let referenceCall = 0
  const reference = await prepareFlipsReference({
    model: MODEL, service: MODEL, stage: 'first', pairs: drawFlipsPairs(draw),
    ask: async (bodies) => ({
      upstream: { kind: 'test' }, oneProvider: true,
      results: bodies.map((body) => {
        const pair = ((body['messages'] as Array<{ content: string }>)[0]!.content.match(/\{(\w+), (\w+)\}/)!.slice(1)) as unknown as FlipsPair
        return { requestBody: bytes(body), response: { statusCode: 200, body: bytes(chat(symbols(pair, ++referenceCall))) }, provider: null, failure: null }
      }),
    }),
  })
  return runFlips({
    seller: { proxyBaseUrl: 'http://127.0.0.1:1', responseAuthReader: seller.responseAuthReader, limiter: new ConcurrencyLimiter(4), fetchFn: seller.fetchFn, peerId: PEER, service: MODEL },
    draw, reference,
  })
}

test('a run asks every scheduled slot, asks again only a slot with no reply, and its record recomputes as stored', async () => {
  // The 20 first tries queue before any second try, so calls 1 and 21 are both tries of one slot, which gets no reply
  // at all: that slot alone is asked again.
  const slots = FLIPS_RULE.repliesPerPair.first * FLIPS_RULE.pairsPerCheck
  const seller = fakeSeller((call) => symbols(['amber', 'basin'], call + 100), (call) => call === 1 || call === slots + 1)
  const record = await stored(seller)
  assert.equal(record.reasks, 1)
  for (const pair of record.pairs) assert.equal(pair.seller.length, FLIPS_RULE.repliesPerPair.first)
  assert.doesNotThrow(() => validateFlips(record))
  assert.throws(() => validateFlips({ ...record, p: 0.5, outcome: 'pass' }), /does not follow from its replies/)
  assert.throws(() => validateFlips({ ...record, draw: { ...record.draw, salt: 'ef'.repeat(32) } }), /not the ones its draw gives/)
  // An empty reply is an answer: it counts as the rule says and is never asked again.
  const empty = fakeSeller((call) => (call === 1 ? '' : symbols(['amber', 'basin'], call)))
  const withEmpty = await stored(empty)
  assert.equal(withEmpty.reasks, 0)
  assert.equal(empty.calls(), FLIPS_RULE.repliesPerPair.first * FLIPS_RULE.pairsPerCheck)
})
