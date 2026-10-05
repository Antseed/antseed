import { readFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import {
  canonicalHashBytes32,
  type KbfProbe,
  type KbfReferenceV1,
  type ReferenceQueryProfileV1,
} from '@antseed/fingerprints'
import { writeJsonAtomic } from './atomic-files.js'
import type { ModelVerificationTargetResult } from './model-run.js'
import { verifyProxyAuditEvidenceFile, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import { safeServiceSlug } from './slug.js'

interface ReferenceIntegrityEvidenceV1 {
  version: 1
  kind: 'antseed-kbf-reference-integrity'
  referenceId: string
  referenceModel: string
  queryProfileHash: string
  queryProfile: ReferenceQueryProfileV1
  statisticalPower: number
  statisticalPowerEvidence: Record<string, unknown>
  selfTest: ProxyAuditEvidenceV1['reference']['selfTest']
  summary: {
    totalProbeCount: number
    referenceConsensusConfirmedCount: number
    referenceSelfMismatchCount: number
    referenceSelfMissingCount: number
  }
  probes: Array<{
    probe: KbfProbe
    referenceSelfTest: { answer: number | null; match: 0 | 1 | null }
    referenceConsensusConfirmed: boolean
  }>
}

export type ReferencePointDecision = 'CONFIRMED' | 'REJECTED' | 'NO_RESPONSE'
export type SellerReferencePointDecision = ReferencePointDecision | 'EXCLUDED'

export const REFERENCE_VOTE_DECISION_RULE = {
  unit: 'one-vote-per-authenticated-seller-per-probe',
  includedSellerVerdicts: ['SAME', 'DIFF', 'UNDETERMINED'],
  excludedSellerVerdicts: [],
  confirmationThresholdBps: 5_000,
  tiePolicy: 'confirm',
  noResponseDecision: 'NO_RESPONSE',
} as const

export function decideReferencePoint(referenceSupportCount: number, referenceRejectCount: number): ReferencePointDecision {
  const eligibleSellerAnswerCount = referenceSupportCount + referenceRejectCount
  if (eligibleSellerAnswerCount === 0) return 'NO_RESPONSE'
  return referenceSupportCount * 2 >= eligibleSellerAnswerCount ? 'CONFIRMED' : 'REJECTED'
}

export interface ModelProbeConsensusEvidenceV1 {
  version: 1
  kind: 'antseed-verifier-model-probe-consensus'
  runId: string
  epoch: string
  model: string
  createdAt: string
  scope: {
    referenceConsensus: true
    referenceIntegrity: 'linked-model-reference-file'
    sellerAnswers: 'verified-response-auth-with-exact-preimages-only'
    rawSellerResponses: 'linked-seller-exchange-files'
    paymentEvidence: false
    onChainInclusionProof: false
  }
  reference: {
    referenceId: string
    referenceModel: string
    upstreamModel: string
    sourceId: string | null
    integrityHash: string
    integrityPath: string
    relativeIntegrityPath: string
  } | null
  decisionRule: typeof REFERENCE_VOTE_DECISION_RULE
  summary: {
    probeCount: number
    auditedSellerCount: number
    authenticatedSellerCount: number
    eligibleSellerCount: number
    signedExchangeCount: number
    authenticatedAnswerCount: number
    referenceMatchCount: number
    referenceMismatchCount: number
    unparsedAnswerCount: number
    referenceMatchRate: number | null
    eligibleAnswerCount: number
    referenceSupportCount: number
    referenceRejectCount: number
    confirmedReferencePointCount: number
    rejectedReferencePointCount: number
    noResponseReferencePointCount: number
    referencePointConfirmationRate: number | null
  }
  sellers: Array<{
    sellerEvidenceId: string
    peerId: string
    verdict: ModelVerificationTargetResult['status']
    eligibleForReferenceVote: boolean
    evidenceHash: string
    evidencePath: string
    relativeEvidencePath: string
  }>
  probes: Array<{
    probeId: string
    domain: string
    name: string
    question: string
    range: [number, number]
    tolerance: KbfProbe['tolerance']
    acceptedAnswerInterval: {
      minimum: number
      maximum: number
      inclusive: true
    }
    referenceId: string
    referenceConsensus: number
    referenceSelfTest: { answer: number | null; match: 0 | 1 | null }
    authenticatedSellerAnswerCount: number
    referenceMatchCount: number
    referenceMismatchCount: number
    unparsedAnswerCount: number
    referenceMatchRate: number | null
    eligibleSellerAnswerCount: number
    referenceSupportCount: number
    referenceRejectCount: number
    referenceSupportRate: number | null
    referenceDecision: ReferencePointDecision
    sellerDecisions: Record<SellerReferencePointDecision, {
      count: number
      peerIds: string[]
    }>
    globalDecision: {
      decision: ReferencePointDecision
      eligibleSellerAnswerCount: number
      requiredConfirmedSellerCount: number
      confirmedSellerCount: number
      rejectedSellerCount: number
    }
    sellerAnswers: Array<{
      peerId: string
      sellerVerdict: ModelVerificationTargetResult['status']
      eligibleForReferenceVote: boolean
      referenceVote: 'CONFIRM' | 'REJECT' | null
      sellerDecision: Exclude<SellerReferencePointDecision, 'NO_RESPONSE'>
      decisionReason:
        | 'within-reference-tolerance'
        | 'outside-reference-tolerance'
        | 'missing-or-malformed-answer-in-completed-response'
        | 'malformed-output-batch-not-scoreable'
        | 'answer-not-scoreable'
      sellerEvidenceId: string
      evidenceHash: string
      batchIndex: number
      requestId: string
      requestHash: string
      responseHash: string
      responseAuthSignature: string
      rawResponse: {
        exchangePath: string
        buyerProxyRequestField: 'request.bodyBase64'
        buyerProxyBodyField: 'response.bodyBase64'
        responseAuthSignatureField: 'responseAuth.record.signature'
        signedRequestPreimageField: 'responseAuth.signedPreimages.requestBase64'
        signedResponsePreimageField: 'responseAuth.signedPreimages.responseBase64'
        responseAuthSigningPreimageField: 'responseAuth.signedPreimages.responseAuthSigningBase64'
      }
      answer: number | null
      match: 0 | 1 | null
    }>
  }>
}

interface ProbeAccumulator {
  probe: KbfProbe
  referenceId: string
  referenceSelfTest: { answer: number | null; match: 0 | 1 | null }
  sellerAnswers: ModelProbeConsensusEvidenceV1['probes'][number]['sellerAnswers']
}

export async function writeModelProbeConsensusEvidence(input: {
  directory: string
  referencesDirectory: string
  runId: string
  epoch: string
  model: string
  createdAt: string
  results: ModelVerificationTargetResult[]
  referenceSource?: KbfReferenceV1
}): Promise<{
  directory: string
  consensusPath: string
  manifestPath: string
  referenceIntegrityPath: string | null
}> {
  const probeById = new Map<string, ProbeAccumulator>()
  const sellers: ModelProbeConsensusEvidenceV1['sellers'] = []
  const authenticatedSellers = new Set<string>()
  const eligibleSellers = new Set<string>()
  let signedExchangeCount = 0
  let referenceEvidence: ProxyAuditEvidenceV1['reference'] | null = null
  let referenceEvidenceHash: string | null = null

  for (const result of input.results) {
    const evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
    const currentReferenceHash = canonicalHashBytes32(evidence.reference)
    if (referenceEvidenceHash && referenceEvidenceHash !== currentReferenceHash) {
      throw new Error(`conflicting reference evidence while building ${input.model} run ${input.runId}`)
    }
    referenceEvidence ??= evidence.reference
    referenceEvidenceHash ??= currentReferenceHash
    sellers.push({
      sellerEvidenceId: result.auditId,
      peerId: result.peerId,
      verdict: result.status,
      eligibleForReferenceVote: false,
      evidenceHash: result.evidenceHash,
      evidencePath: result.evidencePath,
      relativeEvidencePath: relativePath(input.directory, result.evidencePath),
    })
    const selfTestByProbeId = new Map(
      (evidence.reference.selfTest.outcomes ?? []).map((outcome) => [outcome.probeId, outcome]),
    )
    for (const probe of evidence.reference.probes) {
      const existing = probeById.get(probe.id)
      if (existing && canonicalHashBytes32(existing.probe) !== canonicalHashBytes32(probe)) {
        throw new Error(`conflicting reference probe ${probe.id} while building ${input.model} consensus evidence`)
      }
      if (!existing) {
        probeById.set(probe.id, {
          probe,
          referenceId: evidence.reference.referenceId,
          referenceSelfTest: selfTestByProbeId.get(probe.id) ?? { answer: null, match: null },
          sellerAnswers: [],
        })
      }
    }
    for (const exchange of evidence.exchanges) {
      const auth = exchange.responseAuth
      if (exchange.status !== 'succeeded'
        || auth.status !== 'verified'
        || !auth.record
        || !auth.signedPreimages
        || !auth.requestId) continue
      signedExchangeCount += 1
      authenticatedSellers.add(result.peerId.toLowerCase())
      if (exchange.matches.some((match) => match !== null)) {
        eligibleSellers.add(result.peerId.toLowerCase())
      }
      for (const [index, probeId] of exchange.probeIds.entries()) {
        const accumulator = probeById.get(probeId)
        if (!accumulator) continue
        const answer = exchange.answers[index] ?? null
        const match = exchange.matches[index] ?? null
        const sellerDecision = match === null
          ? 'EXCLUDED'
          : match === 1 ? 'CONFIRMED' : 'REJECTED'
        const decisionReason = match === null
          ? exchange.outcomeReason?.code === 'malformed_output'
            ? 'malformed-output-batch-not-scoreable'
            : 'answer-not-scoreable'
          : match === 1
            ? 'within-reference-tolerance'
            : answer === null
              ? 'missing-or-malformed-answer-in-completed-response'
              : 'outside-reference-tolerance'
        accumulator.sellerAnswers.push({
          peerId: result.peerId,
          sellerVerdict: result.status,
          eligibleForReferenceVote: match !== null,
          referenceVote: match === null
            ? null
            : match === 1 ? 'CONFIRM' : 'REJECT',
          sellerDecision,
          decisionReason,
          sellerEvidenceId: result.auditId,
          evidenceHash: result.evidenceHash,
          batchIndex: exchange.batchIndex,
          requestId: auth.requestId,
          requestHash: auth.record.requestHash,
          responseHash: auth.record.responseHash,
          responseAuthSignature: auth.record.signature,
          rawResponse: {
            exchangePath: relativePath(
              input.directory,
              join(dirname(result.evidencePath), 'exchanges', `${String(exchange.batchIndex).padStart(3, '0')}.json`),
            ),
            buyerProxyRequestField: 'request.bodyBase64',
            buyerProxyBodyField: 'response.bodyBase64',
            responseAuthSignatureField: 'responseAuth.record.signature',
            signedRequestPreimageField: 'responseAuth.signedPreimages.requestBase64',
            signedResponsePreimageField: 'responseAuth.signedPreimages.responseBase64',
            responseAuthSigningPreimageField: 'responseAuth.signedPreimages.responseAuthSigningBase64',
          },
          answer,
          match,
        })
      }
    }
  }

  const probes = [...probeById.values()]
    .sort((left, right) => left.probe.id.localeCompare(right.probe.id))
    .map((entry) => {
      const sellerAnswers = entry.sellerAnswers.sort((left, right) => left.peerId.localeCompare(right.peerId))
      const referenceMatchCount = sellerAnswers.filter((answer) => answer.match === 1).length
      const referenceMismatchCount = sellerAnswers.filter((answer) => answer.match === 0).length
      const authenticatedSellerAnswerCount = referenceMatchCount + referenceMismatchCount
      const confirmedPeerIds = sellerAnswers
        .filter((answer) => answer.sellerDecision === 'CONFIRMED')
        .map((answer) => answer.peerId)
      const rejectedPeerIds = sellerAnswers
        .filter((answer) => answer.sellerDecision === 'REJECTED')
        .map((answer) => answer.peerId)
      const excludedPeerIds = sellerAnswers
        .filter((answer) => answer.sellerDecision === 'EXCLUDED')
        .map((answer) => answer.peerId)
      const answeredPeerIds = new Set(sellerAnswers.map((answer) => answer.peerId.toLowerCase()))
      const noResponsePeerIds = sellers
        .filter((seller) => !answeredPeerIds.has(seller.peerId.toLowerCase()))
        .map((seller) => seller.peerId)
        .sort()
      const referenceSupportCount = confirmedPeerIds.length
      const referenceRejectCount = rejectedPeerIds.length
      const eligibleSellerAnswerCount = referenceSupportCount + referenceRejectCount
      const referenceDecision = decideReferencePoint(referenceSupportCount, referenceRejectCount)
      return {
        probeId: entry.probe.id,
        domain: entry.probe.domain,
        name: entry.probe.name,
        question: entry.probe.template,
        range: entry.probe.range,
        tolerance: entry.probe.tolerance,
        acceptedAnswerInterval: acceptedAnswerInterval(entry.probe),
        referenceId: entry.referenceId,
        referenceConsensus: entry.probe.consensus,
        referenceSelfTest: entry.referenceSelfTest,
        sellerAnswers,
        authenticatedSellerAnswerCount,
        referenceMatchCount,
        referenceMismatchCount,
        unparsedAnswerCount: sellerAnswers.filter((answer) => answer.answer === null).length,
        referenceMatchRate: authenticatedSellerAnswerCount === 0
          ? null
          : referenceMatchCount / authenticatedSellerAnswerCount,
        eligibleSellerAnswerCount,
        referenceSupportCount,
        referenceRejectCount,
        referenceSupportRate: eligibleSellerAnswerCount === 0
          ? null
          : referenceSupportCount / eligibleSellerAnswerCount,
        referenceDecision,
        sellerDecisions: {
          CONFIRMED: { count: confirmedPeerIds.length, peerIds: confirmedPeerIds },
          REJECTED: { count: rejectedPeerIds.length, peerIds: rejectedPeerIds },
          NO_RESPONSE: { count: noResponsePeerIds.length, peerIds: noResponsePeerIds },
          EXCLUDED: { count: excludedPeerIds.length, peerIds: excludedPeerIds },
        },
        globalDecision: {
          decision: referenceDecision,
          eligibleSellerAnswerCount,
          requiredConfirmedSellerCount: eligibleSellerAnswerCount === 0
            ? 0
            : Math.ceil(eligibleSellerAnswerCount / 2),
          confirmedSellerCount: referenceSupportCount,
          rejectedSellerCount: referenceRejectCount,
        },
      }
    })
  const referenceMatchCount = probes.reduce((total, probe) => total + probe.referenceMatchCount, 0)
  const referenceMismatchCount = probes.reduce((total, probe) => total + probe.referenceMismatchCount, 0)
  const authenticatedAnswerCount = referenceMatchCount + referenceMismatchCount
  const referenceSupportCount = probes.reduce((total, probe) => total + probe.referenceSupportCount, 0)
  const referenceRejectCount = probes.reduce((total, probe) => total + probe.referenceRejectCount, 0)
  const eligibleAnswerCount = referenceSupportCount + referenceRejectCount
  const confirmedReferencePointCount = probes.filter((probe) => probe.referenceDecision === 'CONFIRMED').length
  const rejectedReferencePointCount = probes.filter((probe) => probe.referenceDecision === 'REJECTED').length
  const noResponseReferencePointCount = probes.filter((probe) => probe.referenceDecision === 'NO_RESPONSE').length
  const decidedReferencePointCount = confirmedReferencePointCount + rejectedReferencePointCount
  const referenceIntegrity = referenceEvidence ? createReferenceIntegrityEvidence(referenceEvidence) : null
  const referenceIntegrityPath = referenceIntegrity
    ? join(input.referencesDirectory, safeServiceSlug(referenceIntegrity.referenceId), 'probe-integrity.json')
    : null
  if (referenceIntegrity && referenceIntegrityPath) await writeJsonAtomic(referenceIntegrityPath, referenceIntegrity, true)
  const reference = referenceIntegrity && referenceIntegrityPath ? {
    referenceId: referenceIntegrity.referenceId,
    referenceModel: referenceIntegrity.referenceModel,
    upstreamModel: referenceIntegrity.queryProfile.upstreamModel,
    sourceId: referenceSourceId(input.referenceSource, referenceIntegrity.referenceId),
    integrityHash: canonicalHashBytes32(referenceIntegrity),
    integrityPath: referenceIntegrityPath,
    relativeIntegrityPath: relativePath(input.directory, referenceIntegrityPath),
  } : null
  const consensus: ModelProbeConsensusEvidenceV1 = {
    version: 1,
    kind: 'antseed-verifier-model-probe-consensus',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    createdAt: input.createdAt,
    scope: {
      referenceConsensus: true,
      referenceIntegrity: 'linked-model-reference-file',
      sellerAnswers: 'verified-response-auth-with-exact-preimages-only',
      rawSellerResponses: 'linked-seller-exchange-files',
      paymentEvidence: false,
      onChainInclusionProof: false,
    },
    reference,
    decisionRule: REFERENCE_VOTE_DECISION_RULE,
    summary: {
      probeCount: probes.length,
      auditedSellerCount: input.results.length,
      authenticatedSellerCount: authenticatedSellers.size,
      eligibleSellerCount: eligibleSellers.size,
      signedExchangeCount,
      authenticatedAnswerCount,
      referenceMatchCount,
      referenceMismatchCount,
      unparsedAnswerCount: probes.reduce((total, probe) => total + probe.unparsedAnswerCount, 0),
      referenceMatchRate: authenticatedAnswerCount === 0 ? null : referenceMatchCount / authenticatedAnswerCount,
      eligibleAnswerCount,
      referenceSupportCount,
      referenceRejectCount,
      confirmedReferencePointCount,
      rejectedReferencePointCount,
      noResponseReferencePointCount,
      referencePointConfirmationRate: decidedReferencePointCount === 0
        ? null
        : confirmedReferencePointCount / decidedReferencePointCount,
    },
    sellers: sellers
      .map((seller) => ({
        ...seller,
        eligibleForReferenceVote: eligibleSellers.has(seller.peerId.toLowerCase()),
      }))
      .sort((left, right) => left.peerId.localeCompare(right.peerId)),
    probes,
  }
  const consensusPath = join(input.directory, 'probe-consensus.json')
  await writeJsonAtomic(consensusPath, consensus, true)
  const manifest = {
    version: 1,
    kind: 'antseed-verifier-model-evidence-pack',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    scope: consensus.scope,
    reference,
    files: [{
      path: 'probe-consensus.json',
      hash: canonicalHashBytes32(consensus),
      purpose: 'Reference consensus and authenticated seller support by probe',
    }],
  }
  const manifestPath = join(input.directory, 'manifest.json')
  await writeJsonAtomic(manifestPath, manifest, true)
  return { directory: input.directory, consensusPath, manifestPath, referenceIntegrityPath }
}

function referenceSourceId(reference: KbfReferenceV1 | undefined, expectedReferenceId: string): string | null {
  if (!reference || reference.referenceId !== expectedReferenceId) return null
  const provenanceSourceId = reference.provenance?.sourceId
  if (typeof provenanceSourceId === 'string' && provenanceSourceId.length > 0) return provenanceSourceId
  const generatorSourceId = reference.generator.params.sourceId
  return typeof generatorSourceId === 'string' && generatorSourceId.length > 0 ? generatorSourceId : null
}

function acceptedAnswerInterval(probe: KbfProbe): {
  minimum: number
  maximum: number
  inclusive: true
} {
  const distance = probe.tolerance.mode === 'absolute'
    ? probe.tolerance.value
    : Math.abs(probe.consensus) * probe.tolerance.value
  return {
    minimum: stableDisplayNumber(probe.consensus - distance),
    maximum: stableDisplayNumber(probe.consensus + distance),
    inclusive: true,
  }
}

function stableDisplayNumber(value: number): number {
  return Number(value.toPrecision(15))
}

export async function writeModelAuditManifest(input: {
  directory: string
  runId: string
  epoch: string
  model: string
  summaryPath: string
  consensusPath: string
  referenceIntegrityPath: string | null
  results: ModelVerificationTargetResult[]
}): Promise<string> {
  const summary = JSON.parse(await readFile(input.summaryPath, 'utf8')) as unknown
  const consensus = JSON.parse(await readFile(input.consensusPath, 'utf8')) as ModelProbeConsensusEvidenceV1
  const manifest = {
    version: 1,
    kind: 'antseed-verifier-model-evidence-pack',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    scope: consensus.scope,
    reference: consensus.reference,
    files: [
      {
        path: relativePath(input.directory, input.summaryPath),
        hash: canonicalHashBytes32(summary),
        purpose: 'Seller results, failures, skips, cost, and outcome reasons for this model run',
      },
      {
        path: relativePath(input.directory, input.consensusPath),
        hash: canonicalHashBytes32(consensus),
        purpose: 'Reference consensus and authenticated seller support by probe',
      },
    ],
    sellers: input.results
      .map((result) => ({
        peerId: result.peerId,
        sellerEvidenceId: result.auditId,
        evidenceHash: result.evidenceHash,
        evidencePath: relativePath(input.directory, result.evidencePath),
      }))
      .sort((left, right) => left.peerId.localeCompare(right.peerId)),
    referenceIntegrityPath: input.referenceIntegrityPath
      ? relativePath(input.directory, input.referenceIntegrityPath)
      : null,
  }
  const manifestPath = join(input.directory, 'manifest.json')
  await writeJsonAtomic(manifestPath, manifest, true)
  return manifestPath
}

function createReferenceIntegrityEvidence(reference: ProxyAuditEvidenceV1['reference']): ReferenceIntegrityEvidenceV1 {
  const selfTestByProbeId = new Map(
    (reference.selfTest.outcomes ?? []).map((outcome) => [outcome.probeId, outcome]),
  )
  const probes = reference.probes.map((probe) => {
    const referenceSelfTest = selfTestByProbeId.get(probe.id) ?? { answer: null, match: null }
    return {
      probe,
      referenceSelfTest,
      referenceConsensusConfirmed: referenceSelfTest.match === 1,
    }
  })
  return {
    version: 1,
    kind: 'antseed-kbf-reference-integrity',
    referenceId: reference.referenceId,
    referenceModel: reference.referenceModel,
    queryProfileHash: reference.queryProfileHash,
    queryProfile: reference.queryProfile,
    statisticalPower: reference.statisticalPower,
    statisticalPowerEvidence: reference.statisticalPowerEvidence,
    selfTest: reference.selfTest,
    summary: {
      totalProbeCount: probes.length,
      referenceConsensusConfirmedCount: probes.filter((entry) => entry.referenceSelfTest.match === 1).length,
      referenceSelfMismatchCount: probes.filter((entry) => entry.referenceSelfTest.match === 0).length,
      referenceSelfMissingCount: probes.filter((entry) => entry.referenceSelfTest.match === null).length,
    },
    probes,
  }
}

function relativePath(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}
