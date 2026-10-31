import type { ServiceHealthView } from '../api/types'
import { formatDateTime, formatRelative } from './format'

/** The fixed failure codes a seller announces, in plain words. */
const REASON_LABELS: Record<string, string> = {
  timeout: 'upstream timed out',
  rate_limited: 'upstream rate or usage limited',
  out_of_credit: 'upstream out of credit',
  auth: 'upstream rejected its credentials',
  model_unavailable: 'upstream no longer offers the model',
  upstream_error: 'upstream errors',
  unreachable: 'upstream unreachable',
  init_failed: 'provider failed to start',
}

/**
 * A seller's last announced self health check for one model, in one line:
 * when it last succeeded and how (a buyer request or its own probe), or since
 * when it is failing and why.
 */
export function serviceHealthSummary(health: ServiceHealthView, now = Date.now()): string {
  if (health.status === 'unknown') return 'Self check: not run yet'
  if (health.status === 'healthy') {
    if (!health.checkedAt) return 'Self check: passed'
    const when = formatRelative(health.checkedAt, now)
    return health.source === 'traffic' ? `Self check: served a buyer ${when}` : `Self check: passed ${when}`
  }
  const facts: string[] = []
  if (health.reason) facts.push(REASON_LABELS[health.reason] ?? health.reason)
  if (health.httpStatus !== null) facts.push(`HTTP ${health.httpStatus}`)
  if (health.consecutiveFailures) facts.push(`${health.consecutiveFailures} failed check${health.consecutiveFailures === 1 ? '' : 's'} in a row`)
  if (health.checkedAt) facts.push(`last ${formatRelative(health.checkedAt, now)}`)
  const since = health.failingSince ? ` since ${formatDateTime(health.failingSince)}` : ''
  return `Self check failing${since}${facts.length ? `: ${facts.join(', ')}` : ''}`
}
