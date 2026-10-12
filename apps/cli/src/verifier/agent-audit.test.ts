import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import { modelHash, serviceHash, sortServiceResults } from '@antseed/node/payments'
import {
  agentSubmissionPath,
  prepareAgentAudits,
  readAgentAuditSubmission,
  writeAgentAuditEvidence,
  writeAgentAuditSubmission,
  type PreparedAgentAudit,
} from './agent-audit.js'
import { FIXTURE_CONFIG, writeSignedAuditRun, type FixtureAudit } from './agent-audit-fixtures.test-support.js'
import { readVerifierRunManifest } from './audit-artifacts.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const auditor = randomWallet()
const sellers = [randomWallet(), randomWallet()]

interface Fixture {
  evidenceDir: string
  prepared: Awaited<ReturnType<typeof prepareAgentAudits>>
}

async function withRun(
  audits: FixtureAudit[],
  body: (fixture: Fixture) => Promise<void>,
  options: { owners?: Record<string, string>; tamper?: (evidenceDir: string) => Promise<void> } = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-agent-audit-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId: 'run-1', epoch: '2026-10-07', auditor, audits })
    await options.tamper?.(evidenceDir)
    const prepared = await prepareAgentAudits({
      evidenceDir,
      banksDir,
      manifest,
      auditor: auditor.address,
      resolveAgentOwner: async (agentId) => options.owners?.[agentId.toString()] ?? randomWallet().address,
      config: FIXTURE_CONFIG,
    })
    await body({ evidenceDir, prepared })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const audit = (agentId: string, seller: Wallet, model: string, verdict: 'SAME' | 'DIFF' = 'SAME'): FixtureAudit => ({
  agentId, seller, model, service: model, verdict,
})

test('groups results per agent across models; a service passes only when KBF says SAME', async () => {
  await withRun([
    audit('1', sellers[0]!, 'model-a'),
    audit('1', sellers[0]!, 'model-b'),
    audit('2', sellers[1]!, 'model-a', 'DIFF'),
  ], async ({ prepared }) => {
    assert.deepEqual(prepared.excluded, [])
    assert.deepEqual(prepared.audits.map((entry) => entry.agentId), [1n, 2n])
    const [first, second] = prepared.audits as [PreparedAgentAudit, PreparedAgentAudit]

    assert.deepEqual(first.results, sortServiceResults(first.results))
    assert.deepEqual(
      first.results.map((result) => result.serviceHash).sort(),
      [serviceHash('model-a'), serviceHash('model-b')].sort(),
    )
    assert.ok(first.results.every((result) => result.passed))
    for (const service of first.evidence.services) {
      assert.equal(service.modelHash, modelHash(service.reference.referenceModel))
      assert.ok(service.reference.path?.startsWith('references/'))
    }
    assert.equal(first.evidenceHash, canonicalHashBytes32(first.evidence))

    assert.deepEqual(second.results.map((result) => result.passed), [false])
    assert.equal(second.evidence.services[0]!.verdict, 'DIFF')
  })
})

test('skips agents the auditor owns', async () => {
  await withRun([
    audit('1', sellers[0]!, 'model-a'),
    audit('2', sellers[1]!, 'model-a'),
  ], async ({ prepared }) => {
    assert.deepEqual(prepared.audits.map((entry) => entry.agentId), [2n])
    assert.equal(prepared.excluded.length, 1)
    assert.match(prepared.excluded[0]!.reason, /self-audit/)
  }, { owners: { '1': auditor.address } })
})

test('excludes audits whose evidence no longer matches its hash', async () => {
  await withRun([audit('1', sellers[0]!, 'model-a'), audit('2', sellers[1]!, 'model-a')], async ({ prepared }) => {
    assert.deepEqual(prepared.audits.map((entry) => entry.agentId), [2n])
    assert.match(prepared.excluded[0]!.reason, /invalid audit evidence/)
  }, {
    tamper: async (evidenceDir) => {
      const manifest = await readVerifierRunManifest(evidenceDir, 'run-1')
      const summary = JSON.parse(await readFile(manifest.models[0]!.summaryPath, 'utf8')) as {
        results: Array<{ agentId: string; evidencePath: string }>
      }
      const target = summary.results.find((result) => result.agentId === '1')!
      const evidence = JSON.parse(await readFile(target.evidencePath, 'utf8')) as { createdAt: string }
      evidence.createdAt = '2000-01-01T00:00:00.000Z'
      await writeFile(target.evidencePath, JSON.stringify(evidence))
    },
  })
})

test('writes evidence and round-trips the submission record', async () => {
  await withRun([audit('1', sellers[0]!, 'model-a')], async ({ evidenceDir, prepared }) => {
    const [entry] = prepared.audits as [PreparedAgentAudit]
    await writeAgentAuditEvidence(entry)
    const stored = JSON.parse(await readFile(entry.evidencePath, 'utf8')) as { agentId: string }
    assert.equal(stored.agentId, '1')

    const path = agentSubmissionPath(evidenceDir, 'run-1', entry.agentId)
    assert.equal(await readAgentAuditSubmission(path), null)
    const record = {
      version: 1 as const,
      kind: 'antseed-verifier-agent-audit-submission' as const,
      runId: 'run-1',
      agentId: '1',
      auditor: auditor.address,
      chainId: '31337',
      contract: '0x00000000000000000000000000000000000000aa',
      evidenceHash: entry.evidenceHash,
      evidenceUri: '',
      transactionHash: '0x' + '11'.repeat(32),
      submittedAt: '2026-10-12T00:00:00.000Z',
    }
    await writeAgentAuditSubmission(path, record)
    assert.deepEqual(await readAgentAuditSubmission(path), record)
  })
})
