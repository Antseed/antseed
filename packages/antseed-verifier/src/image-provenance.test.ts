import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import record from './image-build.fixture.json' with { type: 'json' }
import { IMAGE_BUILD, IMAGES_BUILT_AFTER, composeImageDigest, imageBuildRecord, tokenImageDigest, verifyImageBuild } from './image-provenance.js'

/** The build record GitHub serves for TEE seller image 0.1.234 (attestation of the Publish TEE seller image workflow on main). */
const DIGEST = 'sha256:74972a3ce21531fcfc4bdd48a3cac95d20afe39f234cb7c472fae2e004e605bc'
const policy = { ...IMAGE_BUILD, builtAfter: IMAGES_BUILT_AFTER }

describe('verifyImageBuild', () => {
  it('approves the image a build record from the workflow on main names, offline', async () => {
    expect(await verifyImageBuild(record)).toEqual({ images: [{ version: 'built 2026-11-07 from 2a3bd77', digest: DIGEST }] })
  })

  it('rejects a record from another workflow or branch', async () => {
    const other = await verifyImageBuild(record, { ...policy, workflow: IMAGE_BUILD.workflow.replace('refs/heads/main', 'refs/heads/dev') })
    expect(other).toMatchObject({ error: expect.stringMatching(/does not verify/) })
  })

  it('rejects a record whose statement was changed after signing', async () => {
    const payload = Buffer.from(record.dsseEnvelope.payload, 'base64').toString().replace(DIGEST.slice(7, 15), '00000000')
    const tampered = { ...record, dsseEnvelope: { ...record.dsseEnvelope, payload: Buffer.from(payload).toString('base64') } }
    expect(await verifyImageBuild(tampered)).toMatchObject({ error: expect.stringMatching(/does not verify/) })
  })

  it('dates the build by its signing certificate, not by a log entry time the seller could add', async () => {
    const [entry] = record.verificationMaterial.tlogEntries
    const { inclusionPromise: _p, ...proofOnly } = entry!
    const forged = { ...record, verificationMaterial: { ...record.verificationMaterial, tlogEntries: [{ ...proofOnly, integratedTime: '1900000000' }, entry] } }
    expect(await verifyImageBuild(forged, { ...policy, builtAfter: '2026-11-08T00:00:00Z' })).toMatchObject({ error: expect.stringMatching(/built before|does not verify/) })
  })

  it('rejects an image built before the cutoff, and anything that is not a record', async () => {
    expect(await verifyImageBuild(record, { ...policy, builtAfter: '2026-11-08T00:00:00Z' })).toEqual({ error: 'image was built before 2026-11-08T00:00:00Z' })
    expect(await verifyImageBuild(record, { ...policy, image: 'ghcr.io/other/image' })).toEqual({ error: 'build record names no ghcr.io/other/image image' })
    expect(await verifyImageBuild({ hello: 'world' })).toMatchObject({ error: expect.stringMatching(/does not verify/) })
  })
})

describe('the seller image digest', () => {
  it('is read from a dstack app compose that pins one service by digest', () => {
    const app = (image: string) => JSON.stringify({ docker_compose_file: JSON.stringify({ services: { seller: { image } } }) })
    expect(composeImageDigest(app(`ghcr.io/antseed/tee-seller@${DIGEST}`))).toBe(DIGEST)
    expect(composeImageDigest(app('ghcr.io/antseed/tee-seller:0.1.234'))).toBeUndefined()
    expect(composeImageDigest('not json')).toBeUndefined()
  })

  it('is read from a Confidential Space token', () => {
    const token = (claims: unknown) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
    expect(tokenImageDigest(token({ submods: { container: { image_digest: DIGEST } } }))).toBe(DIGEST)
    expect(tokenImageDigest(token({ submods: {} }))).toBeUndefined()
    expect(tokenImageDigest('garbage')).toBeUndefined()
  })
})

describe('imageBuildRecord', () => {
  const answer = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  const blob = JSON.stringify(record)
  const blobDigest = `sha256:${createHash('sha256').update(blob).digest('hex')}`
  const registry = 'https://ghcr.io/v2/antseed/tee-seller'
  /** GHCR serving the record the way the publish workflow pushes it, and GitHub's API answering `github`. */
  const routes = (digest: string, github: () => Response, { bundle = blob, hasRecord = true } = {}) => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      if (url.startsWith('https://ghcr.io/token')) return answer(200, { token: 't' })
      if (url === `${registry}/manifests/${digest.replace(':', '-')}`) {
        if (!hasRecord) return answer(404, {})
        return answer(200, { manifests: [
          { digest: 'sha256:sbom', artifactType: 'application/spdx+json' },
          { digest: 'sha256:prov', artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json', annotations: { 'dev.sigstore.bundle.predicateType': 'https://slsa.dev/provenance/v1' } },
        ] })
      }
      if (url === `${registry}/manifests/sha256:prov`) return answer(200, { layers: [{ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', digest: blobDigest }] })
      if (url === `${registry}/blobs/${blobDigest}`) return answer(200, bundle)
      if (url.startsWith('https://api.github.com/')) return github()
      return answer(404, {})
    }) as unknown as typeof fetch
    return { urls, fetchImpl }
  }
  const githubRecord = () => answer(200, { attestations: [{ bundle: { from: 'github' } }] })

  it('fetches the record from the image registry once per digest', async () => {
    const digest = `sha256:${'1'.repeat(64)}`
    const { urls, fetchImpl } = routes(digest, githubRecord)
    expect(await imageBuildRecord(digest, fetchImpl, 0)).toEqual(record)
    expect(await imageBuildRecord(digest, fetchImpl, 3_600_000)).toEqual(record)
    expect(urls.filter((u) => u.startsWith('https://api.github.com/'))).toEqual([])
    expect(urls.filter((u) => u.includes('/blobs/'))).toHaveLength(1)
  })

  it("falls back to GitHub's attestations API when the registry has no record or a corrupted one", async () => {
    const missing = `sha256:${'4'.repeat(64)}`
    expect(await imageBuildRecord(missing, routes(missing, githubRecord, { hasRecord: false }).fetchImpl, 0)).toEqual({ from: 'github' })
    const corrupted = `sha256:${'5'.repeat(64)}`
    const { urls, fetchImpl } = routes(corrupted, githubRecord, { bundle: blob.replace('dsseEnvelope', 'dsseEnvelopX') })
    expect(await imageBuildRecord(corrupted, fetchImpl, 0)).toEqual({ from: 'github' })
    expect(urls.at(-1)).toBe(`https://api.github.com/repos/Antseed/antseed/attestations/${corrupted}?predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1`)
  })

  it('answers undefined without a record, and tries again after a while', async () => {
    let calls = 0
    const digest = `sha256:${'2'.repeat(64)}`
    const { fetchImpl } = routes(digest, () => { calls++; return calls === 1 ? answer(500, {}) : answer(404, {}) }, { hasRecord: false })
    expect(await imageBuildRecord(digest, fetchImpl, 0)).toBeUndefined()
    expect(await imageBuildRecord(digest, fetchImpl, 60_000)).toBeUndefined()
    expect(calls).toBe(1)
    expect(await imageBuildRecord(digest, fetchImpl, 11 * 60_000)).toBeUndefined()
    expect(calls).toBe(2)
    expect(await imageBuildRecord(undefined, fetchImpl)).toBeUndefined()
  })
})
