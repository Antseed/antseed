import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  antseedRdV1,
  noncePubkeySha256V1,
  aciKeysetV1,
  getReportDataScheme,
  verifyReportData,
  type BindingIngredients,
} from './report-data.js'

const NONCE = randomBytes(32)
const PEER = 'ab'.repeat(20)
const PUBKEY = Buffer.from(randomBytes(32)).toString('base64')
const KEYSET_DIGEST = `sha256:${createHash('sha256').update('keyset').digest('hex')}`
const aciStatement = (digest: string, nonce: Uint8Array) =>
  `{"keyset_digest":"${digest}","nonce":"${Buffer.from(nonce).toString('hex')}","purpose":"aci.report_data.v1"}`

describe('antseed-rd-v1 (compositional)', () => {
  it('is 64 bytes, deterministic, and always binds the nonce', () => {
    const a = antseedRdV1.build(NONCE, { peerId: PEER })
    expect(a.length).toBe(64)
    expect(Buffer.from(antseedRdV1.build(NONCE, { peerId: PEER })).equals(a)).toBe(true)
    expect(Buffer.from(antseedRdV1.build(randomBytes(32), { peerId: PEER })).equals(a)).toBe(false)
  })

  it('toggles fields by ingredient presence — more fields changes the commitment', () => {
    const base = antseedRdV1.build(NONCE, { peerId: PEER })
    const withKey = antseedRdV1.build(NONCE, { peerId: PEER, e2ePubkey: PUBKEY })
    expect(Buffer.from(withKey).equals(base)).toBe(false)
  })

  it('is canonical regardless of ingredient object key order', () => {
    const x = antseedRdV1.build(NONCE, { peerId: PEER, e2ePubkey: PUBKEY })
    const y = antseedRdV1.build(NONCE, { e2ePubkey: PUBKEY, peerId: PEER })
    expect(Buffer.from(x).equals(y)).toBe(true)
  })

  it('the node cap is the {peerId} instance', () => {
    const rd = antseedRdV1.build(NONCE, { peerId: PEER })
    // domain ‖ len(nonce)‖nonce ‖ tag(0x01) ‖ len(20)‖20-byte-address
    const lp = (b: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length, 0); return Buffer.concat([l, b]) }
    const expected = createHash('sha512')
      .update(Buffer.from('antseed-rd-v1', 'utf8'))
      .update(lp(Buffer.from(NONCE)))
      .update(Buffer.from([0x01]))
      .update(lp(Buffer.from(PEER, 'hex')))
      .digest()
    expect(Buffer.from(rd).equals(expected)).toBe(true)
  })

  it('the GPU nonce is the raw round nonce', () => {
    expect(Buffer.from(antseedRdV1.gpuNonce(NONCE, { peerId: PEER })).equals(NONCE)).toBe(true)
  })
})

describe('nonce-pubkey-sha256-v1 (foreign / Chutes)', () => {
  it('is SHA-256(nonce_hex ‖ pubkey_b64) in report_data[0:32]', () => {
    const rd = noncePubkeySha256V1.build(NONCE, { e2ePubkey: PUBKEY })
    expect(rd.length).toBe(64)
    const commit = createHash('sha256')
      .update(Buffer.from(NONCE).toString('hex'), 'utf8')
      .update(PUBKEY, 'utf8')
      .digest()
    expect(Buffer.from(rd.subarray(0, 32)).equals(commit)).toBe(true)
    expect(Buffer.from(rd.subarray(32)).equals(Buffer.alloc(32))).toBe(true) // [32:64] unused
  })

  it('requires e2ePubkey', () => {
    expect(() => noncePubkeySha256V1.build(NONCE, { peerId: PEER })).toThrow(/requires e2ePubkey/)
  })

  it('derives the GPU nonce from the [0:32] commitment', () => {
    const g = noncePubkeySha256V1.gpuNonce(NONCE, { e2ePubkey: PUBKEY })
    expect(Buffer.from(g).equals(noncePubkeySha256V1.build(NONCE, { e2ePubkey: PUBKEY }).subarray(0, 32))).toBe(true)
  })
})

describe('aci-keyset-v1 (foreign / RedPill ACI)', () => {
  it('is SHA-256(statement) in report_data[0:32], zero-padded to 64', () => {
    const rd = aciKeysetV1.build(NONCE, { keysetDigest: KEYSET_DIGEST })
    expect(rd.length).toBe(64)
    const commit = createHash('sha256').update(aciStatement(KEYSET_DIGEST, NONCE), 'utf8').digest()
    expect(Buffer.from(rd.subarray(0, 32)).equals(commit)).toBe(true)
    expect(Buffer.from(rd.subarray(32)).equals(Buffer.alloc(32))).toBe(true)
  })

  it('requires a "sha256:<64 hex>" keysetDigest', () => {
    expect(() => aciKeysetV1.build(NONCE, { peerId: PEER })).toThrow(/requires keysetDigest/)
    expect(() => aciKeysetV1.build(NONCE, { keysetDigest: 'ab' })).toThrow(/sha256:/)
  })

  it('the GPU nonce is the raw round nonce', () => {
    expect(Buffer.from(aciKeysetV1.gpuNonce(NONCE, { keysetDigest: KEYSET_DIGEST })).equals(NONCE)).toBe(true)
  })
})

describe('verifyReportData', () => {
  const rd = (scheme: { build: (n: Uint8Array, i: BindingIngredients) => Uint8Array }, i: BindingIngredients) =>
    scheme.build(NONCE, i)

  it('matches when the quote committed the same scheme + ingredients + nonce', () => {
    expect(verifyReportData('antseed-rd-v1', rd(antseedRdV1, { peerId: PEER }), NONCE, { peerId: PEER })).toBeNull()
    expect(verifyReportData('nonce-pubkey-sha256-v1', rd(noncePubkeySha256V1, { e2ePubkey: PUBKEY }), NONCE, { e2ePubkey: PUBKEY })).toBeNull()
    expect(verifyReportData('aci-keyset-v1', rd(aciKeysetV1, { keysetDigest: KEYSET_DIGEST }), NONCE, { keysetDigest: KEYSET_DIGEST })).toBeNull()
  })

  it('aci-keyset-v1 fails on a stale nonce and on a swapped keyset digest', () => {
    const quote = rd(aciKeysetV1, { keysetDigest: KEYSET_DIGEST })
    expect(verifyReportData('aci-keyset-v1', quote, randomBytes(32), { keysetDigest: KEYSET_DIGEST })).toMatch(/does not match/)
    const other = `sha256:${createHash('sha256').update('other').digest('hex')}`
    expect(verifyReportData('aci-keyset-v1', quote, NONCE, { keysetDigest: other })).toMatch(/does not match/)
  })

  it('compares only compareLen bytes (Chutes leaves [32:64] to the provider)', () => {
    const quote = noncePubkeySha256V1.build(NONCE, { e2ePubkey: PUBKEY })
    quote.set(randomBytes(32), 32) // the provider put bytes in [32:64]
    expect(verifyReportData('nonce-pubkey-sha256-v1', quote, NONCE, { e2ePubkey: PUBKEY })).toBeNull()
  })

  it('fails on a stale nonce (freshness gate)', () => {
    const quote = rd(antseedRdV1, { peerId: PEER })
    expect(verifyReportData('antseed-rd-v1', quote, randomBytes(32), { peerId: PEER })).toMatch(/does not match/)
  })

  it('fails on a downgraded field set (quote bound more than the buyer recomputes)', () => {
    const quote = antseedRdV1.build(NONCE, { peerId: PEER, e2ePubkey: PUBKEY })
    expect(verifyReportData('antseed-rd-v1', quote, NONCE, { peerId: PEER })).toMatch(/does not match/)
  })

  it('fails closed on an unknown scheme', () => {
    expect(verifyReportData('made-up-v9', rd(antseedRdV1, { peerId: PEER }), NONCE, { peerId: PEER })).toMatch(/unknown report_data scheme/)
  })

  it('getReportDataScheme returns registry entries and undefined for unknown', () => {
    expect(getReportDataScheme('antseed-rd-v1')?.id).toBe('antseed-rd-v1')
    expect(getReportDataScheme('nope')).toBeUndefined()
  })
})
