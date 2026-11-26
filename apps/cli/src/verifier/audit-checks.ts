import { canonicalJsonStringify } from '@antseed/fingerprints'
import { auditedServiceNames } from './audited-models.js'
import type {
  AuditCheckId, CheckFinding, CheckOutcome, CheckRecords, CheckSlot, CheckSubject, CheckSummaries, CheckSummaryOutcomes, ConfirmationOnly,
  ConfirmationOnlyCheckId, InactiveCause, ReadingRules, RecordCheck, StoredAuditContext, StoredCheckRecords, StoredRequest,
} from './audit-method.js'
import type { TestThinking } from './audit-thinking.js'
import { METHODS } from './methods/index.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { matchesEnrolledService } from './response-auth-reader.js'
import { AUDIT_TEST_COUNTS, notCountedReason, testBlocksSame, testCounts } from './audit-test-counts.js'
import { sanitizeOutcomeSummary } from './outcome-reason.js'
import { sellerSignatureProblem } from './seller-signature.js'
import { sameModelService } from './service-discovery.js'

/**
 * The checks of a seller audit, behind one description each, so that every rule that reads them (which flagged, which
 * passed, which decided, what ended the audit) is written once over the list instead of once per check. Each check
 * keeps its own folder, rule, record and judgement (`methods/<test>/`). Its description beside them (`method.ts`)
 * only says how to read what it stored, how a run builds the check's own screen for a model, how an audit runs the
 * check from that screen, and what the check says of an audit in a model report and in the run's line. The list of
 * the descriptions is `methods/index.ts`, and what a description is made of is in `audit-method.ts`. This module
 * holds the rules that read the list: the readings, the verdict, validation, the binding to the seller, what a retry
 * or a confirmation carries, and which report a confirmation answers.
 */

/** A description's types, for the modules that read them from here (`audit-method.ts` holds them). */
export type {
  AuditCheckId, CheckFinding, CheckOutcome, CheckRecords, CheckScreens, CheckSlot, CheckSummaries, ConfirmationOnlyCheckId, RecordCheck,
  StoredCheckRecords,
} from './audit-method.js'
import { peerComparisonKey } from './utils.js'

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
  /**
   * Set on a finding that is not active for the model in this run (`inactiveChecks`): it never blocks a SAME. Absent on
   * an active one, which must pass for the audit to be SAME (`verdictOf`).
   */
  inactive?: InactiveCause
  /**
   * Set on a finding of a flag-only test (the table's `blocksSame` false, `AUDIT_TEST_COUNTS`): its flag counts, and anything else never
   * blocks a SAME, also while it is active.
   */
  flagOnly?: true
}

/** A test that is not active for a model in a run, with why: as the seller's summary and the published result give it. */
export interface InactiveTest extends InactiveCause {
  check: AuditCheckId
}

/** A seller's own entry for a test that kept no record because the run had none of it for the model (`noRecord`). */
export interface NoRecordEntry {
  slot: string
  reason: string
}

/** The reason a result from before the active tests were recorded gives each of its tests: today's rule reads them. */
export const ACTIVE_NOT_RECORDED = 'a result from before the active tests were recorded: only the questions decide a SAME'

/** The seller an audit is about, and the names its model is sold under. */
export interface SellerBinding {
  peerId: string
  service: string
  /** The model's other service names. Evidence does not store them: they are the audited model's (`audited-models.ts`). */
  serviceAliases: readonly string[]
  /** The audited model (the evidence's `referenceModel`): a reply signed for any spelling of it, as sellers are admitted, binds. */
  model?: string
}

/**
 * Whether an undecided confirmation would stay undecided however often it is asked again: every test it repeats that
 * neither flagged nor passed keeps its record on a retry (`carriedByRetry`), as a FLIPS scored between its bars does,
 * since FLIPS is never drawn twice for one audit chain. Such a confirmation is finished at once instead of paying for
 * its other tests up to the confirmation limit. False when a test it repeats would be asked again (the questions, or a
 * test with no result).
 */
export function confirmationCannotDecideOnRetry(
  result: { readonly [Slot in CheckSlot]?: CheckSummaryOutcomes<Slot> | null } & { status: string; questionsStatus?: string; parsedProbeCount?: number; confirming?: readonly AuditCheckId[] | null },
): boolean {
  const confirming = result.confirming ?? []
  if (confirming.length === 0) return false
  const readings = readingsOfSummary(result)
  const decided = checksWith(readings, 'flag', 'pass')
  const open = confirming.filter((check) => !decided.includes(check))
  if (open.length === 0) return false
  return open.every((id) => {
    const check = METHODS.find((entry) => (entry.findings as readonly CheckFinding<CheckSlot>[]).some((finding) => finding.id === id))
    const summary = check ? result[check.slot] : null
    return check?.summaryCarriedByRetry !== undefined && summary != null && check.summaryCarriedByRetry(summary)
  })
}

/**
 * A check of the list with its slot kept: without an argument any check of the list, and in a function over `Slot`
 * that slot's check, so that what the function takes from the check and puts under the check's slot is held to the
 * slot's own types (its record, its summary, its screen) with no cast.
 */
export type ListedCheck<Slot extends CheckSlot = CheckSlot> = { [Each in Slot]: RecordCheck<Each> }[Slot]

/** The questions have no record field: they are the evidence file itself. A description only. */
/**
 * The questions, as the readings name them, with their thinking declaration: the first in the one list of what each
 * test sends (`THINKING_DECLARATIONS`). The questions set the pattern every test follows (`audit-thinking.ts`): as the
 * KBF reference code does, each endpoint is asked with its own discovered setting, the seller with its discovery's and
 * the reference with its bank's; the answers are compared, so the two may differ. The questions' own ways of asking a
 * batch stay theirs: a batch refused for its setting is sent again without it (`omittedThinkingSuppression`), and a
 * seller nothing stops thinking gets fifty times the tokens (`bare-expanded`).
 */
export const QUESTIONS_CHECK = Object.freeze({
  id: 'kbf' as const,
  subject: 'model' as const,
  label: 'the questions',
  thinking: Object.freeze({
    needs: Object.freeze({ seller: 'own', reference: 'bank' }),
    why: 'as the KBF reference code: each endpoint with its own discovered setting; the answers are compared, so the two sides may differ',
  }) as TestThinking,
})

/** Every test's thinking declaration, in run order: the questions first, then the tests with a record (`METHODS`). */
export const THINKING_DECLARATIONS: ReadonlyArray<{ test: AuditCheckId | CheckSlot; thinking: TestThinking }> = Object.freeze([
  { test: QUESTIONS_CHECK.id, thinking: QUESTIONS_CHECK.thinking },
  ...METHODS.map((check) => ({ test: check.slot, thinking: check.thinking as TestThinking })),
])

export const AUDIT_CHECK_IDS: readonly AuditCheckId[] = Object.freeze([
  ...METHODS.flatMap((check) => check.findings.map((finding) => finding.id)),
  QUESTIONS_CHECK.id,
])

/** A finding only a confirmation answers, as the same-check decision reads it. */
export interface ConfirmationOnlyFinding {
  id: ConfirmationOnlyCheckId
  label: string
  confirmationOnly: ConfirmationOnly
}

/** The findings of the list only a confirmation answers, in attribution order. */
export const CONFIRMATION_ONLY_FINDINGS: readonly ConfirmationOnlyFinding[] = Object.freeze(METHODS.flatMap((check) => (
  (check.findings as readonly CheckFinding<CheckSlot>[]).flatMap((finding) => (finding.confirmationOnly ? [finding] : []))
)))

type QuestionsVerdict = 'SAME' | 'DIFF' | 'UNDETERMINED' | null

const questionsReading = (asked: boolean, verdict: QuestionsVerdict): CheckReading => ({
  check: QUESTIONS_CHECK.id,
  subject: QUESTIONS_CHECK.subject,
  outcome: !asked ? 'not-run' : verdict === 'DIFF' ? 'flag' : verdict === 'SAME' ? 'pass' : 'inconclusive',
})

/** What `inactiveChecks` reads of a seller's evidence: its test records, its `noRecord` entries and its model. */
export type ActiveTestsInput = StoredCheckRecords & {
  noRecord?: readonly NoRecordEntry[] | null
  reference?: { referenceModel?: string }
}

/**
 * The findings that are not active for the seller's model in this run, in attribution order, from its evidence alone,
 * so the auditor that wrote it, `verifier submit` and any reader of the published evidence get the same list. A
 * finding is active when its rule counts it for the model and its reference gave it something to judge on:
 *
 * - With a record: not active when the record cannot affect a verdict (`RecordCheck.counts`: FLIPS while it is recorded
 *   only), or when its own gate says so from the record's bytes (`inactiveOfRecord`: the pre-check without a reference
 *   difference for every round; the echo check's fixed amount in visible mode).
 * - Without a record: not active when the rule never counts the test for the model (`countsFor`), or when the seller's
 *   evidence names it in `noRecord`: the run had none of the test for the model (its reference switched it off for the
 *   whole model, or it did not run for the model). A seller's own failure is never there.
 *
 * Every other finding is active: one with no result, or that did not run for this seller, keeps the audit from SAME.
 * The questions are always active.
 */
export function inactiveChecks(evidence: ActiveTestsInput, rules?: ReadingRules): InactiveTest[] {
  const inactive: InactiveTest[] = []
  const model = evidence.reference?.referenceModel
  for (const { check, record } of recordsOf(evidence)) {
    const entry = record == null ? (evidence.noRecord ?? []).find((candidate) => candidate.slot === check.slot) : undefined
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      // The table of which tests count first (`AUDIT_TEST_COUNTS`): a test it does not count decides nothing anywhere.
      const tableCounts = testCounts(finding.id, rules?.counts)
      // Then the test's own rule, under the rule the reading is taken by (`ReadingRules`, the record's own by default): a
      // finding that is recorded only is judged and stored, and decides nothing.
      const ruleCounts = record != null
        ? (finding.recordedOnly ? safely(() => finding.recordedOnly!(record, rules) === null, false) : countsTowardVerdict(check, record))
        : !(check.countsFor !== undefined && typeof model === 'string' && !safely(() => check.countsFor!(model, rules), true))
      const cause: InactiveCause | null = !tableCounts
        ? { cause: 'rule', reason: notCountedReason(finding.label) }
        : !ruleCounts
        ? { cause: 'rule', reason: `${finding.label} is recorded only: its rule does not count it for this model` }
        : record != null ? safely(() => finding.inactiveOfRecord?.(record) ?? null, null)
          : entry ? { cause: 'run', reason: entry.reason } : null
      if (cause) inactive.push({ check: finding.id, cause: cause.cause, reason: cause.reason })
    }
  }
  return inactive
}

/** The longest reason a `noRecord` entry keeps. */
export const NO_RECORD_REASON_LENGTH = 300

/**
 * The `noRecord` entries of one seller's audit: each test of the list without a record that the run had none of for
 * the model. A test with no screen for the model this run did not run for it (switched off, or nothing to run it with);
 * a test with a screen and no record says why from the files its screen wrote beside the run's audits
 * (`RecordCheck.whyNoRecord`): its reference switched it off for the model. A test that gives no such reason did not run
 * for this seller (the seller failed, the audit stopped) and has no entry: it stays active. Best effort: a file that is
 * missing or cannot be read gives nothing.
 */
export async function noRecordEntries(input: {
  records: StoredCheckRecords
  /** Whether the run had a screen of the test for the model. */
  screened: (slot: CheckSlot) => boolean
  read: (file: string) => Promise<unknown>
  confirming: readonly AuditCheckId[]
}): Promise<NoRecordEntry[]> {
  const found: NoRecordEntry[] = []
  for (const { check, record } of recordsOf(input.records)) {
    if (record != null) continue
    let reason: string | null = null
    try {
      reason = (await check.whyNoRecord?.(input.read, { confirming: input.confirming })) ?? null
    } catch {
      reason = null
    }
    if ((typeof reason !== 'string' || reason.length === 0) && !input.screened(check.slot)) {
      reason = `${check.texts.name} does not run for this model in this run`
    }
    if (typeof reason === 'string' && reason.length > 0) {
      found.push({ slot: check.slot, reason: sanitizeOutcomeSummary(reason).slice(0, NO_RECORD_REASON_LENGTH) })
    }
  }
  return found
}

/**
 * A seller's `noRecord` entries as stored evidence must hold them: each a test of the list with no record in the same
 * evidence, once, with a short reason. Throws otherwise: an entry beside a record would claim a test that ran was off.
 */
export function validateNoRecord(evidence: StoredCheckRecords & { noRecord?: unknown }): void {
  if (evidence.noRecord === undefined) return
  if (!Array.isArray(evidence.noRecord)) throw new Error('the evidence\'s tests without a record are not a list')
  const seen = new Set<string>()
  for (const entry of evidence.noRecord as unknown[]) {
    const slot = typeof entry === 'object' && entry !== null ? (entry as { slot?: unknown }).slot : undefined
    const reason = typeof entry === 'object' && entry !== null ? (entry as { reason?: unknown }).reason : undefined
    const check = METHODS.find((candidate) => candidate.slot === slot)
    if (!check || typeof reason !== 'string' || reason.length === 0 || reason.length > NO_RECORD_REASON_LENGTH) {
      throw new Error('the evidence names a test without a record that is not one of the list, or without a reason')
    }
    if (seen.has(check.slot)) throw new Error(`the evidence names ${check.texts.name} without a record twice`)
    seen.add(check.slot)
    if (evidence[check.slot] != null) throw new Error(`the evidence names ${check.texts.name} without a record beside its record`)
  }
}

/** A hook's answer, or the fallback when it throws on a damaged record. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

const inactiveOf = (inactive: readonly InactiveTest[], check: AuditCheckId): InactiveCause | undefined => {
  const entry = inactive.find((candidate) => candidate.check === check)
  return entry ? { cause: entry.cause, reason: entry.reason } : undefined
}

/**
 * Every finding of one audit, read from its evidence alone, in attribution order. The questions count when a batch
 * was sent, and `kbfVerdict` is theirs after any close-call extra sets. A finding that is not active for the model in
 * this run says so (`inactiveChecks`).
 */
export function readingsOfEvidence(
  evidence: ActiveTestsInput & { exchanges: readonly unknown[] },
  kbfVerdict: QuestionsVerdict,
  rules?: ReadingRules,
): CheckReading[] {
  const readings: CheckReading[] = []
  const inactive = inactiveChecks(evidence, rules)
  for (const check of METHODS) {
    const record = evidence[check.slot]
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      // A test the table does not count is read as recorded only: its judged outcome is kept beside, and decides nothing.
      const counted = testCounts(finding.id, rules?.counts)
      const judged = record == null ? null : finding.recordedOnly?.(record, rules) ?? finding.ofRecord(record, rules)
      const recorded = record == null ? null : counted ? finding.recordedOnly?.(record, rules) ?? null : judged
      const outcome = record == null ? 'not-run' : counted ? finding.ofRecord(record, rules) : 'inconclusive'
      const between = counted && record != null && outcome === 'inconclusive' && finding.betweenOfRecord?.(record, rules) === true
      const off = inactiveOf(inactive, finding.id)
      readings.push({
        check: finding.id, subject: finding.subject, outcome,
        ...(recorded ? { recordedOnly: recorded } : {}),
        ...(between ? { between: true as const } : {}),
        ...(off ? { inactive: off } : {}),
        ...(!testBlocksSame(finding.id) ? { flagOnly: true as const } : {}),
      })
    }
  }
  readings.push(questionsReading(evidence.exchanges.length > 0, kbfVerdict))
  return readings
}

/**
 * Every finding of one audit, read from its summary. The questions count when an answer was scored: the summary's
 * form of "a batch was sent", which agrees with it on valid evidence and is kept apart from it on purpose. Which tests
 * are active is the summary's `inactive`, its evidence's `inactiveChecks` (submit checks the two agree); a summary
 * written before it was recorded reads every test but the questions as not active, so it keeps the rule it was made by.
 */
export function readingsOfSummary(
  result: { readonly [Slot in CheckSlot]?: CheckSummaryOutcomes<Slot> | null } & {
    status: string; questionsStatus?: string; parsedProbeCount?: number; inactive?: readonly InactiveTest[] | null
  },
): CheckReading[] {
  const readings: CheckReading[] = []
  const recorded = Array.isArray(result.inactive) ? result.inactive : null
  for (const check of METHODS) {
    const summary = result[check.slot]
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      // A test the table does not count gives neither flag nor pass (`AUDIT_TEST_COUNTS`).
      const counted = testCounts(finding.id)
      const outcome = summary == null ? 'not-run' : counted ? finding.ofSummary(summary) : 'inconclusive'
      const between = counted && summary != null && outcome === 'inconclusive' && finding.betweenOfSummary?.(summary) === true
      const off = recorded ? inactiveOf(recorded, finding.id) : { cause: 'rule' as const, reason: ACTIVE_NOT_RECORDED }
      readings.push({
        check: finding.id, subject: finding.subject, outcome,
        ...(between ? { between: true as const } : {}),
        ...(off ? { inactive: off } : {}),
        ...(!testBlocksSame(finding.id) ? { flagOnly: true as const } : {}),
      })
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
  for (const entry of METHODS) {
    const finding = (entry.findings as readonly CheckFinding<CheckSlot>[]).find((candidate) => candidate.id === check)
    if (finding) return finding.label
  }
  throw new Error(`unknown audit check ${check}`)
}

/**
 * The checks that flagged the seller in one audit, read from its evidence alone, so the auditor that
 * wrote it, a confirming auditor and any reader of the published evidence get the same answer.
 *
 * - `tokens`: the tokenizer pre-check found a mismatch.
 * - `output-cap`: the cap check flagged (`output-cap.ts`).
 * - `output-echo`, `output-offset`: the echo check flagged a growth or a fixed amount (`output-echo.ts`).
 * - `kbf`: questions were asked and the questions' verdict (after any close-call extra sets, which is
 *   what `kbfVerdict` must be) is DIFF.
 *
 * Empty when nothing flagged. In the order of `AUDIT_CHECK_IDS`.
 */
export function flaggingChecks(
  evidence: Pick<ProxyAuditEvidenceV1, CheckSlot | 'exchanges'>,
  kbfVerdict: 'SAME' | 'DIFF' | 'UNDETERMINED' | null,
): AuditCheckId[] {
  return checksWith(readingsOfEvidence(evidence, kbfVerdict), 'flag')
}

/**
 * The checks that ran to a pass in one audit: the pre-check matched, the cap check passed, the questions
 * were asked and say SAME. A confirmer's SAME counts only when a check that flagged first passed here.
 * Each finding of the echo check passes on its own: a seller that only failed to be a candidate has not passed.
 */
export function passedChecks(
  evidence: Pick<ProxyAuditEvidenceV1, CheckSlot | 'exchanges'>,
  kbfVerdict: 'SAME' | 'DIFF' | 'UNDETERMINED' | null,
): AuditCheckId[] {
  return checksWith(readingsOfEvidence(evidence, kbfVerdict), 'pass')
}

/**
 * The checks of one audit scored between their bars where such a score clears a waiting flag like a pass (a
 * confirmation's FLIPS under `confirmBetweenClears`): the same-check decision credits them as passed.
 */
export function betweenChecks(
  evidence: Pick<ProxyAuditEvidenceV1, CheckSlot | 'exchanges'>,
  kbfVerdict: 'SAME' | 'DIFF' | 'UNDETERMINED' | null,
): AuditCheckId[] {
  return readingsOfEvidence(evidence, kbfVerdict).filter((reading) => reading.between === true).map((reading) => reading.check)
}

/** The checks an audit's summary shows flagged, for the planner. */
export function flaggedSummaryChecks(result: Parameters<typeof decidedChecks>[0]): AuditCheckId[] {
  return checksWith(readingsOfSummary(result), 'flag')
}

/** The checks an audit's summary shows decided (flagged or passed), for the planner, which has no evidence at hand. */
export function decidedChecks(result: Parameters<typeof readingsOfSummary>[0]): AuditCheckId[] {
  // A score between the bars that clears like a pass (`CheckReading.between`) decided too.
  const readings = readingsOfSummary(result)
  return [...new Set([...checksWith(readings, 'flag', 'pass'), ...readings.filter((reading) => reading.between === true).map((reading) => reading.check)])]
}

/**
 * What a finished local result decided, for `localResultAnswersConfirmation`: the checks it decided, or
 * `undecided-confirmation` for a confirmation that ran and did not decide. That is a result the epoch plan audits
 * again within its attempts (`confirmation_undecided`), or a confirmation (`confirmsDiff`) whose cell is done
 * UNDETERMINED: its attempts are used up, so it answers the target and the seller is not planned again in every run.
 */
export function localConfirmationDecision(
  result: Parameters<typeof decidedChecks>[0] & { outcomeReason?: { code?: string } | null; confirmsDiff?: boolean },
  done: boolean,
): AuditCheckId[] | 'undecided-confirmation' {
  if (result.outcomeReason?.code === 'confirmation_undecided') return 'undecided-confirmation'
  // Only a confirmation's own UNDETERMINED: a first look that overlapped the other auditor's flag answers nothing.
  if (done && result.status === 'UNDETERMINED' && result.confirmsDiff === true) return 'undecided-confirmation'
  return decidedChecks(result)
}

/** A plain name for people, as in a verdict reason. */
export function describeAuditCheck(check: AuditCheckId): string {
  return checkLabel(check)
}

/**
 * A finding that flagged a seller as a model report's reason names it: what its test saw, from the audit's summary
 * of the test (`inReport`), or the finding's plain name where the test gives no more or the result holds no summary
 * of it.
 */
export function flagInReport(check: AuditCheckId, result: Partial<CheckSummaries>): string {
  const said = <Slot extends CheckSlot>(entry: ListedCheck<Slot>): string | null => {
    const summary = result[entry.slot]
    return summary && entry.findings.some((finding) => finding.id === check) ? entry.inReport(check, summary) : null
  }
  for (const entry of METHODS) {
    const text = said(entry)
    if (text !== null) return text
  }
  return checkLabel(check)
}

/** What each test adds to the run's line for one finished audit, in run order (`RecordCheck.inRunLine`). */
export function testsInRunLine(result: Partial<CheckSummaries>): string[] {
  const said = <Slot extends CheckSlot>(check: ListedCheck<Slot>): string | null => {
    const summary = result[check.slot]
    return summary == null ? null : check.inRunLine(summary)
  }
  return METHODS.flatMap((check) => {
    const text = said(check)
    return text === null ? [] : [text]
  })
}

/**
 * Each check with its record in these records, in run order. A slot that is absent or stored as null holds no record
 * (`== null` throughout, as the readers before this list did with `?.`): a file of other software may write null.
 */
export function recordsOf(records: StoredCheckRecords): Array<{ check: RecordCheck<CheckSlot>; record: CheckRecords[CheckSlot] | undefined }> {
  return METHODS.map((check) => ({ check: check as unknown as RecordCheck<CheckSlot>, record: records[check.slot] }))
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
 * Every answer in a seller's evidence that came with a signed record is the seller's own (`sellerSignatureProblem`):
 * the question batches, and the requests of every test that counts toward the verdict. For a reader of another
 * auditor's published evidence, whose answers never passed through its own buyer proxy. An answer stored without a
 * record is no answer to the tests, which read only signed bytes.
 */
export function assertSellerSignatures(evidence: Pick<ProxyAuditEvidenceV1, 'exchanges'> & StoredCheckRecords): void {
  const refuse = (what: string, problem: string | null): void => {
    if (problem !== null) throw new Error(`${what}: an answer in the evidence is not authenticated: ${problem}`)
  }
  for (const exchange of evidence.exchanges) {
    if (exchange.responseAuth?.record) refuse('the questions', sellerSignatureProblem(exchange.responseAuth))
  }
  for (const { check, record } of recordsOf(evidence)) {
    if (record == null || !countsTowardVerdict(check, record)) continue
    for (const request of check.requests(record)) {
      if (request.responseAuth?.record) refuse(check.texts.name, sellerSignatureProblem(request.responseAuth))
    }
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

/**
 * Whether a record can affect the verdict: some finding of its test is counted by the table (`AUDIT_TEST_COUNTS`), and
 * its own rule counts it (`RecordCheck.counts`; a check without that hook always does). A record that cannot is a
 * diagnostic: its validation, its binding and its request times stay out of the verdict path.
 */
function countsTowardVerdict(check: RecordCheck<CheckSlot>, record: CheckRecords[CheckSlot]): boolean {
  if (!(check.findings as readonly CheckFinding<CheckSlot>[]).some((finding) => testCounts(finding.id))) return false
  try {
    return check.counts?.(record) ?? true
  } catch {
    return false
  }
}

/** The table of which tests count, for the modules that read it from here (`audit-test-counts.ts` holds it). */
export { AUDIT_TEST_COUNTS, testCounts }

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

const peerKey = peerComparisonKey

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
    const tableCounts = (check.findings as readonly CheckFinding<CheckSlot>[]).some((finding) => testCounts(finding.id))
    if (check.counts !== undefined || !tableCounts) {
      const recordCounts = record != null && countsTowardVerdict(check, record)
      const summary = result[check.slot]
      const summaryCounts = tableCounts && summary != null && (() => {
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
  /**
   * Set on an UNDETERMINED whose questions say SAME: the active tests that did not pass (no result, or not run for this
   * seller), in attribution order. Absent otherwise.
   */
  openTests?: AuditCheckId[]
}

/**
 * The audit's verdict from every test it ran, rule `all-tests-v1` (Alex, 19 November), with the table of how each test
 * takes part (`AUDIT_TEST_COUNTS`: which tests count, and which a SAME needs passed; Alex, 23 to 25 November). A test the
 * table does not count reads as neither flag nor pass (`readingsOfEvidence`), so it decides nothing here.
 *
 * A first look:
 * - any counting test that flagged makes it DIFF, attributed to every test that flagged;
 * - otherwise it is the questions' own verdict. A SAME needs passed only the active tests whose `blocksSame` is true
 *   (none today: "if the questions pass and there is no DIFF, call it SAME"); one of those with no result, or not run
 *   for this seller, makes it UNDETERMINED (`openTests`). A test that is not active, or flag-only (`flagOnly`), never
 *   blocks a SAME.
 *
 * A confirmation (`confirming`, the tests it repeats for another auditor's waiting DIFF) always decides something to
 * send (Alex, 25 November: "a confirmation must always send a result"), in this order:
 * 1. a repeated test flags again: DIFF, confirmed by the same test;
 * 2. every repeated test passed (or, for FLIPS, scored between its bars where that clears): SAME, which clears the
 *    waiting DIFF, whatever another test found here (its flag is asked again at the seller's next audit, where it goes
 *    the usual two-auditor way);
 * 3. the questions say SAME and no counting test flagged: SAME too;
 * 4. otherwise (another counting test flagged while the repeat did not pass, or nothing decided): UNDETERMINED. It is
 *    an undecided confirmation (`undecidedConfirmation`): asked again within its attempts, and its last attempt is
 *    sent, so the waiting DIFF is answered. Another test's flag is never sent as a DIFF that answers this report: the
 *    contract counts any two DIFF reports, and only the same test confirms a DIFF.
 * A confirmation of the questions whose close call still waits for its extra set waits with it.
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
  if (confirming && confirming.length > 0) {
    // 1. The same test flags again.
    if (confirming.some((check) => flaggedBy.includes(check))) return { verdict: 'DIFF', flaggedBy, passedBy, undecidedConfirmation: null }
    // The questions still waiting for an extra set are not undecided yet: the confirmation waits with them.
    if (options.questionsPending === true && confirming.includes('kbf') && !passedBy.includes('kbf')) {
      return { verdict: 'UNDETERMINED', flaggedBy, passedBy, undecidedConfirmation: null }
    }
    const open = confirming.filter((check) => !passedBy.includes(check) && !clearsBetween.includes(check))
    // 2. Every repeated test passed; 3. the questions say SAME and nothing that counts flagged.
    if (open.length === 0 || (questions === 'SAME' && flaggedBy.length === 0)) return { verdict: 'SAME', flaggedBy, passedBy, undecidedConfirmation: null }
    // 4. Nothing decided, or another test flagged while the repeat did not pass.
    return { verdict: 'UNDETERMINED', flaggedBy, passedBy, undecidedConfirmation: open }
  }
  if (flaggedBy.length > 0) return { verdict: 'DIFF', flaggedBy, passedBy, undecidedConfirmation: null }
  // A SAME needs passed every active test the table says blocks it: one with no result, or not run for this seller,
  // leaves the audit open. None does today.
  const openTests = readings.filter((reading) => reading.check !== QUESTIONS_CHECK.id && reading.inactive === undefined && reading.flagOnly !== true
    && reading.outcome !== 'pass' && reading.between !== true).map((reading) => reading.check)
  if (questions === 'SAME' && openTests.length > 0) return { verdict: 'UNDETERMINED', flaggedBy, passedBy, undecidedConfirmation: null, openTests }
  return { verdict: questions, flaggedBy, passedBy, undecidedConfirmation: null }
}

/**
 * The audit's verdict reason: what each test that flagged found (the questions with their own reason), the tests an
 * undecided confirmation repeats, or the questions' own reason when nothing flagged.
 */
export function auditVerdictReason(records: StoredCheckRecords, audit: AuditVerdict, questionsReason: string | null): string | null {
  if (audit.undecidedConfirmation) return `the test this confirmation must repeat (${audit.undecidedConfirmation.join(', ')}) did not decide`
  if (audit.openTests && audit.openTests.length > 0) return openTestsReason(records, audit.openTests)
  // A confirmation's SAME beside another test's flag (`verdictOf`, step 2): the flag is asked again at the next audit.
  if (audit.verdict === 'SAME' && audit.flaggedBy.length > 0) {
    const others = `${audit.flaggedBy.map(checkLabel).join(' and ')} flagged here, and is asked again at the seller's next audit: a DIFF is confirmed only by the same test`
    return questionsReason ? `${questionsReason}; ${others}` : others
  }
  if (audit.verdict !== 'DIFF') return questionsReason
  const reasons: string[] = []
  for (const { check, record } of recordsOf(records)) {
    if (record != null && check.findings.some((finding) => audit.flaggedBy.includes(finding.id))) reasons.push(check.describeFlag(record))
  }
  if (audit.flaggedBy.includes('kbf') && questionsReason) reasons.push(questionsReason)
  return reasons.length > 0 ? reasons.join('; ') : questionsReason
}

/** The longest text of one test in the reason of an open SAME (`openTestsReason`). */
const OPEN_TEST_REASON_LENGTH = 200

/**
 * Why an audit whose questions say SAME is UNDETERMINED, in plain words: each active test that did not pass, by name,
 * with what it found ("the echo check ran and did not decide: a round was under") or that it did not run for the seller.
 */
export function openTestsReason(records: StoredCheckRecords, openTests: readonly AuditCheckId[]): string {
  const parts: string[] = []
  for (const { check, record } of recordsOf(records)) {
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      if (!openTests.includes(finding.id)) continue
      if (record == null) {
        parts.push(`${finding.label} did not run for this seller`)
        continue
      }
      const said = safely(() => finding.undecided?.(record) ?? null, null)
        ?? (typeof (record as { reason?: unknown }).reason === 'string' ? (record as { reason: string }).reason : null)
      // Clipped and cleaned: a test's reason can quote a seller's error body.
      const shown = said ? sanitizeOutcomeSummary(said).slice(0, OPEN_TEST_REASON_LENGTH) : ''
      parts.push(shown ? `${finding.label} ran and did not decide: ${shown}` : `${finding.label} ran and did not decide`)
    }
  }
  return `the questions say SAME, but a SAME needs every active test passed: ${parts.join('; ')}`
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
