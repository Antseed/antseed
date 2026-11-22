import { canonicalJsonStringify, type KbfReferenceV1 } from '@antseed/fingerprints'
import { auditedServiceNames } from './audited-models.js'
import type { MethodEnv, MethodRun, MethodScreen, OwnScreen, OwnScreenFor, SellerAuditStart } from './audit-method.js'
import {
  FLIPS_AUDITOR_FAILURE, FLIPS_WAITING_FOR_REFERENCE, describeFlipsFlag, flipsFingerprint, flipsPaidRequests, isFlipsRecord, isProbeDraw, summarizeFlips,
  validateFlips,
  type FlipsStage, type FlipsV1,
} from './flips.js'
import { flipsForRun } from './flips-run.js'
import { FLIPS_RULE, flipsCounts, flipsRuleById, type FlipsRule } from './flips-score.js'
import {
  createOutputCapScreen, describeOutputCapFlag, outputCapFingerprint, outputCapPaidRequests, summarizeOutputCap, validateOutputCap, type OutputCapV1,
} from './output-cap.js'
import {
  OUTPUT_ECHO_RULE, createOutputEchoScreen, describeOutputEchoFlag, outputEchoFingerprint, outputEchoPaidRequests, outputEchoPrompt, summarizeOutputEcho,
  validateOutputEcho,
  type EchoSellerAskV1, type OutputEchoV1,
} from './output-echo.js'
import type { PaidRequest, ProxyAuditEvidenceExchangeV1 } from './proxy-evidence.js'
import { matchesEnrolledService } from './response-auth-reader.js'
import { sameModelService } from './service-discovery.js'
import {
  TOKENIZER_PRECHECK_RULE,
  createTokenizerPrecheckScreen,
  describeTokenizerMismatch,
  measureTokenizerReference,
  summarizeTokenizerPrecheck,
  tokenizerPrecheckFingerprint,
  tokenizerPrecheckPaidRequests,
  validateTokenizerPrecheck,
  type TokenizerSellerRequestV1,
  type TokenizerPrecheckV1,
} from './tokenizer-precheck.js'

/**
 * The checks of a seller audit, behind one description each, so that every rule that reads them (which flagged, which
 * passed, which decided, what ended the audit) is written once over the list instead of once per check. Each check
 * keeps its own file, rule, record and judgement; the list only says how to read what it stored, how a run builds the
 * check's own screen for a model, and how an audit runs the check from that screen (`audit-method.ts`).
 */

/**
 * The checks of a seller audit that can end in DIFF, by the name a DIFF is attributed to. A DIFF is recorded on chain
 * only when a second auditor's check of the same name flags the seller too, on its own fresh material (`same-check.ts`).
 */
export type AuditCheckId = 'tokens' | 'output-cap' | 'output-echo' | 'output-offset' | 'flips' | 'kbf'

/** What a check judges: which model answers, or how the seller bills. */
export type CheckSubject = 'model' | 'billing'

/** A finding as every shared rule reads it. `not-run`: the audit holds no record of the check. */
export type CheckOutcome = 'flag' | 'pass' | 'inconclusive' | 'not-run'

/** One finding of one audit, read the same way for every check. */
export interface CheckReading {
  check: AuditCheckId
  subject: CheckSubject
  outcome: CheckOutcome
  /**
   * Set on a finding that is recorded only (FLIPS where it does not count): its judged outcome. `outcome` is then
   * `inconclusive`; `verdictOf` reads the judged one only when told to count recorded findings.
   */
  recordedOnly?: Exclude<CheckOutcome, 'not-run'>
  /**
   * Set on an `inconclusive` finding of a confirmation's FLIPS scored between its bars, under a rule whose such score
   * clears the waiting flag like a pass (`FlipsRule.confirmBetweenClears`): `verdictOf` and the same-check decision
   * read it, never the score itself.
   */
  between?: true
}

/** The evidence fields that hold a check's record. The names are the stored ones and never change. */
export interface CheckRecords {
  tokenizerPrecheck: TokenizerPrecheckV1
  outputCap: OutputCapV1
  outputEcho: OutputEchoV1
  flips: FlipsV1
}
export type CheckSlot = keyof CheckRecords

/**
 * What the readings use of a check in an audit's summary. Loose on purpose: the planner reads summaries of earlier
 * runs, and a field it does not find reads as not decided.
 */
export interface CheckSummaryOutcomes {
  outcome?: string
  growth?: string
  fixedAmount?: string
  /** FLIPS: the model it was drawn for (whether it counts is the rule's), and whether its pairs were chosen by hand. */
  model?: string
  probe?: true
}

/** The findings only a confirmation answers (`ConfirmationOnly`), by id. The same-check decision builds its codes from it. */
export type ConfirmationOnlyCheckId = 'flips'

/**
 * On a finding only a confirmation answers: a waiting flag of it is confirmed or cleared only by an audit made as a
 * confirmation of it. A first look's flag or pass of it answers nothing: it is not sent, and the seller is audited
 * again as a confirmation (`same-check.ts`). A finding without it is answered by a first look too.
 */
export interface ConfirmationOnly {
  /** What a confirmation of it is made on, as the reason for leaving a first look out says it. The reason is stored. */
  material: string
}

/**
 * One finding of a check. The echo check has two, every other check one. `confirmationOnly` is on the findings of
 * `ConfirmationOnlyCheckId` and on no other: the compiler holds the list to it.
 */
export type CheckFinding<Slot extends CheckSlot> = FindingReadings<Slot> & (
  | { id: ConfirmationOnlyCheckId; confirmationOnly: ConfirmationOnly }
  | { id: Exclude<AuditCheckId, ConfirmationOnlyCheckId>; confirmationOnly?: undefined }
)

/** A finding's name, and how it is read from a record and from a summary. */
interface FindingReadings<Slot extends CheckSlot> {
  id: AuditCheckId
  subject: CheckSubject
  /** As in a verdict reason: "the cap check". */
  label: string
  /** The finding in a stored record, from the check's own names (a pre-check `mismatch` is a flag). */
  ofRecord(record: CheckRecords[Slot], rules?: ReadingRules): Exclude<CheckOutcome, 'not-run'>
  /** The same finding in an audit's summary, for the planner, which has no evidence at hand. */
  ofSummary(summary: CheckSummaryOutcomes): Exclude<CheckOutcome, 'not-run'>
  /** For a finding that can be recorded only: its judged outcome when it is (then `ofRecord` reads `inconclusive`). */
  recordedOnly?(record: CheckRecords[Slot], rules?: ReadingRules): Exclude<CheckOutcome, 'not-run'> | null
  /** Whether an `inconclusive` finding is a score between the bars that clears like a pass (`CheckReading.between`). */
  betweenOfRecord?(record: CheckRecords[Slot], rules?: ReadingRules): boolean
  betweenOfSummary?(summary: CheckSummaryOutcomes): boolean
}

/**
 * The rules a reading is taken under, when not the ones the record was judged by: the eval replay and the dry-run
 * report read FLIPS under a rule that counts it (`counts.default` true, `counts.never` and unmeasured models still
 * respected), to show what the verdict would be. An audit and submit never pass any.
 */
export interface ReadingRules {
  flips?: FlipsRule
}

/**
 * One request a check stored, with whose signature its answer must carry: the audited seller's, or another seller's
 * of the model (a crowd vote, a backer of the reference), with the service it was asked as when the record names one.
 */
export interface StoredRequest {
  signer: 'audited' | { peerId: string; service?: string }
  requestIds: readonly string[]
  responseAuth: ProxyAuditEvidenceExchangeV1['responseAuth'] | null
}

/** The seller an audit is about, and the names its model is sold under. */
export interface SellerBinding {
  peerId: string
  service: string
  /** The model's other service names. Evidence does not store them: they are the audited model's (`audited-models.ts`). */
  serviceAliases: readonly string[]
  /** The audited model (the evidence's `referenceModel`): a reply signed for any spelling of it, as sellers are admitted, binds. */
  model?: string
}

/** What validating one stored record may read besides the record. */
export interface StoredAuditContext {
  /** The seller the evidence is about (`target.peerId`). */
  auditedPeerId: string
  /** The other records of the same evidence file: the echo check reads the pre-check's outcome. */
  records: StoredCheckRecords
  /** Who reads the record: submit its own audit, or a confirmer the first auditor's (the texts say whose). */
  reader: 'submit' | 'confirmer'
  /**
   * The audit around the record: the tests it confirms and the model its reference is of (from the evidence), and the
   * epoch and auditor of the report that publishes it (from the caller, which knows them).
   */
  audit?: { confirming?: readonly AuditCheckId[]; referenceModel?: string; epoch?: string; auditor?: string }
}

export type StoredCheckRecords = { readonly [Slot in CheckSlot]?: CheckRecords[Slot] }

/** A check whose result is one field of the seller's evidence: everything but the questions. */
export interface RecordCheck<Slot extends CheckSlot = CheckSlot> {
  slot: Slot
  /** In attribution order. */
  findings: readonly CheckFinding<Slot>[]
  /** The record as an audit's summary carries it; submit compares the two. */
  summarize(record: CheckRecords[Slot]): unknown
  /** Recomputes the record from the bytes it stores, with the rules that cross records. Throws. */
  validate(record: CheckRecords[Slot], context: StoredAuditContext): void
  /** The earlier tests whose records this one is judged against: it is carried into a retry only with them. */
  readsEarlier?: readonly CheckSlot[]
  /** Every request the record stores, with its signer, grouped by kind (the readers take a set or a minimum, not an order). */
  requests(record: CheckRecords[Slot]): StoredRequest[]
  /** Every request the check paid for, in the order its cost is summed. */
  paid(record: CheckRecords[Slot]): PaidRequest[]
  /** What a flag of this record found, in plain words, as the audit's verdict reason gives it. */
  describeFlag(record: CheckRecords[Slot]): string
  /**
   * Whether the record can affect a verdict at all. A record that cannot (FLIPS while it is recorded only) is a
   * diagnostic: its validation, its binding and its request times stay out of the verdict path.
   */
  counts?(record: CheckRecords[Slot]): boolean
  /** Whether a summary of it in a published result can affect a verdict; a check with `counts` only. */
  summaryCounts?(summary: unknown): boolean
  /** Whether a stored value has the record's shape: a carried or checkpointed record that does not is dropped. */
  wellFormed?(record: unknown): boolean
  /** Whether a scheduled retry carries this record; by default when a finding flagged or passed (`decidedRecords`). */
  carriedByRetry?(record: CheckRecords[Slot]): boolean
  /** `carriedByRetry` read from the record's summary in a result, for a check with that hook. */
  summaryCarriedByRetry?(summary: unknown): boolean
  /** The texts of a stored record that breaks the run's rules. */
  texts: {
    /** The check, as an error names it. */
    name: string
    summaryMismatch: string
  }
  /** When an audit asks the seller this test: before its questions or after them. Inside a phase the order is the list's. */
  phase: 'before-questions' | 'after-questions'
  /**
   * The test asks the seller with the seller's own thinking setting: while one is still to be asked, the audit
   * discovers that setting although no question batch is left.
   */
  asksWithSellerThinking?: true
  /**
   * Whether a carried record is this audit's at all, also where the test does not run (no screen, an extra set).
   * Without it any carried record is.
   */
  carriedIsOfAudit?(carried: CheckRecords[Slot], audit: SellerAuditStart): boolean
  /** The test as an audit runs it (`audit-method.ts`), from its own screen for the model and run. */
  screen(own: OwnScreen<Slot>): MethodScreen<Slot>
  /**
   * The config switch that turns the test off: `verifier.<key>` set to false. Any other value leaves it on. `pinned` is
   * the value the compat number stands for: a run with the switch set away from it judges by other rules
   * (`verifierRuleOverrides`).
   */
  toggle: { key: 'tokenizerPrecheck' | 'outputChecks' | 'flips'; pinned: boolean }
  /**
   * The test's block of the rules fingerprint, held there under its slot's name: its rule, its limits and what its
   * judge gives for fixed sample inputs, which live with the test. Every test has one, so a rule of any test in the
   * list is under the pinned hash (`verifierRulesFingerprint`).
   */
  fingerprint(): Record<string, unknown>
  /**
   * The test in one run. Called once, before any model lane, and only when the test is switched on: it does the work
   * its models share (a key, limiters of its own) and gives what builds the test's own screen for one model, which the
   * audit then runs through `screen`.
   */
  forRun(run: MethodRun): OwnScreenFor<Slot> | Promise<OwnScreenFor<Slot>>
  /**
   * A line for the operator about one model that does not wait for the test's screen: said for every model of a run,
   * also with the test switched off.
   */
  announce?(env: MethodEnv): void
}

const stored = (
  signer: StoredRequest['signer'],
  request: Pick<TokenizerSellerRequestV1, 'requestIds' | 'responseAuth'>,
): StoredRequest => ({ signer, requestIds: request.requestIds, responseAuth: request.responseAuth })

const outcome = (value: string | undefined, flag: string, pass: string): Exclude<CheckOutcome, 'not-run'> =>
  value === flag ? 'flag' : value === pass ? 'pass' : 'inconclusive'

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
  // (`tokenizerPrecheckSellers`), not only the ones this run audits: a retry, a confirmation or a
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
  texts: {
    name: 'the cap check',
    summaryMismatch: 'the summary\'s cap check is not the one in its evidence',
  },
  phase: 'after-questions',
  asksWithSellerThinking: true,
  screen: (cap) => ({
    ready: (audit) => cap.ready(audit.bank),
    check: (audit) => cap.check(audit.seller, audit.bank, audit.thinking, audit.clock),
  }),
  toggle: { key: 'outputChecks', pinned: true },
  fingerprint: outputCapFingerprint,
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
  texts: {
    name: 'the echo check',
    summaryMismatch: 'the summary\'s echo check is not the one in its evidence',
  },
  phase: 'after-questions',
  asksWithSellerThinking: true,
  screen: (echo) => ({
    ready: (audit) => echo.ready(audit.bank),
    check: (audit) => echo.check(audit.seller, audit.bank, {
      thinking: audit.thinking,
      // The model's other sellers are asked with the reference's thinking setting.
      crowdThinking: audit.crowdThinking,
      precheckMatch: audit.earlier.tokenizerPrecheck?.outcome === 'match',
      clock: audit.clock,
      // Work for the fixed amount alone keeps to the audit's spare time.
      spare: () => audit.spare(),
    }),
  }),
  toggle: { key: 'outputChecks', pinned: true },
  fingerprint: outputEchoFingerprint,
  // The echo check of this model's sellers (`createOutputEchoScreen`): its texts are written and measured on
  // the reference once, and its crowd is every seller of the model the buyer would audit, as for the pre-check.
  forRun: () => ({ sellers, seller, reference, limiters, report }) => createOutputEchoScreen<KbfReferenceV1>({
    onReady: (record) => report.reference('output-echo', record),
    sellers,
    ...seller,
    ask: (bank) => (texts, signal) => reference.replies(bank, { contents: texts.map(outputEchoPrompt), maxTokens: OUTPUT_ECHO_RULE.maxTokens }, { signal, limiter: limiters.reference }),
  }),
}

/**
 * Whether a stored FLIPS counts, under the rule it was judged by (its `rule` id) or the FLIPS rule given
 * (`ReadingRules`), from its model: never from the stored flag alone, and never under a later build's rule, so a record
 * judged while FLIPS was recorded only stays so. A rule this CLI does not know, chosen dry-run pairs and a malformed
 * draw never count.
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
    betweenOfSummary: (summary) => {
      const flips = summary as { rule?: unknown; stage?: unknown; outcome?: unknown; p?: unknown; model?: unknown; probe?: unknown }
      return flipsSummaryCounts(flips) && flips.stage === 'confirm' && flips.outcome === 'inconclusive' && typeof flips.p === 'number'
        && typeof flips.rule === 'string' && flipsRuleById(flips.rule)?.confirmBetweenClears === true
    },
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
  requests: (record) => record.pairs.flatMap((pair) => pair.seller.map((slot) => stored('audited', slot.request))),
  paid: flipsPaidRequests,
  describeFlag: describeFlipsFlag,
  counts: (record) => flipsCountsFor(record),
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
  // A carried record is kept only for its own stage: a first look's FLIPS never stands for a confirmation of FLIPS, or
  // the other way round. Without a screen too: a carried record of another stage is not this audit's, so it is not kept.
  carriedIsOfAudit: (carried, audit) => carried.draw.stage === flipsStageOf(audit),
  screen: (flips) => ({
    // The stage's FLIPS reference is decided before the seller is asked anything paid, once per model, stage and run:
    // where FLIPS counts and it is not whole, the audit is not started (the auditor's attempt, nothing paid), except on the
    // auditor's last attempt, which runs with FLIPS at no result (never for a report only FLIPS flagged).
    admit: {
      decide(audit) {
        if (flips.referenceDecision) {
          return flips.referenceDecision(flipsStageOf(audit), audit.seller.service, audit.bank, {
            lastAuditorAttempt: audit.lastAuditorAttempt,
            confirming: audit.confirming,
          })
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
      // A record of another rule than this build's (an earlier build's, recorded only) is asked again under this one.
      || (flips.ruleId !== undefined && carried.rule !== flips.ruleId)
      // A probe's record is a diagnostic: without a probe on, the production FLIPS is asked.
      || (flips.probing !== true && isProbeDraw(carried.draw))
      || (flips.probing === true
        && (!isProbeDraw(carried.draw) || carried.probeSettings !== flips.probeSettings))),
    check: (audit) => flips.check(audit.seller, audit.bank, {
      stage: flipsStageOf(audit),
      clock: audit.clock,
      signal: audit.clock.signal,
    }),
    // FLIPS can be a diagnostic (recorded only): a write made only for it never stops the audit when it fails.
    bestEffortCheckpoint: true,
  }),
  toggle: { key: 'flips', pinned: true },
  fingerprint: () => ({
    ...flipsFingerprint(),
    // Counting by a record's own rule: a flips-v1 summary never counts under this build, a flips-v2 one does.
    countsByRule: ['flips-v1', FLIPS_RULE.id, 'flips-unknown'].map((rule) => FLIPS_CHECK.summaryCounts!({ rule, model: 'claude-opus-5.5', outcome: 'flag' })),
  }),
  // Its key, its probe and its own limiters once per run, then each model's screen (`flips-run.ts`).
  forRun: flipsForRun,
}

/**
 * Whether an undecided confirmation would stay undecided however often it is asked again: every test it repeats that
 * neither flagged nor passed keeps its record on a retry (`carriedByRetry`), as a FLIPS scored between its bars does,
 * since FLIPS is never drawn twice for one audit chain. Such a confirmation is finished at once instead of paying for
 * its other tests up to the confirmation limit. False when a test it repeats would be asked again (the questions, or a
 * test with no result).
 */
export function confirmationCannotDecideOnRetry(
  result: { readonly [Slot in CheckSlot]?: CheckSummaryOutcomes | null } & { status: string; questionsStatus?: string; parsedProbeCount?: number; confirming?: readonly AuditCheckId[] | null },
): boolean {
  const confirming = result.confirming ?? []
  if (confirming.length === 0) return false
  const readings = readingsOfSummary(result)
  const decided = checksWith(readings, 'flag', 'pass')
  const open = confirming.filter((check) => !decided.includes(check))
  if (open.length === 0) return false
  return open.every((id) => {
    const check = RECORD_CHECKS.find((entry) => (entry.findings as readonly CheckFinding<CheckSlot>[]).some((finding) => finding.id === id))
    const summary = check ? result[check.slot] : null
    return check?.summaryCarriedByRetry !== undefined && summary != null && check.summaryCarriedByRetry(summary)
  })
}

/** The checks with a record, in run order and attribution order. Never reorder: the order is in the rules hash. */
export const RECORD_CHECKS = Object.freeze([TOKENS_CHECK, OUTPUT_CAP_CHECK, OUTPUT_ECHO_CHECK, FLIPS_CHECK] as const)

/** The questions have no record field: they are the evidence file itself. A description only. */
export const QUESTIONS_CHECK = Object.freeze({ id: 'kbf' as const, subject: 'model' as const, label: 'the questions' })

export const AUDIT_CHECK_IDS: readonly AuditCheckId[] = Object.freeze([
  ...RECORD_CHECKS.flatMap((check) => check.findings.map((finding) => finding.id)),
  QUESTIONS_CHECK.id,
])

/** A finding only a confirmation answers, as the same-check decision reads it. */
export interface ConfirmationOnlyFinding {
  id: ConfirmationOnlyCheckId
  label: string
  confirmationOnly: ConfirmationOnly
}

/** The findings of the list only a confirmation answers, in attribution order. */
export const CONFIRMATION_ONLY_FINDINGS: readonly ConfirmationOnlyFinding[] = Object.freeze(RECORD_CHECKS.flatMap((check) => (
  (check.findings as readonly CheckFinding<CheckSlot>[]).flatMap((finding) => (finding.confirmationOnly ? [finding] : []))
)))

type QuestionsVerdict = 'SAME' | 'DIFF' | 'UNDETERMINED' | null

const questionsReading = (asked: boolean, verdict: QuestionsVerdict): CheckReading => ({
  check: QUESTIONS_CHECK.id,
  subject: QUESTIONS_CHECK.subject,
  outcome: !asked ? 'not-run' : verdict === 'DIFF' ? 'flag' : verdict === 'SAME' ? 'pass' : 'inconclusive',
})

/**
 * Every finding of one audit, read from its evidence alone, in attribution order. The questions count when a batch
 * was sent, and `kbfVerdict` is theirs after any close-call extra sets.
 */
export function readingsOfEvidence(
  evidence: { readonly [Slot in CheckSlot]?: CheckRecords[Slot] } & { exchanges: readonly unknown[] },
  kbfVerdict: QuestionsVerdict,
  rules?: ReadingRules,
): CheckReading[] {
  const readings: CheckReading[] = []
  for (const check of RECORD_CHECKS) {
    const record = evidence[check.slot]
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      const recorded = record == null ? null : finding.recordedOnly?.(record, rules) ?? null
      const outcome = record == null ? 'not-run' : finding.ofRecord(record, rules)
      const between = record != null && outcome === 'inconclusive' && finding.betweenOfRecord?.(record, rules) === true
      readings.push({
        check: finding.id, subject: finding.subject, outcome,
        ...(recorded ? { recordedOnly: recorded } : {}),
        ...(between ? { between: true as const } : {}),
      })
    }
  }
  readings.push(questionsReading(evidence.exchanges.length > 0, kbfVerdict))
  return readings
}

/**
 * Every finding of one audit, read from its summary. The questions count when an answer was scored: the summary's
 * form of "a batch was sent", which agrees with it on valid evidence and is kept apart from it on purpose.
 */
export function readingsOfSummary(
  result: { readonly [Slot in CheckSlot]?: CheckSummaryOutcomes | null } & { status: string; questionsStatus?: string; parsedProbeCount?: number },
): CheckReading[] {
  const readings: CheckReading[] = []
  for (const check of RECORD_CHECKS) {
    const summary = result[check.slot]
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      const outcome = summary == null ? 'not-run' : finding.ofSummary(summary)
      const between = summary != null && outcome === 'inconclusive' && finding.betweenOfSummary?.(summary) === true
      readings.push({ check: finding.id, subject: finding.subject, outcome, ...(between ? { between: true as const } : {}) })
    }
  }
  // The questions' own verdict: an audit's `status` is DIFF when another test flagged, whatever the questions said.
  const questions = result.questionsStatus ?? result.status
  const status = questions === 'SAME' || questions === 'DIFF' ? questions : null
  readings.push(questionsReading((result.parsedProbeCount ?? 0) > 0, status))
  return readings
}

/** The checks of these readings with one of these outcomes, in attribution order. */
export function checksWith(readings: readonly CheckReading[], ...outcomes: CheckOutcome[]): AuditCheckId[] {
  return readings.filter((reading) => outcomes.includes(reading.outcome)).map((reading) => reading.check)
}

/** A plain name for people, as in a verdict reason. */
export function checkLabel(check: AuditCheckId): string {
  if (check === QUESTIONS_CHECK.id) return QUESTIONS_CHECK.label
  for (const entry of RECORD_CHECKS) {
    const finding = (entry.findings as readonly CheckFinding<CheckSlot>[]).find((candidate) => candidate.id === check)
    if (finding) return finding.label
  }
  throw new Error(`unknown audit check ${check}`)
}

/**
 * Each check with its record in these records, in run order. A slot that is absent or stored as null holds no record
 * (`== null` throughout, as the readers before this list did with `?.`): a file of other software may write null.
 */
export function recordsOf(records: StoredCheckRecords): Array<{ check: RecordCheck<CheckSlot>; record: CheckRecords[CheckSlot] | undefined }> {
  return RECORD_CHECKS.map((check) => ({ check: check as unknown as RecordCheck<CheckSlot>, record: records[check.slot] }))
}

/**
 * Every stored check record of one seller's evidence recomputed from the bytes it stores, with the rules that cross
 * records. For any reader of stored evidence: submit's own, and a confirmer reading the first auditor's.
 */
export function validateStoredChecks(
  evidence: StoredCheckRecords & StoredAuditTarget,
  reader: StoredAuditContext['reader'] = 'submit',
  report: ReportOfAudit = {},
): void {
  const context = storedAuditContext(evidence, reader, report)
  const seller = sellerBindingOf(evidence)
  for (const { check, record } of recordsOf(evidence)) {
    if (record == null || !countsTowardVerdict(check, record)) continue
    check.validate(record, context)
    assertBoundToSeller(check.requests(record), seller, check.texts.name)
  }
}

/**
 * Which report a confirmation answers: the tests it repeats and the chain time of the report (the latest, when several
 * reports of the seller wait). Stored in its evidence and checkpoints, so a carry or a resume keeps to that report.
 */
export interface ConfirmationIdentity {
  checks: readonly AuditCheckId[]
  reportedAt?: number
}

/** Whether two confirmations answer the same report with the same tests; one without a report time matches none. */
export function sameConfirmation(left: ConfirmationIdentity, right: ConfirmationIdentity): boolean {
  const key = (checks: readonly AuditCheckId[]) => [...new Set(checks)].sort().join(',')
  return left.reportedAt !== undefined && left.reportedAt === right.reportedAt && key(left.checks) === key(right.checks)
}

/** An auditor time in milliseconds (batch `timing.startedAt`, `receivedAt`) as the seconds the cutoffs are in. */
export function auditorSeconds(milliseconds: number): number {
  return Math.floor(milliseconds / 1_000)
}

/**
 * What an audit that resumes an earlier attempt may reuse: everything for a first look; in a confirmation, only
 * material of a confirmation of the same report and tests (`sameConfirmation`), each question batch and test record
 * fresh for it (`fresh`, in seconds, as submit reads it). A batch without a send time, any material of another report,
 * or any material at all when the report's time is unknown, is asked again.
 */
export function resumeMaterialFor<Exchange extends { timing?: { startedAt?: number } }>(
  source: { exchanges: readonly Exchange[]; records?: StoredCheckRecords; confirming?: ConfirmationIdentity | null },
  identity: ConfirmationIdentity | null,
  fresh: (earliestRequestAt: number | null) => boolean,
): { exchanges: Exchange[]; records: StoredCheckRecords } {
  if (!identity) return { exchanges: [...source.exchanges], records: source.records ?? {} }
  if (!source.confirming || !sameConfirmation(source.confirming, identity)) return { exchanges: [], records: {} }
  return {
    // Each batch is read as submit reads the audit: its own earliest auditor time, in submit's units.
    exchanges: source.exchanges.filter((exchange) => fresh(earliestAuditorTime([{ exchanges: [exchange] }]))),
    records: carriedIntoConfirmation(source.records ?? {}, { confirming: source.confirming }, identity, fresh),
  }
}

/** The epoch and auditor of the report a stored audit is published in, as its reader knows them. */
export interface ReportOfAudit {
  epoch?: string
  auditor?: string
}

function storedAuditContext(evidence: StoredCheckRecords & StoredAuditTarget, reader: StoredAuditContext['reader'], report: ReportOfAudit): StoredAuditContext {
  return {
    auditedPeerId: evidence.target.peerId, records: evidence, reader,
    audit: {
      ...(evidence.confirming ? { confirming: evidence.confirming.checks } : {}),
      referenceModel: evidence.reference.referenceModel,
      ...(report.epoch !== undefined ? { epoch: report.epoch } : {}),
      ...(report.auditor !== undefined ? { auditor: report.auditor } : {}),
    },
  }
}

/** Whether a record can affect the verdict (`RecordCheck.counts`); a check without that hook always can. */
function countsTowardVerdict(check: RecordCheck<CheckSlot>, record: CheckRecords[CheckSlot]): boolean {
  try {
    return check.counts?.(record) ?? true
  } catch {
    return false
  }
}

/** What a seller's evidence says about whom it audited. */
export interface StoredAuditTarget {
  target: { peerId: string; service: string }
  reference: { referenceModel: string }
  /** The tests the audit confirms, when it answers another auditor's DIFF. */
  confirming?: ConfirmationIdentity
}

/** The seller a stored audit is about, with its model's service names. */
export function sellerBindingOf(evidence: StoredAuditTarget): SellerBinding {
  return {
    peerId: evidence.target.peerId,
    service: evidence.target.service,
    serviceAliases: typeof evidence.reference?.referenceModel === 'string' ? auditedServiceNames(evidence.reference.referenceModel) : [],
    ...(typeof evidence.reference?.referenceModel === 'string' ? { model: evidence.reference.referenceModel } : {}),
  }
}

/** A signed service that is the audited model: its own name or a built-in name of it, by `sameModelService`. */
function serviceOfModel(signed: string, seller: SellerBinding): boolean {
  if (!seller.model) return false
  return [seller.model, ...seller.serviceAliases].some((name) => sameModelService(signed, name))
}

const peerKey = (peerId: string): string => peerId.toLowerCase().replace(/^0x/, '')

/**
 * Every verified reply a check stored is the one asked of the seller it is stored for: signed by that seller (the
 * audited one, or the backer or crowd seller named beside it), for a request this record sent (the signed request ID
 * is the one beside it and among the record's tries), and for the service it was asked as (the audited service, or
 * the one stored with a backer; the model's other names count as the same). A reply that is not verified is left to
 * the check, which does not count it.
 */
export function assertBoundToSeller(requests: readonly StoredRequest[], seller: SellerBinding, what: string): void {
  for (const request of requests) {
    const auth = request.responseAuth
    if (auth?.status !== 'verified') continue
    const record = auth.record
    if (!record) throw new Error(`${what}: a verified reply has no signed record`)
    const peerId = request.signer === 'audited' ? seller.peerId : request.signer.peerId
    if (typeof record.sellerPeerId !== 'string' || peerKey(record.sellerPeerId) !== peerKey(peerId)) {
      throw new Error(`${what}: a reply is not signed by the seller it is stored for`)
    }
    if (record.requestId !== auth.requestId || !request.requestIds.includes(record.requestId)) {
      throw new Error(`${what}: a signed reply answers another request than the one stored with it`)
    }
    // One rule for the audited seller, a backer and a crowd vote alike: the service asked, or any spelling of the
    // audited model by the rule sellers are admitted with (`sameModelService`), so a voter asked under its own spelling
    // binds although the evidence stores no service for it.
    const service = request.signer === 'audited' ? seller.service : request.signer.service ?? seller.service
    const signed = record.advertisedService
    if (typeof signed !== 'string' || !(matchesEnrolledService(service, signed, seller.serviceAliases) || serviceOfModel(signed, seller))) {
      throw new Error(`${what}: a reply is signed for another service than the one asked`)
    }
  }
}

/**
 * The test records of the first set of a seller's evidence against its audit's summary, as submit reads them: each
 * record valid and bound to the seller, and its summary the summary's. Every test runs in every audit, so no stop rule
 * is checked; the verdict over them is recomputed by the caller (`verdictOf`).
 */
export function validateCheckRecordsAgainstSummary(
  evidence: StoredCheckRecords & StoredAuditTarget,
  result: { readonly [Slot in CheckSlot]?: unknown },
  report: ReportOfAudit = {},
): void {
  const context = storedAuditContext(evidence, 'submit', report)
  const seller = sellerBindingOf(evidence)
  for (const { check, record } of recordsOf(evidence)) {
    // A diagnostic (a record or a summary that cannot affect the verdict) is neither validated nor compared: it can
    // hold up nothing, also when one side is missing.
    if (check.counts !== undefined) {
      const recordCounts = record != null && countsTowardVerdict(check, record)
      const summary = result[check.slot]
      const summaryCounts = summary != null && (() => {
        try {
          return check.summaryCounts?.(summary) ?? true
        } catch {
          return false
        }
      })()
      if (!recordCounts && !summaryCounts) continue
    }
    if (record != null) {
      check.validate(record, context)
      assertBoundToSeller(check.requests(record), seller, check.texts.name)
    }
    const stored = record == null ? null : check.summarize(record)
    if (canonicalJsonStringify(stored) !== canonicalJsonStringify(result[check.slot] ?? null)) throw new Error(check.texts.summaryMismatch)
  }
}

/** Every request the check records of one seller's evidence store, with their signers, in run order. */
export function storedRequestsOf(records: StoredCheckRecords): StoredRequest[] {
  return recordsOf(records).flatMap(({ check, record }) => (record == null ? [] : check.requests(record)))
}

/**
 * Unix seconds of the earliest request this audit rests on, on the auditor's own clock: when each question batch was
 * sent (reused batches keep their own times), and for every reply a check stored, when the buyer received it
 * (`responseAuth.record.receivedAt`, the buyer's local store time, in milliseconds like the batch times). Over the
 * first set and its extra sets. A check request stores no send time, so its time is its answer's: a request sent just
 * before a cutoff and answered after it counts as after it. The seller's signed times are never read: a seller could
 * back-date them to make every audit of it look stale. A request with no auditor time gives none; null when no request
 * has one, which is never fresh.
 */
export function earliestAuditorTime(
  evidences: ReadonlyArray<(StoredCheckRecords & { exchanges: ReadonlyArray<{ timing?: { startedAt?: number } }> }) | null | undefined>,
): number | null {
  const times: number[] = []
  for (const evidence of evidences) {
    if (!evidence) continue
    for (const exchange of evidence.exchanges) {
      if (typeof exchange.timing?.startedAt === 'number') times.push(exchange.timing.startedAt)
    }
    // A diagnostic's requests are no material of the verdict, so their times are not counted either.
    for (const { check, record } of recordsOf(evidence)) {
      if (record == null || !countsTowardVerdict(check, record)) continue
      for (const request of check.requests(record)) {
        // Only a verified reply gives a time: the reader keeps its local record for an invalid one too.
        if (request.responseAuth?.status !== 'verified') continue
        const at = request.responseAuth.record?.receivedAt
        if (typeof at === 'number') times.push(at)
      }
    }
  }
  const known = times.filter((time) => Number.isFinite(time) && time > 0)
  return known.length === 0 ? null : auditorSeconds(Math.min(...known))
}

/**
 * The format of a seller's evidence in which every test runs and none ends the audit: `result` is the questions' own,
 * and the audit's verdict is `verdictOf` over the test records and the questions. Required on every evidence file.
 */
export const ALL_TESTS_FORMAT = 'all-tests-v1' as const

/** A verdict as the questions, and an audit, give it. */
export type AuditVerdictValue = 'SAME' | 'DIFF' | 'UNDETERMINED'

/** One audit's verdict over every test it ran (`verdictOf`). */
export interface AuditVerdict {
  verdict: AuditVerdictValue
  /** Every test that flagged, in id order; the questions only when they say DIFF themselves. */
  flaggedBy: AuditCheckId[]
  /** Every test that passed, in id order. */
  passedBy: AuditCheckId[]
  /** Set on a confirmation in which none of the tests it repeats decided: the tests it repeats. */
  undecidedConfirmation: AuditCheckId[] | null
}

/**
 * The audit's verdict from every test it ran, rule `all-tests-v1` (Alex, 19 November):
 *
 * - A confirmation (`confirming`, the tests it repeats) in which no repeated test flagged and at least one did not
 *   decide is UNDETERMINED, whatever the other tests say: it is never sent, it counts as an attempt for the report it
 *   answers, and its retry asks only the tests still open. A repeated test that flags again makes it a DIFF at once; a
 *   SAME needs every repeated test decided.
 * - Otherwise any test that flagged makes it DIFF, attributed to every test that flagged.
 * - Otherwise it is the questions' own verdict, SAME or UNDETERMINED, exactly as the questions decide alone. A test
 *   that did not decide (inconclusive, did not apply, could not run) never blocks SAME.
 *
 * `readings` hold the questions' own finding (`readingsOfEvidence`, `readingsOfSummary`), so `kbf` flags only on the
 * questions' own DIFF. `questions` is their verdict after any close call.
 */
export function verdictOf(
  readings: readonly CheckReading[],
  questions: AuditVerdictValue,
  confirming?: readonly AuditCheckId[] | null,
  options: {
    /**
     * The questions are a close call still waiting for an extra set: a confirmation that repeats them is not
     * undecided yet, it waits for that set (`needsExtension`).
     */
    questionsPending?: boolean
  } = {},
): AuditVerdict {
  // The verdict as the readings give it; "what if FLIPS counted" is a reading under another rule (`ReadingRules`).
  const flaggedBy = checksWith(readings, 'flag')
  const passedBy = checksWith(readings, 'pass')
  // A confirmation's FLIPS scored between its bars under a rule whose such score clears like a pass (`between`).
  const clearsBetween = readings.filter((reading) => reading.between === true).map((reading) => reading.check)
  if (confirming && confirming.length > 0 && !confirming.some((check) => flaggedBy.includes(check))) {
    // The questions still waiting for an extra set are not undecided yet: the confirmation waits with them.
    const open = confirming.filter((check) => !passedBy.includes(check) && !clearsBetween.includes(check)
      && !(check === 'kbf' && options.questionsPending === true))
    const waits = options.questionsPending === true && confirming.includes('kbf') && !passedBy.includes('kbf')
    if (open.length > 0) return { verdict: 'UNDETERMINED', flaggedBy, passedBy, undecidedConfirmation: open }
    if (waits) return { verdict: 'UNDETERMINED', flaggedBy, passedBy, undecidedConfirmation: null }
  }
  if (flaggedBy.length > 0) return { verdict: 'DIFF', flaggedBy, passedBy, undecidedConfirmation: null }
  return { verdict: questions, flaggedBy, passedBy, undecidedConfirmation: null }
}

/**
 * The audit's verdict reason: what each test that flagged found (the questions with their own reason), the tests an
 * undecided confirmation repeats, or the questions' own reason when nothing flagged.
 */
export function auditVerdictReason(records: StoredCheckRecords, audit: AuditVerdict, questionsReason: string | null): string | null {
  if (audit.undecidedConfirmation) return `the test this confirmation must repeat (${audit.undecidedConfirmation.join(', ')}) did not decide`
  if (audit.verdict !== 'DIFF') return questionsReason
  const reasons: string[] = []
  for (const { check, record } of recordsOf(records)) {
    if (record != null && check.findings.some((finding) => audit.flaggedBy.includes(finding.id))) reasons.push(check.describeFlag(record))
  }
  if (audit.flaggedBy.includes('kbf') && questionsReason) reasons.push(questionsReason)
  return reasons.length > 0 ? reasons.join('; ') : questionsReason
}

/**
 * The test records a scheduled retry carries: only those that decided (flagged or passed, or judged when recorded
 * only), so a test with no result is asked again. A test judged against an earlier test's record (`readsEarlier`) is
 * carried only with that record: when the earlier test is asked again, so is it, also when the earlier test did not
 * run at all (`withoutOrphans`). A resume of an interrupted attempt carries every finished record, with the same rule.
 */
export function decidedRecords(records: StoredCheckRecords): StoredCheckRecords {
  const kept: { [Slot in CheckSlot]?: CheckRecords[Slot] } = {}
  for (const { check, record } of recordsOf(records)) {
    if (record == null) continue
    const decided = check.carriedByRetry?.(record) ?? (check.findings as readonly CheckFinding<CheckSlot>[]).some((finding) => {
      const outcome = finding.recordedOnly?.(record) ?? finding.ofRecord(record)
      return outcome === 'flag' || outcome === 'pass'
    })
    if (decided) (kept as Record<string, unknown>)[check.slot] = record
  }
  return withoutOrphans(kept)
}

/**
 * These records without any that would be judged against an earlier test's record that is not among them
 * (`readsEarlier`): that earlier test is asked now, absent or undecided before, so the dependant is asked again with it.
 */
export function withoutOrphans(records: StoredCheckRecords): StoredCheckRecords {
  const kept: { [Slot in CheckSlot]?: CheckRecords[Slot] } = { ...records }
  for (const { check, record } of recordsOf(records)) {
    if (record == null) continue
    // A record without its shape (a diagnostic from another build, a damaged checkpoint) is dropped, never read.
    if (check.wellFormed && !check.wellFormed(record)) {
      delete (kept as Record<string, unknown>)[check.slot]
      continue
    }
    if ((check.readsEarlier ?? []).some((slot) => kept[slot] == null)) delete (kept as Record<string, unknown>)[check.slot]
  }
  return kept
}

/**
 * The carried records a confirmation may keep: only from an attempt that was itself a confirmation, and only a record
 * whose every request is fresh for the report it answers (`fresh`, the time test of `same-check.ts` on the record's
 * earliest auditor time). A record from a first look, or one older than the report's cutoff, is asked again, with the
 * tests judged against it (`withoutOrphans`): old material would make the whole confirmation stale at submit.
 */
export function carriedIntoConfirmation(
  records: StoredCheckRecords,
  source: { confirming: ConfirmationIdentity | null | undefined },
  target: ConfirmationIdentity,
  fresh: (earliestRequestAt: number | null) => boolean,
): StoredCheckRecords {
  // Only from a confirmation of the same report, repeating the same tests: a record of another round is not this one's.
  if (!source.confirming || !sameConfirmation(source.confirming, target)) return {}
  const kept: { [Slot in CheckSlot]?: CheckRecords[Slot] } = {}
  for (const { check, record } of recordsOf(records)) {
    if (record == null) continue
    if (fresh(earliestAuditorTime([{ [check.slot]: record, exchanges: [] }]))) (kept as Record<string, unknown>)[check.slot] = record
  }
  return withoutOrphans(kept)
}
