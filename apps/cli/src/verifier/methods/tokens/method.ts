import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { outcome, stored, type RecordCheck } from '../../audit-method.js'
import {
  TOKENIZER_PRECHECK_RULE,
  createTokenizerPrecheckScreen,
  describeTokenizerCounts,
  describeTokenizerMismatch,
  measureTokenizerReference,
  summarizeTokenizerPrecheck,
  tokenizerPrecheckFingerprint,
  tokenizerPrecheckPaidRequests,
  validateTokenizerPrecheck,
} from './tokenizer-precheck.js'

/** The tokenizer pre-check as the list of tests holds it (`../index.ts`): how its record is read, and how a run and an audit run it. */

export const TOKENS_CHECK: RecordCheck<'tokenizerPrecheck'> = {
  slot: 'tokenizerPrecheck',
  findings: [{
    id: 'tokens', subject: 'model', label: 'the token-count pre-check',
    ofRecord: (record) => outcome(record.outcome, 'mismatch', 'match'),
    ofSummary: (summary) => outcome(summary.outcome, 'mismatch', 'match'),
  }],
  summarize: summarizeTokenizerPrecheck,
  // A pre-check must follow from the signed responses it stores.
  validate: (record, context) => validateTokenizerPrecheck(record, context.auditedPeerId),
  requests: (record) => [
    ...record.rounds.flatMap((round) => round.seller.flatMap((ask) => [ask.base, ...(ask.probed ? [ask.probed] : [])]))
      .map((request) => stored('audited', request)),
    ...(record.crowd?.backers ?? []).flatMap((backer) => [backer.ask.base, ...(backer.ask.probed ? [backer.ask.probed] : [])]
      .map((request) => stored({ peerId: backer.peerId, service: backer.service }, request))),
  ],
  paid: tokenizerPrecheckPaidRequests,
  describeFlag: describeTokenizerMismatch,
  inReport: (_finding, summary) => `tokenizer pre-check (${summary.rule}): ${describeTokenizerCounts(summary)}`,
  inRunLine: (summary) => (summary.outcome === 'mismatch' ? `tokenizer pre-check: ${describeTokenizerCounts(summary)}` : null),
  texts: {
    name: 'the tokenizer pre-check',
    summaryMismatch: 'the summary\'s tokenizer pre-check is not the one in its evidence',
  },
  phase: 'before-questions',
  screen: (precheck) => ({
    ready: (audit) => precheck.ready(audit.bank),
    check: (audit) => precheck.check(audit.seller, audit.bank, audit.clock),
  }),
  toggle: { key: 'tokenizerPrecheck', pinned: true },
  fingerprint: tokenizerPrecheckFingerprint,
  // The tokenizer pre-check of this model's sellers (`createTokenizerPrecheckScreen`): its probes are
  // written and measured on the reference once, when the first seller is audited, whose question set
  // names the bank whose route is asked. Its crowd is every seller of the model the buyer would audit
  // (`auditableSellers`), not only the ones this run audits: a retry, a confirmation or a
  // `--peer` run audits one or two, and they alone could not tell a wrong reference from a wrong seller.
  forRun: () => ({ model, sellers, seller, reference, limiters, report }) => createTokenizerPrecheckScreen<KbfReferenceV1>({
    sellers,
    ...seller,
    onUnbacked: (crowd, referenceDelta) => report.warn(crowd.outvoted
      ? `${model}: ${crowd.largestGroup} sellers sign ${crowd.groupDelta} input tokens for a text the reference counts as ${referenceDelta}, `
        + `and only ${crowd.agree} sign the reference's count. The reference may not be the model they serve; such a seller is judged on its questions.`
      : `${model}: a seller signs input tokens that are off the reference's (${referenceDelta}) in every round, but none of the model's `
        + `${crowd.deltas.length - 1} other seller(s) signs the reference's count (${crowd.measured - 1} could be read). Nothing backs the reference; such a seller is judged on its questions.`),
    reference: async (bank) => {
      const measured = await measureTokenizerReference({
        ask: (contents, signal) => reference.inputTokens(bank, contents, { maxTokens: TOKENIZER_PRECHECK_RULE.maxTokens, signal, limiter: limiters.reference }),
      })
      const unmeasured = measured.rounds.find((round) => round.delta === null)
      if (unmeasured) {
        report.warn(`${model}: the tokenizer pre-check has no reference this run (${unmeasured.failure}); its sellers are judged on the questions alone`)
      }
      return measured
    },
  }),
}
