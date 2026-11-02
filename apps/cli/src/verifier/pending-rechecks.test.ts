import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReferenceQueryProfile } from '@antseed/fingerprints'
import type { ModelVerificationTargetResult } from './model-run.js'
import { loadPendingDiffRechecks, pendingRecheckKey } from './pending-rechecks.js'
import { emptyAuditCostSummary, writeProxyAuditEvidence, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'

const PEER_A = 'aa'.repeat(20)
const PEER_B = 'bb'.repeat(20)

async function evidenceFor(directory: string, peerId: string, auditId: string) {
  const evidence: ProxyAuditEvidenceV1 = {
    version: 1,
    kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: '2026-10-27T12:00:00.000Z',
    buyerProxy: { baseUrl: 'http://127.0.0.1:8377', statePath: '/tmp/buyer.state.json', pid: 1 },
    target: { peerId, displayName: null, agentId: '7', service: 'model-a' },
    reference: {
      referenceId: `ref-${auditId}`,
      referenceModel: 'model-a',
      queryProfileHash: `0x${'44'.repeat(32)}`,
      queryProfile: createReferenceQueryProfile({ upstreamModel: 'model-a' }),
      statisticalPower: 0.9,
      statisticalPowerEvidence: {},
      selfTest: { hamming: 0, total: 1, coverage: 1, errorRate: 0 },
      probes: [],
    },
    exchanges: [],
    result: {
      selectedProbeCount: 1, parsedProbeCount: 1, matchVector: [0], matchVectorHash: `0x${'66'.repeat(32)}`,
      stats: { selfHamming: 0, selfTotal: 1, targetHamming: 1, targetTotal: 1, selfCoverage: 1, targetCoverage: 1, p0Cp99: 1, pValueBinomial: 0 },
      verdict: 'DIFF', verdictReason: 'test', cost: emptyAuditCostSummary(),
    },
  }
  return writeProxyAuditEvidence(join(directory, auditId), auditId, evidence)
}

function result(peerId: string, status: ModelVerificationTargetResult['status'], written: { path: string; evidenceHash: string }, extra: Partial<ModelVerificationTargetResult> = {}): ModelVerificationTargetResult {
  return {
    peerId, displayName: null, agentId: '7', service: 'model-a', status, auditId: `audit-${peerId.slice(0, 4)}`,
    parsedProbeCount: 1, probeCount: 1, correctProbeCount: 0, incorrectProbeCount: 1, correctRate: 0, requestCount: 1,
    cost: emptyAuditCostSummary(), evidencePath: written.path, evidenceHash: written.evidenceHash, ...extra,
  }
}

async function writeRun(evidenceDir: string, runId: string, completedAt: string, results: ModelVerificationTargetResult[], epoch = '28') {
  const summaryPath = join(evidenceDir, 'summaries', `${runId}.json`)
  await mkdir(join(evidenceDir, 'summaries'), { recursive: true })
  await writeFile(summaryPath, JSON.stringify({
    version: 1, kind: 'antseed-verifier-model-summary', runId, epoch, model: 'model-a',
    startedAt: completedAt, completedAt, results, failures: [], skipped: [], cost: emptyAuditCostSummary(), reasonCounts: {},
  }))
  await mkdir(join(evidenceDir, 'runs'), { recursive: true })
  await writeFile(join(evidenceDir, 'runs', `${runId}.json`), JSON.stringify({
    version: 1, kind: 'antseed-verifier-run-manifest', runId, state: 'completed', epoch, epochSource: 'onchain',
    epochStartedAt: completedAt, epochEndsAt: completedAt, startedAt: completedAt, completedAt, summaryPath: '',
    modelOrder: ['model-a'], failureCount: 0,
    models: [{ model: 'model-a', summaryPath, reportPath: '', resultCount: results.length, failureCount: 0, skippedCount: 0, cost: emptyAuditCostSummary(), reasonCounts: {} }],
  }))
}

test('a DIFF is never carried over: it is submitted as found, and another auditor confirms it', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'pending-rechecks-'))
  try {
    const a = await evidenceFor(evidenceDir, PEER_A, 'a1')
    const waiting = { reason: 'reference endpoint 402', since: '2026-10-27T12:00:00.000Z' }
    await writeRun(evidenceDir, 'run-1', '2026-10-27T13:00:00.000Z', [
      result(PEER_A, 'DIFF', a),
      // A run from before still marked its DIFF as waiting for its own recheck: no longer carried over.
      result(PEER_B, 'DIFF', a, { recheckPending: waiting }),
    ])
    assert.equal((await loadPendingDiffRechecks(evidenceDir, '28', ['model-a'])).size, 0)
  } finally {
    await rm(evidenceDir, { recursive: true, force: true })
  }
})

test('a close call waiting for its extra questions is carried over as an extension until extended', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'pending-rechecks-'))
  try {
    const a = await evidenceFor(evidenceDir, PEER_A, 'a1')
    const grey = {
      decisionRule: 'kbf-extension-v1' as const,
      responseAuthVerified: true,
      stats: { selfHamming: 30, selfTotal: 300, targetHamming: 22, targetTotal: 100, selfCoverage: 1, targetCoverage: 1, p0Cp99: 0.155, pValueBinomial: 0.05 },
    }
    await writeRun(evidenceDir, 'run-1', '2026-10-27T13:00:00.000Z', [
      result(PEER_A, 'SAME', a, { ...grey, extensionPending: { reason: 'no fresh questions', since: '2026-10-27T13:00:00.000Z' } }),
    ])
    let pending = await loadPendingDiffRechecks(evidenceDir, '28', ['model-a'])
    assert.equal(pending.get(pendingRecheckKey('model-a', PEER_A))?.kind, 'extension')

    // Extended in a later run, the pooled verdict is DIFF: final for this auditor, nothing left to carry over.
    await writeRun(evidenceDir, 'run-2', '2026-10-27T14:00:00.000Z', [
      result(PEER_A, 'DIFF', a, {
        ...grey,
        recheckPending: { reason: 'reference endpoint 402', since: '2026-10-27T14:00:00.000Z' },
        extension: {
          rule: 'kbf-extension-v1', auditId: 'x', status: 'DIFF', referenceId: 'r', probeCount: 1, parsedProbeCount: 1,
          correctProbeCount: 0, responseAuthVerified: true, cost: emptyAuditCostSummary(),
          evidencePath: a.path, evidenceHash: a.evidenceHash,
          firstLook: { status: 'SAME', pValue: 0.05 },
          pooled: { ...grey.stats, verdict: 'DIFF', verdictReason: null },
        },
      }),
    ])
    pending = await loadPendingDiffRechecks(evidenceDir, '28', ['model-a'])
    assert.equal(pending.get(pendingRecheckKey('model-a', PEER_A)), undefined)
  } finally {
    await rm(evidenceDir, { recursive: true, force: true })
  }
})
