import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { outcome, stored, type RecordCheck } from '../../audit-method.js'
import { asSuppression } from '../../audit-thinking.js'
import { referenceDidNotApply } from '../shared/output-usage.js'
import {
  OUTPUT_ECHO_RULE, createOutputEchoScreen, describeOutputEchoFlag, outputEchoFingerprint, outputEchoPaidRequests, outputEchoPrompt, summarizeOutputEcho,
  validateOutputEcho,
  type EchoSellerAskV1,
} from './output-echo.js'

/** The echo check as the list of tests holds it (`../index.ts`): how its record is read, and how a run and an audit run it. */

export const OUTPUT_ECHO_CHECK: RecordCheck<'outputEcho'> = {
  slot: 'outputEcho',
  // Each finding passes on its own: a seller that only failed to be a candidate has not passed.
  findings: [{
    id: 'output-echo', subject: 'billing', label: 'the echo check',
    ofRecord: (record) => outcome(record.growth?.outcome, 'flag', 'pass'),
    ofSummary: (summary) => outcome(summary.growth, 'flag', 'pass'),
  }, {
    id: 'output-offset', subject: 'billing', label: 'the echo check\'s fixed amount',
    ofRecord: (record) => outcome(record.fixedAmount?.outcome, 'flag', 'pass'),
    ofSummary: (summary) => outcome(summary.fixedAmount, 'flag', 'pass'),
  }],
  summarize: summarizeOutputEcho,
  // Its pre-check anchor (`precheckMatch`) is the pre-check of the same audit.
  readsEarlier: ['tokenizerPrecheck'],
  validate(record, context) {
    // Recomputed from the bytes the seller and its crowd signed.
    validateOutputEcho(record, context.auditedPeerId)
    // Its pre-check anchor is this audit's own pre-check, not a stored claim.
    if (record.precheckMatch !== (context.records.tokenizerPrecheck?.outcome === 'match')) {
      throw new Error(context.reader === 'confirmer'
        ? 'its echo check\'s pre-check match is not its pre-check'
        : 'the echo check\'s pre-check match is not this audit\'s pre-check')
    }
  },
  requests: (record) => [
    ...record.rounds.flatMap((round): EchoSellerAskV1[] => [...round.short, ...round.long, ...(round.repeats ? [round.repeats.short, round.repeats.long] : [])])
      .map((ask) => stored('audited', ask.request)),
    // Every vote the record stores, also one another audit of the run sent: its answer is material of this check too.
    ...(record.crowd?.votes ?? []).flatMap((vote) => [vote.short, vote.long].map((ask) => stored({ peerId: vote.peerId }, ask.request))),
  ],
  paid: outputEchoPaidRequests,
  // The record's overall flag makes the audit DIFF, described by the finding that flagged; the other tests still run.
  describeFlag: describeOutputEchoFlag,
  // A flag of the growth is given with the record's reason; one of the fixed amount is named by its label alone.
  inReport: (finding, summary) => (finding === 'output-echo' ? `echo check (${summary.rule}): ${summary.reason}` : null),
  // The record's overall flag, so a flag of either finding, with the record's one reason.
  inRunLine: (summary) => (summary.outcome === 'flag' ? `echo check: ${summary.reason}` : null),
  texts: {
    name: 'the echo check',
    summaryMismatch: 'the summary\'s echo check is not the one in its evidence',
  },
  phase: 'after-questions',
  thinking: {
    needs: { seller: 'own', reference: 'bank', crowd: 'reference' },
    why: 'the seller as for its questions; the reference and the model\'s other sellers with the bank\'s setting',
  },
  screen: (echo) => ({
    ready: (audit) => echo.ready(audit.bank),
    check: (audit) => echo.check(audit.seller, audit.bank, {
      thinking: asSuppression(audit.thinking.seller),
      // The model's other sellers are asked with the reference's thinking setting.
      crowdThinking: audit.thinking.crowd && asSuppression(audit.thinking.crowd),
      precheckMatch: audit.earlier.tokenizerPrecheck?.outcome === 'match',
      clock: audit.clock,
      // Work for the fixed amount alone keeps to the audit's spare time.
      spare: () => audit.spare(),
    }),
  }),
  toggle: { key: 'outputChecks', pinned: true },
  fingerprint: outputEchoFingerprint,
  whyNoRecord: async (read) => referenceDidNotApply(await read('output-echo-reference.json')),
  // The echo check of this model's sellers (`createOutputEchoScreen`): its texts are written and measured on
  // the reference once, and its crowd is every seller of the model the buyer would audit, as for the pre-check.
  forRun: () => ({ sellers, seller, reference, limiters, report }) => createOutputEchoScreen<KbfReferenceV1>({
    onReady: (record) => report.reference('output-echo', record),
    sellers,
    ...seller,
    ask: (bank) => (texts, signal) => reference.replies(bank, { contents: texts.map(outputEchoPrompt), maxTokens: OUTPUT_ECHO_RULE.maxTokens }, { signal, limiter: limiters.reference }),
  }),
}
