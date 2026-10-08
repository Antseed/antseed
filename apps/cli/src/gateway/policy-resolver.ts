import { expandPeerLists, meaningfulPolicy, narrowPolicy, narrowedFields, normalizePolicy, type RoutingPolicy } from '../routing-policy/policy.js'
import type { RoutePreview } from './console-api/types.js'
import type { ApiKeyRecord, GatewayStore, MemberRecord, PresetRecord, WorkspaceRecord } from './store.js'

/** Settings key of the gateway-wide default routing policy. */
export const GATEWAY_ROUTING_SETTING = 'routing.default'

export interface ResolvedPolicy {
  policy: RoutingPolicy
  sources: RoutePreview['sources']
}

export type PolicyLevel = RoutePreview['sources'][number]['level']

export interface PolicyTarget {
  keyId?: string
  workspaceId?: string
  memberId?: string
  presetSlug?: string
  preset?: PresetRecord | null
  /** Records the caller already loaded (the gateway does, once per request), so they are not read again. */
  key?: ApiKeyRecord | null
  workspace?: WorkspaceRecord | null
  member?: MemberRecord | null
}

export function gatewayDefaultPolicy(store: GatewayStore): RoutingPolicy | null {
  return store.getSetting<RoutingPolicy>(GATEWAY_ROUTING_SETTING)
}

/** The levels that apply to a target, top to bottom, with their own (unexpanded) policies. */
function policySources(store: GatewayStore, target: PolicyTarget): RoutePreview['sources'] {
  const key = targetKey(store, target)
  const workspaceId = target.workspaceId ?? key?.workspaceId ?? null
  const memberId = target.memberId ?? key?.ownerMemberId ?? null
  const workspace = loaded(target.workspace, workspaceId, (id) => store.getWorkspace(id))
  const member = loaded(target.member, memberId, (id) => store.getMember(id))
  const preset = targetPreset(store, target, workspaceId)

  const sources: RoutePreview['sources'] = [
    { level: 'buyer', id: null, policy: null },
    { level: 'gateway', id: null, policy: gatewayDefaultPolicy(store) },
  ]
  if (workspace) {
    // Two workspace entries: the org admins' policy, then the workspace
    // admins' own, which can only narrow it.
    sources.push({ level: 'workspace-org', id: workspace.id, policy: workspace.orgRoutingPolicy })
    sources.push({ level: 'workspace', id: workspace.id, policy: workspace.routingPolicy })
  }
  if (member) sources.push({ level: 'member', id: member.id, policy: member.routingPolicy })
  if (key) {
    // The admins' policy for the key, then the owner's own on top of it.
    sources.push({ level: 'key', id: key.id, policy: key.routingPolicy })
    sources.push({ level: 'key-owner', id: key.id, policy: key.ownerRoutingPolicy })
  }
  if (preset) sources.push({ level: 'preset', id: preset.id, policy: preset.routingPolicy })
  return sources
}

function targetKey(store: GatewayStore, target: PolicyTarget): ApiKeyRecord | null {
  if (target.key !== undefined) return target.key
  return target.keyId ? store.getKey(target.keyId) : null
}

function targetPreset(store: GatewayStore, target: PolicyTarget, workspaceId: string | null): PresetRecord | null {
  if (target.preset !== undefined) return target.preset
  return target.presetSlug ? store.findPresetBySlug(target.presetSlug, workspaceId) : null
}

/** The record the caller already loaded when it is the one with this id, else a store read. */
function loaded<T extends { id: string }>(given: T | null | undefined, id: string | null, read: (id: string) => T | null): T | null {
  if (given !== undefined && given?.id === id) return given
  return id ? read(id) : null
}

function peerListLookup(store: GatewayStore): (listId: string) => string[] | null {
  return (listId) => store.getPeerList(listId)?.peerIds ?? null
}

/**
 * Peer lists are expanded per level before narrowing, so allow specs
 * intersect as sets of sellers (a level adding a list never widens the one
 * above it), editing a list applies everywhere it is used, and the buyer
 * only ever sees peer ids.
 */
function combine(store: GatewayStore, sources: RoutePreview['sources']): RoutingPolicy {
  const listPeers = peerListLookup(store)
  let policy: RoutingPolicy = {}
  for (const source of sources) policy = narrowPolicy(policy, source.policy ? expandPeerLists(source.policy, listPeers) : null)
  return normalizePolicy(policy)
}

/**
 * Effective policy for a request or a preview: gateway default → workspace
 * (org admins' policy, then the workspace admins') → member (the key's
 * owner) → key (admins', then the owner's) → preset, each level only
 * narrowing the one above. The buyer applies its own config on top, so the
 * `buyer` source has no policy here. A key implies its workspace and owner
 * unless given.
 */
export function resolvePolicy(store: GatewayStore, target: PolicyTarget): ResolvedPolicy {
  const sources = policySources(store, target)
  return { policy: combine(store, sources), sources }
}

export interface PolicyInputCheck {
  /** The policy at that level once narrowed under every level above it (peer lists expanded). */
  effective: RoutingPolicy
  /** Fields where the sent policy asked for more than the levels above allow (see `narrowedFields`). */
  narrowed: string[]
  /** The sent policy restricts sellers to an allow list that ends up empty: no seller could serve. */
  emptyAllow: boolean
}

/**
 * What a policy sent for one level would amount to: `sent` replaces that
 * level's policy for `target`, and only the levels above it count.
 */
export function checkPolicyInput(store: GatewayStore, target: PolicyTarget, level: PolicyLevel, sent: RoutingPolicy | null): PolicyInputCheck {
  const sources = policySources(store, target)
  const index = sources.findIndex((source) => source.level === level)
  const above = index === -1 ? sources : sources.slice(0, index)
  const parent = combine(store, above)
  if (!sent) return { effective: parent, narrowed: [], emptyAllow: false }
  const expanded = expandPeerLists(sent, peerListLookup(store))
  const effective = normalizePolicy(narrowPolicy(parent, expanded))
  const restrictsSellers = sent.allowedPeerIds !== undefined || sent.allowedPeerLists !== undefined || sent.allowedPeerGroups !== undefined
  return {
    effective,
    narrowed: narrowedFields(expanded, effective),
    emptyAllow: restrictsSellers && effective.allowedPeerIds?.length === 0,
  }
}

/** True when the policy changes nothing about routing (see `meaningfulPolicy`). */
export function isEmptyPolicy(policy: RoutingPolicy): boolean {
  return Object.keys(meaningfulPolicy(policy)).length === 0
}

/** A console answer for policy input that cannot be stored as sent. */
export interface PolicyInputProblem {
  status: 400 | 409
  body: { error: { code: string; message: string } & Record<string, unknown> }
}

/**
 * The 400 `empty_allow_list` / 409 `narrowed` answer for policies (and
 * limits) sent to the console, or null when they can be stored. `checks`
 * name the input field each check belongs to; `narrowedLimits` lists limit
 * fields that ask for more than the layer above allows.
 */
export function policyInputProblem(
  checks: ReadonlyArray<{ field: string; check: PolicyInputCheck }>,
  flags: { confirmEmpty?: boolean; acceptNarrowed?: boolean },
  narrowedLimits: { fields: string[]; effective?: unknown } = { fields: [] },
): PolicyInputProblem | null {
  const empty = checks.filter(({ check }) => check.emptyAllow)
  if (empty.length > 0 && !flags.confirmEmpty) {
    return {
      status: 400,
      body: {
        error: {
          code: 'empty_allow_list',
          message: `${empty.map(({ field }) => field).join(', ')} would let no seller serve; send confirmEmpty: true to save it anyway`,
          fields: empty.map(({ field }) => field),
        },
      },
    }
  }
  const narrowed = checks.filter(({ check }) => check.narrowed.length > 0)
  if ((narrowed.length > 0 || narrowedLimits.fields.length > 0) && !flags.acceptNarrowed) {
    const fields = [...narrowed.flatMap(({ field, check }) => check.narrowed.map((name) => `${field}.${name}`)), ...narrowedLimits.fields]
    return {
      status: 409,
      body: {
        error: {
          code: 'narrowed',
          message: `The levels above allow less than this asks for (${fields.join(', ')}); send acceptNarrowed: true to save it anyway`,
          fields,
          ...(narrowed[0] ? { effectiveRoutingPolicy: narrowed[narrowed.length - 1]!.check.effective } : {}),
          ...(narrowedLimits.fields.length > 0 ? { effectiveLimits: narrowedLimits.effective } : {}),
        },
      },
    }
  }
  return null
}
