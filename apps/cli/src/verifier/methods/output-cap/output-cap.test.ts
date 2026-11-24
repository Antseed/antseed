import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import { prepareModelAudits } from '../../model-audit.js'
import { FIXTURE_CONFIG, peerIdOf, writeSignedAuditRun, type FixtureAudit } from '../../model-audit-fixtures.test-support.js'
import { fakeCapSeller as fakeSeller, keptReply, runCapOn as runOn, wordReference } from '../shared/output-checks.test-support.js'
import test from 'node:test'
import { transformRequest } from '@antseed/api-adapter'
import { outputEchoRequestBody } from '../output-echo/output-echo.js'
import { ConcurrencyLimiter } from '../../audit-concurrency.js'
import { readOutput, requestCarriesPrompt, type OutputReadingV1 } from '../shared/output-usage.js'
import type { TokenizerReferenceAsk } from '../tokens/tokenizer-precheck.js'
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
  capScaleFrom,
  capScaleHolds,
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
  // The reference test's one measurement asks once per fresh message (A, then A + answer each time).
  assert.equal(asked, OUTPUT_CAP_RULE.referenceAsks, 'within the limit: only the reference test asked the reference')
})

test('a cap record of every outcome, written to its evidence file, passes the check submit makes', async () => {
  // Each record is made for the seller the fixture writes it under, so its replies are signed by that seller.
  const wallets = Array.from({ length: 4 }, () => new Wallet(Wallet.createRandom().privateKey))
  const peerOf = (index: number) => peerIdOf(wallets[index]!)
  const records = {
    pass: await runOn(fakeSeller((cap) => ({ text: words(Math.floor(cap / 3)), billed: cap })), wordReference, peerOf(0)),
    flag: await runOn(fakeSeller(() => ({ text: words(120), billed: 900 })), wordReference, peerOf(1)),
    // Billed far over the limit, on two lines the reference cannot measure: unexplained.
    inconclusive: await runOn(fakeSeller(() => ({ text: `${words(40)}\n${words(40)}`, billed: 900 })), wordReference, peerOf(2)),
  }
  // A dry pass's record: an answer within the limit, measured too.
  const measuredWithin = await runOutputCap({
    proxyBaseUrl: 'http://127.0.0.1:1', peerId: peerOf(3), service: SERVICE, ...(() => { const seller = fakeSeller((cap) => ({ text: words(Math.floor(cap / 3)), billed: cap })); return { responseAuthReader: seller.responseAuthReader, fetchFn: seller.fetchFn } })(),
    limiter: new ConcurrencyLimiter(1), ask: wordReference, thinking: null, measureWithin: true,
  })
  assert.notEqual(measuredWithin.asks[0]!.measurement, null)
  assert.deepEqual(Object.entries(records).map(([name, record]) => [name, record.outcome]), [['pass', 'pass'], ['flag', 'flag'], ['inconclusive', 'inconclusive']])
  const directory = await mkdtemp(join(tmpdir(), 'antseed-output-cap-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    // Stored under the seller and the service its replies were signed by and for.
    // The questions say SAME for each; the cap check with no result keeps its seller from SAME (every active test must pass).
    const seller = (agentId: string, verdict: FixtureAudit['verdict'], outputCap: OutputCapV1): FixtureAudit => ({
      agentId, seller: wallets[Number(agentId) - 1]!, model: 'model-a', service: SERVICE, verdict, questionsVerdict: 'SAME', outputCap,
    })
    const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor, audits: [
      seller('1', 'SAME', records.pass), seller('2', 'DIFF', records.flag), seller('3', 'UNDETERMINED', records.inconclusive), seller('4', 'SAME', measuredWithin),
    ] })
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address, config: FIXTURE_CONFIG,
    })
    assert.deepEqual(prepared.excluded, [])
    assert.deepEqual(prepared.audits[0]?.results.map((result) => [result.agentId, result.verdict]), [[1n, VERIFIER_VERDICT.SAME], [2n, VERIFIER_VERDICT.DIFF], [3n, VERIFIER_VERDICT.UNDETERMINED], [4n, VERIFIER_VERDICT.SAME]])
    assert.deepEqual(prepared.audits[0]?.evidence.results.map((result) => result.flaggedBy), [[], ['output-cap'], [], []])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a cap record stored under another seller than the one that signed it is refused at submit', async () => {
  const [signer, other] = [0, 1].map(() => new Wallet(Wallet.createRandom().privateKey))
  const record = await runOn(fakeSeller(() => ({ text: words(120), billed: 900 })), wordReference, peerIdOf(signer!))
  assert.equal(record.outcome, 'flag')
  const directory = await mkdtemp(join(tmpdir(), 'antseed-output-cap-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor, audits: [
      { agentId: '1', seller: other!, model: 'model-a', service: SERVICE, verdict: 'DIFF', outputCap: record },
    ] })
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address, config: FIXTURE_CONFIG,
    })
    assert.equal(prepared.audits.length, 0)
    assert.match(prepared.excluded[0]!.reason, /invalid audit evidence: the cap check: a reply is not signed by the seller it is stored for/)
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
  const record = await runOutputCap({
    proxyBaseUrl: 'http://127.0.0.1:1', peerId: PEER, service: SERVICE,
    responseAuthReader: seller.responseAuthReader, limiter: new ConcurrencyLimiter(1), fetchFn: seller.fetchFn,
    ask: wordReference, thinking: null, measureWithin: true,
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

test('a reference whose host caches a prompt of its own on every answer measures answers, for itself and for sellers', async () => {
  // Grok 4.7 on xAI: the host adds a prompt of its own to every request and reports it as cached, the same amount on A
  // and on A + B; a text asked again has more of it cached. Each ask's A is fresh, so the cache cancels within each ask.
  const seen = new Map<string, number>()
  const hostCache: TokenizerReferenceAsk = async (contents) => ({
    upstream: { kind: 'test' },
    results: contents.map((content) => {
      const times = (seen.get(content) ?? 0) + 1
      seen.set(content, times)
      return { inputTokens: 1240 + content.trim().split(/\s+/).length, cachedInput: true, cache: { 'prompt_tokens_details.cached_tokens': times > 1 ? 1280 : 1152 }, provider: 'xAI', failure: null }
    }),
  })
  const reference = await prepareOutputCapReference({ ask: hostCache, askReply: keptReply })
  assert.equal(reference.applies, true, reference.reason)
  assert.equal(reference.ownReply?.measured, reference.ownReply?.cap)
  // A seller's long answer is measured on that reference: flagged when it ignores the limit twice, and rechecked at submit.
  const ignoring = fakeSeller(() => ({ text: words(120), billed: 900 }))
  const record = await runOn(ignoring, hostCache)
  assert.equal(record.outcome, 'flag')
  assert.doesNotThrow(() => validateOutputCap(record))
  // A cached amount that differs between A and A + B, the same way on every ask, shows nothing: unmeasured.
  const uneven: TokenizerReferenceAsk = async (contents) => ({
    upstream: { kind: 'test' },
    results: contents.map((content, index) => ({ inputTokens: 1240 + content.trim().split(/\s+/).length, cachedInput: true, cache: { 'prompt_tokens_details.cached_tokens': index % 2 === 0 ? 1152 : 1280 }, provider: 'xAI', failure: null })),
  })
  const unmeasured = await prepareOutputCapReference({ ask: uneven, askReply: keptReply })
  assert.equal(unmeasured.applies, false)
  assert.match(unmeasured.reason, /could not measure its own answer \(the reference reported cached input\)/)
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

// --- The reference's scale on a model that reasons through the lowest limit ---

/** `count` words of one token each at `wordReference`. */
const plain = (count: number): string => Array.from({ length: count }, () => 'one').join(' ')

/** The reference's replies, by limit and call; every limit it is asked at is captured. */
function referenceReplies(reply: (cap: number, call: number) => { text: string; billed: number; reasoning?: number }) {
  const limits: number[] = []
  const askReply: CapReferenceReply = async (prompt, cap) => {
    limits.push(cap)
    const { text, billed, reasoning } = reply(cap, limits.length)
    return {
      requestBody: bytes({ messages: [{ role: 'user', content: prompt }], max_tokens: cap, reasoning: { effort: 'minimal' }, stream: false }),
      response: chat(text, { prompt_tokens: 20, completion_tokens: billed, ...(reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) }),
      provider: 'maker', oneProvider: true,
    }
  }
  return { askReply, limits }
}

test('a model that reasons through the lowest limit shows its scale on a second reply at a larger limit, and the check applies', async () => {
  // All 16 tokens billed as reasoning at the lowest limit; at the larger limit some reasoning, then a long answer.
  const reference = referenceReplies((cap) => (cap === OUTPUT_CAP_RULE.minCap ? { text: '', billed: cap, reasoning: cap } : { text: plain(400), billed: cap, reasoning: cap - 400 }))
  const record = await prepareOutputCapReference({ ask: wordReference, askReply: reference.askReply })
  assert.equal(record.applies, true, record.reason)
  assert.deepEqual(reference.limits, [OUTPUT_CAP_RULE.minCap, OUTPUT_CAP_RULE.scaleCap])
  assert.deepEqual(record.ownReply, { cap: 16, billed: 16, reasoning: 16, measured: null })
  assert.equal(record.measurement, null, 'an answer of nothing within the limit is not measured')
  assert.deepEqual({ ...record.scale, measurement: undefined }, { from: 'scale', cap: 512, billed: 512, reasoning: 112, measured: 400, measurement: undefined })
  assert.equal(measuredTokens(record.scale!.measurement!), 400)
  assert.match(record.reason, /kept a limit of 16 \(billed 16\) with 0 tokens of answer, and at a limit of 512 its answer measures 400 where it billed 400 for it/)
  // The request of each reply is kept, with the setting the reference was sent.
  assert.deepEqual(record.requests.map((body) => [(body as Record<string, unknown>)['max_tokens'], (body as Record<string, unknown>)['reasoning']]), [
    [16, { effort: 'minimal' }], [512, { effort: 'minimal' }],
  ])
  const prompts = record.requests.map((body) => ((body as { messages: Array<{ content: string }> }).messages[0]!.content))
  assert.notEqual(prompts[0], prompts[1], 'the second reply counts from another start')
})

test('a host that bills a few tokens per reply beyond its answer keeps the scale, within the framing allowance only', async () => {
  // Billed 5 tokens of answer more than the answer measures, at any length: a fixed framing, not a scale error.
  const framed = (extra: number) => referenceReplies((cap) => (cap === OUTPUT_CAP_RULE.minCap ? { text: '', billed: cap, reasoning: cap } : { text: plain(398), billed: cap, reasoning: cap - 398 - extra }))
  assert.equal((await prepareOutputCapReference({ ask: wordReference, askReply: framed(5).askReply })).applies, true)
  assert.equal((await prepareOutputCapReference({ ask: wordReference, askReply: framed(6).askReply })).applies, true)
  const beyond = await prepareOutputCapReference({ ask: wordReference, askReply: framed(7).askReply })
  assert.equal(beyond.applies, false)
  assert.match(beyond.reason, /its answer at a limit of 512 measures 398 where it billed 405 for it/)
  // An answer that measures more than billed is held to the tolerance, as before.
  const over = await prepareOutputCapReference({ ask: wordReference, askReply: referenceReplies((cap) => (cap === 16 ? { text: '', billed: 16, reasoning: 16 } : { text: plain(406), billed: cap, reasoning: cap - 403 })).askReply })
  assert.equal(over.applies, false)
  assert.match(over.reason, /measures 406 where it billed 403/)
})

test('the scale holds from the framing allowance below to the tolerance above, on an answer of at least the lowest limit', () => {
  assert.deepEqual(
    [[16, 16], [16, 18], [16, 19], [16, 10], [16, 9], [2, 1], [15, 15], [403, 398], [403, 397], [403, 396], [403, 405], [403, 406]].map(([billed, measured]) => capScaleHolds(billed!, measured!)),
    [true, true, false, true, false, false, false, true, true, false, true, false],
  )
  // The allowance keeps a passing scale below the flag: an honest answer at the limit cannot measure over twice it.
  const { minCap, tolerance, framingTokens, flagFactor } = OUTPUT_CAP_RULE
  assert.ok((minCap + tolerance) / (minCap - framingTokens) < flagFactor)
  assert.deepEqual([[16, null], [16, 0], [16, 16], [16, 14], [10, 0], [408, 392], [921, 905]].map(([billed, reasoning]) => capScaleFrom(billed!, reasoning ?? null)), [
    'limit', 'limit', 'scale', 'scale', 'scale', 'limit', 'limit',
  ])
})

test('a reply at the lowest limit that shows its answer is enough: the reference is not asked again', async () => {
  const reference = referenceReplies((cap) => ({ text: plain(cap), billed: cap, reasoning: 0 }))
  const record = await prepareOutputCapReference({ ask: wordReference, askReply: reference.askReply })
  assert.equal(record.applies, true)
  assert.deepEqual(reference.limits, [OUTPUT_CAP_RULE.minCap])
  assert.deepEqual(record.scale, { from: 'limit', cap: 16, billed: 16, reasoning: 0, measured: 16, measurement: null })
  assert.equal(record.requests.length, 1)
})

test('a host that bills a fixed few tokens on a short answer at the lowest limit applies', async () => {
  // Billed 16 for an answer that measures 12: 4 tokens of framing, inside the allowance.
  const record = await prepareOutputCapReference({ ask: wordReference, askReply: referenceReplies(() => ({ text: plain(12), billed: 16, reasoning: 0 })).askReply })
  assert.equal(record.applies, true, record.reason)
  assert.equal(record.scale?.from, 'limit')
  assert.equal(record.ownReply?.measured, 12)
})

test('a reply at the lowest limit with only a token or two of answer does not show the scale: the reference answers again', async () => {
  const reference = referenceReplies((cap) => (cap === 16 ? { text: plain(1), billed: 16, reasoning: 14 } : { text: plain(300), billed: cap, reasoning: cap - 300 }))
  const record = await prepareOutputCapReference({ ask: wordReference, askReply: reference.askReply })
  assert.deepEqual(reference.limits, [16, 512])
  assert.equal(record.applies, true)
  assert.equal(record.scale?.from, 'scale')
})

test('a second reply that is all reasoning, cannot be read, or cannot be measured leaves the check off, with its reason', async () => {
  const allReasoning = await prepareOutputCapReference({ ask: wordReference, askReply: referenceReplies((cap) => ({ text: '', billed: cap, reasoning: cap })).askReply })
  assert.equal(allReasoning.applies, false)
  assert.match(allReasoning.reason, /with 0 tokens of answer, and 0 at a limit of 512: too little answer to check the measurement's scale on, so the cap check does not apply/)
  assert.deepEqual(allReasoning.scale, { from: 'scale', cap: 512, billed: 512, reasoning: 512, measured: null, measurement: null })
  const { askReply: firstOnly } = referenceReplies(() => ({ text: '', billed: 16, reasoning: 16 }))
  const failing: CapReferenceReply = async (prompt, cap) => {
    if (cap === OUTPUT_CAP_RULE.scaleCap) throw new Error('upstream answered 503')
    return firstOnly(prompt, cap)
  }
  const failed = await prepareOutputCapReference({ ask: wordReference, askReply: failing })
  assert.equal(failed.applies, false)
  assert.match(failed.reason, /and the reference's answer at a limit of 512 could not be read \(upstream answered 503\)/)
  const cached: TokenizerReferenceAsk = async (contents) => ({ upstream: null, results: contents.map((content) => ({ inputTokens: content.length, cachedInput: true, provider: 'maker', failure: null })) })
  const unmeasured = await prepareOutputCapReference({ ask: cached, askReply: referenceReplies((cap) => (cap === 16 ? { text: '', billed: 16, reasoning: 16 } : { text: plain(300), billed: cap, reasoning: cap - 300 })).askReply })
  assert.equal(unmeasured.applies, false)
  assert.match(unmeasured.reason, /could not measure its answer at a limit of 512 \(the reference reported cached input\)/)
})

/**
 * A reference that counts one token per word and caches every text it has been sent: a text sent again reports cached
 * input, as a host with a prefix cache does for an identical prompt.
 */
function cachingReference(): TokenizerReferenceAsk {
  const seen = new Set<string>()
  return async (contents) => ({
    upstream: { kind: 'test' },
    results: contents.map((content) => {
      const cachedInput = seen.has(content)
      seen.add(content)
      return { inputTokens: 10 + content.trim().split(/\s+/).length, cachedInput, provider: 'maker', failure: null }
    }),
  })
}

test('each measurement ask sends its own fresh message, so a host that caches repeated prompts still measures the answer', async () => {
  const record = await runOn(fakeSeller(() => ({ text: words(120), billed: 900 })), cachingReference())
  assert.equal(record.outcome, 'flag', 'measured despite the cache: the limit was ignored twice')
  for (const ask of record.asks) {
    assert.equal(ask.measurement!.a.length, OUTPUT_CAP_RULE.referenceAsks)
    assert.equal(new Set(ask.measurement!.a).size, OUTPUT_CAP_RULE.referenceAsks, 'a fresh message for every ask')
    assert.equal(ask.measurement!.reference.asks.length, OUTPUT_CAP_RULE.referenceAsks)
  }
  validateOutputCap(record)
  // The reference's own measurement of its scale answer gets through the same cache.
  const reference = await prepareOutputCapReference({ ask: cachingReference(), askReply: referenceReplies((cap) => (cap === 16 ? { text: '', billed: 16, reasoning: 16 } : { text: plain(300), billed: cap, reasoning: cap - 300 })).askReply })
  assert.equal(reference.applies, true, reference.reason)
})
