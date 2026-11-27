import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet } from 'ethers'
import { prepareModelAudits } from '../../model-audit.js'
import { FIXTURE_CONFIG, peerIdOf, writeSignedAuditRun, type FixtureAudit } from '../../model-audit-fixtures.test-support.js'
import { echoReference, echoScreenFor as screenFor, fakeEchoNetwork as fakeNetwork } from '../shared/output-checks.test-support.js'
import test from 'node:test'
import { assertBoundToSeller, sellerBindingOf } from '../../audit-checks.js'
import { OUTPUT_ECHO_CHECK } from './method.js'
import { isSafeProbe } from '@antseed/node/payments'
import type { OutputReadingV1 } from '../shared/output-usage.js'
import { readOutput } from '../shared/output-usage.js'
import {
  ECHO_SET_ASIDE_REASON,
  ECHO_STOPPED_REASON,
  OUTPUT_ECHO_RULE,
  outputEchoRequestBody,
  outputEchoRuleById,
  steadyShares,
  stoppedEcho,
  echoCrowdVote,
  prepareOutputEchoReference,
  describeOutputEchoFlag,
  echoCrowdObjection,
  outputEchoCost,
  outputEchoRequestCount,
  validateOutputEcho,
  type EchoReferenceAsk,
  judgeEchoRound,
  judgeOutputEcho,
  readEchoReply,
  referenceEchoCount,
  writeEchoText,
  type EchoCrowdVoteV1,
  type EchoRoundV1,
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
  peerId: `peer-${Math.random()}`, short: ask(null), long: ask(null), growth, offset, reasoning, sentHere: true,
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
  assert.deepEqual(referenceEchoCount([asked(60), asked(60)], 'plain'), { count: 60, failure: null })
  assert.match(referenceEchoCount([asked(60), asked(61)], 'plain').failure!, /did not agree with itself/, 'plain mode needs the same count')
  assert.equal(referenceEchoCount([asked(60), asked(61)], 'visible').count, 60, 'visible mode allows the tolerance')
  assert.match(referenceEchoCount([asked(60), asked(64)], 'visible').failure!, /did not agree with itself/)
  assert.match(referenceEchoCount([asked(60), asked(60, 'other')], 'plain').failure!, /more than one provider/)
  assert.match(referenceEchoCount([asked(60), asked(null, 'maker', 'not finished')], 'plain').failure!, /not usable \(not finished\)/)
  assert.match(referenceEchoCount([asked(60)], 'plain').failure!, /asked 1 of 2 times/)
})

test('a round is over only when its growth repeats; a constant offset cancels', () => {
  assert.equal(round([[60, 360]]).verdict, 'within')
  // A host that adds 3 tokens to every reply: growth 0.
  assert.deepEqual(round([[63, 363]]).growths, [0])
  assert.equal(round([[63, 363]]).verdict, 'within')
  // 2% more on output: 66 more on long, 1 more on short → growth 5, over; it repeats.
  assert.equal(round([[61, 366], [61, 366]]).verdict, 'over')
  // Over once and within when asked again: undecided, not within.
  assert.equal(round([[61, 366], [60, 360]]).verdict, 'unstable')
  // +40 then 0 on the repeat: the seller's own two counts disagree.
  assert.equal(round([[60, 400], [60, 360]]).verdict, 'unstable')
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

/** The rule, which counts the fixed amount. */
const COUNTING = OUTPUT_ECHO_RULE
/** The rule with both its counting switches off: the fixed amount and visible-mode findings stored only. */
const NOT_COUNTED = Object.freeze({ ...OUTPUT_ECHO_RULE, offsetCounts: false, visibleCounts: false })
/** The rule without asking a text again. */
const NO_ASK_AGAIN = Object.freeze({ ...OUTPUT_ECHO_RULE, askAgain: undefined })

const judge = (rounds: ReturnType<typeof round>[], crowd: EchoCrowdVoteV1[] | null, options: { precheckMatch?: boolean; incomplete?: boolean; rule?: typeof OUTPUT_ECHO_RULE } = {}) => judgeOutputEcho({
  mode: 'plain', reference: REFERENCE, referenceReasoning: [0, 0, 0], rounds,
  precheckMatch: options.precheckMatch ?? true, crowd: crowd ? { votes: crowd, incomplete: options.incomplete ?? false } : null,
  ...(options.rule ? { rule: options.rule } : {}),
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

test('a fixed amount is judged on every text asked twice, behind the crowd, and counts only when the rule says so', () => {
  // On single replies it is only a candidate: every text is asked again first.
  const once = [round([[90, 390]]), round([[90, 390]]), round([[91, 390]])]
  assert.deepEqual([judge(once, null).needsSecondAsks, judge(once, null).fixedAmount.outcome], [true, 'inconclusive'])
  const padded = [round([[90, 390], [90, 390]]), round([[90, 390], [90, 390]]), round([[91, 390], [90, 391]])]
  const crowd = [vote(0, 0), vote(0, 3), vote(0, -1)]
  const counted = judge(padded, crowd, { rule: COUNTING })
  assert.deepEqual([counted.outcome, counted.flag, counted.offset.median, counted.fixedAmount.outcome], ['flag', 'offset', 30, 'flag'])
  // With its switch off the finding is stored and shown, and decides nothing.
  const held = judge(padded, crowd, { rule: NOT_COUNTED })
  assert.deepEqual([held.outcome, held.flag, held.fixedAmount.outcome], ['pass', null, 'inconclusive'], 'the growth counts and passes; the fixed amount is only stored')
  assert.match(held.fixedAmount.reason, /^flag, stored and not counted yet: the seller adds 30 tokens/)
  // The rule counts it.
  const shipped = judge(padded, crowd)
  assert.deepEqual([shipped.outcome, shipped.flag, shipped.fixedAmount.outcome], ['flag', 'offset', 'flag'])
  // The lead over the crowd's median must be above 20 tokens: +21 against a crowd at +2 is not enough.
  const close = [round([[81, 381], [81, 381]]), round([[81, 381], [81, 381]]), round([[81, 381], [81, 381]])]
  assert.match(judge(close, [vote(0, 2), vote(0, 2), vote(0, 0), vote(0, 0), vote(0, 3)], { rule: COUNTING }).reason, /not more than 20 tokens above the other sellers' median/)
  // A small constant passes; one another seller shares is a relay; one that varies decides nothing.
  assert.equal(judge([round([[75, 375]]), round([[75, 375]]), round([[75, 375]])], null).outcome, 'pass')
  assert.match(judge(padded, [vote(0, 0), vote(0, 30), vote(0, -1)], { rule: COUNTING }).reason, /fixed amount: another seller of the model signs the same amount/)
  assert.equal(judge([round([[90, 390]]), round([[80, 380]]), round([[90, 390]])], null, { rule: COUNTING }).fixedAmount.outcome, 'inconclusive')
})

test('only a seller that kept to the model\'s count passes each finding', () => {
  // Over the margin in two rounds of three: not a candidate, and not a pass either.
  const partly = judge([round([[61, 366], [61, 366]]), round([[61, 366], [61, 366]]), round([[60, 360]])], null)
  assert.deepEqual([partly.outcome, partly.growth.outcome], ['inconclusive', 'inconclusive'])
  const honest = judge([round([[60, 360]]), round([[60, 360]]), round([[60, 360]])], null, { rule: COUNTING })
  assert.deepEqual([honest.outcome, honest.growth.outcome, honest.fixedAmount.outcome], ['pass', 'pass', 'pass'])
  // With its switch off the fixed amount's pass is stored and clears nothing; the growth's pass counts.
  const second = judge([round([[60, 360]]), round([[60, 360]]), round([[60, 360]])], null, { rule: NOT_COUNTED })
  assert.deepEqual([second.outcome, second.growth.outcome, second.fixedAmount.outcome], ['pass', 'pass', 'inconclusive'])
  assert.match(second.fixedAmount.reason, /^pass, stored and not counted yet/)
  // The shipped rule counts both: each passes.
  const shipped = judge([round([[60, 360]]), round([[60, 360]]), round([[60, 360]])], null)
  assert.deepEqual([shipped.outcome, shipped.growth.outcome, shipped.fixedAmount.outcome], ['pass', 'pass', 'pass'])
  // A growth pass with a fixed amount left undecided is no overall pass; with the switch off it is.
  const varying = [round([[90, 390]]), round([[80, 380]]), round([[90, 390]])]
  assert.deepEqual([judge(varying, null).outcome, judge(varying, null).growth.outcome, judge(varying, null).fixedAmount.outcome], ['inconclusive', 'pass', 'inconclusive'])
  assert.equal(judge(varying, null, { rule: NOT_COUNTED }).outcome, 'pass')
})

test('a round that cannot be read or does not repeat decides nothing', () => {
  assert.match(judge([round([[60, 360]]), round([[null, 360]]), round([[60, 360]])], null).reason, /a round was unusable/)
  assert.match(judge([round([[60, 360]]), round([[61, 366], [61, 390]]), round([[60, 360]])], null).reason, /a round was unstable/)
  assert.match(judge([round([[60, 360]])], null).reason, /not every round was asked/)
})

test('the texts are guard-safe single paragraphs without quotation marks, and a long one is several short ones long', () => {
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

const honestBilling = (text: string): number => tokens(text)

test('the rule asks under a reply limit of 2,048 tokens, counts both parts and asks again; an unknown rule is not known', () => {
  // The longest text is six passages: under a limit of 1,024 a tokenizer that writes it in more tokens had its echo cut
  // off, at the reference too, so the check did not apply to the model.
  assert.deepEqual([OUTPUT_ECHO_RULE.id, OUTPUT_ECHO_RULE.maxTokens], ['output-echo-v1', 2048])
  assert.deepEqual([OUTPUT_ECHO_RULE.offsetCounts, OUTPUT_ECHO_RULE.visibleCounts, OUTPUT_ECHO_RULE.askAgain], [true, true, { waitMs: 5_000 }])
  assert.equal(outputEchoRuleById('output-echo-v1'), OUTPUT_ECHO_RULE)
  assert.equal(outputEchoRuleById('output-echo-v2'), undefined)
  assert.equal(outputEchoRequestBody({ service: 'model-a', text: 'x' })['max_tokens'], 2048)
})

test('an honest seller passes on six requests, and the model\'s other sellers are not asked', async () => {
  const network = fakeNetwork(Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])))
  const record = await screenFor(network).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true })
  assert.equal(record?.outcome, 'pass')
  assert.equal(record?.mode, 'plain')
  assert.equal(outputEchoRequestCount(record!), 6)
  assert.equal(network.asked.get(PEERS[1]!), undefined)
  validateOutputEcho(record!, PEERS[0])
})

test('a seller that bills a quarter more output is flagged once three other sellers back the reference, and the record rechecks', async () => {
  const network = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: (text) => Math.round(tokens(text) * 1.25) })
  const record = (await screenFor(network).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true }))!
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
  const ownVote = structuredClone(record)
  ownVote.crowd!.votes[0]!.peerId = PEERS[0]!
  assert.throws(() => validateOutputEcho(ownVote, PEERS[0]), /audited seller's, or a second vote/)
  assert.throws(() => validateOutputEcho(record, PEERS[1]), /not signed by it/, 'replies are bound to the seller that signed them')
  // A voter admitted under its own spelling of the model (by the canonical key, as discovery admits it) binds at submit
  // and in the confirmer's read: both bind with `sellerBindingOf` and `assertBoundToSeller`. Another model does not.
  const binding = sellerBindingOf({ target: { peerId: PEERS[0]!, service: SERVICE }, reference: { referenceModel: SERVICE } })
  const respelled = (signed: string) => {
    const copy = structuredClone(record)
    for (const ask of [copy.crowd!.votes[1]!.short, copy.crowd!.votes[1]!.long]) {
      ;(ask.request.responseAuth as { record: { advertisedService: string } }).record.advertisedService = signed
    }
    return () => assertBoundToSeller(OUTPUT_ECHO_CHECK.requests(copy), binding, 'the echo check')
  }
  assert.doesNotThrow(respelled('vendor/test_model'), 'a spelling outside the built-in list, same model')
  assert.throws(respelled('other-model'), /a reply is signed for another service than the one asked/)
  // The same seller with its pre-check not a match decides nothing.
  const unknown = (await screenFor(network).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: false }))!
  assert.equal(unknown.outcome, 'inconclusive')
})

test('a seller that adds the same 30 tokens to every reply is found, asked every text twice, and flagged; a crowd that does the same is a relay', async () => {
  const padded = (text: string): number => tokens(text) + 30
  const alone = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: padded })
  const record = (await screenFor(alone).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true }))!
  assert.deepEqual([record.outcome, record.flag, record.offset, record.growth.outcome], ['flag', 'offset', { median: 30, fixed: true }, 'pass'])
  assert.match(record.fixedAmount.reason, /^the seller adds 30 tokens to every reply/)
  assert.ok(record.rounds.every((entry) => entry.repeats !== undefined && entry.short.length === 1), 'every text asked again, apart from the growth rounds')
  validateOutputEcho(record, PEERS[0])
  const relay = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: padded, [PEERS[1]!]: padded })
  const shared = (await screenFor(relay).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true }))!
  assert.equal(shared.fixedAmount.outcome, 'inconclusive')
  assert.match(shared.fixedAmount.reason, /another seller of the model signs the same amount/)
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
  const record = await screenFor(network, drifting).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true })
  assert.equal(record, null)
  assert.equal(network.asked.size, 0)
})

test('an echo record of every outcome, written to its evidence file, passes the check submit makes', async () => {
  // Each record is made for the seller the fixture writes it under, so its replies are signed by that seller.
  const wallets = Array.from({ length: 5 }, () => new Wallet(Wallet.createRandom().privateKey))
  const crowdPeers = PEERS.slice(1)
  const honest = Object.fromEntries(crowdPeers.map((peer) => [peer, honestBilling]))
  let next = 0
  const run = async (billing: (text: string) => number, precheckMatch = true) => {
    const peer = peerIdOf(wallets[next++]!)
    return (await screenFor(fakeNetwork({ ...honest, [peer]: billing }), echoReference, [peer, ...crowdPeers])
      .check({ peerId: peer, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch }))!
  }
  const records = {
    pass: await run(honestBilling),
    growth: await run((text) => Math.round(tokens(text) * 1.25)),
    offset: await run((text) => tokens(text) + 30),
    inconclusive: await run((text) => Math.round(tokens(text) * 1.25), false),
  }
  // A check stopped before it decided is stored inconclusive in every finding, and rechecks as such.
  // A check whose audit stopped after its growth was decided: the growth stands, the rest is stored as stopped.
  const base = await run(honestBilling)
  const stopped = { ...base, ...stoppedEcho(base, base, 'plain') }
  assert.deepEqual([stopped.outcome, stopped.growth.outcome, stopped.reason], ['pass', 'pass', 'the seller bills the model\'s growth; the rest was stopped with the audit'])
  assert.deepEqual(Object.values(records).map((record) => [record.outcome, record.flag]), [['pass', null], ['flag', 'growth'], ['flag', 'offset'], ['inconclusive', null]])
  const directory = await mkdtemp(join(tmpdir(), 'antseed-output-echo-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const audits: FixtureAudit[] = [...Object.values(records), stopped].map((record, index) => ({
      // Stored under the service its replies were signed for.
      agentId: String(index + 1), seller: wallets[index]!, model: 'model-a', service: SERVICE,
      // The questions say SAME; an echo flag is a DIFF, and an echo check that decided nothing blocks no SAME.
      verdict: record.outcome === 'flag' ? 'DIFF' : 'SAME', questionsVerdict: 'SAME',
      outputEcho: record, ...(record.precheckMatch ? { tokenizerMatch: true } : {}),
    }))
    const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor, audits })
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address, config: FIXTURE_CONFIG,
    })
    assert.deepEqual(prepared.excluded, [])
    assert.deepEqual(prepared.audits[0]?.evidence.results.map((result) => result.flaggedBy), [[], ['output-echo'], ['output-offset'], [], []])
    assert.ok(records.offset.rounds.every((round) => round.repeats !== undefined), 'the fixed-amount record with its repeats went through the file')
    assert.deepEqual(prepared.audits[0]?.evidence.results.map((result) => result.passedBy?.filter((check) => check.startsWith('output'))), [['output-echo', 'output-offset'], [], ['output-echo'], [], ['output-echo', 'output-offset']])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a growth far below the model\'s is no match, and a fixed extra on long replies only is not steady as a share of the gaps', () => {
  // -60 in every round: not a pass, and nothing it could clear.
  const under = judge([round([[60, 300]]), round([[60, 300]]), round([[60, 300]])], null)
  assert.deepEqual([under.outcome, under.growth.outcome], ['inconclusive', 'inconclusive'])
  assert.match(under.reason, /a round was under/)
  // Gaps of 200, 300 and 500: a 25% factor keeps its share; +60 on every long reply does not.
  const reference = [[60, 260], [60, 360], [60, 560]].map(([short, long]) => ({ short: { text: 's', count: short! }, long: { text: 'l', count: long! } }))
  const judgeOn = (rows: Array<[number, number]>) => judgeOutputEcho({
    mode: 'plain', reference, referenceReasoning: [0, 0, 0], precheckMatch: true,
    crowd: { votes: [vote(0), vote(1), vote(-1)], incomplete: false },
    rounds: rows.map(([short, long], index) => {
      const asks = { short: [ask(short), ask(short)], long: [ask(long), ask(long)] }
      return { ...asks, ...judgeEchoRound({ ...asks, reference: { short: reference[index]!.short.count, long: reference[index]!.long.count }, referenceReasoning: 0, mode: 'plain' }) }
    }),
  })
  const factor = judgeOn([[75, 325], [75, 450], [75, 700]])
  assert.deepEqual([factor.outcome, factor.flag], ['flag', 'growth'])
  const fixedOnLong = judgeOn([[60, 320], [60, 420], [60, 620]])
  assert.equal(fixedOnLong.growth.outcome, 'inconclusive')
  assert.match(fixedOnLong.growth.reason, /not steady as a share of the texts' gaps/)
})

test('a fixed amount backs the reference only when both texts are in the band', () => {
  const short = ask(62)
  const long = ask(364)
  const voted = echoCrowdVote('peer', short, long, REF)
  assert.equal(voted.offset, 4, 'the larger excess: +2 and +4 is not a backer')
})

test('a fixed-amount candidate\'s repeats never change the growth verdict', () => {
  const rounds = [round([[90, 390]]), round([[90, 390]]), round([[90, 390]])]
  for (const entry of rounds) (entry as EchoRoundV1).repeats = { short: ask(null), long: ask(390) }
  const judged = judge(rounds, [vote(0, 0), vote(0, 1), vote(0, 0)], { rule: COUNTING })
  assert.equal(judged.growth.outcome, 'pass', 'a failed repeat leaves the growth as it was')
})

test('the recheck refuses findings a record cannot have, and repeated authenticated asks', async () => {
  const network = fakeNetwork(Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])))
  // A stored outcome must follow from the rounds.
  const record = (await screenFor(network).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true }))!
  assert.equal(record.fixedAmount.outcome, 'pass')
  const flagged = structuredClone(record)
  flagged.fixedAmount = { outcome: 'flag', reason: 'x' }
  assert.throws(() => validateOutputEcho(flagged, PEERS[0]), /outcome is pass, its rounds give pass|its rounds give/)
  const empty = { ...structuredClone(record), rounds: [], outcome: 'inconclusive' as const, growth: { outcome: 'pass' as const, reason: 'x' } }
  assert.throws(() => validateOutputEcho(empty, PEERS[0]), /without rounds must be inconclusive in every finding/)
  const twice = structuredClone(record)
  twice.rounds[1]!.short[0]!.request.responseAuth = structuredClone(twice.rounds[0]!.short[0]!.request.responseAuth)
  assert.throws(() => validateOutputEcho(twice, PEERS[0]), /repeats an authenticated request ID|not one of its tries/)
})

test('a reference route that may serve several providers and names none leaves the model unjudged', async () => {
  const unnamed: EchoReferenceAsk = async (texts, signal) => {
    const answered = await echoReference(texts, signal)
    return { ...answered, oneProvider: false, results: answered.results.map((result) => ({ ...result, provider: null })) }
  }
  const reference = await prepareOutputEchoReference({ ask: unnamed })
  assert.equal(reference.applies, false)
  assert.match(reference.reason, /may serve several providers and names none/)
  const direct: EchoReferenceAsk = async (texts, signal) => ({ ...(await unnamed(texts, signal)), oneProvider: true })
  assert.equal((await prepareOutputEchoReference({ ask: direct })).applies, true, 'a direct endpoint names no provider and is one')
})

test('a reasoning count that is not a whole number gives no reading', () => {
  const reply = readOutput(new TextEncoder().encode(JSON.stringify({ messages: [{ role: 'user', content: 'x' }], max_tokens: 1024 })), {
    statusCode: 200,
    body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: TEXT }, finish_reason: 'stop' }], usage: { completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 12.5 } } })),
  })
  assert.equal(reply.billedOutputTokens, null)
})

test('the rounds\' gaps must differ by at least 4 to 3, or the check does not apply', async () => {
  const short = writeEchoText('short')
  const long = writeEchoText('long', undefined, 4)
  const same = await prepareOutputEchoReference({ ask: echoReference, write: (kind) => (kind === 'short' ? short : long) })
  assert.equal(same.applies, false)
  assert.match(same.reason, /gaps are too close/)
  const differing = await prepareOutputEchoReference({ ask: echoReference })
  assert.equal(differing.applies, true)
})

test('a stop after the growth was decided keeps it; a candidate that needed the crowd is stopped', () => {
  const pass = { outcome: 'pass' as const, reason: 'the seller bills the model\'s growth' }
  const candidate = { outcome: 'inconclusive' as const, reason: 'a candidate' }
  const kept = stoppedEcho({ growth: pass, fixedAmount: candidate }, { growth: pass, fixedAmount: { outcome: 'inconclusive', reason: 'x' } }, 'plain', NOT_COUNTED)
  assert.deepEqual([kept.outcome, kept.growth, kept.fixedAmount.reason], ['pass', pass, ECHO_STOPPED_REASON])
  // Where the fixed amount counts, the growth's pass is kept, and the check as a whole decides nothing.
  const third = stoppedEcho({ growth: pass, fixedAmount: candidate }, { growth: pass, fixedAmount: { outcome: 'inconclusive', reason: 'x' } }, 'plain')
  assert.deepEqual([third.outcome, third.growth, third.fixedAmount.reason], ['inconclusive', pass, ECHO_STOPPED_REASON])
  const cut = stoppedEcho({ growth: candidate, fixedAmount: candidate }, { growth: { outcome: 'flag', reason: 'x' }, fixedAmount: candidate }, 'plain')
  assert.deepEqual([cut.outcome, cut.flag, cut.growth.reason], ['inconclusive', null, ECHO_STOPPED_REASON])
})

test('the share test is exact: gaps of 150, 175 and 200 with a fixed 40 on long replies tie and are not steady', () => {
  assert.equal(steadyShares([[40, 150], [40, 175], [40, 200]], OUTPUT_ECHO_RULE), false)
  assert.equal(steadyShares([[30, 150], [35, 175], [40, 200]], OUTPUT_ECHO_RULE), true, 'a factor keeps its share')
})

test('a fixed-amount candidate whose repeats cannot all be read does not ask the crowd', () => {
  const rounds = [round([[90, 390]]), round([[90, 390]]), round([[90, 390]])]
  for (const entry of rounds) (entry as EchoRoundV1).repeats = { short: ask(null), long: ask(390) }
  const judged = judge(rounds, null, { rule: COUNTING })
  assert.deepEqual([judged.needsCrowd, judged.fixedAmount.reason, judged.growth.outcome], [false, 'a repeat of a text could not be read', 'pass'])
})

test('other sellers asked for a check are not asked again once its audit has stopped', async () => {
  // A seller that needs the crowd; the audit stops when the first other seller is asked its short text.
  const network = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: (text) => Math.round(tokens(text) * 1.25) })
  const audit = new AbortController()
  const fetchFn: typeof fetch = async (url, init) => {
    if (new Headers(init?.headers).get('x-antseed-pin-peer') !== PEERS[0]) audit.abort()
    return network.fetchFn(url, init)
  }
  const record = (await screenFor({ ...network, fetchFn }).check({ peerId: PEERS[0]!, service: SERVICE }, null, {
    thinking: null, crowdThinking: null, precheckMatch: true,
    clock: { signal: audit.signal, start: () => audit.signal, finish: () => {} },
  }))!
  assert.notEqual(record.outcome, 'flag', 'a crowd that was stopped backs nothing')
  // Time for a request that was not stopped to leave: each other seller's long text would follow its short one.
  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const peer of PEERS.slice(1)) {
    assert.ok((network.asked.get(peer) ?? 0) <= 1, `no request to ${peer} after the audit stopped: its cost would be in no audit`)
  }
})

test('a vote cut off between its two requests keeps the request that had ended in the count and the cost', async () => {
  // A seller that needs the crowd. Every answer is priced. The audit stops when the first other seller is asked its
  // long text: that seller's short text was answered and paid, and its vote never comes.
  const network = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: (text) => Math.round(tokens(text) * 1.25) })
  const audit = new AbortController()
  const fetchFn: typeof fetch = async (url, init) => {
    const peer = new Headers(init?.headers).get('x-antseed-pin-peer')!
    const reply = await network.fetchFn(url, init)
    if (peer !== PEERS[0] && network.asked.get(peer) === 2) audit.abort()
    const headers = new Headers(reply.headers)
    for (const [name, value] of Object.entries({
      'x-antseed-input-tokens': '100', 'x-antseed-output-tokens': '10', 'x-antseed-total-tokens': '110',
      'x-antseed-input-usd-per-million': '1', 'x-antseed-output-usd-per-million': '2', 'x-antseed-estimated-cost-usd': '0.00012',
    })) headers.set(name, value)
    return new Response(await reply.text(), { status: reply.status, headers })
  }
  const record = (await screenFor({ ...network, fetchFn }).check({ peerId: PEERS[0]!, service: SERVICE }, null, {
    thinking: null, crowdThinking: null, precheckMatch: true,
    clock: { signal: audit.signal, start: () => audit.signal, finish: () => {} },
  }))!
  assert.equal(record.crowd?.incomplete, true)
  assert.deepEqual(record.crowd?.votes, [])
  const cutOff = record.crowd?.cutOff ?? []
  const priced = cutOff.filter((request) => request.attemptCosts.length > 0)
  assert.ok(priced.length >= 1, 'the short text that was answered before the stop')
  assert.ok(cutOff.every((request) => request.requestCount === 1))
  assert.equal(outputEchoRequestCount(record), 12 + cutOff.length, 'the seller\'s twelve, and each request the stop cut off')
  assert.equal(outputEchoCost(record).pricedExchangeCount, 12 + priced.length)
  validateOutputEcho(record, PEERS[0])
  assert.throws(() => validateOutputEcho({ ...record, crowd: { ...record.crowd!, incomplete: false } }, PEERS[0]))
})

test('an answer that had arrived when the check stopped, its ResponseAuth still awaited, keeps its cost', async () => {
  // Every other seller answers its short text at once, priced, and its ResponseAuth comes late. The audit stops
  // meanwhile: no request has ended, and each answer was paid for.
  const network = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: (text) => Math.round(tokens(text) * 1.25) })
  const audit = new AbortController()
  const fetchFn: typeof fetch = async (url, init) => {
    const reply = await network.fetchFn(url, init)
    const headers = new Headers(reply.headers)
    for (const [name, value] of Object.entries({
      'x-antseed-input-tokens': '100', 'x-antseed-output-tokens': '10', 'x-antseed-total-tokens': '110',
      'x-antseed-input-usd-per-million': '1', 'x-antseed-output-usd-per-million': '2', 'x-antseed-estimated-cost-usd': '0.00012',
    })) headers.set(name, value)
    return new Response(await reply.text(), { status: reply.status, headers })
  }
  const responseAuthReader: typeof network.responseAuthReader = {
    ...network.responseAuthReader,
    async waitForVerified(input) {
      if (input.sellerPeerId !== PEERS[0]) {
        setTimeout(() => audit.abort(), 20)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      return network.responseAuthReader.waitForVerified(input)
    },
  }
  const record = (await screenFor({ ...network, fetchFn, responseAuthReader }).check({ peerId: PEERS[0]!, service: SERVICE }, null, {
    thinking: null, crowdThinking: null, precheckMatch: true,
    clock: { signal: audit.signal, start: () => audit.signal, finish: () => {} },
  }))!
  assert.equal(record.crowd?.incomplete, true)
  const cutOff = record.crowd?.cutOff ?? []
  assert.equal(cutOff.length, PEERS.length - 1, 'one request to each other seller')
  assert.ok(cutOff.every((request) => request.requestCount === 1 && request.attemptCosts.length === 1), 'each answer had arrived and is priced')
  assert.equal(outputEchoCost(record).pricedExchangeCount, 12 + cutOff.length)
  validateOutputEcho(record, PEERS[0])
})

test('work for the fixed amount alone stops when the audit\'s spare time is up, keeps the growth pass, and the audit goes on', async () => {
  const padded = (text: string): number => tokens(text) + 30
  const network = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: padded })
  const spare = new AbortController()
  const audit = new AbortController()
  const fetchFn: typeof fetch = async (url, init) => {
    const reply = await network.fetchFn(url, init)
    // The spare time runs out once the seller's twelve asks are in: the crowd is never asked.
    if (network.asked.get(PEERS[0]!) === 12) spare.abort()
    return reply
  }
  const third = (await screenFor({ ...network, fetchFn }).check({ peerId: PEERS[0]!, service: SERVICE }, null, {
    thinking: null, crowdThinking: null, precheckMatch: true, spare: () => spare.signal,
    clock: { signal: audit.signal, start: () => audit.signal, finish: () => {} },
  }))!
  // The growth's pass is kept; the fixed amount counts and was set aside, so the whole is no pass.
  assert.equal(audit.signal.aborted, false)
  assert.deepEqual([third.outcome, third.growth.outcome, third.fixedAmount.reason, third.reason], ['inconclusive', 'pass', ECHO_SET_ASIDE_REASON, ECHO_SET_ASIDE_REASON])
  assert.equal(third.crowd, null)
  assert.equal(network.asked.get(PEERS[1]!), undefined)
  validateOutputEcho(third, PEERS[0])
})

// --- A model counted on its visible answer counts, and an ask with no signed answer is asked again ---

test('a model counted on its visible answer is judged; with the switch off it is only stored', () => {
  const visible = (rule?: typeof OUTPUT_ECHO_RULE) => judgeOutputEcho({
    mode: 'visible', reference: REFERENCE, referenceReasoning: [0, 0, 0], precheckMatch: true, crowd: null,
    rounds: [0, 1, 2].map(() => round([[60, 360], [60, 360]], 'visible')),
    ...(rule ? { rule } : {}),
  })
  const second = visible(NOT_COUNTED)
  assert.deepEqual([second.outcome, second.growth.outcome], ['inconclusive', 'inconclusive'])
  assert.match(second.growth.reason, /^pass, stored and not counted yet/)
  const third = visible()
  assert.deepEqual([third.outcome, third.growth.outcome, third.fixedAmount.outcome], ['pass', 'pass', 'inconclusive'])
  assert.equal(third.fixedAmount.reason, 'not judged in visible mode')
})

/** The honest network, with the audited seller's calls listed in `failing` answered `status` instead. */
function failingSeller(failing: readonly number[], status: number) {
  const network = fakeNetwork(Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])))
  let call = 0
  const fetchFn: typeof fetch = async (url, init) => {
    if (new Headers(init?.headers).get('x-antseed-pin-peer') === PEERS[0]) {
      call += 1
      if (failing.includes(call)) return new Response('{"error":{"message":"upstream busy"}}', { status })
    }
    return network.fetchFn(url, init)
  }
  const waits: number[] = []
  const check = (rule?: typeof OUTPUT_ECHO_RULE) => {
    call = 0
    waits.length = 0
    return screenFor({ ...network, fetchFn }, echoReference, PEERS, { ...(rule ? { rule } : {}), wait: async (ms) => { waits.push(ms) } })
      .check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true })
  }
  return { check, waits }
}

test('an ask with no signed answer after a 5xx is asked once more after a short wait, and the round is judged on it', async () => {
  // Calls 3 and 4 are both tries of the second round's short text.
  const seller = failingSeller([3, 4], 503)
  const record = (await seller.check())!
  // The shared helper waits before its second try; the check waits again before asking the text once more.
  assert.deepEqual(seller.waits, [2_000, OUTPUT_ECHO_RULE.askAgain!.waitMs])
  assert.equal(record.outcome, 'pass')
  const asked = record.rounds[1]!.short[0]!
  assert.equal(asked.askedAgain?.requestIds.length, 2)
  assert.equal(asked.askedAgain?.statusCode, 503)
  assert.match(asked.askedAgain?.failureReason ?? '', /HTTP 503/)
  assert.equal(asked.request.requestIds.length, 3, 'both asks\' tries are paid for and kept with the one ask')
  assert.equal(outputEchoRequestCount(record), 6 + 2)
  validateOutputEcho(record, PEERS[0])
  // Without asking again the same seller leaves the round unusable, and the check has no result.
  const second = (await seller.check(NO_ASK_AGAIN))!
  assert.deepEqual(seller.waits, [2_000])
  assert.deepEqual([second.outcome, second.reason], ['inconclusive', 'growth: a round was unusable; fixed amount: a round was unusable'])
  assert.equal(second.rounds[1]!.short[0]!.askedAgain, undefined)
})

test('a refusal is an answer: it is not asked again, and the round is unusable', async () => {
  const seller = failingSeller([3], 400)
  const record = (await seller.check())!
  assert.deepEqual(seller.waits, [])
  assert.equal(record.rounds[1]!.short[0]!.askedAgain, undefined)
  assert.match(record.reason, /a round was unusable/)
  validateOutputEcho(record, PEERS[0])
})

test('the recheck holds an ask asked again to the rule: only after a failure that can pass, and never for a crowd vote', async () => {
  const seller = failingSeller([3, 4], 503)
  const record = (await seller.check())!
  const edited = (change: (copy: OutputEchoV1) => void) => {
    const copy = structuredClone(record)
    change(copy)
    return copy
  }
  assert.throws(() => validateOutputEcho(edited((copy) => { delete copy.rounds[1]!.short[0]!.askedAgain }), PEERS[0]), /more tries than its rule allows/)
  assert.throws(() => validateOutputEcho(edited((copy) => {
    copy.rounds[1]!.short[0]!.askedAgain = { ...copy.rounds[1]!.short[0]!.askedAgain!, statusCode: 400, failureReason: 'the seller answered HTTP 400: no' }
  }), PEERS[0]), /after a failure that cannot pass/)
  assert.throws(() => validateOutputEcho(edited((copy) => {
    const asked = copy.rounds[1]!.short[0]!
    asked.askedAgain = { ...asked.askedAgain!, requestIds: asked.request.requestIds.slice(1) }
  }), PEERS[0]), /does not store its first ask's tries first/)
  assert.throws(() => validateOutputEcho(edited((copy) => {
    copy.rounds[0]!.long[0]!.askedAgain = { requestIds: [copy.rounds[0]!.long[0]!.request.requestIds[0]!], statusCode: 503, failureReason: 'x' }
  }), PEERS[0]), /does not store its first ask's tries first|keeps its first ask's answer/)
  // A vote of the crowd is never asked again.
  const network = fakeNetwork({ ...Object.fromEntries(PEERS.map((peer) => [peer, honestBilling])), [PEERS[0]!]: (text) => Math.round(tokens(text) * 1.25) })
  const flagged = (await screenFor(network).check({ peerId: PEERS[0]!, service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true }))!
  const vote = flagged.crowd!.votes[0]!
  vote.short.askedAgain = { requestIds: ['x'], statusCode: 503, failureReason: 'the seller answered HTTP 503' }
  vote.short.request.requestIds = ['x', ...vote.short.request.requestIds]
  assert.throws(() => validateOutputEcho(flagged, PEERS[0]), /asked again, which its rule does not allow here/)
})
