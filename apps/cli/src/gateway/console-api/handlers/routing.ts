import { gatewayDefaultPolicy, setGatewayDefaultPolicy } from '../../services/routing.js'
import { activeMember, requestActor, requireOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import type { ConsoleRouter } from '../router.js'
import { policyFromWire } from '../serialize.js'

/** The gateway-wide default routing policy, the top level every key inherits. */
export function registerRoutingRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  router.add('GET', '/routing', async ({ principal }) => {
    activeMember(store, principal)
    return gatewayDefaultPolicy(store) ?? {}
  })

  router.add('PUT', '/routing', async (request) => {
    requireOrgAdmin(request.principal, store)
    const { confirmEmpty, ...body } = (request.body ?? {}) as Record<string, unknown>
    const policy = policyFromWire(body, 'routing policy') ?? {}
    return setGatewayDefaultPolicy(deps, requestActor(deps, request), policy, {
      confirmEmpty: confirmEmpty === true || request.query.get('confirmEmpty') === '1',
    })
  })
}
