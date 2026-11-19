import assert from 'node:assert/strict'
import test from 'node:test'
import { assertBoundToSeller, carriedIntoConfirmation, decidedRecords, withoutOrphans, earliestAuditorTime, RECORD_CHECKS, storedRequestsOf, TOKENS_CHECK, verdictOf } from './audit-checks.js'
import { isFreshConfirmation } from './same-check.js'
import { costOfRequests, requestCountOf } from './proxy-evidence.js'
import {
  AUDIT_CHECK_IDS,
  decidedChecks,
  describeAuditCheck,
  flaggingChecks,
  localConfirmationDecision,
  passedChecks,
  type AuditCheckId,
} from './flagging-checks.js'
import { OUTPUT_CAP_RULE, outputCapCost, outputCapRequestCount, summarizeOutputCap } from './output-cap.js'
import { OUTPUT_ECHO_RULE, outputEchoCost, outputEchoRequestCount, summarizeOutputEcho } from './output-echo.js'
import { summarizeTokenizerPrecheck, tokenizerPrecheckCost, tokenizerPrecheckRequestCount } from './tokenizer-precheck.js'

// Pins what every reader of a check's outcome gives today, for every outcome of every check, so that moving the
// readers onto one registry of checks changes no verdict, attribution or order.

type Outcome3 = 'flag' | 'pass' | 'inconclusive'
const TOKENS = ['match', 'mismatch', 'inconclusive'] as const
const OUTCOMES = ['flag', 'pass', 'inconclusive'] as const
const VERDICTS = ['SAME', 'DIFF', 'UNDETERMINED', null] as const

const echoRecord = (growth: Outcome3, fixedAmount: Outcome3) => ({
  outcome: growth === 'flag' ? 'flag' : growth,
  growth: { outcome: growth, reason: '' },
  fixedAmount: { outcome: fixedAmount, reason: '' },
}) as never

test('the check ids and their order are fixed: the order is the attribution order and is in the rules hash', () => {
  assert.deepEqual([...AUDIT_CHECK_IDS], ['tokens', 'output-cap', 'output-echo', 'output-offset', 'flips', 'kbf'])
  assert.deepEqual(AUDIT_CHECK_IDS.map(describeAuditCheck), [
    'the token-count pre-check', 'the cap check', 'the echo check', 'the echo check\'s fixed amount', 'the randomness check', 'the questions',
  ])
})

test('flagged and passed are read from each record\'s own outcome, every combination, in the fixed order', () => {
  for (const tokens of [undefined, ...TOKENS]) {
    for (const cap of [undefined, ...OUTCOMES]) {
      for (const growth of [undefined, ...OUTCOMES]) {
        for (const fixedAmount of OUTCOMES) {
          for (const asked of [false, true]) {
            for (const verdict of VERDICTS) {
              const evidence = {
                ...(tokens ? { tokenizerPrecheck: { outcome: tokens } as never } : {}),
                ...(cap ? { outputCap: { outcome: cap } as never } : {}),
                ...(growth ? { outputEcho: echoRecord(growth, fixedAmount) } : {}),
                exchanges: asked ? [{} as never] : [],
              }
              const flagged: AuditCheckId[] = []
              const passed: AuditCheckId[] = []
              if (tokens === 'mismatch') flagged.push('tokens')
              if (tokens === 'match') passed.push('tokens')
              if (cap === 'flag') flagged.push('output-cap')
              if (cap === 'pass') passed.push('output-cap')
              if (growth === 'flag') flagged.push('output-echo')
              if (growth === 'pass') passed.push('output-echo')
              if (growth && fixedAmount === 'flag') flagged.push('output-offset')
              if (growth && fixedAmount === 'pass') passed.push('output-offset')
              if (asked && verdict === 'DIFF') flagged.push('kbf')
              if (asked && verdict === 'SAME') passed.push('kbf')
              const at = JSON.stringify({ tokens, cap, growth, fixedAmount, asked, verdict })
              assert.deepEqual(flaggingChecks(evidence, verdict), flagged, at)
              assert.deepEqual(passedChecks(evidence, verdict), passed, at)
            }
          }
        }
      }
    }
  }
})

test('decided is read from the summary, every combination: the questions count only when an answer was scored', () => {
  for (const tokens of [undefined, ...TOKENS]) {
    for (const cap of [undefined, ...OUTCOMES]) {
      for (const growth of [undefined, ...OUTCOMES]) {
        for (const fixedAmount of OUTCOMES) {
          for (const parsedProbeCount of [undefined, 0, 3]) {
            for (const status of ['SAME', 'DIFF', 'UNDETERMINED', 'FAILED', 'SKIPPED']) {
              const result = {
                status,
                ...(parsedProbeCount === undefined ? {} : { parsedProbeCount }),
                ...(tokens ? { tokenizerPrecheck: { outcome: tokens } } : {}),
                ...(cap ? { outputCap: { outcome: cap } } : {}),
                ...(growth ? { outputEcho: { growth, fixedAmount } } : {}),
              }
              const decided: AuditCheckId[] = []
              if (tokens === 'match' || tokens === 'mismatch') decided.push('tokens')
              if (cap === 'pass' || cap === 'flag') decided.push('output-cap')
              if (growth === 'pass' || growth === 'flag') decided.push('output-echo')
              if (growth && (fixedAmount === 'pass' || fixedAmount === 'flag')) decided.push('output-offset')
              if ((parsedProbeCount ?? 0) > 0 && (status === 'SAME' || status === 'DIFF')) decided.push('kbf')
              assert.deepEqual(decidedChecks(result), decided, JSON.stringify(result))
            }
          }
        }
      }
    }
  }
})

test('the audit\'s verdict: any flag is a DIFF, otherwise the questions\' own; a test with no result blocks nothing', () => {
  const reading = (check: AuditCheckId, outcome: 'flag' | 'pass' | 'inconclusive' | 'not-run') => ({ check, subject: 'model' as const, outcome })
  const verdict = (readings: ReturnType<typeof reading>[], questions: 'SAME' | 'DIFF' | 'UNDETERMINED', confirming?: AuditCheckId[], pending = false) => {
    const result = verdictOf(readings, questions, confirming, { questionsPending: pending })
    return [result.verdict, result.flaggedBy, result.undecidedConfirmation]
  }
  // A cap flag beside the questions' SAME: a DIFF attributed to the cap check, never to the questions.
  assert.deepEqual(verdict([reading('output-cap', 'flag'), reading('kbf', 'pass')], 'SAME'), ['DIFF', ['output-cap'], null])
  assert.deepEqual(verdict([reading('tokens', 'flag'), reading('output-echo', 'flag'), reading('kbf', 'flag')], 'DIFF'), ['DIFF', ['tokens', 'output-echo', 'kbf'], null])
  // No flag: the questions decide, and a test with no result never blocks SAME.
  assert.deepEqual(verdict([reading('tokens', 'inconclusive'), reading('output-cap', 'not-run'), reading('kbf', 'pass')], 'SAME'), ['SAME', [], null])
  assert.deepEqual(verdict([reading('tokens', 'pass'), reading('kbf', 'inconclusive')], 'UNDETERMINED'), ['UNDETERMINED', [], null])
  // A confirmation in which no test it repeats decided is undecided, whatever another test says.
  assert.deepEqual(verdict([reading('output-cap', 'inconclusive'), reading('output-echo', 'flag'), reading('kbf', 'pass')], 'SAME', ['output-cap']),
    ['UNDETERMINED', ['output-echo'], ['output-cap']])
  assert.deepEqual(verdict([reading('output-cap', 'pass'), reading('kbf', 'pass')], 'SAME', ['output-cap']), ['SAME', [], null], 'a pass of the repeated test decides')
  // A confirmation of the questions whose close call still waits for its extra set is not undecided yet: it waits.
  assert.deepEqual(verdict([reading('output-cap', 'flag'), reading('kbf', 'inconclusive')], 'UNDETERMINED', ['kbf'], true), ['UNDETERMINED', ['output-cap'], null])
  assert.deepEqual(verdict([reading('output-cap', 'flag'), reading('kbf', 'inconclusive')], 'UNDETERMINED', ['kbf'], false), ['UNDETERMINED', ['output-cap'], ['kbf']])
})

test('a local result answers a confirmation with the checks it decided, or as an undecided confirmation', () => {
  const decided = { status: 'DIFF', parsedProbeCount: 0, outputCap: { outcome: 'flag' } }
  assert.deepEqual(localConfirmationDecision(decided, true), ['output-cap'])
  assert.equal(localConfirmationDecision({ ...decided, outcomeReason: { code: 'confirmation_undecided' } }, false), 'undecided-confirmation')
  const undetermined = { status: 'UNDETERMINED', parsedProbeCount: 4 }
  assert.equal(localConfirmationDecision({ ...undetermined, confirmsDiff: true }, true), 'undecided-confirmation')
  assert.deepEqual(localConfirmationDecision({ ...undetermined, confirmsDiff: true }, false), [], 'not done: retried, not answered')
  assert.deepEqual(localConfirmationDecision(undetermined, true), [], 'a first look answers nothing')
})

// Each check's summary, cost and request count over a fixed record, pinned field by field: submit compares a
// summary with its evidence's, so one changed field would hold back every seller result that carries the check.

const cost = (input: number, output: number, usd: number) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output, estimatedCostUsd: usd })
const request = (ids: string[], costs: ReturnType<typeof cost>[]) => ({ requestIds: ids, attemptCosts: costs })

test('the pre-check\'s summary, cost and request count are pinned', () => {
  const record = {
    rule: { id: 'tokenizer-precheck-v1' }, outcome: 'mismatch',
    rounds: [
      { reference: { delta: 40 }, seller: [{ base: request(['a1'], [cost(100, 1, 0.01)]), probed: request(['a2', 'a3'], [cost(140, 1, 0.02), cost(140, 1, 0.02)]), delta: 55 }] },
      { reference: { delta: 41 }, seller: [{ base: request(['b1'], []), probed: null, delta: 56 }] },
    ],
    crowd: { requests: [{ requestCount: 2, attemptCosts: [cost(100, 1, 0.01), cost(140, 1, 0.02)] }] },
  } as never
  assert.deepEqual(summarizeTokenizerPrecheck(record), { rule: 'tokenizer-precheck-v1', outcome: 'mismatch', sellerTokens: [55, 56], modelTokens: [40, 41] })
  assert.deepEqual(summarizeTokenizerPrecheck({ ...(record as object), outcome: 'match' } as never), { rule: 'tokenizer-precheck-v1', outcome: 'match' })
  assert.equal(tokenizerPrecheckRequestCount(record), 4 + 2)
  assert.deepEqual(tokenizerPrecheckCost(record), {
    inputTokens: 620, outputTokens: 5, totalTokens: 625, estimatedCostUsd: 0.01 + 0.02 + 0.02 + 0.01 + 0.02,
    pricedExchangeCount: 3, missingCostExchangeCount: 1,
  })
})

test('the cap check\'s summary, cost and request count are pinned', () => {
  const record = {
    rule: OUTPUT_CAP_RULE, outcome: 'flag', reason: 'over twice the limit',
    asks: [
      { cap: 20, class: 'over', reading: { billedOutputTokens: 90 }, measurement: null, request: request(['c1'], [cost(30, 90, 0.003)]) },
      { cap: 24, class: 'over', reading: null, measurement: null, request: request(['c2', 'c3'], []) },
    ],
  } as never
  assert.deepEqual(summarizeOutputCap(record), {
    rule: 'output-cap-v1', outcome: 'flag', reason: 'over twice the limit',
    asks: [{ cap: 20, billed: 90, measured: null, class: 'over' }, { cap: 24, billed: null, measured: null, class: 'over' }],
  })
  assert.equal(outputCapRequestCount(record), 3)
  assert.deepEqual(outputCapCost(record), { inputTokens: 30, outputTokens: 90, totalTokens: 120, estimatedCostUsd: 0.003, pricedExchangeCount: 1, missingCostExchangeCount: 1 })
})

test('the echo check\'s summary, cost and request count are pinned, with the crowd votes it sent and not the others', () => {
  const ask = (id: string, costs: ReturnType<typeof cost>[]) => ({ request: request([id], costs) })
  const record = {
    rule: OUTPUT_ECHO_RULE, outcome: 'flag', flag: 'growth', reason: 'grows with the text',
    growth: { outcome: 'flag', reason: 'g' }, fixedAmount: { outcome: 'inconclusive', reason: 'f' },
    rounds: [
      { growths: [120, 130], short: [ask('s1', [cost(50, 60, 0.001)])], long: [ask('l1', [cost(60, 480, 0.004)])], repeats: { short: ask('s2', []), long: ask('l2', [cost(60, 470, 0.004)]) } },
      { growths: [null], short: [ask('s3', [cost(50, 61, 0.001)])], long: [ask('l3', [cost(60, 300, 0.003)])] },
    ],
    offset: { median: 7 },
    crowd: { votes: [
      { sentHere: true, short: ask('v1', [cost(50, 60, 0.001)]), long: ask('v2', [cost(60, 360, 0.003)]) },
      { sentHere: false, short: ask('v3', [cost(50, 60, 0.001)]), long: ask('v4', [cost(60, 360, 0.003)]) },
    ] },
  } as never
  assert.deepEqual(summarizeOutputEcho(record), {
    rule: 'output-echo-v1', outcome: 'flag', flag: 'growth', growth: 'flag', fixedAmount: 'inconclusive',
    reason: 'grows with the text', growths: [[120, 130], [null]], offset: 7,
  })
  assert.equal(outputEchoRequestCount(record), 6 + 2)
  assert.deepEqual(outputEchoCost(record), {
    inputTokens: 50 + 60 + 60 + 50 + 60 + 50 + 60, outputTokens: 60 + 480 + 470 + 61 + 300 + 60 + 360,
    totalTokens: 50 + 60 + 60 + 50 + 60 + 50 + 60 + 60 + 480 + 470 + 61 + 300 + 60 + 360,
    estimatedCostUsd: 0.001 + 0.004 + 0.004 + 0.001 + 0.003 + 0.001 + 0.003,
    pricedExchangeCount: 7, missingCostExchangeCount: 1,
  })
})

test('each check lists every request its record stores with whose signature it must carry, in the order asked', () => {
  const auth = (id: string) => ({ requestId: id, status: 'verified', record: null, signedPreimages: null, failureReason: null }) as never
  const signed = (id: string) => ({ requestIds: [id], attemptCosts: [], responseAuth: auth(id) })
  const precheck = {
    outcome: 'match',
    rounds: [{ seller: [{ base: signed('p1'), probed: signed('p2') }] }, { seller: [{ base: signed('p3'), probed: null }] }],
    crowd: { requests: [], backers: [{ peerId: 'bb', service: 'svc', ask: { base: signed('b1'), probed: signed('b2') } }] },
  } as never
  const cap = { asks: [{ request: signed('c1') }, { request: signed('c2') }] } as never
  const echo = {
    rounds: [{ short: [{ request: signed('s1') }], long: [{ request: signed('l1') }], repeats: { short: { request: signed('s2') }, long: { request: signed('l2') } } }],
    crowd: { votes: [{ peerId: 'cc', sentHere: false, short: { request: signed('v1') }, long: { request: signed('v2') } }] },
  } as never
  const listed = storedRequestsOf({ tokenizerPrecheck: precheck, outputCap: cap, outputEcho: echo })
  assert.deepEqual(listed.map((request) => [request.requestIds[0], request.signer]), [
    ['p1', 'audited'], ['p2', 'audited'], ['p3', 'audited'],
    ['b1', { peerId: 'bb', service: 'svc' }], ['b2', { peerId: 'bb', service: 'svc' }],
    ['c1', 'audited'], ['c2', 'audited'],
    ['s1', 'audited'], ['l1', 'audited'], ['s2', 'audited'], ['l2', 'audited'],
    ['v1', { peerId: 'cc' }], ['v2', { peerId: 'cc' }],
  ])
  assert.equal(listed[0]!.responseAuth, (precheck as { rounds: Array<{ seller: Array<{ base: { responseAuth: unknown } }> }> }).rounds[0]!.seller[0]!.base.responseAuth)
  assert.deepEqual(storedRequestsOf({}), [])
})

test('every check\'s paid requests give its cost and request count, in the order they were summed', () => {
  const cost = (usd: number) => ({ inputTokens: 1, outputTokens: 2, totalTokens: 3, estimatedCostUsd: usd })
  const precheck = {
    rounds: [{ seller: [{ base: { requestIds: ['a', 'b'], attemptCosts: [cost(0.1), cost(0.2)] }, probed: null }] }],
    crowdRequests: [{ requestCount: 1, attemptCosts: [cost(0.3)] }],
  } as never
  for (const check of RECORD_CHECKS) assert.equal(typeof check.paid, 'function')
  assert.deepEqual(TOKENS_CHECK.paid(precheck), [
    { requestCount: 2, attemptCosts: [cost(0.1), cost(0.2)] }, { requestCount: 1, attemptCosts: [cost(0.3)] },
  ])
  assert.deepEqual(tokenizerPrecheckCost(precheck), costOfRequests(TOKENS_CHECK.paid(precheck)))
  assert.equal(tokenizerPrecheckRequestCount(precheck), requestCountOf(TOKENS_CHECK.paid(precheck)))
})

test('every verified reply a check stores is bound to its seller, its request and its service', () => {
  const seller = { peerId: 'aa'.repeat(20), service: 'model-a', serviceAliases: ['model-a', 'vendor/model-a'] }
  const reply = (input: { requestId?: string; signedId?: string; peer?: string; service?: string; status?: string; record?: boolean } = {}) => {
    const requestId = input.requestId ?? 'r2'
    return {
      signer: 'audited' as const,
      requestIds: ['r1', 'r2'],
      responseAuth: {
        requestId, status: input.status ?? 'verified', signedPreimages: null, failureReason: null,
        record: input.record === false ? null : { requestId: input.signedId ?? requestId, sellerPeerId: input.peer ?? `0x${seller.peerId.toUpperCase()}`, advertisedService: input.service ?? 'model-a' },
      } as never,
    }
  }
  const bind = (requests: unknown[]) => () => assertBoundToSeller(requests as never, seller, 'the cap check')
  assert.doesNotThrow(bind([reply()]), 'peer ids compare without case or 0x')
  assert.doesNotThrow(bind([reply({ service: 'vendor/model-a' })]), 'another name of the model is the same service')
  assert.throws(bind([reply({ peer: 'bb'.repeat(20) })]), /^Error: the cap check: a reply is not signed by the seller it is stored for$/)
  assert.throws(bind([reply({ signedId: 'r9' })]), /a signed reply answers another request than the one stored with it/)
  assert.throws(bind([reply({ requestId: 'r9' })]), /a signed reply answers another request than the one stored with it/, 'not one of the record\'s tries')
  assert.throws(bind([reply({ service: 'model-b' })]), /a reply is signed for another service than the one asked/)
  assert.throws(bind([reply({ record: false })]), /a verified reply has no signed record/)
  assert.doesNotThrow(bind([reply({ status: 'invalid', peer: 'bb'.repeat(20) })]), 'a reply that is not verified is left to the check')
  // Another seller's reply: its own peer, and the service stored with it when there is one.
  const other = (service?: string, signed = 'model-a') => ({ ...reply({ peer: 'cc'.repeat(20), service: signed }), signer: { peerId: 'cc'.repeat(20), ...(service ? { service } : {}) } })
  assert.doesNotThrow(bind([other()]))
  assert.doesNotThrow(bind([other('model-a-fast', 'model-a-fast')]), 'a backer asked under its own service name')
  assert.throws(bind([other('model-a-fast', 'model-a')]), /signed for another service/)
  assert.throws(bind([{ ...other(), signer: { peerId: 'dd'.repeat(20) } }]), /not signed by the seller it is stored for/)
})

test('an audit\'s time for "fresh" is its earliest request on the auditor\'s clock, never the seller\'s signed time', () => {
  const REPORTED = 1_800_000_000
  const reply = (receivedAt: number | undefined, responseStartedAt: number) => ({
    requestIds: ['r'], attemptCosts: [],
    responseAuth: { requestId: 'r', status: 'verified', record: { requestId: 'r', receivedAt, responseStartedAt } },
  })
  const capOnly = (receivedAt: number | undefined, responseStartedAt: number) => ({ exchanges: [], outputCap: { asks: [{ request: reply(receivedAt, responseStartedAt) }] } as never })
  const afterCutoff = (REPORTED + 3_600) * 1_000
  // A seller that back-dates its signed start time before the report does not make the audit stale.
  const backDated = capOnly(afterCutoff + 5_000, (REPORTED - 86_400) * 1_000)
  assert.equal(earliestAuditorTime([backDated]), REPORTED + 3_605)
  assert.equal(isFreshConfirmation(earliestAuditorTime([backDated]), REPORTED), true)
  // The earliest of every set: question batches by their send time, check replies by when the buyer received them.
  const questions = { exchanges: [{ timing: { startedAt: afterCutoff + 20_000 } }, { timing: { startedAt: afterCutoff + 9_000 } }] }
  assert.equal(earliestAuditorTime([questions, capOnly(afterCutoff + 30_000, 0)]), REPORTED + 3_609)
  // A reused batch from before the cutoff, in the first set or an extra set, makes the audit not fresh.
  const reused = { exchanges: [{ timing: { startedAt: (REPORTED + 60) * 1_000 } }] }
  assert.equal(isFreshConfirmation(earliestAuditorTime([questions, null, reused]), REPORTED), false)
  // A reply with no auditor time gives none; no time at all is never fresh.
  assert.equal(earliestAuditorTime([capOnly(undefined, afterCutoff)]), null)
  assert.equal(isFreshConfirmation(earliestAuditorTime([{ exchanges: [] }]), REPORTED), false)
  assert.equal(isFreshConfirmation(null, REPORTED), false)
  assert.equal(isFreshConfirmation(REPORTED + 3_600, REPORTED), true, 'an hour after the report is fresh')
  assert.equal(isFreshConfirmation(REPORTED + 3_599, REPORTED), false)
})

test('a confirmation of two flags: a DIFF when one flags again, a SAME only when both passed, undecided otherwise', () => {
  const reading = (check: AuditCheckId, outcome: 'flag' | 'pass' | 'inconclusive' | 'not-run') => ({ check, subject: 'model' as const, outcome })
  const both: AuditCheckId[] = ['output-cap', 'kbf']
  const judge = (cap: 'flag' | 'pass' | 'inconclusive', kbf: 'flag' | 'pass' | 'inconclusive') => {
    const result = verdictOf([reading('output-cap', cap), reading('kbf', kbf)], kbf === 'flag' ? 'DIFF' : kbf === 'pass' ? 'SAME' : 'UNDETERMINED', both)
    return [result.verdict, result.undecidedConfirmation]
  }
  // The cap check has no result here and the questions pass: before, that SAME went out and the cap flag had one try.
  assert.deepEqual(judge('inconclusive', 'pass'), ['UNDETERMINED', ['output-cap']])
  assert.deepEqual(judge('inconclusive', 'flag'), ['DIFF', null], 'one repeated test flagging again is enough for a DIFF')
  assert.deepEqual(judge('flag', 'inconclusive'), ['DIFF', null])
  assert.deepEqual(judge('pass', 'pass'), ['SAME', null])
  assert.deepEqual(judge('pass', 'inconclusive'), ['UNDETERMINED', ['kbf']])
})

test('a retry carries only the tests that decided; a test with no result is asked again', () => {
  const records = {
    tokenizerPrecheck: { outcome: 'match' } as never,
    outputCap: { outcome: 'inconclusive' } as never,
    outputEcho: { outcome: 'inconclusive', growth: { outcome: 'inconclusive' }, fixedAmount: { outcome: 'inconclusive' } } as never,
  }
  assert.deepEqual(Object.keys(decidedRecords(records)), ['tokenizerPrecheck'])
  const passed = { ...records, outputEcho: { outcome: 'pass', growth: { outcome: 'pass' }, fixedAmount: { outcome: 'inconclusive' } } as never }
  assert.deepEqual(Object.keys(decidedRecords(passed)), ['tokenizerPrecheck', 'outputEcho'])
  assert.deepEqual(decidedRecords({}), {})
  // An echo judged against an undecided pre-check is asked again with it: the two stay one pair at submit.
  const anchored = { ...passed, tokenizerPrecheck: { outcome: 'inconclusive' } as never }
  assert.deepEqual(Object.keys(decidedRecords(anchored)), [])
})

test('a confirmation carries only records of an earlier confirmation that are fresh for its report, with their dependants', () => {
  const at = (ms: number) => ({ requestIds: ['r'], attemptCosts: [], responseAuth: { requestId: 'r', status: 'verified', record: { requestId: 'r', receivedAt: ms } } })
  const cap = (ms: number) => ({ outcome: 'pass', asks: [{ request: at(ms) }] }) as never
  const precheck = (ms: number) => ({ outcome: 'match', rounds: [{ seller: [{ base: at(ms), probed: null }] }] }) as never
  const echo = (ms: number) => ({ outcome: 'pass', growth: { outcome: 'pass' }, fixedAmount: { outcome: 'pass' }, rounds: [{ short: [{ request: at(ms) }], long: [], repeats: undefined }] }) as never
  const cutoff = 10_000 + 3_600
  const fresh = (time: number | null) => time !== null && time >= cutoff
  const records = { tokenizerPrecheck: precheck(9_000_000), outputCap: cap(20_000_000), outputEcho: echo(20_000_000) }
  assert.deepEqual(carriedIntoConfirmation(records, { confirmation: false }, fresh), {}, 'never a first look\'s records')
  // The pre-check is older than the report's cutoff: asked again, and the echo judged against it with it.
  assert.deepEqual(Object.keys(carriedIntoConfirmation(records, { confirmation: true }, fresh)), ['outputCap'])
  assert.deepEqual(Object.keys(carriedIntoConfirmation({ ...records, tokenizerPrecheck: precheck(20_000_000) }, { confirmation: true }, fresh)).sort(),
    ['outputCap', 'outputEcho', 'tokenizerPrecheck'])
  // An absent pre-check is asked now, so the echo judged without it is asked again too.
  assert.deepEqual(Object.keys(withoutOrphans({ outputEcho: echo(20_000_000), outputCap: cap(20_000_000) })), ['outputCap'])
})
