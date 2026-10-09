import { useQuery } from '@tanstack/react-query'
import { api, type ApiClient } from '../api'
import type { Workspace } from '../api/types'

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
  channels: (workspaceId: string, all: boolean) => ['channels', workspaceId, all] as const,
  /** Authorized-wallet status of every workspace the viewer can open (markers). */
  operators: ['wallet-operators'] as const,
  rewards: (workspaceId: string) => ['rewards', workspaceId] as const,
  chain: ['chain'] as const,
  peers: ['peers'] as const,
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
  return useQuery({ queryKey: qk.wallet(workspaceId), queryFn: () => api.wallet.get(workspaceId), enabled })
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

export function useChain(enabled = true) {
  return useQuery({ queryKey: qk.chain, queryFn: api.wallet.chain, staleTime: Infinity, enabled })
}

/** Every model offered on the network, for model pickers. */
export function modelsFromPeers(peers: Array<{ services: Array<{ service: string }> }> | undefined): string[] {
  const models = new Set<string>()
  for (const peer of peers ?? []) for (const service of peer.services) models.add(service.service)
  return [...models].sort()
}
