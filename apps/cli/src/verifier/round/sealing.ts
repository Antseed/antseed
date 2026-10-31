import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'
import { keccak256 } from 'ethers'
import type { SealedEnvelopeV1 } from './types.js'

/**
 * Encryption for the round: the epoch bank is sealed with one random AES-256-GCM key (revealed
 * on-chain after collection), and each collector's questions are sealed to its X25519 key.
 */

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const ENVELOPE_INFO = Buffer.from('antseed-kbf-envelope-v1')
const BANK_AAD = Buffer.from('antseed-kbf-bank-v1')

export interface X25519KeyPair {
  /** 0x-prefixed 32-byte public key, as stored on-chain. */
  publicKey: string
  /** 0x-prefixed 32-byte private key. */
  privateKey: string
}

export function generateEncryptionKeyPair(): X25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { publicKey: rawPublicKey(publicKey), privateKey: rawPrivateKey(privateKey) }
}

export function encryptionPublicKey(privateKeyHex: string): string {
  return rawPublicKey(createPublicKey(privateKeyObject(privateKeyHex)))
}

/**
 * Whether an on-chain encryption key can actually receive envelopes: 32 bytes and not a
 * low-order point (those make the X25519 agreement fail, or come out all zero).
 */
export function isUsableEncryptionKey(publicKeyHex: string): boolean {
  try {
    const shared = diffieHellman({ privateKey: generateKeyPairSync('x25519').privateKey, publicKey: publicKeyObject(publicKeyHex) })
    return shared.some((byte) => byte !== 0)
  } catch {
    return false
  }
}

export function sealEnvelope(recipientPublicKeyHex: string, plaintext: Uint8Array): SealedEnvelopeV1 {
  const ephemeral = generateKeyPairSync('x25519')
  const recipient = publicKeyObject(recipientPublicKeyHex)
  const ephemeralPublic = Buffer.from(rawPublicKey(ephemeral.publicKey).slice(2), 'hex')
  const key = envelopeKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), ephemeralPublic, recipientPublicKeyHex)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    ephemeralPublicKey: ephemeralPublic.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function openEnvelope(privateKeyHex: string, envelope: SealedEnvelopeV1): Buffer {
  const privateKey = privateKeyObject(privateKeyHex)
  const ephemeralPublic = Buffer.from(envelope.ephemeralPublicKey, 'base64')
  const shared = diffieHellman({ privateKey, publicKey: publicKeyObject(`0x${ephemeralPublic.toString('hex')}`) })
  const key = envelopeKey(shared, ephemeralPublic, encryptionPublicKey(privateKeyHex))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()])
}

export interface SealedBank {
  /** 0x-prefixed 32-byte AES key; revealed on-chain as `bankKey`. */
  key: string
  /** iv(12) | tag(16) | ciphertext. Its keccak256 is the on-chain `bankHash`. */
  blob: Buffer
}

export function sealBank(plaintext: Uint8Array, key: Buffer = randomBytes(32)): SealedBank {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(BANK_AAD)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { key: `0x${key.toString('hex')}`, blob: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]) }
}

export function openBank(keyHex: string, blob: Uint8Array): Buffer {
  const data = Buffer.from(blob)
  const decipher = createDecipheriv('aes-256-gcm', hexToBuffer(keyHex, 32), data.subarray(0, 12))
  decipher.setAAD(BANK_AAD)
  decipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()])
}

/** On-chain `bankKeyHash`: keccak256(abi.encode(bytes32 key)). */
export function bankKeyHash(keyHex: string): string {
  return keccak256(hexToBuffer(keyHex, 32))
}

/** keccak256 of exact published bytes: the on-chain hash of every round file. */
export function contentHash(bytes: Uint8Array): string {
  return keccak256(bytes)
}

function envelopeKey(shared: Buffer, ephemeralPublic: Buffer, recipientPublicKeyHex: string): Buffer {
  const salt = Buffer.concat([ephemeralPublic, hexToBuffer(recipientPublicKeyHex, 32)])
  return Buffer.from(hkdfSync('sha256', shared, salt, ENVELOPE_INFO, 32))
}

function rawPublicKey(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' })
  return `0x${der.subarray(der.length - 32).toString('hex')}`
}

function rawPrivateKey(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'pkcs8' })
  return `0x${der.subarray(der.length - 32).toString('hex')}`
}

function publicKeyObject(hex: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, hexToBuffer(hex, 32)]), format: 'der', type: 'spki' })
}

function privateKeyObject(hex: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, hexToBuffer(hex, 32)]), format: 'der', type: 'pkcs8' })
}

function hexToBuffer(hex: string, length: number): Buffer {
  const clean = hex.replace(/^0x/, '')
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length !== length * 2) throw new Error(`expected ${length}-byte hex value`)
  return Buffer.from(clean, 'hex')
}
