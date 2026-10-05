import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Command } from 'commander'
import { createReferenceQueryProfile } from '@antseed/fingerprints'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from '../../../verifier/audit-artifacts.js'
import {
  emptyAuditCostSummary,
  writeProxyAuditEvidence,
  type ProxyAuditEvidenceV1,
} from '../../../verifier/proxy-evidence.js'
import { registerVerifierCommands } from './index.js'
import {
  filterCompatibleResumeCandidates,
  filterResumeCandidatesByPeer,
  loadResumeCandidates,
  normalizeVerifierPeerId,
  resolveRunModels,
  selectVerifierPeer,
  type ResumeCandidate,
} from './run.js'

function command(): Command {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  registerVerifierCommands(program)
  return program
}

test('verifier exposes registry-only run, reference, status, and submit workflows', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')
  assert.ok(verifier)
  assert.deepEqual(verifier.commands.map((entry) => entry.name()).sort(), ['reference', 'run', 'status', 'submit'])
})

test('verifier submit exposes model-bundle submission controls', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const submit = verifier.commands.find((entry) => entry.name() === 'submit')!
  assert.deepEqual(
    submit.options.map((option) => option.long),
    ['--run-id', '--dry-run', '--yes', '--rpc-url', '--publish-ipfs'],
  )
})

test('verifier reference exposes only the explicit build workflow', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const reference = verifier.commands.find((entry) => entry.name() === 'reference')!
  assert.deepEqual(reference.commands.map((entry) => entry.name()), ['build'])
  assert.deepEqual(reference.commands[0]!.registeredArguments.map((argument) => argument.name()), ['model'])
  assert.deepEqual(reference.commands[0]!.options.map((option) => option.long), ['--all'])
})

test('verifier run accepts one model or all configured models', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const run = verifier.commands.find((entry) => entry.name() === 'run')!
  assert.deepEqual(
    run.options.map((option) => option.long),
    ['--all', '--allow-probe-reuse', '--peer', '--resume-run'],
  )
  assert.deepEqual(run.registeredArguments.map((argument) => argument.name()), ['model'])
})

test('verifier peer selector normalizes supported peer ids', () => {
  assert.equal(normalizeVerifierPeerId(`0x${'AB'.repeat(20)}`), 'ab'.repeat(20))
  assert.equal(normalizeVerifierPeerId(`  ${'12'.repeat(20)}  `), '12'.repeat(20))
})

test('verifier peer selector rejects malformed peer ids', () => {
  assert.throws(() => normalizeVerifierPeerId('not-a-peer'), /exactly 40 hexadecimal characters/)
  assert.throws(() => normalizeVerifierPeerId('11'.repeat(19)), /exactly 40 hexadecimal characters/)
})

test('verifier peer selector requires the peer in the live snapshot', () => {
  const peerId = '11'.repeat(20)
  assert.equal(selectVerifierPeer([{ peerId }, { peerId: '22'.repeat(20) }], peerId).peerId, peerId)
  assert.throws(
    () => selectVerifierPeer([{ peerId }], '33'.repeat(20)),
    /not present in the buyer proxy's live discovered-peer snapshot/,
  )
})

test('verifier peer selector intersects resume candidates', () => {
  const selectedPeerId = '11'.repeat(20)
  const candidate = (peerId: string): ResumeCandidate => ({
    model: 'model-a',
    peerId,
    service: 'model-a',
    auditId: `0x${'22'.repeat(32)}`,
    reservationAuditId: `0x${'33'.repeat(32)}`,
    evidencePath: '/tmp/evidence.json',
    evidenceHash: `0x${'44'.repeat(32)}`,
    referenceId: 'reference',
    queryProfileHash: `0x${'55'.repeat(32)}`,
    probeIds: ['probe'],
    exchanges: [],
  })
  const selected = filterResumeCandidatesByPeer(new Map([
    ['selected', candidate(selectedPeerId)],
    ['other', candidate('66'.repeat(20))],
  ]), selectedPeerId)
  assert.deepEqual([...selected.keys()], ['selected'])
})

test('explicit resume limits model selection to the source manifest', () => {
  const verifier = {
    referenceEndpoint: {
      baseUrl: 'https://example.test',
      apiKeyEnv: 'TEST_API_KEY',
      sourceId: 'test',
      trust: 'trusted' as const,
      models: {
        'model-a': { upstreamModel: 'vendor/model-a' },
        'model-b': { upstreamModel: 'vendor/model-b' },
      },
    },
  }
  const manifest = {
    version: 1 as const,
    kind: 'antseed-verifier-run-manifest' as const,
    runId: 'source-run',
    state: 'completed' as const,
    epoch: '7',
    epochSource: 'utc-day' as const,
    epochStartedAt: '2026-08-10T00:00:00.000Z',
    epochEndsAt: '2026-08-11T00:00:00.000Z',
    startedAt: '2026-08-10T01:00:00.000Z',
    completedAt: '2026-08-10T02:00:00.000Z',
    summaryPath: '/tmp/summary.json',
    modelOrder: ['model-b'],
    models: [],
    failureCount: 0,
  }
  assert.deepEqual(resolveRunModels(verifier, undefined, false, manifest), ['model-b'])
  assert.deepEqual(resolveRunModels(verifier, 'MODEL-B', false, manifest), ['model-b'])
  assert.throws(
    () => resolveRunModels(verifier, 'model-a', false, manifest),
    /does not include model model-a/,
  )
})

test('second repair keeps the original seller reservation audit id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-resume-'))
  const originalAuditId = `0x${'11'.repeat(32)}`
  const firstRepairAuditId = `0x${'22'.repeat(32)}`
  const peerId = '33'.repeat(20)
  try {
    const evidence: ProxyAuditEvidenceV1 = {
      version: 1,
      kind: 'antseed-buyer-proxy-kbf-audit',
      evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
      createdAt: '2026-08-12T12:00:00.000Z',
      buyerProxy: { baseUrl: 'http://127.0.0.1:8377', statePath: '/tmp/buyer.state.json', pid: 1 },
      target: { peerId, displayName: null, agentId: null, service: 'claude-fable-5' },
      reference: {
        referenceId: 'fable-reference',
        referenceModel: 'claude-fable-5',
        queryProfileHash: `0x${'44'.repeat(32)}`,
        queryProfile: createReferenceQueryProfile({ upstreamModel: 'claude-fable-5' }),
        statisticalPower: 0.9,
        statisticalPowerEvidence: {},
        selfTest: { hamming: 0, total: 1, coverage: 1, errorRate: 0 },
        probes: [{
          id: 'probe-1', name: 'probe', domain: 'test', template: 'Value is ___.',
          consensus: 1, range: [0, 2], tolerance: { mode: 'absolute', value: 0 },
        }],
      },
      exchanges: [],
      resume: {
        parentAuditId: originalAuditId,
        parentEvidenceHash: `0x${'55'.repeat(32)}`,
        reusedBatchIndexes: [],
      },
      result: {
        selectedProbeCount: 1,
        parsedProbeCount: 0,
        matchVector: [null],
        matchVectorHash: `0x${'66'.repeat(32)}`,
        stats: {
          selfHamming: 0,
          selfTotal: 1,
          targetHamming: 0,
          targetTotal: 0,
          selfCoverage: 1,
          targetCoverage: 0,
          p0Cp99: 1,
          pValueBinomial: 1,
        },
        verdict: 'UNDETERMINED',
        verdictReason: 'no scoreable probes',
        cost: emptyAuditCostSummary(),
      },
    }
    const written = await writeProxyAuditEvidence(directory, firstRepairAuditId, evidence)
    const summaryPath = join(directory, 'summary.json')
    const summary = {
      version: 1,
      kind: 'antseed-verifier-model-summary',
      runId: 'first-repair-run',
      epoch: '2026-08-12',
      model: 'claude-fable-5',
      startedAt: evidence.createdAt,
      completedAt: evidence.createdAt,
      results: [{
        peerId,
        displayName: null,
        agentId: null,
        service: 'claude-fable-5',
        status: 'UNDETERMINED',
        outcomeReason: null,
        auditId: firstRepairAuditId,
        parsedProbeCount: 0,
        probeCount: 1,
        correctProbeCount: 0,
        incorrectProbeCount: 0,
        correctRate: 0,
        requestCount: 0,
        cost: emptyAuditCostSummary(),
        evidencePath: written.path,
        evidenceHash: written.evidenceHash,
      }],
      failures: [],
      skipped: [],
      cost: emptyAuditCostSummary(),
    } satisfies ModelAuditSummaryV1
    await writeFile(summaryPath, JSON.stringify(summary))
    const manifest = {
      version: 1,
      kind: 'antseed-verifier-run-manifest',
      runId: summary.runId,
      state: 'completed',
      epoch: summary.epoch,
      epochSource: 'utc-day',
      epochStartedAt: '2026-08-12T00:00:00.000Z',
      epochEndsAt: '2026-08-13T00:00:00.000Z',
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
      summaryPath: join(directory, 'epoch-summary.json'),
      modelOrder: [summary.model],
      models: [{
        model: summary.model,
        summaryPath,
        resultCount: 1,
        failureCount: 0,
        skippedCount: 0,
        cost: emptyAuditCostSummary(),
      }],
      failureCount: 0,
    } satisfies VerifierRunManifestV1

    const candidates = await loadResumeCandidates(manifest, ['claude-fable-5'])
    assert.equal(candidates.size, 1)
    const candidate = [...candidates.values()][0]
    assert.equal(candidate?.auditId, firstRepairAuditId)
    assert.equal(candidate?.reservationAuditId, originalAuditId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('automatic resume ignores candidates whose archived bank reservation no longer exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-stale-resume-'))
  const banksDir = join(directory, 'fresh-bank')
  const candidate = {
    model: 'claude-opus-4-6',
    peerId: '11'.repeat(20),
    service: 'claude-opus-4-6',
    auditId: `0x${'22'.repeat(32)}`,
    reservationAuditId: `0x${'33'.repeat(32)}`,
    evidencePath: join(directory, 'evidence.json'),
    evidenceHash: `0x${'44'.repeat(32)}`,
    referenceId: 'archived-reference',
    queryProfileHash: `0x${'55'.repeat(32)}`,
    probeIds: ['archived-probe'],
    exchanges: [],
  }
  try {
    const modelBankDir = join(banksDir, 'claude-opus-4-6')
    await mkdir(modelBankDir, { recursive: true })
    await writeFile(join(modelBankDir, 'bank.json'), JSON.stringify({
      referenceCosts: [],
      referenceTemplate: {
        generator: { name: 'antseed-simple-reference-builder', version: '3' },
      },
    }))
    const candidates = new Map([['candidate', candidate]])
    const automatic = await filterCompatibleResumeCandidates({
      candidates,
      banksDir,
      epoch: '2026-08-13',
      strict: false,
    })
    assert.equal(automatic.size, 0)
    await assert.rejects(
      filterCompatibleResumeCandidates({
        candidates,
        banksDir,
        epoch: '2026-08-13',
        strict: true,
      }),
      /incompatible with the active probe bank: probe bank for claude-opus-4-6 uses reference enrollment/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
