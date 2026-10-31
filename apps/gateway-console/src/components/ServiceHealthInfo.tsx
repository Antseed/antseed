import type { ServiceHealthView } from '../api/types'
import { formatDateTime } from '../lib/format'
import { serviceHealthSummary } from '../lib/service-health'

/** A seller's last announced self health check for one model; failing gets the amber dot. Nothing when not announced. */
export function ServiceHealthInfo({ health }: { health: ServiceHealthView | undefined }) {
  if (!health) return null
  const title = health.checkedAt ? `Checked ${formatDateTime(health.checkedAt)}` : undefined
  if (health.status !== 'failing') return <span title={title}>{serviceHealthSummary(health)}</span>
  return <span className="gc-health-failing" title={title}><span className="gc-attention" aria-hidden="true" />{serviceHealthSummary(health)}</span>
}
