import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createReferenceQueryProfile } from '@antseed/fingerprints'
import {
  addAuditCostSummaries,
  deriveProxyAuditId,
  emptyAuditCostSummary,
  parseProxyAuditExchangeCost,
  proxyAuditEvidenceHash,
  verifyProxyAuditEvidenceFile,
  writeProxyAuditEvidence,
  type ProxyAuditEvidenceV1,
} from './proxy-evidence.js'

function evidence(): ProxyAuditEvidenceV1 {
  return {
    version: 1,
    kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: '2026-08-05T12:00:00.000Z',
    buyerProxy: {
      baseUrl: 'http://127.0.0.1:8377',
      statePath: '/tmp/buyer.state.json',
      pid: 123,
    },
    target: {
      peerId: '22'.repeat(20),
      displayName: 'test',
      agentId: '7',
      service: 'gpt-test',
    },
    reference: {
      referenceId: 'reference-1',
      referenceModel: 'gpt-test',
      queryProfileHash: `0x${'44'.repeat(32)}`,
      queryProfile: createReferenceQueryProfile({ upstreamModel: 'gpt-test' }),
      statisticalPower: 0.99,
      statisticalPowerEvidence: { power: 0.99 },
      selfTest: { hamming: 0, total: 1, coverage: 1, errorRate: 0 },
      probes: [{
        id: 'probe-1', name: 'probe', domain: 'test', template: 'Value is ___.',
        consensus: 1, range: [0, 2], tolerance: { mode: 'absolute', value: 0 },
      }],
    },
    exchanges: [],
    result: {
      selectedProbeCount: 1,
      parsedProbeCount: 1,
      matchVector: [1],
      matchVectorHash: `0x${'55'.repeat(32)}`,
      stats: {
        selfHamming: 0,
        selfTotal: 1,
        targetHamming: 0,
        targetTotal: 1,
        selfCoverage: 1,
        targetCoverage: 1,
        p0Cp99: 0.1,
        pValueBinomial: 1,
      },
      verdict: 'SAME',
      verdictReason: null,
      cost: emptyAuditCostSummary(),
    },
  }
}

test('canonical proxy evidence round-trips and derives a stable audit id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-proxy-evidence-'))
  try {
    const value = evidence()
    const hash = proxyAuditEvidenceHash(value)
    const auditId = deriveProxyAuditId({
      targetPeerId: value.target.peerId,
      referenceId: value.reference.referenceId,
      completedAt: Date.parse(value.createdAt),
      evidenceHash: hash,
    })
    const written = await writeProxyAuditEvidence(directory, auditId, value)
    assert.equal(written.evidenceHash, hash)
    assert.equal((await readFile(written.path, 'utf8')).endsWith('\n'), false)
    assert.deepEqual(await verifyProxyAuditEvidenceFile(written.path, hash), value)
    const packDirectory = join(directory, value.target.peerId)
    assert.deepEqual((await readdir(packDirectory)).sort(), [
      'README.md', 'evidence.json', 'exchanges', 'manifest.json',
    ])
    const manifest = JSON.parse(await readFile(join(packDirectory, 'manifest.json'), 'utf8')) as {
      evidenceLevel: string
      scope: { paymentEvidence: boolean; onChainInclusionProof: boolean }
    }
    assert.equal(manifest.evidenceLevel, value.evidenceLevel)
    assert.deepEqual(manifest.scope, {
      responseAuthentication: 'seller-signed-response-auth',
      exactSignedPreimages: true,
      paymentEvidence: false,
      onChainInclusionProof: false,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('proxy telemetry headers produce additive audit costs', () => {
  const cost = parseProxyAuditExchangeCost({
    'x-antseed-input-tokens': '100',
    'x-antseed-output-tokens': '20',
    'x-antseed-total-tokens': '120',
    'x-antseed-input-usd-per-million': '1',
    'x-antseed-output-usd-per-million': '2',
    'x-antseed-estimated-cost-usd': '0.00014',
    'x-antseed-token-source': 'usage',
    'x-antseed-provider': 'test',
    'x-antseed-service': 'gpt-test',
  })
  assert.deepEqual(cost, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    estimatedCostUsd: 0.00014,
    tokenSource: 'usage',
    provider: 'test',
    service: 'gpt-test',
  })
  const total = addAuditCostSummaries({
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    estimatedCostUsd: 0.00014,
    pricedExchangeCount: 1,
    missingCostExchangeCount: 0,
  }, {
    inputTokens: 50,
    outputTokens: 10,
    totalTokens: 60,
    estimatedCostUsd: 0.00007,
    pricedExchangeCount: 1,
    missingCostExchangeCount: 1,
  })
  assert.deepEqual({ ...total, estimatedCostUsd: 0 }, {
    inputTokens: 150,
    outputTokens: 30,
    totalTokens: 180,
    estimatedCostUsd: 0,
    pricedExchangeCount: 2,
    missingCostExchangeCount: 1,
  })
  assert.ok(Math.abs(total.estimatedCostUsd - 0.00021) < 1e-12)
  assert.equal(parseProxyAuditExchangeCost({ 'x-antseed-input-tokens': '100' }), null)
})

test('proxy evidence verification rejects non-canonical files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-proxy-evidence-'))
  try {
    const value = evidence()
    const hash = proxyAuditEvidenceHash(value)
    const written = await writeProxyAuditEvidence(directory, 'audit', value)
    await writeFile(written.path, `${await readFile(written.path, 'utf8')}\n`)
    await assert.rejects(verifyProxyAuditEvidenceFile(written.path, hash), /not canonical/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
