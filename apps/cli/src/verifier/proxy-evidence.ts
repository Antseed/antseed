import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalHashBytes32,
  canonicalJsonStringify,
  type FingerprintStats,
  type FingerprintVerdict,
  type KbfProbe,
  type MatchVector,
  type ReferenceQueryProfileV1,
} from '@antseed/fingerprints'
import type { StoredResponseAuth } from '@antseed/node'
import type { VerificationOutcomeReasonV1 } from './outcome-reason.js'
import { safeServiceSlug } from './slug.js'

export type ExportedResponseAuthRecord = Omit<StoredResponseAuth, 'requestPreimage' | 'responsePreimage'>

export interface SignedResponseAuthPreimagesV1 {
  encoding: 'antseed-http-codec-v1'
  signatureEncoding: 'antseed-response-auth-signing-v1'
  hashAlgorithm: 'keccak256'
  requestBase64: string
  responseBase64: string
  responseAuthSigningBase64: string
  requestHash: string
  responseHash: string
}

export interface ProxyAuditEvidenceExchange {
  batchIndex: number
  attemptCount: number
  requestIds: string[]
  probeIds: string[]
  request: {
    method: 'POST'
    url: string
    headers: Record<string, string>
    bodyBase64: string
    hash: string
  }
  response: {
    statusCode: number
    headers: Record<string, string>
    bodyBase64: string
    hash: string
  } | null
  timing: {
    startedAt: number
    completedAt: number
    responseLatencyMs: number
  }
  answers: Array<number | null>
  matches: MatchVector
  status: 'succeeded' | 'failed'
  failureReason: string | null
}

export interface ProxyAuditEvidenceExchangeV1 extends ProxyAuditEvidenceExchange {
  cost: ProxyAuditExchangeCostV1 | null
  attemptCosts?: ProxyAuditExchangeCostV1[]
  outcomeReason?: VerificationOutcomeReasonV1 | null
  responseAuth: {
    requestId: string | null
    status: 'verified' | 'missing' | 'invalid'
    record: ExportedResponseAuthRecord | null
    signedPreimages: SignedResponseAuthPreimagesV1 | null
    failureReason: string | null
  }
}

export interface ProxyAuditExchangeCostV1 {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  estimatedCostUsd: number
  tokenSource: string | null
  provider: string | null
  service: string | null
}

export interface AuditCostSummaryV1 {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUsd: number
  pricedExchangeCount: number
  missingCostExchangeCount: number
}

export type VerificationSkipCode =
  | 'missing_response_auth'
  | 'reputation_below_minimum'
  | 'price_above_maximum'
  | 'policy_rejected'
  | 'stale_model_advertisement'
  | 'upstream_credentials_invalid'
  | 'request_profile_incompatible'

export interface ProxyAuditSkipEvidenceV1 {
  version: 1
  kind: 'antseed-buyer-proxy-target-skip'
  evidenceLevel: 'proxy-observation-no-payment-evidence'
  createdAt: string
  buyerProxy: {
    baseUrl: string
    statePath: string
    pid: number
  }
  target: {
    peerId: string
    displayName: string | null
    agentId: string | null
    service: string
  }
  reference: {
    referenceId: string
    referenceModel: string
  }
  exchange: ProxyAuditEvidenceExchangeV1
  result: {
    status: 'SKIPPED'
    code: VerificationSkipCode
    reason: string
    outcomeReason?: VerificationOutcomeReasonV1
  }
}

export interface ProxyAuditEvidenceV1 {
  version: 1
  kind: 'antseed-buyer-proxy-kbf-audit'
  evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence'
  createdAt: string
  buyerProxy: {
    baseUrl: string
    statePath: string
    pid: number
  }
  target: {
    peerId: string
    displayName: string | null
    agentId: string | null
    service: string
  }
  reference: {
    referenceId: string
    referenceModel: string
    queryProfileHash: string
    queryProfile: ReferenceQueryProfileV1
    statisticalPower: number
    statisticalPowerEvidence: Record<string, unknown>
    selfTest: {
      hamming: number
      total: number
      coverage: number
      errorRate: number
      outcomes?: Array<{ probeId: string; answer: number | null; match: 0 | 1 | null }>
    }
    probes: KbfProbe[]
  }
  exchanges: ProxyAuditEvidenceExchangeV1[]
  resume?: {
    parentAuditId: string
    reservationAuditId?: string
    parentEvidenceHash: string
    reusedBatchIndexes: number[]
  }
  result: {
    selectedProbeCount: number
    parsedProbeCount: number
    matchVector: MatchVector
    matchVectorHash: string
    stats: FingerprintStats
    verdict: Exclude<FingerprintVerdict, 'UNKNOWN'>
    verdictReason: string | null
    outcomeReason?: VerificationOutcomeReasonV1 | null
    cost: AuditCostSummaryV1
    cumulativeCost?: AuditCostSummaryV1
  }
}

interface ProxyAuditEvidencePackManifestV1 {
  version: 1
  kind: 'antseed-verifier-evidence-pack'
  auditId: string
  createdAt: string
  evidenceHash: string
  evidenceLevel: ProxyAuditEvidenceV1['evidenceLevel']
  scope: {
    responseAuthentication: 'seller-signed-response-auth'
    exactSignedPreimages: boolean
    paymentEvidence: false
    onChainInclusionProof: false
  }
  files: Array<{
    path: string
    hash: string
    purpose: string
  }>
}

export function emptyAuditCostSummary(): AuditCostSummaryV1 {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    pricedExchangeCount: 0,
    missingCostExchangeCount: 0,
  }
}

export function addAuditCostSummaries(...summaries: AuditCostSummaryV1[]): AuditCostSummaryV1 {
  return summaries.reduce((total, summary) => ({
    inputTokens: total.inputTokens + summary.inputTokens,
    outputTokens: total.outputTokens + summary.outputTokens,
    totalTokens: total.totalTokens + summary.totalTokens,
    estimatedCostUsd: total.estimatedCostUsd + summary.estimatedCostUsd,
    pricedExchangeCount: total.pricedExchangeCount + summary.pricedExchangeCount,
    missingCostExchangeCount: total.missingCostExchangeCount + summary.missingCostExchangeCount,
  }), emptyAuditCostSummary())
}

export function summarizeAuditExchangeCosts(
  exchanges: ProxyAuditEvidenceExchangeV1[],
): AuditCostSummaryV1 {
  const priced = exchanges.flatMap((exchange) => exchange.attemptCosts ?? (exchange.cost ? [exchange.cost] : []))
  return {
    inputTokens: priced.reduce((total, cost) => total + cost.inputTokens, 0),
    outputTokens: priced.reduce((total, cost) => total + cost.outputTokens, 0),
    totalTokens: priced.reduce((total, cost) => total + cost.totalTokens, 0),
    estimatedCostUsd: priced.reduce((total, cost) => total + cost.estimatedCostUsd, 0),
    pricedExchangeCount: priced.length,
    missingCostExchangeCount: exchanges.length - priced.length,
  }
}

export function parseProxyAuditExchangeCost(
  headers: Record<string, string>,
): ProxyAuditExchangeCostV1 | null {
  const inputTokens = parseNonNegativeInteger(headers['x-antseed-input-tokens'])
  const outputTokens = parseNonNegativeInteger(headers['x-antseed-output-tokens'])
  const totalTokens = parseNonNegativeInteger(headers['x-antseed-total-tokens'])
  const inputUsdPerMillion = parseNonNegativeNumber(headers['x-antseed-input-usd-per-million'])
  const outputUsdPerMillion = parseNonNegativeNumber(headers['x-antseed-output-usd-per-million'])
  const estimatedCostUsd = parseNonNegativeNumber(headers['x-antseed-estimated-cost-usd'])
  if (
    inputTokens === null
    || outputTokens === null
    || totalTokens === null
    || inputUsdPerMillion === null
    || outputUsdPerMillion === null
    || estimatedCostUsd === null
  ) return null
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputUsdPerMillion,
    outputUsdPerMillion,
    estimatedCostUsd,
    tokenSource: nonEmptyHeader(headers['x-antseed-token-source']),
    provider: nonEmptyHeader(headers['x-antseed-provider']),
    service: nonEmptyHeader(headers['x-antseed-service']),
  }
}

export function proxyAuditEvidenceHash(evidence: ProxyAuditEvidenceV1): string {
  return canonicalHashBytes32(evidence)
}

export function deriveProxyAuditId(input: {
  targetPeerId: string
  referenceId: string
  completedAt: number
  evidenceHash: string
}): string {
  return canonicalHashBytes32({
    domain: 'antseed-buyer-proxy-audit-id-v1',
    targetPeerId: input.targetPeerId.toLowerCase(),
    referenceId: input.referenceId,
    completedAt: input.completedAt,
    evidenceHash: input.evidenceHash.toLowerCase(),
  })
}

export async function writeProxyAuditEvidence(
  evidenceDir: string,
  auditId: string,
  evidence: ProxyAuditEvidenceV1,
): Promise<{ path: string; evidenceHash: string }> {
  const evidenceHash = proxyAuditEvidenceHash(evidence)
  const packDirectory = join(evidenceDir, safeServiceSlug(evidence.target.peerId))
  const exchangesDirectory = join(packDirectory, 'exchanges')
  await mkdir(exchangesDirectory, { recursive: true })
  const path = join(packDirectory, 'evidence.json')
  const writtenFiles: ProxyAuditEvidencePackManifestV1['files'] = []
  writtenFiles.push(await writeEvidencePackJson(path, evidence, 'Canonical complete audit evidence'))
  for (const exchange of evidence.exchanges) {
    const exchangePath = join('exchanges', `${String(exchange.batchIndex).padStart(3, '0')}.json`)
    writtenFiles.push(await writeEvidencePackJson(
      join(packDirectory, exchangePath),
      exchange,
      `Captured batch ${exchange.batchIndex} with seller-signed ResponseAuth and exact P2P preimages`,
      exchangePath,
    ))
  }
  const manifest: ProxyAuditEvidencePackManifestV1 = {
    version: 1,
    kind: 'antseed-verifier-evidence-pack',
    auditId,
    createdAt: evidence.createdAt,
    evidenceHash,
    evidenceLevel: evidence.evidenceLevel,
    scope: {
      responseAuthentication: 'seller-signed-response-auth',
      exactSignedPreimages: evidence.exchanges.every((exchange) => exchange.status !== 'succeeded'
        || exchange.responseAuth.signedPreimages !== null),
      paymentEvidence: false,
      onChainInclusionProof: false,
    },
    files: writtenFiles,
  }
  await writeEvidencePackJson(join(packDirectory, 'manifest.json'), manifest, 'Evidence pack manifest')
  await writeTextAtomic(join(packDirectory, 'README.md'), evidencePackReadme(manifest, evidence.reference.referenceId))
  return { path, evidenceHash }
}

async function writeEvidencePackJson(
  path: string,
  value: unknown,
  purpose: string,
  relativePath = path.split('/').at(-1)!,
): Promise<ProxyAuditEvidencePackManifestV1['files'][number]> {
  await writeTextAtomic(path, canonicalJsonStringify(value))
  return { path: relativePath, hash: canonicalHashBytes32(value), purpose }
}

async function writeTextAtomic(path: string, value: string): Promise<void> {
  const bytes = new TextEncoder().encode(value)
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(temporaryPath, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporaryPath, path)
}

function evidencePackReadme(
  manifest: ProxyAuditEvidencePackManifestV1,
  referenceId: string,
): string {
  return `# AntSeed Verifier Evidence Pack\n\n`
    + `Audit: ${manifest.auditId}\n\n`
    + `- evidence.json: canonical complete audit evidence; hash ${manifest.evidenceHash}\n`
    + `- exchanges/: one file per request batch, including the signed ResponseAuth record and exact AntSeed codec preimages\n`
    + `- manifest.json: hashes and evidence scope\n\n`
    + `Reference probe integrity is stored once for reference ${referenceId} in the model's references directory.\n\n`
    + `The local HTTP capture hash and signed P2P hash intentionally use different representations. `
    + `Recompute signed hashes from responseAuth.signedPreimages using Keccak-256, then verify the seller signature `
    + `against responseAuth.signedPreimages.responseAuthSigningBase64. `
    + `This pack contains seller-signed response authentication, but no payment or on-chain inclusion proof.\n`
}

export async function writeProxyAuditSkipEvidence(
  evidenceDir: string,
  _auditId: string,
  evidence: ProxyAuditSkipEvidenceV1,
): Promise<{ path: string; evidenceHash: string }> {
  const evidenceHash = canonicalHashBytes32(evidence)
  const bytes = new TextEncoder().encode(canonicalJsonStringify(evidence))
  const packDirectory = join(evidenceDir, safeServiceSlug(evidence.target.peerId))
  await mkdir(packDirectory, { recursive: true })
  const path = join(packDirectory, 'skip.json')
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(temporaryPath, 'wx')
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporaryPath, path)
  return { path, evidenceHash }
}

export async function verifyProxyAuditEvidenceFile(
  path: string,
  expectedHash: string,
): Promise<ProxyAuditEvidenceV1> {
  const bytes = await readFile(path)
  const parsed = JSON.parse(bytes.toString('utf8')) as ProxyAuditEvidenceV1
  if (parsed.kind !== 'antseed-buyer-proxy-kbf-audit' || parsed.version !== 1) {
    throw new Error('unsupported proxy audit evidence schema')
  }
  if (parsed.evidenceLevel !== 'proxy-observation-with-verified-response-auth-no-payment-evidence') {
    throw new Error('invalid proxy audit evidence v1 level')
  }
  const canonical = new TextEncoder().encode(canonicalJsonStringify(parsed))
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) throw new Error('evidence file is not canonical JSON')
  if (proxyAuditEvidenceHash(parsed).toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error('evidence file hash mismatch')
  }
  return parsed
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseNonNegativeNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function nonEmptyHeader(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}
