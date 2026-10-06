import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  prepareReportPublication,
  publishVerificationToPinata,
  type PreparedVerificationPublication,
} from './ipfs-publication.js'

test('builds a portable agent report package and excludes operational files', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'antseed-ipfs-package-'))
  try {
    const runId = 'run-7'
    const sellerDirectory = join(evidenceDir, 'epochs', '7', 'Model_A', 'audits', runId, 'sellers', 'peer-a')
    const reportDirectory = join(evidenceDir, 'reports', runId)
    const evidencePath = join(reportDirectory, '1.evidence.json')
    const referencePath = join(reportDirectory, 'references', `${'ab'.repeat(32)}.json`)
    await mkdir(join(sellerDirectory, 'exchanges'), { recursive: true })
    await mkdir(join(sellerDirectory, '.checkpoints'), { recursive: true })
    await mkdir(dirname(referencePath), { recursive: true })
    await writeFile(join(sellerDirectory, 'evidence.json'), JSON.stringify({ signed: true }))
    await writeFile(join(sellerDirectory, 'manifest.json'), JSON.stringify({ kind: 'fixture-manifest' }))
    for (let index = 0; index < 151; index += 1) {
      await writeFile(
        join(sellerDirectory, 'exchanges', `${String(index).padStart(3, '0')}.json`),
        JSON.stringify({ raw: true, index }),
      )
    }
    await writeFile(join(sellerDirectory, '.checkpoints', 'secret.json'), JSON.stringify({ transient: true }))
    await writeFile(join(sellerDirectory, 'status.json'), JSON.stringify({ state: 'running' }))
    await writeFile(join(sellerDirectory, 'evidence.json.tmp-1-fixture'), '{}')
    await writeFile(referencePath, JSON.stringify({ referenceId: 'reference-1' }))

    const prepare = () => prepareReportPublication({
      evidenceDir,
      runId,
      agentId: '1',
      evidenceHash: `0x${'11'.repeat(32)}`,
      evidencePath,
      evidenceBytes: Buffer.from(JSON.stringify({ kind: 'agent-evidence' })),
      referencePaths: [referencePath],
      auditEvidencePaths: [join(sellerDirectory, 'evidence.json')],
    })
    const publication = await prepare()
    const paths = publication.files.map((file) => file.path)
    const sellerPath = `epochs/7/Model_A/audits/${runId}/sellers/peer-a`

    assert.ok(paths.includes('publication.json'))
    assert.ok(paths.includes(`reports/${runId}/1.evidence.json`))
    assert.ok(paths.includes(`reports/${runId}/references/${'ab'.repeat(32)}.json`))
    assert.ok(paths.includes(`${sellerPath}/evidence.json`))
    assert.ok(paths.includes(`${sellerPath}/manifest.json`))
    const exchangeArchivePath = `${sellerPath}/exchanges.bundle.json`
    assert.ok(paths.includes(exchangeArchivePath))
    assert.equal(paths.some((path) => path.includes('/exchanges/')), false)
    assert.ok(paths.length <= 150)
    assert.equal(paths.some((path) => path.includes('.checkpoints')), false)
    assert.equal(paths.some((path) => path.endsWith('status.json')), false)
    assert.equal(paths.some((path) => path.includes('.tmp-')), false)

    const exchangeArchive = JSON.parse(Buffer.from(
      publication.files.find((file) => file.path === exchangeArchivePath)!.bytes,
    ).toString('utf8')) as {
      kind: string
      files: Array<{ path: string; sha256: string; bytesBase64: string }>
    }
    assert.equal(exchangeArchive.kind, 'antseed-verifier-ipfs-file-archive')
    assert.equal(exchangeArchive.files.length, 151)
    assert.deepEqual(
      Buffer.from(exchangeArchive.files[0]!.bytesBase64, 'base64'),
      Buffer.from(JSON.stringify({ raw: true, index: 0 })),
    )

    const repeated = await prepare()
    assert.deepEqual(
      repeated.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      publication.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    )
    const indexFile = publication.files.find((file) => file.path === 'publication.json')!
    const index = JSON.parse(Buffer.from(indexFile.bytes).toString('utf8')) as {
      agentId: string
      evidenceHash: string
      evidencePath: string
      sourceFileCount: number
      archives: Array<{ path: string; files: Array<{ path: string; sha256: string }> }>
      files: Array<{ path: string; sha256: string }>
    }
    assert.equal(index.agentId, '1')
    assert.equal(index.evidenceHash, `0x${'11'.repeat(32)}`)
    assert.equal(index.evidencePath, `reports/${runId}/1.evidence.json`)
    assert.ok(index.sourceFileCount > publication.fileCount)
    assert.equal(index.archives.length, 1)
    assert.equal(index.archives[0]!.files.length, 151)
    assert.equal(index.files.some((file) => file.path === 'publication.json'), false)
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
    agentId: '1',
    evidenceHash: `0x${'11'.repeat(32)}`,
    packageName: 'antseed-verification-run-agent-1',
    files,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0),
  }
}
