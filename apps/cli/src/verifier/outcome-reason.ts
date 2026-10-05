export type VerificationOutcomeReasonCode =
  | 'deadline_exceeded'
  | 'request_timeout'
  | 'temporarily_unavailable'
  | 'rate_limited'
  | 'payment_lock_timeout'
  | 'response_auth_missing'
  | 'response_auth_invalid'
  | 'upstream_credentials_invalid'
  | 'request_profile_incompatible'
  | 'missing_response_auth'
  | 'reputation_below_minimum'
  | 'price_above_maximum'
  | 'policy_rejected'
  | 'stale_model_advertisement'
  | 'malformed_output'
  | 'transport_error'
  | 'audit_failed'

export type VerificationOutcomeReasonSource =
  | 'transport'
  | 'provider'
  | 'payment'
  | 'response_auth'
  | 'policy'
  | 'request_profile'
  | 'verifier'

export type VerificationNextAction =
  | 'resume audit'
  | 'retry later'
  | 'seller must repair credentials'
  | 'seller must support canonical request profile'
  | 'restart or repair payment channel'
  | 'adjust buyer routing policy'
  | 'seller must return parseable output'
  | 'rebuild verifier reference'
  | 'inspect verifier evidence'

export interface VerificationOutcomeReasonV1 {
  code: VerificationOutcomeReasonCode
  summary: string
  retryable: boolean
  source: VerificationOutcomeReasonSource
  affectedBatchCount: number
  totalBatchCount: number
  nextAction: VerificationNextAction
  upstreamStatus?: number
  providerCode?: string
  requestId?: string
}

export function withBatchCounts(
  reason: VerificationOutcomeReasonV1,
  affectedBatchCount: number,
  totalBatchCount: number,
): VerificationOutcomeReasonV1 {
  return { ...reason, affectedBatchCount, totalBatchCount }
}

export function failureOutcomeReason(message: string): VerificationOutcomeReasonV1 {
  return {
    code: 'audit_failed',
    summary: sanitizeOutcomeSummary(message),
    retryable: false,
    source: 'verifier',
    affectedBatchCount: 0,
    totalBatchCount: 0,
    nextAction: message.includes('probe bank') || message.includes('reference')
      ? 'rebuild verifier reference'
      : 'inspect verifier evidence',
  }
}

export function sanitizeOutcomeSummary(value: string): string {
  return value
    .replace(/bearer\s+[a-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[a-z0-9_-]{12,}/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}
