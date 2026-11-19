import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import { FLIPS_CHECK, readingsOfEvidence, validateCheckRecordsAgainstSummary, verdictOf, withoutOrphans, type AuditCheckId } from './audit-checks.js'
import { FLIPS_RULE, flipsCounts, flipsRequestBody, isValidFlipsPair, type FlipsPair, type FlipsRule } from './flips-score.js'
import {
  FLIPS_WORDS,
  drawFlipsPairs,
  FLIPS_ROUTE_NOT_SUPPORTED,
  FLIPS_REASK_BUDGET,
  createFlipsScreen,
  finishReasonOf,
  flipsReferenceProblem,
  flipsRequestCount,
  flipsSeed,
  flipsPool,
  isFlipsRecord,
  judgeFlips,
  readFlipsAnswer,
  summarizeFlips,
  type FlipsUnavailable,
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
  const draw: FlipsDrawV1 = { auditor: '0x00', model: MODEL, epoch: '7', seed: '00', stage }
  const pairs = saved.pairs.map((pair, pairIndex) => {
    const body = flipsRequestBody(MODEL, MODEL, pair.pair, rule)
    const reference: FlipsReferencePairV1 = {
      words: pair.pair,
      replies: pair.reference.map((reply) => ({
        ...reply, provider: 'host', reasoning: false, thinkBlock: false, failure: null,
        request: JSON.stringify({ ...body, model: 'vendor/route-model', provider: { only: ['host'] } }),
      })),
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
  // The draw is fixed by the auditor, model, epoch, seed and stage, and changes with the seed.
  const draw: FlipsDrawV1 = { auditor: '0xA1', model: MODEL, epoch: '32', seed: 'aa'.repeat(32), stage: 'first' }
  assert.deepEqual(drawFlipsPairs(draw), drawFlipsPairs({ ...draw }))
  assert.equal(drawFlipsPairs(draw).length, FLIPS_RULE.pairsPerCheck)
  assert.equal(new Set(drawFlipsPairs(draw).map(key)).size, FLIPS_RULE.pairsPerCheck)
  const seeds = new Set(Array.from({ length: 12 }, (_, index) => drawFlipsPairs({ ...draw, seed: index.toString(16).padStart(64, '0') }).map(key).join(',')))
  assert.ok(seeds.size > 1, 'another seed draws other pairs')
  // A seed is derived per model audit and stage from a private master: publishing one reveals no other.
  assert.notEqual(flipsSeed('ab'.repeat(32), { model: MODEL, epoch: '32', runId: 'r1', stage: 'first' }), flipsSeed('ab'.repeat(32), { model: MODEL, epoch: '32', runId: 'r2', stage: 'first' }))
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
  // What it would be if FLIPS counted: the same record read under a counting rule, which still never counts MiniMax M3.
  const counting = { flips: { ...FLIPS_RULE, counts: { default: true, never: ['minimax-m3'] } } }
  assert.deepEqual(verdictOf(readingsOfEvidence({ flips: stored, exchanges: [{}] }, 'SAME', counting), 'SAME'),
    { verdict: 'DIFF', flaggedBy: ['flips'], passedBy: ['kbf'], undecidedConfirmation: null })
  const m3 = { ...stored, draw: { ...stored.draw, model: 'minimax-m3' } }
  assert.equal(verdictOf(readingsOfEvidence({ flips: m3, exchanges: [{}] }, 'SAME', counting), 'SAME').verdict, 'SAME', 'MiniMax M3 never counts')
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
  assert.match(reason((pair, index) => { if (index === 1) pair.replies[3]!.provider = 'other-host' }), /do not come from one proven provider/, 'across both pairs')
  assert.match(reason((pair) => { pair.replies[5]!.request = JSON.stringify({ ...JSON.parse(pair.replies[5]!.request), max_tokens: 600 }) }), /was not asked the sellers' request/, 'every slot is compared')
  assert.match(reason((pair) => { pair.replies[2]!.request = JSON.stringify({ ...JSON.parse(pair.replies[2]!.request), reasoning_effort: 'high' }) }), /was not asked the sellers' request/, 'an override outside the five fields shows')
  assert.match(reason((pair) => { pair.replies[0]!.content = null }), /a reference reply could not be read/)
  // The reasoning profile is a share over both pairs: neither at most 10% nor at least 90% is no profile.
  assert.match(reason((pair) => { for (const reply of pair.replies.slice(0, Math.ceil(pair.replies.length / 4))) reply.reasoning = true }), /the reference reasons in \d+ of \d+ replies: neither/)
  assert.match(reason((pair, index) => { if (index === 0) for (const reply of pair.replies) reply.reasoning = true }), /the reference reasons in \d+ of \d+ replies: neither/, 'one pair reasons, the other does not')
  assert.match(reason(undefined, (record) => {
    const body = flipsRequestBody(MODEL, MODEL, record.pairs[0]!.words)
    record.pairs[0]!.seller[1]!.request = signed(body, chat('<think>random</think> amber basin'), 'think-block')
  }), /writes its reasoning into its text/)
  assert.match(reason(undefined, (record) => {
    const body = flipsRequestBody(MODEL, MODEL, record.pairs[0]!.words)
    record.pairs[0]!.seller[1]!.request = signed(body, { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }] }, 'null-text')
  }), /a signed answer has no readable text/)
  // The seller's profile is read the same way, in both directions, with the counts of both sides.
  const sellerReasons = (share: number) => (record: ReturnType<typeof recordOf>['record']) => {
    record.pairs.forEach((pair, pairIndex) => pair.seller.forEach((slot, index) => {
      if (index >= Math.round(pair.seller.length * share)) return
      const reply = saved.pairs[pairIndex]!.seller[index]!
      slot.request = signed(flipsRequestBody(MODEL, MODEL, pair.words), chat(reply.content, reply.finishReason ?? 'stop', 40), `thinks-${pairIndex}-${index}`)
    }))
  }
  assert.match(reason(undefined, sellerReasons(1)), /the seller reasons where the reference does not \(\d+ of \d+ replies, \d+ reasoning tokens, against 0 of/)
  assert.match(reason(undefined, sellerReasons(0.5)), /the seller reasons in some replies and not in others/)
  assert.match(reason((pair) => { for (const reply of pair.replies) reply.reasoning = true }), /the seller does not reason where the reference does/)
  const { record: reasoning, rule: reasoningRule } = recordOf(saved, 'first')
  sellerReasons(1)(reasoning)
  const mismatched = judgeFlips(reasoning, reasoningRule)
  assert.deepEqual(mismatched.profileMismatch?.code, 'seller-reasons')
  // The score it would have had is kept for the dry run, apart from the outcome: the record itself has no p.
  assert.equal(mismatched.p, null)
  const unmasked = judgeFlips(recordOf(saved, 'first').record, reasoningRule)
  assert.ok(Math.abs(mismatched.profileMismatch!.diagnosticScoreIgnoringProfile!.p - unmasked.p!) < 1e-12)
  // One reasoning reply in a whole profile is still that profile: it scores.
  const { record: oneOff, rule: oneOffRule } = recordOf(saved, 'first', (pair, index) => { if (index === 0) pair.replies[0]!.reasoning = true })
  assert.notEqual(judgeFlips(oneOff, oneOffRule).p, null)
  assert.match(reason(undefined, (record) => {
    record.pairs[0]!.seller[2]!.request = signed(flipsRequestBody(MODEL, MODEL, record.pairs[0]!.words), chat(`${record.pairs[0]!.words[0]} `.repeat(1300)), 'long')
  }), /longer than 6000 characters/)
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
  const draw: FlipsDrawV1 = { auditor: '0xA1', model: MODEL, epoch: '32', seed: 'cd'.repeat(32), stage: 'first' }
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
  // Each slot keeps its asks in order: the scheduled one, then a re-ask only after no reply, with time and cost.
  const reasked = record.pairs.flatMap((pair) => pair.seller).find((slot) => slot.asks!.length > 1)!
  assert.deepEqual(reasked.asks!.map((entry) => [entry.reason, entry.answered]), [['scheduled', false], ['no-reply', true]])
  const edited = (change: (slots: FlipsV1['pairs'][number]['seller']) => void): FlipsV1 => {
    const copy = structuredClone(record)
    change(copy.pairs.flatMap((pair) => pair.seller))
    return copy
  }
  assert.throws(() => validateFlips({ ...record, reasks: FLIPS_REASK_BUDGET + 1 }), /re-asks more slots than its budget/)
  assert.throws(() => validateFlips(edited((slots) => { slots.find((slot) => slot.asks!.length > 1)!.asks![0]!.answered = true })), /asked again after a reply/)
  assert.throws(() => validateFlips(edited((slots) => { slots[3]!.asks![0]!.requestIds = ['other'] })), /asks are not its requests/)
  assert.throws(() => validateFlips(edited((slots) => { slots[4]!.asks = [] })), /does not start with its scheduled ask/)
  assert.throws(() => validateFlips({ ...record, p: 0.5, outcome: 'pass' }), /does not follow from its replies/)
  assert.throws(() => validateFlips({ ...record, draw: { ...record.draw, seed: 'ef'.repeat(32) } }), /not the ones its draw gives/)
  // An empty reply is an answer: it counts as the rule says and is never asked again.
  const empty = fakeSeller((call) => (call === 1 ? '' : symbols(['amber', 'basin'], call)))
  const withEmpty = await stored(empty)
  assert.equal(withEmpty.reasks, 0)
  assert.equal(empty.calls(), FLIPS_RULE.repliesPerPair.first * FLIPS_RULE.pairsPerCheck)
})

test('the finish reason is read in each API\'s own terms', () => {
  assert.equal(finishReasonOf({ choices: [{ finish_reason: 'length' }] }), 'length')
  assert.equal(finishReasonOf({ stop_reason: 'max_tokens' }), 'length')
  assert.equal(finishReasonOf({ stop_reason: 'end_turn' }), 'stop')
  assert.equal(finishReasonOf({ stop_reason: 'refusal' }), 'content_filter')
  assert.equal(finishReasonOf({ status: 'completed' }), 'stop')
  assert.equal(finishReasonOf({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), 'length')
  assert.equal(finishReasonOf(null), null)
})

test('a stored FLIPS is the audit\'s own: the confirmation stage exactly when it confirms FLIPS, and the audit\'s model', async () => {
  const record = await stored(fakeSeller((call) => symbols(['amber', 'basin'], call + 300)))
  const context = (audit: { confirming?: AuditCheckId[]; referenceModel?: string; epoch?: string; auditor?: string }) => ({ auditedPeerId: PEER, records: {}, reader: 'submit' as const, audit })
  assert.doesNotThrow(() => FLIPS_CHECK.validate(record, context({ referenceModel: MODEL })))
  assert.throws(() => FLIPS_CHECK.validate(record, context({ confirming: ['flips'], referenceModel: MODEL })), /stage is not the one its audit calls for/)
  assert.doesNotThrow(() => FLIPS_CHECK.validate(record, context({ confirming: ['output-cap'], referenceModel: MODEL })), 'a confirmation of another test is a first look for FLIPS')
  assert.throws(() => FLIPS_CHECK.validate(record, context({ referenceModel: 'gpt-6-astra' })), /drawn for another model/)
  // The report's epoch and auditor are the draw's: a record of another epoch or auditor is not this audit's.
  const reported = (audit: { epoch?: string; auditor?: string }) => context({ referenceModel: MODEL, ...audit })
  assert.doesNotThrow(() => FLIPS_CHECK.validate(record, reported({ epoch: '32', auditor: '0xa1' })))
  assert.throws(() => FLIPS_CHECK.validate(record, reported({ epoch: '33' })), /drawn for another epoch/)
  assert.throws(() => FLIPS_CHECK.validate(record, reported({ auditor: '0xB2' })), /drawn for another auditor/)
})

test('an answer is read from its own bytes: without usage, empty only when filtered, a structured refusal is a filtered reply', () => {
  const read = (answer: unknown) => readFlipsAnswer(new Uint8Array(), { statusCode: 200, body: bytes(answer) })
  const { usage: _usage, ...noUsage } = chat('amber basin')
  assert.equal(read(noUsage).reply.content, 'amber basin', 'billing is not reading')
  assert.deepEqual(read(chat(null, 'content_filter')).reply, { content: '', finishReason: 'content_filter' })
  assert.equal(read(chat(null, 'stop')).reply.content, null, 'no content is not an empty reply')
  const refusal = { object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }
  assert.deepEqual(read(refusal).reply, { content: '', finishReason: 'content_filter' })
  assert.equal(read(chat('<think>x</think> amber')).thinkBlock, true)
  assert.equal(read(chat('amber', 'stop', 12)).reasoningTokens, 12)
  assert.equal(read({ object: 'response', status: 'completed', output: [{ type: 'reasoning', summary: [] }] }).reply.content, null, 'a completed reply with no message is no reply')
  assert.deepEqual(read({ object: 'response', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }).reply, { content: '', finishReason: 'content_filter' }, 'explicit filtering stays a filtered reply')
  const huge = read({ ...chat('amber'), usage: { prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 1e300 } } })
  assert.deepEqual([huge.reasoning, huge.reasoningTokens], [true, 0], 'an implausible count shows reasoning and counts no tokens')
})

/** A FLIPS screen over stand-in reference and seller endpoints; `askReference` sees every reference call. */
function screenOf(options: {
  seller: ReturnType<typeof fakeSeller>
  rule?: FlipsRule
  probe?: Parameters<typeof createFlipsScreen>[0]['probe']
  askReference?: (call: number) => void | Promise<never>
  provider?: (index: number) => string | null
  timeLimitMs?: number
}) {
  const events: FlipsUnavailable[] = []
  let referenceCalls = 0
  let replyIndex = 0
  const screen = createFlipsScreen<null>({
    model: MODEL, auditor: '0xA1', epoch: '32', seedFor: (stage) => flipsSeed('ab'.repeat(32), { model: MODEL, epoch: '32', runId: 'r', stage }),
    proxyBaseUrl: 'http://127.0.0.1:1', responseAuthReader: options.seller.responseAuthReader as never, limiter: new ConcurrencyLimiter(8),
    fetchFn: options.seller.fetchFn, ...(options.rule ? { rule: options.rule } : {}), ...(options.probe ? { probe: options.probe } : {}),
    onUnavailable: (event) => events.push(event),
    ...(options.timeLimitMs ? { timeLimitMs: options.timeLimitMs } : {}),
    ask: () => async (bodies) => {
      await options.askReference?.(++referenceCalls)
      return {
        upstream: { kind: 'test' }, oneProvider: true,
        results: bodies.map((body) => {
          const pair = ((body['messages'] as Array<{ content: string }>)[0]!.content.match(/\{(\w+), (\w+)\}/)!.slice(1)) as unknown as FlipsPair
          const index = replyIndex++
          return { requestBody: bytes(body), response: { statusCode: 200, body: bytes(chat(symbols(pair, index + 900))) }, provider: options.provider?.(index) ?? null, failure: null }
        }),
      }
    },
  })
  return { screen, events }
}

const SELLER = { peerId: PEER, service: MODEL }

test('a probe marks every record it asks, and a follow-up of a first flag draws fresh pairs, is paid for, and keeps the flag when it fails', async () => {
  // A stage-only probe is still a probe: it never counts, even under a rule that counts FLIPS for this model.
  const counting: FlipsRule = { ...FLIPS_RULE, counts: { default: true, never: [] } }
  const staged = await screenOf({ seller: fakeSeller((call) => symbols(['amber', 'basin'], call)), rule: counting, probe: { stage: 'first' } }).screen.check(SELLER, null, { stage: 'first' })
  assert.equal(staged!.draw.probe, true)
  assert.equal(staged!.counted, false)
  assert.equal(summarizeFlips(staged!).probe, true)
  assert.equal(FLIPS_CHECK.findings[0]!.ofRecord(staged!, { flips: counting }), 'inconclusive')
  // Every scored check flags under this bar, so each one is followed up.
  const flagging: FlipsRule = { ...FLIPS_RULE, bar: { first: 1, confirm: 0.001 } }
  const chosen = flipsPool('confirm').slice(0, 2)
  const followed = await screenOf({ seller: fakeSeller((call) => symbols(['amber', 'basin'], call + 7)), rule: flagging, probe: { pairs: chosen, followUpFirstFlags: true } }).screen.check(SELLER, null, { stage: 'first' })
  assert.equal(followed!.outcome, 'flag')
  const followUp = followed!.followUp!
  assert.equal(followUp.draw.stage, 'confirm')
  assert.equal(followUp.draw.probe, true)
  const key = (pair: readonly string[]) => [...pair].sort().join('/')
  assert.deepEqual(followed!.pairs.map((pair) => key(pair.words)), chosen.map(key))
  assert.equal(followUp.pairs.filter((pair) => chosen.some((other) => key(other) === key(pair.words))).length, 0, 'chosen pairs are not asked again')
  assert.equal(flipsRequestCount(followed!), FLIPS_RULE.repliesPerPair.first * 2 + FLIPS_RULE.repliesPerPair.confirm * 2, 'the follow-up is in the cost')
  assert.doesNotThrow(() => validateFlips(followed!))
  // The follow-up's reference fails: the first flag stands, with why.
  const failed = screenOf({ seller: fakeSeller((call) => symbols(['amber', 'basin'], call + 7)), rule: flagging, probe: { followUpFirstFlags: true }, askReference: (call) => { if (call === 2) throw new Error('reference down') } })
  const kept = await failed.screen.check(SELLER, null, { stage: 'first' })
  assert.equal(kept!.outcome, 'flag')
  assert.equal(kept!.followUp, undefined)
  assert.match(kept!.followUpFailed!, /reference down/)
  assert.deepEqual(failed.events.map((event) => `${event.stage} ${event.code}`), ['follow-up reference-failed', 'follow-up follow-up-failed'])
})

test('a FLIPS that cannot run says why, once per model and stage, and costs the seller nothing', async () => {
  // The reference fails: every seller gets no record, and the reason is reported once.
  const seller = fakeSeller((call) => symbols(['amber', 'basin'], call))
  const down = screenOf({ seller, askReference: () => { throw new Error('reference down') } })
  assert.equal(await down.screen.check(SELLER, null, { stage: 'first' }), null)
  assert.equal(await down.screen.check({ ...SELLER, peerId: 'cd'.repeat(20) }, null, { stage: 'first' }), null)
  assert.deepEqual(down.events, [{ stage: 'first', code: 'reference-failed', detail: 'reference down' }])
  assert.equal(seller.calls(), 0)
  // The reference answers from two providers: unusable, checked before the seller is asked.
  const mixed = screenOf({ seller, provider: (index) => (index === 5 ? 'other-host' : 'host') })
  const record = await mixed.screen.check(SELLER, null, { stage: 'first' })
  assert.equal(record!.outcome, 'inconclusive')
  assert.match(record!.reason, /one proven provider/)
  assert.equal(seller.calls(), 0)
  assert.deepEqual(mixed.events.map((event) => event.code), ['reference-unusable'])
  // Unnamed answers on a route not proven to serve one provider are no one provider's.
  const unproven = flipsReferenceProblem({ draw: record!.draw, service: MODEL, referenceOneProvider: false, pairs: record!.pairs.map((pair) => ({ ...pair.reference, replies: pair.reference.replies.map((reply) => ({ ...reply, provider: null })) })) })
  assert.match(unproven!, /one proven provider/)
})

test('a carried record without the shape of a FLIPS record is dropped; a FLIPS summary with no record holds up nothing while it cannot count', () => {
  assert.equal(isFlipsRecord({ rule: 'flips-v1' }), false)
  assert.deepEqual(withoutOrphans({ flips: { rule: 'flips-v1', draw: null } as never }), {})
  const evidence = { target: { peerId: PEER, service: MODEL }, reference: { referenceModel: MODEL } }
  const summary = { rule: 'flips-v1', model: MODEL, stage: 'first', outcome: 'flag', counted: false, p: 0.001, score: 3, reason: 'x' }
  assert.doesNotThrow(() => validateCheckRecordsAgainstSummary(evidence as never, { flips: summary }))
  assert.doesNotThrow(() => validateCheckRecordsAgainstSummary(evidence as never, { flips: { ...summary, model: 'minimax-m3' } }))
})

test('FLIPS\'s time bounds the wait for its reference, an unusable reference is reported once it is ready, and a record keeps what the dry run reads', async () => {
  // The reference never answers: the seller's FLIPS ends at its time limit with no record, and says so.
  const seller = fakeSeller((call) => symbols(['amber', 'basin'], call))
  const hung = screenOf({ seller, timeLimitMs: 30, askReference: () => new Promise<never>(() => undefined) })
  const began = Date.now()
  assert.equal(await hung.screen.check(SELLER, null, { stage: 'first' }), null)
  assert.ok(Date.now() - began < 2_000)
  assert.deepEqual(hung.events.map((event) => event.code), ['check-failed'])
  // Warmed while the questions run, an unusable reference is reported before any seller reaches FLIPS.
  const mixed = screenOf({ seller, provider: (index) => (index === 3 ? 'other-host' : 'host') })
  mixed.screen.warm(MODEL, null, 'first')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(mixed.events.map((event) => event.code), ['reference-unusable'])
  // A route that names no provider and is not proven to serve one is reported as not supported.
  const unnamed = flipsReferenceProblem({
    draw: { auditor: '0xA1', model: MODEL, epoch: '32', seed: 'aa', stage: 'first' }, service: MODEL, referenceOneProvider: false,
    pairs: drawFlipsPairs({ auditor: '0xA1', model: MODEL, epoch: '32', seed: 'aa', stage: 'first' }).map((words) => ({
      words, replies: Array.from({ length: 40 }, () => ({ content: 'amber', finishReason: 'stop', provider: null, reasoning: false, thinkBlock: false, failure: null, request: JSON.stringify(flipsRequestBody(MODEL, MODEL, words)) })),
    })),
  })
  assert.equal(unnamed, FLIPS_ROUTE_NOT_SUPPORTED)
  // A finished check keeps its seconds and the reasoning counts of both sides.
  const done = await screenOf({ seller: fakeSeller((call) => symbols(['amber', 'basin'], call + 3)) }).screen.check(SELLER, null, { stage: 'first' })
  assert.ok(done!.timing && done!.timing.finishedAt >= done!.timing.startedAt)
  assert.deepEqual([done!.reasoningCounts?.sellerReplies, done!.reasoningCounts?.referenceReplies], [20, 80])
})

test('a stored FLIPS record is bounded and holds real numbers: a slot with a null cost is no record', async () => {
  const record = await stored(fakeSeller((call) => symbols(['amber', 'basin'], call + 50)))
  assert.equal(isFlipsRecord(record), true)
  const nullCost = { ...record, pairs: record.pairs.map((pair, index) => (index === 0 ? { ...pair, seller: [{ request: { ...pair.seller[0]!.request, attemptCosts: [null] } }, ...pair.seller.slice(1)] } : pair)) }
  assert.equal(isFlipsRecord(nullCost), false)
  // The reference's time, on the auditor's clock, for a report of its age: written on every pair, optional to read.
  assert.ok(record.pairs.every((pair) => pair.reference.askedAt && pair.reference.askedAt.first <= pair.reference.askedAt.last))
  const withoutStamp = { ...record, pairs: record.pairs.map((pair) => ({ ...pair, reference: { words: pair.reference.words, replies: pair.reference.replies } })) }
  assert.equal(isFlipsRecord(withoutStamp), true, 'a record written before the stamp is still a record')
  const backwards = { ...record, pairs: record.pairs.map((pair) => ({ ...pair, reference: { ...pair.reference, askedAt: { first: 2, last: 1 } } })) }
  assert.equal(isFlipsRecord(backwards), false, 'a stamp, when there, is well formed')
  assert.equal(withoutOrphans({ flips: nullCost as never }).flips, undefined)
  assert.equal(isFlipsRecord({ ...record, pairs: Array.from({ length: 5 }, () => record.pairs[0]) }), false, 'more pairs than any rule asks')
  // Counts that would sum past any number, or a number canonical JSON cannot hold, make no record.
  assert.equal(isFlipsRecord({ ...record, reasoningCounts: { ...record.reasoningCounts!, sellerReasoningTokens: Number.MAX_VALUE } }), false)
  assert.equal(isFlipsRecord({ ...record, score: Number.POSITIVE_INFINITY }), false)
  // A deeply nested record is refused at its second level, without descending.
  let nested: Record<string, unknown> = { ...record }
  for (let level = 0; level < 20_000; level += 1) nested = { ...record, followUp: nested }
  assert.equal(isFlipsRecord(nested), false)
  assert.equal(isFlipsRecord({ ...record, followUp: { ...record, draw: { ...record.draw, probe: true } } }), true)
})
