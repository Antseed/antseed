import { canonicalJsonStringify } from '@antseed/fingerprints'
import { summarizeOutputCap, validateOutputCap, type OutputCapV1 } from './output-cap.js'
import { summarizeOutputEcho, validateOutputEcho, type OutputEchoV1 } from './output-echo.js'
import { summarizeTokenizerPrecheck, validateTokenizerPrecheck, type TokenizerPrecheckV1 } from './tokenizer-precheck.js'

/**
 * The checks of a seller audit, behind one description each, so that every rule that reads them (which flagged, which
 * passed, which decided, what ended the audit) is written once over the list instead of once per check. Each check
 * keeps its own file, rule, record and judgement; the list only says how to read what it stored.
 */

/**
 * The checks of a seller audit that can end in DIFF, by the name a DIFF is attributed to. A DIFF is recorded on chain
 * only when a second auditor's check of the same name flags the seller too, on its own fresh material (`same-check.ts`).
 */
export type AuditCheckId = 'tokens' | 'output-cap' | 'output-echo' | 'output-offset' | 'kbf'

/** What a check judges: which model answers, or how the seller bills. */
export type CheckSubject = 'model' | 'billing'

/** A finding as every shared rule reads it. `not-run`: the audit holds no record of the check. */
export type CheckOutcome = 'flag' | 'pass' | 'inconclusive' | 'not-run'

/** One finding of one audit, read the same way for every check. */
export interface CheckReading {
  check: AuditCheckId
  subject: CheckSubject
  outcome: CheckOutcome
}

/** The evidence fields that hold a check's record. The names are the stored ones and never change. */
export interface CheckRecords {
  tokenizerPrecheck: TokenizerPrecheckV1
  outputCap: OutputCapV1
  outputEcho: OutputEchoV1
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
}

/** One finding of a check. The echo check has two, every other check one. */
export interface CheckFinding<Slot extends CheckSlot> {
  id: AuditCheckId
  subject: CheckSubject
  /** As in a verdict reason: "the cap check". */
  label: string
  /** The finding in a stored record, from the check's own names (a pre-check `mismatch` is a flag). */
  ofRecord(record: CheckRecords[Slot]): Exclude<CheckOutcome, 'not-run'>
  /** The same finding in an audit's summary, for the planner, which has no evidence at hand. */
  ofSummary(summary: CheckSummaryOutcomes): Exclude<CheckOutcome, 'not-run'>
}

/** What validating one stored record may read besides the record. */
export interface StoredAuditContext {
  /** The seller the evidence is about (`target.peerId`). */
  auditedPeerId: string
  /** The other records of the same evidence file: the echo check reads the pre-check's outcome. */
  records: StoredCheckRecords
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
  /** The finding a flag of this record would end the audit with, before the questions; null when it flags nothing that ends it. */
  endingFinding(record: CheckRecords[Slot]): AuditCheckId | null
  /** The texts of a stored record that breaks the run's rules. */
  texts: {
    summaryMismatch: string
    /** It ran although an earlier check's flag had ended the audit. Unused for the first check. */
    ranAfterDiff: string
    endsWithDiff: string
    extraSetAfterDiff: string
  }
  /**
   * Whether a summary shows that this check ended the audit with a DIFF before the questions. It is the record's own
   * overall outcome, not any one finding: a finding that does not count yet (the echo check's fixed amount) ends nothing.
   */
  endedAuditInSummary(summary: CheckSummaryOutcomes): boolean
}

const outcome = (value: string | undefined, flag: string, pass: string): Exclude<CheckOutcome, 'not-run'> =>
  value === flag ? 'flag' : value === pass ? 'pass' : 'inconclusive'

export const TOKENS_CHECK: RecordCheck<'tokenizerPrecheck'> = {
  slot: 'tokenizerPrecheck',
  findings: [{
    id: 'tokens', subject: 'model', label: 'the token-count pre-check',
    ofRecord: (record) => outcome(record.outcome, 'mismatch', 'match'),
    ofSummary: (summary) => outcome(summary.outcome, 'mismatch', 'match'),
  }],
  endedAuditInSummary: (summary) => summary.outcome === 'mismatch',
  summarize: summarizeTokenizerPrecheck,
  // A pre-check must follow from the signed responses it stores.
  validate: (record, context) => validateTokenizerPrecheck(record, context.auditedPeerId),
  endingFinding: (record) => (record.outcome === 'mismatch' ? 'tokens' : null),
  texts: {
    summaryMismatch: 'the summary\'s tokenizer pre-check is not the one in its evidence',
    ranAfterDiff: 'a tokenizer pre-check after a DIFF that ended the audit',
    endsWithDiff: 'a tokenizer pre-check mismatch is a DIFF with no question asked',
    extraSetAfterDiff: 'extra set after a tokenizer pre-check DIFF',
  },
}

export const OUTPUT_CAP_CHECK: RecordCheck<'outputCap'> = {
  slot: 'outputCap',
  findings: [{
    id: 'output-cap', subject: 'billing', label: 'the cap check',
    ofRecord: (record) => outcome(record.outcome, 'flag', 'pass'),
    ofSummary: (summary) => outcome(summary.outcome, 'flag', 'pass'),
  }],
  endedAuditInSummary: (summary) => summary.outcome === 'flag',
  summarize: summarizeOutputCap,
  // Recomputed from the bytes the seller signed.
  validate: (record) => validateOutputCap(record),
  endingFinding: (record) => (record.outcome === 'flag' ? 'output-cap' : null),
  texts: {
    summaryMismatch: 'the summary\'s cap check is not the one in its evidence',
    ranAfterDiff: 'a cap check after a tokenizer pre-check DIFF',
    endsWithDiff: 'a cap check flag is a DIFF with no question asked',
    extraSetAfterDiff: 'extra set after a cap check DIFF',
  },
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
  endedAuditInSummary: (summary) => summary.outcome === 'flag',
  summarize: summarizeOutputEcho,
  validate(record, context) {
    // Recomputed from the bytes the seller and its crowd signed.
    validateOutputEcho(record, context.auditedPeerId)
    // Its pre-check anchor is this audit's own pre-check, not a stored claim.
    if (record.precheckMatch !== (context.records.tokenizerPrecheck?.outcome === 'match')) {
      throw new Error('the echo check\'s pre-check match is not this audit\'s pre-check')
    }
  },
  // The record's overall flag ends the audit, attributed to the finding that flagged.
  endingFinding: (record) => (record.outcome !== 'flag' ? null : record.flag === 'offset' ? 'output-offset' : 'output-echo'),
  texts: {
    summaryMismatch: 'the summary\'s echo check is not the one in its evidence',
    ranAfterDiff: 'an echo check after a DIFF that ended the audit',
    endsWithDiff: 'an echo check flag is a DIFF with no question asked',
    extraSetAfterDiff: 'extra set after an echo check DIFF',
  },
}

/** The checks with a record, in run order and attribution order. Never reorder: the order is in the rules hash. */
export const RECORD_CHECKS = Object.freeze([TOKENS_CHECK, OUTPUT_CAP_CHECK, OUTPUT_ECHO_CHECK] as const)

/** The questions have no record field: they are the evidence file itself. A description only. */
export const QUESTIONS_CHECK = Object.freeze({ id: 'kbf' as const, subject: 'model' as const, label: 'the questions' })

export const AUDIT_CHECK_IDS: readonly AuditCheckId[] = Object.freeze([
  ...RECORD_CHECKS.flatMap((check) => check.findings.map((finding) => finding.id)),
  QUESTIONS_CHECK.id,
])

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
): CheckReading[] {
  const readings: CheckReading[] = []
  for (const check of RECORD_CHECKS) {
    const record = evidence[check.slot]
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      readings.push({ check: finding.id, subject: finding.subject, outcome: record === undefined ? 'not-run' : finding.ofRecord(record) })
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
  result: { readonly [Slot in CheckSlot]?: CheckSummaryOutcomes } & { status: string; parsedProbeCount?: number },
): CheckReading[] {
  const readings: CheckReading[] = []
  for (const check of RECORD_CHECKS) {
    const summary = result[check.slot]
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      readings.push({ check: finding.id, subject: finding.subject, outcome: summary === undefined ? 'not-run' : finding.ofSummary(summary) })
    }
  }
  const status = result.status === 'SAME' || result.status === 'DIFF' ? result.status : null
  readings.push(questionsReading((result.parsedProbeCount ?? 0) > 0, status))
  return readings
}

/** The checks of these readings with one of these outcomes, in attribution order. */
export function checksWith(readings: readonly CheckReading[], ...outcomes: CheckOutcome[]): AuditCheckId[] {
  return readings.filter((reading) => outcomes.includes(reading.outcome)).map((reading) => reading.check)
}

/** Whether a summary shows a DIFF that a check ended before any question was asked (an answer scored). */
export function endedBeforeQuestions(
  result: { readonly [Slot in CheckSlot]?: CheckSummaryOutcomes } & { parsedProbeCount?: number },
): boolean {
  return (result.parsedProbeCount ?? 0) === 0 && RECORD_CHECKS.some((check) => {
    const summary = result[check.slot]
    return summary !== undefined && check.endedAuditInSummary(summary)
  })
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

/** Each check with its record in these records (undefined when it holds none), in run order. */
function recordsOf(records: StoredCheckRecords): Array<{ check: RecordCheck<CheckSlot>; record: CheckRecords[CheckSlot] | undefined }> {
  return RECORD_CHECKS.map((check) => ({ check: check as unknown as RecordCheck<CheckSlot>, record: records[check.slot] }))
}

/**
 * Every stored check record of one seller's evidence recomputed from the bytes it stores, with the rules that cross
 * records. For any reader of stored evidence: submit's own, and a confirmer reading the first auditor's.
 */
export function validateStoredChecks(evidence: StoredCheckRecords & { target: { peerId: string } }): void {
  const context: StoredAuditContext = { auditedPeerId: evidence.target.peerId, records: evidence }
  for (const { check, record } of recordsOf(evidence)) {
    if (record !== undefined) check.validate(record, context)
  }
}

/**
 * The check records of the first set of a seller's evidence against its audit's summary, as submit reads them: each
 * record valid, its summary the summary's, and the stop rule kept. A flag that ends the audit (one not passed over in a
 * confirmation of another check, `continuedPast`) is a DIFF with no question asked, no later check ran after it, and
 * no extra set follows it. In run order, so the first broken rule is the one named.
 */
export function validateCheckRecordsAgainstSummary(
  evidence: StoredCheckRecords & {
    target: { peerId: string }
    exchanges: readonly unknown[]
    result: { verdict: string; parsedProbeCount: number }
  },
  result: { readonly [Slot in CheckSlot]?: unknown } & { extension?: unknown; extension2?: unknown },
  continuedPast: (check: AuditCheckId) => boolean,
): void {
  const context: StoredAuditContext = { auditedPeerId: evidence.target.peerId, records: evidence }
  const ended: Array<RecordCheck<CheckSlot>> = []
  for (const { check, record } of recordsOf(evidence)) {
    if (record !== undefined) {
      if (ended.length > 0) throw new Error(check.texts.ranAfterDiff)
      check.validate(record, context)
    }
    const stored = record === undefined ? null : check.summarize(record)
    if (canonicalJsonStringify(stored) !== canonicalJsonStringify(result[check.slot] ?? null)) throw new Error(check.texts.summaryMismatch)
    const finding = record === undefined ? null : check.endingFinding(record)
    if (finding === null || continuedPast(finding)) continue
    if (evidence.result.verdict !== 'DIFF' || evidence.exchanges.length > 0) throw new Error(check.texts.endsWithDiff)
    ended.push(check)
  }
  if (ended.length === 0 && evidence.result.verdict === 'DIFF' && evidence.result.parsedProbeCount === 0) {
    throw new Error('DIFF without a scoreable answer or a tokenizer pre-check mismatch, and no cap check flag')
  }
  for (const check of ended) {
    if (result.extension || result.extension2) throw new Error(check.texts.extraSetAfterDiff)
  }
}
