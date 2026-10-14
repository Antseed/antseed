import { clientIp } from '../auth/http.js'
import { recordAudit, type Actor } from '../services/context.js'
import type { AuditInput, GatewayStore } from '../store.js'
import { ConsoleError, type ConsoleRequest, type Principal } from './router.js'
import type { WorkspaceRole } from './types.js'

/**
 * Role checks for console routes. Members are re-read from the store on
 * every check so a role change or a disabled member takes effect at once,
 * whatever the session cached. Management tokens act as org admins; the API
 * server already refuses read-scope tokens on anything but GET.
 */

function unauthorized(): ConsoleError {
  return new ConsoleError(401, 'unauthorized', 'Sign in to continue')
}

function forbidden(message = 'You do not have access to this'): ConsoleError {
  return new ConsoleError(403, 'forbidden', message)
}

/** The live member behind a principal, or null for keys and tokens. Throws when the member is no longer active. */
export function activeMember(store: GatewayStore, p: Principal | null) {
  if (!p) throw unauthorized()
  if (p.kind !== 'member') return null
  const member = store.getMember(p.memberId)
  if (!member || member.status !== 'active') throw unauthorized()
  return member
}

export function isOrgAdmin(store: GatewayStore, p: Principal | null): boolean {
  if (!p) return false
  if (p.kind === 'token') return true
  if (p.kind === 'key') return false
  const member = store.getMember(p.memberId)
  return Boolean(member && member.status === 'active' && (member.orgRole === 'owner' || member.orgRole === 'admin'))
}

/**
 * Org owner or admin (or a management token). The store argument is
 * optional to keep the spec'd signature; without it the principal's own
 * claim is trusted.
 */
export function requireOrgAdmin(p: Principal | null, store?: GatewayStore): void {
  if (!p) throw unauthorized()
  if (p.kind === 'token') return
  if (p.kind === 'key') throw forbidden('API-key sessions are read-only')
  if (store) {
    activeMember(store, p)
    if (!isOrgAdmin(store, p)) throw forbidden('Only organization admins can do this')
    return
  }
  if (p.orgRole !== 'owner' && p.orgRole !== 'admin') throw forbidden('Only organization admins can do this')
}

/** The caller's role in a workspace: org admins and tokens count as workspace admins. */
export function workspaceRole(store: GatewayStore, p: Principal | null, workspaceId: string): WorkspaceRole | null {
  if (!p || p.kind === 'key') return null
  if (isOrgAdmin(store, p)) return 'admin'
  if (p.kind !== 'member') return null
  const member = store.getMember(p.memberId)
  if (!member || member.status !== 'active') return null
  return store.memberWorkspaceRoles(p.memberId).get(workspaceId) ?? null
}

export function requireWorkspaceAccess(store: GatewayStore, p: Principal | null, workspaceId: string, minRole: 'member' | 'admin' = 'member'): void {
  if (!p) throw unauthorized()
  if (p.kind === 'member') activeMember(store, p)
  if (!store.getWorkspace(workspaceId)) throw new ConsoleError(404, 'not_found', 'Workspace not found')
  const role = workspaceRole(store, p, workspaceId)
  if (!role) throw forbidden('You are not a member of this workspace')
  if (minRole === 'admin' && role !== 'admin') throw forbidden('Only workspace admins can do this')
}

export function canSeeWorkspace(store: GatewayStore, p: Principal | null, workspaceId: string): boolean {
  if (!store.getWorkspace(workspaceId)) return false
  return workspaceRole(store, p, workspaceId) !== null
}

/** Workspaces the caller can open; null means all of them. */
export function visibleWorkspaceIds(store: GatewayStore, p: Principal | null): Set<string> | null {
  if (isOrgAdmin(store, p)) return null
  if (!p || p.kind !== 'member') return new Set()
  return new Set(store.memberWorkspaceRoles(p.memberId).keys())
}

/**
 * Keys whose usage and request log the caller may read; null means all.
 * A key session sees its key; a member sees every key in workspaces they
 * administer plus their own keys elsewhere.
 */
export function visibleKeyIds(store: GatewayStore, p: Principal | null): string[] | null {
  if (!p) throw unauthorized()
  if (p.kind === 'key') return [p.keyId]
  if (isOrgAdmin(store, p)) return null
  if (p.kind !== 'member') return []
  activeMember(store, p)
  const roles = store.memberWorkspaceRoles(p.memberId)
  return store.listKeys()
    .filter((key) => roles.get(key.workspaceId) === 'admin' || (key.ownerMemberId === p.memberId && roles.has(key.workspaceId)))
    .map((key) => key.id)
}

// ── Audit helpers ─────────────────────────────────────────────────────────

/** The audit-log actor for a principal (null → system). */
export function auditActor(store: Pick<GatewayStore, 'getMember' | 'getKey' | 'getAdminToken'>, p: Principal | null): AuditInput['actor'] {
  if (!p) return { kind: 'system', id: null, label: null }
  try {
    if (p.kind === 'member') return { kind: 'member', id: p.memberId, label: store.getMember(p.memberId)?.label ?? null }
    if (p.kind === 'key') return { kind: 'key', id: p.keyId, label: store.getKey(p.keyId)?.label ?? null }
    return { kind: 'token', id: p.tokenId, label: store.getAdminToken(p.tokenId)?.label ?? null }
  } catch {
    return { kind: p.kind, id: principalId(p), label: null }
  }
}

function principalId(p: Principal): string {
  if (p.kind === 'member') return p.memberId
  if (p.kind === 'key') return p.keyId
  return p.tokenId
}

/**
 * Client address of a console request. `CF-Connecting-IP` is believed only
 * when the gateway runs behind its own Cloudflare tunnel
 * (`deps.trustCloudflareHeaders`); otherwise the last `X-Forwarded-For`
 * hop added by a loopback proxy, else the socket peer.
 */
export function requestIp(request: Pick<ConsoleRequest, 'raw'>, deps?: { trustCloudflareHeaders?: boolean }): string | null {
  if (!request.raw?.socket) return null
  return clientIp(request.raw, { trustCloudflare: deps?.trustCloudflareHeaders === true })
}

/**
 * Records one mutating console action. Never throws: a failed write is
 * logged loudly instead, since the action itself already happened.
 *
 *   audit(deps, request, 'preset.update', { kind: 'preset', id, label: name }, { before, after })
 */
export function audit(
  deps: { store: GatewayStore; log: (message: string) => void },
  request: Pick<ConsoleRequest, 'principal' | 'raw'>,
  action: string,
  target: AuditInput['target'] = null,
  details: Record<string, unknown> = {},
): void {
  recordAudit(deps, requestActor(deps, request), action, target, details)
}

/** The audit actor and client address of a console request, for the shared services. */
export function requestActor(deps: { store: GatewayStore; trustCloudflareHeaders?: boolean }, request: Pick<ConsoleRequest, 'principal' | 'raw'>): Actor {
  let ip: string | null = null
  try {
    ip = requestIp(request, deps)
  } catch {
    ip = null
  }
  return { actor: auditActor(deps.store, request.principal), ip }
}
