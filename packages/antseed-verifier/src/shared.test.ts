import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { antseedRdV1 } from './report-data.js'
import {
  NONCE_BYTES,
  VERIFIER_ID,
  bundleDigest,
  claimId,
  computeReportData,
  decodeAttestRequest,
  decodeAttestResponse,
  encodeAttestRequest,
  encodeAttestResponse,
  normalizePeerId,
  sellerBoundPreimage,
} from './shared.js'

const PEER = 'a'.repeat(40)

describe('normalizePeerId', () => {
  it('lowercases and accepts a 40-hex peer id', () => {
    expect(normalizePeerId('AbCd' + 'e'.repeat(36))).toBe('abcd' + 'e'.repeat(36))
  })
  it('rejects non-40-hex input', () => {
    expect(() => normalizePeerId('xyz')).toThrow(/invalid peerId/)
    expect(() => normalizePeerId('0x' + 'a'.repeat(40))).toThrow(/invalid peerId/)
    expect(() => normalizePeerId('g'.repeat(40))).toThrow(/invalid peerId/)
  })
})

describe('claimId', () => {
  it('namespaces the capability id under the verifier id', () => {
    expect(claimId('seller-node-tee-genuine')).toBe(`${VERIFIER_ID}:seller-node-tee-genuine`)
  })
})

describe('computeReportData', () => {
  it('is 64 bytes and equals the antseed-rd-v1 {peerId} instance', () => {
    const nonce = randomBytes(NONCE_BYTES)
    const rd = computeReportData(nonce, PEER)
    expect(rd.length).toBe(64)
    expect(Buffer.from(rd).equals(antseedRdV1.build(nonce, { peerId: PEER }))).toBe(true)
  })
  it('normalizes peer id casing so both sides agree', () => {
    const nonce = randomBytes(NONCE_BYTES)
    expect(Buffer.from(computeReportData(nonce, PEER)).equals(computeReportData(nonce, PEER.toUpperCase()))).toBe(true)
  })
})

describe('bundleDigest', () => {
  it('is a deterministic 32-byte digest, independent of map insertion order', () => {
    const a = { 'seller-node-tee-genuine': randomBytes(100), 'seller-provider-tee-genuine': randomBytes(80) }
    const b = { 'seller-provider-tee-genuine': a['seller-provider-tee-genuine'], 'seller-node-tee-genuine': a['seller-node-tee-genuine'] }
    const da = bundleDigest(a)
    expect(da.length).toBe(32)
    expect(Buffer.from(da).equals(bundleDigest(b))).toBe(true)
  })
  it('excludes the seller-bound entry (signing over itself is impossible)', () => {
    const base = { 'seller-node-tee-genuine': randomBytes(64) }
    const withSb = { ...base, 'seller-bound': randomBytes(65) }
    expect(Buffer.from(bundleDigest(base)).equals(bundleDigest(withSb))).toBe(true)
  })
  it('changes when any covered evidence byte flips', () => {
    const ev = randomBytes(64)
    const base = bundleDigest({ 'seller-node-tee-genuine': ev })
    const tampered = Uint8Array.from(ev)
    tampered[0]! ^= 0xff
    expect(Buffer.from(base).equals(bundleDigest({ 'seller-node-tee-genuine': tampered }))).toBe(false)
  })
})

describe('sellerBoundPreimage', () => {
  it('is a deterministic 32-byte digest', () => {
    const nonce = randomBytes(NONCE_BYTES)
    const digest = randomBytes(32)
    const a = sellerBoundPreimage(nonce, digest, PEER)
    expect(a.length).toBe(32)
    expect(Buffer.from(a).equals(sellerBoundPreimage(nonce, digest, PEER))).toBe(true)
  })
  it('binds to nonce, bundle digest and peer id independently', () => {
    const nonce = randomBytes(NONCE_BYTES)
    const digest = randomBytes(32)
    const base = sellerBoundPreimage(nonce, digest, PEER)
    expect(Buffer.from(base).equals(sellerBoundPreimage(randomBytes(NONCE_BYTES), digest, PEER))).toBe(false)
    expect(Buffer.from(base).equals(sellerBoundPreimage(nonce, randomBytes(32), PEER))).toBe(false)
    expect(Buffer.from(base).equals(sellerBoundPreimage(nonce, digest, 'b'.repeat(40)))).toBe(false)
  })
})

describe('attestation request codec (multi-cap)', () => {
  it('round-trips the nonce and cap menu', () => {
    const nonce = randomBytes(NONCE_BYTES)
    const caps = ['seller-node-tee-genuine', 'seller-bound']
    const decoded = decodeAttestRequest(encodeAttestRequest(nonce, caps))
    expect(Buffer.from(decoded.nonce).equals(nonce)).toBe(true)
    expect(decoded.caps).toEqual(caps)
  })
  it('rejects a missing nonce', () => {
    const body = new TextEncoder().encode(JSON.stringify({ caps: [] }))
    expect(() => decodeAttestRequest(body)).toThrow(/missing "nonce"/)
  })
  it('rejects a wrong-size nonce', () => {
    const body = new TextEncoder().encode(JSON.stringify({ nonce: Buffer.from([1, 2, 3]).toString('base64'), caps: [] }))
    expect(() => decodeAttestRequest(body)).toThrow(/must be 32 bytes/)
  })
  it('rejects a missing caps array', () => {
    const body = new TextEncoder().encode(JSON.stringify({ nonce: randomBytes(NONCE_BYTES).toString('base64') }))
    expect(() => decodeAttestRequest(body)).toThrow(/missing "caps"/)
  })
})

describe('attestation response codec (per-cap evidence)', () => {
  it('round-trips a per-cap evidence map, including an empty entry', () => {
    const evidence = { 'seller-node-tee-genuine': randomBytes(100), 'seller-bound': randomBytes(65), 'seller-provider-measured-image': new Uint8Array() }
    const decoded = decodeAttestResponse(encodeAttestResponse(evidence))
    expect(Buffer.from(decoded['seller-node-tee-genuine']!).equals(evidence['seller-node-tee-genuine'])).toBe(true)
    expect(Buffer.from(decoded['seller-bound']!).equals(evidence['seller-bound'])).toBe(true)
    expect(decoded['seller-provider-measured-image']!.length).toBe(0)
  })
  it('round-trips an empty evidence map', () => {
    expect(decodeAttestResponse(encodeAttestResponse({}))).toEqual({})
  })
  it('rejects a missing evidence object', () => {
    const body = new TextEncoder().encode(JSON.stringify({}))
    expect(() => decodeAttestResponse(body)).toThrow(/missing "evidence"/)
  })
})
