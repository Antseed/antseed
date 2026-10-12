import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import type { ClaimResult } from '../antseed-node-types.js'
import {
  PROVIDER_CLAIMS_CAP_ID,
  PROVIDER_CLAIMS_MENU,
  claimsConfigKey,
  claimsReportData,
  providerClaimsCapability,
} from './provider-claims.js'
import type { ParsedTdxQuote, TdMeasurements } from './tee-tdx.js'
import { claimId } from '../shared.js'

const NONCE = randomBytes(32)
const PEER = 'ab'.repeat(20)
const PARENT = claimId(PROVIDER_CLAIMS_CAP_ID)
const DIGEST = `sha256:${'a'.repeat(64)}`

/** Claim id of one named provider claim: <verifier>:seller-provider-claims/<name>. */
const child = (name: string): string => `${PARENT}/${name}`

function doc(claims: Record<string, unknown>, version: unknown = 1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version, claims }))
}

/** TDX report_data is 64 bytes. The provider commitment occupies [0:32]. */
function rd64(commitment: Uint8Array): Uint8Array {
  const out = new Uint8Array(64)
  out.set(commitment.subarray(0, 32), 0)
  return out
}

function td(commitment: Uint8Array, over: Partial<TdMeasurements> = {}): TdMeasurements {
  return {
    mrTd: new Uint8Array(48).fill(7),
    rtMr0: new Uint8Array(48),
    rtMr1: new Uint8Array(48),
    rtMr2: new Uint8Array(48),
    rtMr3: new Uint8Array(48),
    reportData: rd64(commitment),
    debug: false,
    ...over,
  }
}

/** A provider TDX parse as the orchestrator hands it over. Default is genuine with current TCB. */
function parsed(reportData: Uint8Array, over: Partial<ParsedTdxQuote> = {}): ParsedTdxQuote {
  return { quoteEvidence: new Uint8Array([1]), status: 'UpToDate', td: td(reportData), ...over }
}

async function verify(
  evidence: Uint8Array | undefined,
  parsedQuote?: ParsedTdxQuote,
): Promise<ClaimResult[]> {
  const out = await providerClaimsCapability.verify({ nonce: NONCE, peerId: PEER, evidence, parsedQuote })
  return Array.isArray(out) ? out : [out]
}

const find = (claims: ClaimResult[], id: string): ClaimResult | undefined =>
  claims.find((c) => c.claim === id)

afterEach(() => vi.unstubAllGlobals())

describe('claimsReportData', () => {
  it('is the 32-byte report_data[0:32] commitment and binds both nonce and document', () => {
    const bytes = doc({ 'model-id': 'm' })
    const rd = claimsReportData(NONCE, bytes)
    expect(rd.length).toBe(32)
    expect(Buffer.from(claimsReportData(NONCE, bytes)).equals(rd)).toBe(true)
    expect(Buffer.from(claimsReportData(randomBytes(32), bytes)).equals(rd)).toBe(false)
    expect(Buffer.from(claimsReportData(NONCE, doc({ 'model-id': 'other' }))).equals(rd)).toBe(false)
  })
})

describe('PROVIDER_CLAIMS_MENU — the menu is FROZEN in the SDK (a version-pinned artifact)', () => {
  it('defines exactly the v0.1 claims, each with a required proof level and a validator', () => {
    expect(Object.keys(PROVIDER_CLAIMS_MENU).sort()).toEqual(['model-id', 'serving-image-digest'])
    expect(PROVIDER_CLAIMS_MENU['model-id']!.proof).toBe('asserted')
    expect(PROVIDER_CLAIMS_MENU['serving-image-digest']!.proof).toBe('tdx-quote')
    for (const def of Object.values(PROVIDER_CLAIMS_MENU)) {
      expect(typeof def.validate).toBe('function')
    }
  })
})

describe('providerClaimsCapability.verify — document-level failures (one parent claim)', () => {
  it('fails when the seller returned no claims document', async () => {
    const r = await verify(undefined)
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ claim: PARENT, ok: false })
    expect(r[0]!.detail).toMatch(/no claims document/)
  })

  it('fails on malformed JSON', async () => {
    const r = await verify(new TextEncoder().encode('not json'))
    expect(r[0]).toMatchObject({ claim: PARENT, ok: false })
    expect(r[0]!.detail).toMatch(/malformed claims document/)
  })

  it('fails on an unsupported document version', async () => {
    const r = await verify(doc({ 'model-id': 'm' }, 2))
    expect(r[0]).toMatchObject({ claim: PARENT, ok: false })
    expect(r[0]!.detail).toMatch(/unsupported claims document version/)
  })

  it('fails when the document declares no claims', async () => {
    const r = await verify(doc({}))
    expect(r[0]).toMatchObject({ claim: PARENT, ok: false })
    expect(r[0]!.detail).toMatch(/declares no claims/)
  })

  it('rejects the whole document on an id-unsafe claim name', async () => {
    const r = await verify(doc({ 'Bad Name': 'x', 'model-id': 'm' }))
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ claim: PARENT, ok: false })
    expect(r[0]!.detail).toMatch(/invalid claim name/)
  })

  it('rejects a document with too many claims', async () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 65; i++) many[`claim-${i}`] = i
    const r = await verify(doc(many))
    expect(r[0]).toMatchObject({ claim: PARENT, ok: false })
    expect(r[0]!.detail).toMatch(/too many claims/)
  })
})

describe('providerClaimsCapability.verify — the SDK menu is authoritative, never the document', () => {
  it('emits one namespaced ClaimResult per declared claim', async () => {
    const r = await verify(doc({ 'model-id': 'llama-3.1-70b', 'serving-image-digest': DIGEST }))
    expect(r).toHaveLength(2)
    expect(find(r, child('model-id'))).toBeDefined()
    expect(find(r, child('serving-image-digest'))).toBeDefined()
  })

  it('a claim name outside the frozen menu can never pass', async () => {
    const r = await verify(doc({ 'my-custom-claim': 'anything' }))
    const c = find(r, child('my-custom-claim'))
    expect(c?.ok).toBe(false)
    expect(c?.detail).toMatch(/not in this SDK version's frozen claims menu/)
  })

  it('validates values with the SDK-frozen validator, not provider-supplied semantics', async () => {
    const r = await verify(doc({ 'model-id': 42 }))
    const c = find(r, child('model-id'))
    expect(c?.ok).toBe(false)
    expect(c?.detail).toMatch(/invalid value/)
  })
})

describe('providerClaimsCapability.verify — proof requirements are frozen per claim', () => {
  it('an asserted-level claim (model-id) passes without a provider quote', async () => {
    const r = await verify(doc({ 'model-id': 'llama-3.1-70b' }))
    const c = find(r, child('model-id'))
    expect(c?.ok).toBe(true)
    expect(c?.detail).toMatch(/provider-asserted only, NOT independently verified/)
    expect(c?.detail).toContain('llama-3.1-70b')
  })

  it('a tdx-quote-required claim (serving-image-digest) fails without a provider quote', async () => {
    const r = await verify(doc({ 'serving-image-digest': DIGEST }))
    const c = find(r, child('serving-image-digest'))
    expect(c?.ok).toBe(false)
    expect(c?.detail).toMatch(/no verified provider TDX quote/)
  })

  it('a tdx-quote-required claim passes when the verified quote commits to this document', async () => {
    const bytes = doc({ 'serving-image-digest': DIGEST })
    const c = find(await verify(bytes, parsed(claimsReportData(NONCE, bytes))), child('serving-image-digest'))
    expect(c?.ok).toBe(true)
    expect(c?.detail).toMatch(/attested by provider TEE/)
  })

  it('an invalid value fails even when the quote binding holds', async () => {
    const bytes = doc({ 'serving-image-digest': 'sha256:short' })
    const c = find(await verify(bytes, parsed(claimsReportData(NONCE, bytes))), child('serving-image-digest'))
    expect(c?.ok).toBe(false)
    expect(c?.detail).toMatch(/invalid value/)
  })

  it('an asserted-level claim is upgraded to TEE-attested when the document is quote-bound', async () => {
    const bytes = doc({ 'model-id': 'llama-3.1-70b' })
    const c = find(await verify(bytes, parsed(claimsReportData(NONCE, bytes))), child('model-id'))
    expect(c?.ok).toBe(true)
    expect(c?.detail).toMatch(/attested by provider TEE/)
  })

  it('fails tdx-quote claims when the quote itself did not verify', async () => {
    const bytes = doc({ 'serving-image-digest': DIGEST })
    const p = parsed(claimsReportData(NONCE, bytes), { td: null, status: '', error: 'quote verification failed: boom' })
    expect(find(await verify(bytes, p), child('serving-image-digest'))?.ok).toBe(false)
  })

  it('fails tdx-quote claims on an unacceptable provider TCB', async () => {
    const bytes = doc({ 'serving-image-digest': DIGEST })
    const c = find(await verify(bytes, parsed(claimsReportData(NONCE, bytes), { status: 'OutOfDate' })), child('serving-image-digest'))
    expect(c?.ok).toBe(false)
    expect(c?.detail).toMatch(/TCB/)
  })

  it('fails tdx-quote claims when TDX debug mode is enabled', async () => {
    const bytes = doc({ 'serving-image-digest': DIGEST })
    const p = parsed(claimsReportData(NONCE, bytes))
    p.td = td(claimsReportData(NONCE, bytes), { debug: true })
    expect(find(await verify(bytes, p), child('serving-image-digest'))?.ok).toBe(false)
  })

  it('fails tdx-quote claims when report_data does not commit to this document (stale/foreign doc)', async () => {
    const bytes = doc({ 'serving-image-digest': DIGEST })
    const foreign = parsed(claimsReportData(NONCE, doc({ 'model-id': 'other' })))
    const c = find(await verify(bytes, foreign), child('serving-image-digest'))
    expect(c?.ok).toBe(false)
    expect(c?.detail).toMatch(/report_data does not commit to this claims document/)
  })

  it('judges each claim independently: model-id passes while serving-image-digest fails', async () => {
    const r = await verify(doc({ 'model-id': 'llama-3.1-70b', 'serving-image-digest': DIGEST }))
    expect(find(r, child('model-id'))?.ok).toBe(true)
    expect(find(r, child('serving-image-digest'))?.ok).toBe(false)
  })
})

describe('providerClaimsCapability.collect', () => {
  it('is not offered without a configured evidence url', async () => {
    await expect(
      providerClaimsCapability.collect!({ nonce: NONCE, peerId: PEER, config: {} }),
    ).rejects.toThrow(/not offered/)
  })

  it('is not offered without a configured claims field', async () => {
    await expect(
      providerClaimsCapability.collect!({
        nonce: NONCE,
        peerId: PEER,
        config: { [claimsConfigKey('url')]: 'https://x.example/att/{nonce}' },
      }),
    ).rejects.toThrow(/not offered/)
  })

  it('fetches the provider route and returns the base64 claims document bytes VERBATIM', async () => {
    const bytes = doc({ 'model-id': 'llama-3.1-70b' })
    let seenUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      seenUrl = u
      return { ok: true, status: 200, json: async () => ({ claims_doc: Buffer.from(bytes).toString('base64') }) }
    }))
    const out = await providerClaimsCapability.collect!({
      nonce: NONCE,
      peerId: PEER,
      config: {
        [claimsConfigKey('url')]: 'https://x.example/att/{nonce}',
        [claimsConfigKey('field')]: 'claims_doc',
      },
    })
    expect(seenUrl).toBe(`https://x.example/att/${Buffer.from(NONCE).toString('hex')}`)
    // Byte-exact: the tdx-quote binding commits to these bytes, so no re-encoding is allowed.
    expect(Buffer.from(out).equals(bytes)).toBe(true)
  })
})
