import { createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto'

/**
 * Coinbase Developer Platform API authentication: every request carries a
 * short-lived JWT signed with the CDP secret API key and bound to the
 * request's method, host and path. Mirrors `generateJwt` in
 * `@coinbase/cdp-sdk/auth` for both key types CDP issues:
 * Ed25519 (base64 of seed + public key) and EC P-256 (PEM).
 */
const TOKEN_LIFETIME_SECONDS = 120

export interface CdpCredentials {
  keyId: string
  keySecret: string
}

type SigningKey = { alg: 'EdDSA' | 'ES256'; key: KeyObject }

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function parseSigningKey(secret: string): SigningKey {
  const trimmed = secret.trim()
  if (trimmed.includes('-----BEGIN')) {
    // CDP stores EC secrets with literal "\n" when copied from JSON.
    return { alg: 'ES256', key: createPrivateKey(trimmed.replace(/\\n/g, '\n')) }
  }
  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.length !== 64) {
    throw new Error('CDP API key secret must be a base64 Ed25519 key or a PEM EC key')
  }
  return {
    alg: 'EdDSA',
    key: createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', d: base64url(decoded.subarray(0, 32)), x: base64url(decoded.subarray(32)) },
      format: 'jwk',
    }),
  }
}

export function createCdpJwt(
  credentials: CdpCredentials,
  request: { method: string; host: string; path: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const { alg, key } = parseSigningKey(credentials.keySecret)
  const header = { alg, kid: credentials.keyId, typ: 'JWT', nonce: randomBytes(16).toString('hex') }
  const claims = {
    sub: credentials.keyId,
    iss: 'cdp',
    uris: [`${request.method} ${request.host}${request.path}`],
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_SECONDS,
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = alg === 'EdDSA'
    ? sign(null, Buffer.from(signingInput), key)
    : sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${base64url(signature)}`
}

/** Authorization header for one CDP API call, e.g. POST to the facilitator's /settle. */
export function cdpAuthorization(credentials: CdpCredentials, url: string, method = 'POST'): string {
  const { host, pathname } = new URL(url)
  return `Bearer ${createCdpJwt(credentials, { method, host, path: pathname })}`
}
