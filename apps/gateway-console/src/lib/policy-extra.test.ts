import { describe, expect, it } from 'vitest'
import type { Peer } from '../api/types'
import {
  applyPeerAction, blockEmptiesAllowList, describePolicy, draftToPolicy, emptyDraft, mergeTemplate, policyToDraft, templateConflicts,
  templateDraft, templatePolicy,
} from './policy'
import { combinePolicies, hasReputationData, matchingPeers } from './policy-match'

const A = '0xfa1e00000000000000000000000000000000000a'
const B = '0xfa1e00000000000000000000000000000000000b'

function peer(id: string, overrides: Partial<Peer> = {}): Peer {
  return {
    peerId: id, displayName: null, trustScore: 80, reputationScore: null, verified: false, tee: false, stakeAnts: null, usageShareBps: null,
    washFlagged: false, lastSeen: null, health: { failureStreak: 0, coolingDownUntil: null }, latencyMsP50: null, requests24h: 0,
    services: [{ provider: 'p', service: 'kimi-k2', inputUsdPerMillion: 1, outputUsdPerMillion: 3, cachedInputUsdPerMillion: null, categories: [] }],
    ...overrides,
  }
}

describe('requireTee', () => {
  it('round-trips through the draft and describes as TEE only', () => {
    const draft = policyToDraft({ requireTee: true })
    expect(draft.requireTee).toBe(true)
    expect(draftToPolicy(draft)).toEqual({ requireTee: true })
    expect(describePolicy({ requireTee: true })).toBe('TEE only')
  })
})

describe('templates merge into the draft', () => {
  it('keeps unrelated settings and only reports real conflicts', () => {
    const draft = { ...emptyDraft(), blockedPeerIds: [A], maxInputUsdPerMillion: '2' }
    const tee = templateDraft(templatePolicy('tee'))
    expect(templateConflicts(draft, tee)).toEqual([])
    expect(draftToPolicy(mergeTemplate(draft, tee))).toEqual({ blockedPeerIds: [A], requireTee: true, maxInputUsdPerMillion: 2 })
  })
  it('flags fields the template would overwrite', () => {
    const draft = { ...emptyDraft(), sort: 'latency' as const, minTrustScore: '90' }
    expect(templateConflicts(draft, templateDraft(templatePolicy('trusted')))).toEqual(['minimum trust', 'sort order'])
    expect(templateConflicts({ ...emptyDraft(), sort: 'trust' as const }, templateDraft(templatePolicy('trusted')))).toEqual([])
  })
})

describe('blocking the only allowed seller', () => {
  it('drops an emptied allow list instead of leaving "no seller"', () => {
    expect(blockEmptiesAllowList({ allowedPeerIds: [A] }, A)).toBe(true)
    expect(blockEmptiesAllowList({ allowedPeerIds: [A, B] }, A)).toBe(false)
    expect(blockEmptiesAllowList({ allowedPeerIds: [A], allowedPeerLists: ['pl'] }, A)).toBe(false)
    expect(applyPeerAction({ allowedPeerIds: [A], sort: 'price' }, 'block', A)).toEqual({ blockedPeerIds: [A], sort: 'price' })
  })
})

describe('policy matching', () => {
  const peers = [peer(A, { tee: true, reputationScore: 70 }), peer(B)]
  it('counts sellers left by the combined policy', () => {
    expect(matchingPeers({ requireTee: true }, peers)).toHaveLength(1)
    expect(matchingPeers(combinePolicies({ requireTee: true }, { blockedPeerIds: [A] }), peers)).toHaveLength(0)
    expect(matchingPeers({ maxInputUsdPerMillion: 0.5 }, peers)).toHaveLength(0)
    expect(matchingPeers({ allowedPeerLists: ['own'] }, peers, [{ id: 'own', name: 'Own', description: null, peerIds: [B], createdAt: 0 }])).toEqual([peers[1]])
  })
  it('narrows like the gateway: allow lists intersect, caps take the lower', () => {
    expect(combinePolicies({ allowedPeerIds: [A, B], maxInputUsdPerMillion: 3 }, { allowedPeerIds: [B], maxInputUsdPerMillion: 5 }))
      .toEqual({ allowedPeerIds: [B], maxInputUsdPerMillion: 3 })
  })
  it('knows when the network has reputation data', () => {
    expect(hasReputationData(peers)).toBe(true)
    expect(hasReputationData([peer(B)])).toBe(false)
    expect(hasReputationData(undefined)).toBe(false)
  })
})

describe('policyChips', () => {
  it('summarises each rule as a short chip', async () => {
    const { policyChips } = await import('./policy')
    expect(policyChips(null)).toEqual([])
    expect(policyChips({})).toEqual([])
    expect(policyChips({
      allowedPeerIds: ['a', 'b', 'c'], requireTee: true, maxInputUsdPerMillion: 2, sort: 'price', preferFreePeers: true,
    })).toEqual(['Allow 3 sellers', 'TEE only', '≤ $2/M in', 'Sort: price', 'Free sellers first'])
    expect(policyChips({ allowedPeerIds: [], allowedPeerLists: ['l1'] })).toEqual(['Allow 1 list'])
    expect(policyChips({ allowedPeerIds: [] })).toEqual(['No seller allowed'])
    expect(policyChips({ blockedPeerIds: ['x'], blockedPeerLists: ['l1', 'l2'] })).toEqual(['Block 1 seller + 2 lists'])
    expect(policyChips({ allowedModels: ['m'], modelRoutes: { m: { peerIds: ['a'] } }, minTrustScore: 70 })).toEqual(['Trust ≥ 70', '1 model', '1 fallback chain'])
  })
})
