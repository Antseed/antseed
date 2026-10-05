import { readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { StoredRequestCost } from '@antseed/node'
import {
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_SAME,
  VERIFIER_VERDICT_UNDETERMINED,
  serviceHash,
  type VerificationResultInput,
} from '@antseed/node/payments'
import { canonicalHashBytes32, canonicalJsonStringify } from '@antseed/fingerprints'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from './audit-artifacts.js'
import { writeJsonAtomic } from './atomic-files.js'
import type { ModelProbeConsensusEvidenceV1 } from './model-consensus-evidence.js'
import type { ReferenceCostEntryV1 } from './probe-bank.js'
import {
  verifyProxyAuditEvidenceFile,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditEvidenceV1,
} from './proxy-evidence.js'
import { safeServiceSlug } from './slug.js'
import type { VerificationOutcomeReasonV1 } from './outcome-reason.js'
import { asError, normalized } from './utils.js'

export interface BundleInferenceCostSourceV1 {
  requestId: string
  sellerPeerId: string
  service: string
  channelId: string | null
  source: 'buyer-validated-request-cost' | 'response-telemetry'
  costUsdMicros: string
  inputTokens: string
  outputTokens: string
  recordedAt: number | null
}

export interface ModelBundleSellerResultV1 {
  order: number
  peerId: string
  displayName: string | null
  agentId: string
  service: string
  serviceHash: string
  verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'
  verdictReason: string | null
  outcomeReason: VerificationOutcomeReasonV1 | null
  modelShareBps: number
  auditId: string
  auditEvidenceHash: string
  responseAuth: {
    verified: number
    missing: number
    invalid: number
    exchanges: Array<{
      batchIndex: number
      requestId: string | null
      status: 'verified' | 'missing' | 'invalid'
      failureReason: string | null
    }>
  }
  inferenceCostUsdMicros: string
  costSources: BundleInferenceCostSourceV1[]
}

export interface ExcludedModelBundleAuditV1 {
  peerId: string
  agentId: string | null
  service: string
  auditId: string | null
  reason: string
  outcomeReason?: VerificationOutcomeReasonV1
}

export interface ModelVerificationBundleEvidenceV1 {
  version: 1
  kind: 'antseed-model-verification-bundle'
  runId: string
  model: string
  expectedEpoch: string
  epochWindow: {
    startedAt: string
    endsAt: string
  }
  consensus: {
    evidenceHash: string
    relativeEvidencePath: string
    referenceId: string | null
    decisionRule: ModelProbeConsensusEvidenceV1['decisionRule']
    summary: ModelProbeConsensusEvidenceV1['summary']
  }
  results: ModelBundleSellerResultV1[]
  referenceCosts: Array<{
    costId: string
    referenceId: string
    cost: ReferenceCostEntryV1['cost']
  }>
  excludedAudits: ExcludedModelBundleAuditV1[]
  inferenceCostUsdMicros: string
  referenceCostUsdMicros: string
  totalAuditCostUsdMicros: string
}

export interface PreparedModelVerificationBundle {
  model: string
  evidenceHash: string
  evidencePath: string
  evidence: ModelVerificationBundleEvidenceV1
  totalAuditCostUsdMicros: bigint
  results: VerificationResultInput[]
  referenceCostIds: string[]
}

export interface RequestCostLookup {
  getRequestCost(requestId: string): StoredRequestCost | null
}

export function modelBundleEvidencePath(evidenceDir: string, runId: string, model: string): string {
  return join(evidenceDir, 'bundles', runId, `${safeServiceSlug(model)}.json`)
}

export async function prepareModelVerificationBundle(input: {
  evidenceDir: string
  manifest: VerifierRunManifestV1
  model: string
  modelSummaryPath: string
  verifierAddress: string
  requestCostLookup: RequestCostLookup
  referenceCosts: ReferenceCostEntryV1[]
  resolveAgentOwner(agentId: bigint): Promise<string>
}): Promise<PreparedModelVerificationBundle> {
  const summary = await readModelSummary(input.modelSummaryPath, input.manifest.runId, input.model)
  if (!summary.consensusEvidencePath) throw new Error(`model consensus evidence is missing for ${input.model}`)
  const consensus = await readModelConsensusEvidence(
    summary.consensusEvidencePath,
    input.manifest.runId,
    input.model,
  )
  const results: ModelBundleSellerResultV1[] = []
  const contractResults: VerificationResultInput[] = []
  const excludedAudits: ExcludedModelBundleAuditV1[] = summary.failures.map((failure) => ({
    peerId: failure.peerId,
    agentId: failure.agentId,
    service: failure.service,
    auditId: null,
    reason: failure.reason,
    ...(failure.outcomeReason ? { outcomeReason: failure.outcomeReason } : {}),
  }))
  excludedAudits.push(...summary.skipped.map((skipped) => ({
    peerId: skipped.peerId,
    agentId: skipped.agentId,
    service: skipped.service,
    auditId: skipped.auditId,
    reason: skipped.reason,
    ...(skipped.outcomeReason ? { outcomeReason: skipped.outcomeReason } : {}),
  })))
  const usedAgentServices = new Set<string>()
  const countedRequestIds = new Set<string>()

  for (const [order, result] of summary.results.entries()) {
    const excluded = (reason: string): void => {
      excludedAudits.push({
        peerId: result.peerId,
        agentId: result.agentId,
        service: result.service,
        auditId: result.auditId,
        reason,
      })
    }
    let agentId: bigint
    try {
      if (!result.agentId) throw new Error('missing seller agent ID')
      agentId = BigInt(result.agentId)
      if (agentId <= 0n) throw new Error('seller agent ID must be positive')
    } catch (error) {
      excluded(asError(error).message)
      continue
    }

    let owner: string
    try {
      owner = await input.resolveAgentOwner(agentId)
    } catch (error) {
      excluded(`unknown seller agent ${agentId}: ${asError(error).message}`)
      continue
    }
    if (normalized(owner) === normalized(input.verifierAddress)) {
      excluded(`self-audit is not allowed for seller agent ${agentId}`)
      continue
    }

    const hashedService = serviceHash(result.service)
    const duplicateKey = `${agentId}:${hashedService.toLowerCase()}`
    if (usedAgentServices.has(duplicateKey)) {
      excluded(`duplicate seller agent and service entry (${agentId}, ${hashedService})`)
      continue
    }

    let auditEvidence: ProxyAuditEvidenceV1
    try {
      auditEvidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
      validateAuditMatchesSummary(auditEvidence, result)
    } catch (error) {
      excluded(`invalid audit evidence: ${asError(error).message}`)
      continue
    }

    const sellerCosts = collectSellerInferenceCosts({
      evidence: auditEvidence,
      peerId: result.peerId,
      service: result.service,
      requestCostLookup: input.requestCostLookup,
      countedRequestIds,
    })
    const inferenceCostUsdMicros = sumMicros(sellerCosts.map((cost) => cost.costUsdMicros))
    const responseAuth = auditEvidence.exchanges.reduce((counts, exchange) => {
      counts[exchange.responseAuth.status] += 1
      counts.exchanges.push({
        batchIndex: exchange.batchIndex,
        requestId: exchange.responseAuth.requestId,
        status: exchange.responseAuth.status,
        failureReason: exchange.responseAuth.failureReason,
      })
      return counts
    }, {
      verified: 0,
      missing: 0,
      invalid: 0,
      exchanges: [] as ModelBundleSellerResultV1['responseAuth']['exchanges'],
    })
    let modelShareBps = 0
    if (result.status === 'DIFF') {
      // TODO: Replace zero with the seller's actual audited-service volume share.
      modelShareBps = 0
    }
    const verdict = verifierVerdict(result.status)
    usedAgentServices.add(duplicateKey)
    results.push({
      order,
      peerId: result.peerId,
      displayName: result.displayName,
      agentId: agentId.toString(),
      service: result.service,
      serviceHash: hashedService,
      verdict: result.status,
      verdictReason: auditEvidence.result.verdictReason,
      outcomeReason: auditEvidence.result.outcomeReason ?? result.outcomeReason ?? null,
      modelShareBps,
      auditId: result.auditId,
      auditEvidenceHash: result.evidenceHash,
      responseAuth,
      inferenceCostUsdMicros: inferenceCostUsdMicros.toString(),
      costSources: sellerCosts,
    })
    contractResults.push({ agentId, serviceHash: hashedService, verdict })
  }

  const inferenceCostUsdMicros = sumMicros(results.map((result) => result.inferenceCostUsdMicros))
  const referenceCostUsdMicros = sumMicros(input.referenceCosts.map((entry) => entry.cost.totalUsdMicros))
  const totalAuditCostUsdMicros = inferenceCostUsdMicros + referenceCostUsdMicros
  if (totalAuditCostUsdMicros > 18_446_744_073_709_551_615n) {
    throw new Error(`model bundle cost exceeds uint64: ${totalAuditCostUsdMicros}`)
  }
  const evidence: ModelVerificationBundleEvidenceV1 = {
    version: 1,
    kind: 'antseed-model-verification-bundle',
    runId: input.manifest.runId,
    model: input.model,
    expectedEpoch: input.manifest.epoch,
    epochWindow: {
      startedAt: input.manifest.epochStartedAt,
      endsAt: input.manifest.epochEndsAt,
    },
    consensus: {
      evidenceHash: canonicalHashBytes32(consensus),
      relativeEvidencePath: relative(input.evidenceDir, summary.consensusEvidencePath).split(sep).join('/'),
      referenceId: consensus.reference?.referenceId ?? null,
      decisionRule: consensus.decisionRule,
      summary: consensus.summary,
    },
    results,
    referenceCosts: input.referenceCosts.map((entry) => ({
      costId: entry.costId,
      referenceId: entry.referenceId,
      cost: entry.cost,
    })),
    excludedAudits,
    inferenceCostUsdMicros: inferenceCostUsdMicros.toString(),
    referenceCostUsdMicros: referenceCostUsdMicros.toString(),
    totalAuditCostUsdMicros: totalAuditCostUsdMicros.toString(),
  }
  if (contractResults.length > 64) {
    throw new Error(`model bundle has ${contractResults.length} results; maximum is 64`)
  }
  const evidenceHash = canonicalHashBytes32(evidence)
  return {
    model: input.model,
    evidenceHash,
    evidencePath: modelBundleEvidencePath(input.evidenceDir, input.manifest.runId, input.model),
    evidence,
    totalAuditCostUsdMicros,
    results: contractResults,
    referenceCostIds: input.referenceCosts.map((entry) => entry.costId),
  }
}

export async function writeModelVerificationBundleEvidence(
  bundle: PreparedModelVerificationBundle,
): Promise<string> {
  await writeJsonAtomic(bundle.evidencePath, bundle.evidence, true)
  return bundle.evidencePath
}

export async function readPreparedModelVerificationBundle(input: {
  evidencePath: string
  evidenceHash: string
}): Promise<PreparedModelVerificationBundle> {
  const raw = await readFile(input.evidencePath, 'utf8')
  const evidence = JSON.parse(raw) as ModelVerificationBundleEvidenceV1
  if (evidence.version !== 1 || evidence.kind !== 'antseed-model-verification-bundle') {
    throw new Error(`unsupported model bundle evidence at ${input.evidencePath}`)
  }
  if (raw !== canonicalJsonStringify(evidence)) {
    throw new Error(`model bundle evidence is not canonical JSON at ${input.evidencePath}`)
  }
  const evidenceHash = canonicalHashBytes32(evidence)
  if (evidenceHash.toLowerCase() !== input.evidenceHash.toLowerCase()) {
    throw new Error(`model bundle evidence hash mismatch at ${input.evidencePath}`)
  }
  const results = evidence.results.map((result) => ({
    agentId: BigInt(result.agentId),
    serviceHash: result.serviceHash,
    verdict: verifierVerdict(result.verdict),
  }))
  return {
    model: evidence.model,
    evidenceHash,
    evidencePath: input.evidencePath,
    evidence,
    totalAuditCostUsdMicros: BigInt(evidence.totalAuditCostUsdMicros),
    results,
    referenceCostIds: evidence.referenceCosts.map((entry) => entry.costId),
  }
}

function collectSellerInferenceCosts(input: {
  evidence: ProxyAuditEvidenceV1
  peerId: string
  service: string
  requestCostLookup: RequestCostLookup
  countedRequestIds: Set<string>
}): BundleInferenceCostSourceV1[] {
  const costs: BundleInferenceCostSourceV1[] = []
  for (const exchange of input.evidence.exchanges) {
    let successfulRequestHasReceipt = false
    for (const requestId of exchange.requestIds) {
      if (input.countedRequestIds.has(requestId)) continue
      const stored = input.requestCostLookup.getRequestCost(requestId)
      if (!stored) continue
      if (normalized(stored.sellerPeerId) !== normalized(input.peerId)
        || normalized(stored.service) !== normalized(input.service)) continue
      input.countedRequestIds.add(requestId)
      if (requestId === exchange.responseAuth.requestId) successfulRequestHasReceipt = true
      costs.push(storedCostSource(stored))
    }
    if (exchange.status !== 'succeeded' || !exchange.cost || successfulRequestHasReceipt) continue
    const requestId = exchange.responseAuth.requestId ?? exchange.requestIds.at(-1)
    if (!requestId || input.countedRequestIds.has(requestId)) continue
    input.countedRequestIds.add(requestId)
    costs.push(telemetryCostSource(requestId, input.peerId, input.service, exchange))
  }
  return costs
}

function storedCostSource(cost: StoredRequestCost): BundleInferenceCostSourceV1 {
  return {
    requestId: cost.requestId,
    sellerPeerId: cost.sellerPeerId,
    service: cost.service,
    channelId: cost.channelId,
    source: 'buyer-validated-request-cost',
    costUsdMicros: cost.authorizedCostUsdc.toString(),
    inputTokens: cost.inputTokens.toString(),
    outputTokens: cost.outputTokens.toString(),
    recordedAt: cost.recordedAt,
  }
}

function telemetryCostSource(
  requestId: string,
  peerId: string,
  service: string,
  exchange: ProxyAuditEvidenceExchangeV1,
): BundleInferenceCostSourceV1 {
  return {
    requestId,
    sellerPeerId: peerId,
    service,
    channelId: null,
    source: 'response-telemetry',
    costUsdMicros: String(Math.ceil(exchange.cost!.estimatedCostUsd * 1_000_000)),
    inputTokens: String(exchange.cost!.inputTokens),
    outputTokens: String(exchange.cost!.outputTokens),
    recordedAt: exchange.timing.completedAt,
  }
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

async function readModelConsensusEvidence(
  path: string,
  runId: string,
  model: string,
): Promise<ModelProbeConsensusEvidenceV1> {
  const bytes = await readFile(path)
  const parsed = JSON.parse(bytes.toString('utf8')) as ModelProbeConsensusEvidenceV1
  if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-model-probe-consensus') {
    throw new Error(`invalid model consensus evidence: ${path}`)
  }
  if (parsed.runId !== runId || normalized(parsed.model) !== normalized(model)) {
    throw new Error(`model consensus evidence does not belong to run ${runId}: ${path}`)
  }
  const canonical = Buffer.from(canonicalJsonStringify(parsed))
  if (!bytes.equals(canonical)) throw new Error(`model consensus evidence is not canonical JSON: ${path}`)
  return parsed
}

function verifierVerdict(verdict: ModelBundleSellerResultV1['verdict']): 1 | 2 | 3 {
  if (verdict === 'SAME') return VERIFIER_VERDICT_SAME
  if (verdict === 'DIFF') return VERIFIER_VERDICT_DIFF
  return VERIFIER_VERDICT_UNDETERMINED
}

function sumMicros(values: readonly string[]): bigint {
  return values.reduce((total, value) => {
    const parsed = BigInt(value)
    if (parsed < 0n) throw new Error(`negative USD micro-cost: ${value}`)
    return total + parsed
  }, 0n)
}
