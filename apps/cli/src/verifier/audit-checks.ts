import { canonicalJsonStringify } from '@antseed/fingerprints'
import { auditedServiceNames } from './audited-models.js'
import { describeOutputCapFlag, outputCapPaidRequests, summarizeOutputCap, validateOutputCap, type OutputCapV1 } from './output-cap.js'
import { describeOutputEchoFlag, outputEchoPaidRequests, summarizeOutputEcho, validateOutputEcho, type EchoSellerAskV1, type OutputEchoV1 } from './output-echo.js'
import type { PaidRequest, ProxyAuditEvidenceExchangeV1 } from './proxy-evidence.js'
import { matchesEnrolledService } from './response-auth-reader.js'
import {
  describeTokenizerMismatch,
  summarizeTokenizerPrecheck,
  tokenizerPrecheckPaidRequests,
  validateTokenizerPrecheck,
  type TokenizerSellerRequestV1,
  type TokenizerPrecheckV1,
} from './tokenizer-precheck.js'

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
}

/** What validating one stored record may read besides the record. */
export interface StoredAuditContext {
  /** The seller the evidence is about (`target.peerId`). */
  auditedPeerId: string
  /** The other records of the same evidence file: the echo check reads the pre-check's outcome. */
  records: StoredCheckRecords
  /** Who reads the record: submit its own audit, or a confirmer the first auditor's (the texts say whose). */
  reader: 'submit' | 'confirmer'
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
  /** The texts of a stored record that breaks the run's rules. */
  texts: {
    /** The check, as an error names it. */
    name: string
    summaryMismatch: string
  }
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
}

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
  // The record's overall flag ends the audit, attributed to the finding that flagged.
  requests: (record) => [
    ...record.rounds.flatMap((round): EchoSellerAskV1[] => [...round.short, ...round.long, ...(round.repeats ? [round.repeats.short, round.repeats.long] : [])])
      .map((ask) => stored('audited', ask.request)),
    // Every vote the record stores, also one another audit of the run sent: its answer is material of this check too.
    ...(record.crowd?.votes ?? []).flatMap((vote) => [vote.short, vote.long].map((ask) => stored({ peerId: vote.peerId }, ask.request))),
  ],
  paid: outputEchoPaidRequests,
  describeFlag: describeOutputEchoFlag,
  texts: {
    name: 'the echo check',
    summaryMismatch: 'the summary\'s echo check is not the one in its evidence',
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
      readings.push({ check: finding.id, subject: finding.subject, outcome: record == null ? 'not-run' : finding.ofRecord(record) })
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
      readings.push({ check: finding.id, subject: finding.subject, outcome: summary == null ? 'not-run' : finding.ofSummary(summary) })
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
function recordsOf(records: StoredCheckRecords): Array<{ check: RecordCheck<CheckSlot>; record: CheckRecords[CheckSlot] | undefined }> {
  return RECORD_CHECKS.map((check) => ({ check: check as unknown as RecordCheck<CheckSlot>, record: records[check.slot] }))
}

/**
 * Every stored check record of one seller's evidence recomputed from the bytes it stores, with the rules that cross
 * records. For any reader of stored evidence: submit's own, and a confirmer reading the first auditor's.
 */
export function validateStoredChecks(
  evidence: StoredCheckRecords & StoredAuditTarget,
  reader: StoredAuditContext['reader'] = 'submit',
): void {
  const context: StoredAuditContext = { auditedPeerId: evidence.target.peerId, records: evidence, reader }
  const seller = sellerBindingOf(evidence)
  for (const { check, record } of recordsOf(evidence)) {
    if (record == null) continue
    check.validate(record, context)
    assertBoundToSeller(check.requests(record), seller, check.texts.name)
  }
}

/** What a seller's evidence says about whom it audited. */
export interface StoredAuditTarget {
  target: { peerId: string; service: string }
  reference: { referenceModel: string }
}

/** The seller a stored audit is about, with its model's service names. */
export function sellerBindingOf(evidence: StoredAuditTarget): SellerBinding {
  return {
    peerId: evidence.target.peerId,
    service: evidence.target.service,
    serviceAliases: typeof evidence.reference?.referenceModel === 'string' ? auditedServiceNames(evidence.reference.referenceModel) : [],
  }
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
    const service = request.signer === 'audited' ? seller.service : request.signer.service ?? seller.service
    if (typeof record.advertisedService !== 'string' || !matchesEnrolledService(service, record.advertisedService, seller.serviceAliases)) {
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
): void {
  const context: StoredAuditContext = { auditedPeerId: evidence.target.peerId, records: evidence, reader: 'submit' }
  const seller = sellerBindingOf(evidence)
  for (const { check, record } of recordsOf(evidence)) {
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
    for (const request of storedRequestsOf(evidence)) {
      const at = request.responseAuth?.record?.receivedAt
      if (typeof at === 'number') times.push(at)
    }
  }
  const known = times.filter((time) => Number.isFinite(time) && time > 0)
  return known.length === 0 ? null : Math.floor(Math.min(...known) / 1_000)
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
  const flaggedBy = checksWith(readings, 'flag')
  const passedBy = checksWith(readings, 'pass')
  if (confirming && confirming.length > 0 && !confirming.some((check) => flaggedBy.includes(check))) {
    // The questions still waiting for an extra set are not undecided yet: the confirmation waits with them.
    const open = confirming.filter((check) => !passedBy.includes(check)
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
 * carried only with that record: when the earlier test is asked again, so is it. A resume of an interrupted attempt
 * carries every finished record.
 */
export function decidedRecords(records: StoredCheckRecords): StoredCheckRecords {
  const kept: { [Slot in CheckSlot]?: CheckRecords[Slot] } = {}
  for (const { check, record } of recordsOf(records)) {
    if (record == null) continue
    const decided = (check.findings as readonly CheckFinding<CheckSlot>[]).some((finding) => {
      const outcome = finding.ofRecord(record)
      return outcome === 'flag' || outcome === 'pass'
    })
    if (decided) (kept as Record<string, unknown>)[check.slot] = record
  }
  for (const { check, record } of recordsOf(kept)) {
    if (record == null) continue
    const without = (check.readsEarlier ?? []).some((slot) => records[slot] != null && kept[slot] == null)
    if (without) delete (kept as Record<string, unknown>)[check.slot]
  }
  return kept
}
