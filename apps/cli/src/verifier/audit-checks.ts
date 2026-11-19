import { canonicalJsonStringify } from '@antseed/fingerprints'
import { auditedServiceNames } from './audited-models.js'
import { outputCapPaidRequests, summarizeOutputCap, validateOutputCap, type OutputCapV1 } from './output-cap.js'
import { outputEchoPaidRequests, summarizeOutputEcho, validateOutputEcho, type EchoSellerAskV1, type OutputEchoV1 } from './output-echo.js'
import type { PaidRequest, ProxyAuditEvidenceExchangeV1 } from './proxy-evidence.js'
import { matchesEnrolledService } from './response-auth-reader.js'
import {
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
  /** The finding a flag of this record would end the audit with, before the questions; null when it flags nothing that ends it. */
  endingFinding(record: CheckRecords[Slot]): AuditCheckId | null
  /** Every request the record stores, with its signer, grouped by kind (the readers take a set or a minimum, not an order). */
  requests(record: CheckRecords[Slot]): StoredRequest[]
  /** Every request the check paid for, in the order its cost is summed. */
  paid(record: CheckRecords[Slot]): PaidRequest[]
  /** The texts of a stored record that breaks the run's rules. */
  texts: {
    /** The check, as an error names it. */
    name: string
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
  endedAuditInSummary: (summary) => summary.outcome === 'mismatch',
  summarize: summarizeTokenizerPrecheck,
  // A pre-check must follow from the signed responses it stores.
  validate: (record, context) => validateTokenizerPrecheck(record, context.auditedPeerId),
  endingFinding: (record) => (record.outcome === 'mismatch' ? 'tokens' : null),
  requests: (record) => [
    ...record.rounds.flatMap((round) => round.seller.flatMap((ask) => [ask.base, ...(ask.probed ? [ask.probed] : [])]))
      .map((request) => stored('audited', request)),
    ...(record.crowd?.backers ?? []).flatMap((backer) => [backer.ask.base, ...(backer.ask.probed ? [backer.ask.probed] : [])]
      .map((request) => stored({ peerId: backer.peerId, service: backer.service }, request))),
  ],
  paid: tokenizerPrecheckPaidRequests,
  texts: {
    name: 'the tokenizer pre-check',
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
  requests: (record) => record.asks.map((ask) => stored('audited', ask.request)),
  paid: outputCapPaidRequests,
  texts: {
    name: 'the cap check',
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
      throw new Error(context.reader === 'confirmer'
        ? 'its echo check\'s pre-check match is not its pre-check'
        : 'the echo check\'s pre-check match is not this audit\'s pre-check')
    }
  },
  // The record's overall flag ends the audit, attributed to the finding that flagged.
  endingFinding: (record) => (record.outcome !== 'flag' ? null : record.flag === 'offset' ? 'output-offset' : 'output-echo'),
  requests: (record) => [
    ...record.rounds.flatMap((round): EchoSellerAskV1[] => [...round.short, ...round.long, ...(round.repeats ? [round.repeats.short, round.repeats.long] : [])])
      .map((ask) => stored('audited', ask.request)),
    // Every vote the record stores, also one another audit of the run sent: its answer is material of this check too.
    ...(record.crowd?.votes ?? []).flatMap((vote) => [vote.short, vote.long].map((ask) => stored({ peerId: vote.peerId }, ask.request))),
  ],
  paid: outputEchoPaidRequests,
  texts: {
    name: 'the echo check',
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
  result: { readonly [Slot in CheckSlot]?: CheckSummaryOutcomes } & { status: string; parsedProbeCount?: number },
): CheckReading[] {
  const readings: CheckReading[] = []
  for (const check of RECORD_CHECKS) {
    const summary = result[check.slot]
    for (const finding of check.findings as readonly CheckFinding<CheckSlot>[]) {
      readings.push({ check: finding.id, subject: finding.subject, outcome: summary == null ? 'not-run' : finding.ofSummary(summary) })
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
    return summary != null && check.endedAuditInSummary(summary)
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
 * The check records of the first set of a seller's evidence against its audit's summary, as submit reads them: each
 * record valid, its summary the summary's, and the stop rule kept. A flag that ends the audit (one not passed over in a
 * confirmation of another check, `continuedPast`) is a DIFF with no question asked, no later check ran after it, and
 * no extra set follows it. In run order, so the first broken rule is the one named.
 */
export function validateCheckRecordsAgainstSummary(
  evidence: StoredCheckRecords & StoredAuditTarget & {
    exchanges: readonly unknown[]
    result: { verdict: string; parsedProbeCount: number }
  },
  result: { readonly [Slot in CheckSlot]?: unknown } & { extension?: unknown; extension2?: unknown },
  continuedPast: (check: AuditCheckId) => boolean,
): void {
  const context: StoredAuditContext = { auditedPeerId: evidence.target.peerId, records: evidence, reader: 'submit' }
  const seller = sellerBindingOf(evidence)
  const ended: Array<RecordCheck<CheckSlot>> = []
  for (const { check, record } of recordsOf(evidence)) {
    if (record != null) {
      if (ended.length > 0) throw new Error(check.texts.ranAfterDiff)
      check.validate(record, context)
      assertBoundToSeller(check.requests(record), seller, check.texts.name)
    }
    const stored = record == null ? null : check.summarize(record)
    if (canonicalJsonStringify(stored) !== canonicalJsonStringify(result[check.slot] ?? null)) throw new Error(check.texts.summaryMismatch)
    const finding = record == null ? null : check.endingFinding(record)
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
