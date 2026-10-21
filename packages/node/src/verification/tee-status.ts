export const TEE_VERIFIER_ID = 'antseed-verifier'
export const TEE_MAX_AGE_MS = 5 * 60_000
export const TEE_BADGE_MAX_AGE_MS = 24 * 60 * 60_000
export const TEE_REQUIRED_CLAIMS = [
  'antseed-verifier:seller-node-tee-genuine',
  'antseed-verifier:seller-bound',
] as const
/** Optional claim: the downstream inference provider also runs in a genuine TEE. */
export const TEE_PROVIDER_CLAIM = 'antseed-verifier:seller-provider-tee-genuine'

export interface TeeClaim {
  claim: string
  ok: boolean
  detail?: string
}
export interface TeeEvidence {
  peerId: string
  verifierId: string
  verifierVersion?: string
  fingerprint: string
  checkedAt: number
  expiresAt: number
  sellerNodeVerified: boolean
  claims: TeeClaim[]
  reason?: string
  checking?: boolean
  unavailable?: boolean
}
export interface TeeSnapshot {
  sessionId: string
  verificationEnabled: boolean
  evidence: TeeEvidence[]
}
export interface DesktopTeeStatus {
  snapshot: TeeSnapshot | null
  error?: string
}

/**
 * How far a verified seller's TEE reaches: `end-to-end` when the upstream provider is attested
 * too, `seller-node` when only the seller node is (e.g. it forwards to a non-TEE model API).
 */
export type TeeScope = 'end-to-end' | 'seller-node'

function passedClaim(claims: readonly TeeClaim[], required: string): boolean {
  const matches = claims.filter((claim) => claim.claim === required)
  return matches.length > 0 && matches.every((claim) => claim.ok === true)
}

export function passedSellerNodeClaims(claims: readonly TeeClaim[]): boolean {
  return TEE_REQUIRED_CLAIMS.every((required) => passedClaim(claims, required))
}

export function teeScope(evidence: Pick<TeeEvidence, 'claims'>): TeeScope {
  return passedClaim(evidence.claims, TEE_PROVIDER_CLAIM) ? 'end-to-end' : 'seller-node'
}

export function isFreshSellerNodeEvidence(evidence: TeeEvidence | undefined, now = Date.now()): boolean {
  return evidence?.sellerNodeVerified === true && !evidence.checking
    && !evidence.unavailable && evidence.expiresAt > now
}

export function teeControlFileName(port: number): string {
  return `buyer-verification-${port}.json`
}
