import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  FLIPS_RULE,
  FLIPS_STATISTICS,
  flipsCalibrationFor,
  flipsPrompt,
  flipsPValue,
  flipsRuleById,
  flipsScoreFromStatistics,
  flipsStatistics,
  isEmptyFlipsReply,
  isValidFlipsPair,
  judgeFlipsCheck,
  parseFlipsReply,
  studentTUpperTail,
  welchT2,
  type FlipsPair,
  type FlipsPairSampleV1,
  type FlipsReplyV1,
} from './flips-score.js'

const WOLF_PINE: FlipsPair = ['wolf', 'pine']
const ECHO_RUST: FlipsPair = ['echo', 'rust']
const r4 = (v: number): number => Math.round(v * 10000) / 10000
const stat = (values: number[], name: (typeof FLIPS_STATISTICS)[number]): number => values[FLIPS_STATISTICS.indexOf(name)]!
const reply = (content: string | null, finishReason: string | null = 'stop'): FlipsReplyV1 => ({ content, finishReason })
const words = (bits: number[], pair: FlipsPair = WOLF_PINE): string => bits.map((b) => pair[b]).join(' ')

/** Saved checks of the FLIPS eval: reference replies, seller replies and the score the eval gave them. */
interface Fixture {
  name: string
  claimed: string
  served: string
  label: 'swap' | 'honest'
  replies: number
  expected: { score: number; scoreMax: number; inconclusive: boolean }
  pairs: FlipsPairSampleV1[]
}
const here = dirname(fileURLToPath(import.meta.url))
// Next to this file in the source tree; from the CLI's compiled dist/verifier the JSON stays in src/verifier.
const FIXTURES = [join(here, 'fixtures'), join(here, 'fixtures', 'flips'), join(here, '..', '..', '..', '..', 'src', 'verifier', 'methods', 'flips', 'fixtures', 'flips')].find((d) => existsSync(d) && readdirSync(d).some((f) => f.endsWith('.json')))
const fixtures: Fixture[] = FIXTURES ? readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) as Fixture) : []

test('the rule is frozen and known by its id', () => {
  assert.equal(FLIPS_RULE.id, 'flips-v1')
  assert.equal(flipsRuleById('flips-v1'), FLIPS_RULE)
  assert.equal(flipsRuleById('flips-v2'), undefined)
  assert.ok(Object.isFrozen(FLIPS_RULE))
  // Counting (never MiniMax M3), the bars, replies without a sequence left out, repeats, the asks trail, a confirmation
  // between its bars clearing, and the second look between the bars.
  assert.deepEqual(FLIPS_RULE.counts, { default: true, never: ['minimax-m3'] })
  assert.deepEqual([FLIPS_RULE.bar, FLIPS_RULE.passAbove], [{ first: 0.002, confirm: 0.001 }, 0.1])
  assert.deepEqual([FLIPS_RULE.noSequence, FLIPS_RULE.repeats], [{ below: 8, maxShare: 0.2 }, { sellerShare: 0.5, referenceShare: 0.25, minReplies: 4 }])
  assert.deepEqual([FLIPS_RULE.asksRequired, FLIPS_RULE.confirmBetweenClears], [true, true])
  assert.deepEqual(FLIPS_RULE.secondLook, { morePerPair: 10, bar: 0.001 })
  const secondLook = FLIPS_RULE.secondLook
  // The second look's replies are a size the rule has a calibration for: the first look's and 10 more per pair, two pairs.
  assert.ok(flipsCalibrationFor((FLIPS_RULE.repliesPerPair.first + secondLook!.morePerPair) * FLIPS_RULE.pairsPerCheck))
  assert.ok(Object.isFrozen(FLIPS_RULE.calibrations))
  assert.equal(FLIPS_STATISTICS.length, 27)
  assert.equal(FLIPS_RULE.example.length, 16)
  assert.deepEqual(FLIPS_RULE.repliesPerPair, { first: 10, confirm: 20 })
  assert.deepEqual(FLIPS_RULE.calibrations.map((c) => c.replies), [20, 40])
})

test('the prompt is the eval prompt', () => {
  assert.equal(
    flipsPrompt(WOLF_PINE),
    'Give a sequence of 64 symbols drawn uniformly at random from the set {wolf, pine}. Write the symbols separated by single spaces. ' +
      'Output only the sequence, with no explanation or formatting.\n' +
      'Example of the format (16 symbols): wolf pine pine wolf pine wolf wolf wolf pine pine wolf pine wolf pine pine wolf\n' +
      'Now give your sequence of 64 symbols.',
  )
})

test('a pair must be readable back', () => {
  assert.ok(isValidFlipsPair(WOLF_PINE))
  assert.ok(isValidFlipsPair(['Open', 'mart']))
  assert.equal(isValidFlipsPair(['wolf', 'wolf']), false)
  assert.equal(isValidFlipsPair(['wolf', '']), false)
  assert.equal(isValidFlipsPair(['wolf', 'pi ne']), false)
  assert.equal(isValidFlipsPair(['wolf', 'pine.']), false)
  assert.equal(isValidFlipsPair(['wolf', 'pi,ne']), false)
})

test('the parser reads words exactly and counts everything else as invalid', () => {
  assert.deepEqual(parseFlipsReply('wolf pine  wolf\npine', WOLF_PINE), { symbols: [0, 1, 0, 1], invalid: 0 })
  assert.deepEqual(parseFlipsReply('`wolf`, *pine*; "wolf". [pine] {wolf}', WOLF_PINE), { symbols: [0, 1, 0, 1, 0], invalid: 0 })
  // case-sensitive; colons, brackets and hyphens are not stripped, so these are all invalid
  assert.deepEqual(parseFlipsReply('Wolf PINE wolf: (pine) wolf-pine', WOLF_PINE), { symbols: [], invalid: 5 })
  assert.deepEqual(parseFlipsReply('', WOLF_PINE), { symbols: [], invalid: 0 })
})

test('empty, filtered and failed replies count as empty', () => {
  assert.equal(isEmptyFlipsReply(reply('wolf pine')), false)
  assert.equal(isEmptyFlipsReply(reply('  \n')), true)
  assert.equal(isEmptyFlipsReply(reply('wolf pine', 'content_filter')), true)
  assert.equal(isEmptyFlipsReply(reply(null, null)), true)
})

test('statistics of an alternating sequence', () => {
  const alternating = Array.from({ length: 64 }, (_, i) => i % 2)
  const s = flipsStatistics(words(alternating), WOLF_PINE)
  assert.equal(s.length, 27)
  assert.equal(stat(s, 'len'), 64)
  assert.equal(stat(s, 'lenErr'), 0)
  assert.equal(stat(s, 'invalid'), 0)
  assert.equal(stat(s, 'monobit'), 0)
  assert.equal(stat(s, 'first'), 0)
  assert.equal(stat(s, 'runs'), 1)
  assert.equal(stat(s, 'long0'), 1)
  assert.equal(stat(s, 'long1'), 1)
  assert.equal(stat(s, 'longMax'), 1)
  assert.equal(stat(s, 's2_00'), 0)
  assert.equal(stat(s, 's2_01'), 32 / 63)
  assert.equal(stat(s, 's2_10'), 31 / 63)
  assert.equal(stat(s, 's3_010'), 31 / 62)
  assert.equal(stat(s, 'blockChi'), 0)
  assert.equal(stat(s, 'cusumF'), 1 / 8)
  assert.equal(stat(s, 'cusumB'), 1 / 8)
  assert.equal(stat(s, 'short'), 0)
  // two patterns of length 2 (01, 10) and two of length 3 (010, 101), each half the time: phi(2) = phi(3)
  assert.equal(stat(s, 'apen'), 0)
})

test('a short reply gets only its length statistics', () => {
  const s = flipsStatistics('wolf pine wolf oops', WOLF_PINE)
  assert.equal(stat(s, 'len'), 3)
  assert.equal(stat(s, 'lenErr'), 61)
  assert.equal(stat(s, 'invalid'), 1)
  assert.equal(stat(s, 'short'), 1)
  for (const name of FLIPS_STATISTICS) if (!['len', 'lenErr', 'invalid', 'short'].includes(name)) assert.equal(stat(s, name), 0, name)
  assert.equal(stat(flipsStatistics('x '.repeat(30), WOLF_PINE), 'invalid'), 20)
  assert.equal(stat(flipsStatistics('', WOLF_PINE), 'lenErr'), 64)
})

test('Welch t² with its zero-variance cases and ceiling', () => {
  assert.equal(welchT2([1, 1, 1], [1, 1]), null)
  assert.equal(welchT2([1, 1, 1], [2, 2]), 25)
  // means 2 and 4, variances 1 and 1, n 3 and 3: (2²) / (1/3 + 1/3) = 6
  assert.ok(Math.abs(welchT2([1, 2, 3], [3, 4, 5])! - 6) < 1e-12)
  assert.equal(welchT2([0, 0, 0, 0, 1e-9], [100, 100, 100, 100, 100 + 1e-9]), 400)
  // a lone value has variance 0, not NaN: means 2 and 5, se = 2/2 + 0/1 = 1
  assert.ok(Math.abs(welchT2([1, 3], [5])! - 9) < 1e-12)
})

test('the score is the mean of capped t² and needs replies on both sides of every pair', () => {
  const zeros = new Array<number>(27).fill(0)
  const shifted = (v: number, k: number): number[] => zeros.map((z, i) => (i === k ? v : z))
  // statistic 0 differs with no variance (25), the rest are equal constants and left out
  const one = flipsScoreFromStatistics([{ reference: [zeros, zeros], seller: [shifted(1, 0), shifted(1, 0)] }])
  assert.deepEqual(one, { score: 25, scoreMax: 25, terms: 1 })
  // a huge t² is capped at 50 in the mean but kept (up to 400) in scoreMax
  const huge = flipsScoreFromStatistics([{ reference: [shifted(0, 3), shifted(1e-6, 3)], seller: [shifted(10, 3), shifted(10 + 1e-6, 3)] }])
  assert.equal(huge!.score, 50)
  assert.equal(huge!.scoreMax, 400)
  assert.equal(flipsScoreFromStatistics([{ reference: [zeros], seller: [] }]), null)
  assert.equal(flipsScoreFromStatistics([{ reference: [zeros], seller: [zeros] }]), null)
})

test('the port gives the eval scores on the saved checks', () => {
  assert.ok(fixtures.length >= 5, `fixtures found in ${FIXTURES}`)
  for (const f of fixtures) {
    const stats = f.pairs.map(({ pair, reference, seller }) => ({
      reference: reference.map((r) => flipsStatistics(r.content!, pair)),
      seller: seller.map((r) => flipsStatistics(r.content!, pair)),
    }))
    const scored = flipsScoreFromStatistics(stats)
    assert.ok(scored, f.name)
    assert.equal(r4(scored.score), f.expected.score, `${f.name}: score`)
    assert.equal(r4(scored.scoreMax), f.expected.scoreMax, `${f.name}: scoreMax`)
    const judged = judgeFlipsCheck(f.pairs)
    assert.equal(judged.replies, f.replies, f.name)
    assert.equal(judged.outcome, f.expected.inconclusive ? 'inconclusive' : 'scored', `${f.name}: outcome`)
    if (!f.expected.inconclusive) {
      assert.equal(r4(judged.score!), f.expected.score, `${f.name}: judged score`)
      assert.equal(judged.p, flipsPValue(judged.score!, f.replies), f.name)
    }
  }
})

test('saved checks against the eval threshold and the calibration', () => {
  const byName = new Map(fixtures.map((f) => [f.name, f]))
  const judged = (name: string) => judgeFlipsCheck(byName.get(name)!.pairs)
  // the eval's threshold at 20 replies: 8.8879
  assert.ok(judged('swap-caught-near-threshold').score! > 8.8879)
  assert.ok(judged('swap-same-maker-missed').score! < 8.8879)
  assert.ok(judged('swap-same-maker-caught').p! < 1e-4)
  // honest checks closest to a flag: p stays above 0.1%
  assert.ok(judged('honest-wrapper').p! > 0.001)
  assert.ok(judged('honest-provider-confirm-40').p! > 0.001)
  const filtered = judged('inconclusive-content-filter')
  assert.equal(filtered.p, null)
  assert.match(filtered.reasons.join('; '), /echo\/rust: 10 of 10 seller replies empty, filtered or failed/)
})

test('more than half of a pair empty, filtered or failed is inconclusive, on either side', () => {
  const good = (seed: number): FlipsReplyV1 => reply(words(Array.from({ length: 64 }, (_, i) => (i * 7 + seed) % 3 === 0 ? 1 : 0)))
  const replies = (n: number, bad: number, badReply: FlipsReplyV1): FlipsReplyV1[] => Array.from({ length: n }, (_, i) => (i < bad ? badReply : good(i)))
  const check = (seller: FlipsReplyV1[], reference: FlipsReplyV1[] = replies(20, 0, good(0))): FlipsPairSampleV1[] => [
    { pair: WOLF_PINE, reference, seller },
    { pair: ECHO_RUST, reference: reference.map((r) => ({ ...r, content: r.content && r.content.replaceAll('wolf', 'echo').replaceAll('pine', 'rust') })), seller: replies(10, 0, good(0)).map((r) => ({ ...r, content: r.content!.replaceAll('wolf', 'echo').replaceAll('pine', 'rust') })) },
  ]
  assert.equal(judgeFlipsCheck(check(replies(10, 5, reply('')))).outcome, 'scored')
  assert.equal(judgeFlipsCheck(check(replies(10, 6, reply('')))).outcome, 'inconclusive')
  assert.equal(judgeFlipsCheck(check(replies(10, 6, reply('wolf pine', 'content_filter')))).outcome, 'inconclusive')
  assert.equal(judgeFlipsCheck(check(replies(10, 6, reply(null, null)))).outcome, 'inconclusive')
  assert.equal(judgeFlipsCheck(check(replies(10, 0, good(0)), replies(20, 11, reply('')))).outcome, 'inconclusive')
  // failed replies are left out of the statistics, empty ones are kept; the size is the replies asked for
  const withFailed = check(replies(10, 3, reply(null, null)))
  const failed = judgeFlipsCheck(withFailed)
  const statsOf = (list: readonly FlipsReplyV1[], pair: FlipsPair): number[][] => list.filter((r) => r.content !== null).map((r) => flipsStatistics(r.content!, pair))
  const withoutThem = flipsScoreFromStatistics(withFailed.map((p) => ({ reference: statsOf(p.reference, p.pair), seller: statsOf(p.seller, p.pair) })))
  assert.equal(failed.outcome, 'scored')
  assert.equal(failed.score, withoutThem!.score)
  assert.equal(failed.replies, 20)
  assert.notEqual(judgeFlipsCheck(check(replies(10, 3, reply('')))).score, failed.score)
  // a size the rule has no calibration for is inconclusive, never a throw
  const odd = check(replies(9, 0, good(0)))
  assert.deepEqual(judgeFlipsCheck(odd).reasons, ['no calibration for 19 replies'])
  // a check needs the rule's two pairs, each readable
  assert.equal(judgeFlipsCheck(check(replies(10, 0, good(0))).slice(0, 1)).outcome, 'inconclusive')
  const unreadable = check(replies(10, 0, good(0)))
  unreadable[0] = { ...unreadable[0]!, pair: ['wolf', 'wolf'] }
  assert.equal(judgeFlipsCheck(unreadable).outcome, 'inconclusive')
})

test('the Student t tail', () => {
  assert.equal(studentTUpperTail(0, 5), 0.5)
  assert.ok(Math.abs(studentTUpperTail(2.228138852, 10) - 0.025) < 1e-8)
  assert.ok(Math.abs(studentTUpperTail(-2.228138852, 10) - 0.975) < 1e-8)
  assert.ok(Math.abs(studentTUpperTail(12.70620474, 1) - 0.025) < 1e-8)
  assert.ok(Math.abs(studentTUpperTail(1.959963985, 1e6) - 0.025) < 1e-6)
})

test('the frozen calibration turns a score into p', () => {
  // the eval's thresholds: 8.8879 at 20 replies, 9.876 at 40
  assert.equal(Number(flipsPValue(8.8879, 20).toPrecision(4)), 0.0006922)
  assert.equal(Number(flipsPValue(9.876, 40).toPrecision(4)), 0.001344)
  // the median honest score is near p = 0.5
  assert.ok(Math.abs(flipsPValue(Math.exp(flipsCalibrationFor(20)!.location), 20) - 0.5) < 1e-12)
  assert.ok(flipsPValue(2, 20) > flipsPValue(4, 20))
  assert.ok(flipsPValue(50, 20) > 0 && flipsPValue(50, 20) < 1e-6)
  // a score of 0 (no difference at all) is p near 1, not an error
  assert.ok(flipsPValue(0, 20) > 0.999)
  assert.throws(() => flipsPValue(5, 30), RangeError)
  assert.throws(() => flipsPValue(Number.NaN, 20), RangeError)
  assert.equal(flipsCalibrationFor(84), undefined)
})
