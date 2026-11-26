import { SELLER_RETRY_SPACING_SECONDS, CONFIRMATION_RECHECK_SPACING_SECONDS } from './epoch-plan.js'
import { CONFIRMATION_WINDOW_SECONDS } from './pending-confirmations.js'
import { CONFIRMATION_MIN_DELAY_SECONDS } from './same-check.js'
import { isLocalUrl } from './test-publication.js'

/**
 * The waits of an epoch's audits, in seconds: a failed seller's retry (`SELLER_RETRY_SPACING_SECONDS`), the delay
 * before a confirmation may start (`CONFIRMATION_MIN_DELAY_SECONDS`), an undecided confirmation's next attempt
 * (`CONFIRMATION_RECHECK_SPACING_SECONDS`) and a confirmer's turn (`CONFIRMATION_WINDOW_SECONDS`).
 *
 * The production values are part of the audit rules and of the rules hash, and every function that waits defaults to
 * them. Only `verifier.testTiming` passes others, for a dry run on a local fork (`testTimingFor`).
 */
export interface AuditTiming {
  sellerRetrySpacingSeconds: number
  confirmationMinDelaySeconds: number
  confirmationRecheckSpacingSeconds: number
  confirmationWindowSeconds: number
}

/** `verifier.testTiming`: any of the waits, each optional. */
export type TestTimingConfig = Partial<AuditTiming>

export const PRODUCTION_AUDIT_TIMING: Readonly<AuditTiming> = Object.freeze({
  sellerRetrySpacingSeconds: SELLER_RETRY_SPACING_SECONDS,
  confirmationMinDelaySeconds: CONFIRMATION_MIN_DELAY_SECONDS,
  confirmationRecheckSpacingSeconds: CONFIRMATION_RECHECK_SPACING_SECONDS,
  confirmationWindowSeconds: CONFIRMATION_WINDOW_SECONDS,
})

const KEYS = Object.keys(PRODUCTION_AUDIT_TIMING) as Array<keyof AuditTiming>

/**
 * Testing only: the shortened waits `verifier.testTiming` sets, only those it sets, or null without any. Allowed only
 * while the chain RPC is on this machine (a local fork), as `verifier.testPublication` is, so a production verifier
 * never waits less than the rules say; anything else throws, so `run`, `watch` and `submit` stop.
 */
export function testTimingFor(config: TestTimingConfig | undefined, rpcUrl: string | undefined): TestTimingConfig | null {
  if (!config) return null
  const set = Object.fromEntries(KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]])) as TestTimingConfig
  if (Object.keys(set).length === 0) return null
  if (!isLocalUrl(rpcUrl)) {
    throw new Error('verifier.testTiming is for a dry run on a local fork only: the chain RPC must be on this machine '
      + `(127.0.0.1 or localhost), not ${rpcUrl ? new URL(rpcUrl).host : 'the default Base RPC'}. Remove it to wait as the audit rules say.`)
  }
  return set
}

/** Every wait, the test timing's where it sets one and the production value elsewhere. */
export function auditTiming(test: TestTimingConfig | null | undefined): AuditTiming {
  return { ...PRODUCTION_AUDIT_TIMING, ...test }
}

function duration(seconds: number): string {
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600} h`
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`
  return `${seconds} s`
}

const LABELS: Record<keyof AuditTiming, string> = {
  sellerRetrySpacingSeconds: 'seller retry',
  confirmationMinDelaySeconds: 'confirmation delay',
  confirmationRecheckSpacingSeconds: 'confirmation re-check',
  confirmationWindowSeconds: 'confirmer turn',
}

/** The one line `run` and `watch` print while a test timing is on. */
export function describeTestTiming(test: TestTimingConfig): string {
  const waits = KEYS.filter((key) => test[key] !== undefined)
    .map((key) => `${LABELS[key]} ${duration(test[key]!)} (rules: ${duration(PRODUCTION_AUDIT_TIMING[key])})`)
  return `verifier.testTiming is set: ${waits.join(', ')}. For a dry run on a local fork only; every auditor in the test must use the same values.`
}
