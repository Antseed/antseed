import type { RoutingPolicy } from '../../routing-policy/policy.js'
import { GATEWAY_ROUTING_SETTING, checkPolicyInput, gatewayDefaultPolicy, policyInputProblem } from '../policy-resolver.js'
import { recordAudit, throwIfProblem, type Actor, type ServiceContext } from './context.js'

export { gatewayDefaultPolicy }

/**
 * Sets the gateway-wide default routing policy, the top level every key
 * inherits; an empty policy clears it. A policy that lets no seller serve
 * needs `confirmEmpty`.
 */
export function setGatewayDefaultPolicy(ctx: ServiceContext, actor: Actor, policy: RoutingPolicy, options: { confirmEmpty?: boolean } = {}): RoutingPolicy {
  const { store } = ctx
  throwIfProblem(policyInputProblem(
    [{ field: 'routingPolicy', check: checkPolicyInput(store, {}, 'gateway', policy) }],
    { confirmEmpty: options.confirmEmpty === true, acceptNarrowed: true },
  ))
  const before = gatewayDefaultPolicy(store)
  store.setSetting(GATEWAY_ROUTING_SETTING, Object.keys(policy).length > 0 ? policy : null)
  recordAudit(ctx, actor, 'routing.default.update', { kind: 'routing', id: 'gateway', label: 'Gateway default' }, { before, after: policy })
  ctx.log('console: gateway default routing policy updated')
  return policy
}
