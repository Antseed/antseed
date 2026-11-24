// Test support: builds complete verifier runs with genuinely signed seller exchanges.
import { confirmationUndecidedReason } from './outcome-reason.js'
import { ALL_TESTS_FORMAT, earliestAuditorTime, inactiveChecks, readingsOfEvidence, storedRequestsOf, verdictOf } from './audit-checks.js'
import { METHODS } from './methods/index.js'
import { outputCapCost, summarizeOutputCap, type OutputCapV1 } from './methods/output-cap/output-cap.js'
import { outputEchoCost, summarizeOutputEcho, type OutputEchoV1 } from './methods/output-echo/output-echo.js'
import { flipsCost, summarizeFlips, type FlipsV1 } from './methods/flips/flips.js'
import type { AuditCheckId } from './audit-checks.js'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { keccak256, Wallet } from 'ethers'
import {
  KBF_AUDIT_VERIFY_OPTIONS,
  KBF_CALIBRATION_METHOD,
  aggregateKbfSelfTestOutcomes,
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
  modelAuditSellersDirectory,
  writeEpochAuditSummary,
  writeModelAuditSummary,
  writeVerifierRunManifest,
  type EpochAuditSummaryV1,
  type ModelAuditSummaryV1,
  type VerifierRunManifestV1,
} from './audit-artifacts.js'
import { writeJsonAtomic } from './atomic-files.js'
import { createDomainHomogeneousKbfBatches, kbfAuditBatches } from './kbf-batching.js'
import { buildKbfProbeRequestBody, type ModelVerificationTargetResult } from './model-run.js'
import { combineExtension } from './extension-round.js'
import {
  appendModelReferenceToBank,
  recordEpochQuestionPool,
  recordEpochSetCalibration,
  EPOCH_QUESTION_SET_METHOD,
  epochQuestionSetPath,
  selectEpochQuestionSet,
  type EpochQuestionSetV1,
} from './probe-bank.js'
import { ConcurrencyLimiter } from './audit-concurrency.js'
import {
  measureTokenizerReference,
  runTokenizerPrecheck,
  summarizeTokenizerPrecheck,
  tokenizerCrowd,
  tokenizerPrecheckCost,
  TOKENIZER_PRECHECK_RULE,
  type TokenizerBackerV1,
  type TokenizerPrecheckV1,
} from './methods/tokens/tokenizer-precheck.js'
import {
  addAuditCostSummaries,
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
  /** The audit's verdict over every test. UNDETERMINED answers like SAME, then is recorded as lacking verified ResponseAuth. */
  verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'
  /** The questions' own verdict; by default SAME beside a flag of another test, else `verdict`. */
  questionsVerdict?: 'SAME' | 'DIFF' | 'UNDETERMINED'
  /** Seller key that actually signs ResponseAuth (defaults to `seller`). */
  signer?: Wallet
  /** The run flagged the result as a confirmation of another auditor's DIFF. */
  confirmsDiff?: boolean
  /** Sets a second row of the same seller and model apart (its own audit and evidence file). */
  auditSalt?: string
  /** The row is another report's own result, as the epoch submission marks it. */
  offeredAsAlternate?: true
  /**
   * The seller signs input tokens from another tokenizer: the tokenizer pre-check finds a mismatch and the
   * audit is DIFF beside its questions. `verdict` must be DIFF.
   */
  tokenizerMismatch?: boolean
  /** The tokenizer pre-check ran and matched: the seller counts input like the model. The audit asks its questions. */
  tokenizerMatch?: boolean
  /**
   * A cap check record (`output-cap.ts`) written into the evidence. A `flag` makes the audit a DIFF with no
   * question asked, as in a real run; any other outcome is stored beside the questions.
   */
  outputCap?: OutputCapV1
  /** An echo check record (`output-echo.ts`), the same way. */
  outputEcho?: OutputEchoV1
  /** A FLIPS record (`flips.ts`), stored beside the questions as a run stores it. */
  flips?: FlipsV1
  /** The audit confirms another auditor's report: the tests it repeats and the report's chain time. */
  confirming?: { checks: AuditCheckId[]; reportedAt: number }
  /** Written as a CLI from before the all-tests format wrote it: the evidence names no `tests` format. */
  beforeAllTests?: true
  /**
   * The evidence's `noRecord` entries: the tests its run had none of for the model, which are not active. By default
   * every test the fixture gives no record, so a seller judged on its questions alone keeps the questions' verdict;
   * null for none, so a test without a record did not run for the seller and stays active.
   */
  noRecord?: Array<{ slot: string; reason: string }> | null
  reference?: KbfReferenceV1
  /**
   * A close-call first audit (`kbf-extension-v1`): `firstWrong` wrong answers on the first set, then
   * an extension set of the same size with `extensionWrong` wrong answers. `verdict` is ignored. Omit `extensionWrong` for a close call still waiting.
   * Under `rule: 'kbf-extension-v2'`, a pooled look still in the grey zone gets a second extra set with
   * `extension2Wrong` wrong answers (omit it for a close call waiting for that set).
   */
  closeCall?: {
    firstWrong: number
    extensionWrong?: number
    extension2Wrong?: number
    rule?: 'kbf-extension-v1' | 'kbf-extension-v2'
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

/** `referenceFixture` with other questions: ids `<prefix>-<n>` and new text, as a later build writes them. */
export function freshReferenceFixture(model: string, prefix: string, probeCount = 10): KbfReferenceV1 {
  const value = referenceFixture(model, probeCount)
  const ids = new Map(value.probes.map((probe, index) => [probe.id, `${prefix}-${index + 1}`]))
  value.probes = value.probes.map((probe, index) => ({
    ...probe, id: ids.get(probe.id)!, name: `${prefix} ${index + 1}`, template: `The ${model} ${prefix} value ${index + 1} is ___.`,
  }))
  value.selfTest.outcomes = value.selfTest.outcomes.map((outcome) => ({ ...outcome, probeId: ids.get(outcome.probeId)! }))
  value.contrasts = value.contrasts.map((contrast) => ({ ...contrast, distinguishingProbeIds: value.probes.map((probe) => probe.id) }))
  value.referenceId = computeReferenceId(value)
  return value
}

const NO_COST = { totalUsdMicros: '0', requestCount: 0, models: [], purposes: [] }

/**
 * The epoch's question set as `verifier run` makes it: `reference`'s questions are banked in the
 * epoch's own bank as its build, the set is selected from them in order and calibrated with a clean pass.
 */
export async function writeCalibratedEpochSet(input: {
  banksDir: string
  model: string
  epoch: string
  reference: KbfReferenceV1
  extensionCount?: number
}): Promise<EpochQuestionSetV1> {
  const appended = await appendModelReferenceToBank({
    banksDir: input.banksDir, model: input.model, epoch: input.epoch, reference: input.reference, cost: NO_COST,
  })
  await recordEpochQuestionPool({ banksDir: input.banksDir, model: input.model, epoch: input.epoch, probeIds: appended.addedProbeIds })
  const selection = await selectEpochQuestionSet({
    banksDir: input.banksDir, model: input.model, epoch: input.epoch, runId: 'set-run',
    extensionCount: input.extensionCount ?? 1, config: FIXTURE_CONFIG, shuffle: <T>(values: readonly T[]) => [...values],
  })
  if (selection.status !== 'ready') throw new Error(`no question set: ${selection.reason}`)
  const exchangesPath = join(input.banksDir, `${input.model}-calibration.exchanges.json`)
  const exchanges = JSON.stringify({ kind: 'antseed-reference-exchanges', exchanges: [] })
  await writeFile(exchangesPath, exchanges)
  return recordEpochSetCalibration({
    banksDir: input.banksDir, model: input.model, epoch: input.epoch, config: FIXTURE_CONFIG, passes: 1, cost: NO_COST,
    calibrations: [selection.set.reference, ...selection.set.extensions].map((reference) => {
      const outcomes = reference.probes.map((probe) => ({ probeId: probe.id, answers: [probe.consensus], matches: [1 as const] }))
      return {
        version: 1 as const, method: KBF_CALIBRATION_METHOD, passes: 1, ...aggregateKbfSelfTestOutcomes(outcomes),
        batches: kbfAuditBatches(reference.probes).map((batch, batchIndex) => ({
          pass: 0, batchIndex, probeIds: batch.probes.map((probe) => probe.id), promptVariantId: 'v1', attempts: 1,
        })),
        calibratedAt: '2026-10-07T00:00:00.000Z',
      }
    }),
    exchanges: {
      path: exchangesPath, sha256: `sha256:${createHash('sha256').update(exchanges).digest('hex')}`, exchangeCount: 0, requestCount: 0,
      upstream: {
        name: 'referenceEndpoint', type: 'openai', baseUrl: 'https://reference.test/v1', model: `upstream-${input.model}`,
        protocol: 'openai-chat-completions', request: { overrides: {}, omissions: [] }, providerPin: null,
      },
    },
  })
}

export function peerIdOf(wallet: Wallet): string {
  return wallet.address.slice(2).toLowerCase()
}

/**
 * Writes a completed run (summaries, signed evidence) and returns its manifest. Each audit's reference
 * is stored as a question set of the epoch (`epochs/<epoch>/fixture-sets/`), where a submit finds it.
 */
export async function writeSignedAuditRun(input: {
  evidenceDir: string
  banksDir: string
  runId: string
  epoch: string
  auditor: Wallet
  audits: FixtureAudit[]
  epochSource?: VerifierRunManifestV1['epochSource']
  /** Failures and skips of the run, per model, as its summary lists them. */
  failures?: Record<string, ModelAuditSummaryV1['failures']>
  skipped?: Record<string, ModelAuditSummaryV1['skipped']>
  /**
   * When the run's audits were made (default 2026-10-07T00:02:00Z, two minutes into the fixture epoch). A
   * confirmation must be made at least an hour after the report it answers (`same-check.ts`).
   */
  completedAt?: string
}): Promise<VerifierRunManifestV1> {
  // A model with only failures or skips in the run has its summary too.
  const models = [...new Set([...input.audits.map((audit) => audit.model), ...Object.keys(input.failures ?? {}), ...Object.keys(input.skipped ?? {})])]
  const completedAt = input.completedAt ?? '2026-10-07T00:02:00.000Z'
  const timestamps = {
    epochStartedAt: '2026-10-07T00:00:00.000Z',
    epochEndsAt: '2026-10-08T00:00:00.000Z',
    startedAt: new Date(Date.parse(completedAt) - 60_000).toISOString(),
    completedAt,
  }
  const summaryModels: EpochAuditSummaryV1['models'] = []
  for (const model of models) {
    const results: ModelAuditSummaryV1['results'] = []
    for (const [index, audit] of input.audits.filter((entry) => entry.model === model).entries()) {
      const reference = audit.reference ?? referenceFixture(model)
      const peerId = peerIdOf(audit.seller)
      const referencePath = join(dirname(epochQuestionSetPath(input.banksDir, model, input.epoch)), 'fixture-sets', `${peerId}.json`)
      await mkdir(dirname(referencePath), { recursive: true })
      await writeJsonAtomic(referencePath, {
        version: 1,
        kind: 'antseed-kbf-epoch-question-set',
        method: EPOCH_QUESTION_SET_METHOD,
        model,
        epoch: input.epoch,
        compatibilityHash: `0x${'00'.repeat(32)}`,
        candidateProbeCount: reference.probes.length,
        reference,
        extensions: [],
        createdAt: timestamps.startedAt,
        createdByRunId: input.runId,
      })
      const auditId = canonicalHashBytes32({ fixture: input.runId, model, peerId, ...(audit.auditSalt ? { salt: audit.auditSalt } : {}) })
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
        // A second row of one seller comes from another run in real use: its own directory.
        directory: modelAuditSellersDirectory(input.evidenceDir, input.epoch, model, audit.auditSalt ? `${input.runId}-${audit.auditSalt}` : input.runId),
      })
      const { evidence, written, exchanges, matchVector, cost, auditVerdict } = first
      const undecided = verdictOf(readingsOfEvidence(evidence, evidence.result.verdict), evidence.result.verdict, audit.confirming?.checks ?? null).undecidedConfirmation
      results.push({
        peerId,
        displayName: evidence.target.displayName,
        agentId: audit.agentId,
        service: audit.service,
        status: auditVerdict,
        questionsStatus: evidence.result.verdict,
        questionsOutcomeReason: null,
        ...(audit.confirmsDiff ? { confirmsDiff: true } : {}),
        ...(audit.offeredAsAlternate ? { offeredAsAlternate: true } : {}),
        ...(audit.confirming ? { confirming: [...audit.confirming.checks], confirmingReportedAt: audit.confirming.reportedAt } : {}),
        // As a real summary: its earliest request on the auditor's clock.
        ...(audit.confirming ? { firstRequestAt: earliestAuditorTime([evidence]) } : {}),
        // As a run settles it: a confirmation whose repeated tests did not decide says so.
        outcomeReason: undecided ? confirmationUndecidedReason(undecided, exchanges.length) : null,
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
        stats: evidence.result.stats,
        responseAuthVerified: evidence.exchanges.every((exchange) => exchange.status !== 'succeeded' || exchange.responseAuth.status === 'verified'),
        ...(evidence.tokenizerPrecheck ? { tokenizerPrecheck: summarizeTokenizerPrecheck(evidence.tokenizerPrecheck) } : {}),
        ...(evidence.outputCap ? { outputCap: summarizeOutputCap(evidence.outputCap) } : {}),
        ...(evidence.outputEcho ? { outputEcho: summarizeOutputEcho(evidence.outputEcho) } : {}),
        ...(evidence.flips ? { flips: summarizeFlips(evidence.flips) } : {}),
        inactive: inactiveChecks(evidence),
      })
    }
    const failures = input.failures?.[model] ?? []
    const skipped = input.skipped?.[model] ?? []
    const summaryPath = await writeModelAuditSummary(input.evidenceDir, input.epoch, model, {
      version: 1,
      kind: 'antseed-verifier-model-summary',
      runId: input.runId,
      epoch: input.epoch,
      model,
      startedAt: timestamps.startedAt,
      completedAt: timestamps.completedAt,
      results,
      failures,
      skipped,
      cost: emptyAuditCostSummary(),
    })
    summaryModels.push({
      model,
      summaryPath,
      resultCount: results.length,
      failureCount: failures.length,
      skippedCount: skipped.length,
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
  /** When the batches were sent, in milliseconds (the auditor's clock, which "fresh" reads). */
  sentAt?: number
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
      timing: { startedAt: input.sentAt ?? 1_000, completedAt: (input.sentAt ?? 1_000) + 1_000, responseLatencyMs: 1_000 },
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
      ...(audit.confirmsDiff ? { confirmsDiff: true } : {}),
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
      inactive: inactiveChecks(written.evidence),
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
  return result
}

/** A copy of a reference with new probe IDs, as an extension on fresh probes gets. */
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

/**
 * A tokenizer pre-check the seller fails in every round, made by the real pre-check against a seller that
 * genuinely signs responses whose input tokens come from another tokenizer than the reference's.
 */
async function signedTokenizerMismatch(input: {
  audit: FixtureAudit
  auditor: Wallet
  runId: string
  peerId: string
}): Promise<TokenizerPrecheckV1> {
  const { audit } = input
  const modelTokens = (text: string): number => Math.ceil(text.length / 4)
  const sellerTokens = (text: string): number => 9 + Math.ceil(text.length / 2.5)
  const reference = await measureTokenizerReference({
    ask: async (contents) => ({
      upstream: { name: 'referenceEndpoint', type: 'openai', model: audit.model },
      results: contents.map((content) => ({ inputTokens: 5 + modelTokens(content), cachedInput: false, provider: 'Provider-A', failure: null })),
    }),
  })
  const target = signedTokenizerSeller({ ...input, signer: audit.signer ?? audit.seller, count: sellerTokens })
  // The model's other sellers: two that sign the reference's count for the first round's text, each its own pair.
  const backers = async (): Promise<TokenizerBackerV1[]> => Promise.all([0, 1].map(async () => {
    const signer = new Wallet(Wallet.createRandom().privateKey)
    const backer = signedTokenizerSeller({ ...input, peerId: peerIdOf(signer), signer, count: (text) => 30 + modelTokens(text) })
    const record = await runTokenizerPrecheck({ ...backer, reference })
    return { peerId: backer.peerId, service: audit.service, ask: record.rounds[0]!.seller[0]! }
  }))
  return runTokenizerPrecheck({
    ...target,
    reference,
    crowd: async (own) => {
      const backing = await backers()
      return tokenizerCrowd([own.delta, ...backing.map((backer) => backer.ask.delta)], reference.rounds[0]!.delta!, TOKENIZER_PRECHECK_RULE, [], backing)
    },
  })
}

/** A pre-check that matched: the seller signs the model's own count. */
async function signedTokenizerMatch(input: {
  audit: FixtureAudit
  auditor: Wallet
  runId: string
  peerId: string
}): Promise<TokenizerPrecheckV1> {
  const modelTokens = (text: string): number => 5 + Math.ceil(text.length / 4)
  const reference = await measureTokenizerReference({
    ask: async (contents) => ({
      upstream: { name: 'referenceEndpoint', type: 'openai', model: input.audit.model },
      results: contents.map((content) => ({ inputTokens: modelTokens(content), cachedInput: false, provider: 'Provider-A', failure: null })),
    }),
  })
  const target = signedTokenizerSeller({ ...input, signer: input.audit.signer ?? input.audit.seller, count: (text) => 40 + modelTokens(text) })
  const record = await runTokenizerPrecheck({ ...target, reference })
  if (record.outcome !== 'match') throw new Error(`fixture pre-check gave ${record.outcome}, expected match`)
  return record
}

/** A seller of `audit`'s model behind the buyer proxy that signs, with `signer`, the input tokens `count` gives. */
function signedTokenizerSeller(input: {
  audit: FixtureAudit
  auditor: Wallet
  peerId: string
  signer: Wallet
  count: (text: string) => number
}): Pick<Parameters<typeof runTokenizerPrecheck>[0], 'proxyBaseUrl' | 'peerId' | 'service' | 'limiter' | 'fetchFn' | 'responseAuthReader'> & { peerId: string } {
  const { audit, peerId } = input
  const sent = new Map<string, Uint8Array>()
  const headers = { 'content-type': 'application/json' }
  return {
    proxyBaseUrl: 'http://127.0.0.1:8377',
    peerId,
    service: audit.service,
    limiter: new ConcurrencyLimiter(1),
    fetchFn: async (_url, init) => {
      const requestId = new Headers(init?.headers).get('x-antseed-request-id')!
      sent.set(requestId, init!.body as Uint8Array)
      return Response.json({}, {
        headers: {
          'x-antseed-request-id': requestId,
          'x-antseed-input-tokens': '100',
          'x-antseed-output-tokens': '20',
          'x-antseed-total-tokens': '120',
          'x-antseed-input-usd-per-million': '1',
          'x-antseed-output-usd-per-million': '2',
          'x-antseed-estimated-cost-usd': '0.00014',
          'x-antseed-token-source': 'usage',
          'x-antseed-provider': 'openai',
          'x-antseed-service': audit.routedService ?? audit.service,
        },
      })
    },
    responseAuthReader: {
      async waitForVerified({ requestId }) {
        const body = sent.get(requestId)!
        const content = (JSON.parse(new TextDecoder().decode(body)) as { messages: Array<{ content: string }> }).messages[0]!.content
        const request = { requestId, method: 'POST', path: '/v1/chat/completions', headers, body }
        const response = {
          requestId,
          statusCode: 200,
          headers,
          body: new TextEncoder().encode(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: input.count(content), completion_tokens: 3 },
          })),
        }
        const payload = createResponseAuthPayload({
          request,
          response,
          buyerPeerId: input.auditor.address,
          sellerPeerId: peerId,
          advertisedService: audit.routedService ?? audit.service,
          channelId: `0x${'cc'.repeat(32)}`,
          provider: 'openai',
          responseStartedAt: 1_000,
          responseCompletedAt: 2_000,
        }, input.signer)
        const { signature: _signature, ...unsigned } = payload
        const requestBytes = encodeHttpRequest(request)
        const responseBytes = encodeHttpResponse(response)
        return {
          requestId,
          status: 'verified',
          responseAuth: {
            ...payload, receivedAt: 2_500, verified: true, verificationError: null,
            requestPreimage: requestBytes, responsePreimage: responseBytes,
          },
          signedPreimages: {
            encoding: 'antseed-http-codec-v1',
            signatureEncoding: 'antseed-response-auth-signing-v1',
            requestBase64: Buffer.from(requestBytes).toString('base64'),
            responseBase64: Buffer.from(responseBytes).toString('base64'),
            responseAuthSigningBase64: Buffer.from(encodeResponseAuthSigningPayload(unsigned)).toString('base64'),
            requestHash: keccak256(requestBytes),
            responseHash: keccak256(responseBytes),
          },
          failureReason: null,
        }
      },
      close() {},
    },
  }
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
  const tokenizerPrecheck = audit.tokenizerMismatch
    ? await signedTokenizerMismatch({ audit, auditor: input.auditor, runId: input.runId, peerId })
    : null
  const precheckMatch = audit.tokenizerMatch
    ? await signedTokenizerMatch({ audit, auditor: input.auditor, runId: input.runId, peerId })
    : null
  // Every test runs and none ends the audit: the questions are asked beside a flag, and answer as
  // `questionsVerdict` says (by default SAME beside a flag, else as the audit's verdict).
  const flagged = Boolean(tokenizerPrecheck) || audit.outputCap?.outcome === 'flag' || audit.outputEcho?.outcome === 'flag'
  const questionsWanted = audit.questionsVerdict ?? (flagged ? 'SAME' : audit.verdict)
  const exchanges = signedExchanges({
    ...audit, verdict: questionsWanted, reference, auditor: input.auditor, runId: input.runId, wrongProbeIds, sentAt: Date.parse(timestamps.completedAt),
  })
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
  const undetermined = questionsWanted === 'UNDETERMINED' && input.wrongCount === undefined
  // As a real run: an UNDETERMINED for want of verified ResponseAuth has a successful batch whose reply is not verified.
  if (undetermined && exchanges[0]) exchanges[0] = { ...exchanges[0], responseAuth: { ...exchanges[0].responseAuth, status: 'invalid' } as never }
  // The questions' own verdict: the evidence's `result` (`ALL_TESTS_FORMAT`).
  const verdict = undetermined ? 'UNDETERMINED' as const : fragment.verdict
  const verdictReason = undetermined
    ? 'one or more successful proxy batches lacked valid verified ResponseAuth'
    : fragment.verdictReason
  const testCost = [
    ...(tokenizerPrecheck ? [tokenizerPrecheckCost(tokenizerPrecheck)] : []),
    ...(precheckMatch ? [tokenizerPrecheckCost(precheckMatch)] : []),
    ...(audit.outputCap ? [outputCapCost(audit.outputCap)] : []),
    ...(audit.outputEcho ? [outputEchoCost(audit.outputEcho)] : []),
    ...(audit.flips ? [flipsCost(audit.flips)] : []),
  ]
  const cost = addAuditCostSummaries(summarizeAuditExchangeCosts(exchanges), ...testCost)
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
    ...(tokenizerPrecheck ? { tokenizerPrecheck } : {}),
    ...(precheckMatch ? { tokenizerPrecheck: precheckMatch } : {}),
    ...(audit.outputCap ? { outputCap: audit.outputCap } : {}),
    ...(audit.outputEcho ? { outputEcho: audit.outputEcho } : {}),
    ...(audit.flips ? { flips: audit.flips } : {}),
    ...(audit.confirming ? { confirming: { checks: [...audit.confirming.checks], reportedAt: audit.confirming.reportedAt } } : {}),
    ...(audit.beforeAllTests ? {} : { tests: ALL_TESTS_FORMAT }),
    ...fixtureNoRecord(audit, {
      tokenizerPrecheck: tokenizerPrecheck ?? precheckMatch ?? undefined, outputCap: audit.outputCap, outputEcho: audit.outputEcho, flips: audit.flips,
    }),
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
  // The audit's verdict over every test (`verdictOf`), as a run settles it.
  const auditVerdict = verdictOf(readingsOfEvidence(evidence, verdict), verdict, audit.confirming?.checks ?? null).verdict
  if (input.wrongCount === undefined && (verdict !== questionsWanted || auditVerdict !== audit.verdict)) {
    throw new Error(`fixture produced questions ${verdict} and audit ${auditVerdict}, expected ${questionsWanted} and ${audit.verdict}`)
  }
  stampBuyerTimes(evidence, Date.parse(timestamps.completedAt))
  const written = await writeProxyAuditEvidence(input.directory, input.auditId, evidence)
  return { evidence, written, exchanges, matchVector, cost, auditVerdict }
}

/** The fixture's `noRecord` entries (`FixtureAudit.noRecord`), by default one for each test it gives no record. */
function fixtureNoRecord(audit: FixtureAudit, records: Record<string, unknown>): { noRecord?: Array<{ slot: string; reason: string }> } {
  if (audit.noRecord === null) return {}
  const entries = audit.noRecord ?? METHODS.filter((check) => records[check.slot] == null)
    .map((check) => ({ slot: check.slot, reason: `the fixture's run had none of ${check.texts.name} for the model` }))
  return entries.length > 0 ? { noRecord: entries } : {}
}

/**
 * What the buyer stores beside every signed reply a check keeps: when it received it (`receivedAt`, its own clock),
 * here the audit's time, so "fresh" reads the fixture's audit time. The records are copied first: a test may write one
 * record under several sellers.
 */
function stampBuyerTimes(evidence: ProxyAuditEvidenceV1, at: number): void {
  for (const slot of ['tokenizerPrecheck', 'outputCap', 'outputEcho'] as const) {
    if (evidence[slot]) (evidence as unknown as Record<string, unknown>)[slot] = structuredClone(evidence[slot])
  }
  for (const request of storedRequestsOf(evidence)) {
    const record = request.responseAuth?.record as { receivedAt?: number } | null | undefined
    if (record) record.receivedAt = at
  }
}
