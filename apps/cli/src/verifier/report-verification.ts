import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { getAddress, keccak256, type TypedDataDomain } from 'ethers'
import {
  KBF_DEFAULT_PROMPT_VARIANT_ID,
  KBF_PROBES_PER_REQUEST,
  KBF_PROMPT_VARIANT_IDS,
  canonicalHashBytes32,
  canonicalJsonStringify,
  computeMatchVector,
  parseKbfAnswers,
  queryProfileHash,
  renderKbfProbeLine,
  validateKbfReferenceV1,
  verifyKbf,
  type KbfProbe,
  type KbfReferenceV1,
  type MatchVector,
} from '@antseed/fingerprints'
import {
  decodeHttpRequest,
  decodeHttpResponse,
  encodeResponseAuthSigningPayload,
  verifyResponseAuth,
} from '@antseed/node'
import {
  SERVICE_MODEL_MATCH,
  SERVICE_PRICE_MATCH,
  SERVICE_UNDETERMINED,
  hashAuditReport,
  hashServiceResults,
  recoverAuditReportSigner,
  serviceHash,
  modelHash,
} from '@antseed/node/payments'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  KBF_VERIFY_OPTIONS,
  MAX_REPORT_AGE_SECONDS,
  MAX_SERVICES_PER_REPORT,
  auditReportInput,
  auditedServicePricing,
  auditedServicesMetadataHash,
  evaluatePriceCheck,
  normalizedPeer,
  readAuditReportFile,
  referenceIdBytes32,
  resolveReportEvidencePath,
  type AgentAuditEvidenceV1,
  type AgentServiceEvidenceV1,
  type AuditReportFileV1,
  type RecordedRequestCostV1,
} from './audit-report.js'
import { createDomainHomogeneousKbfBatches } from './kbf-batching.js'
import { buildKbfProbeRequestBody, extractCompletionText } from './model-run.js'
import { findEpochProbeReference } from './probe-bank.js'
import {
  verifyProxyAuditEvidenceFile,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditEvidenceV1,
} from './proxy-evidence.js'
import { resolveReferenceSizingPolicy } from './reference-sizing.js'
import { matchesEnrolledService } from './response-auth-reader.js'
import { asError, normalized } from './utils.js'

export type ReportCheckName =
  | 'signature'
  | 'results'
  | 'evidence'
  | 'responseAuth'
  | 'kbf'
  | 'price'
  | 'ownership'

export const REPORT_CHECK_ORDER: readonly ReportCheckName[] = [
  'signature', 'results', 'evidence', 'responseAuth', 'kbf', 'price', 'ownership',
]

export interface ReportCheckResult {
  ok: boolean
  detail: string
}

export interface VerifiedAuditReport {
  path: string
  file: AuditReportFileV1 | null
  digest: string | null
  evidence: AgentAuditEvidenceV1 | null
  checks: Partial<Record<ReportCheckName, ReportCheckResult>>
  ok: boolean
}

class CheckFailure extends Error {}

/**
 * Independently re-derives an auditor's report from its evidence (checks a–f). Nothing the
 * auditor claims is trusted: signatures, hashes, seller ResponseAuth signatures, KBF answers,
 * the verdict, and the price check are all recomputed. On-chain checks (g) are separate.
 */
export async function verifyAuditReportFile(input: {
  path: string
  domain: TypedDataDomain
  nowSeconds: number
  banksDir: string
  config?: VerifierCLIConfig
  maxReportAgeSeconds?: number
  fetchFn?: typeof fetch
}): Promise<VerifiedAuditReport> {
  const verified: VerifiedAuditReport = {
    path: input.path,
    file: null,
    digest: null,
    evidence: null,
    checks: {},
    ok: false,
  }
  const run = async (name: ReportCheckName, check: () => Promise<string> | string): Promise<boolean> => {
    try {
      verified.checks[name] = { ok: true, detail: await check() }
      return true
    } catch (error) {
      verified.checks[name] = { ok: false, detail: asError(error).message }
      return false
    }
  }
  const skipRemaining = (reason: string): void => {
    for (const name of REPORT_CHECK_ORDER) {
      if (name !== 'ownership' && !verified.checks[name]) verified.checks[name] = { ok: false, detail: reason }
    }
  }

  let file: AuditReportFileV1
  try {
    file = await readAuditReportFile(input.path)
    verified.file = file
  } catch (error) {
    verified.checks.signature = { ok: false, detail: asError(error).message }
    skipRemaining('report file is unreadable')
    return verified
  }

  await run('signature', () => {
    const chainId = input.domain.chainId
    const contract = input.domain.verifyingContract
    if (chainId === undefined || chainId === null || !contract) throw new CheckFailure('verifier domain is incomplete')
    if (file.chainId !== BigInt(chainId).toString() || normalized(file.contract) !== normalized(contract)) {
      throw new CheckFailure(`report is for chain ${file.chainId} contract ${file.contract}, not this verification contract`)
    }
    const report = auditReportInput(file)
    if (normalized(file.evidenceHash) !== normalized(report.evidenceHash)) {
      throw new CheckFailure('file evidenceHash differs from the signed report')
    }
    const signer = recoverAuditReportSigner(input.domain, report, file.signature)
    if (signer !== getAddress(file.auditor)) throw new CheckFailure(`signature recovers to ${signer}, not auditor ${file.auditor}`)
    const maxAge = BigInt(input.maxReportAgeSeconds ?? MAX_REPORT_AGE_SECONDS)
    const now = BigInt(Math.floor(input.nowSeconds))
    if (report.auditedAt > now) throw new CheckFailure('auditedAt is in the future')
    if (now - report.auditedAt > maxAge) throw new CheckFailure(`report is older than ${maxAge}s`)
    verified.digest = hashAuditReport(input.domain, report)
    return `signed by ${signer}`
  })

  await run('results', () => {
    const results = file.results
    if (!Array.isArray(results) || results.length === 0 || results.length > MAX_SERVICES_PER_REPORT) {
      throw new CheckFailure(`results must contain 1-${MAX_SERVICES_PER_REPORT} services`)
    }
    let previous = -1n
    for (const result of results) {
      const current = BigInt(result.serviceHash)
      if (current <= previous) throw new CheckFailure('results are not strictly sorted by serviceHash')
      if (BigInt(result.modelHash) === 0n) throw new CheckFailure('result has a zero modelHash')
      if (!Number.isInteger(result.flags) || (result.flags & ~(SERVICE_MODEL_MATCH | SERVICE_PRICE_MATCH | SERVICE_UNDETERMINED)) !== 0) {
        throw new CheckFailure(`result has unknown flags ${result.flags}`)
      }
      previous = current
    }
    if (normalized(hashServiceResults(results)) !== normalized(file.report.resultsHash)) {
      throw new CheckFailure('resultsHash does not match the results')
    }
    return `${results.length} sorted service result(s)`
  })

  const services: Array<{ claim: AgentServiceEvidenceV1; audit: ProxyAuditEvidenceV1 }> = []
  const evidenceOk = await run('evidence', async () => {
    const evidencePath = resolveReportEvidencePath(input.path, file)
    const bytes = await readFile(evidencePath)
    const evidence = JSON.parse(bytes.toString('utf8')) as AgentAuditEvidenceV1
    if (evidence.version !== 1 || evidence.kind !== 'antseed-verifier-agent-audit-evidence') {
      throw new CheckFailure('unsupported agent audit evidence schema')
    }
    if (!bytes.equals(Buffer.from(canonicalJsonStringify(evidence), 'utf8'))) {
      throw new CheckFailure('evidence document is not canonical JSON')
    }
    if (normalized(canonicalHashBytes32(evidence)) !== normalized(file.report.evidenceHash)) {
      throw new CheckFailure('evidence document hash does not match evidenceHash')
    }
    if (evidence.agentId !== file.report.agentId) throw new CheckFailure('evidence agent ID differs from the report')
    if (normalized(evidence.auditor) !== normalized(file.auditor)) throw new CheckFailure('evidence auditor differs from the report')
    if (evidence.services.length !== file.results.length) throw new CheckFailure('evidence and results list different services')
    const evidenceDirectory = dirname(evidencePath)
    for (const [index, claim] of evidence.services.entries()) {
      const result = file.results[index]!
      if (normalized(serviceHash(claim.service)) !== normalized(claim.serviceHash)
        || normalized(claim.serviceHash) !== normalized(result.serviceHash)) {
        throw new CheckFailure(`service ${claim.service} does not match result ${index}`)
      }
      if (referenceIdBytes32(claim.referenceId) !== normalized(claim.referenceIdBytes32)) {
        throw new CheckFailure(`${claim.service}: referenceId encoding is inconsistent`)
      }
      if (normalized(modelHash(claim.reference.referenceModel)) !== normalized(result.modelHash)
        || normalized(claim.modelHash) !== normalized(result.modelHash)) {
        throw new CheckFailure(`${claim.service}: modelHash does not match the audited reference model`)
      }
      if (claim.flags !== result.flags) throw new CheckFailure(`${claim.service}: flags differ from the result`)
      const audit = await verifyProxyAuditEvidenceFile(
        resolve(evidenceDirectory, claim.audit.evidencePath),
        claim.audit.evidenceHash,
      ).catch((error: unknown) => {
        throw new CheckFailure(`${claim.service}: audit evidence ${claim.audit.evidencePath}: ${asError(error).message}`)
      })
      if (audit.target.agentId === null || BigInt(audit.target.agentId).toString() !== file.report.agentId) {
        throw new CheckFailure(`${claim.service}: audit evidence targets another agent`)
      }
      if (normalizedPeer(audit.target.peerId) !== normalizedPeer(claim.peerId)
        || audit.target.service !== claim.service) {
        throw new CheckFailure(`${claim.service}: audit evidence targets another seller or service`)
      }
      if (audit.reference.referenceId !== claim.referenceId
        || audit.reference.referenceModel !== claim.reference.referenceModel) {
        throw new CheckFailure(`${claim.service}: audit evidence used another reference`)
      }
      if (audit.result.verdict !== claim.verdict) throw new CheckFailure(`${claim.service}: claimed verdict differs from audit evidence`)
      services.push({ claim, audit })
    }
    const pricing = auditedServicePricing(evidence.services)
    if (canonicalJsonStringify(pricing) !== canonicalJsonStringify(evidence.metadata.services)) {
      throw new CheckFailure('metadata service pricing does not match the audited services')
    }
    const metadataHash = auditedServicesMetadataHash(file.report.agentId, pricing)
    if (normalized(metadataHash) !== normalized(file.report.metadataHash)
      || normalized(evidence.metadata.hash) !== normalized(metadataHash)) {
      throw new CheckFailure('metadataHash does not match the audited services and prices')
    }
    verified.evidence = evidence
    return `${services.length} audit evidence file(s) verified`
  })
  if (!evidenceOk) {
    skipRemaining('evidence is unavailable or invalid')
    finalizeVerifiedReport(verified)
    return verified
  }

  const sizing = resolveReferenceSizingPolicy(input.config)
  const references = new Map<string, KbfReferenceV1>()
  const referenceFor = async (claim: AgentServiceEvidenceV1): Promise<KbfReferenceV1> => {
    const cached = references.get(claim.serviceHash)
    if (cached) return cached
    const reference = await loadReference({
      referenceId: claim.referenceId,
      evidenceDirectory: dirname(resolveReportEvidencePath(input.path, file)),
      claim,
      banksDir: input.banksDir,
      minimumStatisticalPower: sizing.minimumStatisticalPower,
      fetchFn: input.fetchFn,
    })
    references.set(claim.serviceHash, reference)
    return reference
  }
  const signedResponses = new Map<string, Map<number, Uint8Array>>()
  await run('responseAuth', async () => {
    let verifiedCount = 0
    for (const { claim, audit } of services) {
      const bodies = new Map<number, Uint8Array>()
      for (const exchange of audit.exchanges) {
        if (exchange.responseAuth.status !== 'verified') continue
        const serviceAliases = exchange.responseAuth.record
          && normalized(exchange.responseAuth.record.advertisedService) !== normalized(audit.target.service)
          ? (await referenceFor(claim)).serviceAliases
          : []
        bodies.set(exchange.batchIndex, verifyExchangeResponseAuth(exchange, audit, file.auditor, serviceAliases))
        verifiedCount += 1
      }
      signedResponses.set(claim.serviceHash, bodies)
    }
    return `${verifiedCount} seller signature(s) recovered`
  })

  await run('kbf', async () => {
    if (!verified.checks.responseAuth?.ok) throw new CheckFailure('requires verified seller ResponseAuth')
    for (const { claim, audit } of services) {
      const reference = await referenceFor(claim)
      recomputeKbfVerdict(claim, audit, reference, signedResponses.get(claim.serviceHash) ?? new Map())
    }
    return `${services.length} verdict(s) recomputed`
  })

  await run('price', async () => {
    for (const { claim, audit } of services) {
      const recorded = new Map<string, RecordedRequestCostV1>()
      for (const request of claim.priceCheck.requests) {
        if (request.cost) recorded.set(request.requestId, request.cost)
      }
      const serviceAliases = [...recorded.values()].some((cost) => cost.service
        && normalized(cost.service) !== normalized(audit.target.service))
        ? (await referenceFor(claim)).serviceAliases
        : []
      const recomputed = evaluatePriceCheck(audit, (requestId) => recorded.get(requestId) ?? null, serviceAliases)
      if (canonicalJsonStringify(recomputed) !== canonicalJsonStringify(claim.priceCheck)) {
        throw new CheckFailure(`${claim.service}: price check does not recompute`)
      }
      if (Boolean(claim.flags & SERVICE_PRICE_MATCH) !== recomputed.passed) {
        throw new CheckFailure(`${claim.service}: PRICE_MATCH flag disagrees with the price check`)
      }
    }
    const passed = services.filter(({ claim }) => claim.priceCheck.passed).length
    return `${passed}/${services.length} service(s) within advertised price`
  })

  finalizeVerifiedReport(verified)
  return verified
}

/** Recovers the seller's ResponseAuth signature from the exact signed preimages; returns the signed response body. */
export function verifyExchangeResponseAuth(
  exchange: ProxyAuditEvidenceExchangeV1,
  audit: ProxyAuditEvidenceV1,
  auditor: string,
  serviceAliases: readonly string[] = [],
): Uint8Array {
  const label = `${audit.target.service} batch ${exchange.batchIndex}`
  const record = exchange.responseAuth.record
  const preimages = exchange.responseAuth.signedPreimages
  if (!record || !preimages) throw new CheckFailure(`${label}: verified exchange lacks signed preimages`)
  if (!matchesEnrolledService(audit.target.service, record.advertisedService, serviceAliases)) {
    throw new CheckFailure(`${label}: ResponseAuth advertised service is not the requested service or an enrolled alias`)
  }
  const requestBytes = Buffer.from(preimages.requestBase64, 'base64')
  const responseBytes = Buffer.from(preimages.responseBase64, 'base64')
  if (keccak256(requestBytes) !== record.requestHash || record.requestHash !== preimages.requestHash) {
    throw new CheckFailure(`${label}: request preimage does not hash to the signed requestHash`)
  }
  if (keccak256(responseBytes) !== record.responseHash || record.responseHash !== preimages.responseHash) {
    throw new CheckFailure(`${label}: response preimage does not hash to the signed responseHash`)
  }
  let request: ReturnType<typeof decodeHttpRequest>
  let response: ReturnType<typeof decodeHttpResponse>
  try {
    request = decodeHttpRequest(requestBytes)
    response = decodeHttpResponse(responseBytes)
  } catch (error) {
    throw new CheckFailure(`${label}: signed preimages do not decode: ${asError(error).message}`)
  }
  if (record.requestId !== exchange.responseAuth.requestId || !exchange.requestIds.includes(record.requestId)) {
    throw new CheckFailure(`${label}: ResponseAuth request ID is not the exchange's request`)
  }
  const { receivedAt: _receivedAt, verified: _verified, verificationError: _verificationError, ...payload } = record
  const { signature: _signature, ...unsigned } = payload
  if (Buffer.from(encodeResponseAuthSigningPayload(unsigned)).toString('base64') !== preimages.responseAuthSigningBase64) {
    throw new CheckFailure(`${label}: recorded signing payload differs from the ResponseAuth record`)
  }
  const verification = verifyResponseAuth(payload, {
    request,
    response,
    buyerPeerId: record.buyerPeerId,
    sellerPeerId: audit.target.peerId,
    advertisedService: record.advertisedService,
  })
  if (!verification.valid) throw new CheckFailure(`${label}: ResponseAuth ${verification.reason ?? 'is invalid'}`)
  if (normalizedPeer(record.buyerPeerId) !== normalizedPeer(auditor)) {
    throw new CheckFailure(`${label}: exchange was bought by ${record.buyerPeerId}, not the auditor`)
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new CheckFailure(`${label}: signed response status ${response.statusCode} is not successful`)
  }
  return decodeBody(response.body, response.headers)
}

/** Re-parses answers from captured bytes and recomputes the match vector and KBF verdict. */
export function recomputeKbfVerdict(
  claim: AgentServiceEvidenceV1,
  audit: ProxyAuditEvidenceV1,
  reference: KbfReferenceV1,
  signedResponseBodies: Map<number, Uint8Array>,
): void {
  const label = claim.service
  if (queryProfileHash(reference.queryProfile) !== audit.reference.queryProfileHash) {
    throw new CheckFailure(`${label}: reference query profile differs from the audit`)
  }
  if (canonicalHashBytes32(reference.probes) !== canonicalHashBytes32(audit.reference.probes)) {
    throw new CheckFailure(`${label}: reference probes differ from the audit`)
  }
  if (canonicalJsonStringify(claim.kbfOptions) !== canonicalJsonStringify(KBF_VERIFY_OPTIONS)) {
    throw new CheckFailure(`${label}: unsupported KBF verification options`)
  }
  const batches = createDomainHomogeneousKbfBatches(reference.probes, KBF_PROBES_PER_REQUEST, (values) => [...values])
  if (audit.exchanges.length !== batches.length) {
    throw new CheckFailure(`${label}: audit has ${audit.exchanges.length} exchanges for ${batches.length} probe batches`)
  }
  const answersByProbeId = new Map<string, number | null>()
  const matchesByProbeId = new Map<string, 0 | 1 | null>()
  let authenticated = true
  for (const [position, exchange] of audit.exchanges.entries()) {
    const batch = batches[exchange.batchIndex]
    if (!batch || exchange.batchIndex !== position) throw new CheckFailure(`${label}: unexpected batch ${exchange.batchIndex}`)
    const probes = batch.probes
    const batchLabel = `${label} batch ${exchange.batchIndex}`
    if (!sameStrings(exchange.probeIds, probes.map((probe) => probe.id))) {
      throw new CheckFailure(`${batchLabel}: probe IDs differ from the reference batch`)
    }
    const variantId = exchange.promptVariantId ?? KBF_DEFAULT_PROMPT_VARIANT_ID
    if (!KBF_PROMPT_VARIANT_IDS.includes(variantId)) throw new CheckFailure(`${batchLabel}: unknown prompt variant ${variantId}`)
    const expectedBody = buildKbfProbeRequestBody(audit.target.service, reference.queryProfile, probes, variantId)
    if (Buffer.from(expectedBody).toString('base64') !== exchange.request.bodyBase64) {
      throw new CheckFailure(`${batchLabel}: captured request is not the KBF prompt for its probes`)
    }
    let answers: Array<number | null> = new Array<number | null>(probes.length).fill(null)
    let matches: MatchVector = new Array<null>(probes.length).fill(null)
    if (exchange.status === 'succeeded') {
      let body: Uint8Array
      if (exchange.responseAuth.status === 'verified') {
        const signed = signedResponseBodies.get(exchange.batchIndex)
        if (!signed) throw new CheckFailure(`${batchLabel}: signed response is unavailable`)
        assertSignedRequestAsksProbes(exchange, probes, batchLabel)
        body = signed
      } else {
        // Unauthenticated batches force an UNDETERMINED verdict; their answers come from the local capture.
        authenticated = false
        if (!exchange.response) throw new CheckFailure(`${batchLabel}: successful exchange has no captured response`)
        body = Buffer.from(exchange.response.bodyBase64, 'base64')
      }
      const completion = extractCompletionText(body)
      answers = completion === null ? answers : parseKbfAnswers(completion, probes.length)
      matches = answers.every((answer) => answer === null) ? matches : computeMatchVector(answers, probes)
    }
    if (canonicalJsonStringify(answers) !== canonicalJsonStringify(exchange.answers)
      || canonicalJsonStringify(matches) !== canonicalJsonStringify(exchange.matches)) {
      throw new CheckFailure(`${batchLabel}: re-parsed answers differ from the recorded answers`)
    }
    for (const [index, probe] of probes.entries()) {
      answersByProbeId.set(probe.id, answers[index] ?? null)
      matchesByProbeId.set(probe.id, matches[index] ?? null)
    }
  }
  const answers = reference.probes.map((probe) => answersByProbeId.get(probe.id) ?? null)
  const matchVector = reference.probes.map((probe) => matchesByProbeId.get(probe.id) ?? null)
  const fragment = verifyKbf(reference, { answers, matchVector }, KBF_VERIFY_OPTIONS)
  if (fragment.verdict === 'UNKNOWN') throw new CheckFailure(`${label}: KBF returned UNKNOWN: ${fragment.verdictReason ?? ''}`)
  const verdict = authenticated ? fragment.verdict : 'UNDETERMINED'
  if (verdict !== audit.result.verdict || verdict !== claim.verdict) {
    throw new CheckFailure(`${label}: recomputed verdict ${verdict} differs from claimed ${claim.verdict}`)
  }
  if (canonicalJsonStringify(matchVector) !== canonicalJsonStringify(audit.result.matchVector)
    || fragment.matchVectorHash !== audit.result.matchVectorHash
    || fragment.matchVectorHash !== claim.matchVectorHash
    || canonicalJsonStringify(fragment.stats) !== canonicalJsonStringify(audit.result.stats)
    || canonicalJsonStringify(fragment.stats) !== canonicalJsonStringify(claim.stats)) {
    throw new CheckFailure(`${label}: recomputed match vector or statistics differ from the audit`)
  }
  const modelMatch = Boolean(claim.flags & SERVICE_MODEL_MATCH)
  const undetermined = Boolean(claim.flags & SERVICE_UNDETERMINED)
  if (modelMatch !== (verdict === 'SAME') || undetermined !== (verdict === 'UNDETERMINED')) {
    throw new CheckFailure(`${label}: MODEL_MATCH/UNDETERMINED flags disagree with verdict ${verdict}`)
  }
}

/** Loads the full reference by ID (evidence path, local banks, or recorded URL) and validates it; fails closed. */
export async function loadReference(input: {
  referenceId: string
  evidenceDirectory: string
  claim: AgentServiceEvidenceV1
  banksDir: string
  minimumStatisticalPower: number
  fetchFn?: typeof fetch
}): Promise<KbfReferenceV1> {
  const candidates: Array<() => Promise<unknown | null>> = [
    async () => input.claim.reference.path
      ? readJsonOrNull(resolve(input.evidenceDirectory, input.claim.reference.path))
      : null,
    async () => findEpochProbeReference(input.banksDir, input.referenceId),
    async () => {
      const uri = input.claim.reference.uri
      if (!uri || !/^https:\/\//.test(uri)) return null
      const response = await (input.fetchFn ?? fetch)(uri, { signal: AbortSignal.timeout(30_000) })
      return response.ok ? await response.json() as unknown : null
    },
  ]
  const errors: string[] = []
  for (const candidate of candidates) {
    let value: unknown | null
    try {
      value = await candidate()
    } catch (error) {
      errors.push(asError(error).message)
      continue
    }
    if (value === null) continue
    try {
      const reference = validateKbfReferenceV1(value, { minimumStatisticalPower: input.minimumStatisticalPower })
      if (reference.referenceId !== input.referenceId) throw new Error('referenceId mismatch')
      return reference
    } catch (error) {
      errors.push(asError(error).message)
    }
  }
  throw new CheckFailure(
    `${input.claim.service}: reference ${input.referenceId} is unavailable${errors.length > 0 ? ` (${errors.join('; ')})` : ''}`,
  )
}

function assertSignedRequestAsksProbes(
  exchange: ProxyAuditEvidenceExchangeV1,
  probes: readonly KbfProbe[],
  label: string,
): void {
  const preimages = exchange.responseAuth.signedPreimages!
  const request = decodeHttpRequest(Buffer.from(preimages.requestBase64, 'base64'))
  const text = new TextDecoder().decode(request.body)
  const missing = probes.find((probe) => !text.includes(JSON.stringify(renderKbfProbeLine(probe)).slice(1, -1)))
  if (missing) throw new CheckFailure(`${label}: signed request does not ask probe ${missing.id}`)
}

function decodeBody(body: Uint8Array, headers: Record<string, string>): Uint8Array {
  const encoding = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'content-encoding')?.[1]?.trim().toLowerCase()
  if (!encoding || encoding === 'identity') return body
  if (encoding === 'gzip') return gunzipSync(body)
  if (encoding === 'deflate') return inflateSync(body)
  if (encoding === 'br') return brotliDecompressSync(body)
  throw new CheckFailure(`unsupported signed response content-encoding ${encoding}`)
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function finalizeVerifiedReport(verified: VerifiedAuditReport): void {
  verified.ok = REPORT_CHECK_ORDER
    .filter((name) => name !== 'ownership')
    .every((name) => verified.checks[name]?.ok === true)
    && (verified.checks.ownership?.ok ?? true)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
