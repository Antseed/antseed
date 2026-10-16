import type { PeerTeeScope } from '../api/types'
import { Icon } from './icons'
import { Badge } from './ui'

const FULL = 'Full TEE: the seller node and its model provider both run in verified TEEs.'
const PARTIAL = 'Partial TEE: only the seller node runs in a verified TEE. Its model provider is not TEE-attested and may see requests.'
const UNVERIFIED = 'Advertises TEE attestation; the buyer has not verified it yet.'

/**
 * A seller's TEE, like an SSL mode: Full when the attestation reaches its model provider,
 * Partial when only the seller node is attested, plain TEE while only advertised.
 */
export function TeeBadge({ tee, scope }: { tee: boolean; scope: PeerTeeScope | null | undefined }) {
  if (scope === 'end-to-end') return <Badge tone="info" title={FULL} aria-label={FULL}><Icon.teeFull size={12} />Full TEE</Badge>
  if (scope === 'seller-node') return <Badge title={PARTIAL} aria-label={PARTIAL}><Icon.teePartial size={12} />Partial TEE</Badge>
  if (tee) return <Badge title={UNVERIFIED} aria-label={UNVERIFIED}>TEE</Badge>
  return null
}
