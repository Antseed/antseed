import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import { prepareModelAudits } from './model-audit.js'
import { FIXTURE_CONFIG, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'
import test from 'node:test'
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import { transformRequest } from '@antseed/api-adapter'
import { outputEchoRequestBody } from './output-echo.js'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import { readOutput, requestCarriesPrompt, type OutputReadingV1 } from './output-usage.js'
import type { TokenizerReferenceAsk } from './tokenizer-precheck.js'
import {
  OUTPUT_CAP_RULE,
  createOutputCapScreen,
  describeOutputCapFlag,
  measuredTokens,
  outputCapRequestCount,
  prepareOutputCapReference,
  runOutputCap,
  summarizeOutputCap,
  validateOutputCap,
  type CapReferenceReply,
  type OutputCapV1,
  answerToMeasure,
  classifyCapAnswer,
  judgeOutputCap,
  numberWords,
  outputCapPrompt,
  outputCapRequestBody,
} from './output-cap.js'

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))
const capped = (cap: number, extra: Record<string, unknown> = {}) => bytes({ model: 'm', messages: [{ role: 'user', content: 'count' }], max_tokens: cap, stream: false, ...extra })

function chat(text: string | null, usage: Record<string, unknown>, extra: { finish?: string; message?: Record<string, unknown> } = {}) {
  return {
    statusCode: 200,
    body: bytes({
      id: 'x', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text, ...extra.message }, finish_reason: extra.finish ?? 'length' }],
      usage,
    }),
  }
}

const words = (count: number): string => Array.from({ length: count }, (_value, index) => numberWords(301 + index)).join(', ')

test('reads the cap, the billed output, the itemised reasoning and the answer of each API shape', () => {
  const fromChat = readOutput(capped(16), chat('three hundred and one', { prompt_tokens: 20, completion_tokens: 408, completion_tokens_details: { reasoning_tokens: 392 } }))
  assert.deepEqual(fromChat, {
    cap: 16, oneAnswer: true, stops: false, billedOutputTokens: 408, estimated: false, reasoningTokens: 392,
    reasoningMarker: true, text: 'three hundred and one', finished: false, shape: 'chat',
  })
  const messages = readOutput(capped(24), {
    statusCode: 200,
    body: bytes({
      type: 'message', role: 'assistant', stop_reason: 'max_tokens',
      content: [{ type: 'thinking', thinking: 'hm', signature: 's' }, { type: 'text', text: 'four, five' }],
      usage: { input_tokens: 10, output_tokens: 40 },
    }),
  })
  assert.equal(messages.shape, 'messages')
  assert.equal(messages.text, 'four, five')
  assert.equal(messages.reasoningMarker, true)
  assert.equal(messages.reasoningTokens, null)
  assert.equal(messages.billedOutputTokens, 40)
  const responses = readOutput(bytes({ model: 'm', input: 'count', max_output_tokens: 32 }), {
    statusCode: 200,
    body: bytes({
      object: 'response', status: 'incomplete',
      output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'six' }] }],
      usage: { input_tokens: 5, output_tokens: 50, output_tokens_details: { reasoning_tokens: 18 } },
    }),
  })
  assert.deepEqual([responses.shape, responses.cap, responses.text, responses.reasoningTokens, responses.billedOutputTokens], ['responses', 32, 'six', 18, 50])
})

test('bills as the buyer bills: the reply\'s usage, or the buyer\'s estimate, marked estimated', () => {
  const estimated = readOutput(capped(16), chat(words(40), { prompt_tokens: 0, completion_tokens: 0 }))
  assert.equal(estimated.estimated, true)
  assert.equal(classifyCapAnswer(estimated, 16, 200), 'unread', 'nothing is decided on the buyer\'s own estimate')
})

test('two caps that disagree, several answers and stop sequences give nothing to judge', () => {
  assert.equal(readOutput(capped(16, { max_completion_tokens: 32 }), chat('x', { completion_tokens: 3 })).cap, null)
  const several = readOutput(capped(16, { n: 2 }), chat('x', { completion_tokens: 3 }))
  assert.equal(several.oneAnswer, false)
  assert.equal(classifyCapAnswer(several, 16, null), 'unread')
  assert.equal(classifyCapAnswer(readOutput(capped(16, { stop: ['.'] }), chat('x', { completion_tokens: 30 })), 16, 40), 'unread')
})

test('a stream, a cut body, text after the object and an error sent with status 200 have no reading', () => {
  for (const body of [
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    '{"choices":[{"message":{"content":"x"}}],"usage":{"completion_tokens":40}',
    '{"choices":[{"message":{"content":"x"},"finish_reason":"stop"}],"usage":{"completion_tokens":40}} trailing',
    '{"error":{"message":"upstream failed"},"usage":{"completion_tokens":40}}',
  ]) {
    const reading = readOutput(capped(16), { statusCode: 200, body: bytes(body) })
    assert.equal(reading.billedOutputTokens, null, body)
    assert.equal(classifyCapAnswer(reading, 16, 100), 'unread', body)
  }
  assert.equal(readOutput(capped(16), { statusCode: 500, body: bytes({ choices: [] }) }).billedOutputTokens, null)
})

test('reasoning billed outside the cap is never a flag', () => {
  // Shaped like the eval's Grok 4.7 replies on its maker's route: 408 and 50 billed on a limit of 16, all but 16 itemised.
  for (const [billed, reasoning] of [[408, 392], [50, 34]] as const) {
    const reading = readOutput(capped(16), chat('Three hundred and one, three', { completion_tokens: billed, completion_tokens_details: { reasoning_tokens: reasoning } }))
    assert.equal(classifyCapAnswer(reading, 16, null), 'reasoning-unmeasured', 'not measured: not a pass')
    assert.equal(judgeOutputCap([{ class: 'reasoning-unmeasured' }]).outcome, 'inconclusive')
    assert.equal(answerToMeasure(reading, 16), ' Three hundred and one, three', 'still measured, since it is billed over')
    assert.equal(classifyCapAnswer(reading, 16, 9), 'reasoning-outside-cap')
  }
})

test('the same model inside the cap on another host is within', () => {
  const reading = readOutput(capped(16), chat('', { completion_tokens: 16 }))
  assert.equal(classifyCapAnswer(reading, 16, null), 'within')
  assert.equal(answerToMeasure(reading, 16), null, 'within the limit: nothing is measured')
})

test('billed over the cap with a short answer and no itemisation is unexplained, never a flag', () => {
  const reading = readOutput(capped(16), chat('three hundred and one', { completion_tokens: 927 }))
  assert.equal(classifyCapAnswer(reading, 16, 6), 'unexplained')
  assert.equal(classifyCapAnswer(reading, 16, null), 'unexplained')
})

test('an answer between the cap and twice the cap is over-cap, shown, never a flag', () => {
  const reading = readOutput(capped(20), chat(words(10), { completion_tokens: 36 }))
  assert.equal(classifyCapAnswer(reading, 20, 36), 'over-cap')
  assert.equal(classifyCapAnswer(reading, 20, 40), 'over-cap', 'exactly twice the limit is not more than twice')
})

test('an answer that measures more than twice the cap is cap-ignored, whatever the reply itemises', () => {
  // Shaped like the public issue's seller: a reasoning signature, no count, a long answer on a limit of 10.
  const reading = readOutput(capped(16), chat(words(80), { completion_tokens: 927 }, { message: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'x' }] } }))
  assert.equal(reading.reasoningMarker, true)
  assert.equal(classifyCapAnswer(reading, 16, 537), 'cap-ignored')
  const relabelled = readOutput(capped(16), chat(words(80), { completion_tokens: 927, completion_tokens_details: { reasoning_tokens: 920 } }))
  assert.equal(classifyCapAnswer(relabelled, 16, 537), 'cap-ignored', 'moving the excess into reasoning does not hide delivered text')
})

test('cap-ignored once and within when asked again is not a flag; twice is', () => {
  assert.deepEqual(judgeOutputCap([{ class: 'cap-ignored' }, { class: 'within' }]), { outcome: 'inconclusive', reason: 'the limit was ignored once, not when asked again' })
  assert.equal(judgeOutputCap([{ class: 'cap-ignored' }, { class: 'unread' }]).outcome, 'inconclusive')
  assert.equal(judgeOutputCap([{ class: 'cap-ignored' }]).outcome, 'inconclusive')
  assert.equal(judgeOutputCap([{ class: 'cap-ignored' }, { class: 'cap-ignored' }]).outcome, 'flag')
  for (const first of ['within', 'reasoning-outside-cap'] as const) assert.equal(judgeOutputCap([{ class: first }]).outcome, 'pass', first)
  // Over the limit without a measurement that decides is not a pass: a confirmer must not clear a flag on it.
  for (const first of ['unexplained', 'over-cap'] as const) assert.equal(judgeOutputCap([{ class: first }]).outcome, 'inconclusive', first)
  assert.equal(judgeOutputCap([{ class: 'unread' }]).outcome, 'inconclusive')
  assert.equal(judgeOutputCap([]).outcome, 'inconclusive')
})

test('an answer the probe guard refuses is not measured, and decides nothing beyond its usage', () => {
  const reading = readOutput(capped(16), chat(`${words(20)}\n${words(20)}`, { completion_tokens: 200 }))
  assert.equal(answerToMeasure(reading, 16), null, 'two lines')
  assert.equal(classifyCapAnswer(reading, 16, null), 'unexplained')
})

test('a missing cap and a cap the translation changed decide nothing', () => {
  const none = readOutput(bytes({ model: 'm', messages: [] }), chat(words(80), { completion_tokens: 400 }))
  assert.equal(classifyCapAnswer(none, 16, 300), 'unread')
  const changed = readOutput(capped(64), chat(words(80), { completion_tokens: 400 }))
  assert.equal(classifyCapAnswer(changed, 16, 300), 'unread')
})

test('the request is a plain count with the seller\'s thinking settings and the drawn limit last', () => {
  const { prompt } = outputCapPrompt((max) => (max === 800 ? 7 : 0))
  assert.match(prompt, /^Count upward from 108 in English words/)
  assert.deepEqual(outputCapRequestBody({ service: 's', prompt, cap: 24, thinking: { overrides: { max_tokens: 4096, reasoning: { effort: 'none' } }, assistantPrefill: 'Sure:' } }), {
    model: 's',
    messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: 'Sure:' }],
    max_tokens: 24,
    reasoning: { effort: 'none' },
    stream: false,
  })
  assert.equal(numberWords(301), 'three hundred and one')
  assert.equal(numberWords(942), 'nine hundred and forty-two')
  assert.equal(numberWords(500), 'five hundred')
  assert.ok(OUTPUT_CAP_RULE.minCap >= 16 && OUTPUT_CAP_RULE.maxCap <= 48)
})

test('a count in words of every length the check sends passes the probe guard', () => {
  for (const count of [1, 24, 80, 200]) assert.notEqual(answerToMeasure(readOutput(capped(16), chat(words(count), { completion_tokens: 999 })), 16), null, String(count))
})

export type { OutputReadingV1 }

// --- The run on one seller, through a fake buyer proxy, and its recheck at submit ---

const SERVICE = 'test-model'
const PEER = 'ab'.repeat(32)

/** A seller that answers `answer(cap, call)` with what it signs; every request is captured. */
function fakeSeller(answer: (cap: number, call: number) => { text: string; billed: number; reasoning?: number }) {
  const bodies: Array<Record<string, unknown>> = []
  const signed = new Map<string, { request: Uint8Array; response: Uint8Array }>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
    const raw = init!.body as Uint8Array
    const body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
    const call = bodies.push(body)
    const { text, billed, reasoning } = answer(body['max_tokens'] as number, call)
    const reply = {
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'length' }],
      usage: { prompt_tokens: 30, completion_tokens: billed, ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) },
    }
    signed.set(requestId, {
      request: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: raw }),
      response: encodeHttpResponse({ requestId, statusCode: 200, headers: {}, body: bytes(reply) }),
    })
    return Response.json(reply, { headers: { 'x-antseed-request-id': requestId } })
  }
  const responseAuthReader = {
    async waitForVerified(input: { requestId: string }) {
      const bytesOf = signed.get(input.requestId)!
      return {
        requestId: input.requestId,
        status: 'verified' as const,
        responseAuth: null,
        signedPreimages: {
          encoding: 'antseed-http-codec-v1' as const,
          signatureEncoding: 'antseed-response-auth-signing-v1' as const,
          requestBase64: Buffer.from(bytesOf.request).toString('base64'),
          responseBase64: Buffer.from(bytesOf.response).toString('base64'),
          responseAuthSigningBase64: 'AA==',
          requestHash: `0x${'44'.repeat(32)}`,
          responseHash: `0x${'55'.repeat(32)}`,
        },
        failureReason: null,
      }
    },
    close() {},
  } as unknown as Parameters<typeof runOutputCap>[0]['responseAuthReader']
  return { fetchFn, responseAuthReader, bodies }
}

/** The model's own host keeps the limit: it answers `cap` words and bills `cap`. */
const keptReply: CapReferenceReply = async (prompt, cap) => ({
  requestBody: bytes({ messages: [{ role: 'user', content: prompt }], max_tokens: cap }),
  response: { statusCode: 200, body: bytes({ choices: [{ message: { content: Array.from({ length: cap }, () => 'one').join(' ') }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: cap } }) },
})

/** A reference that counts one token per word, from one provider, never cached: A + B minus A is B's word count. */
const wordReference: TokenizerReferenceAsk = async (contents) => ({
  upstream: { kind: 'test' },
  results: contents.map((content) => ({ inputTokens: 10 + content.trim().split(/\s+/).length, cachedInput: false, provider: 'maker', failure: null })),
})

const runOn = async (seller: ReturnType<typeof fakeSeller>, ask: TokenizerReferenceAsk = wordReference) => {
  const reference = await prepareOutputCapReference({ askReply: keptReply, ask })
  return runOutputCap({
    proxyBaseUrl: 'http://127.0.0.1:1', peerId: PEER, service: SERVICE,
    responseAuthReader: seller.responseAuthReader, limiter: new ConcurrencyLimiter(1), fetchFn: seller.fetchFn,
    reference, ask, thinking: null,
  })
}

test('an honest seller stops at the limit: one request, pass, and the record rechecks at submit', async () => {
  const seller = fakeSeller((cap) => ({ text: words(Math.floor(cap / 3)), billed: cap }))
  const record = await runOn(seller)
  assert.equal(record.outcome, 'pass')
  assert.equal(record.asks.length, 1)
  assert.equal(record.asks[0]!.class, 'within')
  assert.equal(seller.bodies[0]!['max_tokens'], record.asks[0]!.cap)
  assert.equal(outputCapRequestCount(record), 1)
  validateOutputCap(record)
})

test('a seller that ignores the limit twice is flagged, the record rechecks, and an altered record does not', async () => {
  const seller = fakeSeller(() => ({ text: words(120), billed: 900 }))
  const record = await runOn(seller)
  assert.equal(record.outcome, 'flag')
  assert.deepEqual(record.asks.map((ask) => ask.class), ['cap-ignored', 'cap-ignored'])
  assert.ok(record.asks.every((ask) => measuredTokens(ask.measurement)! > 2 * ask.cap))
  validateOutputCap(record)
  assert.match(describeOutputCapFlag(record), /^cap check \(output-cap-v1\): billed 900 output tokens on a limit of \d+, and the answer alone measures \d+; asked again, /)
  assert.deepEqual(summarizeOutputCap(record).asks.map((ask) => ask.class), ['cap-ignored', 'cap-ignored'])
  const altered = structuredClone(record)
  altered.asks[1]!.reading = { ...altered.asks[1]!.reading!, billedOutputTokens: 10 }
  assert.throws(() => validateOutputCap(altered), /reading differs from the signed bytes/)
  const relabelled = structuredClone(record)
  relabelled.outcome = 'pass'
  assert.throws(() => validateOutputCap(relabelled), /outcome is pass, its asks give flag/)
  const remeasured = structuredClone(record)
  remeasured.asks[0]!.measurement!.b = ' one, two'
  assert.throws(() => validateOutputCap(remeasured), /not of the answer the seller signed/)
})

test('ignored once and honoured when asked again decides nothing', async () => {
  const seller = fakeSeller((cap, call) => (call === 1 ? { text: words(120), billed: 900 } : { text: words(3), billed: cap }))
  const record = await runOn(seller)
  assert.equal(record.outcome, 'inconclusive')
  assert.deepEqual(record.asks.map((ask) => ask.class), ['cap-ignored', 'within'])
  validateOutputCap(record)
})

test('reasoning billed outside the limit, itemised, is not a flag even when asked twice', async () => {
  const seller = fakeSeller((cap) => ({ text: words(2), billed: cap + 400, reasoning: 400 }))
  const record = await runOn(seller)
  assert.equal(record.outcome, 'pass')
  assert.equal(record.asks[0]!.class, 'reasoning-outside-cap')
})

test('a reference that cannot measure a count makes the check not apply: no seller is asked', async () => {
  const silent: TokenizerReferenceAsk = async (contents) => ({ upstream: null, results: contents.map(() => ({ inputTokens: null, failure: 'no usage' })) })
  const cached: TokenizerReferenceAsk = async (contents) => ({ upstream: null, results: contents.map((content) => ({ inputTokens: content.length, cachedInput: true, provider: 'maker', failure: null })) })
  for (const ask of [silent, cached]) {
    const reference = await prepareOutputCapReference({ askReply: keptReply, ask })
    assert.equal(reference.applies, false)
    const seller = fakeSeller(() => ({ text: words(120), billed: 900 }))
    const screen = createOutputCapScreen<null>({
      proxyBaseUrl: 'http://127.0.0.1:1', responseAuthReader: seller.responseAuthReader, limiter: new ConcurrencyLimiter(1), fetchFn: seller.fetchFn, ask: () => ask, askReply: () => keptReply,
    })
    assert.equal(await screen.check({ peerId: PEER, service: SERVICE }, null, null), null)
    assert.equal(seller.bodies.length, 0)
  }
})

test('the screen measures the reference once for every seller of the model', async () => {
  let asked = 0
  const counting: TokenizerReferenceAsk = async (contents, signal) => { asked += 1; return wordReference(contents, signal) }
  const seller = fakeSeller((cap) => ({ text: words(2), billed: cap }))
  const screen = createOutputCapScreen<null>({
    proxyBaseUrl: 'http://127.0.0.1:1', responseAuthReader: seller.responseAuthReader, limiter: new ConcurrencyLimiter(1), fetchFn: seller.fetchFn, ask: () => counting, askReply: () => keptReply,
  })
  await Promise.all([screen.check({ peerId: PEER, service: SERVICE }, null, null), screen.check({ peerId: PEER, service: SERVICE }, null, null)])
  assert.equal(asked, 1, 'within the limit: only the reference test asked the reference')
})

test('a cap record of every outcome, written to its evidence file, passes the check submit makes', async () => {
  const records = {
    pass: await runOn(fakeSeller((cap) => ({ text: words(Math.floor(cap / 3)), billed: cap }))),
    flag: await runOn(fakeSeller(() => ({ text: words(120), billed: 900 }))),
    // Billed far over the limit, on two lines the reference cannot measure: unexplained.
    inconclusive: await runOn(fakeSeller(() => ({ text: `${words(40)}\n${words(40)}`, billed: 900 }))),
  }
  // A dry pass's record: an answer within the limit, measured too.
  const measuredWithin = await runOutputCap({
    proxyBaseUrl: 'http://127.0.0.1:1', peerId: PEER, service: SERVICE, ...(() => { const seller = fakeSeller((cap) => ({ text: words(Math.floor(cap / 3)), billed: cap })); return { responseAuthReader: seller.responseAuthReader, fetchFn: seller.fetchFn } })(),
    limiter: new ConcurrencyLimiter(1), reference: await prepareOutputCapReference({ askReply: keptReply, ask: wordReference }), ask: wordReference, thinking: null, measureWithin: true,
  })
  assert.notEqual(measuredWithin.asks[0]!.measurement, null)
  assert.deepEqual(Object.entries(records).map(([name, record]) => [name, record.outcome]), [['pass', 'pass'], ['flag', 'flag'], ['inconclusive', 'inconclusive']])
  const directory = await mkdtemp(join(tmpdir(), 'antseed-output-cap-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const seller = (agentId: string, verdict: FixtureAudit['verdict'], outputCap: OutputCapV1): FixtureAudit => ({
      agentId, seller: new Wallet(Wallet.createRandom().privateKey), model: 'model-a', service: 'model-a', verdict, outputCap,
    })
    const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor, audits: [
      seller('1', 'SAME', records.pass), seller('2', 'DIFF', records.flag), seller('3', 'SAME', records.inconclusive), seller('4', 'SAME', measuredWithin),
    ] })
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address, config: FIXTURE_CONFIG,
    })
    assert.deepEqual(prepared.excluded, [])
    assert.deepEqual(prepared.audits[0]?.results.map((result) => [result.agentId, result.verdict]), [[1n, VERIFIER_VERDICT.SAME], [2n, VERIFIER_VERDICT.DIFF], [3n, VERIFIER_VERDICT.SAME], [4n, VERIFIER_VERDICT.SAME]])
    assert.deepEqual(prepared.audits[0]?.evidence.results.map((result) => result.flaggedBy), [[], ['output-cap'], [], []])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the reader abstains on an error sent with choices, several choices, and usage without an output count', () => {
  const body = (value: unknown) => ({ statusCode: 200, body: bytes(value) })
  const answer = { choices: [{ message: { content: words(80) }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: 900 } }
  assert.equal(readOutput(capped(16), body({ ...answer, error: { message: 'upstream failed' } })).billedOutputTokens, null)
  assert.equal(readOutput(capped(16), body({ ...answer, choices: [answer.choices[0], answer.choices[0]] })).billedOutputTokens, null)
  assert.equal(readOutput(capped(16), body({ ...answer, usage: { prompt_tokens: 20 } })).billedOutputTokens, null, 'input usage only is not a signed output count')
  assert.equal(classifyCapAnswer(readOutput(capped(16), body({ ...answer, usage: { prompt_tokens: 20 } })), 16, null), 'unread')
  assert.equal(readOutput(capped(16), body(answer)).billedOutputTokens, 900, 'a valid answer that stopped at the limit stays readable')
  assert.equal(readOutput(capped(16), body({ ...answer, usage: { completion_tokens: -1, output_tokens: 900 } })).billedOutputTokens, null, 'every output count present must be valid')
  assert.equal(readOutput(capped(16), body({ ...answer, usage: { completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 901 } } })).billedOutputTokens, null, 'reasoning above the billed output')
})

test('the prompt is found in the signed request in every shape the proxy translates to', () => {
  const prompt = 'Count upward from 300'
  assert.equal(requestCarriesPrompt(bytes({ messages: [{ role: 'user', content: prompt }] }), prompt), true)
  assert.equal(requestCarriesPrompt(bytes({ messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }), prompt), true)
  assert.equal(requestCarriesPrompt(bytes({ input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] }), prompt), true)
  assert.equal(requestCarriesPrompt(bytes({ input: prompt }), prompt), true)
  assert.equal(requestCarriesPrompt(bytes({ messages: [{ role: 'user', content: 'Count upward from 301' }] }), prompt), false)
  assert.equal(requestCarriesPrompt(bytes({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'hi' }] }), prompt), false, 'only a user turn counts')
  assert.equal(requestCarriesPrompt(bytes({ metadata: { note: prompt }, messages: [{ role: 'user', content: 'hi' }] }), prompt), false)
})

test('two asks must be two requests, and the request sentence varies', async () => {
  const record = await runOn(fakeSeller(() => ({ text: words(120), billed: 900 })))
  const copied = structuredClone(record)
  copied.asks[1] = structuredClone(copied.asks[0]!)
  assert.throws(() => validateOutputCap(copied), /repeats a request ID/)
  const sentences = new Set(Array.from({ length: 4 }, (_unused, index) => outputCapPrompt(() => index).prompt.split(' 10')[0]))
  assert.equal(sentences.size, 4)
})

test('a check that fails is an inconclusive record, which rechecks at submit', () => {
  validateOutputCap({ rule: OUTPUT_CAP_RULE, outcome: 'inconclusive', reason: 'the check failed: boom', asks: [] })
  assert.throws(() => validateOutputCap({ rule: OUTPUT_CAP_RULE, outcome: 'pass', reason: '', asks: [] }), /without asks must be inconclusive/)
})

test('a dry pass measures answers that kept to the limit too, and the record still rechecks', async () => {
  const seller = fakeSeller((cap) => ({ text: words(Math.floor(cap / 3)), billed: cap }))
  const reference = await prepareOutputCapReference({ askReply: keptReply, ask: wordReference })
  const record = await runOutputCap({
    proxyBaseUrl: 'http://127.0.0.1:1', peerId: PEER, service: SERVICE,
    responseAuthReader: seller.responseAuthReader, limiter: new ConcurrencyLimiter(1), fetchFn: seller.fetchFn,
    reference, ask: wordReference, thinking: null, measureWithin: true,
  })
  assert.equal(record.asks[0]!.class, 'within')
  assert.notEqual(measuredTokens(record.asks[0]!.measurement), null)
  validateOutputCap(record)
})

test('the prompt is found in requests the buyer proxy translates for a seller on Messages or Responses', () => {
  for (const body of [
    outputCapRequestBody({ service: 's', prompt: outputCapPrompt(() => 1).prompt, cap: 24 }),
    outputEchoRequestBody({ service: 's', text: 'The parcel weighs 4.20 kg.' }),
  ]) {
    const prompt = (body['messages'] as Array<{ content: string }>)[0]!.content
    for (const to of ['anthropic-messages', 'openai-responses'] as const) {
      const translated = transformRequest(
        { requestId: 'r', method: 'POST', path: '/v1/chat/completions', headers: {}, body: bytes(body) },
        { from: 'openai-chat-completions', to },
      )
      assert.ok(translated, to)
      assert.equal(requestCarriesPrompt(translated.request.body, prompt), true, to)
    }
  }
})

test('the cap check applies only when the model\'s own host keeps the limit and its answer measures what it billed', async () => {
  const kept = await prepareOutputCapReference({ ask: wordReference, askReply: keptReply })
  assert.equal(kept.applies, true)
  assert.deepEqual([kept.ownReply?.billed, kept.ownReply?.measured === kept.ownReply?.cap], [kept.ownReply?.cap, true])
  // The host bills 900 and delivers a long answer: every honest seller passing the request through would look the same.
  const ignoring: CapReferenceReply = async (prompt, cap) => ({
    requestBody: bytes({ messages: [{ role: 'user', content: prompt }], max_tokens: cap }),
    response: { statusCode: 200, body: bytes({ choices: [{ message: { content: words(200) }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 900 } }) },
  })
  const loose = await prepareOutputCapReference({ ask: wordReference, askReply: ignoring })
  assert.equal(loose.applies, false)
  assert.match(loose.reason, /the model's own host billed 900 on a limit of \d+/)
  // Within the limit, but the answer measures far from what was billed: the measurement's scale is not trusted.
  const offScale: CapReferenceReply = async (prompt, cap) => ({
    requestBody: bytes({ messages: [{ role: 'user', content: prompt }], max_tokens: cap }),
    response: { statusCode: 200, body: bytes({ choices: [{ message: { content: 'one two' }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: cap } }) },
  })
  const scale = await prepareOutputCapReference({ ask: wordReference, askReply: offScale })
  assert.equal(scale.applies, false)
  assert.match(scale.reason, /own answer measures 2 where it billed \d+ for it/)
  const silent = await prepareOutputCapReference({ ask: wordReference, askReply: async () => null })
  assert.match(silent.reason, /own answer to a capped request could not be read/)
})

test('the cap measurement and the reference\'s own reply decline a route that may serve several providers and names none', async () => {
  const unnamed: TokenizerReferenceAsk = async (contents, signal) => {
    const asked = await wordReference(contents, signal)
    return { ...asked, oneProvider: false, results: asked.results.map((result) => ({ ...result, provider: null })) } as Awaited<ReturnType<TokenizerReferenceAsk>>
  }
  const reference = await prepareOutputCapReference({ ask: unnamed, askReply: keptReply })
  assert.equal(reference.applies, false)
  assert.match(reference.reason, /could not measure its own answer \(the reference's route may serve several providers and names none\)/)
  const unnamedReply: CapReferenceReply = async (prompt, cap) => ({ ...(await keptReply(prompt, cap))!, provider: null, oneProvider: false })
  const replied = await prepareOutputCapReference({ ask: wordReference, askReply: unnamedReply })
  assert.match(replied.reason, /route may serve several providers and names none/)
})

test('the reference is asked at the lowest limit, so a host with a floor above twice it declines for exactly the sellers it would flag', async () => {
  const limits: number[] = []
  const floored = (floor: number): CapReferenceReply => async (prompt, cap) => {
    limits.push(cap)
    const billed = Math.max(cap, floor)
    return {
      requestBody: bytes({ messages: [{ role: 'user', content: prompt }], max_tokens: cap }),
      response: { statusCode: 200, body: bytes({ choices: [{ message: { content: Array.from({ length: billed }, () => 'one').join(' ') }, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: billed } }) },
    }
  }
  // A floor of 64: a seller drawing any limit up to 31 bills over twice it, so the reference declines.
  const high = await prepareOutputCapReference({ ask: wordReference, askReply: floored(64) })
  assert.equal(high.applies, false)
  assert.match(high.reason, /billed 64 on a limit of 16/)
  // A floor of 30: no seller answer measures over twice its limit, so nothing is flagged and the check applies.
  const low = await prepareOutputCapReference({ ask: wordReference, askReply: floored(30) })
  assert.equal(low.applies, true)
  assert.deepEqual([...new Set(limits)], [OUTPUT_CAP_RULE.minCap])
})

test('the cap reference says when its route raises the reply limit, and keeps the failure text', async () => {
  const raised: CapReferenceReply = async (prompt, cap) => ({ ...(await keptReply(prompt, cap))!, requestBody: bytes({ messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }) })
  assert.match((await prepareOutputCapReference({ ask: wordReference, askReply: raised })).reason, /route raises the reply limit to 1024/)
  const failing: CapReferenceReply = async () => { throw new Error('upstream answered 503') }
  assert.match((await prepareOutputCapReference({ ask: wordReference, askReply: failing })).reason, /could not be read \(upstream answered 503\)/)
})
