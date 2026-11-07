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
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it('fetches the record from GitHub once per digest', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => { urls.push(url); return answer(200, { attestations: [{ bundle: record }] }) }) as unknown as typeof fetch
    const digest = `sha256:${'1'.repeat(64)}`
    expect(await imageBuildRecord(digest, fetchImpl, 0)).toEqual(record)
    expect(await imageBuildRecord(digest, fetchImpl, 3_600_000)).toEqual(record)
    expect(urls).toEqual([`https://api.github.com/repos/Antseed/antseed/attestations/${digest}?predicate_type=https%3A%2F%2Fslsa.dev%2Fprovenance%2Fv1`])
  })

  it('answers undefined without a record, and tries again after a while', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls++; return calls === 1 ? answer(500, {}) : answer(404, {}) }) as unknown as typeof fetch
    const digest = `sha256:${'2'.repeat(64)}`
    expect(await imageBuildRecord(digest, fetchImpl, 0)).toBeUndefined()
    expect(await imageBuildRecord(digest, fetchImpl, 60_000)).toBeUndefined()
    expect(calls).toBe(1)
    expect(await imageBuildRecord(digest, fetchImpl, 11 * 60_000)).toBeUndefined()
    expect(calls).toBe(2)
    expect(await imageBuildRecord(undefined, fetchImpl)).toBeUndefined()
  })
})
