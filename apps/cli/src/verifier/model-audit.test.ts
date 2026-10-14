import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { VERIFIER_VERDICT, modelHash, serviceHash, sortServiceResults } from '@antseed/node/payments'
import {
  modelAuditLedgerPath,
  prepareModelAudits,
  preparedFromEvidence,
  readModelAuditEvidence,
  readModelAuditLedger,
  validateAuditMatchesSummary,
  writeModelAuditEvidence,
  writeModelAuditLedger,
  type PreparedModelAudit,
} from './model-audit.js'
import { FIXTURE_CONFIG, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'
import { readVerifierRunManifest } from './audit-artifacts.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const auditor = randomWallet()
const sellers = [randomWallet(), randomWallet(), randomWallet()]

interface Fixture {
  evidenceDir: string
  prepared: Awaited<ReturnType<typeof prepareModelAudits>>
}

async function withRun(
  audits: FixtureAudit[],
  body: (fixture: Fixture) => Promise<void>,
  options: {
    owners?: Record<string, string>
    tamper?: (evidenceDir: string) => Promise<void>
    maxResultsPerSubmission?: number
  } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-model-audit-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor, audits })
    await options.tamper?.(evidenceDir)
    const prepared = await prepareModelAudits({
      evidenceDir,
      banksDir,
      manifest,
      auditor: auditor.address,
      resolveAgentOwner: async (agentId) => options.owners?.[agentId.toString()] ?? randomWallet().address,
      config: FIXTURE_CONFIG,
      ...(options.maxResultsPerSubmission ? { maxResultsPerSubmission: options.maxResultsPerSubmission } : {}),
    })
    await body({ evidenceDir, prepared })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const audit = (
  agentId: string,
  seller: Wallet,
  model: string,
  verdict: FixtureAudit['verdict'] = 'SAME',
): FixtureAudit => ({ agentId, seller, model, service: model, verdict })

test('builds one audit per model with every seller, including UNDETERMINED', async () => {
  await withRun([
    audit('2', sellers[1]!, 'model-a', 'DIFF'),
    audit('1', sellers[0]!, 'model-a'),
    audit('3', sellers[2]!, 'model-a', 'UNDETERMINED'),
    audit('1', sellers[0]!, 'model-b'),
  ], async ({ prepared }) => {
    assert.deepEqual(prepared.excluded, [])
    assert.deepEqual(prepared.audits.map((entry) => entry.key), ['model-a', 'model-b'])
    const [first] = prepared.audits as [PreparedModelAudit, PreparedModelAudit]
    assert.equal(first.modelHash, modelHash('model-a'))
    assert.equal(first.expectedEpoch, 7n)
    assert.deepEqual(first.results, sortServiceResults(first.results))
    assert.deepEqual(first.results.map((result) => [result.agentId, result.serviceHash, result.verdict]), [
      [1n, serviceHash('model-a'), VERIFIER_VERDICT.SAME],
      [2n, serviceHash('model-a'), VERIFIER_VERDICT.DIFF],
      [3n, serviceHash('model-a'), VERIFIER_VERDICT.UNDETERMINED],
    ])
    assert.equal(first.evidence.results[2]!.verdict, 'UNDETERMINED')
    assert.match(first.evidence.results[2]!.verdictReason ?? '', /ResponseAuth/)
    assert.equal(first.evidence.references.length, 1)
    assert.ok(first.evidence.references[0]!.path?.startsWith('references/'))
    assert.equal(first.evidenceHash, canonicalHashBytes32(first.evidence))
  })
})

test('excludes the auditor\'s own agent and tampered evidence without dropping the model', async () => {
  await withRun([
    audit('1', sellers[0]!, 'model-a'),
    audit('2', sellers[1]!, 'model-a'),
    audit('3', sellers[2]!, 'model-a'),
  ], async ({ prepared }) => {
    const [entry] = prepared.audits as [PreparedModelAudit]
    assert.deepEqual(entry.results.map((result) => result.agentId), [2n])
    const reasons = prepared.excluded.map((exclusion) => exclusion.reason).sort()
    assert.equal(reasons.length, 2)
    assert.match(reasons[0]!, /invalid audit evidence/)
    assert.match(reasons[1]!, /self-audit/)
    assert.equal(entry.evidence.excluded.length, 2)
  }, {
    owners: { '1': auditor.address },
    tamper: async (evidenceDir) => {
      const manifest = await readVerifierRunManifest(evidenceDir, 'run-1')
      const summary = JSON.parse(await readFile(manifest.models[0]!.summaryPath, 'utf8')) as {
        results: Array<{ agentId: string; evidencePath: string }>
      }
      const target = summary.results.find((result) => result.agentId === '3')!
      const evidence = JSON.parse(await readFile(target.evidencePath, 'utf8')) as { createdAt: string }
      evidence.createdAt = '2000-01-01T00:00:00.000Z'
      await writeFile(target.evidencePath, JSON.stringify(evidence))
    },
  })
})

test('splits a model into ordered parts when it exceeds the per-call result limit', async () => {
  await withRun([
    audit('1', sellers[0]!, 'model-a'),
    audit('2', sellers[1]!, 'model-a'),
    audit('3', sellers[2]!, 'model-a'),
  ], async ({ prepared }) => {
    assert.deepEqual(prepared.audits.map((entry) => entry.key), ['model-a#1', 'model-a#2'])
    assert.deepEqual(prepared.audits.map((entry) => entry.results.map((result) => result.agentId)), [[1n, 2n], [3n]])
    assert.notEqual(prepared.audits[0]!.evidenceHash, prepared.audits[1]!.evidenceHash)
  }, { maxResultsPerSubmission: 2 })
})

test('rejects runs without a numeric on-chain epoch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-model-audit-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const manifest = await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-1', epoch: '2026-10-07', auditor, audits: [audit('1', sellers[0]!, 'model-a')],
      epochSource: 'utc-day',
    })
    await assert.rejects(prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address,
      resolveAgentOwner: async () => randomWallet().address, config: FIXTURE_CONFIG,
    }), /only on-chain epochs/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('written evidence round-trips to the same contract call, and the ledger is bound to its run', async () => {
  await withRun([audit('1', sellers[0]!, 'model-a', 'UNDETERMINED')], async ({ evidenceDir, prepared }) => {
    const [entry] = prepared.audits as [PreparedModelAudit]
    await writeModelAuditEvidence(entry)
    const evidence = await readModelAuditEvidence(entry.evidencePath, entry.evidenceHash)
    const rebuilt = preparedFromEvidence(entry.key, entry.evidencePath, evidence)
    assert.deepEqual(rebuilt.results, entry.results)
    assert.equal(rebuilt.evidenceHash, entry.evidenceHash)
    assert.equal(rebuilt.expectedEpoch, 7n)
    await assert.rejects(readModelAuditEvidence(entry.evidencePath, `0x${'00'.repeat(32)}`), /hash mismatch/)

    const binding = { runId: 'run-1', epoch: '7', auditor: auditor.address, chainId: 31337n, contract: `0x${'aa'.repeat(20)}` }
    const path = modelAuditLedgerPath(evidenceDir, 'run-1', 31337n, binding.contract)
    const ledger = await readModelAuditLedger(path, binding)
    assert.deepEqual(ledger.models, {})
    await writeModelAuditLedger(path, ledger)
    await assert.rejects(readModelAuditLedger(path, { ...binding, epoch: '8' }), /another run/)
  })
})

test('a recheck may turn a first DIFF into UNDETERMINED, but never on reused probes', () => {
  const evidence = (verdict: string, referenceId: string, probeIds: string[]) => ({
    target: { peerId: 'aa'.repeat(20), service: 'model-a', agentId: '7' },
    reference: { referenceId, probes: probeIds.map((id) => ({ id })) },
    result: { verdict },
  }) as unknown as Parameters<typeof validateAuditMatchesSummary>[0]
  const summary = (status: string, recheckStatus: string) => ({
    peerId: 'aa'.repeat(20), service: 'model-a', agentId: '7', status,
    recheck: { status: recheckStatus },
  }) as unknown as Parameters<typeof validateAuditMatchesSummary>[1]
  const first = evidence('DIFF', 'sha256:first', ['p1', 'p2'])

  validateAuditMatchesSummary(first, summary('UNDETERMINED', 'SAME'), evidence('SAME', 'sha256:second', ['p3', 'p4']))
  validateAuditMatchesSummary(first, summary('DIFF', 'DIFF'), evidence('DIFF', 'sha256:second', ['p3', 'p4']))
  validateAuditMatchesSummary(
    first, summary('DIFF', 'UNDETERMINED'), evidence('UNDETERMINED', 'sha256:second', ['p3', 'p4']),
  )
  assert.throws(
    () => validateAuditMatchesSummary(
      first, summary('UNDETERMINED', 'UNDETERMINED'), evidence('UNDETERMINED', 'sha256:second', ['p3', 'p4']),
    ),
    /final verdict does not follow/,
  )
  assert.throws(
    () => validateAuditMatchesSummary(first, summary('DIFF', 'SAME'), evidence('SAME', 'sha256:second', ['p3', 'p4'])),
    /final verdict does not follow/,
  )
  assert.throws(
    () => validateAuditMatchesSummary(first, summary('DIFF', 'DIFF'), evidence('DIFF', 'sha256:second', ['p2', 'p4'])),
    /reused probes/,
  )
  assert.throws(
    () => validateAuditMatchesSummary(evidence('SAME', 'sha256:first', ['p1']), summary('UNDETERMINED', 'SAME'),
      evidence('SAME', 'sha256:second', ['p3'])),
    /without a first DIFF/,
  )
  assert.throws(() => validateAuditMatchesSummary(first, summary('UNDETERMINED', 'SAME'), null), /recheck evidence missing/)
})
