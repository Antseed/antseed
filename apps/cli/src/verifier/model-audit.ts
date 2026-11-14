import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { getAddress } from 'ethers'
import {
  KBF_AUDIT_VERIFY_OPTIONS,
  classifyKbfFirstLook,
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
import { EXTRA_QUESTIONS_PUBLISHED, isExtraQuestionsPublished, type VerificationOutcomeReasonV1 } from './outcome-reason.js'
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
import { closeCallRule, pooledCloseCallVerdict, stageOneVerdict, type CloseCallRuleId } from './close-call.js'
import { verifyProxyAuditEvidenceFile, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'
import type { SubmissionCandidate } from './submission-delta.js'
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
  provider: 'pinata'
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
  alreadyOnChain?: (modelHash: string, candidates: readonly SubmissionCandidate[]) => Promise<boolean[]>
  /**
   * Never a third opinion (`third-opinion.ts`): one reason or null per candidate; a result with a
   * reason is left out of the submission and listed among the excluded sellers with that reason.
   */
  thirdOpinion?: (modelHash: string, candidates: readonly SubmissionCandidate[]) => Promise<Array<string | null>>
  /**
   * The model's audit window this epoch (`audit-window.ts`), or null when it has none (confirmations).
   * An open window's results are not submitted yet; in a closed one, a close call still waiting for
   * its extra questions is submitted as UNDETERMINED, and a seller outside the window (one that came
   * online after it opened) gets no result, unless the result confirms another auditor's DIFF.
   */
  auditWindow?: (model: string) => Promise<Pick<AuditWindowV1, 'state' | 'sellers'> | null>
}): Promise<{
  audits: PreparedModelAudit[]
  excluded: Array<ExcludedSellerAuditV1 & { model: string }>
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
  const alreadyOnChain: Array<{ model: string; count: number }> = []
  for (const model of input.manifest.modelOrder) {
    const modelManifest = input.manifest.models.find((entry) => normalized(entry.model) === normalized(model))
    if (!modelManifest) throw new Error(`run manifest is missing the model summary for ${model}`)
    const summary = await readModelSummary(modelManifest.summaryPath, input.manifest.runId, model)
    const window = await input.auditWindow?.(model) ?? null
    const excluded: ExcludedSellerAuditV1[] = []
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
    }> = []
    const seen = new Set<string>()
    let referenceModel: string | null = null
    for (let result of summary.results) {
      const exclude = (reason: string): void => {
        excluded.push({ peerId: result.peerId, agentId: result.agentId, service: result.service, auditId: result.auditId, reason })
      }
      const agentId = parseAgentId(result.agentId)
      if (agentId === null) {
        exclude('missing or invalid seller agent ID')
        continue
      }
      if (retiredRecheckResult(result)) {
        exclude('made by the retired DIFF self-recheck (CLI 0.2.70 and older), whose combined verdict the evidence '
          + 'no longer carries; a later run this epoch audits the seller again')
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
        validateAuditMatchesSummary(evidence, result, extensionEvidence, extension2Evidence)
      } catch (error) {
        exclude(`invalid audit evidence: ${asError(error).message}`)
        continue
      }
      if (window?.state === 'open') {
        // A confirmation waits too: its evidence would publish the epoch's questions for this model while
        // the window's other sellers are still being asked them.
        exclude(result.confirmsDiff
          ? 'a confirmation on a model whose audit window is still open: it is submitted when the window closes, so the window\'s questions stay unpublished while its sellers are asked'
          : 'its audit window is still open: the model\'s results are submitted together once every seller of the window is finished')
        heldBack.push(`${model} ${result.agentId ?? result.peerId}: its audit window is still open`)
        continue
      }
      if (window && !result.confirmsDiff && !windowIncludesSeller(window, result.peerId)) {
        exclude('not in this epoch\'s audit window (it came online after the window opened); audited next epoch')
        continue
      }
      // A closed window asks no more extra questions: its open close calls are audited but undecided.
      let finalVerdict = finalAuditVerdict(result) ?? (window?.state === 'closed' ? 'UNDETERMINED' : null)
      // So is a close call whose first audit was made on a set a submit has published since: its extra
      // questions are public and are never asked (`decideRetryGiveUps`). A confirmation's is an undecided
      // attempt instead: the seller is audited again on new questions, and only the merged epoch's last
      // attempt (marked with the reason, `applyRetryGiveUps`) is submitted.
      if (finalVerdict === null && await questionSetRetired(input, model, evidence.reference.referenceId)) {
        if (result.confirmsDiff && !isExtraQuestionsPublished(result.outcomeReason)) {
          exclude('a confirmation whose extra questions were published before they could be asked: the seller is audited '
            + 'again on new questions, up to its attempt limit, before anything is submitted')
          heldBack.push(`${model} ${result.agentId ?? result.peerId}: confirmation audited again on new questions`)
          continue
        }
        finalVerdict = 'UNDETERMINED'
        result = { ...result, outcomeReason: result.outcomeReason ?? EXTRA_QUESTIONS_PUBLISHED }
      }
      if (finalVerdict === null) {
        if (result.extensionPending) heldBack.push(`${model} ${result.agentId ?? result.peerId}: close call waiting for its extra questions`)
        exclude(result.extensionPending
          ? `close call waiting for its extra questions (${result.extensionPending.reason}); a later run this epoch asks them, so it is not submitted yet`
          : 'close call without its extra questions, so it is not submitted')
        continue
      }
      if (finalVerdict === 'UNDETERMINED' && failureBlame(result.outcomeReason) === 'auditor') {
        // The auditor's own failure says nothing about the seller's model, also when a run is
        // submitted directly (`--run-id`) rather than through the merged epoch.
        exclude(`UNDETERMINED caused by this auditor (${result.outcomeReason?.summary ?? 'audit failed'}), so it is not submitted`)
        continue
      }
      if (finalVerdict !== result.status) result = { ...result, status: finalVerdict }
      if (referenceModel === null) referenceModel = evidence.reference.referenceModel
      else if (normalized(referenceModel) !== normalized(evidence.reference.referenceModel)) {
        exclude(`audited against ${evidence.reference.referenceModel}, not ${referenceModel}`)
        continue
      }
      const duplicateKey = `${agentId}:${serviceHash(result.service)}`
      if (seen.has(duplicateKey)) {
        exclude(`duplicate audited service ${result.service}`)
        continue
      }
      let owner: string
      try {
        owner = await ownerOf(agentId)
      } catch (error) {
        exclude(`unknown seller agent ${agentId}: ${asError(error).message}`)
        continue
      }
      if (normalized(owner) === normalized(auditor)) {
        exclude(`self-audit: the auditor owns seller agent ${agentId}`)
        continue
      }
      seen.add(duplicateKey)
      accepted.push({ agentId, result, evidence, extensionEvidence, extension2Evidence })
    }

    keepOneSamePerSeller(accepted, excluded)
    allExcluded.push(...excluded.map((entry) => ({ ...entry, model })))
    if (accepted.length === 0 || referenceModel === null) continue
    // After keepOneSamePerSeller, so the SAME kept per seller is the same one whether or not it is
    // already on-chain (another of its services is never sent in its place).
    const candidatesOf = (): SubmissionCandidate[] => accepted.map((entry) => ({
      agentId: entry.agentId,
      serviceHash: serviceHash(entry.result.service),
      verdict: verifierVerdict(entry.result.status),
      auditedAt: auditedAt(entry),
      confirmsDiff: entry.result.confirmsDiff === true,
    }))
    if (input.alreadyOnChain) {
      const onChain = await input.alreadyOnChain(modelHash(referenceModel), candidatesOf())
      const count = onChain.filter(Boolean).length
      if (count > 0) {
        alreadyOnChain.push({ model, count })
        for (let index = accepted.length - 1; index >= 0; index -= 1) if (onChain[index]) accepted.splice(index, 1)
      }
      if (accepted.length === 0) continue
    }
    if (input.thirdOpinion) {
      const reasons = await input.thirdOpinion(modelHash(referenceModel), candidatesOf())
      for (let index = accepted.length - 1; index >= 0; index -= 1) {
        const reason = reasons[index]
        if (!reason) continue
        const { result } = accepted[index]!
        allExcluded.push({ model, peerId: result.peerId, agentId: result.agentId, service: result.service, auditId: result.auditId, reason })
        accepted.splice(index, 1)
      }
      if (accepted.length === 0) continue
    }
    accepted.sort((left, right) => compareResults(
      left.agentId, serviceHash(left.result.service), right.agentId, serviceHash(right.result.service),
    ))
    const partCount = Math.ceil(accepted.length / maxResults)
    // Read once per model, not once per part: neither depends on the part.
    const bankExchanges = await loadBankReferenceExchanges(input.banksDir, model)
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
          const reference = validateKbfReferenceV1(located, {
            minimumStatisticalPower: extensionReferenceIds.has(referenceId) ? Number.EPSILON : sizing.minimumStatisticalPower,
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
      const results: ModelAuditSellerResultV1[] = slice.map(({ agentId, result, evidence, extensionEvidence, extension2Evidence }) => ({
        agentId: agentId.toString(),
        peerId: result.peerId,
        displayName: result.displayName,
        service: result.service,
        serviceHash: serviceHash(result.service),
        verdict: result.status,
        verdictReason: evidence.result.verdictReason,
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
      }))
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
      })
    }
  }
  return { audits, excluded: allExcluded, alreadyOnChain, heldBack }
}

/** Unix seconds of the latest evidence file behind a result: its last extra set when it has one. */
function auditedAt(entry: {
  evidence: ProxyAuditEvidenceV1
  extensionEvidence: ProxyAuditEvidenceV1 | null
  extension2Evidence: ProxyAuditEvidenceV1 | null
}): number {
  const times = [entry.evidence, entry.extensionEvidence, entry.extension2Evidence]
    .flatMap((evidence) => evidence ? [Date.parse(evidence.createdAt)] : [])
    .filter(Number.isFinite)
  return times.length === 0 ? 0 : Math.max(...times) / 1_000
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
): void {
  for (const checked of [evidence, extensionEvidence, extension2Evidence]) {
    if (!checked) continue
    if (normalized(checked.target.peerId) !== normalized(result.peerId)) throw new Error('seller peer ID mismatch')
    if (normalized(checked.target.service) !== normalized(result.service)) throw new Error('service mismatch')
    if ((checked.target.agentId ?? null) !== (result.agentId ?? null)) throw new Error('seller agent ID mismatch')
  }
  const sharesProbes = (left: ProxyAuditEvidenceV1, right: ProxyAuditEvidenceV1): boolean => {
    const ids = new Set(left.reference.probes.map((probe) => probe.id))
    return left.reference.referenceId === right.reference.referenceId
      || right.reference.probes.some((probe) => ids.has(probe.id))
  }
  // The close-call decision reads the summary's stats; they must be the first check's evidence stats.
  if (result.stats && canonicalHashBytes32(result.stats) !== canonicalHashBytes32(evidence.result.stats)) {
    throw new Error('first check statistics do not match its evidence')
  }
  // The stage-1 verdict, recomputed from the evidence: the first check's own verdict, or after a
  // close call the pooled verdict of the first check and its extra sets.
  let stageOne: ModelAuditVerdict = evidence.result.verdict
  const extraSets: Array<{ record: NonNullable<typeof result.extension>; evidence: ProxyAuditEvidenceV1 }> = []
  if (result.extension2 && !result.extension) throw new Error('second extra set without a first one')
  if (result.extension) {
    if (!extensionEvidence) throw new Error('extension evidence missing')
    extraSets.push({ record: result.extension, evidence: extensionEvidence })
  }
  if (result.extension2) {
    if (!extension2Evidence) throw new Error('second extension evidence missing')
    extraSets.push({ record: result.extension2, evidence: extension2Evidence })
  }
  if (extraSets.length > 0) {
    const rule = kbfExtensionRuleById(result.decisionRule)
    if (!rule || extraSets.some(({ record }) => record.rule !== rule.id)) {
      throw new Error('extension without the close-call rule')
    }
    if (extraSets.length > rule.maxExtensions) throw new Error(`${rule.id} allows at most ${rule.maxExtensions} extra set(s)`)
    if (classifyKbfFirstLook(evidence.result.stats, { minCoverage: KBF_VERIFY_OPTIONS.minCoverage, rule }) !== 'extend') {
      throw new Error('extension of a first check that was not a close call')
    }
    const unverified = (checked: ProxyAuditEvidenceV1): boolean => checked.exchanges.some((exchange) => (
      exchange.status === 'succeeded' && exchange.responseAuth.status !== 'verified'
    ))
    if (unverified(evidence)) throw new Error('extension of a first check without verified ResponseAuth')
    const sameNumber = (left: number | null, right: number | null): boolean => (
      left === right || (left !== null && right !== null && Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left)))
    )
    const seen: ProxyAuditEvidenceV1[] = [evidence]
    for (const [index, { record, evidence: setEvidence }] of extraSets.entries()) {
      const label = index === 0 ? 'extension' : 'second extension'
      if (record.status !== setEvidence.result.verdict) throw new Error(`${label} verdict mismatch`)
      if (seen.some((earlier) => sharesProbes(earlier, setEvidence))) throw new Error(`${label} reused probes from an earlier set`)
      seen.push(setEvidence)
      const pooled = pooledCloseCallVerdict(
        { stats: evidence.result.stats, probeCount: evidence.reference.probes.length },
        extraSets.slice(0, index + 1).map(({ evidence: e }) => ({ stats: e.result.stats, probeCount: e.reference.probes.length })),
        rule,
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
      const last = index === extraSets.length - 1
      // Only the last set's look may be undecided, and then the close call is still waiting.
      if (!last && !extendNext) throw new Error(`extra set after a decided look (${label})`)
      stageOne = lookVerdict
    }
  }
  if (stageOne !== result.status) throw new Error('verdict mismatch')
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
  return stageOneVerdict(result)
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
