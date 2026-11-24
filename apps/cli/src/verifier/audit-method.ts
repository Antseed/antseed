import type { KbfReferenceV1 } from '@antseed/fingerprints'
import type { ResolvedThinking, TestThinking } from './audit-thinking.js'
import type { CountedTestId } from './audit-test-counts.js'
import type { AuditTaskLimiter } from './audit-concurrency.js'
import type { FlipsScreen, FlipsSummary, FlipsV1 } from './methods/flips/flips.js'
import type { FlipsRule } from './methods/flips/flips-score.js'
import type { OutputCapScreen, OutputCapSummary, OutputCapV1 } from './methods/output-cap/output-cap.js'
import type { OutputEchoScreen, OutputEchoSummary, OutputEchoV1 } from './methods/output-echo/output-echo.js'
import type { SellerClock } from './methods/shared/seller-clock.js'
import type { SignedSellerRequestInput } from './methods/shared/signed-seller-request.js'
import type { TokenizerPrecheckScreen, TokenizerPrecheckSummary, TokenizerPrecheckV1, TokenizerSellerRequestV1 } from './methods/tokens/tokenizer-precheck.js'
import type { ReferenceRequestLimiter } from './model-reference.js'
import type { PaidRequest, ProxyAuditEvidenceExchangeV1 } from './proxy-evidence.js'
import type { ReferenceOracle } from './reference-oracle.js'

/**
 * What a test of a seller's audit is, for its own description (`methods/<test>/method.ts`), the list of the
 * descriptions (`methods/index.ts`) and the rules that read the list (`audit-checks.ts`).
 *
 * First the description (`RecordCheck`): how to read what a test stored, with the names its record, its summary and
 * its screen are kept under. Then how a seller's audit runs a test: what the audit asks of it while it runs, and what
 * a run gives it to build its screen from, so that the audit and the run loop over the list of tests instead of naming
 * each one. The questions are not among them: they are the audit itself.
 *
 * Every import of this module is a type, so nothing is loaded for it: a description imports it, the list imports the
 * descriptions and the rules import the list, and no module is reached again on the way.
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

/**
 * The evidence fields that hold a check's record. The names are the stored ones and never change.
 *
 * A test's slot is named three times, here and in the two interfaces below, once for each thing kept under it: its
 * record in a seller's evidence, its summary in an audit's result (`CheckSummaries`) and its own screen in an audit's
 * context (`CheckScreens`). Every other shape with a member per test is built from these three, so a new test adds
 * its slot to these three and to no other shape.
 */
export interface CheckRecords {
  /**
   * The tokenizer pre-check, the first test (`tokenizer-precheck.ts`); absent when none ran. On a `mismatch` the
   * verdict is DIFF, and the questions and the later tests still run (`all-tests-v1`).
   */
  tokenizerPrecheck: TokenizerPrecheckV1
  /**
   * The cap check that ran after the questions (`output-cap.ts`); absent when none ran or it does not apply to the
   * model this run. On a `flag` the verdict is DIFF, and the later tests still run.
   */
  outputCap: OutputCapV1
  /**
   * The echo check that ran after the cap check (`output-echo.ts`); absent when none ran or it does not apply to the
   * model this run. On a `flag` the verdict is DIFF, and the later tests still run.
   */
  outputEcho: OutputEchoV1
  /** The randomness check (FLIPS, `flips.ts`) that ran after the echo check; absent when none ran. */
  flips: FlipsV1
}
export type CheckSlot = keyof CheckRecords

/**
 * Each test's record as an audit's summary carries it (`RecordCheck.summarize`), under the slot's name: the members
 * of one seller's result (`ModelVerificationTargetResult`). The names are stored in summaries and never change.
 */
export interface CheckSummaries {
  /**
   * The tokenizer pre-check this audit started with; absent when none ran. On a `mismatch` the status is DIFF;
   * the questions were asked too, and their own verdict is `questionsStatus`.
   */
  tokenizerPrecheck: TokenizerPrecheckSummary
  /**
   * The cap check this audit ran after its questions; absent when none ran. On a `flag` the status is DIFF; the
   * questions' own verdict is `questionsStatus`.
   */
  outputCap: OutputCapSummary
  /** The echo check this audit ran after its cap check; absent when none ran. On a `flag` the status is DIFF. */
  outputEcho: OutputEchoSummary
  /** The randomness check (FLIPS) this audit ran last before its verdict; absent when none ran. */
  flips: FlipsSummary
}

/**
 * Each test's own screen for one model in one run, under the slot's name: the members of an audit's context
 * (`ProxyVerificationContext`) the run hands the audit, which runs the test through `RecordCheck.screen`.
 */
export interface CheckScreens {
  /**
   * When set, each first audit starts with the tokenizer pre-check (`tokenizer-precheck.ts`). The audited model's
   * screen for this run (`createTokenizerPrecheckScreen`): its reference is awaited before the seller's clock
   * starts, and the clock runs only while a pre-check request to the seller is out. A mismatch is a DIFF finding;
   * the questions and the other tests still run (`all-tests-v1`).
   */
  tokenizerPrecheck: Pick<TokenizerPrecheckScreen<KbfReferenceV1>, 'ready' | 'check'>
  /**
   * When set, each first audit runs the cap check after its questions (`output-cap.ts`), with the thinking setting
   * discovered before them: a seller whose delivered answer measures more than twice the reply limit, twice, is DIFF.
   */
  outputCap: Pick<OutputCapScreen<KbfReferenceV1>, 'ready' | 'check'>
  /**
   * When set, each first audit runs the echo check after the cap check (`output-echo.ts`): a seller that bills
   * output the model did not write, held against the model's other sellers, is DIFF.
   */
  outputEcho: Pick<OutputEchoScreen<KbfReferenceV1>, 'ready' | 'check'>
  /** The randomness check of this model's sellers (`flips.ts`); absent when it does not run. */
  flips: Pick<FlipsScreen<KbfReferenceV1>, 'check'> & Partial<Pick<FlipsScreen<KbfReferenceV1>, 'probing' | 'probeSettings' | 'warm' | 'ruleId' | 'referenceDecision'>>
}

/** A summary whose every member may be missing, and whose texts may be any text. */
type Loose<Summary> = { readonly [Key in keyof Summary]?: AnyText<Summary[Key]> }
type AnyText<Value> = Value extends string ? string : Value

/**
 * What the readings use of a check in an audit's summary: the slot's own summary (`CheckSummaries`), read loosely.
 * Loose on purpose: the planner reads summaries of earlier runs, and a field it does not find reads as not decided.
 */
export type CheckSummaryOutcomes<Slot extends CheckSlot = CheckSlot> = Loose<CheckSummaries[Slot]>

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
  ofSummary(summary: CheckSummaryOutcomes<Slot>): Exclude<CheckOutcome, 'not-run'>
  /** For a finding that can be recorded only: its judged outcome when it is (then `ofRecord` reads `inconclusive`). */
  recordedOnly?(record: CheckRecords[Slot], rules?: ReadingRules): Exclude<CheckOutcome, 'not-run'> | null
  /** Whether an `inconclusive` finding is a score between the bars that clears like a pass (`CheckReading.between`). */
  betweenOfRecord?(record: CheckRecords[Slot], rules?: ReadingRules): boolean
  betweenOfSummary?(summary: CheckSummaryOutcomes<Slot>): boolean
  /**
   * Why the finding is not active for the model in this run although its record is there, from the record's own bytes:
   * its reference switched it off for the whole model (`cause: 'run'`), or the rule does not count it for the model in
   * the way the reference answers (`cause: 'rule'`). Null when it is active. A seller-side cause never makes a finding
   * inactive. Without it a finding with a record is active whenever its test counts (`RecordCheck.counts`).
   */
  inactiveOfRecord?(record: CheckRecords[Slot]): InactiveCause | null
  /** What a record of the finding gives when it did not decide, in plain words; by default the record's `reason`. */
  undecided?(record: CheckRecords[Slot]): string | null
}

/**
 * Why a test is not active for a model in a run (`inactiveChecks`): it can neither block a SAME nor make a DIFF.
 * - `rule`: the rules do not count it for the model (FLIPS while it is recorded only, a finding not judged in the way
 *   the model is measured).
 * - `run`: the auditor's run had none of it for the model: its reference switched it off ("the reference's own answer
 *   could not be measured", "no reference to compare with"), or the test did not run for the model at all.
 */
export interface InactiveCause {
  cause: 'rule' | 'run'
  reason: string
}

/**
 * The rules a reading is taken under, when not the ones the record was judged by: the eval replay and the dry-run
 * report read FLIPS under a rule that counts it (`counts.default` true, unmeasured models still
 * respected), to show what the verdict would be. An audit and submit never pass any.
 */
export interface ReadingRules {
  flips?: FlipsRule
  /** Entries of the table of which tests count (`AUDIT_TEST_COUNTS`) to read by instead, for "what if it counted". */
  counts?: Partial<Record<CountedTestId, boolean>>
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

/**
 * A check whose result is one field of the seller's evidence: everything but the questions. Its phase and its thinking
 * declaration go together: a test asked before the questions is asked before the seller's discovery, so it cannot
 * need the seller's own setting, and the compiler refuses one that says it does.
 */
export type RecordCheck<Slot extends CheckSlot = CheckSlot> = RecordCheckBody<Slot> & (
  | {
    /** Asked before the questions: before thinking discovery, so never with the seller's own setting. */
    phase: 'before-questions'
    thinking: TestThinking<'bare' | 'fixed'>
  }
  | {
    /** Asked after the questions. Inside a phase the order is the list's. */
    phase: 'after-questions'
    /**
     * What the test's requests carry on each side (`audit-thinking.ts`). Required: a test declares its need and never
     * carries a setting table or a discovery of its own. While a test still to be asked needs the seller's own setting,
     * the audit discovers it, also when no question batch is left.
     */
    thinking: TestThinking
  }
)

/** Everything of a `RecordCheck` but its phase and its thinking declaration. */
export interface RecordCheckBody<Slot extends CheckSlot = CheckSlot> {
  slot: Slot
  /** In attribution order. */
  findings: readonly CheckFinding<Slot>[]
  /** The record as an audit's summary carries it; submit compares the two. */
  summarize(record: CheckRecords[Slot]): CheckSummaries[Slot]
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
   * A flag of one of the test's findings in a model report's reason, from the test's summary: what the test saw, with
   * its rule. Null where the report names the finding by its label alone. The report asks only for a finding that
   * flagged the seller in a DIFF (`flagInReport`).
   */
  inReport(finding: AuditCheckId, summary: CheckSummaries[Slot]): string | null
  /**
   * What the test adds to the run's line for a finished audit, from its summary: what it saw. Null when it adds
   * nothing. Not the words of `inReport`, and not its moment: the line does not name the rule, and the test speaks
   * whenever its own outcome is a flag, whatever the audit's verdict (`testsInRunLine`).
   */
  inRunLine(summary: CheckSummaries[Slot]): string | null
  /**
   * Whether the record can affect a verdict at all. A record that cannot (FLIPS where its rule does not count it) is a
   * diagnostic: its validation, its binding and its request times stay out of the verdict path.
   */
  counts?(record: CheckRecords[Slot]): boolean
  /** Whether a summary of it in a published result can affect a verdict; a check with `counts` only. */
  summaryCounts?(summary: unknown): boolean
  /**
   * Whether this build's rule counts the test for a model at all, for a seller of it with no record of the test; a check
   * with `counts` only. A test the rule never counts for the model is not active for it (`inactiveChecks`).
   */
  countsFor?(model: string, rules?: ReadingRules): boolean
  /**
   * Whether a SAME needs this test passed when it is active (`verdictOf`). True by default. False for a flag-only test:
   * its flag makes a DIFF, and its no result, a check that could not run, or one that could not ask the seller the way
   * the reference was asked never blocks a SAME and never makes an UNDETERMINED. The value is in the rules hash.
   */
  sameNeedsPass?: boolean
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
  /**
   * Whether a carried record is this audit's at all, also where the test does not run (no screen, an extra set).
   * Without it any carried record is.
   */
  carriedIsOfAudit?(carried: CheckRecords[Slot], audit: SellerAuditStart): boolean
  /** The test as an audit runs it (`MethodScreen`), from its own screen for the model and run. */
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
   * Why the test kept no record for a model's sellers in a run, from the files its own screen wrote beside the run's
   * audits (`read` gives one by name, null when it is not there): the test did not apply to the model, or its
   * reference gave it nothing to judge on. Null when the test wrote no such reason. The audit stores it in the seller's
   * evidence (`ProxyAuditEvidenceV1.noRecord`, `noRecordEntries`): the test is then not active for the seller, so it
   * never blocks a SAME (`inactiveChecks`). A seller-side cause must give null. A test that always keeps a record has none.
   * `audit.confirming` are the tests the audit confirms, none on a first look: a test with stages reads its own stage from it.
   */
  whyNoRecord?(read: (file: string) => Promise<unknown>, audit: { confirming: readonly AuditCheckId[] }): Promise<string | null>
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

/** One request of a record as the readers take it: who must have signed its answer, its tries and its answer's signature. */
export const stored = (
  signer: StoredRequest['signer'],
  request: Pick<TokenizerSellerRequestV1, 'requestIds' | 'responseAuth'>,
): StoredRequest => ({ signer, requestIds: request.requestIds, responseAuth: request.responseAuth })

/** A test's own word for its outcome as a finding's: its word for a flag, its word for a pass, and no result for any other. */
export const outcome = (value: string | undefined, flag: string, pass: string): Exclude<CheckOutcome, 'not-run'> =>
  value === flag ? 'flag' : value === pass ? 'pass' : 'inconclusive'

/** A test's own screen for one model in one run, as the run hands it to an audit: the context's field of the slot's name. */
export type OwnScreen<Slot extends CheckSlot> = CheckScreens[Slot]

/**
 * What a test is given once per run, before any model lane (`RecordCheck.forRun`): what its models share. A test reads
 * no config and no proxy state itself; what it needs of them is here or in `MethodEnv`.
 */
export interface MethodRun {
  epoch: string
  /** The epoch's evidence folder: where a file of the test's own that lasts the epoch is kept (FLIPS's key). */
  epochDir: string
  /**
   * The run's id, or the id of the run it resumes: what a draw of the run is seeded with, so a test an interrupted
   * audit did not finish is drawn as before.
   */
  runId: string
  /** The auditor's address, empty when it cannot be read. Read once per run, when first asked for. */
  auditor(): Promise<string>
  /** New limiters of the test's own, with the run's caps: its requests then never queue with the questions' or another test's. */
  ownLimiters: {
    reference(): ReferenceRequestLimiter
    seller(): AuditTaskLimiter
  }
  /** A warning for the operator about the run. No lane runs yet, so it is printed as it is, not above the run's progress. */
  warn(line: string): void
}

/** What a test is given for one model in one run, to build its own screen from (`OwnScreenFor`). */
export interface MethodEnv {
  model: string
  /**
   * The crowd: the model's sellers the buyer would audit in this run, whether or not the run audits them. One entry
   * per peer. Listed when a test asks for it.
   */
  readonly sellers: ReadonlyArray<{ peerId: string; service: string }>
  /** How a request reaches a seller with its signed bytes captured (`sendSignedRequest`); the limiter is the questions'. */
  seller: Required<Pick<SignedSellerRequestInput, 'proxyBaseUrl' | 'responseAuthReader' | 'limiter' | 'requestTimeoutMs'>>
  /** The audited model itself, asked by the auditor. */
  reference: ReferenceOracle
  limiters: {
    /** The run's one limiter of the tests' reference asks, so every model's asks share the configured cap. */
    reference: ReferenceRequestLimiter
  }
  /**
   * Side files and lines for the operator. Best effort: a test never fails an audit because a report could not be
   * written or said.
   */
  report: {
    /** Writes what a test's reference decided for the model this run beside the model's audits, as `<check>-reference.json`. Never fails. */
    reference(check: string, record: unknown): void
    /** Writes a side file of the test's own beside the model's audits, whole; rejects when it cannot be written. */
    file(name: string, content: unknown): Promise<void>
    /** A warning for the operator, above the run's progress. */
    warn(line: string): void
    /** A notice for the operator, above the run's progress. */
    note(line: string): void
  }
}

/** Builds a test's own screen for one model of the run; null when the test does not run for the model. */
export type OwnScreenFor<Slot extends CheckSlot> = (env: MethodEnv) => OwnScreen<Slot> | null

/** What a test is told about one seller's audit before the seller is asked anything. */
export interface SellerAuditStart {
  /** The audited seller, with every name its model is sold under. */
  seller: { peerId: string; service: string; serviceAliases: readonly string[] }
  /** The audit's question set: a test asks its reference on the route this set was enrolled on. */
  bank: KbfReferenceV1
  /** The tests this audit repeats for another auditor's waiting DIFF; empty on a first look. */
  confirming: readonly AuditCheckId[]
  /** This is the auditor's last attempt at the seller. */
  lastAuditorAttempt: boolean
}

/** What a test is told when it asks the seller: the audit as it stands at that moment. */
export interface SellerAudit extends SellerAuditStart {
  /**
   * The settings the test's requests carry, from its declaration (`RecordCheck.thinking`, `resolveThinking`): the
   * seller's own once discovery has run, the reference's from the bank, and the crowd's.
   */
  thinking: ResolvedThinking
  /** The records the audit holds so far, for a test judged against an earlier one (`RecordCheck.readsEarlier`). */
  earlier: StoredCheckRecords
  /** The seller's clock: references and crowds are the auditor's time, not the seller's. */
  clock: SellerClock
  /** Spare time for work that must not take the questions' time: it ends with the audit, or once only the questions' share is left. */
  spare(): AbortSignal
}

/**
 * A test's say on whether an audit starts, given before the seller is asked anything paid:
 * - `ready`: the audit runs.
 * - `not-started`: the audit is not started. It is the auditor's attempt and nothing is paid (`AuditNotStarted`).
 * - `without-…`: the audit runs and the test will have no result, which its own `check` sees to.
 *
 * These are the answers of the one test with a say (`FlipsReferenceDecision`), and the audit reads them as the test
 * gives them: translating an answer would take one more step between it and what the audit asks next.
 */
export type AdmitDecision = 'ready' | 'not-started' | `without-${string}`

/** One test for one model in one run, as an audit runs it: built from the test's own screen (`RecordCheck.screen`). */
export interface MethodScreen<Slot extends CheckSlot> {
  /** The test's say on whether the audit starts. Without it the audit always runs. */
  admit?: {
    /** A test that only starts its reference here answers at once; one that waits for its reference answers when it has it. */
    decide(audit: SellerAuditStart): AdmitDecision | Promise<AdmitDecision>
    /** What an audit this test does not start fails with: the text the run and the report show. */
    notStarted: string
  }
  /** Whether a carried record still stands for this audit, so the seller is not asked again. Without it any carried record does. */
  keeps?(carried: CheckRecords[Slot], audit: SellerAuditStart): boolean
  /** Reference work the audit waits for before the seller's clock starts. */
  ready?(audit: SellerAuditStart): Promise<unknown>
  /** One seller's check; null when it does not apply this run or found nothing to store. */
  check(audit: SellerAudit): Promise<CheckRecords[Slot] | null>
  /** A checkpoint written for this record alone may fail without failing the audit: the record is a diagnostic. */
  bestEffortCheckpoint?: true
}

/**
 * A test did not start a seller's audit (`MethodScreen.admit`): the auditor's attempt, with nothing asked of the seller
 * and nothing paid. The message is the text the run and the report show. `by` is the test's slot, stored beside that
 * text (`ModelVerificationFailure.notStartedBy`) so that the planner reads a mark and not a wording.
 */
export class AuditNotStarted extends Error {
  constructor(readonly by: CheckSlot, message: string) {
    super(message)
  }
}
