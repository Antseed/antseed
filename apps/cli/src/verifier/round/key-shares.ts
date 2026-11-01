import { secp256k1 } from '@noble/curves/secp256k1.js'
import { computeAddress, getAddress, zeroPadValue } from 'ethers'
import { bankKeyHash, isUsableEncryptionKey, openEnvelope, SECP256K1_ORDER, sealEnvelope } from './sealing.js'
import type { SealedEnvelopeV1 } from './types.js'

/**
 * Bank-key escrow: the epoch publisher splits the bank key (a secp256k1 scalar) with Shamir's
 * scheme modulo the group order, one share per verifier sealed to its X25519 key, so a majority
 * of verifiers can rebuild the key if the publisher never reveals it. The split is Feldman
 * verifiable: the file commits to every polynomial coefficient as a point, the constant term's
 * point is the committed key's (its address is the on-chain `bankKeyHash`), so each verifier can
 * check before the plan that its share lies on the polynomial that rebuilds the committed key.
 * A share is `x (1 byte) | y (32 bytes)`.
 */

export const KEY_SHARE_BYTES = 33

/** Published by the epoch publisher; its keccak256 is the on-chain `keySharesHash`. */
export interface KeySharesFileV2 {
  kind: 'antseed-kbf-key-shares'
  version: 2
  epoch: string
  /** Shares needed to rebuild the key: the epoch's finalization threshold. */
  threshold: number
  bankKeyHash: string
  /** Compressed points `a_j·G` of the polynomial's coefficients, constant term first. */
  commitments: string[]
  /** Each lowercase verifier address's share x coordinate. */
  indexes: Record<string, number>
  /** Sealed share per lowercase verifier address. */
  shares: Record<string, SealedEnvelopeV1>
}

interface Share {
  x: number
  y: bigint
}

const Point = secp256k1.Point
const N = SECP256K1_ORDER

function mod(value: bigint): bigint {
  const result = value % N
  return result < 0n ? result + N : result
}

function inverse(value: bigint): bigint {
  // Fermat: N is prime.
  let result = 1n
  let base = mod(value)
  let exponent = N - 2n
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % N
    base = (base * base) % N
    exponent >>= 1n
  }
  return result
}

function scalar(hex: string): bigint {
  const clean = hex.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('expected a 32-byte scalar')
  return BigInt(`0x${clean}`)
}

function scalarHex(value: bigint): string {
  return value.toString(16).padStart(64, '0')
}

function randomScalar(): bigint {
  return BigInt(`0x${Buffer.from(secp256k1.utils.randomSecretKey()).toString('hex')}`)
}

/**
 * Splits `secret` (0 < secret < n) into `count` shares at x = 1..count, any `threshold` of which
 * rebuild it, with the point commitment of every coefficient.
 */
export function splitSecret(secret: bigint, threshold: number, count: number): { shares: Share[]; commitments: string[] } {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > count || count > 255) {
    throw new Error(`invalid share threshold ${threshold} of ${count}`)
  }
  if (secret <= 0n || secret >= N) throw new Error('the secret must be a secp256k1 scalar')
  const coefficients = [secret, ...Array.from({ length: threshold - 1 }, randomScalar)]
  const shares = Array.from({ length: count }, (_, index) => {
    const x = BigInt(index + 1)
    let y = 0n
    for (let degree = coefficients.length - 1; degree >= 0; degree--) y = mod(y * x + coefficients[degree]!)
    return { x: index + 1, y }
  })
  return { shares, commitments: coefficients.map((coefficient) => `0x${Point.BASE.multiply(coefficient).toHex(true)}`) }
}

/** Whether `share` lies on the committed polynomial: `y·G == Σ C_j·x^j`. */
export function shareMatchesCommitments(commitments: readonly string[], share: Share): boolean {
  if (share.y <= 0n || share.y >= N || share.x < 1 || share.x > 255) return false
  try {
    let expected = Point.ZERO
    let power = 1n
    for (const commitment of commitments) {
      expected = expected.add(Point.fromHex(commitment.replace(/^0x/, '')).multiply(power))
      power = mod(power * BigInt(share.x))
    }
    return expected.equals(Point.BASE.multiply(share.y))
  } catch {
    return false
  }
}

/** Rebuilds the secret from distinct shares (Lagrange interpolation at x = 0). */
export function combineShares(shares: readonly Share[]): bigint {
  if (shares.length === 0) throw new Error('no shares')
  const xs = shares.map((share) => BigInt(share.x))
  if (xs.some((x) => x === 0n) || new Set(xs).size !== xs.length) throw new Error('shares must be distinct')
  let secret = 0n
  for (let i = 0; i < shares.length; i++) {
    let basis = 1n
    for (let j = 0; j < shares.length; j++) {
      if (i !== j) basis = mod(basis * xs[j]! * inverse(xs[j]! - xs[i]!))
    }
    secret = mod(secret + shares[i]!.y * basis)
  }
  return secret
}

function encodeShare(share: Share): Buffer {
  return Buffer.concat([Buffer.from([share.x]), Buffer.from(scalarHex(share.y), 'hex')])
}

function decodeShare(bytes: Uint8Array): Share | null {
  if (bytes.length !== KEY_SHARE_BYTES) return null
  return { x: bytes[0]!, y: BigInt(`0x${Buffer.from(bytes.subarray(1)).toString('hex')}`) }
}

/** On-chain `bankKeyHash` of a committed point: its address, left-padded. */
function pointKeyHash(compressed: string): string {
  return zeroPadValue(computeAddress(compressed), 32).toLowerCase()
}

/**
 * Splits the bank key for the epoch's verifiers. Verifiers without a usable encryption key get no
 * share; with fewer than `threshold` recipients the key could never be rebuilt, so it throws.
 */
export function buildKeySharesFile(input: {
  epoch: bigint
  bankKey: string
  threshold: number
  recipients: ReadonlyArray<{ address: string; encryptionKey: string }>
}): KeySharesFileV2 {
  const recipients = input.recipients
    .filter((recipient) => isUsableEncryptionKey(recipient.encryptionKey))
    .sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()))
  if (recipients.length < input.threshold) {
    throw new Error(`only ${recipients.length} verifiers have usable encryption keys; ${input.threshold} needed to escrow the bank key`)
  }
  const { shares, commitments } = splitSecret(scalar(input.bankKey), input.threshold, recipients.length)
  const file: KeySharesFileV2 = {
    kind: 'antseed-kbf-key-shares',
    version: 2,
    epoch: input.epoch.toString(),
    threshold: input.threshold,
    bankKeyHash: bankKeyHash(input.bankKey),
    commitments,
    indexes: {},
    shares: {},
  }
  recipients.forEach((recipient, index) => {
    const address = recipient.address.toLowerCase()
    file.indexes[address] = shares[index]!.x
    file.shares[address] = sealEnvelope(recipient.encryptionKey, encodeShare(shares[index]!))
  })
  return file
}

/**
 * Checks a fetched key-share file for `epoch` against the on-chain `bankKeyHash`: well formed, with
 * one commitment per coefficient and the constant term's point being the committed key's. Throws
 * when it is not, since no share of it could rebuild the committed key.
 */
export function checkKeySharesFile(value: unknown, epoch: bigint, onChainBankKeyHash: string): KeySharesFileV2 {
  const file = value as Partial<KeySharesFileV2> | null
  if (
    !file || file.kind !== 'antseed-kbf-key-shares' || file.version !== 2 || file.epoch !== epoch.toString()
    || !Number.isInteger(file.threshold) || file.threshold! < 1 || !Array.isArray(file.commitments)
    || file.commitments.length !== file.threshold || typeof file.indexes !== 'object' || file.indexes === null
    || typeof file.shares !== 'object' || file.shares === null
  ) {
    throw new Error(`key-share file for epoch ${epoch} is malformed`)
  }
  let constantKeyHash: string
  try {
    constantKeyHash = pointKeyHash(file.commitments[0]!)
  } catch {
    throw new Error(`key-share file for epoch ${epoch} is malformed`)
  }
  if (constantKeyHash !== onChainBankKeyHash.toLowerCase()) {
    throw new Error(`key-share file for epoch ${epoch} does not commit to the epoch's bank key`)
  }
  return file as KeySharesFileV2
}

/**
 * Opens the caller's share and checks it against the file's commitments. Null when the file holds
 * no share for it; throws when the share cannot be opened or does not lie on the polynomial.
 */
export function openKeyShare(file: KeySharesFileV2, address: string, encryptionPrivateKey: string): string | null {
  const key = address.toLowerCase()
  const envelope = file.shares[key]
  if (!envelope) return null
  let share: Share | null
  try {
    share = decodeShare(openEnvelope(encryptionPrivateKey, envelope))
  } catch {
    share = null
  }
  if (!share || share.x !== file.indexes[key] || !shareMatchesCommitments(file.commitments, share)) {
    throw new Error(`key share for ${getAddress(address)} does not match the file's commitments`)
  }
  return `0x${encodeShare(share).toString('hex')}`
}

/**
 * Rebuilds the bank key from shares posted on-chain. A share counts only when it carries its
 * sender's index and lies on the committed polynomial, so bad shares cannot spoil the result.
 */
export function recoverBankKey(
  file: KeySharesFileV2,
  revealed: ReadonlyArray<{ verifier: string; share: string }>,
): string | null {
  const valid = new Map<number, Share>()
  for (const entry of revealed) {
    const share = decodeShare(Buffer.from(entry.share.replace(/^0x/, ''), 'hex'))
    if (!share || share.x !== file.indexes[entry.verifier.toLowerCase()]) continue
    if (!valid.has(share.x) && shareMatchesCommitments(file.commitments, share)) valid.set(share.x, share)
  }
  if (file.threshold < 1 || valid.size < file.threshold) return null
  const key = `0x${scalarHex(combineShares([...valid.values()].slice(0, file.threshold)))}`
  return bankKeyHash(key) === file.bankKeyHash ? key : null
}
