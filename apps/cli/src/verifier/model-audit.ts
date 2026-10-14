import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { getAddress } from 'ethers'
import {
  KBF_AUDIT_VERIFY_OPTIONS,
  canonicalHashBytes32,
  canonicalJsonStringify,
  sha256Hex,
  validateKbfReferenceV1,
  type FingerprintStats,
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
import type { VerificationOutcomeReasonV1 } from './outcome-reason.js'
import type { ReferenceUpstreamProvenanceV1 } from './model-reference.js'
import { findEpochProbeReference, loadBankReferenceExchanges } from './probe-bank.js'
import { verifyProxyAuditEvidenceFile, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'
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
   * Second check on fresh probes after the first check (`audit`) said DIFF. `verdict` stays DIFF
   * unless this check is SAME, which makes it UNDETERMINED.
   */
  confirmation?: {
    verdict: ModelAuditVerdict
    referenceId: string
    stats: FingerprintStats
    matchVectorHash: string
    audit: {
      auditId: string
      evidencePath: string
      evidenceHash: string
    }
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
   * Raw upstream request/response bytes behind the probe bank these references were drawn
   * from, one file per reference build. Absent on evidence written before they were recorded.
   */
  referenceEvidence?: ModelAuditReferenceEvidenceV1[]
  kbfOptions: typeof KBF_VERIFY_OPTIONS
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
}): Promise<{ audits: PreparedModelAudit[]; excluded: Array<ExcludedSellerAuditV1 & { model: string }> }> {
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
  for (const model of input.manifest.modelOrder) {
    const modelManifest = input.manifest.models.find((entry) => normalized(entry.model) === normalized(model))
    if (!modelManifest) throw new Error(`run manifest is missing the model summary for ${model}`)
    const summary = await readModelSummary(modelManifest.summaryPath, input.manifest.runId, model)
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
      recheckEvidence: ProxyAuditEvidenceV1 | null
    }> = []
    const seen = new Set<string>()
    let referenceModel: string | null = null
    for (const result of summary.results) {
      const exclude = (reason: string): void => {
        excluded.push({ peerId: result.peerId, agentId: result.agentId, service: result.service, auditId: result.auditId, reason })
      }
      const agentId = parseAgentId(result.agentId)
      if (agentId === null) {
        exclude('missing or invalid seller agent ID')
        continue
      }
      let evidence: ProxyAuditEvidenceV1
      let recheckEvidence: ProxyAuditEvidenceV1 | null = null
      try {
        evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
        if (result.recheck) {
          recheckEvidence = await verifyProxyAuditEvidenceFile(result.recheck.evidencePath, result.recheck.evidenceHash)
        }
        validateAuditMatchesSummary(evidence, result, recheckEvidence)
      } catch (error) {
        exclude(`invalid audit evidence: ${asError(error).message}`)
        continue
      }
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
      accepted.push({ agentId, result, evidence, recheckEvidence })
    }

    allExcluded.push(...excluded.map((entry) => ({ ...entry, model })))
    if (accepted.length === 0 || referenceModel === null) continue
    accepted.sort((left, right) => compareResults(
      left.agentId, serviceHash(left.result.service), right.agentId, serviceHash(right.result.service),
    ))
    const partCount = Math.ceil(accepted.length / maxResults)
    for (let part = 1; part <= partCount; part += 1) {
      const slice = accepted.slice((part - 1) * maxResults, part * maxResults)
      const key = partCount === 1 ? model : `${model}#${part}`
      const evidencePath = modelAuditEvidencePath(input.evidenceDir, input.manifest.runId, key)
      const evidenceDirectory = dirname(evidencePath)
      const references: PreparedModelAudit['references'] = []
      const referenceEntries: ModelAuditEvidenceV1['references'] = []
      const auditEvidence = slice.flatMap(({ evidence, recheckEvidence }) => (
        recheckEvidence ? [evidence, recheckEvidence] : [evidence]
      ))
      for (const evidence of auditEvidence) {
        const referenceId = evidence.reference.referenceId
        if (referenceEntries.some((entry) => entry.referenceId === referenceId)) continue
        const referencePath = join(evidenceDirectory, 'references', `${referenceFileName(referenceId)}.json`)
        let exportedPath: string | null = null
        const located = await findEpochProbeReference(input.banksDir, referenceId)
        if (located) {
          const reference = validateKbfReferenceV1(located, { minimumStatisticalPower: sizing.minimumStatisticalPower })
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
      const referenceEvidence: PreparedModelAudit['referenceEvidence'] = []
      const referenceEvidenceEntries: ModelAuditReferenceEvidenceV1[] = []
      for (const stored of await loadBankReferenceExchanges(input.banksDir, model)) {
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
      const results: ModelAuditSellerResultV1[] = slice.map(({ agentId, result, evidence, recheckEvidence }) => ({
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
        ...(result.recheck && recheckEvidence ? {
          confirmation: {
            verdict: result.recheck.status,
            referenceId: recheckEvidence.reference.referenceId,
            stats: recheckEvidence.result.stats,
            matchVectorHash: recheckEvidence.result.matchVectorHash,
            audit: {
              auditId: result.recheck.auditId,
              evidencePath: portableRelative(evidenceDirectory, result.recheck.evidencePath),
              evidenceHash: result.recheck.evidenceHash,
            },
          },
        } : {}),
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
        ...(referenceEvidenceEntries.length > 0 ? { referenceEvidence: referenceEvidenceEntries } : {}),
        kbfOptions: KBF_VERIFY_OPTIONS,
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
        auditEvidencePaths: slice.flatMap(({ result }) => (
          result.recheck ? [result.evidencePath, result.recheck.evidencePath] : [result.evidencePath]
        )),
      })
    }
  }
  return { audits, excluded: allExcluded }
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
  recheckEvidence: ProxyAuditEvidenceV1 | null = null,
): void {
  for (const checked of recheckEvidence ? [evidence, recheckEvidence] : [evidence]) {
    if (normalized(checked.target.peerId) !== normalized(result.peerId)) throw new Error('seller peer ID mismatch')
    if (normalized(checked.target.service) !== normalized(result.service)) throw new Error('service mismatch')
    if ((checked.target.agentId ?? null) !== (result.agentId ?? null)) throw new Error('seller agent ID mismatch')
  }
  if (!result.recheck) {
    if (evidence.result.verdict !== result.status) throw new Error('verdict mismatch')
    return
  }
  if (!recheckEvidence) throw new Error('recheck evidence missing')
  if (evidence.result.verdict !== 'DIFF') throw new Error('recheck without a first DIFF')
  if (recheckEvidence.result.verdict !== result.recheck.status) throw new Error('recheck verdict mismatch')
  if (recheckEvidence.reference.referenceId === evidence.reference.referenceId
    || recheckEvidence.reference.probes.some((probe) => evidence.reference.probes.some((first) => first.id === probe.id))) {
    throw new Error('recheck reused probes from the first check')
  }
  const expected = recheckEvidence.result.verdict === 'SAME' ? 'UNDETERMINED' : 'DIFF'
  if (result.status !== expected) throw new Error('final verdict does not follow from the recheck')
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
