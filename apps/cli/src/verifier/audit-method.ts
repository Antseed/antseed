import type { KbfReferenceV1, KbfThinkingSuppression } from '@antseed/fingerprints'
import type { AuditCheckId, CheckRecords, CheckSlot, StoredCheckRecords } from './audit-checks.js'
import type { ProxyVerificationContext } from './model-run.js'
import type { TokenizerPrecheckClock } from './tokenizer-precheck.js'

/**
 * How a seller's audit runs one of its tests. `RecordCheck` (`audit-checks.ts`) says how to read what a test stored;
 * these types say what the audit asks of a test while it runs, so that the audit loops over the list of tests instead
 * of naming each one. The questions are not among them: they are the audit itself.
 */

/** The seller's audit clock, the same for every test: it runs only while a request to the seller is out. */
export type SellerClock = TokenizerPrecheckClock

/** A test's own screen for one model in one run, as the run hands it to an audit: the context's field of the slot's name. */
export type OwnScreen<Slot extends CheckSlot> = NonNullable<ProxyVerificationContext[Slot]>

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
  /** The seller's own thinking setting. Known after discovery, so a test before the questions is given null. */
  thinking: KbfThinkingSuppression | null
  /** The setting the model's other sellers are asked with: the reference's. */
  crowdThinking: KbfThinkingSuppression | null
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
