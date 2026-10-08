import { describe, expect, it, vi } from 'vitest'
import { ConsoleApiError, createApiClient, errorMessage, withConfirm } from '../api/client'
import type { ApiKey, RoutingPolicy, SpendLimits } from '../api/types'
import { clearMaskedValues, endpointOriginChanged, maskedHeaderNames } from './headers'
import { keyEditRights, keyEffective, keyPatch, narrowedSummary, tighterLimits } from './key-layers'
import { applyPeerActionToScope, describePeerOutcome, previewQueryFor } from './peer-actions'
import { hasEmptyAllowList } from './policy'
import { CANCELLED, guardedSave } from './policy-save'

const A = '0xfa1e00000000000000000000000000000000000a'
const B = '0xfa1e00000000000000000000000000000000000b'
const none: SpendLimits = { daily: null, weekly: null, monthly: null, total: null }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key_1', label: 'K', hint: 'h', workspaceId: 'ws_1', ownerMemberId: 'mem_owner', buyerIdentity: 'team', status: 'active',
    limits: none, routingPolicy: null, ownerLimits: none, ownerRoutingPolicy: null, topupEnabled: false, expiresAt: null, createdAt: 0, lastUsedAt: null,
    usage: { requests: 0, spent: '0', spentThisMonth: '0' }, ...overrides,
  }
}

describe('empty allow lists', () => {
  it('detects an allow list that names no seller', () => {
    expect(hasEmptyAllowList({ allowedPeerIds: [] })).toBe(true)
    expect(hasEmptyAllowList({ allowedPeerIds: [A] })).toBe(false)
    expect(hasEmptyAllowList({ blockedPeerIds: [A] })).toBe(false)
    expect(hasEmptyAllowList(null)).toBe(false)
    const lists = [{ id: 'pl_1', name: 'x', description: null, peerIds: [], createdAt: 0 }, { id: 'pl_2', name: 'y', description: null, peerIds: [A], createdAt: 0 }]
    expect(hasEmptyAllowList({ allowedPeerLists: ['pl_1'] }, lists)).toBe(true)
    expect(hasEmptyAllowList({ allowedPeerLists: ['pl_2'] }, lists)).toBe(false)
    // Unknown lists: let the gateway decide.
    expect(hasEmptyAllowList({ allowedPeerLists: ['pl_1'] })).toBe(false)
  })

  it('adds the save flags to bodies, and to the query for the gateway default', async () => {
    expect(withConfirm({ a: 1 })).toEqual({ a: 1 })
    expect(withConfirm({ a: 1 }, { confirmEmpty: true, acceptNarrowed: true })).toEqual({ a: 1, confirmEmpty: true, acceptNarrowed: true })
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json(200, {}))
    await createApiClient(fetch).network.setGatewayPolicy({ allowedPeerIds: [] }, { confirmEmpty: true })
    expect(fetch.mock.calls[0]![0]).toBe('/console/api/routing?confirmEmpty=1')
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ allowedPeerIds: [] })
  })
})

describe('guarded policy saves', () => {
  it('asks before sending a known-empty allow list, and stops when declined', async () => {
    const send = vi.fn(async () => 'ok')
    expect(await guardedSave(true, send, async () => false)).toBe(CANCELLED)
    expect(send).not.toHaveBeenCalled()
    expect(await guardedSave(true, send, async () => true)).toBe('ok')
    expect(send).toHaveBeenCalledWith({ confirmEmpty: true })
  })

  it('retries after 400 empty_allow_list and 409 narrowed once each, with the user’s consent', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new ConsoleApiError(400, 'empty_allow_list', 'empty'))
      .mockRejectedValueOnce(new ConsoleApiError(409, 'narrowed', 'less', { fields: ['ownerRoutingPolicy.allowedPeerIds'] }))
      .mockResolvedValueOnce('saved')
    const questions: string[] = []
    const result = await guardedSave(false, send, async (question) => { questions.push(question.kind); return true })
    expect(result).toBe('saved')
    expect(questions).toEqual(['empty', 'narrowed'])
    expect(send.mock.calls.map((call) => call[0])).toEqual([{}, { confirmEmpty: true }, { confirmEmpty: true, acceptNarrowed: true }])
  })

  it('does not loop on a repeated refusal or swallow other errors', async () => {
    const narrowed = new ConsoleApiError(409, 'narrowed', 'less')
    await expect(guardedSave(false, vi.fn().mockRejectedValue(narrowed), async () => true)).rejects.toBe(narrowed)
    const other = new ConsoleApiError(403, 'forbidden', 'no')
    await expect(guardedSave(false, vi.fn().mockRejectedValue(other), async () => true)).rejects.toBe(other)
  })
})

describe('key layers', () => {
  it('keeps the error body as details', async () => {
    const fetch = vi.fn(async () => json(409, { error: { code: 'narrowed', message: 'less', fields: ['limits.daily'], effectiveLimits: none } }))
    const error = await createApiClient(fetch).keys.update('key_1', { ownerLimits: none }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(ConsoleApiError)
    expect((error as ConsoleApiError).details['fields']).toEqual(['limits.daily'])
  })

  it('combines the two layers into what applies', () => {
    expect(tighterLimits({ ...none, daily: '5.000000', monthly: '10' }, { ...none, daily: '2', weekly: '7' })).toEqual({ daily: '2', weekly: '7', monthly: '10', total: null })
    const effective = keyEffective(key({ routingPolicy: { allowedPeerIds: [A, B] }, ownerRoutingPolicy: { allowedPeerIds: [B] } }))
    expect(effective.policy.allowedPeerIds).toEqual([B])
  })

  it('sends only what the caller may change', () => {
    const form = { label: 'K', expiresAt: null, topupEnabled: true, adminLimits: none, adminPolicy: { sort: 'price' } as RoutingPolicy, ownerLimits: none, ownerPolicy: { requireTee: true } as RoutingPolicy }
    const owner = keyEditRights(key(), { memberId: 'mem_owner', workspaceAdmin: false })
    expect(keyPatch(owner, key(), form)).toEqual({ label: 'K', ownerLimits: none, ownerRoutingPolicy: { requireTee: true } })
    const admin = keyEditRights(key(), { memberId: 'mem_admin', workspaceAdmin: true })
    expect(keyPatch(admin, key(), form)).toEqual({ label: 'K', limits: none, routingPolicy: { sort: 'price' }, topupEnabled: true })
    const adminOwner = keyEditRights(key(), { memberId: 'mem_owner', workspaceAdmin: true })
    expect(keyPatch(adminOwner, key(), form)).toMatchObject({ routingPolicy: { sort: 'price' }, ownerRoutingPolicy: { requireTee: true } })
    // Older gateways without the owner layer: the owner writes the single layer.
    const legacyKey = key()
    delete (legacyKey as Partial<ApiKey>).ownerRoutingPolicy
    const legacy = keyEditRights(legacyKey, { memberId: 'mem_owner', workspaceAdmin: false })
    expect(keyPatch(legacy, legacyKey, form)).toEqual({ label: 'K', limits: none, routingPolicy: { requireTee: true } })
  })

  it('explains a narrowed answer', () => {
    const lines = narrowedSummary({ fields: ['ownerRoutingPolicy.allowedPeerIds', 'ownerLimits.daily'], effectiveRoutingPolicy: { allowedPeerIds: [A] }, effectiveLimits: { ...none, daily: '2' } })
    expect(lines[0]).toBe('Narrowed by the levels above: allowed sellers, daily limit.')
    expect(lines[1]).toContain('1 allowed')
    expect(lines[2]).toContain('/day')
  })
})

describe('peer actions on key layers and their outcome', () => {
  function fakeApi(stored: ApiKey) {
    return {
      network: { gatewayPolicy: vi.fn(), setGatewayPolicy: vi.fn() },
      workspaces: { get: vi.fn(), update: vi.fn() },
      members: { list: vi.fn(), update: vi.fn() },
      keys: { list: vi.fn(async () => [stored]), update: vi.fn(async () => stored) },
    }
  }

  it('an owner writes their own layer, and an unchanged policy is not written', async () => {
    const api = fakeApi(key({ routingPolicy: { allowedPeerIds: [A] }, ownerRoutingPolicy: { sort: 'price' } }))
    const scope = { kind: 'key' as const, keyId: 'key_1', workspaceId: 'ws_1', layer: 'owner' as const }
    const result = await applyPeerActionToScope(api as never, scope, 'allow', B)
    expect(result.changed).toBe(true)
    expect(api.keys.update).toHaveBeenCalledWith('key_1', { ownerRoutingPolicy: { sort: 'price', allowedPeerIds: [B] } })
    const unchanged = fakeApi(key({ routingPolicy: { allowedPeerIds: [A] } }))
    const again = await applyPeerActionToScope(unchanged as never, { ...scope, layer: 'admin' }, 'allow', A)
    expect(again.changed).toBe(false)
    expect(unchanged.keys.update).not.toHaveBeenCalled()
  })

  it('previews the scope that was changed', () => {
    expect(previewQueryFor({ kind: 'key', keyId: 'k', workspaceId: 'ws_1' }, 'm', 'ws_2')).toEqual({ model: 'm', key: 'k', workspace: 'ws_1' })
    expect(previewQueryFor({ kind: 'member', memberId: 'mem' }, 'm', 'ws_2')).toEqual({ model: 'm', member: 'mem', workspace: 'ws_2' })
    expect(previewQueryFor({ kind: 'gateway' }, 'm', 'ws_2')).toEqual({ model: 'm', workspace: 'ws_2' })
  })

  it('says when an allowed seller still cannot serve', () => {
    const candidate = (eligible: boolean, reasons: string[] = [], rank: number | null = null) => ({
      peerId: A, displayName: null, rank, eligible, reasons, inputUsdPerMillion: null, outputUsdPerMillion: null, trustScore: null,
    })
    const base = { action: 'allow' as const, name: 'Alpha', scopeLabel: 'key “K”', changed: true, model: 'm', peerId: A }
    const blocked = describePeerOutcome({ ...base, preview: { modelAllowed: true, candidates: [candidate(false, ['not in the workspace allow list'])] } })
    expect(blocked.tone).toBe('warning')
    expect(blocked.text).toBe('Allowed Alpha on key “K”, but it still cannot serve m here: not in the workspace allow list.')
    const ok = describePeerOutcome({ ...base, preview: { modelAllowed: true, candidates: [candidate(true, [], 1)] } })
    expect(ok).toEqual({ tone: 'success', text: 'Allowed Alpha on key “K”. It ranks #1 for m.' })
    const same = describePeerOutcome({ ...base, changed: false, preview: { modelAllowed: true, candidates: [candidate(true, [], 2)] } })
    expect(same.tone).toBe('info')
    expect(same.text).toContain('already allowed')
    const prefer = describePeerOutcome({ ...base, action: 'prefer', preview: { modelAllowed: true, candidates: [candidate(true, [], 3)] } })
    expect(prefer.tone).toBe('warning')
    const unknown = describePeerOutcome({ ...base, preview: null, previewError: 'buyer down' })
    expect(unknown.tone).toBe('info')
    expect(unknown.text).toContain('buyer down')
  })
})

describe('OTLP header re-entry and error copy', () => {
  it('finds and clears masked values when the endpoint origin changes', () => {
    const text = 'Authorization: ••••\nX-Team: blue'
    expect(maskedHeaderNames(text)).toEqual(['Authorization'])
    expect(clearMaskedValues(text)).toBe('Authorization: \nX-Team: blue')
    expect(endpointOriginChanged('https://a.example.com/v1/traces', 'https://a.example.com/other')).toBe(false)
    expect(endpointOriginChanged('https://a.example.com/v1/traces', 'https://b.example.com/v1/traces')).toBe(true)
    expect(endpointOriginChanged(null, 'https://b.example.com')).toBe(false)
  })

  it('uses the server message where it carries specifics (hours left) and clear copy elsewhere', () => {
    expect(errorMessage(new ConsoleApiError(403, 'operator_too_new', 'try again in about 5 hours'))).toBe('try again in about 5 hours')
    expect(errorMessage(new ConsoleApiError(409, 'last_credential', 'x'))).toContain('only sign-in method')
    expect(errorMessage(new ConsoleApiError(403, 'session_required', 'x'))).toContain('Management tokens cannot')
    expect(errorMessage(new ConsoleApiError(403, 'reauth_other_credential', 'x'))).toContain('different passkey or wallet')
    expect(errorMessage(new ConsoleApiError(403, 'access_reauth_required', 'x'))).toContain('Cloudflare Access')
  })
})
