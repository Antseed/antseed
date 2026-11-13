import { Badge } from '@antseed/ui'
import type { RoutingPolicy } from '../api/types'
import { policyChips } from '../lib/policy'

/** A policy as one line of chips ("Allow 3 sellers · TEE only · ≤ $2/M in · Sort: price"). */
export function PolicyChips({ policy, invalid, empty = 'Inherits everything' }: { policy: RoutingPolicy | null | undefined; invalid?: boolean; empty?: string }) {
  if (invalid) return <span className="gc-warn">Has an invalid setting; open it to fix.</span>
  const chips = policyChips(policy)
  if (chips.length === 0) return <span className="gc-muted">{empty}</span>
  return (
    <span className="gc-chiprow">
      {chips.map((chip) => <Badge key={chip}>{chip}</Badge>)}
    </span>
  )
}
