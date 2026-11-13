import { createPeerList, deletePeerList, updatePeerList } from '../../services/peer-lists.js'
import type { PeerListRecord } from '../../store.js'
import { activeMember, requestActor, requireOrgAdmin } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { respond, type ConsoleRouter } from '../router.js'
import { asObject, optionalBoolean, optionalString, requiredString } from '../serialize.js'
import type { PeerList } from '../types.js'

function peerListDto(list: PeerListRecord): PeerList {
  return { id: list.id, name: list.name, description: list.description, peerIds: list.peerIds, createdAt: list.createdAt }
}

/** Named seller lists to build routing policies from (rules in `services/peer-lists.ts`). Everyone reads them; org admins edit. */
export function registerPeerListRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  router.add('GET', '/peer-lists', async ({ principal }) => {
    activeMember(store, principal)
    return store.listPeerLists().map(peerListDto)
  })

  router.add('POST', '/peer-lists', async (request) => {
    requireOrgAdmin(request.principal, store)
    const input = asObject(request.body)
    const list = createPeerList(deps, requestActor(deps, request), {
      name: requiredString(input, 'name', 100),
      description: optionalString(input, 'description', 500) ?? null,
      peerIds: input['peerIds'] ?? [],
    })
    return respond(201, peerListDto(list))
  })

  router.add('PATCH', '/peer-lists/:id', async (request) => {
    requireOrgAdmin(request.principal, store)
    const input = asObject(request.body)
    const list = updatePeerList(deps, requestActor(deps, request), request.params['id']!, {
      ...(input['name'] !== undefined ? { name: requiredString(input, 'name', 100) } : {}),
      ...(input['description'] !== undefined ? { description: optionalString(input, 'description', 500) ?? null } : {}),
      ...(input['peerIds'] !== undefined ? { peerIds: input['peerIds'] } : {}),
      confirmEmpty: optionalBoolean(input, 'confirmEmpty') === true,
    })
    return peerListDto(list)
  })

  router.add('DELETE', '/peer-lists/:id', async (request) => {
    requireOrgAdmin(request.principal, store)
    const confirmEmpty = request.query.get('confirmEmpty') === 'true' || optionalBoolean(asObject(request.body), 'confirmEmpty') === true
    deletePeerList(deps, requestActor(deps, request), request.params['id']!, { confirmEmpty })
    return respond(204)
  })
}
