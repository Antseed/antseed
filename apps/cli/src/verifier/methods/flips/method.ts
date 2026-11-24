import { outcome, stored, type ReadingRules, type RecordCheck, type SellerAuditStart } from '../../audit-method.js'
import {
  FLIPS_AUDITOR_FAILURE, FLIPS_WAITING_FOR_REFERENCE, describeFlipsFlag, flipsFingerprint, flipsPaidRequests, flipsSellerSlots, isFlipsRecord, isProbeDraw, summarizeFlips,
  validateFlips,
  type FlipsStage, type FlipsV1,
} from './flips.js'
import { flipsForRun, flipsWithoutRecord } from './flips-run.js'
import { FLIPS_RULE, flipsCounts, flipsRuleById } from './flips-score.js'
import { FLIPS_THINKING } from './flips-thinking.js'

/** The randomness check (FLIPS) as the list of tests holds it (`../index.ts`): how its record is read, and how a run and an audit run it. */

/**
 * Whether a stored FLIPS counts, under the rule it was judged by (its `rule` id) or the FLIPS rule given
 * (`ReadingRules`), from its model: never from the stored flag alone. `flips-v1` changed in place from recorded only to
 * counting, so a `flips-v1` record is read as counting whenever it was judged. A rule this CLI does not know, chosen
 * dry-run pairs and a malformed draw never count.
 */
const flipsCountsFor = (record: FlipsV1, rules?: ReadingRules): boolean => {
  if (!isFlipsRecord(record) || isProbeDraw(record.draw)) return false
  const rule = rules?.flips ?? flipsRuleById(record.rule)
  return rule !== undefined && flipsCounts(record.draw.model, rule)
}

/** Whether a FLIPS summary can affect a verdict: its own rule's for its model, never a probe's or an unknown rule's. */
const flipsSummaryCounts = (summary: { model?: unknown; probe?: unknown; rule?: unknown }): boolean => {
  if (typeof summary.model !== 'string' || summary.probe !== undefined || typeof summary.rule !== 'string') return false
  const rule = flipsRuleById(summary.rule)
  return rule !== undefined && flipsCounts(summary.model, rule)
}

/** FLIPS's stage in an audit: `confirm` only when the audit confirms another auditor's FLIPS flag. */
const flipsStageOf = (audit: Pick<SellerAuditStart, 'confirming'>): FlipsStage => (audit.confirming.includes('flips') ? 'confirm' : 'first')

export const FLIPS_CHECK: RecordCheck<'flips'> = {
  slot: 'flips',
  findings: [{
    id: 'flips', subject: 'model', label: 'the randomness check',
    // Where FLIPS does not count it is recorded only: no flag and no pass for the verdict.
    ofRecord: (record, rules) => (flipsCountsFor(record, rules) ? outcome(record.outcome, 'flag', 'pass') : 'inconclusive'),
    ofSummary: (summary) => (flipsSummaryCounts(summary) ? outcome(summary.outcome, 'flag', 'pass') : 'inconclusive'),
    recordedOnly: (record, rules) => (flipsCountsFor(record, rules) ? null : outcome(record.outcome, 'flag', 'pass')),
    // A confirmation's counting FLIPS scored between its bars, under a rule whose such score clears like a pass.
    betweenOfRecord: (record, rules) => flipsCountsFor(record, rules) && record.draw.stage === 'confirm' && record.outcome === 'inconclusive'
      && record.p !== null && (rules?.flips ?? flipsRuleById(record.rule))?.confirmBetweenClears === true,
    betweenOfSummary: (flips) => flipsSummaryCounts(flips) && flips.stage === 'confirm' && flips.outcome === 'inconclusive' && typeof flips.p === 'number'
      && typeof flips.rule === 'string' && flipsRuleById(flips.rule)?.confirmBetweenClears === true,
    // FLIPS answers a waiting FLIPS flag only from a confirmation of FLIPS: its confirm stage (fresh pairs from the other
    // pool, 40 replies, the confirmation bar). A first look's FLIPS (20 replies, the first bar) neither confirms nor clears
    // it; the seller is audited again as a confirmation.
    confirmationOnly: { material: 'fresh pairs, 40 replies' },
  }],
  summarize: summarizeFlips,
  // Recomputed from the replies the seller signed and the reference replies stored with them.
  validate(record, context) {
    validateFlips(record)
    // The draw is this audit's: the confirmation stage exactly when it confirms FLIPS, and the audit's own model.
    const confirms = context.audit?.confirming?.includes('flips') ?? false
    if ((record.draw.stage === 'confirm') !== confirms) throw new Error('the randomness check\'s stage is not the one its audit calls for')
    const model = context.audit?.referenceModel
    if (model !== undefined && model.toLowerCase() !== record.draw.model.toLowerCase()) throw new Error('the randomness check was drawn for another model')
    // Its pairs are the reporting auditor's for the report's epoch: a draw of another epoch or auditor is not this audit's.
    const epoch = context.audit?.epoch
    if (epoch !== undefined && epoch !== record.draw.epoch) throw new Error('the randomness check was drawn for another epoch')
    const auditor = context.audit?.auditor
    if (auditor !== undefined && auditor.toLowerCase() !== record.draw.auditor.toLowerCase()) throw new Error('the randomness check was drawn for another auditor')
  },
  requests: (record) => flipsSellerSlots(record).map((slot) => stored('audited', slot.request)),
  paid: flipsPaidRequests,
  describeFlag: describeFlipsFlag,
  // A FLIPS flag is named by its label alone in a report, and FLIPS adds nothing to the run's line, where its flag is
  // named with the other tests that flagged.
  inReport: () => null,
  inRunLine: () => null,
  counts: (record) => flipsCountsFor(record),
  // For a seller with no FLIPS record: whether this build's rule counts FLIPS for the model at all.
  countsFor: (model, rules) => flipsCounts(model, rules?.flips ?? FLIPS_RULE),
  // Flag-only for the SAME rule: a counted FLIPS flag is a DIFF; its no result (too few usable replies, a reference that
  // is not whole, a seller asked another way than the reference) never blocks a SAME.
  sameNeedsPass: false,
  summaryCounts: (summary) => typeof summary === 'object' && summary !== null && flipsSummaryCounts(summary as { model?: unknown; probe?: unknown; rule?: unknown }),
  wellFormed: isFlipsRecord,
  // A scored FLIPS is carried whatever its outcome: a p between the bar and the pass is a result, and FLIPS is never
  // drawn twice for one audit chain. A check with no score is asked again.
  carriedByRetry: (record) => record.p !== null,
  // Only a counting result of this build's rule: a probe's score, a recorded-only or another rule's never finishes a
  // confirmation, since a production ask could still decide it.
  summaryCarriedByRetry: (summary) => typeof summary === 'object' && summary !== null && typeof (summary as { p?: unknown }).p === 'number'
    && (summary as { rule?: unknown }).rule === FLIPS_RULE.id && flipsSummaryCounts(summary as { model?: unknown; probe?: unknown; rule?: unknown }),
  texts: {
    name: 'the randomness check',
    summaryMismatch: 'the summary\'s randomness check is not the one in its evidence',
  },
  // FLIPS last.
  phase: 'after-questions',
  thinking: FLIPS_THINKING,
  // A carried record is kept only for its own stage: a first look's FLIPS never stands for a confirmation of FLIPS, or
  // the other way round. Without a screen too: a carried record of another stage is not this audit's, so it is not kept.
  carriedIsOfAudit: (carried, audit) => carried.draw.stage === flipsStageOf(audit),
  screen: (flips) => ({
    // The stage's FLIPS reference is decided before the seller is asked anything paid, once per model, stage and run:
    // where FLIPS counts and it is not whole, FLIPS is not active for the model this run and every audit runs without it;
    // only a confirmation of a report only FLIPS flagged, which could decide nothing without it, is not started.
    admit: {
      decide(audit) {
        if (flips.referenceDecision) {
          return flips.referenceDecision(flipsStageOf(audit), audit.seller.service, audit.bank, { confirming: audit.confirming })
        }
        // Its reference is asked while the questions run: FLIPS then adds only the seller's own time.
        flips.warm?.(audit.seller.service, audit.bank, flipsStageOf(audit))
        return 'ready'
      },
      notStarted: `${FLIPS_AUDITOR_FAILURE}: ${FLIPS_WAITING_FOR_REFERENCE}`,
    },
    // A requested probe is always run: a carried record that is no probe's, or a probe of other settings, is asked
    // again and not kept.
    keeps: (carried, audit) => !(carried.draw.stage !== flipsStageOf(audit)
      // A record of another rule than this build's is asked again under this one.
      || (flips.ruleId !== undefined && carried.rule !== flips.ruleId)
      // A probe's record is a diagnostic: without a probe on, the production FLIPS is asked.
      || (flips.probing !== true && isProbeDraw(carried.draw))
      || (flips.probing === true
        && (!isProbeDraw(carried.draw) || carried.probeSettings !== flips.probeSettings))),
    check: (audit) => flips.check(audit.seller, audit.bank, {
      stage: flipsStageOf(audit),
      // The seller's own discovered setting (`FLIPS_THINKING`).
      sellerThinking: audit.thinking.seller,
      clock: audit.clock,
      signal: audit.clock.signal,
    }),
    // FLIPS can be a diagnostic (recorded only): a write made only for it never stops the audit when it fails.
    bestEffortCheckpoint: true,
  }),
  toggle: { key: 'flips', pinned: true },
  fingerprint: () => ({
    ...flipsFingerprint(),
    // Counting by a record's own rule: this build's counts, a rule it does not know never does.
    countsByRule: [FLIPS_RULE.id, 'flips-unknown'].map((rule) => FLIPS_CHECK.summaryCounts!({ rule, model: 'claude-opus-5.5', outcome: 'flag' })),
  }),
  // The run's status file (`flips-run.ts`) says why the stage's reference gave FLIPS nothing to judge on, or why there
  // was no FLIPS at all this run.
  // The stage is the audit's own (`flipsStageOf`): a confirmation of another test asks FLIPS as a first look.
  whyNoRecord: async (read, audit) => flipsWithoutRecord(await read('flips-status.json'), flipsStageOf(audit)),
  // Its key, its probe and its own limiters once per run, then each model's screen (`flips-run.ts`).
  forRun: flipsForRun,
}
