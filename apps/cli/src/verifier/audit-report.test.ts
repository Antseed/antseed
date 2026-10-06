import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { canonicalHashBytes32 } from '@antseed/fingerprints'
import {
  SERVICE_MODEL_MATCH,
  SERVICE_PRICE_MATCH,
  auditReportDomain,
  hashServiceResults,
  serviceHash,
  sortServiceResults,
} from '@antseed/node/payments'
import {
  auditReportPath,
  evaluatePriceCheck,
  prepareAgentAuditReports,
  readAuditReportFile,
  referenceIdBytes32,
  signAgentAuditReport,
  writeAgentAuditEvidence,
  writeAuditReportFile,
  type PreparedAgentAuditReport,
} from './audit-report.js'
import {
  FIXTURE_CONFIG,
  referenceFixture,
  writeSignedAuditRun,
  type FixtureAudit,
} from './audit-report-fixtures.test-support.js'
import { verifyAuditReportFile, type VerifiedAuditReport } from './report-verification.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const CONTRACT = '0x00000000000000000000000000000000000000aa'
const CHAIN_ID = 31_337n
const domain = auditReportDomain(CHAIN_ID, CONTRACT)
const auditor = randomWallet()
const sellers = [randomWallet(), randomWallet(), randomWallet()]
const nowSeconds = () => Math.floor(Date.now() / 1_000)

interface Fixture {
  directory: string
  evidenceDir: string
  banksDir: string
  emptyBanksDir: string
  prepared: Awaited<ReturnType<typeof prepareAgentAuditReports>>
}

async function withRun(
  audits: FixtureAudit[],
  body: (fixture: Fixture) => Promise<void>,
  owners: Record<string, string> = {},
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-audit-report-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const { manifest, requestCosts } = await writeSignedAuditRun({
      evidenceDir,
      banksDir,
      runId: 'run-1',
      epoch: '2026-10-07',
      auditor,
      audits,
    })
    const prepared = await prepareAgentAuditReports({
      evidenceDir,
      banksDir,
      manifest,
      auditor: auditor.address,
      requestCostLookup: { getRequestCost: (requestId) => requestCosts.get(requestId) ?? null },
      resolveAgentOwner: async (agentId) => owners[agentId.toString()] ?? randomWallet().address,
      config: FIXTURE_CONFIG,
    })
    await body({ directory, evidenceDir, banksDir, emptyBanksDir: join(directory, 'verifier-banks'), prepared })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function signAndWrite(
  fixture: Fixture,
  report: PreparedAgentAuditReport,
  options: { auditedAt?: bigint; signer?: Wallet } = {},
): Promise<string> {
  await writeAgentAuditEvidence(report)
  const path = auditReportPath(fixture.evidenceDir, 'run-1', report.agentId)
  const file = await signAgentAuditReport({
    prepared: report,
    signer: options.signer ?? auditor,
    domain,
    runId: 'run-1',
    auditedAt: options.auditedAt ?? BigInt(nowSeconds()),
    reportPath: path,
  })
  await writeAuditReportFile(path, file)
  return path
}

function verify(fixture: Fixture, path: string, now = nowSeconds()): Promise<VerifiedAuditReport> {
  return verifyAuditReportFile({
    path,
    domain,
    nowSeconds: now,
    banksDir: fixture.emptyBanksDir,
    config: FIXTURE_CONFIG,
  })
}

function failedChecks(verified: VerifiedAuditReport): string[] {
  return Object.entries(verified.checks).filter(([, check]) => !check.ok).map(([name]) => name)
}

const sameAudit = (agentId: string, seller: Wallet, model: string, extra: Partial<FixtureAudit> = {}): FixtureAudit => ({
  agentId, seller, model, service: model, verdict: 'SAME', ...extra,
})

test('auditor groups results per agent across models and the verifier re-derives every proof', async () => {
  await withRun([
    sameAudit('1', sellers[0]!, 'model-a'),
    sameAudit('1', sellers[0]!, 'model-b'),
    { agentId: '2', seller: sellers[1]!, model: 'model-a', service: 'model-a', verdict: 'DIFF' },
  ], async (fixture) => {
    assert.deepEqual(fixture.prepared.excluded, [])
    assert.deepEqual(fixture.prepared.reports.map((report) => report.agentId), [1n, 2n])
    const [first, second] = fixture.prepared.reports as [PreparedAgentAuditReport, PreparedAgentAuditReport]

    assert.equal(first.results.length, 2)
    assert.deepEqual(first.results, sortServiceResults(first.results))
    assert.deepEqual(
      first.results.map((result) => result.serviceHash).sort(),
      [serviceHash('model-a'), serviceHash('model-b')].sort(),
    )
    for (const result of first.results) assert.equal(result.flags, SERVICE_MODEL_MATCH | SERVICE_PRICE_MATCH)
    for (const service of first.evidence.services) {
      assert.equal(service.referenceIdBytes32, referenceIdBytes32(service.referenceId))
      assert.equal(service.referenceIdBytes32, `0x${service.referenceId.slice('sha256:'.length)}`)
      assert.ok(service.reference.path?.startsWith('references/'))
      assert.equal(service.priceCheck.passed, true)
    }
    assert.equal(first.resultsHash, hashServiceResults(first.results))
    assert.equal(first.evidenceHash, canonicalHashBytes32(first.evidence))
    assert.equal(first.evidence.inferenceCostUsdMicros, '280')
    assert.equal(second.results[0]!.flags, SERVICE_PRICE_MATCH)

    for (const report of fixture.prepared.reports) {
      const path = await signAndWrite(fixture, report)
      const file = await readAuditReportFile(path)
      assert.equal(file.auditor, auditor.address)
      assert.equal(file.chainId, '31337')
      assert.equal(file.evidencePath, `${report.agentId}.evidence.json`)
      const verified = await verify(fixture, path)
      assert.deepEqual(failedChecks(verified), [], JSON.stringify(verified.checks, null, 2))
      assert.equal(verified.ok, true)
      assert.ok(verified.digest)
    }
  })
})

test('auditor skips agents it owns and records the exclusion', async () => {
  await withRun([
    sameAudit('1', sellers[0]!, 'model-a'),
    sameAudit('2', sellers[1]!, 'model-a'),
  ], async (fixture) => {
    assert.deepEqual(fixture.prepared.reports.map((report) => report.agentId), [2n])
    assert.equal(fixture.prepared.excluded.length, 1)
    assert.match(fixture.prepared.excluded[0]!.reason, /self-audit/)
  }, { '1': auditor.address })
})

test('price check fails closed on overcharges and missing cost records', async () => {
  await withRun([
    sameAudit('1', sellers[0]!, 'model-a', { costMultiplier: 1.03 }),
    sameAudit('2', sellers[1]!, 'model-a', { omitCost: true }),
    sameAudit('3', sellers[2]!, 'model-a', { costMultiplier: 1.0107 }),
  ], async (fixture) => {
    const [overcharged, missing, tolerated] = fixture.prepared.reports
    assert.equal(overcharged!.results[0]!.flags, SERVICE_MODEL_MATCH)
    assert.match(overcharged!.evidence.services[0]!.priceCheck.reason!, /exceeds allowed 143 micro-USDC/)
    assert.equal(missing!.results[0]!.flags, SERVICE_MODEL_MATCH)
    assert.match(missing!.evidence.services[0]!.priceCheck.reason!, /request cost record is missing/)
    assert.equal(tolerated!.results[0]!.flags, SERVICE_MODEL_MATCH | SERVICE_PRICE_MATCH)
    for (const report of fixture.prepared.reports) {
      const verified = await verify(fixture, await signAndWrite(fixture, report))
      assert.equal(verified.ok, true, JSON.stringify(verified.checks))
    }
  })
})

test('price check tolerance is 1% plus one micro-USDC', () => {
  const evidence = {
    target: { peerId: 'aa'.repeat(20), service: 'model-a' },
    exchanges: [{
      batchIndex: 0,
      requestIds: ['r1'],
      status: 'succeeded',
      cost: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
      responseAuth: { requestId: 'r1' },
    }],
  } as unknown as ProxyAuditEvidenceV1
  const check = (authorized: number) => evaluatePriceCheck(evidence, () => ({
    requestId: 'r1',
    sellerPeerId: `0x${'AA'.repeat(20)}`,
    service: 'Model-A',
    channelId: '0x01',
    source: 'need-auth',
    authorizedCostUsdc: String(authorized),
    inputTokens: '1000',
    outputTokens: '100',
    recordedAt: 1,
  }))
  assert.equal(check(4_500).requests[0]!.expectedCostUsdMicros, '4500')
  assert.equal(check(4_546).passed, true)
  assert.equal(check(4_547).passed, false)
})

test('verifier refuses a report whose flags overstate the recomputed verdict', async () => {
  await withRun([
    { agentId: '2', seller: sellers[1]!, model: 'model-a', service: 'model-a', verdict: 'DIFF' },
  ], async (fixture) => {
    const report = fixture.prepared.reports[0]!
    report.evidence.services[0]!.flags |= SERVICE_MODEL_MATCH
    report.results = sortServiceResults(report.evidence.services.map((service) => ({
      serviceHash: service.serviceHash,
      modelHash: service.modelHash,
      flags: service.flags,
    })))
    report.resultsHash = hashServiceResults(report.results)
    report.evidenceHash = canonicalHashBytes32(report.evidence)
    const verified = await verify(fixture, await signAndWrite(fixture, report))
    assert.deepEqual(failedChecks(verified), ['kbf'])
    assert.match(verified.checks.kbf!.detail, /flags disagree with verdict DIFF/)
  })
})

test('verifier refuses forged seller signatures, stale or foreign signatures, and missing references', async () => {
  await withRun([
    sameAudit('1', sellers[0]!, 'model-a', { signer: sellers[2] }),
    sameAudit('2', sellers[1]!, 'model-a'),
  ], async (fixture) => {
    const [forged, honest] = fixture.prepared.reports as [PreparedAgentAuditReport, PreparedAgentAuditReport]
    const forgedVerified = await verify(fixture, await signAndWrite(fixture, forged))
    assert.deepEqual(failedChecks(forgedVerified), ['responseAuth', 'kbf'])
    assert.match(forgedVerified.checks.responseAuth!.detail, /invalid_signature/)

    const path = await signAndWrite(fixture, honest, { auditedAt: BigInt(nowSeconds() - 4 * 24 * 60 * 60) })
    assert.match((await verify(fixture, path)).checks.signature!.detail, /older than/)

    await signAndWrite(fixture, honest, { auditedAt: BigInt(nowSeconds() + 3_600) })
    assert.match((await verify(fixture, path)).checks.signature!.detail, /future/)

    await signAndWrite(fixture, honest)
    const file = JSON.parse(await readFile(path, 'utf8')) as { auditor: string }
    file.auditor = sellers[2]!.address
    await writeFile(path, JSON.stringify(file))
    assert.match((await verify(fixture, path)).checks.signature!.detail, /recovers to/)

    await signAndWrite(fixture, honest)
    const evidencePath = resolve(fixture.evidenceDir, 'reports', 'run-1', '2.evidence.json')
    await writeFile(evidencePath, `${await readFile(evidencePath, 'utf8')} `)
    assert.deepEqual(failedChecks(await verify(fixture, path)), ['evidence', 'responseAuth', 'kbf', 'price'])

    await signAndWrite(fixture, honest)
    const referencePath = resolve(fixture.evidenceDir, 'reports', 'run-1', honest.evidence.services[0]!.reference.path!)
    await rm(referencePath)
    const missingReference = await verify(fixture, path)
    assert.deepEqual(failedChecks(missingReference), ['kbf'])
    assert.match(missingReference.checks.kbf!.detail, /is unavailable/)
    const withBanks = await verifyAuditReportFile({
      path,
      domain,
      nowSeconds: nowSeconds(),
      banksDir: fixture.banksDir,
      config: FIXTURE_CONFIG,
    })
    assert.equal(withBanks.ok, true, JSON.stringify(withBanks.checks))
  })
})

test('verifier refuses reports signed for another chain or contract', async () => {
  await withRun([sameAudit('1', sellers[0]!, 'model-a')], async (fixture) => {
    const path = await signAndWrite(fixture, fixture.prepared.reports[0]!)
    const verified = await verifyAuditReportFile({
      path,
      domain: auditReportDomain(8_453n, CONTRACT),
      nowSeconds: nowSeconds(),
      banksDir: fixture.emptyBanksDir,
      config: FIXTURE_CONFIG,
    })
    assert.match(verified.checks.signature!.detail, /not this verification contract/)
    assert.equal(verified.ok, false)
  })
})

test('auditors with different per-seller references agree on the same results hash', async () => {
  const audit = { agentId: '7', seller: sellers[0]!, model: 'model-a', service: 'model-a', verdict: 'SAME' as const }
  let first: PreparedAgentAuditReport | undefined
  await withRun([{ ...audit, reference: referenceFixture('model-a', 10) }], async (fixture) => {
    first = fixture.prepared.reports[0]
  })
  await withRun([{ ...audit, reference: referenceFixture('model-a', 20) }], async (fixture) => {
    const second = fixture.prepared.reports[0]!
    assert.notEqual(second.evidence.services[0]!.referenceId, first!.evidence.services[0]!.referenceId)
    assert.equal(second.resultsHash, first!.resultsHash)
  })
})
