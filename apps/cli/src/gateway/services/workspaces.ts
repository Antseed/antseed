import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { buyerIdentityExists, createBuyerIdentity } from '../../buyer-identities/store.js'
import type { RoutingPolicy } from '../../routing-policy/policy.js'
import type { BuyerClient } from '../console-api/handlers/network-buyer.js'
import { ConsoleError } from '../console-api/router.js'
import { badRequest, notFound } from '../console-api/serialize.js'
import { NO_BUDGET_LIMITS, type BudgetLimits } from '../limits.js'
import { parseUsdToUsdc } from '../money.js'
import { checkPolicyInput, policyInputProblem } from '../policy-resolver.js'
import type { WorkspaceRecord, WorkspaceRole } from '../store.js'
import { buyerAddressBook, resolveIdentityAddress, syncWalletCache, type BuyerAddressBook, type ResolvedWalletAddress } from './wallet-address.js'
import { changedFields, recordAudit, requiredText, throwIfProblem, type Actor, type PolicyConfirmations, type ServiceContext } from './context.js'

const IDENTITY_NAME_MAX = 32
const NAME_MAX = 100

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, IDENTITY_NAME_MAX - 3) || 'workspace'
}

/** `ws-<slug>`, suffixed until no identity has that name. */
export async function uniqueWorkspaceIdentity(dataDir: string, name: string): Promise<string> {
  const base = `ws-${slugify(name)}`.slice(0, IDENTITY_NAME_MAX).replace(/-+$/, '')
  if (!await buyerIdentityExists(dataDir, base)) return base
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`
    const candidate = `${base.slice(0, IDENTITY_NAME_MAX - tail.length).replace(/-+$/, '')}${tail}`
    if (!await buyerIdentityExists(dataDir, candidate)) return candidate
  }
}

function requireWorkspaceRecord(ctx: Pick<ServiceContext, 'store'>, id: string): WorkspaceRecord {
  const workspace = ctx.store.getWorkspace(id)
  if (!workspace) throw notFound('Workspace')
  return workspace
}

/** Where a workspace's wallet address comes from; see services/wallet-address.ts. */
export interface WalletContext {
  store: ServiceContext['store']
  dataDir: string
  /** The running buyer's identities; defaults to asking the buyer on `buyerPort`. */
  buyerAddresses?: BuyerAddressBook
  buyerPort?: number
  controlSecret?: string
  log?: (message: string) => void
  warn?: (message: string) => void
}

export function walletAddressBook(ctx: Pick<WalletContext, 'buyerAddresses' | 'buyerPort' | 'controlSecret'>): BuyerAddressBook | null {
  if (ctx.buyerAddresses) return ctx.buyerAddresses
  return ctx.buyerPort ? buyerAddressBook(ctx.buyerPort, ctx.controlSecret) : null
}

/** The workspace's wallet address, resolved live and kept in the display cache. */
export async function resolveWorkspaceWallet(ctx: WalletContext, workspace: WorkspaceRecord): Promise<ResolvedWalletAddress> {
  const resolved = await resolveIdentityAddress(ctx.dataDir, walletAddressBook(ctx), workspace.buyerIdentity)
  syncWalletCache(ctx.store, workspace, resolved, (message) => (ctx.warn ?? ctx.log ?? (() => undefined))(message))
  return resolved
}

/**
 * The workspace with its wallet address as the running buyer pays (see
 * resolveWorkspaceWallet). When that cannot be known the address is null and
 * `walletNote` says why; the cached value is never presented as current.
 */
export async function withWallet(ctx: WalletContext, workspace: WorkspaceRecord): Promise<WorkspaceRecord & { walletNote?: string }> {
  const resolved = await resolveWorkspaceWallet(ctx, workspace)
  return { ...workspace, walletAddress: resolved.address, ...(resolved.note ? { walletNote: resolved.note } : {}) }
}

/** Whether the workspace's wallet still holds anything; null when the buyer cannot say. */
async function walletHoldsFunds(buyer: BuyerClient, workspace: WorkspaceRecord): Promise<boolean | null> {
  try {
    const response = await buyer(`/_antseed/balances?identity=${encodeURIComponent(workspace.buyerIdentity)}`)
    if (!response.ok) return null
    const balances = await response.json() as Record<string, unknown>
    return ['available', 'reserved', 'walletUsdc'].some((field) => {
      const value = balances[field]
      if (typeof value !== 'string' && typeof value !== 'number') return false
      try {
        return parseUsdToUsdc(String(value)) > 0
      } catch {
        return true
      }
    })
  } catch {
    return null
  }
}

/**
 * Empty-allow and narrowing checks for the workspace's two policies as they
 * would be after a change: the org policy under the gateway default, the
 * workspace admins' own under the org policy.
 */
function checkWorkspacePolicies(
  ctx: ServiceContext,
  workspace: Pick<WorkspaceRecord, 'id' | 'routingPolicy' | 'orgRoutingPolicy'>,
  sent: { routingPolicy?: RoutingPolicy | null; orgRoutingPolicy?: RoutingPolicy | null },
  flags: PolicyConfirmations,
): void {
  const next = { ...workspace, ...sent } as WorkspaceRecord
  const target = { workspaceId: workspace.id, workspace: next }
  const checks = []
  if (sent.orgRoutingPolicy !== undefined) {
    checks.push({ field: 'orgRoutingPolicy', check: checkPolicyInput(ctx.store, target, 'workspace-org', sent.orgRoutingPolicy) })
  }
  if (sent.routingPolicy !== undefined) {
    checks.push({ field: 'routingPolicy', check: checkPolicyInput(ctx.store, target, 'workspace', sent.routingPolicy) })
  }
  throwIfProblem(policyInputProblem(checks, flags))
}

export interface CreateWorkspaceInput extends PolicyConfirmations {
  name: string
  limits?: BudgetLimits
  routingPolicy?: RoutingPolicy | null
  orgRoutingPolicy?: RoutingPolicy | null
  /** Pay from this existing buyer identity; by default a new `ws-<name>` identity (wallet) is created. */
  buyerIdentity?: string
}

/** Creates a workspace with its own wallet (or an existing identity's); `adminMemberId` becomes its first admin. */
export async function createWorkspace(
  ctx: ServiceContext,
  actor: Actor,
  input: CreateWorkspaceInput,
  options: { adminMemberId?: string | null } = {},
): Promise<WorkspaceRecord> {
  const { store } = ctx
  const name = requiredText(input.name, 'name', NAME_MAX)
  const limits = input.limits ?? NO_BUDGET_LIMITS
  const routingPolicy = input.routingPolicy ?? null
  const orgRoutingPolicy = input.orgRoutingPolicy ?? null
  checkWorkspacePolicies(ctx, { id: 'ws_new', routingPolicy: null, orgRoutingPolicy: null }, {
    ...(routingPolicy ? { routingPolicy } : {}),
    ...(orgRoutingPolicy ? { orgRoutingPolicy } : {}),
  }, input)
  let buyerIdentity: string
  let walletAddress: string | null = null
  if (input.buyerIdentity !== undefined) {
    buyerIdentity = input.buyerIdentity.trim()
    if (!buyerIdentity) throw badRequest('buyerIdentity is required')
    if (buyerIdentity.length > IDENTITY_NAME_MAX) throw badRequest(`buyerIdentity is longer than ${IDENTITY_NAME_MAX} characters`)
    if (buyerIdentity !== DEFAULT_BUYER_IDENTITY && !await buyerIdentityExists(ctx.dataDir, buyerIdentity)) {
      throw badRequest(`Unknown buyer identity "${buyerIdentity}"`)
    }
    walletAddress = (await resolveIdentityAddress(ctx.dataDir, ctx.buyerAddresses ?? null, buyerIdentity).catch(() => null))?.address ?? null
  } else {
    const created = await createBuyerIdentity(ctx.dataDir, await uniqueWorkspaceIdentity(ctx.dataDir, name))
    buyerIdentity = created.name
    walletAddress = created.address
  }
  const workspace = store.createWorkspace({ name, buyerIdentity, walletAddress, limits, routingPolicy, orgRoutingPolicy })
  if (options.adminMemberId) store.setWorkspaceMember(workspace.id, options.adminMemberId, 'admin')
  ctx.log(`console: workspace ${workspace.id} created, paying with identity ${buyerIdentity}`)
  recordAudit(ctx, actor, 'workspace.create', { kind: 'workspace', id: workspace.id, label: name }, { buyerIdentity, limits, routingPolicy, orgRoutingPolicy })
  return workspace
}

export interface UpdateWorkspaceInput extends PolicyConfirmations {
  name?: string
  /** Org admins only (the caller's check); only the periods present change. */
  limits?: Partial<BudgetLimits>
  routingPolicy?: RoutingPolicy | null
  /** Org admins only (the caller's check). */
  orgRoutingPolicy?: RoutingPolicy | null
  /** Refused: a workspace's wallet never changes. */
  buyerIdentity?: unknown
}

/** Renames a workspace or changes its budgets and policies; policy changes get their own audit entry. */
export function updateWorkspace(ctx: ServiceContext, actor: Actor, id: string, input: UpdateWorkspaceInput): WorkspaceRecord {
  const { store } = ctx
  const before = requireWorkspaceRecord(ctx, id)
  if (input.buyerIdentity !== undefined) throw badRequest('A workspace\'s wallet cannot be changed')
  const { routingPolicy, orgRoutingPolicy } = input
  checkWorkspacePolicies(ctx, before, {
    ...(routingPolicy !== undefined ? { routingPolicy } : {}),
    ...(orgRoutingPolicy !== undefined ? { orgRoutingPolicy } : {}),
  }, input)
  const workspace = store.updateWorkspace(id, {
    ...(input.name !== undefined ? { name: requiredText(input.name, 'name', NAME_MAX) } : {}),
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
    ...(routingPolicy !== undefined ? { routingPolicy } : {}),
    ...(orgRoutingPolicy !== undefined ? { orgRoutingPolicy } : {}),
  })
  const target = { kind: 'workspace', id, label: workspace.name }
  const changes = changedFields(before, workspace, ['name', 'limits', 'routingPolicy', 'orgRoutingPolicy'])
  if (changes['routingPolicy'] || changes['orgRoutingPolicy']) {
    recordAudit(ctx, actor, 'workspace.policy.update', target, {
      ...(changes['routingPolicy'] ? { routingPolicy: changes['routingPolicy'] } : {}),
      ...(changes['orgRoutingPolicy'] ? { orgRoutingPolicy: changes['orgRoutingPolicy'] } : {}),
    })
  }
  const other = Object.fromEntries(Object.entries(changes).filter(([field]) => field !== 'routingPolicy' && field !== 'orgRoutingPolicy'))
  if (Object.keys(other).length) recordAudit(ctx, actor, 'workspace.update', target, { changes: other })
  return workspace
}

/**
 * Deletes a workspace that has no active keys and, unless another workspace
 * shares its identity, an empty wallet (asked of the buyer). The identity
 * itself is kept.
 */
export async function deleteWorkspace(ctx: ServiceContext, actor: Actor, id: string, buyer: BuyerClient): Promise<WorkspaceRecord> {
  const { store } = ctx
  const workspace = requireWorkspaceRecord(ctx, id)
  if (workspace.isDefault) throw new ConsoleError(409, 'default_workspace', 'The Default workspace cannot be deleted')
  if (store.countWorkspaceKeys(workspace.id) > 0) throw new ConsoleError(409, 'workspace_has_keys', 'Revoke this workspace\'s keys first')
  const shared = store.listWorkspaces().some((other) => other.id !== workspace.id && other.buyerIdentity === workspace.buyerIdentity)
  if (!shared) {
    const funds = await walletHoldsFunds(buyer, workspace)
    if (funds === null) throw new ConsoleError(409, 'balance_unknown', 'The buyer is not reachable, so the wallet balance cannot be checked')
    if (funds) throw new ConsoleError(409, 'workspace_has_balance', 'Withdraw this workspace\'s funds first')
  }
  store.deleteWorkspace(workspace.id)
  ctx.log(`console: workspace ${workspace.id} deleted (identity ${workspace.buyerIdentity} kept)`)
  recordAudit(ctx, actor, 'workspace.delete', { kind: 'workspace', id: workspace.id, label: workspace.name }, { buyerIdentity: workspace.buyerIdentity })
  return workspace
}

/** Adds a member to a workspace or changes their role there. */
export function setWorkspaceMember(ctx: ServiceContext, actor: Actor, workspaceId: string, memberId: string, role: WorkspaceRole): void {
  const { store } = ctx
  requireWorkspaceRecord(ctx, workspaceId)
  const member = store.getMember(memberId)
  if (!member) throw notFound('Member')
  if (member.status === 'disabled') throw new ConsoleError(409, 'member_disabled', 'This member is disabled')
  if (role !== 'admin' && role !== 'member') throw badRequest('role must be admin or member')
  const previous = store.memberWorkspaceRoles(member.id).get(workspaceId) ?? null
  store.setWorkspaceMember(workspaceId, member.id, role)
  recordAudit(ctx, actor, 'workspace.member.set', { kind: 'member', id: member.id, label: member.label }, { workspaceId, before: previous, after: role })
}

/** Removes a member from a workspace; their keys there are revoked with the membership. */
export function removeWorkspaceMember(ctx: ServiceContext, actor: Actor, workspaceId: string, memberId: string): { revokedKeys: string[] } {
  const { store } = ctx
  if (!store.removeWorkspaceMember(workspaceId, memberId)) throw notFound('Workspace member')
  const revokedKeys: string[] = []
  for (const key of store.listKeys({ workspaceId, ownerMemberId: memberId })) {
    if (key.status !== 'active') continue
    store.revokeKey(key.id)
    ctx.sessions?.revokeKeySessions(key.id)
    revokedKeys.push(key.id)
  }
  recordAudit(ctx, actor, 'workspace.member.remove', { kind: 'member', id: memberId, label: store.getMember(memberId)?.label ?? null }, { workspaceId, revokedKeys })
  return { revokedKeys }
}
