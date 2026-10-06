import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { getAddress, type AbstractSigner, type TypedDataDomain } from 'ethers'
import {
  canonicalHashBytes32,
  canonicalJsonStringify,
  validateKbfReferenceV1,
  type FingerprintStats,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { StoredRequestCost } from '@antseed/node'
import {
  SERVICE_MODEL_MATCH,
  SERVICE_PRICE_MATCH,
  SERVICE_UNDETERMINED,
  hashServiceResults,
  serviceHash,
  signAuditReport,
  sortServiceResults,
  type AuditReportInput,
  type ServiceResultInput,
} from '@antseed/node/payments'
import type { VerifierCLIConfig } from '../config/types.js'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from './audit-artifacts.js'
import { writeJsonAtomic } from './atomic-files.js'
import { findEpochProbeReference } from './probe-bank.js'
import {
  verifyProxyAuditEvidenceFile,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditEvidenceV1,
} from './proxy-evidence.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import { safeServiceSlug } from './slug.js'
import { asError, normalized } from './utils.js'

/** AntseedVerification.MAX_SERVICES_PER_REPORT. */
export const MAX_SERVICES_PER_REPORT = 64
/** AntseedVerification.maxReportAge default; older reports revert with StaleReport. */
export const MAX_REPORT_AGE_SECONDS = 3 * 24 * 60 * 60
/** Authorized cost may exceed advertised price x tokens by 1% plus 1 micro-USDC of rounding. */
export const PRICE_TOLERANCE_BPS = 100n
export const PRICE_TOLERANCE_MICROS = 1n
/** Options every audit passes to verifyKbf (see verifyModelTarget). */
export const KBF_VERIFY_OPTIONS = { minCoverage: 1 } as const

export type ServiceVerdict = 'SAME' | 'DIFF' | 'UNDETERMINED'

export interface RequestCostLookup {
  getRequestCost(requestId: string): StoredRequestCost | null
}

/** A buyer `request_costs` row, copied into the evidence so verifiers can recompute the price check. */
export interface RecordedRequestCostV1 {
  requestId: string
  sellerPeerId: string
  service: string
  channelId: string
  source: StoredRequestCost['source']
  authorizedCostUsdc: string
  inputTokens: string
  outputTokens: string
  recordedAt: number
}

export interface AdvertisedPricingV1 {
  inputUsdPerMillion: number
  outputUsdPerMillion: number
}

export interface PriceCheckRequestV1 {
  batchIndex: number
  requestId: string
  cost: RecordedRequestCostV1 | null
  advertised: AdvertisedPricingV1 | null
  expectedCostUsdMicros: string | null
  allowedCostUsdMicros: string | null
  passed: boolean
  reason: string | null
}

export interface PriceCheckV1 {
  rule: 'authorized-cost-within-advertised-price-v1'
  toleranceBps: number
  toleranceMicros: string
  advertised: AdvertisedPricingV1 | null
  requests: PriceCheckRequestV1[]
  inferenceCostUsdMicros: string
  passed: boolean
  reason: string | null
}

export interface AuditedServicePricingV1 {
  serviceHash: string
  service: string
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
}

export interface AgentServiceEvidenceV1 {
  model: string
  service: string
  serviceHash: string
  peerId: string
  displayName: string | null
  referenceId: string
  referenceIdBytes32: string
  reference: {
    referenceModel: string
    queryProfileHash: string
    probeCount: number
    /** Full KBF reference, relative to the evidence document; null when the auditor could not export it. */
    path: string | null
    uri: string | null
  }
  verdict: ServiceVerdict
  verdictReason: string | null
  stats: FingerprintStats
  matchVectorHash: string
  kbfOptions: typeof KBF_VERIFY_OPTIONS
  flags: number
  audit: {
    auditId: string
    /** Proxy audit evidence file, relative to the evidence document. */
    evidencePath: string
    evidenceHash: string
  }
  priceCheck: PriceCheckV1
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
  version: 1
  kind: 'antseed-verifier-agent-audit-evidence'
  runId: string
  epoch: string
  agentId: string
  auditor: string
  metadata: {
    /**
     * Interim: the run does not capture the seller's signed peer metadata, so the report's
     * metadataHash commits to the audited services and their advertised prices instead.
     * Replace with the signed metadata hash once service metadata is on-chain (#176).
     */
    source: 'audited-service-pricing-v1'
    hash: string
    services: AuditedServicePricingV1[]
  }
  services: AgentServiceEvidenceV1[]
  excluded: ExcludedServiceAuditV1[]
  inferenceCostUsdMicros: string
}

export interface ReportPublicationV1 {
  provider: 'pinata'
  evidenceHash: string
  cid: string
  uri: string
  pinSize: number
  totalBytes: number
  fileCount: number
  publishedAt: string
}

export interface AuditReportFileV1 {
  version: 1
  kind: 'antseed-verifier-audit-report'
  runId: string
  auditor: string
  chainId: string
  contract: string
  report: {
    agentId: string
    metadataHash: string
    evidenceHash: string
    resultsHash: string
    auditedAt: string
  }
  results: ServiceResultInput[]
  evidenceHash: string
  /** Evidence document, relative to this report file. */
  evidencePath: string
  /** Optional public evidence location submitted on-chain alongside the report. */
  evidenceUri: string
  publication?: ReportPublicationV1
  signature: string
}

export interface PreparedAgentAuditReport {
  agentId: bigint
  evidence: AgentAuditEvidenceV1
  evidenceHash: string
  evidencePath: string
  metadataHash: string
  results: ServiceResultInput[]
  resultsHash: string
  references: Array<{ path: string; reference: KbfReferenceV1 }>
  auditEvidencePaths: string[]
}

export function reportsDirectory(evidenceDir: string, runId: string): string {
  return join(evidenceDir, 'reports', safeServiceSlug(runId))
}

export function auditReportPath(evidenceDir: string, runId: string, agentId: bigint | string): string {
  return join(reportsDirectory(evidenceDir, runId), `${String(agentId)}.report.json`)
}

export function agentEvidencePath(evidenceDir: string, runId: string, agentId: bigint | string): string {
  return join(reportsDirectory(evidenceDir, runId), `${String(agentId)}.evidence.json`)
}

/** On-chain bytes32 form of a content-addressed KBF referenceId (`sha256:<hex>`). */
export function referenceIdBytes32(referenceId: string): string {
  const prefixed = /^sha256:([0-9a-f]{64})$/.exec(referenceId)
  if (prefixed) return `0x${prefixed[1]}`
  if (/^0x[0-9a-fA-F]{64}$/.test(referenceId)) return referenceId.toLowerCase()
  throw new Error(`referenceId is not a sha256 content hash: ${referenceId}`)
}

export function serviceFlags(verdict: ServiceVerdict, priceMatch: boolean): number {
  return (verdict === 'SAME' ? SERVICE_MODEL_MATCH : 0)
    | (verdict === 'UNDETERMINED' ? SERVICE_UNDETERMINED : 0)
    | (priceMatch ? SERVICE_PRICE_MATCH : 0)
}

export function formatServiceFlags(flags: number): string {
  const names = [
    flags & SERVICE_MODEL_MATCH ? 'MODEL' : null,
    flags & SERVICE_PRICE_MATCH ? 'PRICE' : null,
    flags & SERVICE_UNDETERMINED ? 'UNDET' : null,
  ].filter((name): name is string => name !== null)
  return names.length > 0 ? names.join('+') : '-'
}

export function recordedRequestCost(cost: StoredRequestCost): RecordedRequestCostV1 {
  return {
    requestId: cost.requestId,
    sellerPeerId: cost.sellerPeerId,
    service: cost.service,
    channelId: cost.channelId,
    source: cost.source,
    authorizedCostUsdc: cost.authorizedCostUsdc.toString(),
    inputTokens: cost.inputTokens.toString(),
    outputTokens: cost.outputTokens.toString(),
    recordedAt: cost.recordedAt,
  }
}

export function exchangeAdvertisedPricing(exchange: ProxyAuditEvidenceExchangeV1): AdvertisedPricingV1 | null {
  const cost = exchange.cost ?? exchange.attemptCosts?.at(-1) ?? null
  if (!cost || !isPrice(cost.inputUsdPerMillion) || !isPrice(cost.outputUsdPerMillion)) return null
  return { inputUsdPerMillion: cost.inputUsdPerMillion, outputUsdPerMillion: cost.outputUsdPerMillion }
}

/**
 * Checks that every authorized request cost stays within the seller's advertised price for the
 * recorded tokens. Deterministic in its inputs, so verifiers recompute it from the evidence.
 */
export function evaluatePriceCheck(
  evidence: ProxyAuditEvidenceV1,
  lookup: (requestId: string) => RecordedRequestCostV1 | null,
): PriceCheckV1 {
  const requests: PriceCheckRequestV1[] = []
  const seen = new Set<string>()
  let succeeded = 0
  let advertised: AdvertisedPricingV1 | null = null
  let inferenceCost = 0n
  for (const exchange of evidence.exchanges) {
    const pricing = exchangeAdvertisedPricing(exchange)
    advertised ??= pricing
    const successfulRequestId = exchange.status === 'succeeded'
      ? exchange.responseAuth.requestId ?? exchange.requestIds.at(-1) ?? null
      : null
    if (exchange.status === 'succeeded') {
      succeeded += 1
      if (!successfulRequestId) {
        requests.push(failedRequest(exchange.batchIndex, '', null, pricing, 'successful exchange has no request ID'))
      }
    }
    for (const requestId of exchange.requestIds) {
      if (seen.has(requestId)) continue
      seen.add(requestId)
      const cost = lookup(requestId)
      if (!cost) {
        if (requestId === successfulRequestId) {
          requests.push(failedRequest(exchange.batchIndex, requestId, null, pricing, 'request cost record is missing'))
        }
        continue
      }
      if (normalizedPeer(cost.sellerPeerId) !== normalizedPeer(evidence.target.peerId)) {
        requests.push(failedRequest(exchange.batchIndex, requestId, cost, pricing, 'request cost belongs to another seller'))
        continue
      }
      if (cost.service && normalized(cost.service) !== normalized(evidence.target.service)) {
        requests.push(failedRequest(exchange.batchIndex, requestId, cost, pricing, 'request cost belongs to another service'))
        continue
      }
      inferenceCost += nonNegativeBigInt(cost.authorizedCostUsdc)
      if (!pricing) {
        requests.push(failedRequest(exchange.batchIndex, requestId, cost, null, 'advertised price is missing'))
        continue
      }
      // USD per million tokens x tokens = micro-USD; round away float noise before taking the ceiling.
      const expectedMicros = Number(nonNegativeBigInt(cost.inputTokens)) * pricing.inputUsdPerMillion
        + Number(nonNegativeBigInt(cost.outputTokens)) * pricing.outputUsdPerMillion
      const expected = BigInt(Math.ceil(Math.round(expectedMicros * 1_000_000) / 1_000_000))
      const allowed = expected + (expected * PRICE_TOLERANCE_BPS + 9_999n) / 10_000n + PRICE_TOLERANCE_MICROS
      const passed = nonNegativeBigInt(cost.authorizedCostUsdc) <= allowed
      requests.push({
        batchIndex: exchange.batchIndex,
        requestId,
        cost,
        advertised: pricing,
        expectedCostUsdMicros: expected.toString(),
        allowedCostUsdMicros: allowed.toString(),
        passed,
        reason: passed ? null : `authorized ${cost.authorizedCostUsdc} exceeds allowed ${allowed} micro-USDC`,
      })
    }
  }
  const firstFailure = requests.find((request) => !request.passed)
  const reason = succeeded === 0
    ? 'no successful exchanges to price'
    : firstFailure
      ? `batch ${firstFailure.batchIndex}${firstFailure.requestId ? ` (${firstFailure.requestId})` : ''}: ${firstFailure.reason}`
      : requests.length === 0 ? 'no request cost records' : null
  return {
    rule: 'authorized-cost-within-advertised-price-v1',
    toleranceBps: Number(PRICE_TOLERANCE_BPS),
    toleranceMicros: PRICE_TOLERANCE_MICROS.toString(),
    advertised,
    requests,
    inferenceCostUsdMicros: inferenceCost.toString(),
    passed: reason === null,
    reason,
  }
}

export function auditedServicePricing(services: readonly AgentServiceEvidenceV1[]): AuditedServicePricingV1[] {
  return services
    .map((service) => ({
      serviceHash: service.serviceHash,
      service: normalized(service.service),
      inputUsdPerMillion: service.priceCheck.advertised?.inputUsdPerMillion ?? null,
      outputUsdPerMillion: service.priceCheck.advertised?.outputUsdPerMillion ?? null,
    }))
    .sort((left, right) => compareHex(left.serviceHash, right.serviceHash))
}

/**
 * Interim metadataHash until service metadata is on-chain (#176): the canonical hash of the
 * audited services and their advertised prices. Independent auditors of the same seller derive
 * the same value, which the quorum requires.
 */
export function auditedServicesMetadataHash(agentId: bigint | string, services: readonly AuditedServicePricingV1[]): string {
  return canonicalHashBytes32({
    domain: 'antseed-audited-service-pricing-v1',
    agentId: String(agentId),
    services,
  })
}

export async function prepareAgentAuditReports(input: {
  evidenceDir: string
  banksDir: string
  manifest: VerifierRunManifestV1
  auditor: string
  requestCostLookup: RequestCostLookup
  resolveAgentOwner(agentId: bigint): Promise<string>
  config?: VerifierCLIConfig
}): Promise<{ reports: PreparedAgentAuditReport[]; excluded: ExcludedServiceAuditV1[] }> {
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

  for (const model of input.manifest.modelOrder) {
    const modelManifest = input.manifest.models.find((entry) => normalized(entry.model) === normalized(model))
    if (!modelManifest) throw new Error(`run manifest is missing the model summary for ${model}`)
    const summary = await readModelSummary(modelManifest.summaryPath, input.manifest.runId, model)
    for (const entry of [...summary.failures, ...summary.skipped]) {
      const exclusion: ExcludedServiceAuditV1 = {
        model,
        peerId: entry.peerId,
        agentId: entry.agentId,
        service: entry.service,
        auditId: 'auditId' in entry ? entry.auditId : null,
        reason: entry.reason,
      }
      if (entry.agentId && isAgentId(entry.agentId)) group(BigInt(entry.agentId).toString()).excluded.push(exclusion)
      else excluded.push(exclusion)
    }
    for (const result of summary.results) {
      const exclude = (reason: string, agentId: string | null = result.agentId): void => {
        const exclusion = { model, peerId: result.peerId, agentId, service: result.service, auditId: result.auditId, reason }
        if (agentId && isAgentId(agentId)) group(BigInt(agentId).toString()).excluded.push(exclusion)
        else excluded.push(exclusion)
      }
      if (!result.agentId || !isAgentId(result.agentId)) {
        exclude('missing or invalid seller agent ID', null)
        continue
      }
      let evidence: ProxyAuditEvidenceV1
      try {
        evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
        validateAuditMatchesSummary(evidence, result)
      } catch (error) {
        exclude(`invalid audit evidence: ${asError(error).message}`)
        continue
      }
      const agentId = BigInt(result.agentId).toString()
      const hashed = serviceHash(result.service)
      const entry = group(agentId)
      if (entry.services.some((service) => serviceHash(service.result.service) === hashed)) {
        exclude(`duplicate audited service ${result.service}`)
        continue
      }
      entry.services.push({ model, result, evidence })
    }
  }

  const sizing = resolveReferenceSizingPolicy(input.config)
  const reports: PreparedAgentAuditReport[] = []
  for (const [agentIdText, entry] of [...groups.entries()].sort(([left], [right]) => compareBigInt(left, right))) {
    const agentId = BigInt(agentIdText)
    const skipAgent = (reason: string): void => {
      for (const service of entry.services) {
        excluded.push({
          model: service.model,
          peerId: service.result.peerId,
          agentId: agentIdText,
          service: service.result.service,
          auditId: service.result.auditId,
          reason,
        })
      }
      excluded.push(...entry.excluded)
    }
    if (entry.services.length === 0) {
      excluded.push(...entry.excluded)
      continue
    }
    if (entry.services.length > MAX_SERVICES_PER_REPORT) {
      skipAgent(`agent ${agentIdText} has ${entry.services.length} audited services; maximum is ${MAX_SERVICES_PER_REPORT}`)
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
    const references: PreparedAgentAuditReport['references'] = []
    const services: AgentServiceEvidenceV1[] = []
    for (const { model, result, evidence } of entry.services) {
      const referenceId = evidence.reference.referenceId
      const referencePath = join(evidenceDirectory, 'references', `${referenceIdBytes32(referenceId).slice(2)}.json`)
      let exportedPath: string | null = null
      const located = await findEpochProbeReference(input.banksDir, referenceId)
      if (located) {
        const reference = validateKbfReferenceV1(located, { minimumStatisticalPower: sizing.minimumStatisticalPower })
        if (!references.some((existing) => existing.path === referencePath)) references.push({ path: referencePath, reference })
        exportedPath = portableRelative(evidenceDirectory, referencePath)
      }
      const priceCheck = evaluatePriceCheck(evidence, (requestId) => {
        const stored = input.requestCostLookup.getRequestCost(requestId)
        return stored ? recordedRequestCost(stored) : null
      })
      services.push({
        model,
        service: result.service,
        serviceHash: serviceHash(result.service),
        peerId: result.peerId,
        displayName: result.displayName,
        referenceId,
        referenceIdBytes32: referenceIdBytes32(referenceId),
        reference: {
          referenceModel: evidence.reference.referenceModel,
          queryProfileHash: evidence.reference.queryProfileHash,
          probeCount: evidence.reference.probes.length,
          path: exportedPath,
          uri: null,
        },
        verdict: evidence.result.verdict,
        verdictReason: evidence.result.verdictReason,
        stats: evidence.result.stats,
        matchVectorHash: evidence.result.matchVectorHash,
        kbfOptions: KBF_VERIFY_OPTIONS,
        flags: serviceFlags(evidence.result.verdict, priceCheck.passed),
        audit: {
          auditId: result.auditId,
          evidencePath: portableRelative(evidenceDirectory, result.evidencePath),
          evidenceHash: result.evidenceHash,
        },
        priceCheck,
      })
    }
    services.sort((left, right) => compareHex(left.serviceHash, right.serviceHash))
    const pricing = auditedServicePricing(services)
    const metadataHash = auditedServicesMetadataHash(agentId, pricing)
    const evidence: AgentAuditEvidenceV1 = {
      version: 1,
      kind: 'antseed-verifier-agent-audit-evidence',
      runId: input.manifest.runId,
      epoch: input.manifest.epoch,
      agentId: agentIdText,
      auditor,
      metadata: { source: 'audited-service-pricing-v1', hash: metadataHash, services: pricing },
      services,
      excluded: entry.excluded,
      inferenceCostUsdMicros: services
        .reduce((total, service) => total + BigInt(service.priceCheck.inferenceCostUsdMicros), 0n)
        .toString(),
    }
    const results = sortServiceResults(services.map((service) => ({
      serviceHash: service.serviceHash,
      referenceId: service.referenceIdBytes32,
      flags: service.flags,
    })))
    reports.push({
      agentId,
      evidence,
      evidenceHash: canonicalHashBytes32(evidence),
      evidencePath,
      metadataHash,
      results,
      resultsHash: hashServiceResults(results),
      references,
      auditEvidencePaths: entry.services.map((service) => service.result.evidencePath),
    })
  }
  return { reports, excluded }
}

export async function writeAgentAuditEvidence(prepared: PreparedAgentAuditReport): Promise<void> {
  for (const { path, reference } of prepared.references) await writeJsonAtomic(path, reference, true)
  await writeJsonAtomic(prepared.evidencePath, prepared.evidence, true)
}

export async function signAgentAuditReport(input: {
  prepared: PreparedAgentAuditReport
  signer: AbstractSigner
  domain: TypedDataDomain
  runId: string
  auditedAt: bigint
  reportPath: string
  evidenceUri?: string
  publication?: ReportPublicationV1
}): Promise<AuditReportFileV1> {
  if (input.domain.chainId === undefined || input.domain.chainId === null || !input.domain.verifyingContract) {
    throw new Error('audit report domain requires a chain ID and verifying contract')
  }
  const report: AuditReportInput = {
    agentId: input.prepared.agentId,
    metadataHash: input.prepared.metadataHash,
    evidenceHash: input.prepared.evidenceHash,
    resultsHash: input.prepared.resultsHash,
    auditedAt: input.auditedAt,
  }
  const signature = await signAuditReport(input.signer, input.domain, report)
  return {
    version: 1,
    kind: 'antseed-verifier-audit-report',
    runId: input.runId,
    auditor: getAddress(await input.signer.getAddress()),
    chainId: BigInt(input.domain.chainId).toString(),
    contract: getAddress(input.domain.verifyingContract),
    report: {
      agentId: report.agentId.toString(),
      metadataHash: report.metadataHash,
      evidenceHash: report.evidenceHash,
      resultsHash: report.resultsHash,
      auditedAt: report.auditedAt.toString(),
    },
    results: input.prepared.results,
    evidenceHash: input.prepared.evidenceHash,
    evidencePath: portableRelative(dirname(input.reportPath), input.prepared.evidencePath),
    evidenceUri: input.evidenceUri ?? '',
    ...(input.publication ? { publication: input.publication } : {}),
    signature,
  }
}

export async function writeAuditReportFile(path: string, file: AuditReportFileV1): Promise<void> {
  await writeJsonAtomic(path, file)
}

export async function readAuditReportFile(path: string): Promise<AuditReportFileV1> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as AuditReportFileV1
  if (parsed?.version !== 1 || parsed.kind !== 'antseed-verifier-audit-report') {
    throw new Error(`unsupported audit report file: ${path}`)
  }
  return parsed
}

export function auditReportInput(file: AuditReportFileV1): AuditReportInput {
  return {
    agentId: BigInt(file.report.agentId),
    metadataHash: file.report.metadataHash,
    evidenceHash: file.report.evidenceHash,
    resultsHash: file.report.resultsHash,
    auditedAt: BigInt(file.report.auditedAt),
  }
}

export function resolveReportEvidencePath(reportPath: string, file: AuditReportFileV1): string {
  return resolve(dirname(reportPath), file.evidencePath)
}

export function canonicalEvidenceBytes(evidence: AgentAuditEvidenceV1): Buffer {
  return Buffer.from(canonicalJsonStringify(evidence), 'utf8')
}

export function normalizedPeer(peerId: string): string {
  const value = normalized(peerId)
  return value.startsWith('0x') ? value.slice(2) : value
}

export function compareHex(left: string, right: string): number {
  const a = BigInt(left)
  const b = BigInt(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function failedRequest(
  batchIndex: number,
  requestId: string,
  cost: RecordedRequestCostV1 | null,
  advertised: AdvertisedPricingV1 | null,
  reason: string,
): PriceCheckRequestV1 {
  return {
    batchIndex,
    requestId,
    cost,
    advertised,
    expectedCostUsdMicros: null,
    allowedCostUsdMicros: null,
    passed: false,
    reason,
  }
}

function nonNegativeBigInt(value: string): bigint {
  const parsed = BigInt(value)
  if (parsed < 0n) throw new Error(`negative amount: ${value}`)
  return parsed
}

function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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
