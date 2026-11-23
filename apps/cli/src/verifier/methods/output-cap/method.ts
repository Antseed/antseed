import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { outcome, stored, type RecordCheck } from '../../audit-method.js'
import { asSuppression } from '../../audit-thinking.js'
import { referenceDidNotApply } from '../shared/output-usage.js'
import { TOKENIZER_PRECHECK_RULE } from '../tokens/tokenizer-precheck.js'
import {
  createOutputCapScreen, describeOutputCapFlag, describeOutputCapSummary, outputCapFingerprint, outputCapPaidRequests, summarizeOutputCap, validateOutputCap,
} from './output-cap.js'

/** The cap check as the list of tests holds it (`../index.ts`): how its record is read, and how a run and an audit run it. */

/** Dry pass only (`ANTSEED_VERIFIER_CAP_MEASURE_WITHIN=1`): the cap check also measures answers that kept to the limit. */
const capMeasuresWithin = (): boolean => process.env['ANTSEED_VERIFIER_CAP_MEASURE_WITHIN'] === '1'

export const OUTPUT_CAP_CHECK: RecordCheck<'outputCap'> = {
  slot: 'outputCap',
  findings: [{
    id: 'output-cap', subject: 'billing', label: 'the cap check',
    ofRecord: (record) => outcome(record.outcome, 'flag', 'pass'),
    ofSummary: (summary) => outcome(summary.outcome, 'flag', 'pass'),
  }],
  summarize: summarizeOutputCap,
  // Recomputed from the bytes the seller signed.
  validate: (record) => validateOutputCap(record),
  requests: (record) => record.asks.map((ask) => stored('audited', ask.request)),
  paid: outputCapPaidRequests,
  describeFlag: describeOutputCapFlag,
  inReport: (_finding, summary) => `cap check (${summary.rule}): ${describeOutputCapSummary(summary)}: the reply limit was ignored`,
  inRunLine: (summary) => (summary.outcome === 'flag' ? `cap check: ${describeOutputCapSummary(summary)}` : null),
  texts: {
    name: 'the cap check',
    summaryMismatch: 'the summary\'s cap check is not the one in its evidence',
  },
  phase: 'after-questions',
  thinking: {
    needs: { seller: 'own', reference: 'bank' },
    why: 'the seller as for its questions; the reference with its bank\'s setting, on the route the bank was enrolled on',
  },
  screen: (cap) => ({
    ready: (audit) => cap.ready(audit.bank),
    check: (audit) => cap.check(audit.seller, audit.bank, asSuppression(audit.thinking.seller), audit.clock),
  }),
  toggle: { key: 'outputChecks', pinned: true },
  fingerprint: outputCapFingerprint,
  whyNoRecord: async (read) => referenceDidNotApply(await read('output-cap-reference.json')),
  // Said for every model while the dry-pass switch is set, also with the output checks off: the run has always said
  // it whatever the tests' own switches say.
  announce({ model, report }) {
    if (capMeasuresWithin()) {
      report.note(`${model}: ANTSEED_VERIFIER_CAP_MEASURE_WITHIN is on: the cap check also measures answers that kept to the limit (a dry pass's diagnostic; it costs reference requests and changes no result)`)
    }
  },
  // The cap check of this model's sellers (`createOutputCapScreen`): whether it applies is decided once, by
  // the reference measuring a count in words on the route of the seller's question set; each seller's
  // answers billed over the limit are measured there too.
  forRun: () => ({ seller, reference, limiters, report }) => createOutputCapScreen<KbfReferenceV1>({
    // A dry pass (nothing submitted) also measures answers that kept to the limit, to show the measurement's scale.
    measureWithin: capMeasuresWithin(),
    onReady: (record) => report.reference('output-cap', record),
    ...seller,
    ask: (bank) => (contents, signal) => reference.inputTokens(bank, contents, { maxTokens: TOKENIZER_PRECHECK_RULE.maxTokens, signal, limiter: limiters.reference }),
    // The model's own reply to a capped request: the check applies only when it keeps the limit.
    askReply: (bank) => async (prompt, cap, signal) => {
      const replied = await reference.replies(bank, { contents: [prompt], maxTokens: cap }, { signal, limiter: limiters.reference })
      const first = replied.results[0]
      if (!first?.response) throw new Error(first?.failure ?? 'no answer')
      return { requestBody: first.requestBody, response: first.response, provider: first.provider, oneProvider: replied.oneProvider }
    },
  }),
}
