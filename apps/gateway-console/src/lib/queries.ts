import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ApiClient, type UsageFilter } from '../api'
import type { Workspace } from '../api/types'
import { isDepositPending } from './channels'

/**
 * Query keys. One key holds one shape: the first segment groups a resource
 * (so `invalidateQueries({ queryKey: ['workspaces'] })` refreshes all of
 * them), the second names the shape. Never cache a projection (e.g. only a
 * workspace's routing policy) under a full object's key: select it instead.
 */
export const qk = {
  /** Every query of one resource group, for invalidation. */
  group: (name: 'workspaces' | 'members' | 'keys' | 'requests' | 'routing' | 'presets' | 'channels' | 'invites') => [name] as const,
  me: ['me'] as const,
  authConfig: ['auth-config'] as const,
  status: ['status'] as const,
  update: ['update'] as const,
  settings: ['settings'] as const,
  workspaces: ['workspaces', 'list'] as const,
  workspace: (workspaceId: string) => ['workspaces', 'detail', workspaceId] as const,
  workspaceMembers: (workspaceId: string) => ['workspaces', 'members', workspaceId] as const,
  members: ['members', 'list'] as const,
  invites: ['invites'] as const,
  keys: (filter: object) => ['keys', 'list', filter] as const,
  usage: (filter: object) => ['usage', filter] as const,
  requests: (filter: object) => ['requests', 'list', filter] as const,
  request: (tag: string) => ['requests', 'detail', tag] as const,
  audit: (filter: object) => ['audit', filter] as const,
  wallet: (workspaceId: string) => ['wallet', workspaceId] as const,
  deposits: (workspaceId: string) => ['deposits', workspaceId] as const,
  channels: (workspaceId: string, all: boolean) => ['channels', workspaceId, all] as const,
  /** Authorized-wallet status of every workspace the viewer can open (markers). */
  operators: ['wallet-operators'] as const,
  rewards: (workspaceId: string) => ['rewards', workspaceId] as const,
  chain: ['chain'] as const,
  chatModels: (workspaceId: string) => ['chat-models', workspaceId] as const,
  chatContext: (workspaceId: string) => ['chat-context', workspaceId] as const,
  chatThreads: (workspaceId: string) => ['chat-threads', workspaceId] as const,
  chatThread: (workspaceId: string, threadId: string) => ['chat-thread', workspaceId, threadId] as const,
  peers: ['peers'] as const,
  models: ['models'] as const,
  routers: ['routers'] as const,
  favorites: ['favorites'] as const,
  peerLists: ['peer-lists'] as const,
  gatewayPolicy: ['routing', 'gateway'] as const,
  buyerLimits: ['routing', 'buyer-limits'] as const,
  routePreview: (query: object) => ['routing', 'preview', query] as const,
  presets: (workspaceId: string | null) => ['presets', workspaceId] as const,
  adminTokens: ['admin-tokens'] as const,
}

/** Every resource group a routing-policy change can affect. */
export const POLICY_GROUPS = ['routing', 'workspaces', 'members', 'keys', 'presets'] as const

export function workspaceQuery(workspaceId: string, client: ApiClient = api) {
  return { queryKey: qk.workspace(workspaceId), queryFn: (): Promise<Workspace> => client.workspaces.get(workspaceId) }
}

export function useWorkspace(workspaceId: string, enabled = true) {
  return useQuery({ ...workspaceQuery(workspaceId), enabled })
}

export function usePeers(enabled = true) {
  return useQuery({ queryKey: qk.peers, queryFn: api.network.peers, staleTime: 30_000, enabled })
}

const ROUTERS_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000

/** Peer ids of the routing services that ranked requests in this scope over the last 90 days, most spend first. */
export function useUsedRouters(scope: UsageFilter) {
  return useQuery({
    queryKey: qk.usage({ ...scope, groupBy: 'router', routersUsed: true }),
    queryFn: async () => {
      const report = await api.usage.report({ ...scope, groupBy: 'router', from: Date.now() - ROUTERS_LOOKBACK_MS })
      return report.groups.map((group) => group.group).filter((peerId) => peerId !== '')
    },
    staleTime: 60_000,
  })
}

/** Every model on the network, with the sellers offering it. */
export function useModels(enabled = true) {
  return useQuery({ queryKey: qk.models, queryFn: api.network.models, staleTime: 30_000, enabled })
}

/** Every routing service on the network. An older gateway has no list: no routers, not an error. */
export function useRouters() {
  return useQuery({ queryKey: qk.routers, queryFn: () => api.network.routers().catch(() => []), staleTime: 30_000 })
}

/** The caller's starred model and router ids, oldest first; empty when the gateway keeps none (an older one, or an admin token). */
export function useFavorites() {
  return useQuery({ queryKey: qk.favorites, queryFn: () => api.favorites.list().then((body) => body.models).catch(() => [] as string[]), staleTime: 60_000 })
}

/** Stars or unstars a model or router, showing the change at once and undoing it if the save fails. */
export function useToggleFavorite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, favorite }: { id: string; favorite: boolean }) => (favorite ? api.favorites.add(id) : api.favorites.remove(id)),
    onMutate: async ({ id, favorite }) => {
      await queryClient.cancelQueries({ queryKey: qk.favorites })
      const previous = queryClient.getQueryData<string[]>(qk.favorites)
      queryClient.setQueryData<string[]>(qk.favorites, (current = []) =>
        favorite ? [...current.filter((entry) => entry !== id), id] : current.filter((entry) => entry !== id))
      return { previous }
    },
    onError: (_error, _input, context) => { if (context?.previous) queryClient.setQueryData(qk.favorites, context.previous) },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: qk.favorites }) },
  })
}

export function usePeerLists(enabled = true) {
  return useQuery({ queryKey: qk.peerLists, queryFn: api.network.peerLists, staleTime: 30_000, enabled })
}

export function useWorkspaces() {
  return useQuery({ queryKey: qk.workspaces, queryFn: api.workspaces.list })
}

export function useWorkspaceMembers(workspaceId: string, enabled = true) {
  return useQuery({ queryKey: qk.workspaceMembers(workspaceId), queryFn: () => api.workspaces.members(workspaceId), enabled })
}

export function useMembers(enabled = true) {
  return useQuery({ queryKey: qk.members, queryFn: api.members.list, enabled })
}

export function useInvites() {
  return useQuery({ queryKey: qk.invites, queryFn: api.invites.list })
}

export function useKeys(filter: { workspace?: string; member?: string }, enabled = true) {
  return useQuery({ queryKey: qk.keys(filter), queryFn: () => api.keys.list(filter), enabled })
}

export function usePresets(workspaceId: string, enabled = true) {
  return useQuery({ queryKey: qk.presets(workspaceId), queryFn: () => api.presets.list(workspaceId), enabled })
}

export function useWallet(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: qk.wallet(workspaceId),
    queryFn: () => api.wallet.get(workspaceId),
    enabled,
    // While a payment is moving into the credits, check again until it lands, so nobody has to reload.
    refetchInterval: (query) => (query.state.data && isDepositPending(query.state.data) ? 5_000 : false),
  })
}

export function useGatewayPolicy() {
  return useQuery({ queryKey: qk.gatewayPolicy, queryFn: api.network.gatewayPolicy })
}

export function useBuyerLimits() {
  return useQuery({ queryKey: qk.buyerLimits, queryFn: api.network.buyerLimits })
}

export function useAdminTokens() {
  return useQuery({ queryKey: qk.adminTokens, queryFn: api.adminTokens.list })
}

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: api.auth.me })
}

export function useAuthConfig(enabled = true) {
  return useQuery({ queryKey: qk.authConfig, queryFn: api.auth.config, enabled })
}

export function useStatus() {
  return useQuery({ queryKey: qk.status, queryFn: api.settings.status, refetchInterval: 30_000 })
}

/** Antseed updates (org admins): polls fast while an update runs, so the console notices the restart. */
export function useUpdate(enabled = true) {
  return useQuery({
    queryKey: qk.update,
    queryFn: api.update.get,
    enabled,
    retry: false,
    refetchInterval: (query) => {
      const progress = query.state.data?.progress?.state
      return progress === 'requested' || progress === 'running' ? 2_000 : 10 * 60_000
    },
  })
}

export function useChain(enabled = true) {
  return useQuery({ queryKey: qk.chain, queryFn: api.wallet.chain, staleTime: Infinity, enabled })
}

/** Every model offered on the network, for model pickers. */
export function modelsFromPeers(peers: Array<{ services: Array<{ service: string }> }> | undefined): string[] {
  const models = new Set<string>()
  for (const peer of peers ?? []) for (const service of peer.services) models.add(service.service)
  return [...models].sort()
}
