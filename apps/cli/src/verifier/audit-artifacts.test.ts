import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendVerifierEvent,
  modelAuditsDirectory,
  modelAuditReportPath,
  modelAuditSellersDirectory,
  modelReferenceDirectory,
  readVerifierRunManifest,
  readVerifierStatus,
  writeEpochAuditSummary,
  writeModelAuditReports,
  writeModelAuditSummary,
  writeVerifierRunManifest,
  writeVerifierStatus,
} from './audit-artifacts.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'
import { REFERENCE_VOTE_DECISION_RULE } from './model-consensus-evidence.js'

test('verifier artifacts use model-first epoch directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-artifacts-'))
  try {
    const status = {
      version: 1 as const, kind: 'antseed-verifier-status' as const, state: 'running' as const,
      runId: 'run', epoch: '7', startedAt: '2026-08-06T00:00:00.000Z', completedAt: null,
      epochStartedAt: '2026-08-06T00:00:00.000Z', epochEndsAt: '2026-08-07T00:00:00.000Z',
      currentModel: 'Model A', currentPeerId: null, activeAudits: [], queuedAudits: 1,
      modelsCompleted: 0, modelsTotal: 1, auditsCompleted: 0, skipped: 1, failures: 0,
      cost: emptyAuditCostSummary(), message: 'running',
    }
    await writeVerifierStatus(directory, status)
    assert.deepEqual(await readVerifierStatus(directory), status)

    const auditPackDirectory = join(directory, 'audit-pack')
    await mkdir(join(auditPackDirectory, 'exchanges'), { recursive: true })
    await writeFile(join(auditPackDirectory, 'manifest.json'), JSON.stringify({
      files: [
        { path: 'evidence.json', purpose: 'Canonical complete audit evidence' },
        { path: 'exchanges/000.json', purpose: 'Signed exchange batch 0' },
      ],
    }))
    const consensusPath = join(modelAuditsDirectory(directory, '7', 'Model A', 'run'), 'probe-consensus.json')
    const referencePath = join(modelReferenceDirectory(directory, '7', 'Model A', 'reference:1'), 'probe-integrity.json')
    await mkdir(modelAuditsDirectory(directory, '7', 'Model A', 'run'), { recursive: true })
    await writeFile(consensusPath, JSON.stringify({
      version: 1,
      kind: 'antseed-verifier-model-probe-consensus',
      runId: 'run',
      epoch: '7',
      model: 'Model A',
      createdAt: status.startedAt,
      scope: {
        referenceConsensus: true,
        referenceIntegrity: 'linked-model-reference-file',
        sellerAnswers: 'verified-response-auth-with-exact-preimages-only',
        rawSellerResponses: 'linked-seller-exchange-files',
        paymentEvidence: false,
        onChainInclusionProof: false,
      },
      reference: null,
      decisionRule: REFERENCE_VOTE_DECISION_RULE,
      summary: {
        probeCount: 1, auditedSellerCount: 1, authenticatedSellerCount: 1, eligibleSellerCount: 1,
        signedExchangeCount: 1, authenticatedAnswerCount: 1, referenceMatchCount: 1,
        referenceMismatchCount: 0, unparsedAnswerCount: 0, referenceMatchRate: 1,
        eligibleAnswerCount: 1, referenceSupportCount: 1, referenceRejectCount: 0,
        confirmedReferencePointCount: 1, rejectedReferencePointCount: 0,
        noResponseReferencePointCount: 0, referencePointConfirmationRate: 1,
      },
      sellers: [],
      probes: [{
        probeId: 'probe-1', domain: 'math', name: 'test_weight', question: 'The test weight is ___.',
        range: [0, 20], tolerance: { mode: 'absolute', value: 0 },
        acceptedAnswerInterval: { minimum: 10, maximum: 10, inclusive: true },
        referenceId: 'reference:1', referenceConsensus: 10,
        referenceSelfTest: { answer: 10, match: 1 }, authenticatedSellerAnswerCount: 1,
        referenceMatchCount: 1, referenceMismatchCount: 0, unparsedAnswerCount: 0,
        referenceMatchRate: 1, eligibleSellerAnswerCount: 1, referenceSupportCount: 1,
        referenceRejectCount: 0, referenceSupportRate: 1, referenceDecision: 'CONFIRMED',
        sellerDecisions: {
          CONFIRMED: { count: 1, peerIds: ['11'.repeat(20)] },
          REJECTED: { count: 0, peerIds: [] },
          NO_RESPONSE: { count: 0, peerIds: [] },
          EXCLUDED: { count: 0, peerIds: [] },
        },
        globalDecision: {
          decision: 'CONFIRMED', eligibleSellerAnswerCount: 1, requiredConfirmedSellerCount: 1,
          confirmedSellerCount: 1, rejectedSellerCount: 0,
        },
        sellerAnswers: [{
          peerId: '11'.repeat(20), sellerVerdict: 'SAME', eligibleForReferenceVote: true,
          referenceVote: 'CONFIRM', sellerDecision: 'CONFIRMED',
          decisionReason: 'within-reference-tolerance',
          sellerEvidenceId: 'audit-1', evidenceHash: `0x${'34'.repeat(32)}`,
          batchIndex: 0, requestId: 'request-1', requestHash: `0x${'44'.repeat(32)}`,
          responseHash: `0x${'55'.repeat(32)}`, responseAuthSignature: `0x${'66'.repeat(65)}`,
          answer: 10, match: 1,
          rawResponse: {
            exchangePath: `sellers/${'11'.repeat(20)}/exchanges/000.json`,
            buyerProxyRequestField: 'request.bodyBase64', buyerProxyBodyField: 'response.bodyBase64',
            responseAuthSignatureField: 'responseAuth.record.signature',
            signedRequestPreimageField: 'responseAuth.signedPreimages.requestBase64',
            signedResponsePreimageField: 'responseAuth.signedPreimages.responseBase64',
            responseAuthSigningPreimageField: 'responseAuth.signedPreimages.responseAuthSigningBase64',
          },
        }],
      }],
    }))
    const modelPath = await writeModelAuditSummary(directory, '7', 'Model A', {
      version: 1, kind: 'antseed-verifier-model-summary', runId: 'run', epoch: '7', model: 'Model A',
      startedAt: status.startedAt, completedAt: status.startedAt, results: [{
        peerId: '11'.repeat(20), displayName: 'Seller A', status: 'SAME', parsedProbeCount: 10,
        probeCount: 10, correctProbeCount: 9, incorrectProbeCount: 1, correctRate: 0.9,
        agentId: '1', service: 'Model A', auditId: `0x${'12'.repeat(32)}`, requestCount: 1,
        cost: emptyAuditCostSummary(), evidencePath: join(auditPackDirectory, 'evidence.json'),
        evidenceHash: `0x${'34'.repeat(32)}`,
      }], failures: [], skipped: [], cost: emptyAuditCostSummary(),
      consensusEvidencePath: consensusPath,
      referenceIntegrityPath: referencePath,
    })
    assert.match(modelPath, /epochs\/7\/Model_A\/audits\/run\/summary\.json$/)
    assert.match(
      modelAuditSellersDirectory(directory, '7', 'Model A', 'run'),
      /epochs\/7\/Model_A\/audits\/run\/sellers$/,
    )
    assert.match(referencePath, /epochs\/7\/Model_A\/references\/reference_1\/probe-integrity\.json$/)

    const epochSummary = {
      version: 1 as const, kind: 'antseed-verifier-epoch-summary' as const, runId: 'run', epoch: '7',
      epochStartedAt: status.epochStartedAt, epochEndsAt: status.epochEndsAt,
      startedAt: status.startedAt, completedAt: status.startedAt,
      reportPaths: [{ model: 'Model A', path: modelAuditReportPath(directory, '7', 'Model A') }],
      models: [{
        model: 'Model A', summaryPath: modelPath, resultCount: 1, failureCount: 0, skippedCount: 0,
        reportPath: modelAuditReportPath(directory, '7', 'Model A'),
        cost: emptyAuditCostSummary(),
      }], failureCount: 0, cost: emptyAuditCostSummary(),
    }
    const epochPath = await writeEpochAuditSummary(directory, '7', epochSummary)
    assert.match(epochPath, /runs\/run\.summary\.json$/)
    await writeVerifierRunManifest(directory, {
      version: 1, kind: 'antseed-verifier-run-manifest', runId: 'run', state: 'completed', epoch: '7',
      epochSource: 'onchain', epochStartedAt: status.epochStartedAt, epochEndsAt: status.epochEndsAt,
      startedAt: status.startedAt, completedAt: status.startedAt, summaryPath: epochPath,
      modelOrder: ['Model A'], models: epochSummary.models, failureCount: 0,
    })
    const reports = await writeModelAuditReports(directory, '7', epochSummary)
    const reportPath = reports[0]!.path
    const report = await readFile(reportPath, 'utf8')
    assert.match(reportPath, /epochs\/7\/Model_A\/report\.html$/)
    assert.match(report, /^<!doctype html>/)
    assert.match(report, /Seller A \(111111111111…\)/)
    assert.match(report, /Open audit folder/)
    assert.match(report, /Probe consensus JSON/)
    assert.match(report, /href="#audit-integrity">Audit Integrity<\/a>/)
    assert.match(report, /class="probe-consensus" id="audit-integrity"/)
    assert.match(report, /Does the seller majority agree with the enrolled reference\?/)
    assert.match(report, /Every scoreable answer backed by verified ResponseAuth votes/)
    assert.match(report, /The test weight is ___\./)
    assert.match(report, /CONFIRMED — within the accepted answer interval \(1\)/)
    assert.match(report, /NO_RESPONSE — no eligible signed answer \(0\)/)
    assert.match(report, /Accepted answer interval/)
    assert.match(report, /Open signed exchange JSON/)
    assert.match(report, /href="audits\/run\/sellers\/1111111111111111111111111111111111111111\/exchanges\/000\.json"/)
    assert.doesNotMatch(report, /href="file:/)
    assert.match(report, /Confirmed reference points/)
    assert.match(report, /CONFIRMED/)
    assert.match(report, /Reference probe integrity/)
    assert.match(report, /Open folder/)
    assert.match(report, /Evidence JSON/)
    assert.match(report, /All evidence files \(4\)/)
    assert.match(report, /exchanges\/000\.json/)
    assert.doesNotMatch(report, /index\.html/)
    assert.equal((await readVerifierRunManifest(directory, 'run')).models[0]!.summaryPath, modelPath)
    const eventsPath = await appendVerifierEvent(directory, '7', { type: 'test', at: status.startedAt })
    assert.equal((await readFile(eventsPath, 'utf8')).trim().length > 0, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
