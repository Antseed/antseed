import { isRoutingPolicy, normalizePolicy, type RoutingPolicy } from '../../routing-policy/policy.js'
import { BUDGET_PERIODS, periodStart, type BudgetLimits } from '../limits.js'
import { optionalUsdcToDecimalString, parseUsdToUsdc, usdcToDecimalString } from '../money.js'
import type { ApiKeyRecord, GatewayStore, MemberRecord, WorkspaceRecord } from '../store.js'
import type { ConsoleDeps } from './deps.js'
import { ConsoleError } from './router.js'
import type { ApiKey, Member, SpendLimits, Workspace, WorkspaceSummary } from './types.js'

export function badRequest(message: string, code = 'invalid_request'): ConsoleError {
  return new ConsoleError(400, code, message)
}

export function notFound(what: string): ConsoleError {
  return new ConsoleError(404, 'not_found', `${what} not found`)
}

export function asObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('Send a JSON object')
  return body as Record<string, unknown>
}

export function requiredString(body: Record<string, unknown>, field: string, max = 200): string {
  const value = body[field]
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`)
  if (value.trim().length > max) throw badRequest(`${field} is longer than ${max} characters`)
  return value.trim()
}

export function optionalString(body: Record<string, unknown>, field: string, max = 200): string | null | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw badRequest(`${field} must be a string`)
  if (value.length > max) throw badRequest(`${field} is longer than ${max} characters`)
  return value.trim() || null
}

export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw badRequest(`${field} must be true or false`)
  return value
}

/** The policy confirmation flags a console request may carry. */
export function confirmations(input: Record<string, unknown>): { confirmEmpty?: boolean; acceptNarrowed?: boolean } {
  return { confirmEmpty: optionalBoolean(input, 'confirmEmpty'), acceptNarrowed: optionalBoolean(input, 'acceptNarrowed') }
}

export function optionalTimestamp(body: Record<string, unknown>, field: string): number | null | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw badRequest(`${field} must be epoch milliseconds or null`)
  return value
}

export function optionalCount(body: Record<string, unknown>, field: string): number | null | undefined {
  const value = body[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw badRequest(`${field} must be a non-negative integer or null`)
  return value
}

export function limitsToWire(limits: BudgetLimits): SpendLimits {
  return {
    daily: optionalUsdcToDecimalString(limits.daily),
    weekly: optionalUsdcToDecimalString(limits.weekly),
    monthly: optionalUsdcToDecimalString(limits.monthly),
    total: optionalUsdcToDecimalString(limits.total),
  }
}

/** Only the periods present in the input; null clears a cap. */
export function limitsFromWire(value: unknown): Partial<BudgetLimits> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw badRequest('limits must be an object of USD amounts')
  const input = value as Record<string, unknown>
  const limits: Partial<BudgetLimits> = {}
  for (const period of BUDGET_PERIODS) {
    const raw = input[period]
    if (raw === undefined) continue
    if (raw === null || raw === '') {
      limits[period] = null
      continue
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') throw badRequest(`limits.${period} must be a USD amount or null`)
    try {
      limits[period] = parseUsdToUsdc(String(raw))
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : `limits.${period} is invalid`)
    }
  }
  return limits
}

export function fullLimitsFromWire(value: unknown): BudgetLimits {
  return { daily: null, weekly: null, monthly: null, total: null, ...(limitsFromWire(value) ?? {}) }
}

export function policyFromWire(value: unknown, field = 'routingPolicy'): RoutingPolicy | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (!isRoutingPolicy(value)) throw badRequest(`${field} is not a valid routing policy`, 'invalid_routing_policy')
  return normalizePolicy(value)
}

function workspaceSummary(workspace: WorkspaceRecord): WorkspaceSummary {
  return { id: workspace.id, name: workspace.name, isDefault: workspace.isDefault }
}

export function workspaceDto(store: GatewayStore, workspace: WorkspaceRecord): Workspace {
  return {
    ...workspaceSummary(workspace),
    buyerIdentity: workspace.buyerIdentity,
    walletAddress: workspace.walletAddress,
    limits: limitsToWire(workspace.limits),
    routingPolicy: workspace.routingPolicy,
    orgRoutingPolicy: workspace.orgRoutingPolicy,
    memberCount: store.countWorkspaceMembers(workspace.id),
    keyCount: store.countWorkspaceKeys(workspace.id),
    createdAt: workspace.createdAt,
  }
}

export function memberDto(deps: ConsoleDeps, member: MemberRecord): Member {
  return {
    id: member.id,
    label: member.label,
    email: member.email,
    orgRole: member.orgRole,
    status: member.status,
    credentials: deps.memberCredentials?.(member.id) ?? [],
    limits: limitsToWire(member.limits),
    routingPolicy: member.routingPolicy,
    maxKeys: member.maxKeys,
    createdAt: member.createdAt,
  }
}

export function apiKeyDto(store: GatewayStore, key: ApiKeyRecord, now = Date.now()): ApiKey {
  const usage = store.usageStats(key.id)
  const month = store.usageStats(key.id, periodStart('monthly', now))
  return {
    id: key.id,
    label: key.label,
    hint: key.hint,
    workspaceId: key.workspaceId,
    ownerMemberId: key.ownerMemberId,
    buyerIdentity: key.buyerIdentity,
    status: key.status,
    limits: limitsToWire(key.limits),
    routingPolicy: key.routingPolicy,
    ownerLimits: limitsToWire(key.ownerLimits),
    ownerRoutingPolicy: key.ownerRoutingPolicy,
    topupEnabled: key.topupEnabled,
    expiresAt: key.expiresAt,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    usage: { requests: usage.requests, spent: usdcToDecimalString(usage.spentUsdc), spentThisMonth: usdcToDecimalString(month.spentUsdc) },
  }
}

/** Absolute console URL: the configured public URL, else the local listener. */
export function consoleUrl(deps: ConsoleDeps, host: string | undefined, path: string): string {
  const base = deps.publicUrl?.replace(/\/+$/, '') ?? `http://${host ?? '127.0.0.1'}`
  return `${base}/console${path}`
}
