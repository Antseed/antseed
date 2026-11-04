/**
 * Who caused a failed or UNDETERMINED audit. `auditor` failures (our buyer refused the seller, our
 * deposit or payment channel, our probe bank) don't use up the seller's retry: they are retried up
 * to `AUDITOR_FAILURE_ATTEMPTS` times per epoch, unless retrying cannot help, and an UNDETERMINED
 * they cause is never submitted. `seller` and `unclear` failures are retried once per epoch.
 */
export type FailureBlame = 'seller' | 'auditor' | 'unclear'

export interface ReasonLike {
  code?: string | null
  source?: string | null
  summary?: string | null
}

const AUDITOR_TEXT = [
  /outside your buyer routing policy/i,
  /\bdeposit\b/i,
  /insufficient (?:funds|balance)/i,
  /probe bank/i,
  /BANK_EXHAUSTED/,
  /unseen questions/i,
  /\benrol(?:l)?ment\b/i,
  /reference (?:endpoint|credits?)/i,
  /buyer proxy/i,
  // The auditor's time limits, not the seller's: the fixed total deadline of earlier releases cut off
  // honest slow sellers that were still answering, and the total limit that replaced it.
  /seller audit deadline exceeded after \d+ms/i,
  /seller audit reached its time limit/i,
]

const SELLER_CODES = new Set([
  'transport_error',
  'rate_limited',
  'deadline_exceeded',
  'request_timeout',
  'temporarily_unavailable',
  'response_auth_missing',
  'response_auth_invalid',
  'missing_response_auth',
  'upstream_credentials_invalid',
  'request_profile_incompatible',
  'malformed_output',
  'stale_model_advertisement',
])

export function failureBlame(reason: ReasonLike | null | undefined, text?: string | null): FailureBlame {
  const summary = [reason?.summary ?? '', text ?? ''].join(' ')
  if (AUDITOR_TEXT.some((pattern) => pattern.test(summary))) return 'auditor'
  const code = reason?.code ?? null
  if (code === 'payment_lock_timeout' || code === 'policy_rejected' || code === 'reputation_below_minimum') return 'auditor'
  if (code && SELLER_CODES.has(code)) return 'seller'
  return 'unclear'
}
