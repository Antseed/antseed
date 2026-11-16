import { isRoutingProtocol, type RoutingProtocol } from '@antseed/node'
import { irpSuggestAdapter } from './irp.js'
import type { RoutingClientAdapter } from './types.js'

/** One buyer adapter per routing protocol. None is preferred: the router's advertised protocol picks it. */
const ROUTING_CLIENT_ADAPTERS: Record<RoutingProtocol, RoutingClientAdapter> = {
  'irp-suggest': irpSuggestAdapter,
}

export function routingClientAdapter(protocol: RoutingProtocol): RoutingClientAdapter {
  return ROUTING_CLIENT_ADAPTERS[protocol]
}

/** The adapter for a protocol string, or null when it is not a routing protocol this buyer speaks. */
export function findRoutingClientAdapter(protocol: string | null | undefined): RoutingClientAdapter | null {
  return isRoutingProtocol(protocol) ? ROUTING_CLIENT_ADAPTERS[protocol] : null
}

export { irpSuggestAdapter, irpCandidateId } from './irp.js'
export {
  candidatePricing,
  InvalidRouterOptionsError,
  RouterCannotRankError,
  validateRouterOptions,
  type RankCandidate,
  type RouterOptionSpec,
  type RoutingClientAdapter,
} from './types.js'
