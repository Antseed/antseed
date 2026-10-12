import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import prover from './prover.js'
import { decodeAttestResponse, encodeAttestRequest } from './shared.js'
import { PROVIDER_CLAIMS_CAP_ID } from './caps/provider-claims.js'
import { decodeTeeTdxEvidence } from './caps/tee-tdx.js'

/**
 * Seller-side opt-in semantics: the prover offers only the capabilities that the buyer
 * requests and this seller supports. It omits everything else instead of a failure. A
 * commit to the verifier does not commit to every claim.
 */

const PEER = 'ab'.repeat(20)
const NONCE = randomBytes(32)
const PROVIDER_TEE = 'seller-provider-tee-genuine'

const CLAIMS_DOC = new TextEncoder().encode(JSON.stringify({
  version: 1,
  claims: { 'model-id': 'llama-3.1-70b' },
}))

const ENV_KEYS = [
  'ANTSEED_TEE_PEER_ID',
  'ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL',
  'ANTSEED_VERIFIER_PROVIDER_TEE_FIELD',
  'ANTSEED_VERIFIER_PROVIDER_CLAIMS_FIELD',
  'ANTSEED_VERIFIER_PROVIDER_ADAPTER',
  'CHUTES_API_KEY',
  'CHUTES_CHUTE',
] as const
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  process.env['ANTSEED_TEE_PEER_ID'] = PEER
  process.env['ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL'] = 'https://prov.example/att/{nonce}'
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      quote: Buffer.from(randomBytes(64)).toString('base64'),
      claims_doc: Buffer.from(CLAIMS_DOC).toString('base64'),
    }),
  })))
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  vi.unstubAllGlobals()
})

async function attest(caps: string[]): Promise<Record<string, Uint8Array>> {
  const resp = await prover.prove({
    method: 'POST',
    path: '/_antseed/attest/antseed-verifier',
    headers: { 'content-type': 'application/json' },
    body: encodeAttestRequest(NONCE, caps),
  })
  expect(resp.statusCode).toBe(200)
  return decodeAttestResponse(resp.body)
}

describe('prover — provider-claims opt-in', () => {
  it('offers seller-provider-claims (verbatim doc bytes) when the claims field is configured', async () => {
    process.env['ANTSEED_VERIFIER_PROVIDER_CLAIMS_FIELD'] = 'claims_doc'
    const evidence = await attest([PROVIDER_TEE, PROVIDER_CLAIMS_CAP_ID])
    expect(evidence[PROVIDER_TEE]).toBeDefined()
    expect(Buffer.from(evidence[PROVIDER_CLAIMS_CAP_ID]!).equals(CLAIMS_DOC)).toBe(true)
  })

  it('omits seller-provider-claims when the claims field is not configured', async () => {
    delete process.env['ANTSEED_VERIFIER_PROVIDER_CLAIMS_FIELD']
    const evidence = await attest([PROVIDER_TEE, PROVIDER_CLAIMS_CAP_ID])
    expect(evidence[PROVIDER_TEE]).toBeDefined()
    expect(evidence[PROVIDER_CLAIMS_CAP_ID]).toBeUndefined()
  })

  it('omits any capability the buyer did not request, even when configured', async () => {
    process.env['ANTSEED_VERIFIER_PROVIDER_CLAIMS_FIELD'] = 'claims_doc'
    const evidence = await attest([PROVIDER_TEE])
    expect(evidence[PROVIDER_CLAIMS_CAP_ID]).toBeUndefined()
  })
})

describe('prover — in-process provider adapter', () => {
  it('chutes adapter fetches provider evidence in-process and binds it under seller-provider-tee-genuine', async () => {
    delete process.env['ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL'] // use the adapter path only
    process.env['ANTSEED_VERIFIER_PROVIDER_ADAPTER'] = 'chutes'
    process.env['CHUTES_API_KEY'] = 'k'
    process.env['CHUTES_CHUTE'] = 'mychute'
    const quoteBytes = randomBytes(64)
    // Chutes serves the pubkey and the quote from two endpoints; the adapter joins them.
    vi.stubGlobal('fetch', vi.fn(async (u: string) => ({
      ok: true,
      status: 200,
      json: async () => String(u).includes('/e2e/instances/')
        ? { instances: [{ instance_id: 'i-1', e2e_pubkey: 'cHVia2V5' }] }
        : { evidence: [{ instance_id: 'i-1', quote: Buffer.from(quoteBytes).toString('base64') }] },
    })))
    const evidence = await attest([PROVIDER_TEE])
    expect(evidence[PROVIDER_TEE]).toBeDefined()
    const { quote, binding } = decodeTeeTdxEvidence(evidence[PROVIDER_TEE]!)
    expect(Buffer.from(quote).equals(quoteBytes)).toBe(true)
    expect(binding?.scheme).toBe('nonce-pubkey-sha256-v1')
    expect(binding?.ingredients.e2ePubkey).toBe('cHVia2V5')
  })

  it('unknown adapter id omits the provider caps (not a hard failure)', async () => {
    delete process.env['ANTSEED_VERIFIER_PROVIDER_EVIDENCE_URL']
    process.env['ANTSEED_VERIFIER_PROVIDER_ADAPTER'] = 'nope'
    const evidence = await attest([PROVIDER_TEE])
    expect(evidence[PROVIDER_TEE]).toBeUndefined()
  })
})

describe('prover — collection summary log', () => {
  it('logs which caps collected evidence and which were skipped', async () => {
    // node-tee has no configfs in the test env, so it is skipped; provider-tee collects via the stub.
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    let summary: string | undefined
    try {
      await attest(['seller-node-tee-genuine', PROVIDER_TEE])
      summary = spy.mock.calls.map((c) => String(c[0])).find((w) => w.includes('attest: collected'))
    } finally {
      spy.mockRestore()
    }
    expect(summary).toBeDefined()
    expect(summary).toMatch(/collected \[[^\]]*seller-provider-tee-genuine/)
    expect(summary).toMatch(/skipped \[[^\]]*seller-node-tee-genuine/)
  })
})
