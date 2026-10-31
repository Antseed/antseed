import { randomBytes } from 'node:crypto'
import { getAddress, keccak256 } from 'ethers'
import { bankKeyHash, openEnvelope, sealEnvelope } from './sealing.js'
import type { SealedEnvelopeV1 } from './types.js'

/**
 * Bank-key escrow: the epoch publisher splits the 32-byte bank key with Shamir's scheme over
 * GF(2^8), one share per verifier sealed to its X25519 key, so a majority of verifiers can rebuild
 * the key if the publisher never reveals it. A share is `x (1 byte) | y (32 bytes)`.
 */

export const KEY_SHARE_BYTES = 33

/** Published by the epoch publisher; its keccak256 is the on-chain `keySharesHash`. */
export interface KeySharesFileV1 {
  kind: 'antseed-kbf-key-shares'
  version: 1
  epoch: string
  /** Shares needed to rebuild the key: the epoch's finalization threshold. */
  threshold: number
  bankKeyHash: string
  /** Sealed share per lowercase verifier address. */
  shares: Record<string, SealedEnvelopeV1>
  /** keccak256 of each verifier's plain share, so a posted share can be checked before use. */
  shareHashes: Record<string, string>
}

// GF(2^8) with the AES polynomial x^8 + x^4 + x^3 + x + 1.
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let value = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = value
    LOG[value] = i
    value ^= (value << 1) ^ (value & 0x80 ? 0x11b : 0)
    value &= 0xff
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a]! + LOG[b]!]!
}

function div(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero')
  if (a === 0) return 0
  return EXP[LOG[a]! + 255 - LOG[b]!]!
}

/** Splits `secret` into `count` shares, any `threshold` of which rebuild it. */
export function splitSecret(secret: Uint8Array, threshold: number, count: number): Buffer[] {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > count || count > 255) {
    throw new Error(`invalid share threshold ${threshold} of ${count}`)
  }
  const shares = Array.from({ length: count }, (_, index) => {
    const share = Buffer.alloc(secret.length + 1)
    share[0] = index + 1
    return share
  })
  for (let byte = 0; byte < secret.length; byte++) {
    const coefficients = [secret[byte]!, ...randomBytes(threshold - 1)]
    for (const share of shares) {
      const x = share[0]!
      let y = 0
      for (let degree = coefficients.length - 1; degree >= 0; degree--) y = mul(y, x) ^ coefficients[degree]!
      share[byte + 1] = y
    }
  }
  return shares
}

/** Rebuilds the secret from distinct shares (Lagrange interpolation at x = 0). */
export function combineShares(shares: readonly Uint8Array[]): Buffer {
  if (shares.length === 0) throw new Error('no shares')
  const length = shares[0]!.length
  const xs = shares.map((share) => share[0]!)
  if (shares.some((share) => share.length !== length) || xs.some((x) => x === 0) || new Set(xs).size !== xs.length) {
    throw new Error('shares must be distinct and the same length')
  }
  const secret = Buffer.alloc(length - 1)
  for (let byte = 1; byte < length; byte++) {
    let value = 0
    for (let i = 0; i < shares.length; i++) {
      let basis = 1
      for (let j = 0; j < shares.length; j++) {
        if (i !== j) basis = mul(basis, div(xs[j]!, xs[j]! ^ xs[i]!))
      }
      value ^= mul(shares[i]![byte]!, basis)
    }
    secret[byte - 1] = value
  }
  return secret
}

/**
 * Splits the bank key for the epoch's verifiers. Verifiers without an encryption key get no
 * share; with fewer than `threshold` recipients the key could never be rebuilt, so it throws.
 */
export function buildKeySharesFile(input: {
  epoch: bigint
  bankKey: string
  threshold: number
  recipients: ReadonlyArray<{ address: string; encryptionKey: string }>
}): KeySharesFileV1 {
  const key = Buffer.from(input.bankKey.replace(/^0x/, ''), 'hex')
  if (key.length !== 32) throw new Error('bank key must be 32 bytes')
  const recipients = [...input.recipients].sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
  if (recipients.length < input.threshold) {
    throw new Error(`only ${recipients.length} verifiers have encryption keys; ${input.threshold} needed to escrow the bank key`)
  }
  const raw = splitSecret(key, input.threshold, recipients.length)
  const file: KeySharesFileV1 = {
    kind: 'antseed-kbf-key-shares',
    version: 1,
    epoch: input.epoch.toString(),
    threshold: input.threshold,
    bankKeyHash: bankKeyHash(input.bankKey),
    shares: {},
    shareHashes: {},
  }
  recipients.forEach((recipient, index) => {
    const address = recipient.address.toLowerCase()
    file.shares[address] = sealEnvelope(recipient.encryptionKey, raw[index]!)
    file.shareHashes[address] = keccak256(raw[index]!)
  })
  return file
}

/** Opens the caller's share and checks it against the published hash. */
export function openKeyShare(file: KeySharesFileV1, address: string, encryptionPrivateKey: string): string | null {
  const key = address.toLowerCase()
  const envelope = file.shares[key]
  if (!envelope) return null
  const share = openEnvelope(encryptionPrivateKey, envelope)
  if (share.length !== KEY_SHARE_BYTES || keccak256(share) !== file.shareHashes[key]) {
    throw new Error(`key share for ${getAddress(address)} does not match its published hash`)
  }
  return `0x${share.toString('hex')}`
}

/**
 * Rebuilds the bank key from shares posted on-chain. Shares that do not match the file's hash
 * for their sender are ignored, so one bad share cannot spoil the result.
 */
export function recoverBankKey(
  file: KeySharesFileV1,
  revealed: ReadonlyArray<{ verifier: string; share: string }>,
): string | null {
  const valid = new Map<string, Buffer>()
  for (const entry of revealed) {
    const address = entry.verifier.toLowerCase()
    const share = Buffer.from(entry.share.replace(/^0x/, ''), 'hex')
    if (share.length !== KEY_SHARE_BYTES || keccak256(share) !== file.shareHashes[address]) continue
    valid.set(address, share)
  }
  if (file.threshold < 1 || valid.size < file.threshold) return null
  const key = `0x${combineShares([...valid.values()].slice(0, file.threshold)).toString('hex')}`
  return bankKeyHash(key) === file.bankKeyHash ? key : null
}
