import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { getAddress } from 'ethers'
import {
  KBF_AUDIT_VERIFY_OPTIONS,
  classifyKbfFirstLook,
  computeKbfVerdict,
  kbfAuditBaseline,
  canonicalHashBytes32,
  kbfExtensionRuleById,
  canonicalJsonStringify,
  sha256Hex,
  validateKbfReferenceV1,
  type FingerprintStats,
  type KbfExtensionRule,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import {
  MAX_RESULTS_PER_MODEL_AUDIT,
  modelHash,
  serviceHash,
  sortServiceResults,
  verifierVerdict,
  type ServiceResultInput,
} from '@antseed/node/payments'
import type { VerifierCLIConfig } from '../config/types.js'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from './audit-artifacts.js'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'
import { failureBlame } from './failure-blame.js'
import { EXTRA_QUESTIONS_PUBLISHED, isExtraQuestionsPublished, sanitizeOutcomeSummary, type VerificationOutcomeReasonV1 } from './outcome-reason.js'
import type { ReferenceUpstreamProvenanceV1 } from './model-reference.js'
import { windowIncludesSeller, type AuditWindowV1 } from './audit-window.js'
import {
  EPOCH_QUESTION_SET_METHOD,
  findEpochProbeReference,
  findEpochQuestionSetByReferenceId,
  isRetiredEpochQuestionSetReference,
  loadBankReferenceExchanges,
  type EpochQuestionSetV1,
  type EpochSetCalibrationV1,
} from './probe-bank.js'
import { auditDecision, closeCallRule, coverageRuleOf, pooledCloseCallVerdict, stageOneVerdict, type CloseCallRuleId } from './close-call.js'
import { verifyProxyAuditEvidenceFile, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import type { SameCheckCandidate, SameCheckConfirmationV1, SameCheckDecision } from './same-check.js'
import { safeServiceSlug } from './slug.js'
import type { TestTimingConfig } from './test-timing.js'
import type { AlreadyOnChain, SubmissionCandidate } from './submission-delta.js'
import { confirmationReportKey } from './epoch-plan.js'
import {
  ALL_TESTS_FORMAT, AUDIT_CHECK_IDS, NO_RECORD_REASON_LENGTH, auditVerdictReason, checksWith, earliestAuditorTime, inactiveChecks, readingsOfEvidence,
  readingsOfSummary, validateCheckRecordsAgainstSummary, validateNoRecord, verdictOf,
  type AuditCheckId, type InactiveTest, type ReportOfAudit,
} from './audit-checks.js'
import { METHODS } from './methods/index.js'
import { asError, normalized } from './utils.js'

/** Options every audit passes to verifyKbf (see verifyModelTarget). */
export const KBF_VERIFY_OPTIONS = KBF_AUDIT_VERIFY_OPTIONS

export type ModelAuditVerdict = 'SAME' | 'DIFF' | 'UNDETERMINED'

export interface ModelAuditSellerResultV1 {
  agentId: string
  peerId: string
  displayName: string | null
  service: string
  serviceHash: string
  verdict: ModelAuditVerdict
  verdictReason: string | null
  outcomeReason: VerificationOutcomeReasonV1 | null
  referenceId: string
  stats: FingerprintStats
  matchVectorHash: string
  audit: {
    auditId: string
    /** Proxy audit evidence file, relative to the model evidence document. */
    evidencePath: string
    evidenceHash: string
  }
  /**
   * Extra set of never-seen probes asked because the first check (`audit`) was a close call
   * (`extension.rule`). Without `extension2`, the stage-1 verdict is `pooled.verdict`, computed from
   * both sets' stats.
   */
  extension?: ModelAuditExtensionV1
  /**
   * Second extra set (`kbf-extension-v2`), asked because the first check pooled with `extension` was
   * still a close call (`extension.pooled.extendNext`). The stage-1 verdict is then
   * `extension2.pooled.verdict`, computed from all three sets' stats.
   */
  extension2?: ModelAuditExtensionV1
  /** The questions' own verdict, after any close call; `verdict` is the audit's over every test (`verdictOf`). */
  questionsVerdict?: ModelAuditVerdict
  /** The close-call rule the questions were decided by; absent under the single-look rule. */
  decisionRule?: CloseCallRuleId
  /** A flagged audit whose close call could not be finished in its run: its questions are undecided. */
  questionsClosed?: true
  /**
   * The tests that kept no record for this seller because the run that audited it had none of that test for the model:
   * the test did not apply to the model, or its reference gave it nothing to judge on. By evidence slot, with the
   * reason the auditor's run wrote: the seller's evidence's own `noRecord`, which a reader checks the result against.
   * The auditor's own statement, as its reference is: no seller signed it. Such a test is not active (`inactive`), so it
   * can only leave the SAME to the questions, never make one. A seller's own skip or failure is not here. Absent when
   * there is none.
   */
  noRecord?: Array<{ slot: string; reason: string }>
  /**
   * The tests that were not active for the model in the run behind this result, with why (`inactiveChecks` of the
   * seller's evidence, which any reader recomputes from it): `rule`, the rules do not count it for the model; `run`, the
   * run had none of it for the model (its reference switched it off, with the reference's reason). Every other test
   * was active, and the verdict is SAME only when every active test passed. Always set on a result made by this rule;
   * absent on one from before it, whose SAME only the questions decided.
   */
  inactive?: InactiveTest[]
  /** The checks that flagged the seller in this audit (`flaggingChecks`). */
  flaggedBy?: AuditCheckId[]
  /** The checks that ran to a pass in this audit (`passedChecks`). */
  passedBy?: AuditCheckId[]
  /** The checks scored between their bars where such a score clears like a pass (`betweenChecks`). */
  betweenBy?: AuditCheckId[]
  /**
   * Unix seconds of the earliest request the audit behind this result rests on, on the auditor's own clock, over its first
   * set and extra sets (`earliestAuditorTime`); 0 when none has a time. A confirmation is fresh only from this time on.
   */
  auditedAt?: number
  /**
   * Set on a result that answers another auditor's waiting DIFF: which checks flagged there and here
   * (`same-check.ts`). A DIFF is sent only with a check in common; a SAME only when a check that flagged
   * there passed here.
   */
  confirmation?: SameCheckConfirmationV1
  /**
   * The report this audit confirms, as its evidence names it (`ProxyAuditEvidenceV1.confirming`): read again right
   * before sending, so a confirmation of FLIPS keeps its stage and an untagged first look stays one.
   */
  confirming?: { checks: AuditCheckId[]; reportedAt?: number }
}

export interface ModelAuditExtensionV1 {
  rule: CloseCallRuleId
  firstLook: { verdict: ModelAuditVerdict; pValue: number | null }
  referenceId: string
  stats: FingerprintStats
  matchVectorHash: string
  /** `extendNext`: this look was still a close call and `extension2` decides it. */
  pooled: Omit<FingerprintStats, 'selfCoverage'> & { verdict: ModelAuditVerdict; verdictReason: string | null; extendNext?: boolean }
  audit: {
    auditId: string
    evidencePath: string
    evidenceHash: string
  }
}

export interface ExcludedSellerAuditV1 {
  peerId: string
  agentId: string | null
  service: string
  auditId: string | null
  reason: string
}

/** One row's decision in a submit preparation (`PreparedModelAudits.decisions`). */
export interface PreparedRowDecisionV1 {
  model: string
  peerId: string
  agentId: string | null
  service: string
  /** Null when the row names no service (a malformed row is recorded, never a reason to stop). */
  serviceHash: string | null
  auditId: string | null
  /** The report the row answers (`confirmationReportKey`), null for a first look. */
  reportKey: string | null
  evidenceHash: string | null
  verdict: string | null
  decision: 'send' | 'held' | 'superseded' | 'excluded' | 'already-on-chain'
  /** Why it is not sent, as a fixed code; null for a send. */
  reasonCode: string | null
}

/** The reason codes a preparation gives a row it does not send, and which of them hold it for a later submit. */
export const PREPARED_HOLD_CODES: readonly string[] = Object.freeze(['window-open', 'confirmation-reaudit', 'close-call-waiting', 'confirmation-hold', 'confirmation-waiting'])

/** Public evidence for one `submitModelAudit` call: every seller audited as one model in one run. */
export interface ModelAuditEvidenceV1 {
  version: 1
  kind: 'antseed-verifier-model-audit-evidence'
  runId: string
  epoch: string
  auditor: string
  model: string
  /** On-chain model identity: keccak256 of the lowercased reference model. */
  modelHash: string
  /** 1-based part number when the model's results exceed one submission. */
  part: number
  partCount: number
  references: Array<{
    referenceId: string
    queryProfileHash: string
    probeCount: number
    /** Full KBF reference, relative to the evidence document; null when it could not be exported. */
    path: string | null
  }>
  /**
   * How the questions were chosen: `epoch-shared-set-v1` when every reference is one of this auditor's
   * question sets for the model and epoch (every seller got the same audit set, every close call the
   * same extra sets). Absent on evidence from per-seller draws, and when one model audit holds results
   * from two sets (one a submit retired, `retireEpochQuestionSet`, and the one built after it).
   */
  questionSelection?: {
    method: typeof EPOCH_QUESTION_SET_METHOD
    referenceId: string
    extensionReferenceIds: string[]
    /** The set's calibration, whose trials each reference carries; absent on earlier evidence. */
    calibration?: EpochSetCalibrationV1
  }
  /**
   * Raw upstream request/response bytes behind the probe bank these references were drawn
   * from, one file per reference build. Absent on evidence written before they were recorded.
   */
  referenceEvidence?: ModelAuditReferenceEvidenceV1[]
  kbfOptions: typeof KBF_VERIFY_OPTIONS
  /**
   * Close-call rule; written when every close-call result in this evidence was decided by the same
   * rule (each extra set also names its rule in `extension.rule`).
   */
  extensionRule?: KbfExtensionRule
  /** Every close-call rule a result in this evidence was decided by. */
  extensionRules?: KbfExtensionRule[]
  results: ModelAuditSellerResultV1[]
  excluded: ExcludedSellerAuditV1[]
  /**
   * A dry run's shortened waits (`verifier.testTiming`) from its run manifest, so a reader tells its timing from the
   * rules'. Absent on every run that waits as the rules say, and so on every audit recorded on Base.
   */
  testTiming?: TestTimingConfig
}

export interface ModelAuditReferenceEvidenceV1 {
  /** Reference build that produced the exchanges. */
  referenceId: string
  /** Relative to the evidence document. */
  path: string
  /** sha256 of the file's exact bytes. */
  sha256: string
  upstream: ReferenceUpstreamProvenanceV1
  exchangeCount: number
}

export interface AuditPublicationV1 {
  /** `local-test`: a dry run's publication on this machine (`verifier.testPublication`), never on Base. */
  provider: 'pinata' | 'local-test'
  evidenceHash: string
  cid: string
  uri: string
  pinSize: number
  totalBytes: number
  fileCount: number
  publishedAt: string
}

export interface PreparedModelAudit {
  /** Stable key for the ledger: model, plus the part number when split. */
  key: string
  model: string
  modelHash: string
  expectedEpoch: bigint
  evidence: ModelAuditEvidenceV1
  evidenceHash: string
  evidencePath: string
  results: ServiceResultInput[]
  references: Array<{ path: string; reference: KbfReferenceV1 }>
  auditEvidencePaths: string[]
  /**
   * When each result's audit was made (its latest evidence file, seconds), by `resultTimeKey`: the last read before a
   * send judges each row by it, as the preparation did.
   */
  auditedAt?: Record<string, number>
  /** Raw reference exchange files: where they are read from and where they go next to the evidence. */
  referenceEvidence: Array<{ sourcePath: string; path: string }>
}

export type ModelAuditSubmissionStatus = 'pending' | 'submitted' | 'failed'

export interface ModelAuditLedgerEntryV1 {
  key: string
  model: string
  modelHash: string
  evidenceHash: string
  evidencePath: string
  resultCount: number
  evidenceUri: string
  publication?: AuditPublicationV1
  /** Each result's audit time (`resultTimeKey`), as prepared: the audit behind this entry's report. */
  auditedAt?: Record<string, number>
  status: ModelAuditSubmissionStatus
  transactionHash: string | null
  blockNumber: number | null
  error: string | null
  lastAttemptAt: string
}

/** Per run, chain, and contract record of model audits; makes `verifier submit` safe to re-run. */
export interface ModelAuditLedgerV1 {
  version: 1
  kind: 'antseed-verifier-model-audit-ledger'
  runId: string
  epoch: string
  auditor: string
  chainId: string
  contract: string
  createdAt: string
  updatedAt: string
  models: Record<string, ModelAuditLedgerEntryV1>
}

export function modelAuditsDirectory(evidenceDir: string, runId: string): string {
  return join(evidenceDir, 'submissions', safeServiceSlug(runId))
}

export function modelAuditEvidencePath(evidenceDir: string, runId: string, key: string): string {
  return join(modelAuditsDirectory(evidenceDir, runId), `${safeServiceSlug(key)}.evidence.json`)
}

export function modelAuditLedgerPath(
  evidenceDir: string,
  runId: string,
  chainId: bigint | string,
  contract: string,
): string {
  return join(modelAuditsDirectory(evidenceDir, runId), `ledger-${String(chainId)}-${contract.toLowerCase()}.json`)
}

/** Whether `referenceId` is in a question set a submit retired, from the retired files alone. Unreadable counts as not. */
async function questionSetRetired(
  input: { banksDir: string; manifest: { epoch: string } },
  model: string,
  referenceId: string,
): Promise<boolean> {
  return isRetiredEpochQuestionSetReference({ banksDir: input.banksDir, model, epoch: input.manifest.epoch, referenceId })
    .catch(() => false)
}

/**
 * Builds one submission per audited model from a completed run. Every seller result counts,
 * including UNDETERMINED. Results the contract would reject (unknown agent, the auditor's own
 * agent, duplicate services, evidence that no longer matches its hash) are listed as excluded so
 * one bad seller cannot revert the whole model.
 */
export async function prepareModelAudits(input: {
  evidenceDir: string
  banksDir: string
  manifest: VerifierRunManifestV1
  auditor: string
  resolveAgentOwner(agentId: bigint): Promise<string>
  config?: VerifierCLIConfig
  maxResultsPerSubmission?: number
  /**
   * Flags the results of a model the auditor already has on-chain (see `resultsAlreadyOnChain`), one
   * per candidate. They are left out before the evidence is built, so the evidence lists exactly the
   * results sent; a model with nothing left is not prepared at all.
   */
  alreadyOnChain?: (modelHash: string, candidates: readonly SubmissionCandidate[]) => Promise<AlreadyOnChain[]>
  /**
   * Never a third opinion (`third-opinion.ts`): one reason or null per candidate; a result with a
   * reason is left out of the submission and listed among the excluded sellers with that reason.
   */
  thirdOpinion?: (modelHash: string, candidates: readonly SubmissionCandidate[]) => Promise<Array<string | null>>
  /**
   * The DIFF hold (`diff-hold.ts`): one reason or null per candidate; a result for a service whose
   * recent DIFF must stand is left out and listed among the excluded sellers with that reason.
   */
  diffHold?: (modelHash: string, candidates: readonly SubmissionCandidate[]) => Promise<Array<string | null>>
  /**
   * The model's audit window this epoch (`audit-window.ts`), or null when it has none (confirmations).
   * An open window's results are not submitted yet; in a closed one, a close call still waiting for
   * its extra questions is submitted as UNDETERMINED, and a seller outside the window (one that came
   * online after it opened) gets no result, unless the result confirms another auditor's DIFF.
   */
  auditWindow?: (model: string) => Promise<Pick<AuditWindowV1, 'state' | 'sellers'> | null>
  /**
   * Why the model's results wait for its confirmations that wait to be audited again (`confirmationHoldReason`), or null:
   * every row of the model is held, as for an open audit window, so their evidence does not publish the questions
   * those confirmations are asked again.
   */
  confirmationHold?: (model: string) => string | null
  /**
   * For a DIFF that answers another auditor's waiting DIFF: whether the same check flagged in both
   * audits (`sameCheckFilter`). Runs after `thirdOpinion`. Without it no result is checked.
   */
  sameCheck?: (modelHash: string, candidates: readonly SameCheckCandidate[]) => Promise<Array<SameCheckDecision | null>>
  /** Set when the evidence is not published: every DIFF is left out with this reason, since no confirmer could read it. */
  unpublishedDiffs?: string
}): Promise<{
  audits: PreparedModelAudit[]
  excluded: Array<ExcludedSellerAuditV1 & { model: string }>
  /**
   * What the preparation decided for every row it read, with the row's identity (never published): sent, held for a
   * later submit, held as older than the auditor's own report, left out, or already on chain. `submit --dry-run`
   * writes it (`writeDryRunPrepared`).
   */
  decisions: PreparedRowDecisionV1[]
  /** Per model, results left out because the auditor already has them on-chain (models with none are omitted). */
  alreadyOnChain: Array<{ model: string; count: number }>
  /**
   * Results left out only for now, to be submitted later this epoch: an open audit window, or a close
   * call still waiting for its extra questions. If the epoch ends first they are never sent.
   */
  heldBack: string[]
}> {
  const auditor = getAddress(input.auditor)
  const maxResults = input.maxResultsPerSubmission ?? MAX_RESULTS_PER_MODEL_AUDIT
  if (!/^\d+$/.test(input.manifest.epoch)) {
    throw new Error(`run ${input.manifest.runId} has non-numeric epoch ${input.manifest.epoch}; only on-chain epochs can be submitted`)
  }
  const expectedEpoch = BigInt(input.manifest.epoch)
  const sizing = resolveReferenceSizingPolicy(input.config)
  const ownerCache = new Map<string, Promise<string>>()
  const ownerOf = (agentId: bigint): Promise<string> => {
    const key = agentId.toString()
    let owner = ownerCache.get(key)
    if (!owner) {
      owner = input.resolveAgentOwner(agentId)
      ownerCache.set(key, owner)
    }
    return owner
  }

  const audits: PreparedModelAudit[] = []
  const allExcluded: Array<ExcludedSellerAuditV1 & { model: string }> = []
  const heldBack: string[] = []
  const decisions: PreparedRowDecisionV1[] = []
  const decide = (
    model: string,
    row: { peerId: string; agentId: string | null; service: string; auditId?: string | null; evidenceHash?: string | null; status?: string; confirming?: readonly string[]; confirmingReportedAt?: number; confirmsDiff?: boolean },
    decision: PreparedRowDecisionV1['decision'],
    reasonCode: string | null,
  ): void => {
    // A record for the dry run only: whatever a malformed row holds, recording it never stops the preparation.
    const safely = <T>(read: () => T, fallback: T): T => { try { return read() } catch { return fallback } }
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
    decisions.push({
      model, peerId: text(row.peerId) ?? '', agentId: text(row.agentId), service: text(row.service) ?? '',
      serviceHash: safely(() => (typeof row.service === 'string' ? serviceHash(row.service) : null), null),
      auditId: text(row.auditId), reportKey: safely(() => confirmationReportKey(row), null), evidenceHash: text(row.evidenceHash),
      verdict: text(row.status),
      decision: decision === 'excluded' && reasonCode !== null && PREPARED_HOLD_CODES.includes(reasonCode) ? 'held' : decision,
      reasonCode,
    })
  }
  const alreadyOnChain: Array<{ model: string; count: number }> = []
  for (const model of input.manifest.modelOrder) {
    const modelManifest = input.manifest.models.find((entry) => normalized(entry.model) === normalized(model))
    if (!modelManifest) throw new Error(`run manifest is missing the model summary for ${model}`)
    const summary = await readModelSummary(modelManifest.summaryPath, input.manifest.runId, model)
    const window = await input.auditWindow?.(model) ?? null
    const excluded: ExcludedSellerAuditV1[] = []
    // A confirmation held to be audited again (`heldForConfirmationRecheck`) is a hold for its report, not a failure.
    for (const entry of summary.failures) decide(model, entry, entry.confirmationHeld ? 'held' : 'excluded', entry.confirmationHeld ? 'confirmation-reaudit' : 'failed')
    for (const entry of summary.skipped) decide(model, entry, 'excluded', 'skipped')
    for (const entry of [...summary.failures, ...summary.skipped]) {
      excluded.push({
        peerId: entry.peerId,
        agentId: entry.agentId,
        service: entry.service,
        auditId: 'auditId' in entry ? entry.auditId : null,
        reason: entry.reason,
      })
    }

    const accepted: Array<{
      agentId: bigint
      result: ModelAuditSummaryV1['results'][number]
      evidence: ProxyAuditEvidenceV1
      extensionEvidence: ProxyAuditEvidenceV1 | null
      extension2Evidence: ProxyAuditEvidenceV1 | null
      confirmation?: SameCheckConfirmationV1
      /** Another report's own result, as the submission offers it beside the seller's latest. */
      alternate?: true
      /** The confirmation decision on this row (`sameCheck`), applied once one row per seller is chosen. */
      decision?: SameCheckDecision
    }> = []
    let referenceModel: string | null = null
    for (let result of summary.results) {
      const exclude = (reason: string, code: string): void => {
        excluded.push({ peerId: result.peerId, agentId: result.agentId, service: result.service, auditId: result.auditId, reason })
        decide(model, result, 'excluded', code)
      }
      const agentId = parseAgentId(result.agentId)
      if (agentId === null) {
        exclude('missing or invalid seller agent ID', 'invalid-agent-id')
        continue
      }
      if (retiredRecheckResult(result)) {
        exclude('made by the retired DIFF self-recheck (CLI 0.2.70 and older), whose combined verdict the evidence '
          + 'no longer carries; a later run this epoch audits the seller again', 'retired-self-recheck')
        continue
      }
      let evidence: ProxyAuditEvidenceV1
      let extensionEvidence: ProxyAuditEvidenceV1 | null = null
      let extension2Evidence: ProxyAuditEvidenceV1 | null = null
      try {
        evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
        if (result.extension) {
          extensionEvidence = await verifyProxyAuditEvidenceFile(result.extension.evidencePath, result.extension.evidenceHash)
        }
        if (result.extension2) {
          extension2Evidence = await verifyProxyAuditEvidenceFile(result.extension2.evidencePath, result.extension2.evidenceHash)
        }
      } catch (error) {
        exclude(`invalid audit evidence: ${asError(error).message}`, 'invalid-evidence')
        continue
      }
      // A completed audit by a CLI from before an upgrade within the epoch: refused for its format alone, so the reason
      // says what becomes of it. A confirmation is no part of any window: it is audited again like any unusable result
      // of its report. A first look in a closed window is never audited again, since its questions may be public by now;
      // in an open one it is, while an attempt is left (`recoveringFirstLooks`).
      if (beforeAllTests([evidence, extensionEvidence, extension2Evidence])) {
        exclude(result.confirmsDiff
          ? 'a confirmation written by a CLI from before the all-tests format (an upgrade during the epoch): it is not sent; '
            + 'while the report still waits for this auditor and its attempts are not used up, the seller is audited again '
            + 'for it, and only that result is sent'
          : window?.state === 'closed'
            ? 'written by a CLI from before the all-tests format (an upgrade during the epoch), and its audit window closed '
              + 'before the seller could be audited again: its questions may be public, so nothing is sent for this seller '
              + 'this epoch, and it is audited next epoch'
            : 'written by a CLI from before the all-tests format (an upgrade during the epoch): it is not sent; while its audit '
              + 'window is open and an attempt is left, a run audits the seller again, and only that result is sent', 'before-all-tests')
        continue
      }
      try {
        validateAuditMatchesSummary(evidence, result, extensionEvidence, extension2Evidence, { epoch: input.manifest.epoch, auditor })
      } catch (error) {
        exclude(`invalid audit evidence: ${asError(error).message}`, 'invalid-evidence')
        continue
      }
      // A date that is not valid is damaged evidence: its time orders nothing, and a confirmer could not read it.
      if (latestEvidenceTime([evidence, extensionEvidence, extension2Evidence]) === null) {
        exclude('invalid audit evidence: an evidence file\'s date is not valid', 'invalid-evidence-date')
        continue
      }
      if (window?.state === 'open') {
        // A confirmation waits too: its evidence would publish the epoch's questions for this model while
        // the window's other sellers are still being asked them.
        exclude(result.confirmsDiff
          ? 'a confirmation on a model whose audit window is still open: it is submitted when the window closes, so the window\'s questions stay unpublished while its sellers are asked'
          : 'its audit window is still open: the model\'s results are submitted together once every seller of the window is finished', 'window-open')
        heldBack.push(`${model} ${result.agentId ?? result.peerId}: its audit window is still open`)
        continue
      }
      // Every row of a held model waits, a first look's open close call too: in a closed window it would be sent as
      // UNDETERMINED below, publishing its questions. A confirmation's own open close call keeps its handling below.
      const waiting = finalAuditVerdict(result) === null && result.confirmsDiff ? null : input.confirmationHold?.(model) ?? null
      if (waiting) {
        exclude(`held: ${waiting}`, 'confirmation-waiting')
        heldBack.push(`${model} ${result.agentId ?? result.peerId}: held for the model's confirmations waiting to be audited again`)
        continue
      }
      if (window && !result.confirmsDiff && !windowIncludesSeller(window, result.peerId)) {
        exclude('not in this epoch\'s audit window (it came online after the window opened); audited next epoch', 'outside-window')
        continue
      }
      // A closed window asks no more extra questions: its open close calls are audited but undecided. A
      // confirmation is not part of the window and still gets its extra questions, so it waits for them.
      // A close call that can no longer be finished reads its questions as undecided; the audit's verdict then still
      // counts every other test, so a flag is never sent as UNDETERMINED.
      const unfinished = (): ModelAuditVerdict => verdictOf(
        readingsOfSummary({ ...result, questionsStatus: 'UNDETERMINED' }), 'UNDETERMINED', result.confirming,
      ).verdict
      // The close is published (`questionsClosed`), so a confirmer reads its questions as undecided, not as waiting.
      const close = (reason: string): void => { result = { ...result, closeCallClosed: result.closeCallClosed ?? { reason } } }
      let finalVerdict = finalAuditVerdict(result)
      if (finalVerdict === null && window?.state === 'closed' && !result.confirmsDiff) {
        finalVerdict = unfinished()
        close('its audit window closed before its extra questions were asked')
      }
      // So is a close call whose first audit was made on a set a submit has published since: its extra
      // questions are public and are never asked (`decideRetryGiveUps`). A confirmation's is an undecided
      // attempt instead: the seller is audited again on new questions, and only the merged epoch's last
      // attempt (marked with the reason, `applyRetryGiveUps`) is submitted.
      if (finalVerdict === null && await questionSetRetired(input, model, evidence.reference.referenceId)) {
        if (result.confirmsDiff && !isExtraQuestionsPublished(result.outcomeReason)) {
          exclude('a confirmation whose extra questions were published before they could be asked: the seller is audited '
            + 'again on new questions, up to its attempt limit, before anything is submitted', 'confirmation-reaudit')
          heldBack.push(`${model} ${result.agentId ?? result.peerId}: confirmation audited again on new questions`)
          continue
        }
        finalVerdict = unfinished()
        result = { ...result, outcomeReason: result.outcomeReason ?? EXTRA_QUESTIONS_PUBLISHED }
        close('its extra questions were published before they could be asked')
      }
      if (finalVerdict === null) {
        if (result.extensionPending) heldBack.push(`${model} ${result.agentId ?? result.peerId}: close call waiting for its extra questions`)
        exclude(result.extensionPending
          ? `close call waiting for its extra questions (${result.extensionPending.reason}); a later run this epoch asks them, so it is not submitted yet`
          : 'close call without its extra questions, so it is not submitted', result.extensionPending ? 'close-call-waiting' : 'close-call-unfinished')
        continue
      }
      // A confirmation always sends its result, an undecided one its last attempt's UNDETERMINED (the epoch plan asks it
      // again within its attempts and holds the model's submit meanwhile, `confirmationsHoldingSubmit`). Only one this
      // auditor's own failure left undecided is not sent: it says nothing about the seller.
      if (result.outcomeReason?.code === 'confirmation_undecided' && failureBlame(result.undecidedCause ?? null) === 'auditor') {
        exclude(`a confirmation left undecided by this auditor's own failure (${result.undecidedCause?.summary ?? 'audit failed'}), so it is not submitted`, 'auditor-caused-undetermined')
        continue
      }
      if (finalVerdict === 'UNDETERMINED' && failureBlame(result.outcomeReason) === 'auditor') {
        // The auditor's own failure says nothing about the seller's model, also when a run is
        // submitted directly (`--run-id`) rather than through the merged epoch.
        exclude(`UNDETERMINED caused by this auditor (${result.outcomeReason?.summary ?? 'audit failed'}), so it is not submitted`, 'auditor-caused-undetermined')
        continue
      }
      // The questions' own verdict travels apart from the audit's: the attribution reads it (a cap DIFF beside the
      // questions' SAME never reads as a questions DIFF). A close call that cannot be finished is undecided.
      result = { ...result, status: finalVerdict, questionsStatus: stageOneVerdict(result) ?? 'UNDETERMINED' }
      if (referenceModel === null) referenceModel = evidence.reference.referenceModel
      else if (normalized(referenceModel) !== normalized(evidence.reference.referenceModel)) {
        exclude(`audited against ${evidence.reference.referenceModel}, not ${referenceModel}`, 'wrong-reference-model')
        continue
      }
      // Another report's own result, marked so where the epoch submission offers it (never by its position): it goes
      // through the checks, and one row per seller is chosen with the confirmation decision.
      const alternate = result.offeredAsAlternate === true
      let owner: string
      try {
        owner = await ownerOf(agentId)
      } catch (error) {
        exclude(`unknown seller agent ${agentId}: ${asError(error).message}`, 'unknown-agent')
        continue
      }
      if (normalized(owner) === normalized(auditor)) {
        exclude(`self-audit: the auditor owns seller agent ${agentId}`, 'self-audit')
        continue
      }
      accepted.push({ agentId, result, evidence, extensionEvidence, extension2Evidence, ...(alternate ? { alternate: true as const } : {}) })
    }

    allExcluded.push(...excluded.map((entry) => ({ ...entry, model })))
    if (accepted.length === 0 || referenceModel === null) continue
    const candidatesOf = (): SubmissionCandidate[] => accepted.map((entry) => ({
      agentId: entry.agentId,
      serviceHash: serviceHash(entry.result.service),
      verdict: verifierVerdict(entry.result.status),
      auditedAt: auditedAt(entry),
      confirmsDiff: entry.result.confirmsDiff === true,
    }))
    const drop = (index: number, reason: string, code: string): void => {
      const { result } = accepted[index]!
      allExcluded.push({ model, peerId: result.peerId, agentId: result.agentId, service: result.service, auditId: result.auditId, reason })
      decide(model, result, code === 'superseded' ? 'superseded' : 'excluded', code)
      accepted.splice(index, 1)
    }
    // The confirmation decision of every row first: the choice of one row per seller depends on it.
    if (input.sameCheck) {
      const decisions = await input.sameCheck(modelHash(referenceModel), candidatesOf().map((candidate, index) => {
        const entry = accepted[index]!
        // The tests' readings of this evidence once: the three lists come from them.
        const readings = readingsOfEvidence(entry.evidence, questionsVerdictOf(entry.result))
        return {
          ...candidate,
          peerId: entry.evidence.target.peerId,
          flaggedBy: checksWith(readings, 'flag'),
          passedBy: checksWith(readings, 'pass'),
          betweenBy: readings.filter((reading) => reading.between === true).map((reading) => reading.check),
          // Freshness is the earliest request used, on the auditor's clock, over the first set and its extra sets (0: none).
          auditedAt: earliestAuditorTime([entry.evidence, entry.extensionEvidence, entry.extension2Evidence]) ?? 0,
          ...(entry.evidence.confirming ? { confirming: entry.evidence.confirming } : {}),
        }
      }))
      for (const [index, entry] of accepted.entries()) {
        const decision = decisions[index]
        if (decision) entry.decision = decision
      }
    }
    // One row per seller and service, chosen before anything else removes rows, so no row is promoted because another
    // was removed (as already on chain, say). The submission marks which row is the seller's latest and which is
    // another report's own (`alternate`): an alternate stands only when the decision sends it for the report waiting
    // now, and a sent row whose evidence names the report wins over an untagged first look. Otherwise the latest row
    // stands; when it was refused (its evidence unreadable), the seller gets nothing.
    {
      const sends = (entry: (typeof accepted)[number]) => entry.decision?.kind === 'send'
      const rank = (entry: (typeof accepted)[number]): number => (
        sends(entry) && entry.evidence.confirming ? 3 : sends(entry) ? 2 : entry.alternate ? 0 : 1
      )
      const kept = new Map<string, number>()
      for (const [index, entry] of accepted.entries()) {
        if (rank(entry) === 0) continue
        const key = `${entry.agentId}:${serviceHash(entry.result.service)}`
        const earlier = kept.get(key)
        if (earlier === undefined || rank(entry) > rank(accepted[earlier]!)) kept.set(key, index)
      }
      for (let index = accepted.length - 1; index >= 0; index -= 1) {
        const entry = accepted[index]!
        if (kept.get(`${entry.agentId}:${serviceHash(entry.result.service)}`) === index) continue
        const winner = accepted[kept.get(`${entry.agentId}:${serviceHash(entry.result.service)}`) ?? -1]
        drop(index, entry.alternate
          ? 'another report\'s result of this seller, not sent for the report waiting now'
          : winner && sends(winner) ? 'the result made for the report waiting now is sent in its place' : `duplicate audited service ${entry.result.service}`,
        entry.alternate ? 'other-report-row' : winner && sends(winner) ? 'report-row-sent-instead' : 'duplicate-service')
      }
    }
    // After the choice, so the SAME kept per seller is the same one whether or not it is already on-chain (another of
    // its services is never sent in its place).
    {
      const before = accepted.length
      const sameExcluded: typeof excluded = []
      const keptRows = new Map(accepted.map((entry) => [entry.result.auditId, entry.result]))
      keepOneSamePerSeller(accepted, sameExcluded)
      for (const entry of sameExcluded) decide(model, keptRows.get(entry.auditId ?? '') ?? entry, 'excluded', 'one-same-per-seller')
      // As before: these are listed in the published evidence too.
      excluded.push(...sameExcluded)
      allExcluded.push(...sameExcluded.map((entry) => ({ ...entry, model })))
      if (accepted.length !== before && accepted.length === 0) continue
    }
    if (accepted.length === 0) continue
    if (input.alreadyOnChain) {
      const onChain = await input.alreadyOnChain(modelHash(referenceModel), candidatesOf())
      const count = onChain.filter((entry) => entry === true).length
      if (count > 0) alreadyOnChain.push({ model, count })
      for (let index = accepted.length - 1; index >= 0; index -= 1) {
        if (onChain[index] === true) {
          decide(model, accepted[index]!.result, 'already-on-chain', 'already-on-chain')
          accepted.splice(index, 1)
        }
        // Not on chain, and not sent: this auditor's own newer report with another verdict stands.
        else if (onChain[index] === 'superseded') {
          // Outstanding too, on every path (nothing else to send included): the seller needs a newer audit.
          const { result } = accepted[index]!
          heldBack.push(`${model} ${result.agentId ?? result.peerId}: held: older than your own report with another verdict; a newer audit of this seller is needed to change it`)
          drop(index, 'held: older than your own report with another verdict, which stands; a newer audit of this seller can change it', 'superseded')
        }
      }
      if (accepted.length === 0) continue
    }
    for (const [excludes, code] of [[input.diffHold, 'diff-hold'], [input.thirdOpinion, 'third-opinion']] as const) {
      if (!excludes) continue
      const reasons = await excludes(modelHash(referenceModel), candidatesOf())
      for (let index = accepted.length - 1; index >= 0; index -= 1) {
        const reason = reasons[index]
        if (reason) drop(index, reason, code)
      }
      if (accepted.length === 0) break
    }
    // A DIFF the auditor does not publish can never be confirmed: a confirmer reads which check flagged from
    // the published evidence (`same-check.ts`).
    if (input.unpublishedDiffs) {
      for (let index = accepted.length - 1; index >= 0; index -= 1) {
        if (accepted[index]!.result.status === 'DIFF') drop(index, input.unpublishedDiffs, 'unpublished-diff')
      }
    }
    // The decisions, applied to the rows left: a send carries its confirmation; nothing else is sent, and only a hold is
    // tried again by the next submit.
    for (let index = accepted.length - 1; index >= 0; index -= 1) {
      const entry = accepted[index]!
      const decision = entry.decision
      if (!decision) continue
      if (decision.kind === 'send') {
        entry.confirmation = decision.confirmation
        continue
      }
      if (decision.kind === 'hold') heldBack.push(`${model} ${entry.result.agentId ?? entry.result.peerId}: ${decision.reason}`)
      drop(index, decision.reason, decision.kind === 'hold' ? 'confirmation-hold' : decision.code)
    }
    for (const entry of accepted) decide(model, entry.result, 'send', null)
    if (accepted.length === 0) continue
    accepted.sort((left, right) => compareResults(
      left.agentId, serviceHash(left.result.service), right.agentId, serviceHash(right.result.service),
    ))
    const partCount = Math.ceil(accepted.length / maxResults)
    // Read once per model, not once per part: neither depends on the part.
    const bankExchanges = await loadBankReferenceExchanges(input.banksDir, model, input.manifest.epoch)
    const questionSets = new Map<string, Promise<EpochQuestionSetV1 | null>>()
    const questionSetOf = (referenceId: string): Promise<EpochQuestionSetV1 | null> => {
      let found = questionSets.get(referenceId)
      if (!found) {
        found = findEpochQuestionSetByReferenceId({
          banksDir: input.banksDir, model, epoch: input.manifest.epoch, referenceId, config: input.config,
        }).catch(() => null)
        questionSets.set(referenceId, found)
      }
      return found
    }
    for (let part = 1; part <= partCount; part += 1) {
      const slice = accepted.slice((part - 1) * maxResults, part * maxResults)
      const key = partCount === 1 ? model : `${model}#${part}`
      const evidencePath = modelAuditEvidencePath(input.evidenceDir, input.manifest.runId, key)
      const evidenceDirectory = dirname(evidencePath)
      const references: PreparedModelAudit['references'] = []
      const referenceEntries: ModelAuditEvidenceV1['references'] = []
      const auditEvidence = slice.flatMap(({ evidence, extensionEvidence, extension2Evidence }) => (
        [evidence, extensionEvidence, extension2Evidence].filter((entry): entry is ProxyAuditEvidenceV1 => entry !== null)
      ))
      // A close-call extension set is only judged pooled with its first set, so it is not power-sized.
      const extensionReferenceIds = new Set(slice.flatMap(({ extensionEvidence, extension2Evidence }) => (
        [extensionEvidence, extension2Evidence].flatMap((entry) => entry ? [entry.reference.referenceId] : [])
      )))
      for (const evidence of auditEvidence) {
        const referenceId = evidence.reference.referenceId
        if (referenceEntries.some((entry) => entry.referenceId === referenceId)) continue
        const referencePath = join(evidenceDirectory, 'references', `${referenceFileName(referenceId)}.json`)
        let exportedPath: string | null = null
        const located = await findEpochProbeReference(input.banksDir, referenceId)
        if (located) {
          // The power on a set's calibration is checked before a seller is asked it; audits made on a set
          // calibrated before that check are still published as they were judged.
          const reference = validateKbfReferenceV1(located, {
            minimumStatisticalPower: extensionReferenceIds.has(referenceId) ? Number.EPSILON : sizing.minimumStatisticalPower,
            minimumCalibrationPower: Number.EPSILON,
          })
          references.push({ path: referencePath, reference })
          exportedPath = portableRelative(evidenceDirectory, referencePath)
        }
        referenceEntries.push({
          referenceId,
          queryProfileHash: evidence.reference.queryProfileHash,
          probeCount: evidence.reference.probes.length,
          path: exportedPath,
        })
      }
      referenceEntries.sort((left, right) => left.referenceId.localeCompare(right.referenceId))
      // The set the references are from, also once a submit has retired it, so evidence prepared again is the same.
      const questionSet = referenceEntries.length === 0 ? null : await questionSetOf(referenceEntries[0]!.referenceId)
      const setReferenceIds = new Set(questionSet ? [questionSet.reference, ...questionSet.extensions].map((entry) => entry.referenceId) : [])
      const questionSelection: ModelAuditEvidenceV1['questionSelection'] | null = questionSet
        && referenceEntries.every((entry) => setReferenceIds.has(entry.referenceId))
        ? {
          method: EPOCH_QUESTION_SET_METHOD,
          referenceId: questionSet.reference.referenceId,
          extensionReferenceIds: questionSet.extensions.map((entry) => entry.referenceId),
          ...(questionSet.calibration ? { calibration: questionSet.calibration } : {}),
        }
        : null
      const referenceEvidence: PreparedModelAudit['referenceEvidence'] = []
      const referenceEvidenceEntries: ModelAuditReferenceEvidenceV1[] = []
      for (const stored of bankExchanges) {
        const path = join(evidenceDirectory, 'reference-evidence', basename(stored.path))
        referenceEvidence.push({ sourcePath: stored.absolutePath, path })
        referenceEvidenceEntries.push({
          referenceId: stored.referenceId,
          path: portableRelative(evidenceDirectory, path),
          sha256: stored.sha256,
          upstream: stored.upstream,
          exchangeCount: stored.exchangeCount,
        })
      }
      const withoutRecord = await Promise.all(slice.map(({ result, evidence }) => testsWithoutRecord(result.evidencePath, evidence)))
      const results: ModelAuditSellerResultV1[] = slice.map(({ agentId, result, evidence, extensionEvidence, extension2Evidence, confirmation }, index) => {
        // The tests' readings of this evidence once: the audit's verdict, and each list of the row, come from them.
        const questions = questionsVerdictOf(result)
        const readings = readingsOfEvidence(evidence, questions)
        const audit = verdictOf(readings, questions, evidence.confirming?.checks)
        const betweenBy = readings.filter((reading) => reading.between === true).map((reading) => reading.check)
        return {
        agentId: agentId.toString(),
        peerId: result.peerId,
        displayName: result.displayName,
        service: result.service,
        serviceHash: serviceHash(result.service),
        verdict: result.status,
        // The audit's reason: what each test that flagged found, or the questions' own reason.
        verdictReason: auditVerdictReason(evidence, audit, evidence.result.verdictReason),
        outcomeReason: evidence.result.outcomeReason ?? result.outcomeReason ?? null,
        referenceId: evidence.reference.referenceId,
        stats: evidence.result.stats,
        matchVectorHash: evidence.result.matchVectorHash,
        audit: {
          auditId: result.auditId,
          evidencePath: portableRelative(evidenceDirectory, result.evidencePath),
          evidenceHash: result.evidenceHash,
        },
        ...(result.extension && extensionEvidence
          ? { extension: submittedExtension(result.extension, extensionEvidence, evidence, evidenceDirectory) }
          : {}),
        ...(result.extension2 && extension2Evidence
          ? { extension2: submittedExtension(result.extension2, extension2Evidence, evidence, evidenceDirectory) }
          : {}),
        ...(withoutRecord[index]!.length > 0 ? { noRecord: withoutRecord[index]! } : {}),
        // Which tests were active, from the seller's evidence (`inactiveChecks`): the verdict above follows from them.
        inactive: inactiveChecks(evidence),
        flaggedBy: audit.flaggedBy,
        passedBy: audit.passedBy,
        ...(betweenBy.length > 0 ? { betweenBy } : {}),
        questionsVerdict: questions,
        ...(result.decisionRule ? { decisionRule: result.decisionRule } : {}),
        ...(result.closeCallClosed ? { questionsClosed: true as const } : {}),
        auditedAt: earliestAuditorTime([evidence, extensionEvidence, extension2Evidence]) ?? 0,
        ...(confirmation ? { confirmation } : {}),
        ...(evidence.confirming ? { confirming: { checks: [...evidence.confirming.checks], ...(evidence.confirming.reportedAt !== undefined ? { reportedAt: evidence.confirming.reportedAt } : {}) } } : {}),
        }
      })
      const evidence: ModelAuditEvidenceV1 = {
        version: 1,
        kind: 'antseed-verifier-model-audit-evidence',
        runId: input.manifest.runId,
        epoch: input.manifest.epoch,
        auditor,
        model,
        modelHash: modelHash(referenceModel),
        part,
        partCount,
        references: referenceEntries,
        ...(questionSelection ? { questionSelection } : {}),
        ...(referenceEvidenceEntries.length > 0 ? { referenceEvidence: referenceEvidenceEntries } : {}),
        kbfOptions: KBF_VERIFY_OPTIONS,
        ...closeCallRulesEvidence(slice.map(({ result }) => result)),
        results,
        excluded: part === 1 ? excluded : [],
        ...(input.manifest.testTiming ? { testTiming: { ...input.manifest.testTiming } } : {}),
      }
      audits.push({
        key,
        model,
        modelHash: evidence.modelHash,
        expectedEpoch,
        evidence,
        evidenceHash: canonicalHashBytes32(evidence),
        evidencePath,
        results: sortServiceResults(results.map((entry) => ({
          agentId: BigInt(entry.agentId),
          serviceHash: entry.serviceHash,
          verdict: verifierVerdict(entry.verdict),
        }))),
        references,
        referenceEvidence,
        auditEvidencePaths: slice.flatMap(({ result }) => [
          result.evidencePath,
          ...(result.extension ? [result.extension.evidencePath] : []),
          ...(result.extension2 ? [result.extension2.evidencePath] : []),
        ]),
        auditedAt: Object.fromEntries(slice.map((entry) => [resultTimeKey(entry.agentId, serviceHash(entry.result.service)), auditedAt(entry)])),
      })
    }
  }
  return { audits, excluded: allExcluded, decisions, alreadyOnChain, heldBack }
}

/** Unix seconds of the latest evidence file behind a result: its last extra set when it has one. */
/** The key of a result's audit time on a prepared audit (`PreparedModelAudit.auditedAt`). */
export function resultTimeKey(agentId: bigint | string, serviceHash: string): string {
  return `${agentId.toString()}:${serviceHash.toLowerCase()}`
}

function auditedAt(entry: {
  evidence: ProxyAuditEvidenceV1
  extensionEvidence: ProxyAuditEvidenceV1 | null
  extension2Evidence: ProxyAuditEvidenceV1 | null
}): number {
  // Rows with a date that is not valid are left out before this (`invalid-evidence-date`).
  return latestEvidenceTime([entry.evidence, entry.extensionEvidence, entry.extension2Evidence]) ?? 0
}

/**
 * The one rule for when a row's audit finished (seconds), for submit and the planner alike: the latest `createdAt` of
 * its evidence files. A file whose date is missing or not valid makes the row's time unknown (null): submit leaves the
 * row out as damaged evidence and the planner audits its report again; an unknown time is never ordered as 0.
 */
function latestEvidenceTime(evidences: ReadonlyArray<Pick<ProxyAuditEvidenceV1, 'createdAt'> | null>): number | null {
  const times: number[] = []
  for (const evidence of evidences) {
    if (!evidence) continue
    const time = typeof evidence.createdAt === 'string' ? Date.parse(evidence.createdAt) : Number.NaN
    // A date that is not valid is damaged evidence: the row has no finish time at all.
    if (!Number.isFinite(time)) return null
    times.push(time)
  }
  return times.length === 0 ? null : Math.max(...times) / 1_000
}

/**
 * When the audit behind a summary row finished (seconds), by submit's rule (`latestEvidenceTime`), each file read and
 * verified against its hash as the submit preparation reads it. Null when any file of the row (an extra set included)
 * is missing, unreadable, not the one its summary names, or written before the all-tests format (`ALL_TESTS_FORMAT`,
 * by a CLI from before an upgrade within the epoch): submit would refuse the row, so the planner audits it again and
 * its audit window waits for it (`recoveringFirstLooks`). A file whose date is not valid gives no time, as in submit.
 */
export async function auditFinishedAt(result: AuditFiles): Promise<number | null> {
  const evidences = await verifiedAuditFiles(result)
  if (!evidences || beforeAllTests(evidences)) return null
  return latestEvidenceTime(evidences)
}

/**
 * Whether a summary row's files all verify against their hashes and carry a valid date, but one of them was written
 * before the all-tests format (`ALL_TESTS_FORMAT`), by a CLI from before an upgrade within the epoch: a completed
 * audit that submit refuses only for its format, which `recoveringFirstLooks` audits again once more than the seller's
 * attempts allow.
 */
export async function auditBeforeAllTests(result: AuditFiles): Promise<boolean> {
  const evidences = await verifiedAuditFiles(result)
  return evidences !== null && beforeAllTests(evidences) && latestEvidenceTime(evidences) !== null
}

interface AuditFiles {
  evidencePath: string
  evidenceHash: string
  extension?: { evidencePath: string; evidenceHash: string } | null
  extension2?: { evidencePath: string; evidenceHash: string } | null
}

/** A row's files (an extra set included), each read and verified against its hash; null when any is not. */
async function verifiedAuditFiles(result: AuditFiles): Promise<ProxyAuditEvidenceV1[] | null> {
  const evidences: ProxyAuditEvidenceV1[] = []
  for (const set of [result, result.extension, result.extension2]) {
    if (set == null) continue
    try {
      evidences.push(await verifyProxyAuditEvidenceFile(set.evidencePath, set.evidenceHash))
    } catch {
      return null
    }
  }
  return evidences
}

function beforeAllTests(evidences: ReadonlyArray<ProxyAuditEvidenceV1 | null>): boolean {
  return evidences.some((evidence) => evidence !== null && evidence.tests !== ALL_TESTS_FORMAT)
}

/**
 * When each result this auditor sent finished, by transaction: every run's submit ledger in `evidenceDir` for this
 * chain and contract (`auditedAt`, by `resultTimeKey`). An unreadable ledger is passed over.
 */
export async function sentAuditTimes(
  evidenceDir: string, chainId: bigint | string, contract: string,
): Promise<Map<string, Record<string, number>>> {
  const byTransaction = new Map<string, Record<string, number>>()
  const root = join(evidenceDir, 'submissions')
  let runs: string[]
  try {
    runs = await readdir(root)
  } catch {
    return byTransaction
  }
  for (const run of runs) {
    try {
      const ledger = JSON.parse(await readFile(join(root, run, `ledger-${String(chainId)}-${contract.toLowerCase()}.json`), 'utf8')) as {
        models?: Record<string, Partial<ModelAuditLedgerEntryV1>>
      }
      for (const entry of Object.values(ledger.models ?? {})) {
        if (typeof entry.transactionHash !== 'string' || !entry.auditedAt || typeof entry.auditedAt !== 'object') continue
        // Only real times: an unknown one (0, or not a number) is no time. Every ledger that knows the transaction adds
        // its valid times, so one ledger's unknown never masks another's.
        const key = entry.transactionHash.toLowerCase()
        const times = byTransaction.get(key) ?? {}
        for (const [row, time] of Object.entries(entry.auditedAt)) {
          if (typeof time === 'number' && Number.isFinite(time) && time > 0 && !(row in times)) times[row] = time
        }
        byTransaction.set(key, times)
      }
    } catch {
      // No ledger for this chain and contract in this run.
    }
  }
  return byTransaction
}

/**
 * The seller bonus is meant to count once per verified model, but the contract counts SAME services.
 * So each seller gets at most one SAME per model on-chain: the one with the lowest service hash,
 * which every auditor picks the same way. Extra SAMEs stay in the evidence as excluded; DIFF and
 * UNDETERMINED results are always submitted.
 */
function keepOneSamePerSeller(
  accepted: Array<{ agentId: bigint; result: ModelAuditSummaryV1['results'][number] }>,
  excluded: ExcludedSellerAuditV1[],
): void {
  const kept = new Map<string, { service: string; hash: string }>()
  for (const { agentId, result } of accepted) {
    if (result.status !== 'SAME') continue
    const hash = serviceHash(result.service)
    const current = kept.get(agentId.toString())
    if (!current || hash < current.hash) kept.set(agentId.toString(), { service: result.service, hash })
  }
  for (let index = accepted.length - 1; index >= 0; index -= 1) {
    const { agentId, result } = accepted[index]!
    if (result.status !== 'SAME') continue
    const keep = kept.get(agentId.toString())!
    if (serviceHash(result.service) === keep.hash) continue
    accepted.splice(index, 1)
    excluded.push({
      peerId: result.peerId,
      agentId: result.agentId,
      service: result.service,
      auditId: result.auditId,
      reason: `seller already verified for this model via ${keep.service}; the bonus counts once per model`,
    })
  }
}

export async function writeModelAuditEvidence(prepared: PreparedModelAudit): Promise<void> {
  for (const { path, reference } of prepared.references) await writeJsonAtomic(path, reference, true)
  for (const { sourcePath, path } of prepared.referenceEvidence) {
    if (resolve(sourcePath) === resolve(path)) continue
    await mkdir(dirname(path), { recursive: true })
    await copyFile(sourcePath, path)
    const expected = prepared.evidence.referenceEvidence
      ?.find((entry) => resolve(dirname(prepared.evidencePath), entry.path) === resolve(path))?.sha256
    if (expected && `sha256:${sha256Hex(await readFile(path))}` !== expected) {
      throw new Error(`reference evidence ${sourcePath} does not match its recorded sha256`)
    }
  }
  await writeJsonAtomic(prepared.evidencePath, prepared.evidence, true)
}

/** Re-reads evidence written by an earlier attempt, so a retry submits the identical evidence hash. */
export async function readModelAuditEvidence(path: string, evidenceHash: string): Promise<ModelAuditEvidenceV1> {
  const raw = await readFile(path, 'utf8')
  const evidence = JSON.parse(raw) as ModelAuditEvidenceV1
  if (evidence.version !== 1 || evidence.kind !== 'antseed-verifier-model-audit-evidence') {
    throw new Error(`unsupported model audit evidence: ${path}`)
  }
  if (raw !== canonicalJsonStringify(evidence)) throw new Error(`model audit evidence is not canonical JSON: ${path}`)
  if (normalized(canonicalHashBytes32(evidence)) !== normalized(evidenceHash)) {
    throw new Error(`model audit evidence hash mismatch: ${path}`)
  }
  return evidence
}

/** Rebuilds the contract call from previously written evidence. */
export function preparedFromEvidence(
  key: string,
  evidencePath: string,
  evidence: ModelAuditEvidenceV1,
  auditEvidencePaths: string[] = [],
): PreparedModelAudit {
  return {
    key,
    model: evidence.model,
    modelHash: evidence.modelHash,
    expectedEpoch: BigInt(evidence.epoch),
    evidence,
    evidenceHash: canonicalHashBytes32(evidence),
    evidencePath,
    results: sortServiceResults(evidence.results.map((entry) => ({
      agentId: BigInt(entry.agentId),
      serviceHash: entry.serviceHash,
      verdict: verifierVerdict(entry.verdict),
    }))),
    references: [],
    auditEvidencePaths,
    referenceEvidence: (evidence.referenceEvidence ?? []).map((entry) => {
      const path = resolve(dirname(evidencePath), entry.path)
      return { sourcePath: path, path }
    }),
  }
}

function submittedExtension(
  extension: NonNullable<ModelAuditSummaryV1['results'][number]['extension']>,
  extensionEvidence: ProxyAuditEvidenceV1,
  firstEvidence: ProxyAuditEvidenceV1,
  evidenceDirectory: string,
): ModelAuditExtensionV1 {
  return {
    rule: extension.rule,
    firstLook: { verdict: firstEvidence.result.verdict, pValue: firstEvidence.result.stats.pValueBinomial },
    referenceId: extensionEvidence.reference.referenceId,
    stats: extensionEvidence.result.stats,
    matchVectorHash: extensionEvidence.result.matchVectorHash,
    pooled: {
      selfHamming: extension.pooled.selfHamming,
      selfTotal: extension.pooled.selfTotal,
      targetHamming: extension.pooled.targetHamming,
      targetTotal: extension.pooled.targetTotal,
      targetCoverage: extension.pooled.targetCoverage,
      p0Cp99: extension.pooled.p0Cp99,
      pValueBinomial: extension.pooled.pValueBinomial,
      verdict: extension.pooled.verdict,
      verdictReason: extension.pooled.verdictReason,
      ...(extension.pooled.extendNext ? { extendNext: true } : {}),
    },
    audit: {
      auditId: extension.auditId,
      evidencePath: portableRelative(evidenceDirectory, extension.evidencePath),
      evidenceHash: extension.evidenceHash,
    },
  }
}

/** `extensionRule` (one rule) and `extensionRules` (all) for the close-call rules these results use. */
function closeCallRulesEvidence(
  results: ReadonlyArray<ModelAuditSummaryV1['results'][number]>,
): { extensionRule?: KbfExtensionRule; extensionRules?: KbfExtensionRule[] } {
  const rules = new Map<string, KbfExtensionRule>()
  for (const result of results) {
    const rule = closeCallRule(result)
    if (rule) rules.set(rule.id, rule)
  }
  if (rules.size === 0) return {}
  const list = [...rules.values()].sort((left, right) => left.id.localeCompare(right.id))
  return { ...(list.length === 1 ? { extensionRule: list[0] } : {}), extensionRules: list }
}

/** Distinct reference upstreams named by a model audit's evidence and references. */
export function modelAuditUpstreams(audit: PreparedModelAudit): ReferenceUpstreamProvenanceV1[] {
  const upstreams = new Map<string, ReferenceUpstreamProvenanceV1>()
  const add = (upstream: unknown): void => {
    if (!upstream || typeof upstream !== 'object') return
    const value = upstream as ReferenceUpstreamProvenanceV1
    upstreams.set(canonicalJsonStringify(value), value)
  }
  for (const entry of audit.evidence.referenceEvidence ?? []) add(entry.upstream)
  for (const { reference } of audit.references) add(reference.provenance?.upstream)
  return [...upstreams.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value)
}

export function canonicalEvidenceBytes(evidence: ModelAuditEvidenceV1): Buffer {
  return Buffer.from(canonicalJsonStringify(evidence), 'utf8')
}

export function newModelAuditLedger(input: {
  runId: string
  epoch: string
  auditor: string
  chainId: bigint | string
  contract: string
}): ModelAuditLedgerV1 {
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: 'antseed-verifier-model-audit-ledger',
    runId: input.runId,
    epoch: input.epoch,
    auditor: getAddress(input.auditor),
    chainId: String(input.chainId),
    contract: getAddress(input.contract),
    createdAt: now,
    updatedAt: now,
    models: {},
  }
}

export async function readModelAuditLedger(
  path: string,
  expected: { runId: string; epoch: string; auditor: string; chainId: bigint | string; contract: string },
): Promise<ModelAuditLedgerV1> {
  const parsed = await readJsonIfExists<ModelAuditLedgerV1>(path)
  if (!parsed) return newModelAuditLedger(expected)
  if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-model-audit-ledger') {
    throw new Error(`unsupported model audit ledger: ${path}`)
  }
  if (parsed.runId !== expected.runId
    || parsed.epoch !== expected.epoch
    || normalized(parsed.auditor) !== normalized(expected.auditor)
    || parsed.chainId !== String(expected.chainId)
    || normalized(parsed.contract) !== normalized(expected.contract)) {
    throw new Error(`model audit ledger ${path} belongs to another run, epoch, auditor, chain, or contract`)
  }
  return parsed
}

export async function writeModelAuditLedger(path: string, ledger: ModelAuditLedgerV1): Promise<void> {
  ledger.updatedAt = new Date().toISOString()
  await writeJsonAtomic(path, ledger)
}

function parseAgentId(value: string | null): bigint | null {
  if (!value) return null
  try {
    const agentId = BigInt(value)
    return agentId > 0n ? agentId : null
  } catch {
    return null
  }
}

function compareResults(leftAgent: bigint, leftService: string, rightAgent: bigint, rightService: string): number {
  if (leftAgent !== rightAgent) return leftAgent < rightAgent ? -1 : 1
  const a = BigInt(leftService)
  const b = BigInt(rightService)
  return a < b ? -1 : a > b ? 1 : 0
}

function referenceFileName(referenceId: string): string {
  const match = /^(?:sha256:|0x)([0-9a-fA-F]{64})$/.exec(referenceId)
  if (!match) throw new Error(`referenceId is not a sha256 content hash: ${referenceId}`)
  return match[1]!.toLowerCase()
}

function portableRelative(from: string, to: string): string {
  return relative(resolve(from), resolve(to)).split(sep).join('/')
}

export function validateAuditMatchesSummary(
  evidence: ProxyAuditEvidenceV1,
  result: ModelAuditSummaryV1['results'][number],
  extensionEvidence: ProxyAuditEvidenceV1 | null = null,
  extension2Evidence: ProxyAuditEvidenceV1 | null = null,
  report: ReportOfAudit = {},
): void {
  for (const checked of [evidence, extensionEvidence, extension2Evidence]) {
    if (!checked) continue
    if (normalized(checked.target.peerId) !== normalized(result.peerId)) throw new Error('seller peer ID mismatch')
    if (normalized(checked.target.service) !== normalized(result.service)) throw new Error('service mismatch')
    if ((checked.target.agentId ?? null) !== (result.agentId ?? null)) throw new Error('seller agent ID mismatch')
  }
  // The close-call decision reads the summary's stats; they must be the first check's evidence stats.
  if (result.stats && canonicalHashBytes32(result.stats) !== canonicalHashBytes32(evidence.result.stats)) {
    throw new Error('first check statistics do not match its evidence')
  }
  // Every seller file names its format: every test ran, and `result` is the questions' own (`ALL_TESTS_FORMAT`).
  for (const checked of [evidence, extensionEvidence, extension2Evidence]) {
    if (checked && checked.tests !== ALL_TESTS_FORMAT) throw new Error('the evidence does not name the all-tests format')
  }
  // A confirmation names the tests it repeats; every test ran in it, as in a first look.
  if (evidence.confirming && (!Array.isArray(evidence.confirming.checks) || evidence.confirming.checks.length === 0
    || evidence.confirming.checks.some((check) => !AUDIT_CHECK_IDS.includes(check)))) {
    throw new Error('a confirmation names no known check it confirms')
  }
  if (evidence.confirming?.reportedAt !== undefined && !Number.isSafeInteger(evidence.confirming.reportedAt)) {
    throw new Error('a confirmation names its report at no valid time')
  }
  // Each test's record follows from the signed responses it stores, is bound to the seller, and is the summary's.
  validateCheckRecordsAgainstSummary(evidence, result, report)
  if (result.extension2 && !result.extension) throw new Error('second extra set without a first one')
  const extraSets: Array<{ record: NonNullable<typeof result.extension>; evidence: ProxyAuditEvidenceV1 }> = []
  if (result.extension) {
    if (!extensionEvidence) throw new Error('extension evidence missing')
    extraSets.push({ record: result.extension, evidence: extensionEvidence })
  }
  if (result.extension2) {
    if (!extension2Evidence) throw new Error('second extension evidence missing')
    extraSets.push({ record: result.extension2, evidence: extension2Evidence })
  }
  for (const [index, { record, evidence: setEvidence }] of extraSets.entries()) {
    if (record.status !== setEvidence.result.verdict) throw new Error(`${index === 0 ? 'extension' : 'second extension'} verdict mismatch`)
  }
  // The questions' verdict, recomputed from the evidence by the adjudicator a confirmer uses too.
  const questions = adjudicateQuestions({
    evidence,
    extraSets,
    decisionRule: result.decisionRule,
    closed: result.closeCallClosed !== undefined,
  })
  const stageOne = questions.verdict
  if ((result.questionsStatus ?? result.status) !== stageOne && !questions.pending) throw new Error('questions verdict mismatch')
  // Which tests were active: the evidence's own `noRecord` entries are tests it has no record of, and the summary's
  // list is the one its evidence gives, so the verdict below is judged on the same active tests as the run's.
  validateNoRecord(evidence)
  if (!Array.isArray(result.inactive)) throw new Error('the summary does not say which tests were active (it was written before the active tests were recorded)')
  if (canonicalHashBytes32(result.inactive) !== canonicalHashBytes32(inactiveChecks(evidence))) {
    throw new Error('the summary\'s active tests are not the ones its evidence gives')
  }
  // The audit's verdict, recomputed from the questions and every test record (`verdictOf`, rule `all-tests-v1`).
  const looked = questions.pending ? 'UNDETERMINED' as const : stageOne
  const audit = verdictOf(
    readingsOfEvidence(evidence, looked === 'UNDETERMINED' ? null : looked),
    looked,
    evidence.confirming?.checks,
    { questionsPending: questions.pending },
  )
  if (result.closeCallClosed && !audit.flaggedBy.some((check) => check !== 'kbf')) throw new Error('a close call closed without a flag of another test')
  const pending = questions.pending && audit.undecidedConfirmation === null
  // The summary and its evidence decide alike: whether its answers are verified, and whether it waits for an extra set.
  // A summary that says ResponseAuth failed beside verified evidence would be final to the sender and pending here.
  const firstVerified = evidence.exchanges.every((exchange) => exchange.status !== 'succeeded' || exchange.responseAuth.status === 'verified')
  if (result.responseAuthVerified !== undefined && result.responseAuthVerified !== firstVerified) throw new Error('the summary\'s ResponseAuth state is not its evidence\'s')
  if (auditDecision(result).pending !== pending) throw new Error('the summary and its evidence disagree on whether the close call waits for an extra set')
  if (!pending && audit.verdict !== result.status) throw new Error('verdict mismatch')
  if ((audit.undecidedConfirmation !== null) !== (result.outcomeReason?.code === 'confirmation_undecided')) {
    throw new Error('the undecided confirmation is not the one its tests give')
  }
}

/**
 * For one seller's evidence: each test of the list without a record there that the run had none of for the model. The
 * evidence's own entries (`ProxyAuditEvidenceV1.noRecord`, written by the audit) when it has them; for evidence from
 * before they were written, the reasons its tests' screens wrote beside the run's audits (`RecordCheck.whyNoRecord`),
 * read from the folder that holds the sellers' folders (`modelAuditSellersDirectory`). Best effort: a file that is
 * missing or cannot be read gives nothing, and never stops a submit.
 */
export async function testsWithoutRecord(
  evidencePath: string,
  evidence: ProxyAuditEvidenceV1,
): Promise<Array<{ slot: string; reason: string }>> {
  if (Array.isArray(evidence.noRecord)) return evidence.noRecord.map((entry) => ({ slot: entry.slot, reason: entry.reason }))
  const sellers = dirname(dirname(evidencePath))
  if (basename(sellers) !== 'sellers') return []
  const read = async (file: string): Promise<unknown> => {
    try {
      return await readJsonIfExists<unknown>(join(dirname(sellers), basename(file)))
    } catch {
      return null
    }
  }
  const found: Array<{ slot: string; reason: string }> = []
  for (const check of METHODS) {
    if (!check.whyNoRecord || evidence[check.slot] != null) continue
    let reason: string | null = null
    try {
      reason = await check.whyNoRecord(read, { confirming: evidence.confirming?.checks ?? [] })
    } catch {
      reason = null
    }
    if (typeof reason === 'string' && reason.length > 0) {
      found.push({ slot: check.slot, reason: sanitizeOutcomeSummary(reason).slice(0, NO_RECORD_REASON_LENGTH) })
    }
  }
  return found
}

/** What an extra set of a close call records about its pooled look, in a summary and in a published result alike. */
interface ExtraSetRecord {
  rule: string
  pooled: Omit<FingerprintStats, 'selfCoverage'> & { verdict: ModelAuditVerdict; extendNext?: boolean }
}

/**
 * The first look of a seller's evidence recomputed from what it stores: each question's match from the batch that
 * asked it, the reference's own error baseline over those questions (`kbfAuditBaseline`), the run's coverage rules
 * (`KBF_AUDIT_VERIFY_OPTIONS`), and UNDETERMINED when a successful batch lacks verified ResponseAuth, as the run
 * decides it. Stats are null when the reference cannot give a baseline.
 */
function recomputedFirstLook(evidence: ProxyAuditEvidenceV1): { verdict: ModelAuditVerdict; stats: FingerprintStats | null } {
  // An unfinished question set (the seller skipped at a batch) is undecided, as the run decides it, only when the
  // batch it names is stored as the run stores a skip: failed, with no scored answer, and the failure's own summary as
  // the mark's reason. A mark the evidence cannot back is ignored, and the numbers decide.
  const unfinished = evidence.result.unfinished
  const skippedAt = unfinished ? evidence.exchanges.find((exchange) => exchange.batchIndex === unfinished.batchIndex) : undefined
  const backedSkip = skippedAt !== undefined && skippedAt.status === 'failed'
    && skippedAt.matches.every((match) => match === null)
    && typeof skippedAt.outcomeReason?.summary === 'string' && skippedAt.outcomeReason.summary === unfinished!.reason
  const matches = new Map<string, 0 | 1 | null>()
  for (const exchange of evidence.exchanges) {
    for (const [index, probeId] of exchange.probeIds.entries()) matches.set(probeId, exchange.matches[index] ?? null)
  }
  const matchVector = evidence.reference.probes.map((probe) => matches.get(probe.id) ?? null)
  let baseline: ReturnType<typeof kbfAuditBaseline>
  try {
    baseline = kbfAuditBaseline(evidence.reference as unknown as KbfReferenceV1, evidence.reference.probes.map((probe) => probe.id))
  } catch {
    return { verdict: 'UNDETERMINED', stats: null }
  }
  // The set is judged by the coverage rule it names, never by a newer one; a set from before it names none.
  const coverageRule = evidence.result.coverageRule
  const computed = computeKbfVerdict({
    selfHamming: baseline.hamming, selfTotal: baseline.total, targetMatchVector: matchVector,
    minCoverage: KBF_AUDIT_VERIFY_OPTIONS.minCoverage, minDiffCoverage: KBF_AUDIT_VERIFY_OPTIONS.minDiffCoverage,
    ...(coverageRule !== undefined ? { coverageRule: coverageRuleOf(coverageRule) } : {}),
  })
  const authenticated = evidence.exchanges.every((exchange) => exchange.status !== 'succeeded' || exchange.responseAuth.status === 'verified')
  const stats: FingerprintStats = { ...computed.stats, selfCoverage: baseline.coverage }
  return { verdict: authenticated && !backedSkip && computed.verdict !== 'UNKNOWN' ? computed.verdict : 'UNDETERMINED', stats }
}

/**
 * The questions' own verdict, from a seller's evidence files: the first set's look, or after a close call the pooled
 * look of the first set and its extra sets, each checked (the rule, the close-call zone, verified ResponseAuth, no
 * probe asked twice, the pooled statistics and the continuation). `closed`: a flagged audit whose close call could not
 * be finished, accepted only when the latest look really was a close call; its questions are undecided. A questions
 * DIFF needs scored answers. `pending`: the latest look is still a close call waiting for an extra set. Submit and the
 * confirmer's read of published evidence both decide the questions' finding here, never from a stored label. Throws.
 */
export function adjudicateQuestions(input: {
  evidence: ProxyAuditEvidenceV1
  extraSets: ReadonlyArray<{ record: ExtraSetRecord; evidence: ProxyAuditEvidenceV1 }>
  decisionRule: string | undefined
  closed: boolean
}): { verdict: ModelAuditVerdict; pending: boolean } {
  const { evidence, extraSets } = input
  const rule = input.decisionRule === undefined ? undefined : kbfExtensionRuleById(input.decisionRule) ?? undefined
  const unverified = (checked: ProxyAuditEvidenceV1): boolean => checked.exchanges.some((exchange) => (
    exchange.status === 'succeeded' && exchange.responseAuth.status !== 'verified'
  ))
  const sharesProbes = (left: ProxyAuditEvidenceV1, right: ProxyAuditEvidenceV1): boolean => {
    const ids = new Set(left.reference.probes.map((probe) => probe.id))
    return left.reference.referenceId === right.reference.referenceId
      || right.reference.probes.some((probe) => ids.has(probe.id))
  }
  // Every set's look recomputed from what its evidence stores (each batch's matches and the reference's own errors),
  // with the run's coverage and auth rules, exactly as the run decides it. Its label must be that look, UNDETERMINED
  // included: a decisive look is never relabelled (hidden from both readers, or withheld), and a look whose numbers say
  // SAME never passes as DIFF. The zone test and the pooled verdict read only these recomputed statistics.
  const lookOf = (set: ProxyAuditEvidenceV1, which: string) => {
    const recomputed = recomputedFirstLook(set)
    if (set.result.verdict !== recomputed.verdict) {
      throw new Error(`the questions' ${which} says ${set.result.verdict}, but its stored answers give ${recomputed.verdict}`)
    }
    return recomputed
  }
  const firstLook = lookOf(evidence, 'first look')
  const looks = extraSets.map(({ evidence: set }, index) => lookOf(set, index === 0 ? 'extra set' : 'second extra set'))
  // As `needsExtension`: a set whose ResponseAuth failed, or a seller that refuses the request profile, is not extended.
  const firstLookExtends = rule !== undefined && !unverified(evidence)
    && evidence.result.outcomeReason?.code !== 'request_profile_incompatible'
    && firstLook.stats !== null
    && classifyKbfFirstLook(firstLook.stats, { minCoverage: KBF_VERIFY_OPTIONS.minCoverage, rule }) === 'extend'
  let verdict: ModelAuditVerdict = evidence.result.verdict
  let latestExtends = firstLookExtends
  // Both readers (submit and the confirmer) hold an extra set to the same form: tagged with the all-tests format, and no
  // test record on it, since tests run on the first set only.
  for (const { evidence: set } of extraSets) {
    if (set.tests !== ALL_TESTS_FORMAT) throw new Error('an extra set does not name the all-tests format')
    if (METHODS.some((check) => set[check.slot] != null)) throw new Error('an extra set stores a test record; tests run on the first set only')
  }
  if (extraSets.length > 0) {
    if (!rule || extraSets.some(({ record }) => record.rule !== rule.id)) throw new Error('extension without the close-call rule')
    if (extraSets.some(({ evidence: set }) => set.result.coverageRule !== evidence.result.coverageRule)) {
      throw new Error('an extra set decided by another coverage rule than its first set')
    }
    if (extraSets.length > rule.maxExtensions) throw new Error(`${rule.id} allows at most ${rule.maxExtensions} extra set(s)`)
    if (!firstLookExtends) {
      throw new Error(unverified(evidence) ? 'extension of a first check without verified ResponseAuth' : 'extension of a first check that was not a close call')
    }
    const sameNumber = (left: number | null, right: number | null): boolean => (
      left === right || (left !== null && right !== null && Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left)))
    )
    const seen: ProxyAuditEvidenceV1[] = [evidence]
    for (const [index, { record, evidence: setEvidence }] of extraSets.entries()) {
      const label = index === 0 ? 'extension' : 'second extension'
      if (seen.some((earlier) => sharesProbes(earlier, setEvidence))) throw new Error(`${label} reused probes from an earlier set`)
      seen.push(setEvidence)
      if (looks.slice(0, index + 1).some((look) => look.stats === null)) throw new Error(`${label}: its statistics cannot be recomputed`)
      const pooled = pooledCloseCallVerdict(
        { stats: firstLook.stats!, probeCount: evidence.reference.probes.length },
        extraSets.slice(0, index + 1).map(({ evidence: e }, at) => ({ stats: looks[at]!.stats!, probeCount: e.reference.probes.length })),
        rule,
        evidence.result.coverageRule,
      )
      if (pooled.verdict === 'UNKNOWN') throw new Error(`pooled verdict is UNKNOWN: ${pooled.verdictReason}`)
      const recordedPooled = record.pooled
      if (pooled.stats.selfHamming !== recordedPooled.selfHamming || pooled.stats.selfTotal !== recordedPooled.selfTotal
        || pooled.stats.targetHamming !== recordedPooled.targetHamming || pooled.stats.targetTotal !== recordedPooled.targetTotal
        || !sameNumber(pooled.stats.pValueBinomial, recordedPooled.pValueBinomial)) {
        throw new Error(`pooled statistics do not follow from the evidence files (${label})`)
      }
      const authFailed = unverified(setEvidence)
      const extendNext = !authFailed && pooled.extend
      if ((recordedPooled.extendNext === true) !== extendNext) throw new Error(`close-call continuation mismatch (${label})`)
      const lookVerdict: ModelAuditVerdict = authFailed ? 'UNDETERMINED' : pooled.verdict
      if (recordedPooled.verdict !== lookVerdict) throw new Error('pooled verdict mismatch')
      // Only the last set's look may be undecided, and then the close call is still waiting.
      if (index < extraSets.length - 1 && !extendNext) throw new Error(`extra set after a decided look (${label})`)
      verdict = lookVerdict
      latestExtends = extendNext && extraSets.length < rule.maxExtensions
    }
  }
  if (input.closed) {
    // Only a real close call can be closed: the latest look still extends.
    if (!latestExtends) throw new Error('a closed close call whose latest look was not a close call')
    return { verdict: 'UNDETERMINED', pending: false }
  }
  // The questions flag only on scored answers.
  if (verdict === 'DIFF' && extraSets.length === 0 && evidence.result.parsedProbeCount === 0) {
    throw new Error('a questions DIFF with no scored answer')
  }
  return { verdict, pending: latestExtends }
}

/**
 * A result the retired DIFF self-recheck (CLI 0.2.67 to 0.2.70) turned into UNDETERMINED: its first
 * check found DIFF and a recheck on fresh probes did not. The summary points at the first check's
 * evidence, which says DIFF, so it can be neither validated nor submitted as recorded; the epoch plan
 * audits the seller again instead. A recheck that also found DIFF left the result DIFF and stays valid.
 */
export function retiredRecheckResult(result: ModelAuditSummaryV1['results'][number]): boolean {
  return (result as { recheck?: unknown }).recheck != null && result.status !== 'DIFF'
}

/**
 * The verdict submitted for a seller. A close call is decided on its first set pooled with its extra
 * sets; null while one is missing (null results are not submitted). A DIFF is submitted as found: it
 * is one auditor's report, and the contract records it only once another auditor confirms it.
 */
export function finalAuditVerdict(result: ModelAuditSummaryV1['results'][number]): ModelAuditVerdict | null {
  // The one decision the run, the extension round, the planner and submit share (`auditDecision`), never the stored
  // status: null while a close call waits, else the audit's verdict over every test. Submit recomputes it again.
  const decision = auditDecision(result)
  return decision.pending ? null : decision.audit.verdict
}

/** The questions' own verdict of a result, as the attribution reads it. */
function questionsVerdictOf(result: Pick<ModelAuditSummaryV1['results'][number], 'status' | 'questionsStatus'>): ModelAuditVerdict {
  return result.questionsStatus ?? result.status
}

async function readModelSummary(path: string, runId: string, model: string): Promise<ModelAuditSummaryV1> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as ModelAuditSummaryV1
  if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-model-summary') {
    throw new Error(`invalid model audit summary: ${path}`)
  }
  if (parsed.runId !== runId || normalized(parsed.model) !== normalized(model)) {
    throw new Error(`model audit summary does not belong to run ${runId}: ${path}`)
  }
  return parsed
}
