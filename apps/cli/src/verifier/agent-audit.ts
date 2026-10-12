import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { getAddress } from 'ethers'
import {
  canonicalHashBytes32,
  canonicalJsonStringify,
  validateKbfReferenceV1,
  type FingerprintStats,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import { modelHash, serviceHash, sortServiceResults, type ServiceResultInput } from '@antseed/node/payments'
import type { VerifierCLIConfig } from '../config/types.js'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from './audit-artifacts.js'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'
import { findEpochProbeReference } from './probe-bank.js'
import { verifyProxyAuditEvidenceFile, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'
import { asError, normalized } from './utils.js'

/** AntseedVerification.MAX_SERVICES_PER_AUDIT. */
export const MAX_SERVICES_PER_AUDIT = 64
/** Options every audit passes to verifyKbf (see verifyModelTarget). */
export const KBF_VERIFY_OPTIONS = { minCoverage: 1 } as const

export interface AgentServiceEvidenceV1 {
  model: string
  service: string
  serviceHash: string
  peerId: string
  displayName: string | null
  referenceId: string
  /** On-chain model identity: keccak256 of the lowercased reference model. */
  modelHash: string
  reference: {
    referenceModel: string
    queryProfileHash: string
    probeCount: number
    /** Full KBF reference, relative to the evidence document; null when it could not be exported. */
    path: string | null
  }
  verdict: 'SAME' | 'DIFF'
  verdictReason: string | null
  stats: FingerprintStats
  matchVectorHash: string
  kbfOptions: typeof KBF_VERIFY_OPTIONS
  passed: boolean
  audit: {
    auditId: string
    /** Proxy audit evidence file, relative to the evidence document. */
    evidencePath: string
    evidenceHash: string
  }
}

export interface ExcludedServiceAuditV1 {
  model: string
  peerId: string
  agentId: string | null
  service: string
  auditId: string | null
  reason: string
}

export interface AgentAuditEvidenceV1 {
  version: 2
  kind: 'antseed-verifier-agent-audit-evidence'
  runId: string
  epoch: string
  agentId: string
  auditor: string
  services: AgentServiceEvidenceV1[]
  excluded: ExcludedServiceAuditV1[]
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

/** Local record of one agent's audit submission; makes `verifier submit` safe to re-run. */
export interface AgentAuditSubmissionV1 {
  version: 1
  kind: 'antseed-verifier-agent-audit-submission'
  runId: string
  agentId: string
  auditor: string
  chainId: string
  contract: string
  evidenceHash: string
  evidenceUri: string
  publication?: AuditPublicationV1
  transactionHash: string | null
  submittedAt: string | null
}

export interface PreparedAgentAudit {
  agentId: bigint
  evidence: AgentAuditEvidenceV1
  evidenceHash: string
  evidencePath: string
  results: ServiceResultInput[]
  references: Array<{ path: string; reference: KbfReferenceV1 }>
  auditEvidencePaths: string[]
}

export function auditsDirectory(evidenceDir: string, runId: string): string {
  return join(evidenceDir, 'audits', safeServiceSlug(runId))
}

export function agentEvidencePath(evidenceDir: string, runId: string, agentId: bigint | string): string {
  return join(auditsDirectory(evidenceDir, runId), `${String(agentId)}.evidence.json`)
}

export function agentSubmissionPath(evidenceDir: string, runId: string, agentId: bigint | string): string {
  return join(auditsDirectory(evidenceDir, runId), `${String(agentId)}.submission.json`)
}

/**
 * Groups a completed run's results per seller agent. A service passes when KBF judged it SAME;
 * UNDETERMINED audits are excluded so they can be re-run rather than counted as failures.
 */
export async function prepareAgentAudits(input: {
  evidenceDir: string
  banksDir: string
  manifest: VerifierRunManifestV1
  auditor: string
  resolveAgentOwner(agentId: bigint): Promise<string>
  config?: VerifierCLIConfig
}): Promise<{ audits: PreparedAgentAudit[]; excluded: ExcludedServiceAuditV1[] }> {
  const auditor = getAddress(input.auditor)
  const excluded: ExcludedServiceAuditV1[] = []
  const groups = new Map<string, {
    services: Array<{ model: string; result: ModelAuditSummaryV1['results'][number]; evidence: ProxyAuditEvidenceV1 }>
    excluded: ExcludedServiceAuditV1[]
  }>()
  const group = (agentId: string) => {
    let entry = groups.get(agentId)
    if (!entry) {
      entry = { services: [], excluded: [] }
      groups.set(agentId, entry)
    }
    return entry
  }
  const exclude = (exclusion: ExcludedServiceAuditV1): void => {
    if (exclusion.agentId && isAgentId(exclusion.agentId)) group(BigInt(exclusion.agentId).toString()).excluded.push(exclusion)
    else excluded.push(exclusion)
  }

  for (const model of input.manifest.modelOrder) {
    const modelManifest = input.manifest.models.find((entry) => normalized(entry.model) === normalized(model))
    if (!modelManifest) throw new Error(`run manifest is missing the model summary for ${model}`)
    const summary = await readModelSummary(modelManifest.summaryPath, input.manifest.runId, model)
    for (const entry of [...summary.failures, ...summary.skipped]) {
      exclude({
        model,
        peerId: entry.peerId,
        agentId: entry.agentId,
        service: entry.service,
        auditId: 'auditId' in entry ? entry.auditId : null,
        reason: entry.reason,
      })
    }
    for (const result of summary.results) {
      const base = { model, peerId: result.peerId, agentId: result.agentId, service: result.service, auditId: result.auditId }
      if (!result.agentId || !isAgentId(result.agentId)) {
        exclude({ ...base, agentId: null, reason: 'missing or invalid seller agent ID' })
        continue
      }
      if (result.status === 'UNDETERMINED') {
        exclude({ ...base, reason: 'undetermined: re-audit' })
        continue
      }
      let evidence: ProxyAuditEvidenceV1
      try {
        evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
        validateAuditMatchesSummary(evidence, result)
      } catch (error) {
        exclude({ ...base, reason: `invalid audit evidence: ${asError(error).message}` })
        continue
      }
      const entry = group(BigInt(result.agentId).toString())
      const hashed = serviceHash(result.service)
      if (entry.services.some((service) => serviceHash(service.result.service) === hashed)) {
        exclude({ ...base, reason: `duplicate audited service ${result.service}` })
        continue
      }
      entry.services.push({ model, result, evidence })
    }
  }

  const sizing = resolveReferenceSizingPolicy(input.config)
  const audits: PreparedAgentAudit[] = []
  for (const [agentIdText, entry] of [...groups.entries()].sort(([left], [right]) => compareBigInt(left, right))) {
    const agentId = BigInt(agentIdText)
    const skipAgent = (reason: string): void => {
      for (const { model, result } of entry.services) {
        excluded.push({ model, peerId: result.peerId, agentId: agentIdText, service: result.service, auditId: result.auditId, reason })
      }
      excluded.push(...entry.excluded)
    }
    if (entry.services.length === 0) {
      excluded.push(...entry.excluded)
      continue
    }
    if (entry.services.length > MAX_SERVICES_PER_AUDIT) {
      skipAgent(`agent ${agentIdText} has ${entry.services.length} audited services; maximum is ${MAX_SERVICES_PER_AUDIT}`)
      continue
    }
    let owner: string
    try {
      owner = await input.resolveAgentOwner(agentId)
    } catch (error) {
      skipAgent(`unknown seller agent ${agentIdText}: ${asError(error).message}`)
      continue
    }
    if (normalized(owner) === normalized(auditor)) {
      skipAgent(`self-audit: the auditor owns seller agent ${agentIdText}`)
      continue
    }

    const evidencePath = agentEvidencePath(input.evidenceDir, input.manifest.runId, agentIdText)
    const evidenceDirectory = dirname(evidencePath)
    const references: PreparedAgentAudit['references'] = []
    const services: AgentServiceEvidenceV1[] = []
    for (const { model, result, evidence } of entry.services) {
      const referenceId = evidence.reference.referenceId
      const referencePath = join(evidenceDirectory, 'references', `${referenceFileName(referenceId)}.json`)
      let exportedPath: string | null = null
      const located = await findEpochProbeReference(input.banksDir, referenceId)
      if (located) {
        const reference = validateKbfReferenceV1(located, { minimumStatisticalPower: sizing.minimumStatisticalPower })
        if (!references.some((existing) => existing.path === referencePath)) references.push({ path: referencePath, reference })
        exportedPath = portableRelative(evidenceDirectory, referencePath)
      }
      const verdict = evidence.result.verdict as 'SAME' | 'DIFF'
      services.push({
        model,
        service: result.service,
        serviceHash: serviceHash(result.service),
        peerId: result.peerId,
        displayName: result.displayName,
        referenceId,
        modelHash: modelHash(evidence.reference.referenceModel),
        reference: {
          referenceModel: evidence.reference.referenceModel,
          queryProfileHash: evidence.reference.queryProfileHash,
          probeCount: evidence.reference.probes.length,
          path: exportedPath,
        },
        verdict,
        verdictReason: evidence.result.verdictReason,
        stats: evidence.result.stats,
        matchVectorHash: evidence.result.matchVectorHash,
        kbfOptions: KBF_VERIFY_OPTIONS,
        passed: verdict === 'SAME',
        audit: {
          auditId: result.auditId,
          evidencePath: portableRelative(evidenceDirectory, result.evidencePath),
          evidenceHash: result.evidenceHash,
        },
      })
    }
    services.sort((left, right) => compareBigInt(left.serviceHash, right.serviceHash))
    const evidence: AgentAuditEvidenceV1 = {
      version: 2,
      kind: 'antseed-verifier-agent-audit-evidence',
      runId: input.manifest.runId,
      epoch: input.manifest.epoch,
      agentId: agentIdText,
      auditor,
      services,
      excluded: entry.excluded,
    }
    audits.push({
      agentId,
      evidence,
      evidenceHash: canonicalHashBytes32(evidence),
      evidencePath,
      results: sortServiceResults(services.map(({ serviceHash, modelHash, passed }) => ({ serviceHash, modelHash, passed }))),
      references,
      auditEvidencePaths: entry.services.map((service) => service.result.evidencePath),
    })
  }
  return { audits, excluded }
}

export async function writeAgentAuditEvidence(prepared: PreparedAgentAudit): Promise<void> {
  for (const { path, reference } of prepared.references) await writeJsonAtomic(path, reference, true)
  await writeJsonAtomic(prepared.evidencePath, prepared.evidence, true)
}

export function canonicalEvidenceBytes(evidence: AgentAuditEvidenceV1): Buffer {
  return Buffer.from(canonicalJsonStringify(evidence), 'utf8')
}

export async function readAgentAuditSubmission(path: string): Promise<AgentAuditSubmissionV1 | null> {
  const parsed = await readJsonIfExists<AgentAuditSubmissionV1>(path)
  if (parsed && (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-agent-audit-submission')) {
    throw new Error(`unsupported audit submission file: ${path}`)
  }
  return parsed
}

export async function writeAgentAuditSubmission(path: string, submission: AgentAuditSubmissionV1): Promise<void> {
  await writeJsonAtomic(path, submission)
}

function referenceFileName(referenceId: string): string {
  const match = /^(?:sha256:|0x)([0-9a-fA-F]{64})$/.exec(referenceId)
  if (!match) throw new Error(`referenceId is not a sha256 content hash: ${referenceId}`)
  return match[1]!.toLowerCase()
}

function isAgentId(value: string): boolean {
  try {
    return BigInt(value) > 0n
  } catch {
    return false
  }
}

function compareBigInt(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function portableRelative(from: string, to: string): string {
  return relative(resolve(from), resolve(to)).split(sep).join('/')
}

function validateAuditMatchesSummary(
  evidence: ProxyAuditEvidenceV1,
  result: ModelAuditSummaryV1['results'][number],
): void {
  if (normalized(evidence.target.peerId) !== normalized(result.peerId)) throw new Error('seller peer ID mismatch')
  if (normalized(evidence.target.service) !== normalized(result.service)) throw new Error('service mismatch')
  if ((evidence.target.agentId ?? null) !== (result.agentId ?? null)) throw new Error('seller agent ID mismatch')
  if (evidence.result.verdict !== result.status) throw new Error('verdict mismatch')
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
