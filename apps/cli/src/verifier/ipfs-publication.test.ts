import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  modelAuditReportPath,
  modelAuditsDirectory,
  modelReferenceDirectory,
  writeEpochAuditSummary,
  writeModelAuditSummary,
  writeVerifierRunManifest,
  type EpochAuditSummaryV1,
  type VerifierRunManifestV1,
} from './audit-artifacts.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'
import { REFERENCE_VOTE_DECISION_RULE } from './model-consensus-evidence.js'
import {
  prepareVerificationPublication,
  publishVerificationToPinata,
  type PreparedVerificationPublication,
} from './ipfs-publication.js'
import type { PreparedModelVerificationBundle } from './submission-bundles.js'

test('builds a portable finalized model package and excludes operational files', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'antseed-ipfs-package-'))
  try {
    const runId = 'run-7'
    const epoch = '7'
    const model = 'Model A'
    const auditDirectory = modelAuditsDirectory(evidenceDir, epoch, model, runId)
    const modelSummaryPath = join(auditDirectory, 'summary.json')
    const consensusPath = join(auditDirectory, 'probe-consensus.json')
    const referenceIntegrityPath = join(modelReferenceDirectory(evidenceDir, epoch, model, 'reference-1'), 'probe-integrity.json')
    await mkdir(join(auditDirectory, 'sellers', 'peer-a', 'exchanges'), { recursive: true })
    await mkdir(join(auditDirectory, '.checkpoints'), { recursive: true })
    await mkdir(dirname(referenceIntegrityPath), { recursive: true })
    await writeFile(consensusPath, JSON.stringify({ version: 1, kind: 'fixture-consensus' }))
    await writeFile(join(auditDirectory, 'manifest.json'), JSON.stringify({ version: 1, kind: 'fixture-manifest' }))
    await writeFile(join(auditDirectory, 'sellers', 'peer-a', 'evidence.json'), JSON.stringify({ signed: true }))
    for (let index = 0; index < 151; index += 1) {
      await writeFile(
        join(auditDirectory, 'sellers', 'peer-a', 'exchanges', `${String(index).padStart(3, '0')}.json`),
        JSON.stringify({ raw: true, index }),
      )
    }
    await writeFile(join(auditDirectory, '.checkpoints', 'secret.json'), JSON.stringify({ transient: true }))
    await writeFile(join(auditDirectory, 'status.json'), JSON.stringify({ state: 'running' }))
    await writeFile(join(auditDirectory, 'events.jsonl'), '{}\n')
    await writeFile(join(auditDirectory, '.run.lock'), JSON.stringify({ pid: 1 }))
    await writeFile(join(auditDirectory, 'summary.json.tmp-1-fixture'), '{}')
    await writeFile(referenceIntegrityPath, JSON.stringify({ referenceId: 'reference-1' }))

    await writeModelAuditSummary(evidenceDir, epoch, model, {
      version: 1,
      kind: 'antseed-verifier-model-summary',
      runId,
      epoch,
      model,
      startedAt: '2026-08-16T00:00:00.000Z',
      completedAt: '2026-08-16T00:01:00.000Z',
      results: [],
      failures: [],
      skipped: [],
      cost: emptyAuditCostSummary(),
      referenceIntegrityPath,
    })
    const epochSummary: EpochAuditSummaryV1 = {
      version: 1,
      kind: 'antseed-verifier-epoch-summary',
      runId,
      epoch,
      epochStartedAt: '2026-08-16T00:00:00.000Z',
      epochEndsAt: '2026-08-17T00:00:00.000Z',
      startedAt: '2026-08-16T00:00:00.000Z',
      completedAt: '2026-08-16T00:01:00.000Z',
      reportPaths: [{ model, path: modelAuditReportPath(evidenceDir, epoch, model) }],
      models: [{
        model,
        summaryPath: modelSummaryPath,
        resultCount: 0,
        failureCount: 0,
        skippedCount: 0,
        cost: emptyAuditCostSummary(),
      }],
      failureCount: 0,
      cost: emptyAuditCostSummary(),
    }
    const summaryPath = await writeEpochAuditSummary(evidenceDir, epoch, epochSummary)
    const manifest: VerifierRunManifestV1 = {
      version: 1,
      kind: 'antseed-verifier-run-manifest',
      runId,
      state: 'completed',
      epoch,
      epochSource: 'onchain',
      epochStartedAt: epochSummary.epochStartedAt,
      epochEndsAt: epochSummary.epochEndsAt,
      startedAt: epochSummary.startedAt,
      completedAt: epochSummary.completedAt,
      summaryPath,
      modelOrder: [model],
      models: epochSummary.models,
      failureCount: 0,
    }
    await writeVerifierRunManifest(evidenceDir, manifest)
    const bundle = fixtureBundle(evidenceDir, runId, model, epoch)
    const publication = await prepareVerificationPublication({ evidenceDir, manifest, modelSummaryPath, bundle })
    const paths = publication.files.map((file) => file.path)

    assert.ok(paths.includes('publication.json'))
    assert.ok(paths.includes(`bundles/${runId}/model-a.json`))
    assert.ok(paths.includes('model/report.html'))
    assert.ok(paths.includes(`model/audits/${runId}/sellers/peer-a/evidence.json`))
    const exchangeArchivePath = `model/audits/${runId}/sellers/peer-a/exchanges.bundle.json`
    assert.ok(paths.includes(exchangeArchivePath))
    assert.equal(paths.some((path) => path.includes('/exchanges/')), false)
    assert.ok(paths.length <= 150)
    assert.ok(paths.includes('model/references/reference-1/probe-integrity.json'))
    assert.ok(paths.every((path) => path.split('/').length - 1 <= 6))
    assert.equal(paths.some((path) => path.includes('.checkpoints')), false)
    assert.equal(paths.some((path) => path.endsWith('status.json')), false)
    assert.equal(paths.some((path) => path.endsWith('events.jsonl')), false)
    assert.equal(paths.some((path) => path.endsWith('.lock')), false)
    assert.equal(paths.some((path) => path.includes('.tmp-')), false)

    const report = publication.files.find((file) => file.path.endsWith('/report.html'))!
    assert.match(Buffer.from(report.bytes).toString('utf8'), new RegExp(runId))

    const exchangeArchive = JSON.parse(Buffer.from(
      publication.files.find((file) => file.path === exchangeArchivePath)!.bytes,
    ).toString('utf8')) as {
      kind: string
      files: Array<{ path: string; sha256: string; bytesBase64: string }>
    }
    assert.equal(exchangeArchive.kind, 'antseed-verifier-ipfs-file-archive')
    assert.equal(exchangeArchive.files.length, 151)
    assert.ok(exchangeArchive.files[0]!.path.endsWith('/exchanges/000.json'))
    assert.deepEqual(
      Buffer.from(exchangeArchive.files[0]!.bytesBase64, 'base64'),
      Buffer.from(JSON.stringify({ raw: true, index: 0 })),
    )

    const repeated = await prepareVerificationPublication({ evidenceDir, manifest, modelSummaryPath, bundle })
    assert.deepEqual(
      repeated.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      publication.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    )

    const indexFile = publication.files.find((file) => file.path === 'publication.json')!
    const index = JSON.parse(Buffer.from(indexFile.bytes).toString('utf8')) as {
      evidenceHash: string
      layout: { modelRoot: string; sourceModelRoot: string }
      sourceFileCount: number
      archives: Array<{ path: string; files: Array<{ path: string; sha256: string }> }>
      files: Array<{ path: string; sha256: string }>
    }
    assert.equal(index.evidenceHash, bundle.evidenceHash)
    assert.deepEqual(index.layout, {
      modelRoot: 'model',
      sourceModelRoot: `epochs/${epoch}/Model_A`,
    })
    assert.ok(index.sourceFileCount > publication.fileCount)
    assert.equal(index.archives.length, 1)
    assert.equal(index.archives[0]!.path, exchangeArchivePath)
    assert.equal(index.archives[0]!.files.length, 151)
    assert.equal(index.files.some((file) => file.path === 'publication.json'), false)
    assert.ok(index.files.every((file) => file.sha256.startsWith('sha256:')))
  } finally {
    await rm(evidenceDir, { recursive: true, force: true })
  }
})

test('uploads a CIDv1 Pinata folder with portable package paths and retries transient failures', async () => {
  const publication = fixturePublication(2)
  const calls: Array<{ authorization: string | null; names: string[]; cidVersion: unknown }> = []
  let attempts = 0
  const fetchImpl: typeof fetch = async (_input, init) => {
    attempts += 1
    const form = init?.body as FormData
    calls.push({
      authorization: new Headers(init?.headers).get('authorization'),
      names: [...form.entries()].map(([name, value]) => name === 'file' && value instanceof File
        ? `${name}:${value.name}`
        : name),
      cidVersion: form.get('cid_version'),
    })
    if (attempts < 3) return new Response('{}', { status: 503 })
    return new Response(JSON.stringify({
      data: {
        cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghpm',
        size: 42,
        created_at: '2026-08-16T12:00:00.000Z',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const result = await publishVerificationToPinata(publication, 'secret-jwt', {
    endpoint: 'https://pinata.test/upload',
    fetchImpl,
    sleep: async () => undefined,
  })

  assert.equal(attempts, 3)
  assert.equal(result.uri, `ipfs://${result.cid}`)
  assert.equal(result.pinSize, 42)
  assert.equal(result.fileCount, 2)
  assert.ok(calls.every((call) => call.authorization === 'Bearer secret-jwt'))
  assert.equal(calls[0]!.names.filter((name) => name.startsWith('file:')).length, 2)
  assert.ok(calls[0]!.names.includes('file:bundle.json'))
  assert.ok(calls[0]!.names.includes('file:evidence/001.json'))
  assert.ok(calls[0]!.names.includes('network'))
  assert.ok(calls[0]!.names.includes('name'))
  assert.ok(calls[0]!.names.includes('keyvalues'))
  assert.ok(calls[0]!.names.includes('cid_version'))
  assert.equal(calls[0]!.cidVersion, 'v1')
})

test('does not retry permanent Pinata authentication failures or expose the JWT', async () => {
  let attempts = 0
  await assert.rejects(
    publishVerificationToPinata(fixturePublication(), 'do-not-leak', {
      fetchImpl: async () => {
        attempts += 1
        return new Response(JSON.stringify({ error: 'Bearer do-not-leak is invalid' }), { status: 401 })
      },
      sleep: async () => undefined,
    }),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/)
      assert.match(error.message, /Bearer \[redacted\]/)
      assert.doesNotMatch(error.message, /do-not-leak/)
      return true
    },
  )
  assert.equal(attempts, 1)
})

function fixtureBundle(
  evidenceDir: string,
  runId: string,
  model: string,
  epoch: string,
): PreparedModelVerificationBundle {
  return {
    model,
    evidenceHash: `0x${'11'.repeat(32)}`,
    evidencePath: join(evidenceDir, 'bundles', runId, 'model-a.json'),
    evidence: {
      version: 1,
      kind: 'antseed-model-verification-bundle',
      runId,
      model,
      expectedEpoch: epoch,
      epochWindow: { startedAt: '2026-08-16T00:00:00.000Z', endsAt: '2026-08-17T00:00:00.000Z' },
      consensus: {
        evidenceHash: `0x${'22'.repeat(32)}`,
        relativeEvidencePath: 'probe-consensus.json',
        referenceId: null,
        decisionRule: REFERENCE_VOTE_DECISION_RULE,
        summary: {
          probeCount: 0,
          auditedSellerCount: 0,
          authenticatedSellerCount: 0,
          eligibleSellerCount: 0,
          signedExchangeCount: 0,
          authenticatedAnswerCount: 0,
          referenceMatchCount: 0,
          referenceMismatchCount: 0,
          unparsedAnswerCount: 0,
          referenceMatchRate: null,
          eligibleAnswerCount: 0,
          referenceSupportCount: 0,
          referenceRejectCount: 0,
          confirmedReferencePointCount: 0,
          rejectedReferencePointCount: 0,
          noResponseReferencePointCount: 0,
          referencePointConfirmationRate: null,
        },
      },
      results: [],
      referenceCosts: [],
      excludedAudits: [],
      inferenceCostUsdMicros: '0',
      referenceCostUsdMicros: '0',
      totalAuditCostUsdMicros: '0',
    },
    totalAuditCostUsdMicros: 0n,
    results: [],
    referenceCostIds: [],
  }
}

function fixturePublication(fileCount = 1): PreparedVerificationPublication {
  const files = Array.from({ length: fileCount }, (_, index) => {
    const bytes = Buffer.from(JSON.stringify({ index }))
    return {
      path: index === 0 ? 'bundle.json' : `evidence/${String(index).padStart(3, '0')}.json`,
      bytes,
      size: bytes.length,
      sha256: `sha256:${String(index).padStart(64, '0')}`,
    }
  })
  return {
    version: 1,
    kind: 'antseed-verifier-ipfs-publication-package',
    runId: 'run',
    model: 'model',
    evidenceHash: `0x${'11'.repeat(32)}`,
    packageName: 'antseed-verification-run-model',
    files,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  }
}
