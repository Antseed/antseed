import { describe, expect, it } from 'vitest'
import type { PeerList, RoutingPolicy } from '../api/types'
import {
  applyPeerAction, describePolicy, draftToPolicy, DraftError, emptyDraft, moveItem, policyOrNull, policyToDraft, POLICY_TEMPLATES, templatePolicy,
} from './policy'

const A = '0xfa1e000000000000000000000000000000000001'
const B = '0xfa1e000000000000000000000000000000000002'
const C = '0xfa1e000000000000000000000000000000000003'

describe('policy draft round-trip', () => {
  const policies: RoutingPolicy[] = [
    {},
    { allowedPeerIds: [] },
    { allowedPeerIds: [A, B], blockedPeerIds: [C] },
    { minTrustScore: 70, minReputation: 55.5, requireVerified: true },
    { maxInputUsdPerMillion: 1.5, maxOutputUsdPerMillion: 6, maxCachedInputUsdPerMillion: 0.1, maxImageUsdPerImage: 0.04 },
    { preferFreePeers: false, sort: 'latency' },
    { preferFreePeers: true, sort: 'price', allowedModels: ['deepseek-v3.1', 'kimi-k2'] },
    { modelRoutes: { 'deepseek-v3.1': { peerIds: [B, A], strict: true }, 'kimi-k2': { peerIds: [C] } } },
  ]
  for (const policy of policies) {
    it(`round-trips ${JSON.stringify(policy)}`, () => {
      expect(draftToPolicy(policyToDraft(policy))).toEqual(policy)
    })
  }

  it('maps null to an empty draft and back to null', () => {
    expect(policyToDraft(null)).toEqual(emptyDraft())
    expect(policyOrNull(draftToPolicy(emptyDraft()))).toBeNull()
  })

  it('keeps an explicit empty allow list (no seller can serve)', () => {
    const draft = { ...emptyDraft(), allowMode: 'only' as const }
    expect(draftToPolicy(draft)).toEqual({ allowedPeerIds: [] })
  })

  it('keeps peer lists as references and drops deleted ones', () => {
    const lists: PeerList[] = [
      { id: 'pl_1', name: 'Own', description: null, peerIds: [A, C], createdAt: 0 },
      { id: 'pl_2', name: 'Bad', description: null, peerIds: [B], createdAt: 0 },
    ]
    const draft = { ...emptyDraft(), allowMode: 'only' as const, allowedPeerIds: [A, B, A], allowedListIds: ['pl_1'], blockedListIds: ['pl_2', 'pl_missing'] }
    expect(draftToPolicy(draft, lists)).toEqual({ allowedPeerIds: [A, B], allowedPeerLists: ['pl_1'], blockedPeerLists: ['pl_2'] })
    // Lists alone: no explicit ids, so the allow list is the lists' members.
    expect(draftToPolicy({ ...emptyDraft(), allowMode: 'only', allowedListIds: ['pl_1'] }, lists)).toEqual({ allowedPeerLists: ['pl_1'] })
    // Lists not loaded yet: references are kept as they are.
    expect(draftToPolicy({ ...emptyDraft(), blockedListIds: ['pl_missing'] })).toEqual({ blockedPeerLists: ['pl_missing'] })
  })

  it('round-trips list references through the draft', () => {
    const policy = { allowedPeerLists: ['pl_1'], blockedPeerIds: [B], blockedPeerLists: ['pl_2'] }
    const draft = policyToDraft(policy)
    expect(draft.allowMode).toBe('only')
    expect(draft.allowedListIds).toEqual(['pl_1'])
    expect(draft.blockedListIds).toEqual(['pl_2'])
    expect(draftToPolicy(draft)).toEqual(policy)
    expect(describePolicy(policy)).toContain('0 allowed + 1 list')
  })

  it('rejects invalid numbers and duplicate or empty chains', () => {
    expect(() => draftToPolicy({ ...emptyDraft(), minTrustScore: '120' })).toThrow(DraftError)
    expect(() => draftToPolicy({ ...emptyDraft(), maxInputUsdPerMillion: '-1' })).toThrow(/positive/)
    expect(() => draftToPolicy({ ...emptyDraft(), routes: [{ model: 'm', peerIds: [A], strict: false }, { model: 'm', peerIds: [B], strict: false }] })).toThrow(/two fallback/)
    expect(() => draftToPolicy({ ...emptyDraft(), routes: [{ model: 'm', peerIds: [], strict: false }] })).toThrow(/at least one/)
  })

  it('ignores chains without a model', () => {
    expect(draftToPolicy({ ...emptyDraft(), routes: [{ model: '  ', peerIds: [A], strict: false }] })).toEqual({})
  })
})

describe('templates', () => {
  it('has the four starting templates', () => {
    expect(POLICY_TEMPLATES.map((template) => template.id)).toEqual(['cheapest', 'trusted', 'tee', 'own'])
  })
  it('builds each policy', () => {
    expect(templatePolicy('cheapest')).toEqual({ sort: 'price', preferFreePeers: true })
    expect(templatePolicy('trusted')).toEqual({ sort: 'trust', minTrustScore: 70, minReputation: 60 })
    expect(templatePolicy('tee')).toEqual({ requireTee: true })
    expect(templatePolicy('own', [A, A, B])).toEqual({ allowedPeerIds: [A, B] })
  })
})

describe('applyPeerAction', () => {
  it('allow creates an allow list and unblocks', () => {
    expect(applyPeerAction({ blockedPeerIds: [A, B] }, 'allow', A)).toEqual({ allowedPeerIds: [A], blockedPeerIds: [B] })
  })
  it('allow appends to an existing allow list without duplicates (case/0x-insensitive)', () => {
    expect(applyPeerAction({ allowedPeerIds: [A] }, 'allow', A.toUpperCase().replace('0X', ''))).toEqual({ allowedPeerIds: [A.toUpperCase().replace('0X', '')] })
    expect(applyPeerAction({ allowedPeerIds: [A] }, 'allow', B)).toEqual({ allowedPeerIds: [A, B] })
  })
  it('block adds to the block list and removes from the allow list', () => {
    expect(applyPeerAction({ allowedPeerIds: [A, B] }, 'block', A)).toEqual({ allowedPeerIds: [B], blockedPeerIds: [A] })
    expect(applyPeerAction(null, 'block', C)).toEqual({ blockedPeerIds: [C] })
  })
  it('prefer puts the seller first in the model chain and keeps strict', () => {
    const policy: RoutingPolicy = { modelRoutes: { m: { peerIds: [B, A], strict: true } }, blockedPeerIds: [A] }
    expect(applyPeerAction(policy, 'prefer', A, 'm')).toEqual({ modelRoutes: { m: { peerIds: [A, B], strict: true } } })
    expect(() => applyPeerAction(null, 'prefer', A)).toThrow()
  })
  it('clear removes the seller everywhere', () => {
    const policy: RoutingPolicy = { allowedPeerIds: [A, B], blockedPeerIds: [A], modelRoutes: { m: { peerIds: [A] }, n: { peerIds: [A, C] } } }
    expect(applyPeerAction(policy, 'clear', A)).toEqual({ allowedPeerIds: [B], modelRoutes: { n: { peerIds: [C] } } })
  })
  it('does not mutate its input', () => {
    const policy: RoutingPolicy = { allowedPeerIds: [A] }
    applyPeerAction(policy, 'block', A)
    expect(policy).toEqual({ allowedPeerIds: [A] })
  })
})

describe('helpers', () => {
  it('moves items up and down within bounds', () => {
    expect(moveItem(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
  })
  it('describes policies', () => {
    expect(describePolicy(null)).toBe('Inherits')
    expect(describePolicy({})).toBe('Inherits')
    expect(describePolicy({ blockedPeerIds: [A], requireVerified: true, sort: 'price' })).toBe('1 blocked · verified only · lowest price')
  })
})
