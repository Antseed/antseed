import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalJsonStringify, createReferenceQueryProfile } from '@antseed/fingerprints'
import type { StoredRequestCost } from '@antseed/node'
import { writeModelAuditSummary, type VerifierRunManifestV1 } from './audit-artifacts.js'
import { writeModelProbeConsensusEvidence } from './model-consensus-evidence.js'
import { emptyAuditCostSummary, writeProxyAuditEvidence, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import {
  prepareModelVerificationBundle,
  readPreparedModelVerificationBundle,
  writeModelVerificationBundleEvidence,
} from './submission-bundles.js'
import type { ReferenceCostEntryV1 } from './probe-bank.js'

const verifierAddress = `0x${'aa'.repeat(20)}`
const sellerAddress = `0x${'bb'.repeat(20)}`

function auditEvidence(input: {
  peerId: string
  agentId: string
  service: string
  requestId: string
  verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'
  telemetryUsd: number
}): ProxyAuditEvidenceV1 {
  return {
    version: 1,
    kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: '2026-08-06T12:00:00.000Z',
    buyerProxy: { baseUrl: 'http://127.0.0.1:8377', statePath: '/tmp/buyer.state.json', pid: 1 },
    target: {
      peerId: input.peerId,
      displayName: input.peerId,
      agentId: input.agentId,
      service: input.service,
    },
    reference: {
      referenceId: 'reference-1',
      referenceModel: input.service,
      queryProfileHash: `0x${'11'.repeat(32)}`,
      queryProfile: createReferenceQueryProfile({ upstreamModel: input.service }),
      statisticalPower: 0.99,
      statisticalPowerEvidence: { power: 0.99 },
      selfTest: { hamming: 0, total: 1, coverage: 1, errorRate: 0 },
      probes: [{
        id: 'probe-1', name: 'probe', domain: 'test', template: 'Value is ___.',
        consensus: 1, range: [0, 2], tolerance: { mode: 'absolute', value: 0 },
      }],
    },
    exchanges: [{
      batchIndex: 0,
      attemptCount: 1,
      requestIds: [input.requestId],
      probeIds: ['probe-1'],
      request: {
        method: 'POST', url: 'http://127.0.0.1:8377/v1/chat/completions', headers: {},
        bodyBase64: '', hash: `0x${'22'.repeat(32)}`,
      },
      response: {
        statusCode: 200, headers: {}, bodyBase64: '', hash: `0x${'33'.repeat(32)}`,
      },
      timing: { startedAt: 1, completedAt: 2, responseLatencyMs: 1 },
      answers: [1],
      matches: [1],
      status: 'succeeded',
      failureReason: null,
      cost: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        estimatedCostUsd: input.telemetryUsd,
        tokenSource: 'usage',
        provider: 'test',
        service: input.service,
      },
      responseAuth: {
        requestId: input.requestId,
        status: 'verified',
        record: null,
        signedPreimages: null,
        failureReason: null,
      },
    }],
    result: {
      selectedProbeCount: 1,
      parsedProbeCount: 1,
      matchVector: [1],
      matchVectorHash: `0x${'44'.repeat(32)}`,
      stats: {
        selfHamming: 0, selfTotal: 1, targetHamming: 0, targetTotal: 1,
        selfCoverage: 1, targetCoverage: 1, p0Cp99: 0.1, pValueBinomial: 1,
      },
      verdict: input.verdict,
      verdictReason: null,
      cost: emptyAuditCostSummary(),
    },
  }
}

const referenceCost: ReferenceCostEntryV1 = {
  costId: `0x${'55'.repeat(32)}`,
  referenceId: 'reference-1',
  cost: {
    totalUsdMicros: '600000',
    requestCount: 1,
    models: [{
      model: 'model-a', requestCount: 1, inputTokens: 100, outputTokens: 20,
      inputUsdPerMillion: 1, outputUsdPerMillion: 2, costUsdMicros: '600000',
    }],
    purposes: [{
      purpose: 'target-model', model: 'model-a', requestCount: 1, inputTokens: 100, outputTokens: 20,
      inputUsdPerMillion: 1, outputUsdPerMillion: 2, costUsdMicros: '600000',
    }],
  },
  status: 'unclaimed',
  reservedEvidenceHash: null,
  claimedTransactionHash: null,
}

test('model bundles account costs once and derive deterministic IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-submission-bundle-'))
  try {
    const auditsDirectory = join(directory, 'audits')
    const audit1 = await writeProxyAuditEvidence(auditsDirectory, 'audit-1', auditEvidence({
      peerId: '11'.repeat(20), agentId: '7', service: 'model-a', requestId: 'request-1',
      verdict: 'SAME', telemetryUsd: 0.5,
    }))
    const audit2 = await writeProxyAuditEvidence(auditsDirectory, 'audit-2', auditEvidence({
      peerId: '22'.repeat(20), agentId: '8', service: 'model-a', requestId: 'request-2',
      verdict: 'DIFF', telemetryUsd: 0.25,
    }))
    const audit3 = await writeProxyAuditEvidence(auditsDirectory, 'audit-3', auditEvidence({
      peerId: '33'.repeat(20), agentId: '9', service: 'model-a', requestId: 'request-3',
      verdict: 'SAME', telemetryUsd: 9,
    }))
    const result = (peerId: string, agentId: string, auditId: string, written: typeof audit1, status: 'SAME' | 'DIFF') => ({
      peerId,
      displayName: peerId,
      agentId,
      service: 'model-a',
      status,
      auditId,
      parsedProbeCount: 1,
      probeCount: 1,
      correctProbeCount: status === 'SAME' ? 1 : 0,
      incorrectProbeCount: status === 'SAME' ? 0 : 1,
      correctRate: status === 'SAME' ? 1 : 0,
      requestCount: 1,
      cost: emptyAuditCostSummary(),
      evidencePath: written.path,
      evidenceHash: written.evidenceHash,
    })
    const modelResults = [
      result('11'.repeat(20), '7', 'audit-1', audit1, 'SAME'),
      result('22'.repeat(20), '8', 'audit-2', audit2, 'DIFF'),
      result('33'.repeat(20), '9', 'audit-3', audit3, 'SAME'),
    ]
    const consensus = await writeModelProbeConsensusEvidence({
      directory: join(directory, 'epochs', '4', 'model-a', 'audits', 'run-1'),
      referencesDirectory: join(directory, 'epochs', '4', 'model-a', 'references'),
      runId: 'run-1', epoch: '4', model: 'model-a', createdAt: '2026-08-06T12:05:00.000Z',
      results: modelResults,
    })
    const summaryPath = await writeModelAuditSummary(directory, '4', 'model-a', {
      version: 1,
      kind: 'antseed-verifier-model-summary',
      runId: 'run-1',
      epoch: '4',
      model: 'model-a',
      startedAt: '2026-08-06T12:00:00.000Z',
      completedAt: '2026-08-06T12:05:00.000Z',
      results: modelResults,
      failures: [],
      skipped: [],
      cost: emptyAuditCostSummary(),
      consensusEvidencePath: consensus.consensusPath,
      referenceIntegrityPath: consensus.referenceIntegrityPath ?? undefined,
    })
    const manifest: VerifierRunManifestV1 = {
      version: 1,
      kind: 'antseed-verifier-run-manifest',
      runId: 'run-1',
      state: 'completed',
      epoch: '4',
      epochSource: 'onchain',
      epochStartedAt: '2026-08-06T00:00:00.000Z',
      epochEndsAt: '2026-08-07T00:00:00.000Z',
      startedAt: '2026-08-06T12:00:00.000Z',
      completedAt: '2026-08-06T12:05:00.000Z',
      summaryPath: '/tmp/summary.json',
      modelOrder: ['model-a'],
      models: [{
        model: 'model-a', summaryPath, resultCount: 3, failureCount: 0, skippedCount: 0,
        cost: emptyAuditCostSummary(),
      }],
      failureCount: 0,
    }
    const storedCosts = new Map<string, StoredRequestCost>([[
      'request-1',
      {
        requestId: 'request-1', sellerPeerId: '11'.repeat(20), service: 'model-a',
        channelId: `0x${'66'.repeat(32)}`, authorizedCostUsdc: 1_200_000n,
        inputTokens: 100n, outputTokens: 20n, source: 'response', recordedAt: 3,
      },
    ]])
    const prepare = () => prepareModelVerificationBundle({
      evidenceDir: directory,
      manifest,
      model: 'model-a',
      modelSummaryPath: summaryPath,
      verifierAddress,
      requestCostLookup: { getRequestCost: (requestId) => storedCosts.get(requestId) ?? null },
      referenceCosts: [referenceCost],
      resolveAgentOwner: async (agentId) => agentId === 9n ? verifierAddress : sellerAddress,
    })
    const first = await prepare()
    const second = await prepare()

    assert.equal(first.evidenceHash, second.evidenceHash)
    assert.equal(first.evidence.consensus.referenceId, 'reference-1')
    assert.equal(first.evidence.consensus.summary.probeCount, 1)
    assert.equal(first.evidence.consensus.summary.noResponseReferencePointCount, 1)
    assert.match(first.evidence.consensus.evidenceHash, /^0x[0-9a-f]{64}$/)
    const consensusEvidence = JSON.parse(await readFile(consensus.consensusPath, 'utf8')) as { createdAt: string }
    consensusEvidence.createdAt = '2026-08-06T12:06:00.000Z'
    await writeFile(consensus.consensusPath, canonicalJsonStringify(consensusEvidence))
    const changedConsensus = await prepare()
    assert.notEqual(changedConsensus.evidence.consensus.evidenceHash, first.evidence.consensus.evidenceHash)
    assert.notEqual(changedConsensus.evidenceHash, first.evidenceHash)
    assert.equal(first.results.length, 2)
    assert.equal(first.evidence.results[1]!.modelShareBps, 0)
    assert.equal(first.evidence.inferenceCostUsdMicros, '1450000')
    assert.equal(first.evidence.referenceCostUsdMicros, '600000')
    assert.equal(first.evidence.totalAuditCostUsdMicros, '2050000')
    assert.equal(first.totalAuditCostUsdMicros, 2_050_000n)
    assert.equal(first.evidence.results[0]!.costSources[0]!.source, 'buyer-validated-request-cost')
    assert.equal(first.evidence.results[1]!.costSources[0]!.source, 'response-telemetry')
    assert.match(first.evidence.excludedAudits[0]!.reason, /self-audit/)
    await writeModelVerificationBundleEvidence(first)
    assert.equal((await readPreparedModelVerificationBundle({
      evidencePath: first.evidencePath,
      evidenceHash: first.evidenceHash,
    })).evidenceHash, first.evidenceHash)
    await writeFile(first.evidencePath, `${await readFile(first.evidencePath, 'utf8')} `)
    await assert.rejects(
      readPreparedModelVerificationBundle({
        evidencePath: first.evidencePath,
        evidenceHash: first.evidenceHash,
      }),
      /not canonical JSON/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
