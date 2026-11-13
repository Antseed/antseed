import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  evmAddressFromPrivateKey,
  recoverEvmAddress,
  sellerBoundCapability,
  signerFromPrivateKey,
} from './seller-bound.js'
import { bundleDigest, claimId, evidenceConfigKey, sellerBoundPreimage } from '../shared.js'

// Fixed test key pairs: valid secp256k1 scalars, less than the curve order, not zero.
const PRIV = '01'.repeat(32)
const PRIV2 = '02'.repeat(32)
const PEER = evmAddressFromPrivateKey(PRIV)
const CLAIM = claimId('seller-bound')

const NODE = 'seller-node-tee-genuine'
const PROVIDER = 'seller-provider-tee-genuine'

/** Seller side: expose each cap's evidence as an "evidence:<capId>" config entry, then sign the bundle. */
async function collect(peerId: string, bundle: Record<string, Uint8Array>, nonce: Uint8Array, sign = signerFromPrivateKey(PRIV)) {
  const config: Record<string, string> = {}
  for (const [id, bytes] of Object.entries(bundle)) config[evidenceConfigKey(id)] = Buffer.from(bytes).toString('base64')
  return sellerBoundCapability.collect!({ nonce, peerId, config, sign })
}

function verify(nonce: Uint8Array, sig: Uint8Array, bundle: Record<string, Uint8Array>, peerId = PEER) {
  return sellerBoundCapability.verify({ nonce, peerId, evidence: sig, evidenceBundle: bundle })
}

describe('seller-bound helpers', () => {
  it('evmAddressFromPrivateKey yields a 40-hex lowercase address', () => {
    expect(PEER).toMatch(/^[0-9a-f]{40}$/)
  })
  it('recoverEvmAddress recovers the signer of a digest', async () => {
    const digest = randomBytes(32)
    const sig = await signerFromPrivateKey(PRIV)(digest)
    expect(sig.length).toBe(65)
    expect(recoverEvmAddress(digest, sig)).toBe(PEER)
  })
  it('recoverEvmAddress rejects a wrong-length signature', () => {
    expect(() => recoverEvmAddress(randomBytes(32), randomBytes(64))).toThrow(/65 bytes/)
  })
})

describe('seller-bound capability (whole-bundle binding)', () => {
  it('collect → verify round-trips over the whole bundle (node + provider)', async () => {
    const nonce = randomBytes(32)
    const bundle = { [NODE]: randomBytes(100), [PROVIDER]: randomBytes(80) }
    const sig = await collect(PEER, bundle, nonce)
    expect(verify(nonce, sig, bundle)).toMatchObject({ claim: CLAIM, ok: true })
  })

  it('signs the exact bundle preimage', async () => {
    const nonce = randomBytes(32)
    const bundle = { [NODE]: randomBytes(100), [PROVIDER]: randomBytes(80) }
    const sig = await collect(PEER, bundle, nonce)
    // Recover against the canonical preimage. This must yield the seller address.
    expect(recoverEvmAddress(sellerBoundPreimage(nonce, bundleDigest(bundle), PEER), sig)).toBe(PEER)
  })

  it('fails when a byte flips in ANY covered evidence entry', async () => {
    const nonce = randomBytes(32)
    const bundle = { [NODE]: randomBytes(100), [PROVIDER]: randomBytes(80) }
    const sig = await collect(PEER, bundle, nonce)
    for (const target of [NODE, PROVIDER]) {
      const tampered = { ...bundle, [target]: Uint8Array.from(bundle[target]) }
      tampered[target][0] ^= 0xff
      const r = verify(nonce, sig, tampered)
      expect(r.ok, `tampering ${target} should fail`).toBe(false)
      expect(r.detail).toMatch(/does not match peer/)
    }
  })

  it('fails on a stale / replayed nonce', async () => {
    const nonce = randomBytes(32)
    const bundle = { [NODE]: randomBytes(100) }
    const sig = await collect(PEER, bundle, nonce)
    const r = verify(randomBytes(32), sig, bundle) // a fresh round nonce makes the old signature stale
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/does not match peer/)
  })

  it('fails when a different key signed (signer != peer)', async () => {
    const nonce = randomBytes(32)
    const bundle = { [NODE]: randomBytes(100) }
    const sig = await collect(PEER, bundle, nonce, signerFromPrivateKey(PRIV2))
    const r = verify(nonce, sig, bundle)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/does not match peer/)
  })

  it('fails when the seller returned no signature', () => {
    const r = sellerBoundCapability.verify({ nonce: randomBytes(32), peerId: PEER, evidenceBundle: { [NODE]: randomBytes(100) } })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/no identity signature/)
  })

  it('fails when there is no evidence bundle to bind to', () => {
    const r = sellerBoundCapability.verify({ nonce: randomBytes(32), peerId: PEER, evidence: randomBytes(65) })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/requires the evidence bundle/)
  })

  it('fails when the bundle has no other evidence to cover', () => {
    const r = sellerBoundCapability.verify({ nonce: randomBytes(32), peerId: PEER, evidence: randomBytes(65), evidenceBundle: {} })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/no other evidence/)
  })

  it('fails on a malformed (wrong-length) signature', () => {
    const r = verify(randomBytes(32), randomBytes(10), { [NODE]: randomBytes(100) })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/recovery failed|65 bytes/)
  })

  it('collect throws (cap not offered) without a signer', async () => {
    const config = { [evidenceConfigKey(NODE)]: Buffer.from(randomBytes(50)).toString('base64') }
    await expect(sellerBoundCapability.collect!({ nonce: randomBytes(32), peerId: PEER, config })).rejects.toThrow(/requires a signer/)
  })

  it('collect throws without any cap evidence to bind to', async () => {
    await expect(
      sellerBoundCapability.collect!({ nonce: randomBytes(32), peerId: PEER, config: {}, sign: signerFromPrivateKey(PRIV) }),
    ).rejects.toThrow(/requires other cap evidence/)
  })
})
