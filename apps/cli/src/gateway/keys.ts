import { createHash, randomBytes } from 'node:crypto'

const KEY_PREFIX = 'antseed_'
/** Management tokens look like `antseed_admin_<43 chars>`. */
export const ADMIN_TOKEN_PREFIX = 'antseed_admin_'

export interface GeneratedApiKey {
  /** Shown once at creation; only its hash is stored. */
  secret: string
  hash: string
  hint: string
}

export function generateApiKey(): GeneratedApiKey {
  const secret = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  return { secret, hash: hashApiKey(secret), hint: apiKeyHint(secret) }
}

/** Keys are 256-bit random secrets, so a plain SHA-256 is a sufficient lookup hash. */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

export function apiKeyHint(secret: string): string {
  return secret.length <= 16 ? `${secret.slice(0, 4)}…` : `${secret.slice(0, 12)}…${secret.slice(-4)}`
}

export function newKeyId(): string {
  return `key_${randomBytes(6).toString('hex')}`
}

export function parseBearerToken(header: string | undefined): string | null {
  const prefix = 'Bearer '
  if (!header?.startsWith(prefix)) return null
  const token = header.slice(prefix.length).trim()
  return token.length > 0 ? token : null
}
