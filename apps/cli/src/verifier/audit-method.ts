import type { KbfReferenceV1, KbfThinkingSuppression } from '@antseed/fingerprints'
import type { AuditCheckId, CheckRecords, CheckSlot, StoredCheckRecords } from './audit-checks.js'
import type { AuditTaskLimiter } from './audit-concurrency.js'
import type { ReferenceRequestLimiter } from './model-reference.js'
import type { ProxyVerificationContext } from './model-run.js'
import type { ReferenceOracle } from './reference-oracle.js'
import type { SignedSellerRequestInput } from './signed-seller-request.js'
import type { TokenizerPrecheckClock } from './tokenizer-precheck.js'

/**
 * How a seller's audit runs one of its tests. `RecordCheck` (`audit-checks.ts`) says how to read what a test stored;
 * these types say what the audit asks of a test while it runs, and what a run gives a test to build its screen from,
 * so that the audit and the run loop over the list of tests instead of naming each one. The questions are not among
 * them: they are the audit itself.
 */

/** The seller's audit clock, the same for every test: it runs only while a request to the seller is out. */
export type SellerClock = TokenizerPrecheckClock

/** A test's own screen for one model in one run, as the run hands it to an audit: the context's field of the slot's name. */
export type OwnScreen<Slot extends CheckSlot> = NonNullable<ProxyVerificationContext[Slot]>

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
