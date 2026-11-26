import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { fetchIpfsText } from '@antseed/model-verifier'
import type { PreparedVerificationPublication } from './ipfs-publication.js'
import { publishVerificationToDirectory, testPublicationFor, testPublicationId } from './test-publication.js'
import { VerifierConfigSchema } from './config-schema.js'

const file = (path: string, text: string) => {
  const bytes = new TextEncoder().encode(text)
  return { path, bytes, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const publication = (files = [file('publication.json', '{"kind":"antseed-verifier-ipfs-publication"}'), file('epochs/7/model/audit.json', '{"ok":true}')]): PreparedVerificationPublication => ({
  version: 1, kind: 'antseed-verifier-ipfs-publication-package', runId: 'run-1', model: 'model-a', evidenceHash: '0x01',
  packageName: 'antseed-verification-run-1-model-model-a', files, fileCount: files.length, totalBytes: files.reduce((total, entry) => total + entry.size, 0),
})

test('a test publication is refused unless the chain RPC and its gateway are on this machine', () => {
  const config = { directory: '/tmp/pub', gatewayUrl: 'http://127.0.0.1:8099' }
  assert.equal(testPublicationFor(undefined, 'https://mainnet.base.org'), null, 'not set: IPFS as before')
  assert.deepEqual(testPublicationFor(config, 'http://127.0.0.1:8652'), config)
  assert.deepEqual(testPublicationFor(config, 'http://localhost:8652'), config)
  assert.throws(() => testPublicationFor(config, 'https://mainnet.base.org'), /local fork only.*not mainnet\.base\.org/)
  assert.throws(() => testPublicationFor(config, undefined), /the default Base RPC/)
  assert.throws(() => testPublicationFor({ ...config, gatewayUrl: 'https://ipfs.io/ipfs' }, 'http://127.0.0.1:8652'), /gatewayUrl must be on this machine/)
  // The setting itself: two fields, nothing else.
  assert.ok(VerifierConfigSchema.safeParse({ testPublication: config }).success)
  assert.equal(VerifierConfigSchema.safeParse({ testPublication: { ...config, extra: 1 } }).success, false)
})

test('a test publication writes the package under an id of CIDv1 shape, the same for the same package, and refuses a path that escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-test-publication-'))
  try {
    const published = await publishVerificationToDirectory(publication(), directory, () => new Date('2026-11-20T00:00:00.000Z'))
    assert.match(published.cid, /^b[a-z2-7]{20,}$/, 'every reader of an ipfs:// URI takes it')
    assert.deepEqual([published.provider, published.uri, published.fileCount, published.publishedAt], ['local-test', `ipfs://${published.cid}`, 2, '2026-11-20T00:00:00.000Z'])
    assert.equal(await readFile(join(directory, published.cid, 'epochs/7/model/audit.json'), 'utf8'), '{"ok":true}')
    assert.equal(testPublicationId(publication()), published.cid, 'the same package, the same id')
    assert.notEqual(testPublicationId(publication([file('publication.json', '{}')])), published.cid)
    await assert.rejects(publishVerificationToDirectory(publication([file('../outside.json', '{}')]), directory), /escapes its package/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a confirmer reads a test publication through a local gateway with the same reader it uses for IPFS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-test-publication-'))
  const root = resolve(directory)
  // A plain static server over the directory, as the run book starts one.
  const server = createServer(async (request, response) => {
    const target = normalize(join(root, decodeURIComponent((request.url ?? '/').split('?')[0]!)))
    if (!target.startsWith(root + sep)) return void response.writeHead(403).end()
    const body = await readFile(target).catch(() => null)
    if (body === null) response.writeHead(404).end()
    else response.writeHead(200).end(body)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    const port = (server.address() as { port: number }).port
    const published = await publishVerificationToDirectory(publication(), directory)
    assert.equal(await fetchIpfsText(`${published.cid}/epochs/7/model/audit.json`, { ipfsGateway: `http://127.0.0.1:${port}` }), '{"ok":true}')
    await assert.rejects(fetchIpfsText(`${published.cid}/missing.json`, { ipfsGateway: `http://127.0.0.1:${port}` }), /HTTP 404/)
  } finally {
    await new Promise((done) => server.close(done))
    await rm(directory, { recursive: true, force: true })
  }
})
