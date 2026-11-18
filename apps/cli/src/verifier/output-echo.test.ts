import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { prepareModelAudits } from './model-audit.js'
import { FIXTURE_CONFIG, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'
import test from 'node:test'
import { encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import { isSafeProbe } from '@antseed/node/payments'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import type { OutputReadingV1 } from './output-usage.js'
import {
  OUTPUT_ECHO_RULE,
  createOutputEchoScreen,
  describeOutputEchoFlag,
  echoCrowdObjection,
  outputEchoPrompt,
  outputEchoRequestCount,
  validateOutputEcho,
  type EchoReferenceAsk,
  judgeEchoRound,
  judgeOutputEcho,
  readEchoReply,
  referenceEchoCount,
  writeEchoText,
  type EchoCrowdVoteV1,
  type EchoSellerAskV1,
  type OutputEchoV1,
} from './output-echo.js'

const TEXT = 'The parcel weighs 4.20 kg and ships on Monday.'

const reading = (overrides: Partial<OutputReadingV1> = {}): OutputReadingV1 => ({
  cap: 1024, oneAnswer: true, stops: false, billedOutputTokens: 60, estimated: false, reasoningTokens: null,
  reasoningMarker: false, text: TEXT, finished: true, shape: 'chat', ...overrides,
})

/** An ask whose reply counts `count` (plain), or `count` visible with `reasoning` itemised. */
const ask = (count: number | null, reasoning = 0): EchoSellerAskV1 => ({
  request: {} as never,
  reading: null,
  reply: count === null ? { count: null, reasoning, unusable: 'not finished' } : { count, reasoning, unusable: null },
})

/** Reference: short texts count 60, long ones 360 (a gap of 300). */
const REFERENCE: OutputEchoV1['reference'] = Array.from({ length: 3 }, () => ({ short: { text: 's', count: 60 }, long: { text: 'l', count: 360 } }))
const REF = { short: 60, long: 360 }

/** A seller's round from its short and long counts per ask. */
const round = (asks: Array<[number | null, number | null]>, mode: 'plain' | 'visible' = 'plain') => {
  const short = asks.map(([value]) => ask(value))
  const long = asks.map(([, value]) => ask(value))
  return { short, long, ...judgeEchoRound({ short, long, reference: REF, referenceReasoning: 0, mode }) }
}

const vote = (growth: number | null, offset: number | null = 0, reasoning = 0): EchoCrowdVoteV1 => ({
  peerId: `peer-${Math.random()}`, short: ask(null), long: ask(null), growth, offset, reasoning,
})

test('an echo is usable only when signed, finished, one answer, byte for byte, and without reasoning in plain mode', () => {
  assert.deepEqual(readEchoReply(reading(), TEXT, 'plain'), { count: 60, reasoning: 0, unusable: null })
  for (const [overrides, why] of [
    [{ estimated: true }, 'no signed usage'],
    [{ finished: false }, 'not finished'],
    [{ text: `${TEXT}\n` }, 'the text was changed'],
    [{ text: TEXT.toUpperCase() }, 'the text was changed'],
    [{ reasoningMarker: true }, 'reasoning shown'],
    [{ oneAnswer: false }, 'not one plain answer'],
    [{ shape: null }, 'no reading'],
  ] as const) {
    assert.equal(readEchoReply(reading(overrides), TEXT, 'plain').unusable, why)
  }
  // Visible mode: the count is billed minus itemised reasoning, and a reply that does not itemise is not usable.
  assert.deepEqual(readEchoReply(reading({ billedOutputTokens: 69, reasoningTokens: 9, reasoningMarker: true }), TEXT, 'visible'), { count: 60, reasoning: 9, unusable: null })
  assert.equal(readEchoReply(reading({ reasoningMarker: true }), TEXT, 'visible').unusable, 'reasoning not itemised')
})

test('the reference counts a text only when its two asks agree, from one provider', () => {
  const asked = (count: number | null, provider = 'maker', unusable: string | null = null) => ({ count, reasoning: 0, provider, unusable })
  assert.deepEqual(referenceEchoCount([asked(60), asked(60)]), { count: 60, failure: null })
  assert.match(referenceEchoCount([asked(60), asked(64)]).failure!, /did not agree with itself/)
  assert.match(referenceEchoCount([asked(60), asked(60, 'other')]).failure!, /more than one provider/)
  assert.match(referenceEchoCount([asked(60), asked(null, 'maker', 'not finished')]).failure!, /not usable \(not finished\)/)
  assert.match(referenceEchoCount([asked(60)]).failure!, /asked 1 of 2 times/)
})

test('a round is over only when its growth repeats; a constant offset cancels', () => {
  assert.equal(round([[60, 360]]).verdict, 'within')
  // A host that adds 3 tokens to every reply: growth 0.
  assert.deepEqual(round([[63, 363]]).growths, [0])
  assert.equal(round([[63, 363]]).verdict, 'within')
  // 2% more on output: 66 more on long, 1 more on short → growth 5, over; it repeats.
  assert.equal(round([[61, 366], [61, 366]]).verdict, 'over')
  // Over once and within when asked again: within.
  assert.equal(round([[61, 366], [60, 360]]).verdict, 'within')
  // Both over but further apart than the tolerance: unstable, decides nothing.
  assert.equal(round([[61, 366], [61, 380]]).verdict, 'unstable')
  // Over but not asked again, or the second ask not usable: unusable.
  assert.equal(round([[61, 366]]).verdict, 'unusable')
  assert.equal(round([[61, 366], [null, 366]]).verdict, 'unusable')
  assert.equal(round([[null, 360]]).verdict, 'unusable')
})

test('in visible mode the tolerance grows with the round\'s reasoning and the seller\'s own two asks must agree', () => {
  const short = [ask(60, 9), ask(61, 8)]
  const long = [ask(366, 9), ask(366, 7)]
  const judged = judgeEchoRound({ short, long, reference: REF, referenceReasoning: 4, mode: 'visible' })
  assert.equal(judged.tolerance, 2 + 9)
  assert.equal(judged.verdict, 'within', 'a growth of 6 is within 2 plus the 9 tokens of reasoning seen')
  const drifting = judgeEchoRound({ short: [ask(60, 1), ask(64, 1)], long: [ask(360, 1), ask(360, 1)], reference: REF, referenceReasoning: 0, mode: 'visible' })
  assert.equal(drifting.verdict, 'unstable')
  assert.equal(judgeEchoRound({ short: [ask(60, 1)], long: [ask(360, 1)], reference: REF, referenceReasoning: 0, mode: 'visible' }).verdict, 'unusable', 'asked twice whatever it gives')
})

test('the crowd must back the reference, measure enough sellers, share nothing, and the amount must stand out', () => {
  const honest = [0, 1, -1, 0]
  assert.equal(echoCrowdObjection(93, honest, 15), null)
  assert.match(echoCrowdObjection(93, honest, 35)!, /spread \(35\)/, 'the seller\'s own spread counts too')
  assert.match(echoCrowdObjection(93, [0, 1], 0)!, /2 of the model's other sellers could be measured, 3 are needed/)
  assert.match(echoCrowdObjection(93, [0, 9, 12, null], 0)!, /1 of the model's other sellers sign the reference's count, 2 are needed/)
  assert.match(echoCrowdObjection(93, [0, 0, 92], 0)!, /signs the same amount/)
  // A crowd spread of 30 needs the amount 90 above the median.
  assert.match(echoCrowdObjection(60, [0, 0, 30], 0)!, /not more than 3 times the other sellers' spread \(30\)/)
})

const judge = (rounds: ReturnType<typeof round>[], crowd: EchoCrowdVoteV1[] | null, options: { precheckMatch?: boolean; incomplete?: boolean; referenceReasoning?: number } = {}) => judgeOutputEcho({
  mode: 'plain', reference: REFERENCE, referenceReasoning: options.referenceReasoning ?? 0, rounds,
  precheckMatch: options.precheckMatch ?? true, crowd: crowd ? { votes: crowd, incomplete: options.incomplete ?? false } : null,
})

test('an honest seller and one that adds a small constant are consistent, and nobody else is asked', () => {
  const honest = judge([round([[60, 360]]), round([[60, 360]]), round([[60, 360]])], null)
  assert.deepEqual([honest.outcome, honest.needsCrowd], ['pass', false])
  const constant = judge([round([[63, 363]]), round([[63, 363]]), round([[63, 363]])], null)
  assert.deepEqual([constant.outcome, constant.offset], ['pass', { median: 3, fixed: true }])
})

test('a seller that grows far faster than the model, twice in every round, is flagged only behind a crowd that backs the reference', () => {
  // The known real case: growth of about 100 tokens on a gap of 300.
  const inflating = [round([[60, 460], [60, 460]]), round([[60, 470], [60, 470]]), round([[60, 455], [60, 456]])]
  assert.deepEqual([judge(inflating, null).outcome, judge(inflating, null).needsCrowd], ['inconclusive', true])
  const flagged = judge(inflating, [vote(0), vote(1), vote(-1)])
  assert.deepEqual([flagged.outcome, flagged.flag], ['flag', 'growth'])
  assert.match(flagged.reason, /grows 95 or more tokens faster than the model's/)
  // Without a pre-check match, an incomplete crowd, or a crowd that signs the same growth: nothing is decided.
  assert.equal(judge(inflating, [vote(0), vote(1), vote(-1)], { precheckMatch: false }).outcome, 'inconclusive')
  assert.equal(judge(inflating, [vote(0), vote(1), vote(-1)], { incomplete: true }).outcome, 'inconclusive')
  assert.match(judge(inflating, [vote(0), vote(1), vote(96)]).reason, /growth: another seller of the model signs the same amount/)
  // Reasoning seen on these texts above the growth: not a flag.
  assert.match(judge(inflating, [vote(0), vote(1), vote(-1, 0, 120)]).reason, /not above the 120 tokens of reasoning seen/)
})

test('a relay that drops reasoning and reports zero (16 to 17 tokens, about 6% of the gap) is not flagged', () => {
  const relay = [round([[60, 377], [60, 376]]), round([[60, 377], [60, 377]]), round([[60, 376], [60, 377]])]
  assert.ok(relay.every((entry) => entry.verdict === 'over'))
  const judged = judge(relay, [vote(0), vote(16, 0, 16), vote(0)])
  assert.equal(judged.outcome, 'inconclusive')
  assert.match(judged.reason, /not above 20 tokens and 10% of the reference's gap in every round/)
})

test('a seller that adds the same large amount to every reply is flagged as an offset only behind the crowd', () => {
  const padded = [round([[90, 390]]), round([[90, 390]]), round([[91, 390]])]
  assert.equal(padded.every((entry) => entry.verdict === 'within'), true)
  const flagged = judge(padded, [vote(0, 0), vote(0, 3), vote(0, -1)])
  assert.deepEqual([flagged.outcome, flagged.flag, flagged.offset.median], ['flag', 'offset', 30])
  // A small constant is never an offset flag, nor one another seller shares (a relay), nor one that varies.
  assert.equal(judge([round([[75, 375]]), round([[75, 375]]), round([[75, 375]])], null).outcome, 'pass')
  assert.match(judge(padded, [vote(0, 0), vote(0, 30), vote(0, -1)]).reason, /offset: another seller of the model signs the same amount/)
  const varying = [round([[90, 390]]), round([[80, 380]]), round([[90, 390]])]
  assert.equal(judge(varying, null).outcome, 'pass')
})

test('a round that cannot be read or does not repeat decides nothing', () => {
  assert.match(judge([round([[60, 360]]), round([[null, 360]]), round([[60, 360]])], null).reason, /a round was unusable/)
  assert.match(judge([round([[60, 360]]), round([[61, 366], [61, 390]]), round([[60, 360]])], null).reason, /a round was unstable/)
  assert.match(judge([round([[60, 360]])], null).reason, /not every round was asked/)
})

test('the texts are guard-safe single paragraphs without quotation marks, and a long one is four short ones long', () => {
  for (let index = 0; index < 20; index += 1) {
    const short = writeEchoText('short')
    const long = writeEchoText('long')
    for (const text of [short, long]) {
      assert.ok(isSafeProbe(` ${text}`), text)
      assert.doesNotMatch(text, /["'`\n]/)
    }
    assert.ok(long.length > 2 * short.length)
  }
  assert.equal(OUTPUT_ECHO_RULE.minGap, 150)
})

// --- The run on sellers behind a fake buyer proxy, with the model's other sellers as the crowd ---

const PEERS = ['aa', 'bb', 'cc', 'dd'].map((letter) => letter.repeat(32))
const SERVICE = 'test-model'
/** The model's tokenizer in these tests: one token per three characters. */
const tokens = (text: string): number => Math.ceil(text.length / 3)

/** Sellers that echo each text and sign `billed(text)` output tokens; every request is captured per peer. */
function fakeNetwork(billing: Record<string, (text: string) => number>) {
  const signed = new Map<string, { request: Uint8Array; response: Uint8Array }>()
  const asked = new Map<string, number>()
  const fetchFn: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers)
    const requestId = headers.get('x-antseed-request-id')!
    const peer = headers.get('x-antseed-pin-peer')!
    asked.set(peer, (asked.get(peer) ?? 0) + 1)
    const raw = init!.body as Uint8Array
    const body = JSON.parse(new TextDecoder().decode(raw)) as { messages: Array<{ content: string }> }
    const text = body.messages[0]!.content.split('\n\n').slice(1).join('\n\n')
    const reply = {
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: billing[peer]!(text) },
    }
    signed.set(requestId, {
      request: encodeHttpRequest({ requestId, method: 'POST', path: '/v1/chat/completions', headers: {}, body: raw }),
      response: encodeHttpResponse({ requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(reply)) }),
    })
    return Response.json(reply, { headers: { 'x-antseed-request-id': requestId } })
  }
  const responseAuthReader = {
    async waitForVerified(input: { requestId: string }) {
      const bytes = signed.get(input.requestId)!
      return {
        requestId: input.requestId, status: 'verified' as const, responseAuth: null, failureReason: null,
        signedPreimages: {
          encoding: 'antseed-http-codec-v1' as const, signatureEncoding: 'antseed-response-auth-signing-v1' as const,
          requestBase64: Buffer.from(bytes.request).toString('base64'), responseBase64: Buffer.from(bytes.response).toString('base64'),
          responseAuthSigningBase64: 'AA==', requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}`,
        },
      }
    },
    close() {},
  } as unknown as Parameters<typeof createOutputEchoScreen>[0]['responseAuthReader']
  return { fetchFn, responseAuthReader, asked }
}

/** The reference echoes every text exactly and counts it with the model's tokenizer. */
const echoReference: EchoReferenceAsk = async (texts) => ({
  upstream: { kind: 'test' },
  results: texts.map((text) => ({
    requestBody: new TextEncoder().encode(JSON.stringify({ messages: [{ role: 'user', content: outputEchoPrompt(text) }], max_tokens: 1024 })),
    response: {
      statusCode: 200,
      body: new TextEncoder().encode(JSON.stringify({
        object: 'chat.completion', provider: 'maker',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: tokens(text) },
      })),
    },
    provider: 'maker',
    failure: null,
  })),
})

const screenFor = (network: ReturnType<typeof fakeNetwork>, ask: EchoReferenceAsk = echoReference) => createOutputEchoScreen<null>({
  sellers: PEERS.map((peerId) => ({ peerId, service: SERVICE })),
  proxyBaseUrl: 'http://127.0.0.1:1', responseAuthReader: network.responseAuthReader, limiter: new ConcurrencyLimiter(4),
  fetchFn: network.fetchFn, ask: () => ask,
})

const honestBilling = (text: string): number => tokens(text)

test('an honest seller passes on six requests, and the model\'s other sellers are not asked', async () => {
  const network = fakeNetwork(Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])))
  const record = await screenFor(network).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, precheckMatch: true })
  assert.equal(record?.outcome, 'pass')
  assert.equal(record?.mode, 'plain')
  assert.equal(outputEchoRequestCount(record!), 6)
  assert.equal(network.asked.get(PEERS[1]!), undefined)
  validateOutputEcho(record!, PEERS[0])
})

test('a seller that bills a quarter more output is flagged once three other sellers back the reference, and the record rechecks', async () => {
  const network = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: (text) => Math.round(tokens(text) * 1.25) })
  const record = (await screenFor(network).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, precheckMatch: true }))!
  assert.deepEqual([record.outcome, record.flag], ['flag', 'growth'])
  assert.deepEqual(record.rounds.map((entry) => entry.verdict), ['over', 'over', 'over'])
  assert.equal(record.crowd?.votes.length, 3)
  assert.equal(outputEchoRequestCount(record), 12 + 6, 'three rounds asked twice, two requests to each other seller')
  validateOutputEcho(record, PEERS[0])
  assert.match(describeOutputEchoFlag(record), /^echo check \(output-echo-v1\): the seller's output grows \d+ or more tokens faster than the model's/)
  const altered = structuredClone(record)
  altered.rounds[0]!.short[0]!.reply = { ...altered.rounds[0]!.short[0]!.reply, count: 1 }
  assert.throws(() => validateOutputEcho(altered, PEERS[0]), /reading differs from the signed bytes/)
  const relabelled = structuredClone(record)
  relabelled.outcome = 'pass'
  assert.throws(() => validateOutputEcho(relabelled, PEERS[0]), /outcome is pass, its rounds give flag/)
  assert.throws(() => validateOutputEcho(record, PEERS[1]), /votes in its own crowd/)
  // The same seller with its pre-check not a match decides nothing.
  const unknown = (await screenFor(network).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, precheckMatch: false }))!
  assert.equal(unknown.outcome, 'inconclusive')
})

test('a seller that adds the same 30 tokens to every reply is flagged as a fixed amount; a crowd that does the same is a relay', async () => {
  const padded = (text: string): number => tokens(text) + 30
  const alone = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: padded })
  const record = (await screenFor(alone).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, precheckMatch: true }))!
  assert.deepEqual([record.outcome, record.flag, record.offset], ['flag', 'offset', { median: 30, fixed: true }])
  validateOutputEcho(record, PEERS[0])
  const relay = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: padded, [PEERS[1]!]: padded })
  const shared = (await screenFor(relay).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, precheckMatch: true }))!
  assert.equal(shared.outcome, 'inconclusive')
  assert.match(shared.reason, /offset: another seller of the model signs the same amount/)
})

test('a reference that changes the text or disagrees with itself leaves the model unjudged, and no seller is asked', async () => {
  const network = fakeNetwork(Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])))
  let call = 0
  const drifting: EchoReferenceAsk = async (texts, signal) => {
    const answered = await echoReference(texts, signal)
    call += 1
    return { ...answered, results: answered.results.map((result, index) => (index === 1 && result.response
      ? { ...result, response: { ...result.response, body: new TextEncoder().encode(new TextDecoder().decode(result.response.body).replace(/"completion_tokens":(\d+)/, (_all, value: string) => `"completion_tokens":${Number(value) + 5 + call}`)) } }
      : result)) }
  }
  const record = await screenFor(network, drifting).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, precheckMatch: true })
  assert.equal(record, null)
  assert.equal(network.asked.size, 0)
})

test('an echo record of every outcome, written to its evidence file, passes the check submit makes', async () => {
  const honest = Object.fromEntries(PEERS.map((peer) => [peer, honestBilling]))
  const run = async (billing: (text: string) => number, precheckMatch = true) => (await screenFor(fakeNetwork({ ...honest, [PEERS[0]!]: billing }))
    .check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, precheckMatch }))!
  const records = {
    pass: await run(honestBilling),
    growth: await run((text) => Math.round(tokens(text) * 1.25)),
    offset: await run((text) => tokens(text) + 30),
    inconclusive: await run((text) => Math.round(tokens(text) * 1.25), false),
  }
  assert.deepEqual(Object.values(records).map((record) => [record.outcome, record.flag]), [['pass', null], ['flag', 'growth'], ['flag', 'offset'], ['inconclusive', null]])
  const directory = await mkdtemp(join(tmpdir(), 'antseed-output-echo-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const audits: FixtureAudit[] = Object.values(records).map((record, index) => ({
      agentId: String(index + 1), seller: new Wallet(Wallet.createRandom().privateKey), model: 'model-a', service: 'model-a',
      verdict: record.outcome === 'flag' ? 'DIFF' : 'SAME', outputEcho: record,
    }))
    const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor, audits })
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address, config: FIXTURE_CONFIG,
    })
    assert.deepEqual(prepared.excluded, [])
    assert.deepEqual(prepared.audits[0]?.evidence.results.map((result) => result.flaggedBy), [[], ['output-echo'], ['output-offset'], []])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
