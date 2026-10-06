import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'

// Stub the configfs collector so the node cap collect runs off-TEE. It echoes the report_data
// back as the quote, so a test can assert the nonce and peer binding the collector applied.
vi.mock('../collect/configfs.js', () => ({
  generateTdxQuote: (reportData: Uint8Array) => reportData,
}))

import {
  NODE_TEE_CAP_ID,
  PROVIDER_TEE_CAP_ID,
  decodeTeeTdxEvidence,
  encodeTeeTdxEvidence,
  nodeTeeCapability,
  providerTeeCapability,
  tdxConfigKey,
  verifyTdxEvidence,
  type TdMeasurements,
  type VerifyQuoteFn,
} from './tee-tdx.js'
import type { Capability } from '../capability.js'
import { claimId, computeReportData } from '../shared.js'
import { noncePubkeySha256V1 } from '../report-data.js'

const NONCE = randomBytes(32)
const PEER = 'f'.repeat(40)

afterEach(() => vi.unstubAllGlobals())

/**
 * A TD10 measurement set. Override fields per test. report_data defaults to the node cap
 * antseed-rd-v1 {peerId} binding, so the node binding check passes unless a test overrides it.
 */
function td(over: Partial<TdMeasurements> = {}): TdMeasurements {
  return {
    mrTd: new Uint8Array(48).fill(0xaa),
    rtMr0: new Uint8Array(48),
    rtMr1: new Uint8Array(48),
    rtMr2: new Uint8Array(48),
    rtMr3: new Uint8Array(48),
    reportData: new Uint8Array(computeReportData(NONCE, PEER)),
    debug: false,
    ...over,
  }
}

/** Run verifyTdxEvidence with a stub DCAP, then the cap policy check, as the orchestrator does. */
async function run(cap: Capability, stub: VerifyQuoteFn, evidence = encodeTeeTdxEvidence(randomBytes(64))) {
  const parsed = await verifyTdxEvidence(evidence, stub, Math.floor(Date.now() / 1000))
  return cap.verify({ nonce: NONCE, peerId: PEER, evidence, parsedQuote: parsed })
}

// One factory builds the verify logic for both caps. Exercise it through the node cap.
describe('TDX cap verify (seller-node-tee-genuine)', () => {
  const CLAIM = claimId(NODE_TEE_CAP_ID)

  it('passes on acceptable TCB + TDX quote + debug off', async () => {
    const r = await run(nodeTeeCapability, async () => ({ status: 'UpToDate', td: td() }))
    expect(r).toMatchObject({ claim: CLAIM, ok: true })
    expect(r.detail).toMatch(/genuine Intel TDX quote/)
  })

  it('accepts SWHardeningNeeded', async () => {
    expect((await run(nodeTeeCapability, async () => ({ status: 'SWHardeningNeeded', td: td() }))).ok).toBe(true)
  })

  it('rejects an unacceptable TCB status', async () => {
    const r = await run(nodeTeeCapability, async () => ({ status: 'OutOfDate', td: td() }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/TCB status not acceptable: OutOfDate/)
  })

  it('rejects a non-TDX quote', async () => {
    const r = await run(nodeTeeCapability, async () => ({ status: 'UpToDate', td: null }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/not an Intel TDX quote/)
  })

  it('rejects a debug-enabled TD', async () => {
    const r = await run(nodeTeeCapability, async () => ({ status: 'UpToDate', td: td({ debug: true }) }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/debug mode is enabled/)
  })

  it('rejects a genuine quote whose report_data is not bound to this nonce+peerId', async () => {
    // A borrowed, relayed, or replayed genuine quote. Everything checks out except the binding.
    const r = await run(nodeTeeCapability, async () => ({ status: 'UpToDate', td: td({ reportData: new Uint8Array(64) }) }))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/does not match scheme "antseed-rd-v1"/)
  })

  it('rejects SWHardeningNeeded when ANTSEED_VERIFIER_STRICT_TCB=true', async () => {
    process.env['ANTSEED_VERIFIER_STRICT_TCB'] = 'true'
    try {
      const r = await run(nodeTeeCapability, async () => ({ status: 'SWHardeningNeeded', td: td() }))
      expect(r.ok).toBe(false)
      expect(r.detail).toMatch(/TCB status not acceptable: SWHardeningNeeded/)
    } finally {
      delete process.env['ANTSEED_VERIFIER_STRICT_TCB']
    }
  })

  it('fails (never throws) when DCAP verification throws', async () => {
    const r = await run(nodeTeeCapability, async () => { throw new Error('bad signature') })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/quote verification failed: bad signature/)
  })

  it('fails on malformed evidence', async () => {
    const r = await run(nodeTeeCapability, async () => ({ status: 'UpToDate', td: td() }), new TextEncoder().encode('not json'))
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/malformed tee-tdx evidence/)
  })

  it('fails when the seller returned no quote', () => {
    const r = nodeTeeCapability.verify({ nonce: NONCE, peerId: PEER })
    expect(r).toMatchObject({ claim: CLAIM, ok: false })
    expect((r as { detail: string }).detail).toMatch(/no TDX quote/)
  })
})

// The provider cap verifies a foreign report_data scheme declared in the evidence (Chutes flow).
describe('provider cap — declared report_data scheme binding', () => {
  const now = Math.floor(Date.now() / 1000)
  const PUBKEY = Buffer.from(randomBytes(32)).toString('base64')
  // Stub DCAP reflects the quote bytes as report_data. Real DCAP reads them from the quote.
  const reflect: VerifyQuoteFn = async (quote) => ({
    status: 'UpToDate',
    td: td({ reportData: quote.length >= 64 ? new Uint8Array(quote.subarray(0, 64)) : new Uint8Array(64) }),
  })

  it('passes when the provider quote report_data matches the declared scheme + ingredients', async () => {
    const rd = noncePubkeySha256V1.build(NONCE, { e2ePubkey: PUBKEY }) // commitment in [0:32]
    const ev = encodeTeeTdxEvidence(rd, undefined, { scheme: 'nonce-pubkey-sha256-v1', ingredients: { e2ePubkey: PUBKEY } })
    const parsed = await verifyTdxEvidence(ev, reflect, now)
    const r = await providerTeeCapability.verify({ nonce: NONCE, peerId: PEER, evidence: ev, parsedQuote: parsed })
    expect(r.ok).toBe(true)
  })

  it('fails closed when report_data does not match the declared scheme (wrong pubkey / relayed quote)', async () => {
    const rd = noncePubkeySha256V1.build(NONCE, { e2ePubkey: PUBKEY })
    const ev = encodeTeeTdxEvidence(rd, undefined, { scheme: 'nonce-pubkey-sha256-v1', ingredients: { e2ePubkey: 'AAAA' } })
    const parsed = await verifyTdxEvidence(ev, reflect, now)
    const r = await providerTeeCapability.verify({ nonce: NONCE, peerId: PEER, evidence: ev, parsedQuote: parsed })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/does not match scheme/)
  })

  it('with no declared scheme, stays genuineness-only', async () => {
    const r = await run(providerTeeCapability, async () => ({ status: 'UpToDate', td: td() }))
    expect(r.ok).toBe(true) // no binding on the evidence, so report_data is not checked
  })
})

// Both caps come from the same factory but carry distinct ids and independent evidence.
describe('two TDX caps from one factory', () => {
  it('the provider cap verifies to its own distinct claim id', async () => {
    const r = await run(providerTeeCapability, async () => ({ status: 'UpToDate', td: td() }))
    expect(r).toMatchObject({ claim: claimId(PROVIDER_TEE_CAP_ID), ok: true })
    expect(nodeTeeCapability.id).toBe('seller-node-tee-genuine')
    expect(providerTeeCapability.id).toBe('seller-provider-tee-genuine')
  })
})

describe('seller-node-tee-genuine collect (configfs, stubbed)', () => {
  it('mints a quote bound to report_data = SHA-512(nonce ‖ peerId)', async () => {
    const ev = await nodeTeeCapability.collect!({ nonce: NONCE, peerId: PEER, config: {} })
    const { quote } = decodeTeeTdxEvidence(ev)
    // The stub echoes report_data as the quote. Assert the collector bound nonce and peer.
    expect(Buffer.from(quote).equals(computeReportData(NONCE, PEER))).toBe(true)
  })
})

describe('seller-provider-tee-genuine collect (http, stubbed fetch)', () => {
  it('fetches the {nonce}-hex route and extracts the base64 quote at FIELD', async () => {
    const quoteBytes = randomBytes(96)
    let seenUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seenUrl = url
      return { ok: true, json: async () => ({ quote: Buffer.from(quoteBytes).toString('base64') }) }
    }))
    const config = {
      [tdxConfigKey(PROVIDER_TEE_CAP_ID, 'url')]: 'https://provider.example/evidence/{nonce}',
      [tdxConfigKey(PROVIDER_TEE_CAP_ID, 'field')]: 'quote',
    }
    const ev = await providerTeeCapability.collect!({ nonce: NONCE, peerId: PEER, config })
    expect(seenUrl).toBe(`https://provider.example/evidence/${Buffer.from(NONCE).toString('hex')}`)
    expect(Buffer.from(decodeTeeTdxEvidence(ev).quote).equals(quoteBytes)).toBe(true)
  })

  it('is not offered (throws) when no provider evidence url is configured', async () => {
    await expect(providerTeeCapability.collect!({ nonce: NONCE, peerId: PEER, config: {} })).rejects.toThrow(/requires an evidence url/)
  })
})

/**
 * Lock the TD10 field locations defaultVerifyQuote relies on
 * (asTd10().mrTd, rtMr0, tdAttributes, reportData) against the @phala/dcap-qvl parser.
 * Use a synthetic but structurally valid v4 TDX quote. The GCP e2e exercises the full
 * cryptographic verify, which needs a genuine signed quote and collateral.
 */
describe('@phala/dcap-qvl TD10 field extraction', () => {
  it('exposes mrTd, rtMr0, tdAttributes and reportData at the expected offsets', async () => {
    const mrTd = randomBytes(48)
    const rtMr0 = randomBytes(48)
    const reportData = randomBytes(64)
    const tdAttributes = Buffer.from([0x01, 0, 0, 0, 0, 0, 0, 0]) // DEBUG bit set
    const quote = buildSyntheticTdxQuote({ mrTd, rtMr0, reportData, tdAttributes })
    const mod = (await import('@phala/dcap-qvl')) as typeof import('@phala/dcap-qvl') & { default?: typeof import('@phala/dcap-qvl') }
    const dcap = mod.default ?? mod
    const t = dcap.Quote.parse(quote).report.asTd10()
    expect(t).not.toBeNull()
    expect(Buffer.from(t!.mrTd).equals(mrTd)).toBe(true)
    expect(Buffer.from(t!.rtMr0).equals(rtMr0)).toBe(true)
    expect(Buffer.from(t!.reportData).equals(reportData)).toBe(true)
    expect((t!.tdAttributes[0]! & 0x01) === 1).toBe(true)
  })
})

/** Minimal v4 TDX quote Quote.parse accepts, with chosen TD10 fields at their real offsets. */
function buildSyntheticTdxQuote(fields: { mrTd: Uint8Array; rtMr0: Uint8Array; reportData: Uint8Array; tdAttributes: Uint8Array }): Uint8Array {
  const header = Buffer.alloc(48)
  header.writeUInt16LE(4, 0) // version
  header.writeUInt16LE(2, 2) // attestation key type
  header.writeUInt32LE(0x00000081, 4) // teeType = TDX

  // TD10 report (584 bytes). Offsets: tdAttributes=120, mrTd=136, rtMr0=328, reportData=520.
  const tdReport = Buffer.alloc(584)
  Buffer.from(fields.tdAttributes).copy(tdReport, 120)
  Buffer.from(fields.mrTd).copy(tdReport, 136)
  Buffer.from(fields.rtMr0).copy(tdReport, 328)
  Buffer.from(fields.reportData).copy(tdReport, 520)

  const qeCertBody = Buffer.alloc(384 + 64 + 2 + 2 + 4) // qeReport + sig + authSize=0 + cert(type,size)=0
  const certHeader = Buffer.alloc(6)
  certHeader.writeUInt16LE(5, 0) // certType = PCK_CERT_CHAIN
  certHeader.writeUInt32LE(qeCertBody.length, 2)
  const authData = Buffer.concat([Buffer.alloc(64), Buffer.alloc(64), certHeader, qeCertBody])
  const authSize = Buffer.alloc(4)
  authSize.writeUInt32LE(authData.length, 0)

  return new Uint8Array(Buffer.concat([header, tdReport, authSize, authData]))
}
