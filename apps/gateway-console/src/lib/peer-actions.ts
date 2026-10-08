import { hasOwnerLayer, type ApiClient, type SaveOptions } from '../api'
import type { ApiKey, RoutePreview, RoutingPolicy } from '../api/types'
import { samePeerId } from './peer-id'
import { applyPeerAction, type PeerAction } from './policy'

/**
 * Where a Network-page Allow / Block / Prefer lands:
 * - gateway: the gateway default (org admins)
 * - workspace-org: the workspace's org policy (org admins)
 * - workspace: the workspace's own policy (workspace admins)
 * - member: a member's policy (org admins)
 * - key: one API key, on the layer the caller may edit: `admin` (workspace
 *   admins; `routingPolicy`) or `owner` (the key's owner; `ownerRoutingPolicy`
 *   where the gateway has it, else `routingPolicy`, which it narrows)
 */
export type PeerScope =
  | { kind: 'gateway' }
  | { kind: 'workspace-org'; workspaceId: string }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'member'; memberId: string }
  | { kind: 'key'; keyId: string; workspaceId: string; layer?: 'admin' | 'owner' }

type PolicyApi = Pick<ApiClient, 'network' | 'workspaces' | 'members' | 'keys'>

function keyField(key: ApiKey, layer: 'admin' | 'owner' = 'admin'): 'routingPolicy' | 'ownerRoutingPolicy' {
  return layer === 'owner' && hasOwnerLayer(key) ? 'ownerRoutingPolicy' : 'routingPolicy'
}

async function loadKey(client: PolicyApi, scope: Extract<PeerScope, { kind: 'key' }>): Promise<ApiKey> {
  const key = (await client.keys.list({ workspace: scope.workspaceId })).find((entry) => entry.id === scope.keyId)
  if (!key) throw new Error('That key no longer exists.')
  return key
}

/**
 * Reads the scope's policy from the API, never from a cache: a stale or
 * differently shaped cache entry would otherwise be patched back and wipe
 * the scope's other settings.
 */
export async function loadScopePolicy(client: PolicyApi, scope: PeerScope): Promise<RoutingPolicy | null> {
  switch (scope.kind) {
    case 'gateway': return client.network.gatewayPolicy()
    case 'workspace-org': return (await client.workspaces.get(scope.workspaceId)).orgRoutingPolicy
    case 'workspace': return (await client.workspaces.get(scope.workspaceId)).routingPolicy
    case 'member': {
      const member = (await client.members.list()).find((entry) => entry.id === scope.memberId)
      if (!member) throw new Error('That member no longer exists.')
      return member.routingPolicy
    }
    case 'key': {
      const key = await loadKey(client, scope)
      return (key as unknown as Record<string, RoutingPolicy | null | undefined>)[keyField(key, scope.layer)] ?? null
    }
  }
}

async function saveScopePolicy(client: PolicyApi, scope: PeerScope, policy: RoutingPolicy | null, options?: SaveOptions): Promise<void> {
  // Options only when set, so a plain save is a plain two-argument call.
  const extra = (options?.confirmEmpty || options?.acceptNarrowed ? [options] : []) as [SaveOptions?]
  switch (scope.kind) {
    case 'gateway': await client.network.setGatewayPolicy(policy ?? {}, ...extra); return
    case 'workspace-org': await client.workspaces.update(scope.workspaceId, { orgRoutingPolicy: policy }, ...extra); return
    case 'workspace': await client.workspaces.update(scope.workspaceId, { routingPolicy: policy }, ...extra); return
    case 'member': await client.members.update(scope.memberId, { routingPolicy: policy }, ...extra); return
    case 'key': {
      const field = scope.layer === 'owner' ? keyField(await loadKey(client, scope), 'owner') : 'routingPolicy'
      await client.keys.update(scope.keyId, { [field]: policy }, ...extra); return
    }
  }
}

const canonical = (policy: RoutingPolicy | null | undefined) => JSON.stringify(policy ?? {}, Object.keys(policy ?? {}).sort())

/** Loads the scope's current policy, applies the action and writes the result back (skipped when nothing changes). */
export async function applyPeerActionToScope(
  client: PolicyApi, scope: PeerScope, action: PeerAction, peerId: string, model?: string, options?: SaveOptions,
): Promise<{ before: RoutingPolicy | null; after: RoutingPolicy; changed: boolean }> {
  const before = await loadScopePolicy(client, scope)
  const after = applyPeerAction(before, action, peerId, model)
  const changed = canonical(before) !== canonical(after) || JSON.stringify(before ?? {}) !== JSON.stringify(after)
  if (changed) await saveScopePolicy(client, scope, after, options)
  return { before, after, changed }
}

/** The route-preview query that shows what a scope's requests get, in the open workspace. */
export function previewQueryFor(scope: PeerScope, model: string, workspaceId: string): { model: string; workspace?: string; key?: string; member?: string } {
  if (scope.kind === 'key') return { model, key: scope.keyId, workspace: scope.workspaceId }
  if (scope.kind === 'member') return { model, member: scope.memberId, workspace: workspaceId }
  if (scope.kind === 'gateway') return { model, workspace: workspaceId }
  return { model, workspace: scope.workspaceId }
}

const ACTION_VERBS: Record<Exclude<PeerAction, 'clear'>, string> = { allow: 'Allowed', block: 'Blocked', prefer: 'Preferred' }

export interface PeerOutcome {
  tone: 'success' | 'warning' | 'info'
  text: string
}

/**
 * Says what an Allow / Block / Prefer actually did, from the route preview
 * after the write: an allowed seller can still be excluded by another level
 * (a workspace allow list that lacks it, a price cap, a block above).
 */
export function describePeerOutcome(input: {
  action: Exclude<PeerAction, 'clear'>; name: string; scopeLabel: string; changed: boolean; model: string
  preview: Pick<RoutePreview, 'candidates' | 'modelAllowed'> | null; peerId: string; previewError?: string | null
}): PeerOutcome {
  const { action, name, scopeLabel, changed, model, preview, peerId } = input
  const verb = ACTION_VERBS[action]
  const already = action === 'prefer' ? `already first for ${model}` : `already ${verb.toLowerCase()}`
  const head = changed ? `${verb} ${name} ${action === 'prefer' ? `for ${model} ` : ''}on ${scopeLabel}` : `${name} was ${already} on ${scopeLabel}; nothing changed`
  if (!preview) {
    if (action === 'block') return { tone: changed ? 'success' : 'info', text: `${head}.` }
    return { tone: 'info', text: `${head}. ${input.previewError ? `Could not check whether it can serve: ${input.previewError}` : 'Could not check whether it can serve.'}` }
  }
  const candidate = preview.candidates.find((entry) => samePeerId(entry.peerId, peerId))
  if (action === 'block') {
    if (candidate?.eligible) return { tone: 'warning', text: `${head}, but the route preview still lists it as eligible for ${model}. Reload and check the policy.` }
    return { tone: changed ? 'success' : 'info', text: `${head}.` }
  }
  if (!preview.modelAllowed) return { tone: 'warning', text: `${head}, but ${model} is not an allowed model here, so it still cannot serve it.` }
  if (!candidate) return { tone: 'info', text: `${head}. It does not offer ${model} right now, so the preview cannot show its rank.` }
  if (!candidate.eligible) {
    const reasons = candidate.reasons.length ? candidate.reasons.join('; ') : 'another level excludes it'
    return { tone: 'warning', text: `${head}, but it still cannot serve ${model} here: ${reasons}.` }
  }
  if (action === 'prefer' && candidate.rank !== null && candidate.rank > 1) {
    return { tone: 'warning', text: `${head}, but it ranks #${candidate.rank} for ${model}: a fallback chain on another level comes first.` }
  }
  return { tone: changed ? 'success' : 'info', text: `${head}.${candidate.rank ? ` It ranks #${candidate.rank} for ${model}.` : ''}` }
}
