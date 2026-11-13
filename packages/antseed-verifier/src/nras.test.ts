import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from 'jose'
import { buildNrasRequest, extractEarTokens, verifyEar, type NvidiaGpuEvidence } from './nras.js'

/**
 * Exercise the real EAR path: jose signature verification, claim extraction, and nonce check.
 * The test mints a fixture EAR with a throwaway key, so it never contacts NVIDIA NRAS. The
 * getKey resolver returns the test public key. Production returns the NVIDIA JWKS key for the
 * same call.
 */

const NONCE = randomBytes(32)
const HEX = Buffer.from(NONCE).toString('hex')

let priv: CryptoKey
let pub: CryptoKey
let otherPriv: CryptoKey
/** Stand-in for createRemoteJWKSet. It hands verifyEar the test public key. */
let getKey: JWTVerifyGetKey

beforeAll(async () => {
  ;({ privateKey: priv, publicKey: pub } = await generateKeyPair('ES256'))
  ;({ privateKey: otherPriv } = await generateKeyPair('ES256'))
  getKey = (async () => pub) as unknown as JWTVerifyGetKey
})

/** Mint a JWT signed by `key`. Default is the trusted test key. */
async function jwt(claims: Record<string, unknown>, key: CryptoKey = priv): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256' }).setIssuedAt().sign(key)
}

const sampleEvidence: NvidiaGpuEvidence = {
  arch: 'HOPPER',
  evidence_list: [
    { evidence: Buffer.from('report-0').toString('base64'), certificate: Buffer.from('chain-0').toString('base64') },
    { evidence: Buffer.from('report-1').toString('base64'), certificate: Buffer.from('chain-1').toString('base64') },
  ],
}

describe('buildNrasRequest', () => {
  it('builds the v3 request shape: hex nonce + arch + evidence_list passthrough', () => {
    const req = buildNrasRequest(sampleEvidence, NONCE)
    expect(req.nonce).toBe(HEX)
    expect(req.nonce).toHaveLength(64)
    expect(req.arch).toBe('HOPPER')
    expect(req.evidence_list).toEqual(sampleEvidence.evidence_list)
  })

  it('fails closed on missing arch / empty list / missing item fields', () => {
    expect(() => buildNrasRequest({ evidence_list: sampleEvidence.evidence_list } as NvidiaGpuEvidence, NONCE)).toThrow(/arch/)
    expect(() => buildNrasRequest({ arch: 'HOPPER', evidence_list: [] }, NONCE)).toThrow(/evidence_list/)
    expect(() => buildNrasRequest({ arch: 'HOPPER', evidence_list: [{ certificate: 'c' } as never] }, NONCE)).toThrow(/"evidence"/)
    expect(() => buildNrasRequest({ arch: 'HOPPER', evidence_list: [{ evidence: 'e' } as never] }, NONCE)).toThrow(/"certificate"/)
  })
})

describe('extractEarTokens', () => {
  it('accepts a bare JWT string and a detached-EAR array in either element order', () => {
    expect(extractEarTokens('a.b.c')).toEqual({ overall: 'a.b.c', devices: {} })
    const arr = extractEarTokens(['a.b.c', { 'GPU-0': 'd.e.f', 'GPU-1': 'g.h.i' }])
    expect(arr.overall).toBe('a.b.c')
    expect(arr.devices).toEqual({ 'GPU-0': 'd.e.f', 'GPU-1': 'g.h.i' })
    const swapped = extractEarTokens([{ 'GPU-0': 'd.e.f' }, 'a.b.c'])
    expect(swapped).toEqual({ overall: 'a.b.c', devices: { 'GPU-0': 'd.e.f' } })
  })
  it('unwraps NRAS v3 ["JWT", token] content-type pairs', () => {
    const r = extractEarTokens([['JWT', 'a.b.c'], { 'GPU-0': ['JWT', 'd.e.f'], 'GPU-1': 'g.h.i' }])
    expect(r.overall).toBe('a.b.c')
    expect(r.devices).toEqual({ 'GPU-0': 'd.e.f', 'GPU-1': 'g.h.i' })
  })
  it('throws on an unrecognized shape', () => {
    expect(() => extractEarTokens({ nope: 1 })).toThrow(/unrecognized/)
  })
})

describe('verifyEar', () => {
  async function detachedEar(overrides: { overall?: Record<string, unknown>; device?: Record<string, unknown>; count?: number } = {}) {
    const overall = await jwt({ 'x-nvidia-overall-att-result': true, eat_nonce: HEX, ...overrides.overall })
    const devices: Record<string, string> = {}
    const n = overrides.count ?? 2
    for (let i = 0; i < n; i++) {
      devices[`GPU-${i}`] = await jwt({ measres: 'success', secboot: true, eat_nonce: HEX, ...overrides.device })
    }
    return [overall, devices]
  }

  it('passes: valid signatures, overall success, matching nonce, N GPUs', async () => {
    const r = await verifyEar(await detachedEar({ count: 2 }), NONCE, getKey)
    expect(r.ok).toBe(true)
    expect(r.gpuCount).toBe(2)
    expect(r.reason).toMatch(/2 NVIDIA GPUs.*NRAS-verified/)
  })

  it('passes when NRAS v3 wraps the tokens as ["JWT", token] pairs', async () => {
    const overall = await jwt({ 'x-nvidia-overall-att-result': true, eat_nonce: HEX })
    const device = await jwt({ measres: 'success', eat_nonce: HEX })
    const r = await verifyEar([['JWT', overall], { 'GPU-0': ['JWT', device] }], NONCE, getKey)
    expect(r.ok).toBe(true)
    expect(r.gpuCount).toBe(1)
  })

  it('reports CC mode enabled when a device carries an explicit cc-mode claim', async () => {
    const r = await verifyEar(await detachedEar({ count: 1, device: { 'x-nvidia-gpu-attestation-report-cc-mode': true } }), NONCE, getKey)
    expect(r.ok).toBe(true)
    expect(r.ccMode).toBe('enabled')
  })

  it('accepts a bare overall JWT (single-token response)', async () => {
    const token = await jwt({ 'x-nvidia-overall-att-result': true, eat_nonce: HEX })
    const r = await verifyEar(token, NONCE, getKey)
    expect(r.ok).toBe(true)
    expect(r.gpuCount).toBe(1)
  })

  it('fails when the overall attestation result is not success', async () => {
    const r = await verifyEar(await detachedEar({ overall: { 'x-nvidia-overall-att-result': false } }), NONCE, getKey)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/overall attestation result/)
  })

  it('fails on a nonce mismatch (stale / wrong round)', async () => {
    const ear = await detachedEar({ overall: { eat_nonce: 'deadbeef'.repeat(8) } })
    const r = await verifyEar(ear, NONCE, getKey)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/nonce/)
  })

  it('fails when a device reports CC mode disabled', async () => {
    const r = await verifyEar(await detachedEar({ device: { 'x-nvidia-cc-mode': false } }), NONCE, getKey)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/confidential-compute mode disabled/)
  })

  it('fails a forged EAR signed by an untrusted key', async () => {
    const forged = [await jwt({ 'x-nvidia-overall-att-result': true, eat_nonce: HEX }, otherPriv), {}]
    const r = await verifyEar(forged, NONCE, getKey)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/signature verification failed/)
  })
})
