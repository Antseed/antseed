// Test support: builds complete verifier runs with genuinely signed seller exchanges.
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Wallet } from 'ethers'
import { keccak256 } from 'ethers'
import {
  KBF_AUDIT_VERIFY_OPTIONS,
  KBF_PROBES_PER_REQUEST,
  canonicalHashBytes32,
  computeBinomialPower,
  computeMatchVector,
  computeReferenceId,
  createReferenceQueryProfile,
  parseKbfAnswers,
  queryProfileHash,
  verifyKbf,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import {
  createResponseAuthPayload,
  encodeHttpRequest,
  encodeHttpResponse,
  encodeResponseAuthSigningPayload,
} from '@antseed/node'
import {
  modelAuditExtensionsDirectory,
  modelAuditRechecksDirectory,
  modelAuditSellersDirectory,
  writeEpochAuditSummary,
  writeModelAuditSummary,
  writeVerifierRunManifest,
  type EpochAuditSummaryV1,
  type ModelAuditSummaryV1,
  type VerifierRunManifestV1,
} from './audit-artifacts.js'
import { writeJsonAtomic } from './atomic-files.js'
import { createDomainHomogeneousKbfBatches } from './kbf-batching.js'
import { buildKbfProbeRequestBody, type ModelVerificationTargetResult } from './model-run.js'
import { combineExtension } from './extension-round.js'
import { combineDiffRecheck } from './diff-recheck.js'
import { sellerEpochProbeReferencePath, SELLER_PROBE_SELECTION_METHOD } from './probe-bank.js'
import {
  emptyAuditCostSummary,
  summarizeAuditExchangeCosts,
  writeProxyAuditEvidence,
  type ProxyAuditEvidenceExchangeV1,
  type ProxyAuditEvidenceV1,
} from './proxy-evidence.js'

export const FIXTURE_CONFIG = { referenceMinimumStatisticalPower: 1e-9 }

export interface FixtureAudit {
  agentId: string
  seller: Wallet
  model: string
  service: string
  routedService?: string
  /** UNDETERMINED answers like SAME, then is recorded as lacking verified ResponseAuth. */
  verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'
  /** A DIFF's recheck on fresh probes; omit for a DIFF that was never rechecked. */
  recheck?: 'SAME' | 'DIFF' | 'UNDETERMINED'
  /** Seller key that actually signs ResponseAuth (defaults to `seller`). */
  signer?: Wallet
  reference?: KbfReferenceV1
  /**
   * A close-call first audit (`kbf-extension-v1`): `firstWrong` wrong answers on the first set, then
   * an extension set of the same size with `extensionWrong` wrong answers, and an optional recheck of
   * a pooled DIFF. `verdict` is ignored. Omit `extensionWrong` for a close call still waiting.
   * Under `rule: 'kbf-extension-v2'`, a pooled look still in the grey zone gets a second extra set with
   * `extension2Wrong` wrong answers (omit it for a close call waiting for that set).
   */
  closeCall?: {
    firstWrong: number
    extensionWrong?: number
    extension2Wrong?: number
    rule?: 'kbf-extension-v1' | 'kbf-extension-v2'
    recheck?: 'SAME' | 'DIFF' | 'UNDETERMINED'
  }
}

export function referenceFixture(model: string, probeCount = 10): KbfReferenceV1 {
  const probes = Array.from({ length: probeCount }, (_, index) => ({
    id: `${model}-probe-${index + 1}`,
    name: `probe ${index + 1}`,
    domain: 'test',
    template: `The ${model} test value ${index + 1} is ___.`,
    consensus: index + 1,
    range: [0, 1_000] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0 },
  }))
  const power = computeBinomialPower({
    selfHamming: 0,
    selfTotal: probeCount,
    probeCount,
    minimumMismatchDelta: 0.1,
    alpha: 0.05,
    cpConfidence: 0.99,
  })
  const value: KbfReferenceV1 = {
    version: 2,
    kind: 'kbf',
    referenceId: '',
    referenceModel: model,
    serviceAliases: [model],
    createdAt: '2026-08-06T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    provenance: { sourceId: 'trusted', trust: 'trusted' },
    queryProfile: createReferenceQueryProfile({ upstreamModel: `upstream-${model}` }),
    selfTest: {
      hamming: 0,
      total: probeCount,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answers: [probe.consensus], matches: [1] })),
    },
    probes,
    selectedProbeCount: probeCount,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: probeCount,
      probeCount,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [{ model: `${model}-contrast`, distinguishingProbeIds: probes.map((probe) => probe.id) }],
  }
  value.referenceId = computeReferenceId(value)
  return value
}

export function peerIdOf(wallet: Wallet): string {
  return wallet.address.slice(2).toLowerCase()
}

/** Writes a completed run (summaries, signed evidence, seller references) and returns its manifest. */
export async function writeSignedAuditRun(input: {
  evidenceDir: string
  banksDir: string
  runId: string
  epoch: string
  auditor: Wallet
  audits: FixtureAudit[]
  epochSource?: VerifierRunManifestV1['epochSource']
}): Promise<VerifierRunManifestV1> {
  const models = [...new Set(input.audits.map((audit) => audit.model))]
  const timestamps = {
    epochStartedAt: '2026-10-07T00:00:00.000Z',
    epochEndsAt: '2026-10-08T00:00:00.000Z',
    startedAt: '2026-10-07T00:01:00.000Z',
    completedAt: '2026-10-07T00:02:00.000Z',
  }
  const summaryModels: EpochAuditSummaryV1['models'] = []
  for (const model of models) {
    const results: ModelAuditSummaryV1['results'] = []
    for (const [index, audit] of input.audits.filter((entry) => entry.model === model).entries()) {
      const reference = audit.reference ?? referenceFixture(model)
      const peerId = peerIdOf(audit.seller)
      const referencePath = sellerEpochProbeReferencePath(input.banksDir, model, input.epoch, peerId)
      await mkdir(dirname(referencePath), { recursive: true })
      await writeJsonAtomic(referencePath, {
        version: 1,
        kind: 'antseed-kbf-seller-epoch-probe-reference',
        model,
        epoch: input.epoch,
        sellerPeerId: peerId,
        compatibilityHash: `0x${'00'.repeat(32)}`,
        selection: {
          method: SELLER_PROBE_SELECTION_METHOD,
          eligibleProbeCount: reference.probes.length,
          excludedPreviouslyAssignedProbeCount: 0,
          allowProbeReuse: false,
        },
        reference,
        createdAt: timestamps.startedAt,
        createdByRunId: input.runId,
      })
      const auditId = canonicalHashBytes32({ fixture: input.runId, model, peerId })
      if (audit.closeCall) {
        results.push(await closeCallResult({
          audit, closeCall: audit.closeCall, reference, auditor: input.auditor, runId: input.runId, epoch: input.epoch,
          evidenceDir: input.evidenceDir, completedAt: timestamps.completedAt, displayName: `${model}-${index + 1}`,
          peerId, auditId,
        }))
        continue
      }
      const first = await writeFixtureEvidence({
        audit, reference, auditor: input.auditor, runId: input.runId, completedAt: timestamps.completedAt,
        displayName: `${model}-${index + 1}`, peerId, verdictWanted: audit.verdict, auditId,
        directory: modelAuditSellersDirectory(input.evidenceDir, input.epoch, model, input.runId),
      })
      const { evidence, written, exchanges, matchVector, cost } = first
      let verdict: FixtureAudit['verdict'] = audit.verdict
      let recheck: ModelAuditSummaryV1['results'][number]['recheck']
      if (audit.recheck) {
        if (audit.verdict !== 'DIFF') throw new Error('only a DIFF fixture can carry a recheck')
        const recheckReference = freshReference(reference)
        const recheckAuditId = canonicalHashBytes32({ fixture: input.runId, model, peerId, recheck: true })
        const second = await writeFixtureEvidence({
          audit, reference: recheckReference, auditor: input.auditor, runId: `${input.runId}-recheck`,
          completedAt: timestamps.completedAt, displayName: `${model}-${index + 1}`, peerId,
          verdictWanted: audit.recheck, auditId: recheckAuditId,
          directory: modelAuditRechecksDirectory(input.evidenceDir, input.epoch, model, input.runId),
        })
        verdict = audit.recheck === 'SAME' ? 'UNDETERMINED' : 'DIFF'
        recheck = {
          auditId: recheckAuditId,
          status: audit.recheck,
          referenceId: recheckReference.referenceId,
          probeCount: recheckReference.probes.length,
          parsedProbeCount: second.evidence.result.parsedProbeCount,
          correctProbeCount: second.matchVector.filter((entry) => entry === 1).length,
          cost: second.cost,
          evidencePath: second.written.path,
          evidenceHash: second.written.evidenceHash,
        }
      }
      results.push({
        peerId,
        displayName: evidence.target.displayName,
        agentId: audit.agentId,
        service: audit.service,
        status: verdict,
        outcomeReason: null,
        auditId,
        parsedProbeCount: evidence.result.parsedProbeCount,
        probeCount: reference.probes.length,
        correctProbeCount: matchVector.filter((entry) => entry === 1).length,
        incorrectProbeCount: matchVector.filter((entry) => entry === 0).length,
        correctRate: null,
        requestCount: exchanges.length,
        cost,
        cumulativeCost: cost,
        evidencePath: written.path,
        evidenceHash: written.evidenceHash,
        ...(recheck ? { recheck } : {}),
      })
    }
    const summaryPath = await writeModelAuditSummary(input.evidenceDir, input.epoch, model, {
      version: 1,
      kind: 'antseed-verifier-model-summary',
      runId: input.runId,
      epoch: input.epoch,
      model,
      startedAt: timestamps.startedAt,
      completedAt: timestamps.completedAt,
      results,
      failures: [],
      skipped: [],
      cost: emptyAuditCostSummary(),
    })
    summaryModels.push({
      model,
      summaryPath,
      resultCount: results.length,
      failureCount: 0,
      skippedCount: 0,
      cost: emptyAuditCostSummary(),
    })
  }
  const summaryPath = await writeEpochAuditSummary(input.evidenceDir, input.epoch, {
    version: 1,
    kind: 'antseed-verifier-epoch-summary',
    runId: input.runId,
    epoch: input.epoch,
    ...timestamps,
    reportPaths: [],
    models: summaryModels,
    failureCount: 0,
    cost: emptyAuditCostSummary(),
  })
  const manifest: VerifierRunManifestV1 = {
    version: 1,
    kind: 'antseed-verifier-run-manifest',
    runId: input.runId,
    state: 'completed',
    epoch: input.epoch,
    epochSource: input.epochSource ?? 'onchain',
    ...timestamps,
    summaryPath,
    modelOrder: models,
    models: summaryModels,
    failureCount: 0,
  }
  await writeVerifierRunManifest(input.evidenceDir, manifest)
  return manifest
}

function signedExchanges(input: FixtureAudit & {
  reference: KbfReferenceV1
  auditor: Wallet
  runId: string
  /** When set, exactly these probes are answered wrong, whatever `verdict` says. */
  wrongProbeIds?: ReadonlySet<string>
}): ProxyAuditEvidenceExchangeV1[] {
  const batches = createDomainHomogeneousKbfBatches(input.reference.probes, KBF_PROBES_PER_REQUEST, (values) => [...values])
  const peerId = peerIdOf(input.seller)
  return batches.map(({ probes }, batchIndex) => {
    const requestId = `${input.runId}-${peerId.slice(0, 8)}-${input.model}-${batchIndex}`
    const promptVariantId = 'v1'
    const body = buildKbfProbeRequestBody(input.service, input.reference.queryProfile, probes, promptVariantId)
    const headers = { 'content-type': 'application/json' }
    const content = probes
      .map((probe, index) => {
        const wrong = input.wrongProbeIds ? input.wrongProbeIds.has(probe.id) : input.verdict === 'DIFF'
        return `(${index + 1}) ${wrong ? probe.consensus + 500 : probe.consensus}`
      })
      .join('\n')
    const responseBody = new TextEncoder().encode(JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }))
    const signedBody = buildKbfProbeRequestBody(input.routedService ?? input.service, input.reference.queryProfile, probes, promptVariantId)
    const request = { requestId, method: 'POST', path: '/v1/chat/completions', headers, body: signedBody }
    const response = { requestId, statusCode: 200, headers, body: responseBody }
    const payload = createResponseAuthPayload({
      request,
      response,
      buyerPeerId: input.auditor.address,
      sellerPeerId: peerId,
      advertisedService: input.routedService ?? input.service,
      channelId: `0x${'cc'.repeat(32)}`,
      provider: 'openai',
      responseStartedAt: 1_000,
      responseCompletedAt: 2_000,
    }, input.signer ?? input.seller)
    const { signature: _signature, ...unsigned } = payload
    const requestBytes = encodeHttpRequest(request)
    const responseBytes = encodeHttpResponse(response)
    const answers = parseKbfAnswers(content, probes.length)
    const cost = {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      estimatedCostUsd: 0.00014,
      tokenSource: 'usage',
      provider: 'openai',
      service: input.routedService ?? input.service,
    }
    const url = 'http://127.0.0.1:8377/v1/chat/completions'
    const localHeaders = {
      'content-type': 'application/json',
      'x-antseed-pin-peer': peerId,
      'x-antseed-capture-response-auth-preimages': '1',
    }
    const bodyBase64 = Buffer.from(body).toString('base64')
    const responseBase64 = Buffer.from(responseBody).toString('base64')
    return {
      batchIndex,
      attemptCount: 1,
      requestIds: [requestId],
      probeIds: probes.map((probe) => probe.id),
      promptVariantId,
      request: {
        method: 'POST' as const,
        url,
        headers: localHeaders,
        bodyBase64,
        hash: canonicalHashBytes32({ method: 'POST', url, headers: localHeaders, bodyBase64 }),
      },
      response: {
        statusCode: 200,
        headers,
        bodyBase64: responseBase64,
        hash: canonicalHashBytes32({ statusCode: 200, headers, bodyBase64: responseBase64 }),
      },
      timing: { startedAt: 1_000, completedAt: 2_000, responseLatencyMs: 1_000 },
      answers,
      matches: computeMatchVector(answers, probes),
      status: 'succeeded' as const,
      failureReason: null,
      cost,
      attemptCosts: [cost],
      outcomeReason: null,
      responseAuth: {
        requestId,
        status: 'verified' as const,
        record: { ...payload, receivedAt: 2_500, verified: true, verificationError: null },
        signedPreimages: {
          encoding: 'antseed-http-codec-v1' as const,
          signatureEncoding: 'antseed-response-auth-signing-v1' as const,
          hashAlgorithm: 'keccak256' as const,
          requestBase64: Buffer.from(requestBytes).toString('base64'),
          responseBase64: Buffer.from(responseBytes).toString('base64'),
          responseAuthSigningBase64: Buffer.from(encodeResponseAuthSigningPayload(unsigned)).toString('base64'),
          requestHash: keccak256(requestBytes),
          responseHash: keccak256(responseBytes),
        },
        failureReason: null,
      },
    }
  })
}

async function closeCallResult(input: {
  audit: FixtureAudit
  closeCall: NonNullable<FixtureAudit['closeCall']>
  reference: KbfReferenceV1
  auditor: Wallet
  runId: string
  epoch: string
  evidenceDir: string
  completedAt: string
  displayName: string
  peerId: string
  auditId: string
}): Promise<ModelVerificationTargetResult> {
  const { audit, closeCall, reference, peerId } = input
  const asResult = (
    written: Awaited<ReturnType<typeof writeFixtureEvidence>>,
    auditId: string,
    probeCount: number,
  ): ModelVerificationTargetResult => {
    const correct = written.matchVector.filter((entry) => entry === 1).length
    const incorrect = written.matchVector.filter((entry) => entry === 0).length
    return {
      peerId,
      displayName: written.evidence.target.displayName,
      agentId: audit.agentId,
      service: audit.service,
      status: written.evidence.result.verdict,
      outcomeReason: null,
      auditId,
      parsedProbeCount: correct + incorrect,
      probeCount,
      correctProbeCount: correct,
      incorrectProbeCount: incorrect,
      correctRate: correct + incorrect === 0 ? null : correct / (correct + incorrect),
      requestCount: written.exchanges.length,
      cost: written.cost,
      cumulativeCost: written.cost,
      evidencePath: written.written.path,
      evidenceHash: written.written.evidenceHash,
      stats: written.evidence.result.stats,
      responseAuthVerified: true,
    }
  }
  const common = {
    audit, auditor: input.auditor, completedAt: input.completedAt, displayName: input.displayName, peerId,
    verdictWanted: 'SAME' as const,
  }
  const first = await writeFixtureEvidence({
    ...common, reference, runId: input.runId, auditId: input.auditId, wrongCount: closeCall.firstWrong,
    directory: modelAuditSellersDirectory(input.evidenceDir, input.epoch, audit.model, input.runId),
  })
  let result: ModelVerificationTargetResult = {
    ...asResult(first, input.auditId, reference.probes.length),
    decisionRule: closeCall.rule ?? 'kbf-extension-v1',
  }
  if (closeCall.extensionWrong === undefined) {
    return { ...result, extensionPending: { reason: 'fixture: not extended', since: input.completedAt } }
  }
  const extensionReference = freshReference(reference, 'extension')
  const extensionAuditId = canonicalHashBytes32({ fixture: input.runId, model: audit.model, peerId, extension: true })
  const extension = await writeFixtureEvidence({
    ...common, reference: extensionReference, runId: `${input.runId}-extension`, auditId: extensionAuditId,
    wrongCount: closeCall.extensionWrong,
    directory: modelAuditExtensionsDirectory(input.evidenceDir, input.epoch, audit.model, input.runId),
  })
  result = combineExtension(
    result, asResult(extension, extensionAuditId, extensionReference.probes.length), extensionReference.referenceId,
  )
  if (result.extension?.pooled.extendNext) {
    if (closeCall.extension2Wrong === undefined) {
      return { ...result, extensionPending: { reason: 'fixture: second set not asked', since: input.completedAt } }
    }
    const extension2Reference = freshReference(reference, 'extension2')
    const extension2AuditId = canonicalHashBytes32({ fixture: input.runId, model: audit.model, peerId, extension: 2 })
    const extension2 = await writeFixtureEvidence({
      ...common, reference: extension2Reference, runId: `${input.runId}-extension2`, auditId: extension2AuditId,
      wrongCount: closeCall.extension2Wrong,
      directory: modelAuditExtensionsDirectory(input.evidenceDir, input.epoch, audit.model, input.runId, 2),
    })
    result = combineExtension(
      result, asResult(extension2, extension2AuditId, extension2Reference.probes.length), extension2Reference.referenceId,
    )
  }
  if (!closeCall.recheck) return result
  const recheckReference = freshReference(reference, 'recheck')
  const recheckAuditId = canonicalHashBytes32({ fixture: input.runId, model: audit.model, peerId, recheck: true })
  const recheck = await writeFixtureEvidence({
    ...common, reference: recheckReference, runId: `${input.runId}-recheck`, auditId: recheckAuditId,
    verdictWanted: closeCall.recheck,
    directory: modelAuditRechecksDirectory(input.evidenceDir, input.epoch, audit.model, input.runId),
  })
  return combineDiffRecheck(result, asResult(recheck, recheckAuditId, recheckReference.probes.length), recheckReference.referenceId)
}

/** A copy of a reference with new probe IDs, as a recheck or extension on fresh probes gets. */
function freshReference(reference: KbfReferenceV1, suffix = 'fresh'): KbfReferenceV1 {
  const probes = reference.probes.map((probe) => ({ ...probe, id: `${probe.id}-${suffix}` }))
  const ids = new Map(reference.probes.map((probe, index) => [probe.id, probes[index]!.id]))
  const value: KbfReferenceV1 = {
    ...reference,
    referenceId: '',
    probes,
    selfTest: {
      ...reference.selfTest,
      outcomes: reference.selfTest.outcomes.map((outcome) => ({ ...outcome, probeId: ids.get(outcome.probeId)! })),
    },
    contrasts: reference.contrasts?.map((contrast) => ({
      ...contrast,
      distinguishingProbeIds: contrast.distinguishingProbeIds.map((id) => ids.get(id)!),
    })),
  } as KbfReferenceV1
  value.referenceId = computeReferenceId(value)
  return value
}

async function writeFixtureEvidence(input: {
  audit: FixtureAudit
  reference: KbfReferenceV1
  auditor: Wallet
  runId: string
  completedAt: string
  displayName: string
  peerId: string
  verdictWanted: FixtureAudit['verdict']
  auditId: string
  directory: string
  /** Answer exactly this many probes wrong (the first ones) and keep whatever verdict that gives. */
  wrongCount?: number
}) {
  const { reference, peerId } = input
  const audit = { ...input.audit, verdict: input.verdictWanted }
  const timestamps = { completedAt: input.completedAt }
  const wrongProbeIds = input.wrongCount === undefined
    ? undefined
    : new Set(reference.probes.slice(0, input.wrongCount).map((probe) => probe.id))
  const exchanges = signedExchanges({ ...audit, reference, auditor: input.auditor, runId: input.runId, wrongProbeIds })
  const answersById = new Map<string, number | null>()
  const matchesById = new Map<string, 0 | 1 | null>()
  for (const exchange of exchanges) {
    for (const [position, probeId] of exchange.probeIds.entries()) {
      answersById.set(probeId, exchange.answers[position] ?? null)
      matchesById.set(probeId, exchange.matches[position] ?? null)
    }
  }
  const answers = reference.probes.map((probe) => answersById.get(probe.id) ?? null)
  const matchVector = reference.probes.map((probe) => matchesById.get(probe.id) ?? null)
  const fragment = verifyKbf(reference, { answers, matchVector }, KBF_AUDIT_VERIFY_OPTIONS)
  if (fragment.verdict === 'UNKNOWN') throw new Error(fragment.verdictReason ?? 'UNKNOWN fixture verdict')
  const undetermined = audit.verdict === 'UNDETERMINED' && input.wrongCount === undefined
  const verdict = undetermined ? 'UNDETERMINED' as const : fragment.verdict
  const verdictReason = undetermined
    ? 'one or more successful proxy batches lacked valid verified ResponseAuth'
    : fragment.verdictReason
  const cost = summarizeAuditExchangeCosts(exchanges)
  const evidence: ProxyAuditEvidenceV1 = {
    version: 1,
    kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: timestamps.completedAt,
    buyerProxy: { baseUrl: 'http://127.0.0.1:8377', statePath: '/tmp/buyer.state.json', pid: 1 },
    target: { peerId, displayName: input.displayName, agentId: audit.agentId, service: audit.service },
    reference: {
      referenceId: reference.referenceId,
      referenceModel: reference.referenceModel,
      queryProfileHash: queryProfileHash(reference.queryProfile),
      queryProfile: reference.queryProfile,
      statisticalPower: reference.statisticalPower,
      statisticalPowerEvidence: reference.statisticalPowerEvidence as unknown as Record<string, unknown>,
      selfTest: reference.selfTest,
      probes: reference.probes,
    },
    exchanges,
    result: {
      selectedProbeCount: reference.probes.length,
      parsedProbeCount: matchVector.filter((entry) => entry !== null).length,
      matchVector,
      matchVectorHash: fragment.matchVectorHash,
      stats: fragment.stats,
      verdict,
      verdictReason,
      outcomeReason: null,
      cost,
      cumulativeCost: cost,
    },
  }
  if (input.wrongCount === undefined && verdict !== audit.verdict) {
    throw new Error(`fixture produced ${fragment.verdict}, expected ${audit.verdict}`)
  }
  const written = await writeProxyAuditEvidence(input.directory, input.auditId, evidence)
  return { evidence, written, exchanges, matchVector, cost }
}
