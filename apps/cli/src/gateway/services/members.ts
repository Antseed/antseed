import type { RoutingPolicy } from '../../routing-policy/policy.js'
import { ConsoleError } from '../console-api/router.js'
import { badRequest, notFound } from '../console-api/serialize.js'
import type { Member } from '../console-api/types.js'
import type { BudgetLimits } from '../limits.js'
import { checkPolicyInput, policyInputProblem } from '../policy-resolver.js'
import type { InviteRecord, MemberRecord, OrgRole, WorkspaceRole } from '../store.js'
import { changedFields, recordAudit, requiredText, throwIfProblem, type Actor, type PolicyConfirmations, type ServiceContext } from './context.js'

export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member']
export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['admin', 'member']
export const DEFAULT_INVITE_HOURS = 72
export const MAX_INVITE_HOURS = 24 * 30
const HOUR_MS = 60 * 60 * 1000

export function requireMemberRecord(ctx: Pick<ServiceContext, 'store'>, id: string): MemberRecord {
  const member = ctx.store.getMember(id)
  if (!member) throw notFound('Member')
  return member
}

function lastOwner(): ConsoleError {
  return new ConsoleError(409, 'last_owner', 'The organization needs at least one owner')
}

export interface InviteInput {
  label: string
  email: string | null
  orgRole: OrgRole
  workspaces: Array<{ workspaceId: string; role: WorkspaceRole }>
  expiresInHours?: number
  /** The inviting member; null for the CLI and management tokens. */
  createdBy: string | null
}

/** Creates an invited member (already in their workspaces) and a single-use link token. */
export function inviteMember(ctx: ServiceContext, actor: Actor, input: InviteInput): { invite: InviteRecord; token: string } {
  const { store } = ctx
  const label = requiredText(input.label, 'label')
  if (!ORG_ROLES.includes(input.orgRole)) throw badRequest('orgRole must be owner, admin or member')
  for (const entry of input.workspaces) {
    if (!WORKSPACE_ROLES.includes(entry.role)) throw badRequest('workspace role must be admin or member')
    if (!store.getWorkspace(entry.workspaceId)) throw notFound(`Workspace ${entry.workspaceId}`)
  }
  const hours = input.expiresInHours ?? DEFAULT_INVITE_HOURS
  if (typeof hours !== 'number' || !(hours > 0) || hours > MAX_INVITE_HOURS) throw badRequest(`expiresInHours must be between 1 and ${MAX_INVITE_HOURS}`)
  const email = input.email
  if (email && store.findMemberByEmail(email)) throw new ConsoleError(409, 'member_exists', 'A member with this email already exists')
  const { invite, token } = store.createInvite({
    label,
    email,
    orgRole: input.orgRole,
    workspaces: input.workspaces,
    expiresAt: ctx.now() + hours * HOUR_MS,
    createdBy: input.createdBy,
  })
  ctx.log(`console: invite ${invite.id} created for member ${invite.memberId}`)
  recordAudit(ctx, actor, 'invite.create', { kind: 'member', id: invite.memberId, label }, {
    inviteId: invite.id, email, orgRole: input.orgRole, workspaces: input.workspaces, expiresAt: invite.expiresAt,
  })
  return { invite, token }
}

/** Open (unused) invite, or 404. */
export function requireOpenInvite(ctx: Pick<ServiceContext, 'store'>, id: string): InviteRecord {
  const invite = ctx.store.getInvite(id)
  if (!invite || invite.usedAt !== null) throw notFound('Invite')
  return invite
}

export function cancelInvite(ctx: ServiceContext, actor: Actor, id: string): InviteRecord {
  const invite = requireOpenInvite(ctx, id)
  ctx.store.deleteInvite(invite.id)
  recordAudit(ctx, actor, 'invite.delete', { kind: 'member', id: invite.memberId, label: invite.label }, { inviteId: invite.id })
  return invite
}

export interface UpdateMemberInput extends PolicyConfirmations {
  label?: string
  email?: string | null
  orgRole?: OrgRole
  /** Only the periods present change; null clears a cap. */
  limits?: Partial<BudgetLimits>
  routingPolicy?: RoutingPolicy | null
  maxKeys?: number | null
}

/**
 * Changes a member. The last active owner keeps the role; a demoted admin's
 * management tokens are revoked with it (tokens act as org admins).
 */
export function updateMember(ctx: ServiceContext, actor: Actor, id: string, input: UpdateMemberInput): MemberRecord {
  const { store } = ctx
  const target = requireMemberRecord(ctx, id)
  const { orgRole, email, routingPolicy } = input
  if (orgRole !== undefined && !ORG_ROLES.includes(orgRole)) throw badRequest('orgRole must be owner, admin or member')
  if (target.orgRole === 'owner' && orgRole && orgRole !== 'owner' && target.status === 'active' && store.countActiveOwners() <= 1) throw lastOwner()
  if (email) {
    const existing = store.findMemberByEmail(email)
    if (existing && existing.id !== target.id) throw new ConsoleError(409, 'member_exists', 'A member with this email already exists')
  }
  if (input.label !== undefined && !input.label.trim()) throw badRequest('label is required')
  if (input.maxKeys !== undefined && input.maxKeys !== null && (!Number.isSafeInteger(input.maxKeys) || input.maxKeys < 0)) {
    throw badRequest('maxKeys must be a non-negative integer or null')
  }
  if (routingPolicy !== undefined) {
    // A member's policy applies in every workspace they belong to; it is
    // checked against the gateway default here, each workspace's policy
    // still narrows it per request.
    throwIfProblem(policyInputProblem(
      [{ field: 'routingPolicy', check: checkPolicyInput(store, { member: { ...target, routingPolicy }, memberId: target.id }, 'member', routingPolicy) }],
      input,
    ))
  }
  const updated = store.updateMember(target.id, {
    ...(input.label !== undefined ? { label: input.label.trim() } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(orgRole ? { orgRole } : {}),
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
    ...(routingPolicy !== undefined ? { routingPolicy } : {}),
    ...(input.maxKeys !== undefined ? { maxKeys: input.maxKeys } : {}),
  })
  const demoted = target.orgRole !== 'member' && updated.orgRole === 'member'
  const revokedTokens = demoted ? store.revokeAdminTokensCreatedBy(target.id) : []
  recordAudit(ctx, actor, 'member.update', { kind: 'member', id: target.id, label: updated.label }, {
    changes: changedFields(target, updated, ['label', 'email', 'orgRole', 'limits', 'routingPolicy', 'maxKeys']),
    ...(revokedTokens.length ? { revokedTokens } : {}),
  })
  return updated
}

/** Disables a member: revokes their keys and management tokens and ends their sessions. */
export function disableMember(ctx: ServiceContext, actor: Actor, id: string): { member: MemberRecord; revokedKeys: string[]; revokedTokens: string[] } {
  const { store } = ctx
  const target = requireMemberRecord(ctx, id)
  if (target.orgRole === 'owner' && target.status === 'active' && store.countActiveOwners() <= 1) throw lastOwner()
  const member = store.setMemberStatus(target.id, 'disabled')
  const revokedKeys = store.revokeMemberKeys(target.id)
  for (const keyId of revokedKeys) ctx.sessions?.revokeKeySessions(keyId)
  ctx.sessions?.revokeMemberSessions(target.id)
  const revokedTokens = store.revokeAdminTokensCreatedBy(target.id)
  ctx.log(`console: member ${target.id} disabled; revoked ${revokedKeys.length} key(s) and ${revokedTokens.length} management token(s)`)
  recordAudit(ctx, actor, 'member.disable', { kind: 'member', id: target.id, label: target.label }, { revokedKeys, revokedTokens })
  return { member, revokedKeys, revokedTokens }
}

/** Re-enables a disabled member; their revoked keys stay revoked. */
export function enableMember(ctx: ServiceContext, actor: Actor, id: string): MemberRecord {
  const target = requireMemberRecord(ctx, id)
  if (target.status === 'invited') throw new ConsoleError(409, 'invite_pending', 'This member has not accepted their invite yet')
  const member = ctx.store.setMemberStatus(target.id, 'active')
  recordAudit(ctx, actor, 'member.enable', { kind: 'member', id: target.id, label: target.label })
  return member
}

/** A member's sign-in methods, as auth keeps them. */
export interface CredentialStore {
  credentialsFor(memberId: string): Member['credentials']
  /** Removes one and ends the member's sessions except `keepSessionId`. */
  deleteCredential(memberId: string, credentialId: string, keepSessionId?: string | null): boolean
}

/**
 * Removes one sign-in method. A member's last one, which would lock them
 * out, goes only with `allowLast`. `selfRemoval` (a member removing their
 * own) keeps their current session (`keepSessionId`); otherwise all of the
 * member's sessions end.
 */
export function removeCredential(
  ctx: ServiceContext,
  actor: Actor,
  credentials: CredentialStore,
  input: { memberId: string; credentialId: string; allowLast: boolean; selfRemoval?: boolean; keepSessionId?: string | null },
): Member['credentials'][number] {
  const member = requireMemberRecord(ctx, input.memberId)
  const list = credentials.credentialsFor(member.id)
  const credential = list.find((entry) => entry.id === input.credentialId)
  if (!credential) throw new ConsoleError(404, 'not_found', 'Sign-in method not found')
  const last = list.length <= 1
  if (last && !input.allowLast) {
    throw new ConsoleError(409, 'last_credential', input.selfRemoval
      ? 'Add another sign-in method before removing this one'
      : 'Only an organization owner can remove a member\'s last sign-in method')
  }
  const self = input.selfRemoval === true
  if (!credentials.deleteCredential(member.id, credential.id, self ? input.keepSessionId ?? null : null)) {
    throw new ConsoleError(404, 'not_found', 'Sign-in method not found')
  }
  recordAudit(ctx, actor, 'member.credential_remove', { kind: 'member', id: member.id, label: member.label }, {
    credentialId: credential.id, credentialKind: credential.kind, credentialLabel: credential.label, last, sessionsRevoked: self ? 'others' : 'all',
  })
  ctx.log(`console: removed a sign-in method of member ${member.id}; ended their ${self ? 'other ' : ''}sessions`)
  return credential
}
