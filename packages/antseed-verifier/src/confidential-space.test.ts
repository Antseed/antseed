import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, type JWTPayload } from 'jose'
import { CS_AUDIENCE, CS_ISSUER, CS_SECRETS_ENV, CS_SELLER_CONFIG_ENV, checkConfidentialSpaceClaims, confidentialSpaceNonce } from './confidential-space.js'
import { NODE_TEE_CAP_ID, NODE_UPSTREAMS_CLAIM, encodeConfidentialSpaceEvidence, nodeTeeCapability, providerTeeCapability, verifyTdxEvidence } from './caps/tee-tdx.js'
import { claimId, computeReportData } from './shared.js'
import { TEST_IMAGE } from './dstack-build.fixture.js'

const NONCE = randomBytes(32)
const PEER = 'f'.repeat(40)
const BINDING = 'c'.repeat(64)
const ROUND_NONCE = confidentialSpaceNonce(computeReportData(NONCE, PEER, BINDING))
const CONFIG = { seller: { providers: { venice: { plugin: 'openai', baseUrl: 'https://api.venice.ai/api', apiKeyEnv: 'VENICE_API_KEY', services: {} } } } }

/** Claims as Google issues them for a conforming production workload. */
function claims(over: Record<string, unknown> = {}, env: Record<string, string> = {}): JWTPayload {
  return {
    iss: CS_ISSUER,
    aud: CS_AUDIENCE,
    eat_nonce: [ROUND_NONCE],
    hwmodel: 'GCP_INTEL_TDX',
    swname: 'CONFIDENTIAL_SPACE',
    dbgstat: 'disabled-since-boot',
    secboot: true,
    submods: {
      confidential_space: { support_attributes: ['LATEST', 'STABLE', 'USABLE'] },
      container: {
        image_digest: TEST_IMAGE.digest,
        env_override: {
          ANTSEED_TEE_PEER_ID: PEER,
          [CS_SELLER_CONFIG_ENV]: JSON.stringify(CONFIG),
          [CS_SECRETS_ENV]: JSON.stringify({
            audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/attestation',
            secrets: { ANTSEED_IDENTITY_HEX: 'projects/1/secrets/identity/versions/1', VENICE_API_KEY: 'projects/1/secrets/venice/versions/latest' },
          }),
          ...env,
        },
      },
    },
    ...over,
  }
}

const check = (c: JWTPayload) => checkConfidentialSpaceClaims(c, ROUND_NONCE, [TEST_IMAGE])

describe('checkConfidentialSpaceClaims', () => {
  it('accepts a production Confidential Space workload running an approved image, and reports its upstreams', () => {
    expect(check(claims())).toEqual({ image: TEST_IMAGE, upstreams: [{ provider: 'venice', plugin: 'openai', origin: 'https://api.venice.ai' }] })
  })

  it('requires the round and connection nonce', () => {
    expect(check(claims({ eat_nonce: ['00'.repeat(32)] }))).toEqual({ error: 'Confidential Space token is not bound to this round and connection' })
    expect(checkConfidentialSpaceClaims(claims(), confidentialSpaceNonce(computeReportData(NONCE, PEER, 'd'.repeat(64))), [TEST_IMAGE])).toMatchObject({ error: expect.stringMatching(/not bound/) })
  })

  it('requires Intel TDX, a production image with debugging off, and Secure Boot', () => {
    expect(check(claims({ hwmodel: 'GCP_AMD_SEV' }))).toMatchObject({ error: expect.stringMatching(/not Intel TDX/) })
    expect(check(claims({ swname: 'GCE' }))).toMatchObject({ error: expect.stringMatching(/not from a Confidential Space image/) })
    expect(check(claims({ dbgstat: 'enabled' }))).toMatchObject({ error: expect.stringMatching(/debug image/) })
    expect(check(claims({ secboot: false }))).toMatchObject({ error: expect.stringMatching(/Secure Boot/) })
    const debugImage = claims()
    ;(debugImage['submods'] as any).confidential_space.support_attributes = []
    expect(check(debugImage)).toMatchObject({ error: expect.stringMatching(/production release/) })
  })

  it('requires an approved image digest', () => {
    const other = claims()
    ;(other['submods'] as any).container.image_digest = `sha256:${'ab'.repeat(32)}`
    expect(check(other)).toMatchObject({ error: expect.stringMatching(/not an approved Antseed TEE seller image/) })
  })

  it('rejects overrides that could redirect prompts or expose secrets', () => {
    expect(check(claims({}, { OPENAI_BASE_URL: 'https://collector.example' }))).toMatchObject({ error: 'environment OPENAI_BASE_URL is not allowed' })
    expect(check(claims({}, { HTTPS_PROXY: 'http://proxy.example' }))).toMatchObject({ error: 'environment HTTPS_PROXY is not allowed' })
    expect(check(claims({}, { VENICE_API_KEY: 'sk-…' }))).toMatchObject({ error: 'environment VENICE_API_KEY is not allowed' })
    expect(check(claims({}, { OPENAI_BODY_INJECT_JSON: '{"venice_parameters":{"include_venice_system_prompt":false}}' }))).not.toHaveProperty('error')
  })

  it('applies the seller config rules to the config override', () => {
    const http = { seller: { providers: { o: { plugin: 'openai', baseUrl: 'http://upstream.example', apiKeyEnv: 'VENICE_API_KEY', services: {} } } } }
    expect(check(claims({}, { [CS_SELLER_CONFIG_ENV]: JSON.stringify(http) }))).toMatchObject({ error: expect.stringMatching(/https URL/) })
    const withoutConfig = claims()
    delete (withoutConfig['submods'] as any).container.env_override[CS_SELLER_CONFIG_ENV]
    expect(check(withoutConfig)).toMatchObject({ error: expect.stringMatching(/seller config must be set/) })
  })

  it('only fetches secrets the config names as API keys, or the node identity and RPC URL', () => {
    const secrets = (s: Record<string, string>) => claims({}, { [CS_SECRETS_ENV]: JSON.stringify({ audience: 'x', secrets: s }) })
    expect(check(secrets({ ANTSEED_BASE_RPC_URL: 'projects/1/secrets/rpc/versions/1' }))).not.toHaveProperty('error')
    expect(check(secrets({ OTHER_API_KEY: 'projects/1/secrets/o/versions/1' }))).toMatchObject({ error: expect.stringMatching(/OTHER_API_KEY is hidden but is not an API key/) })
    expect(check(secrets({ OPENAI_BASE_URL: 'projects/1/secrets/o/versions/1' }))).toMatchObject({ error: expect.stringMatching(/OPENAI_BASE_URL is hidden/) })
    expect(check(secrets({ VENICE_API_KEY: 'https://elsewhere.example/key' }))).toMatchObject({ error: expect.stringMatching(/Secret Manager version/) })
  })
})

describe('seller node on Confidential Space', () => {
  async function signer() {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256' }] })
    const sign = (payload: JWTPayload, issuer = CS_ISSUER) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer(issuer).setAudience(CS_AUDIENCE).setIssuedAt().setExpirationTime('1h').sign(privateKey)
    const verifyToken = async (token: string) => (await jwtVerify(token, jwks, { issuer: CS_ISSUER, audience: CS_AUDIENCE })).payload
    return { sign, verifyToken }
  }
  const run = async (token: string, verifyToken: (t: string) => Promise<JWTPayload>, cap = nodeTeeCapability, channelBinding: string | null = BINDING) => {
    const evidence = encodeConfidentialSpaceEvidence(token)
    const parsedQuote = await verifyTdxEvidence(evidence, async () => { throw new Error('no quote') }, 0, verifyToken)
    const out = await cap.verify({ nonce: NONCE, peerId: PEER, evidence, parsedQuote, policy: { os: [], images: [TEST_IMAGE] }, ...(channelBinding !== null ? { channelBinding } : {}) })
    return Array.isArray(out) ? out : [out]
  }

  it('passes on a Google-signed token for this round, and reports the upstreams', async () => {
    const { sign, verifyToken } = await signer()
    const { iss: _i, aud: _a, ...payload } = claims()
    const out = await run(await sign(payload), verifyToken)
    expect(out).toEqual([
      expect.objectContaining({ claim: claimId(NODE_TEE_CAP_ID), ok: true, detail: expect.stringMatching(/Google Confidential Space .*image 0\.0\.0-test, bound to this connection/) }),
      { claim: claimId(NODE_UPSTREAMS_CLAIM), ok: true, detail: 'https://api.venice.ai' },
    ])
  })

  it('fails on a token Google did not sign, or from another issuer', async () => {
    const { iss: _i, aud: _a, ...payload } = claims()
    const ours = await signer()
    const theirs = await signer()
    expect((await run(await theirs.sign(payload), ours.verifyToken))[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/token verification failed/) })
    expect((await run(await ours.sign(payload, 'https://evil.example'), ours.verifyToken))[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/token verification failed/) })
  })

  it('fails without a connection binding or on another connection', async () => {
    const { sign, verifyToken } = await signer()
    const { iss: _i, aud: _a, ...payload } = claims()
    const token = await sign(payload)
    expect((await run(token, verifyToken, nodeTeeCapability, null))[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/no connection binding/) })
    expect((await run(token, verifyToken, nodeTeeCapability, 'd'.repeat(64)))[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/not bound to this round and connection/) })
  })

  it('is not accepted as provider evidence', async () => {
    const { sign, verifyToken } = await signer()
    const { iss: _i, aud: _a, ...payload } = claims()
    expect((await run(await sign(payload), verifyToken, providerTeeCapability))[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/only accepted for the seller node/) })
  })
})
