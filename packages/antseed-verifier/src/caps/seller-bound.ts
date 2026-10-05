import type { ClaimResult } from '../antseed-node-types.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { Capability, CapabilityCollectInput, CapabilityVerifyInput } from '../capability.js'
import { bundleDigest, claimId, normalizePeerId, parseEvidenceConfigKey, sellerBoundPreimage } from '../shared.js'

/**
 * Capability 'seller-bound': turns provider verification into seller verification. The
 * seller signs the seller-bound preimage (keccak256 over nonce ‖ bundleDigest ‖ peerId)
 * with its AntSeed identity key, where bundleDigest covers every other cap's evidence
 * (the node quote and the provider quote together). The buyer recovers the signer's EVM
 * address and requires it to equal the peer id. Freshness (nonce) and identity (peerId)
 * live here, independent of what any quote's own report_data binds. One seller signature
 * therefore ties the whole bundle to this seller and this round.
 */

const CAP_ID = 'seller-bound'

/** Recover the 40-hex (lowercase, no 0x) EVM address that produced an r‖s‖v signature. */
export function recoverEvmAddress(digest: Uint8Array, sig: Uint8Array): string {
  if (sig.length !== 65) throw new Error(`signature must be 65 bytes, got ${sig.length}`)
  const recovery = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!
  if (recovery !== 0 && recovery !== 1) throw new Error(`invalid recovery byte: ${sig[64]}`)
  // noble's recovered format is v(1) ‖ r(32) ‖ s(32); repack our r‖s‖v into it.
  const noble = new Uint8Array(65)
  noble[0] = recovery
  noble.set(sig.subarray(0, 64), 1)
  const compressed = secp256k1.recoverPublicKey(noble, digest, { prehash: false })
  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false) // 0x04 ‖ X ‖ Y
  return bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(-20))
}

/** Build a signer over 32-byte digests from a hex private key; it emits r‖s‖v (v = 27/28). */
export function signerFromPrivateKey(privHex: string): (msg: Uint8Array) => Promise<Uint8Array> {
  const priv = hexToBytes(privHex.replace(/^0x/i, ''))
  if (priv.length !== 32) throw new Error(`private key must be 32 bytes, got ${priv.length}`)
  return async (msg: Uint8Array): Promise<Uint8Array> => {
    // prehash:false — msg is already the 32-byte keccak preimage digest, sign it directly.
    const recovered = secp256k1.sign(msg, priv, { prehash: false, format: 'recovered' })
    const out = new Uint8Array(65)
    out.set(recovered.subarray(1), 0) // r ‖ s
    out[64] = recovered[0]! + 27 // v
    return out
  }
}

/** The 40-hex EVM address a private key corresponds to (for seller-side consistency checks). */
export function evmAddressFromPrivateKey(privHex: string): string {
  const priv = hexToBytes(privHex.replace(/^0x/i, ''))
  const uncompressed = secp256k1.getPublicKey(priv, false)
  return bytesToHex(keccak_256(uncompressed.subarray(1)).subarray(-20))
}

export const sellerBoundCapability: Capability = {
  id: CAP_ID,

  verify(input: CapabilityVerifyInput): ClaimResult {
    const claim = claimId(CAP_ID)
    if (!input.evidence) return { claim, ok: false, detail: 'seller returned no identity signature' }
    const bundle = input.evidenceBundle
    if (!bundle) return { claim, ok: false, detail: 'seller-bound requires the evidence bundle to bind to' }
    // bundleDigest excludes seller-bound's own entry; require at least one other cap to cover.
    if (Object.keys(bundle).filter((id) => id !== CAP_ID).length === 0) {
      return { claim, ok: false, detail: 'seller-bound has no other evidence to bind to' }
    }
    let peerId: string
    try {
      peerId = normalizePeerId(input.peerId)
    } catch (err) {
      return { claim, ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
    const preimage = sellerBoundPreimage(input.nonce, bundleDigest(bundle), peerId)
    let signer: string
    try {
      signer = recoverEvmAddress(preimage, input.evidence)
    } catch (err) {
      return { claim, ok: false, detail: `signature recovery failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (signer !== peerId) {
      return { claim, ok: false, detail: `signer ${signer.slice(0, 10)}… does not match peer ${peerId.slice(0, 10)}…` }
    }
    return { claim, ok: true, detail: `seller identity ${peerId.slice(0, 10)}… signed this bundle (fresh nonce bound)` }
  },

  async collect(input: CapabilityCollectInput): Promise<Uint8Array> {
    if (!input.sign) throw new Error('seller-bound requires a signer (seller identity key); not offered')
    // Rebuild the bundle from every other cap's evidence the prover already collected this
    // round (exposed as "evidence:<capId>" config entries). Collect it last, so the node and
    // provider quotes are already present.
    const bundle: Record<string, Uint8Array> = {}
    for (const [key, b64] of Object.entries(input.config)) {
      const capId = parseEvidenceConfigKey(key)
      if (capId && capId !== CAP_ID) bundle[capId] = new Uint8Array(Buffer.from(b64, 'base64'))
    }
    if (Object.keys(bundle).length === 0) throw new Error('seller-bound requires other cap evidence to bind to; collect a TEE cap first')
    const preimage = sellerBoundPreimage(input.nonce, bundleDigest(bundle), input.peerId)
    const sig = await input.sign(preimage)
    if (sig.length !== 65) throw new Error(`signer returned ${sig.length}-byte signature, expected 65 (r‖s‖v)`)
    return sig
  },
}
