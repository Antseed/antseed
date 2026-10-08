import {
  createWorkspace,
  deleteWorkspace,
  removeWorkspaceMember,
  setWorkspaceMember,
  updateWorkspace,
  withWallet,
} from '../../services/workspaces.js'
import { activeMember, requestActor, requireOrgAdmin, requireWorkspaceAccess, visibleWorkspaceIds, workspaceRole } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { respond, type ConsoleRouter } from '../router.js'
import {
  asObject,
  confirmations,
  fullLimitsFromWire,
  limitsFromWire,
  memberDto,
  notFound,
  policyFromWire,
  requiredString,
  workspaceDto,
} from '../serialize.js'
import type { WorkspaceRole } from '../types.js'
import { defaultBuyerClient } from './network-buyer.js'

/**
 * Workspaces and their members (business rules in `services/workspaces.ts`).
 * Anyone sees the workspaces they belong to (org admins all of them). Org
 * admins create and delete workspaces and set their budgets and
 * `orgRoutingPolicy`; workspace admins rename them, set the workspace's own
 * `routingPolicy` (which can only narrow the org's) and manage their members.
 */
export function registerWorkspaceRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  router.add('GET', '/workspaces', async ({ principal }) => {
    activeMember(store, principal)
    const visible = visibleWorkspaceIds(store, principal)
    const workspaces = store.listWorkspaces().filter((workspace) => !visible || visible.has(workspace.id))
    return Promise.all(workspaces.map(async (workspace) => workspaceDto(store, await withWallet(deps, workspace))))
  })

  router.add('POST', '/workspaces', async (request) => {
    const { principal, body } = request
    requireOrgAdmin(principal, store)
    const input = asObject(body)
    const workspace = await createWorkspace(deps, requestActor(deps, request), {
      name: requiredString(input, 'name', 100),
      limits: fullLimitsFromWire(input['limits']),
      routingPolicy: policyFromWire(input['routingPolicy']) ?? null,
      orgRoutingPolicy: policyFromWire(input['orgRoutingPolicy'], 'orgRoutingPolicy') ?? null,
      ...(input['buyerIdentity'] !== undefined ? { buyerIdentity: requiredString(input, 'buyerIdentity', 32) } : {}),
      ...confirmations(input),
    }, { adminMemberId: principal?.kind === 'member' ? principal.memberId : null })
    return respond(201, workspaceDto(store, workspace))
  })

  router.add('GET', '/workspaces/:id', async ({ principal, params }) => {
    requireWorkspaceAccess(store, principal, params['id']!)
    return workspaceDto(store, await withWallet(deps, store.getWorkspace(params['id']!)!))
  })

  router.add('PATCH', '/workspaces/:id', async (request) => {
    const { principal, params, body } = request
    const id = params['id']!
    requireWorkspaceAccess(store, principal, id, 'admin')
    const input = asObject(body)
    if (input['buyerIdentity'] === undefined && (input['limits'] !== undefined || input['orgRoutingPolicy'] !== undefined)) requireOrgAdmin(principal, store)
    const workspace = updateWorkspace(deps, requestActor(deps, request), id, {
      ...(input['buyerIdentity'] !== undefined ? { buyerIdentity: input['buyerIdentity'] } : {}),
      ...(input['name'] !== undefined ? { name: requiredString(input, 'name', 100) } : {}),
      ...(input['limits'] !== undefined ? { limits: limitsFromWire(input['limits']) } : {}),
      ...(input['routingPolicy'] !== undefined ? { routingPolicy: policyFromWire(input['routingPolicy']) } : {}),
      ...(input['orgRoutingPolicy'] !== undefined ? { orgRoutingPolicy: policyFromWire(input['orgRoutingPolicy'], 'orgRoutingPolicy') } : {}),
      ...confirmations(input),
    })
    return workspaceDto(store, workspace)
  })

  router.add('DELETE', '/workspaces/:id', async (request) => {
    requireOrgAdmin(request.principal, store)
    if (!store.getWorkspace(request.params['id']!)) throw notFound('Workspace')
    await deleteWorkspace(deps, requestActor(deps, request), request.params['id']!, defaultBuyerClient(deps))
    return respond(204)
  })

  router.add('GET', '/workspaces/:id/members', async ({ principal, params }) => {
    requireWorkspaceAccess(store, principal, params['id']!)
    // Sign-in methods are for admins; plain members see who is in the workspace.
    const admin = workspaceRole(store, principal, params['id']!) === 'admin'
    return store.workspaceMembers(params['id']!).map(({ member, role }) => {
      const dto = memberDto(deps, member)
      return { member: admin ? dto : { ...dto, credentials: [] }, role }
    })
  })

  router.add('PUT', '/workspaces/:id/members/:memberId', async (request) => {
    const { principal, params, body } = request
    requireWorkspaceAccess(store, principal, params['id']!, 'admin')
    setWorkspaceMember(deps, requestActor(deps, request), params['id']!, params['memberId']!, asObject(body)['role'] as WorkspaceRole)
    return respond(204)
  })

  router.add('DELETE', '/workspaces/:id/members/:memberId', async (request) => {
    const { principal, params } = request
    requireWorkspaceAccess(store, principal, params['id']!, 'admin')
    removeWorkspaceMember(deps, requestActor(deps, request), params['id']!, params['memberId']!)
    return respond(204)
  })
}
