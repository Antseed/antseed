import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { ApiKey, Member, RoutingPolicy, Workspace } from '../api/types'
import { applyPeerActionToScope } from './peer-actions'
import { applyPeerAction } from './policy'
import { qk, workspaceQuery } from './queries'

const A = '0xfa1e00000000000000000000000000000000000a'
const B = '0xfa1e00000000000000000000000000000000000b'
const C = '0xfa1e00000000000000000000000000000000000c'

const workspacePolicy: RoutingPolicy = { blockedPeerIds: [B], sort: 'price', minTrustScore: 50, allowedModels: ['kimi-k2'] }

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws_1', name: 'Team', isDefault: false, buyerIdentity: 'team', walletAddress: null,
    limits: { daily: null, weekly: null, monthly: null, total: null },
    routingPolicy: workspacePolicy, orgRoutingPolicy: { requireTee: true }, memberCount: 1, keyCount: 1, createdAt: 0, ...overrides,
  }
}

function fakeApi() {
  const ws = workspace()
  return {
    network: { gatewayPolicy: vi.fn(async () => ({ minTrustScore: 10 })), setGatewayPolicy: vi.fn(async (policy: RoutingPolicy) => policy) },
    workspaces: { get: vi.fn(async () => ws), update: vi.fn(async (_id: string, _input: object) => ws) },
    members: { list: vi.fn(async () => [{ id: 'mem_1', routingPolicy: { sort: 'latency' } } as Member]), update: vi.fn(async () => ({}) as Member) },
    keys: { list: vi.fn(async () => [{ id: 'key_1', routingPolicy: { maxInputUsdPerMillion: 2 } } as ApiKey]), update: vi.fn(async () => ({}) as ApiKey) },
  }
}

describe('Network Allow/Block keeps the rest of the policy (regression: policy wipe)', () => {
  it('reproduces the old bug: a policy cached under the workspace key read back as a workspace', () => {
    // Before the fix Routing cached only `routingPolicy` under ['workspaces', id] while the
    // peer dialog read `.routingPolicy` from the same key: undefined, so the action wiped everything.
    const queryClient = new QueryClient()
    const sharedKey = ['workspaces', 'ws_1']
    queryClient.setQueryData(sharedKey, workspacePolicy)
    const misread = (queryClient.getQueryData(sharedKey) as Workspace | undefined)?.routingPolicy
    const written = applyPeerAction(misread, 'allow', A)
    expect(written).toEqual({ allowedPeerIds: [A] })
    expect(written.sort).toBeUndefined()
  })

  it('caches only full workspaces under the workspace key', async () => {
    const api = fakeApi()
    const queryClient = new QueryClient()
    const data = await queryClient.fetchQuery(workspaceQuery('ws_1', api as never))
    expect(queryClient.getQueryData(qk.workspace('ws_1'))).toEqual(data)
    expect(data.routingPolicy).toEqual(workspacePolicy)
    // Distinct shapes never share a key.
    expect(qk.workspace('ws_1')).not.toEqual(qk.workspaces)
    expect(qk.workspace('ws_1')).not.toEqual(qk.workspaceMembers('ws_1'))
    expect(qk.gatewayPolicy).not.toEqual(qk.routePreview({}))
  })

  it('allow on a workspace loads the current policy and only adds the seller', async () => {
    const api = fakeApi()
    const { after } = await applyPeerActionToScope(api as never, { kind: 'workspace', workspaceId: 'ws_1' }, 'allow', A)
    expect(api.workspaces.get).toHaveBeenCalledWith('ws_1')
    expect(after).toEqual({ ...workspacePolicy, allowedPeerIds: [A] })
    expect(api.workspaces.update).toHaveBeenCalledWith('ws_1', { routingPolicy: after })
  })

  it('block on the org layer writes orgRoutingPolicy and keeps requireTee', async () => {
    const api = fakeApi()
    const { after } = await applyPeerActionToScope(api as never, { kind: 'workspace-org', workspaceId: 'ws_1' }, 'block', C)
    expect(after).toEqual({ requireTee: true, blockedPeerIds: [C] })
    expect(api.workspaces.update).toHaveBeenCalledWith('ws_1', { orgRoutingPolicy: after })
  })

  it('reads members and keys fresh from the API', async () => {
    const api = fakeApi()
    await applyPeerActionToScope(api as never, { kind: 'member', memberId: 'mem_1' }, 'block', A)
    expect(api.members.update).toHaveBeenCalledWith('mem_1', { routingPolicy: { sort: 'latency', blockedPeerIds: [A] } })
    await applyPeerActionToScope(api as never, { kind: 'key', keyId: 'key_1', workspaceId: 'ws_1' }, 'prefer', A, 'kimi-k2')
    expect(api.keys.update).toHaveBeenCalledWith('key_1', { routingPolicy: { maxInputUsdPerMillion: 2, modelRoutes: { 'kimi-k2': { peerIds: [A] } } } })
    await expect(applyPeerActionToScope(api as never, { kind: 'key', keyId: 'gone', workspaceId: 'ws_1' }, 'allow', A)).rejects.toThrow('no longer exists')
  })

  it('gateway scope keeps the existing gateway default', async () => {
    const api = fakeApi()
    await applyPeerActionToScope(api as never, { kind: 'gateway' }, 'block', B)
    expect(api.network.setGatewayPolicy).toHaveBeenCalledWith({ minTrustScore: 10, blockedPeerIds: [B] })
  })
})
