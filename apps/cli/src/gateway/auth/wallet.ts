import { randomBytes } from 'node:crypto'
import { getAddress, isAddress, verifyMessage } from 'ethers'

/** Base mainnet; sign-in messages are chain-agnostic proofs of key ownership, the id is informational. */
const SIGN_IN_CHAIN_ID = 8453

export function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !isAddress(value)) return null
  return getAddress(value)
}

export function newWalletNonce(): string {
  // EIP-4361 nonces are alphanumeric, at least 8 characters.
  return randomBytes(16).toString('hex')
}

/** EIP-4361 (Sign-In with Ethereum) message text. */
export function buildSignInMessage(input: { domain: string; address: string; uri: string; nonce: string; issuedAt: number; expiresAt: number }): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.address,
    '',
    'Sign in to the Antseed gateway console.',
    '',
    `URI: ${input.uri}`,
    'Version: 1',
    `Chain ID: ${SIGN_IN_CHAIN_ID}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${new Date(input.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(input.expiresAt).toISOString()}`,
  ].join('\n')
}

export function nonceFromMessage(message: string): string | null {
  const match = /^Nonce: ([A-Za-z0-9]{8,})$/m.exec(message)
  return match?.[1] ?? null
}

/** Lowercase signer address, or null when the signature doesn't parse. */
export function recoverSigner(message: string, signature: string): string | null {
  try {
    return verifyMessage(message, signature).toLowerCase()
  } catch {
    return null
  }
}
