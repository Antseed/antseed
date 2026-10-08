import {
  DEFAULT_INVITE_HOURS,
  MAX_INVITE_HOURS,
  ORG_ROLES,
  WORKSPACE_ROLES,
  cancelInvite,
  disableMember,
  enableMember,
  inviteMember,
  requireMemberRecord,
  requireOpenInvite,
  updateMember,
} from '../../services/members.js'
import type { MemberRecord } from '../../store.js'
import { activeMember, isOrgAdmin, requestActor, requireOrgAdmin, workspaceRole } from '../access.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, respond, type ConsoleRouter, type Principal } from '../router.js'
import {
  asObject,
  badRequest,
  consoleUrl,
  limitsFromWire,
  memberDto,
  notFound,
  optionalBoolean,
  optionalCount,
  optionalString,
  policyFromWire,
  requiredString,
} from '../serialize.js'
import type { Invite, OrgRole, WorkspaceRole } from '../types.js'
import { registerAuditRoutes } from './audit.js'

function callerIsOwner(deps: ConsoleDeps, p: Principal | null): boolean {
  return p?.kind === 'member' && deps.store.getMember(p.memberId)?.orgRole === 'owner'
}

function parseOrgRole(value: unknown): OrgRole {
  if (!ORG_ROLES.includes(value as OrgRole)) throw badRequest('orgRole must be owner, admin or member')
  return value as OrgRole
}

/** Admins manage members, but only an owner may touch an owner or make one. */
function assertMayManage(deps: ConsoleDeps, p: Principal | null, target: MemberRecord, nextRole?: OrgRole): void {
  requireOrgAdmin(p, deps.store)
  const owner = callerIsOwner(deps, p)
  if ((target.orgRole === 'owner' || nextRole === 'owner') && !owner) {
    throw new ConsoleError(403, 'forbidden', 'Only an owner can change an owner or make someone owner')
  }
}

function inviteDto(invite: { id: string; label: string; email: string | null; orgRole: OrgRole; expiresAt: number; createdAt: number }, url?: string): Invite {
  return {
    id: invite.id,
    label: invite.label,
    email: invite.email,
    orgRole: invite.orgRole,
    ...(url ? { url } : {}),
    expiresAt: invite.expiresAt,
    createdAt: invite.createdAt,
  }
}

/**
 * Members and invites. Org admins manage everyone (owners only by owners);
 * a workspace admin may invite plain members into workspaces they
 * administer and see or cancel the invites they created. Disabling a member
 * revokes their keys and ends their sessions through `deps.sessions`.
 */
export function registerOrgRoutes(router: ConsoleRouter, deps: ConsoleDeps): void {
  const { store } = deps

  // The audit log lives with the organization routes so it mounts wherever they do.
  registerAuditRoutes(router, deps)

  router.add('GET', '/members', async ({ principal }) => {
    requireOrgAdmin(principal, store)
    return store.listMembers().map((member) => memberDto(deps, member))
  })

  router.add('POST', '/invites', async (request) => {
    const { principal, body, headers } = request
    const input = asObject(body)
    const label = requiredString(input, 'label')
    const email = optionalString(input, 'email', 320) ?? null
    const orgRole = parseOrgRole(input['orgRole'] ?? 'member')
    const workspacesRaw = input['workspaces'] ?? []
    if (!Array.isArray(workspacesRaw)) throw badRequest('workspaces must be a list')
    const workspaces = workspacesRaw.map((entry) => {
      const item = asObject(entry)
      const workspaceId = requiredString(item, 'workspaceId')
      const role = (item['role'] ?? 'member') as WorkspaceRole
      if (!WORKSPACE_ROLES.includes(role)) throw badRequest('workspace role must be admin or member')
      if (!store.getWorkspace(workspaceId)) throw notFound(`Workspace ${workspaceId}`)
      return { workspaceId, role }
    })
    const hours = input['expiresInHours'] ?? DEFAULT_INVITE_HOURS
    if (typeof hours !== 'number' || !(hours > 0) || hours > MAX_INVITE_HOURS) throw badRequest(`expiresInHours must be between 1 and ${MAX_INVITE_HOURS}`)

    if (isOrgAdmin(store, principal)) {
      if (orgRole === 'owner' && !callerIsOwner(deps, principal)) throw new ConsoleError(403, 'forbidden', 'Only an owner can invite an owner')
    } else {
      activeMember(store, principal)
      if (orgRole !== 'member') throw new ConsoleError(403, 'forbidden', 'Only organization admins can invite admins')
      if (workspaces.length === 0) throw new ConsoleError(403, 'forbidden', 'Invite them into a workspace you administer')
      for (const entry of workspaces) {
        if (workspaceRole(store, principal, entry.workspaceId) !== 'admin') {
          throw new ConsoleError(403, 'forbidden', 'You can only invite into workspaces you administer')
        }
      }
    }
    const { invite, token } = inviteMember(deps, requestActor(deps, request), {
      label,
      email,
      orgRole,
      workspaces,
      expiresInHours: hours,
      createdBy: principal?.kind === 'member' ? principal.memberId : null,
    })
    return respond(201, inviteDto(invite, consoleUrl(deps, headers.host, `/invite#${token}`)))
  })

  router.add('GET', '/invites', async ({ principal }) => {
    const all = store.listInvites()
    if (isOrgAdmin(store, principal)) return all.map((invite) => inviteDto(invite))
    activeMember(store, principal)
    return all
      .filter((invite) => principal?.kind === 'member' && invite.createdBy === principal.memberId)
      .map((invite) => inviteDto(invite))
  })

  router.add('DELETE', '/invites/:id', async (request) => {
    const { principal, params } = request
    const invite = requireOpenInvite(deps, params['id']!)
    const own = principal?.kind === 'member' && invite.createdBy === principal.memberId
    if (!own) requireOrgAdmin(principal, store)
    else activeMember(store, principal)
    cancelInvite(deps, requestActor(deps, request), invite.id)
    return respond(204)
  })

  router.add('PATCH', '/members/:id', async (request) => {
    const { principal, params, body } = request
    const target = requireMemberRecord(deps, params['id']!)
    const input = asObject(body)
    const orgRole = input['orgRole'] === undefined ? undefined : parseOrgRole(input['orgRole'])
    assertMayManage(deps, principal, target, orgRole)
    const updated = updateMember(deps, requestActor(deps, request), target.id, {
      ...(input['label'] !== undefined ? { label: requiredString(input, 'label') } : {}),
      ...(input['email'] !== undefined ? { email: optionalString(input, 'email', 320) ?? null } : {}),
      ...(orgRole ? { orgRole } : {}),
      ...(input['limits'] !== undefined ? { limits: limitsFromWire(input['limits']) } : {}),
      ...(input['routingPolicy'] !== undefined ? { routingPolicy: policyFromWire(input['routingPolicy']) } : {}),
      ...(input['maxKeys'] !== undefined ? { maxKeys: optionalCount(input, 'maxKeys') ?? null } : {}),
      confirmEmpty: optionalBoolean(input, 'confirmEmpty'),
      acceptNarrowed: optionalBoolean(input, 'acceptNarrowed'),
    })
    return memberDto(deps, updated)
  })

  router.add('POST', '/members/:id/disable', async (request) => {
    const { principal, params } = request
    const target = requireMemberRecord(deps, params['id']!)
    assertMayManage(deps, principal, target)
    if (principal?.kind === 'member' && principal.memberId === target.id) throw new ConsoleError(409, 'cannot_disable_self', 'You cannot disable yourself')
    const { member: updated } = disableMember(deps, requestActor(deps, request), target.id)
    return memberDto(deps, updated)
  })

  router.add('POST', '/members/:id/enable', async (request) => {
    const { principal, params } = request
    const target = requireMemberRecord(deps, params['id']!)
    assertMayManage(deps, principal, target)
    const updated = enableMember(deps, requestActor(deps, request), target.id)
    return memberDto(deps, updated)
  })
}
