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
import { setAuditedModelsForTesting } from '../../../verifier/audited-models.js'
import { registerVerifierCommands } from './index.js'
import { validateRunEpoch } from './submit.js'
import {
  enrollmentRequestBudget,
  filterCompatibleResumeCandidates,
  filterResumeCandidatesByPeer,
  loadResumeCandidates,
  normalizeVerifierPeerId,
  resolveAssignedAuditModels,
  resolveRunModels,
  selectVerifierPeer,
  isAssignedMode,
  validateAssignedModeOptions,
  type ResumeCandidate,
} from './run.js'

setAuditedModelsForTesting({
  'model-a': { upstreamModel: 'vendor/model-a' },
  'model-b': { upstreamModel: 'vendor/model-b' },
  'model-c': { upstreamModel: 'vendor/model-c' },
})

function command(): Command {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined })
  registerVerifierCommands(program)
  return program
}

test('verifier exposes run, assignment, models, overview, reference, status, submit, rewards, and check workflows', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')
  assert.ok(verifier)
  assert.deepEqual(
    verifier.commands.map((entry) => entry.name()).sort(),
    ['assignment', 'check', 'models', 'overview', 'reference', 'rewards', 'run', 'status', 'submit'],
  )
})

test('verifier submit and rewards expose the auditor controls', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const options = (name: string) => verifier.commands.find((entry) => entry.name() === name)!
    .options.map((option) => option.long)
  assert.deepEqual(options('submit'), ['--run-id', '--no-publish-ipfs', '--dry-run', '--publish-only', '--auditor', '--yes', '--rpc-url', '--keystore', '--skip-version-check'])
  assert.deepEqual(options('rewards'), ['--epochs', '--claim', '--yes', '--auditor', '--rpc-url'])
})

test('verifier reference exposes only the explicit build workflow', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const reference = verifier.commands.find((entry) => entry.name() === 'reference')!
  assert.deepEqual(reference.commands.map((entry) => entry.name()), ['build'])
  assert.deepEqual(reference.commands[0]!.registeredArguments.map((argument) => argument.name()), ['model'])
  assert.deepEqual(reference.commands[0]!.options.map((option) => option.long), ['--all'])
})

test('verifier run accepts one model, all configured models, or an auditor assignment', () => {
  const verifier = command().commands.find((entry) => entry.name() === 'verifier')!
  const run = verifier.commands.find((entry) => entry.name() === 'run')!
  assert.deepEqual(
    run.options.map((option) => option.long),
    ['--all', '--auditor', '--allow-probe-reuse', '--peer', '--resume-run', '--no-enroll', '--max-enrollment-requests', '--ignore-pre-run-checks', '--fresh', '--skip-version-check', '--max-rounds'],
  )
  assert.deepEqual(run.registeredArguments.map((argument) => argument.name()), ['model'])
})

test('enrollment is on by default (2000 requests per model), off with --no-enroll and for repair runs', () => {
  assert.equal(enrollmentRequestBudget({}), 2000)
  assert.equal(enrollmentRequestBudget({ enroll: true }), 2000)
  assert.equal(enrollmentRequestBudget({ maxEnrollmentRequests: '250' }), 250)
  for (const maxEnrollmentRequests of ['0', '-1', '2.5', 'Infinity', 'no']) {
    assert.throws(() => enrollmentRequestBudget({ maxEnrollmentRequests }), /positive integer/)
  }
  assert.equal(enrollmentRequestBudget({ enroll: false }), null)
  assert.throws(() => enrollmentRequestBudget({ enroll: false, maxEnrollmentRequests: '10' }), /--no-enroll/)
  assert.equal(enrollmentRequestBudget({ resumeRun: 'run' }), null)
  assert.throws(() => enrollmentRequestBudget({ resumeRun: 'run', maxEnrollmentRequests: '10' }), /never builds fresh questions/)
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

test('assigned mode gives the auditor its round-robin share of the models for the on-chain epoch', () => {
  const config = {
    verifier: {
      referenceEndpoint: {
        baseUrl: 'https://example.test',
        apiKeyEnv: 'TEST_API_KEY',
        sourceId: 'test',
        trust: 'trusted' as const,
      },
    },
  } as unknown as Parameters<typeof resolveAssignedAuditModels>[0]
  const auditors = ['0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc', '0x70997970c51812dc3a010c7d01b50e0d17dc79c8']
  const at = (epoch: string) => resolveAssignedAuditModels(
    config, '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', { epoch, startedAt: 220, endsAt: 230, source: 'onchain' }, auditors,
  )
  // 0x3C44… sorts first, so 0x7099… is auditor 1 of 2 over model-a..c.
  assert.deepEqual(at('12'), {
    auditor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    epoch: '12',
    strategy: 'round-robin',
    models: ['model-b'],
  })
  assert.deepEqual(['12', '13', '14'].map((epoch) => at(epoch).models), [['model-b'], ['model-a', 'model-c'], ['model-b']])
  assert.throws(
    () => resolveAssignedAuditModels(config, '0x90f79bf6eb2c4f870365e785982e1f101e93b906', { epoch: '12', startedAt: 220, endsAt: 230, source: 'onchain' }, auditors),
    /not an approved auditor when epoch 12 started/,
  )
  assert.throws(
    () => resolveAssignedAuditModels(config, auditors[1]!, { epoch: '2026-10-28', startedAt: 0, endsAt: 1, source: 'utc-day' }, auditors),
    /on-chain epoch is unavailable/,
  )
})

test('a bare verifier run audits the assigned models', () => {
  assert.equal(isAssignedMode(undefined, {}), true)
  assert.equal(isAssignedMode(undefined, { auditor: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' }), true)
  assert.equal(isAssignedMode('model-a', {}), false)
  assert.equal(isAssignedMode(undefined, { all: true }), false)
  assert.equal(isAssignedMode(undefined, { resumeRun: 'run-1' }), false)
})

test('--auditor cannot be combined with an explicit model, --all, or --resume-run', () => {
  const auditor = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
  assert.doesNotThrow(() => validateAssignedModeOptions(undefined, { auditor }))
  assert.throws(() => validateAssignedModeOptions('model-a', { auditor }), /--auditor/)
  assert.throws(() => validateAssignedModeOptions(undefined, { auditor, all: true }), /--auditor/)
  assert.throws(() => validateAssignedModeOptions(undefined, { auditor, resumeRun: 'run-1' }), /--resume-run/)
})

test('submit only accepts runs audited in the current on-chain epoch', () => {
  const manifest = {
    version: 1 as const,
    kind: 'antseed-verifier-run-manifest' as const,
    runId: 'run-1',
    state: 'completed' as const,
    epoch: '7',
    epochSource: 'onchain' as const,
    epochStartedAt: '1970-01-01T00:11:40.000Z',
    epochEndsAt: '1970-01-01T00:13:20.000Z',
    startedAt: '1970-01-01T00:12:00.000Z',
    completedAt: '1970-01-01T00:13:00.000Z',
    summaryPath: '/tmp/summary.json',
    modelOrder: [],
    models: [],
    failureCount: 0,
  }
  const window = { epoch: 7n, startedAt: 700, endsAt: 800 }
  assert.doesNotThrow(() => validateRunEpoch(manifest, window))
  assert.throws(() => validateRunEpoch({ ...manifest, epochSource: 'utc-day' }, window), /epoch fallback/)
  assert.throws(() => validateRunEpoch(manifest, { ...window, epoch: 8n }), /current on-chain epoch is 8/)
  assert.throws(() => validateRunEpoch({ ...manifest, completedAt: '1970-01-01T00:13:30.000Z' }, window), /outside/)
})

test('verifier run retries what is left for up to --max-rounds rounds; --resume-run is one round', async () => {
  const { maxRunRounds } = await import('./run.js')
  assert.equal(maxRunRounds({}), 3)
  assert.equal(maxRunRounds({ maxRounds: '5' }), 5)
  assert.equal(maxRunRounds({ maxRounds: '5', resumeRun: '0xabc' }), 1)
  assert.throws(() => maxRunRounds({ maxRounds: '0' }), /positive integer/)
})
