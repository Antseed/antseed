import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReferenceQueryProfile } from '@antseed/fingerprints'
import { emptyAuditCostSummary, writeProxyAuditEvidence, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import {
  decideReferencePoint,
  REFERENCE_VOTE_DECISION_RULE,
  writeModelProbeConsensusEvidence,
  type ModelProbeConsensusEvidenceV1,
} from './model-consensus-evidence.js'

function audit(
  peerId: string,
  answer: number | null,
  match: 0 | 1 | null,
  verdict: 'SAME' | 'DIFF' | 'UNDETERMINED' = match === 1 ? 'SAME' : 'DIFF',
): ProxyAuditEvidenceV1 {
  return {
    version: 1, kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: '2026-08-13T10:00:00.000Z',
    buyerProxy: { baseUrl: 'http://127.0.0.1:8377', statePath: '/tmp/buyer.state.json', pid: 1 },
    target: { peerId, displayName: null, agentId: null, service: 'model-a' },
    reference: {
      referenceId: 'reference-1', referenceModel: 'model-a', queryProfileHash: `0x${'11'.repeat(32)}`,
      queryProfile: createReferenceQueryProfile({ upstreamModel: 'upstream/model-a' }),
      statisticalPower: 0.99, statisticalPowerEvidence: { power: 0.99 },
      selfTest: { hamming: 0, total: 1, coverage: 1, errorRate: 0,
        outcomes: [{ probeId: 'probe-1', answer: 10, match: 1 }] },
      probes: [{ id: 'probe-1', name: 'probe', domain: 'math', template: 'Value is ___.',
        consensus: 10, range: [0, 20], tolerance: { mode: 'absolute', value: 0 },
        enrollmentEvidence: { temperatures: [0, 0.7, 0.7], answers: [10, 10, 10], rule: 'rounded-exact-agreement' } }],
    },
    exchanges: [{
      batchIndex: 0, attemptCount: 1, requestIds: ['request-1'], probeIds: ['probe-1'],
      request: { method: 'POST', url: '/v1/chat/completions', headers: {}, bodyBase64: 'e30=', hash: 'local-request' },
      response: { statusCode: 200, headers: {}, bodyBase64: 'e30=', hash: 'local-response' },
      timing: { startedAt: 1, completedAt: 2, responseLatencyMs: 1 }, answers: [answer], matches: [match],
      status: 'succeeded', failureReason: null, cost: null,
      responseAuth: {
        requestId: 'request-1', status: 'verified', failureReason: null,
        record: { version: 1, requestId: 'request-1', buyerPeerId: '33'.repeat(20), sellerPeerId: peerId,
          advertisedService: 'model-a', provider: 'test', statusCode: 200,
          requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}`,
          responseStartedAt: 1, responseCompletedAt: 2, signature: `0x${'66'.repeat(65)}`,
          receivedAt: 3, verified: true, verificationError: null },
        signedPreimages: { encoding: 'antseed-http-codec-v1', signatureEncoding: 'antseed-response-auth-signing-v1',
          hashAlgorithm: 'keccak256', requestBase64: 'AA==', responseBase64: 'AA==',
          responseAuthSigningBase64: 'AA==', requestHash: `0x${'44'.repeat(32)}`, responseHash: `0x${'55'.repeat(32)}` },
      },
    }],
    result: { selectedProbeCount: 1, parsedProbeCount: match === null ? 0 : 1,
      matchVector: [match], matchVectorHash: `0x${'77'.repeat(32)}`,
      stats: { selfHamming: 0, selfTotal: 1, targetHamming: match === null ? 0 : match === 1 ? 0 : 1,
        targetTotal: match === null ? 0 : 1, selfCoverage: 1, targetCoverage: match === null ? 0 : 1,
        p0Cp99: 0.1, pValueBinomial: match === null ? null : 1 },
      verdict, verdictReason: null, cost: emptyAuditCostSummary() },
  }
}

test('reference point decisions confirm ties and require at least one eligible response', () => {
  assert.equal(decideReferencePoint(1, 0), 'CONFIRMED')
  assert.equal(decideReferencePoint(1, 1), 'CONFIRMED')
  assert.equal(decideReferencePoint(1, 2), 'REJECTED')
  assert.equal(decideReferencePoint(0, 0), 'NO_RESPONSE')
})

test('model consensus evidence aggregates authenticated seller support by probe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-model-consensus-'))
  try {
    const runDirectory = join(directory, 'audits', 'run-1')
    const results = []
    const sellers = [
      { match: 1 as const, verdict: 'SAME' as const },
      { match: 0 as const, verdict: 'DIFF' as const },
      { match: 1 as const, verdict: 'UNDETERMINED' as const },
    ]
    for (const [index, seller] of sellers.entries()) {
      const peerId = String(index + 1).repeat(40)
      const auditId = `audit-${index}`
      const written = await writeProxyAuditEvidence(
        join(runDirectory, 'sellers'),
        auditId,
        audit(peerId, seller.match ? 10 : 11, seller.match, seller.verdict),
      )
      results.push({ peerId, displayName: null, agentId: null, service: 'model-a', status: seller.verdict,
        auditId, parsedProbeCount: 1, probeCount: 1, correctProbeCount: seller.match,
        incorrectProbeCount: seller.match ? 0 : 1, correctRate: seller.match, requestCount: 1,
        cost: emptyAuditCostSummary(), evidencePath: written.path,
        evidenceHash: written.evidenceHash })
    }
    const written = await writeModelProbeConsensusEvidence({
      directory: runDirectory,
      referencesDirectory: join(directory, 'references'),
      runId: 'run-1', epoch: '2026-08-13', model: 'model-a',
      createdAt: '2026-08-13T10:01:00.000Z', results,
    })
    const evidence = JSON.parse(await readFile(written.consensusPath, 'utf8')) as {
      version: number
      evidenceLevel?: string
      scope: { referenceIntegrity: string; rawSellerResponses: string; paymentEvidence: boolean }
      reference: { relativeIntegrityPath: string }
      decisionRule: typeof REFERENCE_VOTE_DECISION_RULE
      summary: {
        authenticatedSellerCount: number
        eligibleSellerCount: number
        referenceMatchCount: number
        referenceMismatchCount: number
        eligibleAnswerCount: number
        referenceSupportCount: number
        referenceRejectCount: number
        confirmedReferencePointCount: number
        rejectedReferencePointCount: number
        noResponseReferencePointCount: number
        referencePointConfirmationRate: number | null
      }
      probes: Array<{
        sellerAnswers: Array<{
          responseAuthSignature: string
          rawResponse: {
            exchangePath: string
            responseAuthSignatureField: string
            signedResponsePreimageField: string
          }
        }>
        probeId: string
        domain: string
        name: string
        question: string
        acceptedAnswerInterval: { minimum: number; maximum: number; inclusive: boolean }
        sellerDecisions: Record<string, { count: number; peerIds: string[] }>
        globalDecision: { decision: string; requiredConfirmedSellerCount: number }
        referenceConsensus: number
        eligibleSellerAnswerCount: number
        referenceSupportCount: number
        referenceRejectCount: number
        referenceDecision: string
      }>
    }
    assert.equal(evidence.version, 1)
    assert.equal(evidence.evidenceLevel, undefined)
    assert.deepEqual(evidence.scope, {
      referenceConsensus: true,
      referenceIntegrity: 'linked-model-reference-file',
      sellerAnswers: 'verified-response-auth-with-exact-preimages-only',
      rawSellerResponses: 'linked-seller-exchange-files',
      paymentEvidence: false,
      onChainInclusionProof: false,
    })
    assert.deepEqual(evidence.summary, {
      probeCount: 1, auditedSellerCount: 3, authenticatedSellerCount: 3, eligibleSellerCount: 3,
      signedExchangeCount: 3, authenticatedAnswerCount: 3, referenceMatchCount: 2, referenceMismatchCount: 1,
      unparsedAnswerCount: 0, referenceMatchRate: 2 / 3, eligibleAnswerCount: 3,
      referenceSupportCount: 2, referenceRejectCount: 1, confirmedReferencePointCount: 1,
      rejectedReferencePointCount: 0, noResponseReferencePointCount: 0, referencePointConfirmationRate: 1,
    })
    assert.deepEqual(evidence.decisionRule, REFERENCE_VOTE_DECISION_RULE)
    assert.equal(evidence.probes[0]?.sellerAnswers.length, 3)
    assert.equal(evidence.probes[0]?.eligibleSellerAnswerCount, 3)
    assert.equal(evidence.probes[0]?.referenceSupportCount, 2)
    assert.equal(evidence.probes[0]?.referenceRejectCount, 1)
    assert.equal(evidence.probes[0]?.referenceDecision, 'CONFIRMED')
    assert.equal(
      evidence.probes[0]?.sellerAnswers[0]?.rawResponse.exchangePath,
      'sellers/1111111111111111111111111111111111111111/exchanges/000.json',
    )
    assert.equal(
      evidence.probes[0]?.sellerAnswers[0]?.rawResponse.signedResponsePreimageField,
      'responseAuth.signedPreimages.responseBase64',
    )
    assert.equal(
      evidence.probes[0]?.sellerAnswers[0]?.rawResponse.responseAuthSignatureField,
      'responseAuth.record.signature',
    )
    assert.equal(evidence.probes[0]?.probeId, 'probe-1')
    assert.equal(evidence.probes[0]?.domain, 'math')
    assert.equal(evidence.probes[0]?.name, 'probe')
    assert.equal(evidence.probes[0]?.question, 'Value is ___.')
    assert.deepEqual(evidence.probes[0]?.acceptedAnswerInterval, {
      minimum: 10, maximum: 10, inclusive: true,
    })
    assert.deepEqual(evidence.probes[0]?.sellerDecisions, {
      CONFIRMED: { count: 2, peerIds: ['1'.repeat(40), '3'.repeat(40)] },
      REJECTED: { count: 1, peerIds: ['2'.repeat(40)] },
      NO_RESPONSE: { count: 0, peerIds: [] },
      EXCLUDED: { count: 0, peerIds: [] },
    })
    assert.deepEqual(evidence.probes[0]?.globalDecision, {
      decision: 'CONFIRMED', eligibleSellerAnswerCount: 3, requiredConfirmedSellerCount: 2,
      confirmedSellerCount: 2, rejectedSellerCount: 1,
    })
    assert.equal(evidence.probes[0]?.sellerAnswers[0]?.responseAuthSignature, `0x${'66'.repeat(65)}`)
    assert.equal(evidence.probes[0]?.referenceConsensus, 10)
    assert.match(evidence.reference.relativeIntegrityPath, /^\.\.\/\.\.\/references\/reference-1\/probe-integrity\.json$/)
    assert.ok(written.referenceIntegrityPath)
    const integrity = JSON.parse(await readFile(written.referenceIntegrityPath!, 'utf8')) as {
      kind: string
      probes: Array<{ probe: { enrollmentEvidence?: unknown } }>
    }
    assert.equal(integrity.kind, 'antseed-kbf-reference-integrity')
    assert.ok(integrity.probes[0]?.probe.enrollmentEvidence)

    const manifest = JSON.parse(await readFile(written.manifestPath, 'utf8')) as {
      version: number
      evidenceLevel?: string
      scope: { rawSellerResponses: string }
    }
    assert.equal(manifest.version, 1)
    assert.equal(manifest.evidenceLevel, undefined)
    assert.equal(manifest.scope.rawSellerResponses, 'linked-seller-exchange-files')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('malformed output remains authenticated evidence but is excluded from reference voting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-model-consensus-malformed-'))
  try {
    const runDirectory = join(directory, 'audits', 'run-1')
    const peerId = '1'.repeat(40)
    const malformed = audit(peerId, null, null, 'UNDETERMINED')
    malformed.exchanges[0]!.outcomeReason = {
      code: 'malformed_output',
      summary: 'successful authenticated response contained no parseable final answers',
      retryable: false,
      source: 'provider',
      affectedBatchCount: 1,
      totalBatchCount: 1,
      nextAction: 'seller must return parseable output',
    }
    malformed.result.parsedProbeCount = 0
    malformed.result.stats.targetHamming = 0
    malformed.result.stats.targetTotal = 0
    malformed.result.stats.targetCoverage = 0
    malformed.result.outcomeReason = malformed.exchanges[0]!.outcomeReason
    const writtenEvidence = await writeProxyAuditEvidence(
      join(runDirectory, 'sellers'),
      'audit-malformed',
      malformed,
    )
    const written = await writeModelProbeConsensusEvidence({
      directory: runDirectory,
      referencesDirectory: join(directory, 'references'),
      runId: 'run-1',
      epoch: '2026-08-30',
      model: 'model-a',
      createdAt: '2026-08-30T10:01:00.000Z',
      results: [{
        peerId,
        displayName: null,
        agentId: null,
        service: 'model-a',
        status: 'UNDETERMINED',
        auditId: 'audit-malformed',
        parsedProbeCount: 0,
        probeCount: 1,
        correctProbeCount: 0,
        incorrectProbeCount: 0,
        correctRate: null,
        requestCount: 1,
        cost: emptyAuditCostSummary(),
        evidencePath: writtenEvidence.path,
        evidenceHash: writtenEvidence.evidenceHash,
      }],
    })
    const evidence = JSON.parse(await readFile(written.consensusPath, 'utf8')) as ModelProbeConsensusEvidenceV1
    assert.equal(evidence.summary.authenticatedSellerCount, 1)
    assert.equal(evidence.summary.eligibleSellerCount, 0)
    assert.equal(evidence.summary.authenticatedAnswerCount, 0)
    assert.equal(evidence.summary.eligibleAnswerCount, 0)
    assert.equal(evidence.sellers[0]?.eligibleForReferenceVote, false)
    assert.equal(evidence.probes[0]?.sellerAnswers[0]?.sellerDecision, 'EXCLUDED')
    assert.equal(
      evidence.probes[0]?.sellerAnswers[0]?.decisionReason,
      'malformed-output-batch-not-scoreable',
    )
    assert.equal(evidence.probes[0]?.referenceDecision, 'NO_RESPONSE')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
