import { createHash } from 'node:crypto'
import type { JWTPayload, JWTVerifyGetKey } from 'jose'
import type { ApprovedSellerImage } from './approved-seller-images.js'
import { isTcbAcceptable } from './tcb-policy.js'
import { LITERAL_ENV, RuleError, check, checkHiddenSecrets, checkSellerConfig, isObj, parseJson, type SellerUpstream } from './seller-config-rules.js'

/**
 * Google Confidential Space runs one container on a TDX VM under a Google-built OS with no
 * operator access, and Google's attestation service signs a token describing it: the hardware,
 * the OS image, whether debugging is on, the container's image digest and every environment
 * variable the operator overrode. The seller asks for a token carrying our binding as its nonce,
 * and the buyer checks Google's signature and these claims instead of a raw TDX quote.
 *
 * A conforming workload runs an approved Antseed TEE seller image on a production (non-debug)
 * Confidential Space image on Intel TDX. Its only overrides are the settings LITERAL_ENV allows,
 * the seller config (ANTSEED_SELLER_CONFIG_JSON, checked by the seller config rules), where
 * its secrets come from (ANTSEED_GCP_SECRETS) and where it keeps its state across restarts
 * (ANTSEED_GCP_STATE). Secrets themselves are fetched from Secret Manager inside the attested
 * container, since the token would show any env value to every buyer. The state the image keeps
 * there is its payment and metering databases, encrypted, without prompts or responses.
 */

export const CS_ISSUER = 'https://confidentialcomputing.googleapis.com'
/** The audience the seller requests its token for, so a token minted for another purpose fails. */
export const CS_AUDIENCE = 'antseed-verifier'
/** Google's Confidential Space token signing keys (the issuer's jwks_uri). */
export const CS_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com'
/** The seller config, as JSON, in an env override (the image writes it to its config file). */
export const CS_SELLER_CONFIG_ENV = 'ANTSEED_SELLER_CONFIG_JSON'
/** `{ "audience": <workload identity provider>, "secrets": { NAME: <Secret Manager version> } }` */
export const CS_SECRETS_ENV = 'ANTSEED_GCP_SECRETS'
/** `gs://<bucket>/<prefix>`: where in Cloud Storage the seller keeps its encrypted state snapshots. */
export const CS_STATE_ENV = 'ANTSEED_GCP_STATE'

const STATE_LOCATION = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])\/((?!.*\/\/)(?!.*\.\.)[A-Za-z0-9._-][A-Za-z0-9._/-]{0,1023})$/

/** The bucket and prefix of a CS_STATE_ENV value, or null if it isn't a `gs://<bucket>/<prefix>` URL. */
export function parseStateLocation(value: string): { bucket: string; prefix: string } | null {
  const match = STATE_LOCATION.exec(value)
  return match && !match[2]!.endsWith('/') ? { bucket: match[1]!, prefix: match[2]! } : null
}

/** Verify a Confidential Space token's signature, issuer, audience and expiry; returns its claims. */
export type VerifyConfidentialSpaceTokenFn = (token: string) => Promise<JWTPayload>

let googleKeys: JWTVerifyGetKey | undefined
/** Checks the token against Google's published keys (ANTSEED_VERIFIER_CS_JWKS_URL overrides the URL). The seller half never loads jose. */
export const defaultVerifyConfidentialSpaceToken: VerifyConfidentialSpaceTokenFn = async (token) => {
  const jose = await import('jose')
  googleKeys ??= jose.createRemoteJWKSet(new URL(process.env['ANTSEED_VERIFIER_CS_JWKS_URL'] || CS_JWKS_URL))
  return (await jose.jwtVerify(token, googleKeys, { issuer: CS_ISSUER, audience: CS_AUDIENCE })).payload
}

const SECRET_VERSION = /^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/

/** The nonce a seller requests: SHA-256 (hex) of its antseed-rd-v1 report data for this round. */
export function confidentialSpaceNonce(reportData: Uint8Array): string {
  return createHash('sha256').update(reportData).digest('hex')
}

export interface CheckedConfidentialSpace {
  image: ApprovedSellerImage
  upstreams: SellerUpstream[]
}

/** Check a verified token's claims for this round's nonce. Returns the image and upstreams, or why it fails. */
export function checkConfidentialSpaceClaims(
  claims: JWTPayload,
  expectedNonce: string,
  images: readonly ApprovedSellerImage[],
): CheckedConfidentialSpace | { error: string } {
  try {
    const nonces = claims['eat_nonce']
    check(nonces === expectedNonce || (Array.isArray(nonces) && nonces.includes(expectedNonce)), 'Confidential Space token is not bound to this round and connection')
    check(claims['hwmodel'] === 'GCP_INTEL_TDX', `Confidential Space hardware is ${String(claims['hwmodel'])}, not Intel TDX`)
    check(claims['swname'] === 'CONFIDENTIAL_SPACE', 'token is not from a Confidential Space image')
    check(claims['dbgstat'] === 'disabled-since-boot', 'Confidential Space debug image (debugging enabled)')
    check(claims['secboot'] === true, 'Confidential Space VM did not boot with Secure Boot')
    // Google's verdict on the TDX platform's TCB, held to the same acceptance as a raw quote's.
    const tcb = isObj(claims['tdx']) ? claims['tdx']['gcp_attester_tcb_status'] : undefined
    check(typeof tcb === 'string' && isTcbAcceptable(tcb), `TCB status not acceptable: ${String(tcb ?? 'unknown')}`)
    const submods = isObj(claims['submods']) ? claims['submods'] : {}
    const space = isObj(submods['confidential_space']) ? submods['confidential_space'] : {}
    const support = space['support_attributes']
    check(Array.isArray(support) && support.includes('STABLE'), 'Confidential Space image is not a supported production release')

    const container = isObj(submods['container']) ? submods['container'] : {}
    const digest = container['image_digest']
    const image = typeof digest === 'string' ? images.find((i) => i.digest === digest) : undefined
    check(image, `image ${String(digest).slice(0, 19)}… is not an approved Antseed TEE seller image`)

    const env = container['env_override'] ?? {}
    check(isObj(env), 'container env_override must be a map')
    for (const [key, value] of Object.entries(env)) {
      check(typeof value === 'string', `environment ${key} must be a string`)
      check(LITERAL_ENV.test(key) || key === CS_SELLER_CONFIG_ENV || key === CS_SECRETS_ENV || key === CS_STATE_ENV, `environment ${key} is not allowed`)
    }
    const state = env[CS_STATE_ENV]
    check(state === undefined || parseStateLocation(state as string), `${CS_STATE_ENV} must be a gs://<bucket>/<prefix> URL`)
    const config = env[CS_SELLER_CONFIG_ENV]
    check(typeof config === 'string', `the seller config must be set in ${CS_SELLER_CONFIG_ENV}`)
    const { upstreams, apiKeyEnvs } = checkSellerConfig(parseJson(config, 'seller config'))

    const secrets = env[CS_SECRETS_ENV] === undefined ? { secrets: {} } : parseJson(env[CS_SECRETS_ENV] as string, CS_SECRETS_ENV)
    check(isObj(secrets) && isObj(secrets['secrets']), `${CS_SECRETS_ENV} must name its secrets`)
    for (const [name, version] of Object.entries(secrets['secrets'])) {
      check(typeof version === 'string' && SECRET_VERSION.test(version), `${CS_SECRETS_ENV} ${name} must be a Secret Manager version`)
    }
    checkHiddenSecrets(Object.keys(secrets['secrets']), apiKeyEnvs)
    return { image, upstreams }
  } catch (err) {
    if (err instanceof RuleError) return { error: err.message }
    throw err
  }
}
