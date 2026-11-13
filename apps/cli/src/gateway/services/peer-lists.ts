import { expandPeerLists, normalizePeerId, type RoutingPolicy } from '../../routing-policy/policy.js'
import { badRequest, notFound } from '../console-api/serialize.js'
import { gatewayDefaultPolicy } from '../policy-resolver.js'
import type { GatewayStore, PeerListRecord } from '../store.js'
import { PolicyProblemError, recordAudit, requiredText, type Actor, type ServiceContext } from './context.js'

const MAX_PEERS = 1_000

/** Normalized, de-duplicated peer ids (hex addresses, `0x` optional). */
function cleanPeerIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw badRequest('peerIds must be a list of peer ids')
  const ids = [...new Set((value as string[]).map(normalizePeerId).filter(Boolean))]
  if (ids.length > MAX_PEERS) throw badRequest(`A peer list holds at most ${MAX_PEERS} peers`)
  if (ids.some((id) => !/^[0-9a-f]{1,128}$/.test(id))) throw badRequest('Peer ids are hex addresses')
  return ids
}

function cleanDescription(value: string | null): string | null {
  if (value === null) return null
  if (value.length > 500) throw badRequest('description is longer than 500 characters')
  return value.trim() || null
}

function target(list: PeerListRecord) {
  return { kind: 'peer_list', id: list.id, label: list.name }
}

/** Every stored policy, with where it is set. */
function storedPolicies(store: GatewayStore): Array<{ where: string; policy: RoutingPolicy }> {
  const found: Array<{ where: string; policy: RoutingPolicy | null }> = [{ where: 'gateway default', policy: gatewayDefaultPolicy(store) }]
  for (const workspace of store.listWorkspaces()) {
    found.push({ where: `workspace ${workspace.name} (org policy)`, policy: workspace.orgRoutingPolicy })
    found.push({ where: `workspace ${workspace.name}`, policy: workspace.routingPolicy })
  }
  for (const member of store.listMembers()) found.push({ where: `member ${member.label}`, policy: member.routingPolicy })
  for (const key of store.listKeys()) {
    if (key.status !== 'active') continue
    found.push({ where: `key ${key.label}`, policy: key.routingPolicy })
    found.push({ where: `key ${key.label} (owner)`, policy: key.ownerRoutingPolicy })
  }
  for (const preset of store.listPresets()) found.push({ where: `preset ${preset.slug}`, policy: preset.routingPolicy })
  return found.filter((entry): entry is { where: string; policy: RoutingPolicy } => entry.policy !== null)
}

/**
 * Policies whose allow list would let no seller serve once this list holds
 * `peerIds` (null: the list is deleted) while it lets some serve today.
 */
function policiesLeftEmpty(store: GatewayStore, listId: string, peerIds: string[] | null): string[] {
  const current = (id: string) => store.getPeerList(id)?.peerIds ?? null
  const next = (id: string) => (id === listId ? peerIds : current(id))
  return storedPolicies(store)
    .filter(({ policy }) => [...(policy.allowedPeerLists ?? []), ...(policy.allowedPeerGroups ?? []).flatMap((group) => group.peerLists ?? [])].includes(listId))
    .filter(({ policy }) => expandPeerLists(policy, next).allowedPeerIds?.length === 0 && expandPeerLists(policy, current).allowedPeerIds?.length !== 0)
    .map(({ where }) => where)
}

function emptyAllowError(listName: string, usedBy: string[]): PolicyProblemError {
  return new PolicyProblemError({
    status: 400,
    body: {
      error: {
        code: 'empty_allow_list',
        message: `This leaves no seller allowed for ${usedBy.join(', ')} (they allow only sellers in "${listName}"); send confirmEmpty: true to do it anyway`,
        usedBy,
      },
    },
  })
}

function requirePeerList(ctx: Pick<ServiceContext, 'store'>, id: string): PeerListRecord {
  const list = ctx.store.getPeerList(id)
  if (!list) throw notFound('Peer list')
  return list
}

/** A peer list by id or (case-insensitive) name. */
export function findPeerList(ctx: Pick<ServiceContext, 'store'>, idOrName: string): PeerListRecord {
  const byId = ctx.store.getPeerList(idOrName)
  if (byId) return byId
  const matches = ctx.store.listPeerLists().filter((list) => list.name.toLowerCase() === idOrName.trim().toLowerCase())
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw badRequest(`Several peer lists are named "${idOrName}"; use the list id`)
  throw notFound('Peer list')
}

export function createPeerList(ctx: ServiceContext, actor: Actor, input: { name: string; description?: string | null; peerIds?: unknown }): PeerListRecord {
  const list = ctx.store.createPeerList({
    name: requiredText(input.name, 'name', 100),
    description: cleanDescription(input.description ?? null),
    peerIds: cleanPeerIds(input.peerIds ?? []),
  })
  recordAudit(ctx, actor, 'peer_list.create', target(list), { peerCount: list.peerIds.length })
  return list
}

/** Renames a list or replaces its sellers; refuses to empty a policy's allow list without `confirmEmpty`. */
export function updatePeerList(
  ctx: ServiceContext,
  actor: Actor,
  id: string,
  input: { name?: string; description?: string | null; peerIds?: unknown; confirmEmpty?: boolean },
): PeerListRecord {
  const { store } = ctx
  const before = requirePeerList(ctx, id)
  const description = input.description === undefined ? undefined : cleanDescription(input.description)
  const peerIds = input.peerIds === undefined ? undefined : cleanPeerIds(input.peerIds)
  if (peerIds !== undefined && !input.confirmEmpty) {
    const usedBy = policiesLeftEmpty(store, before.id, peerIds)
    if (usedBy.length > 0) throw emptyAllowError(before.name, usedBy)
  }
  const list = store.updatePeerList(before.id, {
    ...(input.name !== undefined ? { name: requiredText(input.name, 'name', 100) } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(peerIds !== undefined ? { peerIds } : {}),
  })
  const added = list.peerIds.filter((peer) => !before.peerIds.includes(peer))
  const removed = before.peerIds.filter((peer) => !list.peerIds.includes(peer))
  recordAudit(ctx, actor, 'peer_list.update', target(list), {
    ...(list.name !== before.name ? { name: { before: before.name, after: list.name } } : {}),
    ...(added.length ? { added } : {}),
    ...(removed.length ? { removed } : {}),
  })
  return list
}

export function deletePeerList(ctx: ServiceContext, actor: Actor, id: string, options: { confirmEmpty?: boolean } = {}): PeerListRecord {
  const list = requirePeerList(ctx, id)
  if (!options.confirmEmpty) {
    const usedBy = policiesLeftEmpty(ctx.store, list.id, null)
    if (usedBy.length > 0) throw emptyAllowError(list.name, usedBy)
  }
  if (!ctx.store.deletePeerList(list.id)) throw notFound('Peer list')
  recordAudit(ctx, actor, 'peer_list.delete', target(list))
  return list
}
