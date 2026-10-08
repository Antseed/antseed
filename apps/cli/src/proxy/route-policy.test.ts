import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buyerConfigReason,
  buyerHardPolicy,
  orderByPolicy,
  pinnedPeerExclusionReasons,
  policyExclusionReasons,
  rankingPreferences,
  secretsMatch,
  type PolicyPeerFacts,
} from './route-policy.js'
import { narrowPolicy, policyAllowsModel } from '../routing-policy/policy.js'

const id = (c: string): string => c.repeat(40)

function facts(overrides: Partial<PolicyPeerFacts> = {}): PolicyPeerFacts {
  return {
    peerId: id('a'),
    trustScore: 80,
    reputation: 80,
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    cachedInputUsdPerMillion: null,
    imageUsdPerImage: null,
    unverifiedReason: null,
    teeCapable: false,
    ...overrides,
  }
}

test('secretsMatch compares in constant time and rejects mismatches', () => {
  assert.equal(secretsMatch('abc', 'abc'), true)
  assert.equal(secretsMatch('abc', 'abd'), false)
  assert.equal(secretsMatch('abc', 'abcd'), false)
})

test('policyExclusionReasons explains every exclusion in plain words', () => {
  assert.deepEqual(policyExclusionReasons({}, facts()), [])
  assert.deepEqual(policyExclusionReasons({ blockedPeerIds: [id('a')] }, facts()), ['blocked'])
  assert.deepEqual(policyExclusionReasons({ allowedPeerIds: [id('b')] }, facts()), ['not in allow list'])
  assert.deepEqual(policyExclusionReasons({ minTrustScore: 90 }, facts()), ['trust 80 below 90'])
  assert.deepEqual(policyExclusionReasons({ minReputation: 85 }, facts()), ['reputation 80 below 85'])
  assert.deepEqual(policyExclusionReasons({ maxInputUsdPerMillion: 0.5 }, facts()), ['input price $1 over cap $0.5'])
  assert.deepEqual(policyExclusionReasons({ maxOutputUsdPerMillion: 1 }, facts()), ['output price $2 over cap $1'])
  assert.deepEqual(policyExclusionReasons({ maxCachedInputUsdPerMillion: 0.1 }, facts()), [], 'no cached price advertised')
  assert.deepEqual(
    policyExclusionReasons({ maxCachedInputUsdPerMillion: 0.1 }, facts({ cachedInputUsdPerMillion: 0.2 })),
    ['cached input price $0.2 over cap $0.1'],
  )
  assert.deepEqual(
    policyExclusionReasons({ maxImageUsdPerImage: 0.02, maxInputUsdPerMillion: 0 }, facts({ imageUsdPerImage: 0.04 })),
    ['image price $0.04 over cap $0.02'],
  )
  assert.deepEqual(
    policyExclusionReasons({ maxInputUsdPerMillion: 5 }, facts({ inputUsdPerMillion: null })),
    ['input price unknown, cap $5'],
  )
  assert.deepEqual(
    policyExclusionReasons({ requireVerified: true }, facts({ unverifiedReason: 'not verified (no supported verifier)' })),
    ['not verified (no supported verifier)'],
  )
})

test('buyer hard limits narrow a gateway policy; routing preferences are not part of them', () => {
  const buyer = buyerHardPolicy({ minPeerReputation: 50, verifierRequired: true })
  assert.deepEqual(buyer, { minReputation: 50, requireVerified: true })
  const effective = narrowPolicy(buyer, { minTrustScore: 5, minReputation: 10, blockedPeerIds: [id('d')], requireVerified: false })
  assert.equal(effective.minTrustScore, 5, 'the gateway decides the trust minimum')
  assert.equal(effective.minReputation, 50)
  assert.equal(effective.requireVerified, true)
  assert.deepEqual(effective.blockedPeerIds, [id('d')])
  assert.deepEqual(buyerHardPolicy({ minPeerReputation: 0 }), {})
})

test('ranking preferences exclude nobody and let the policy decide preferFree', () => {
  const prefs = { preferFreePeers: true, maxInputUsdPerMillion: 25, minTrustScore: 60, allowedPeerIds: [id('a')], blockedPeerIds: [id('b')] }
  assert.deepEqual(rankingPreferences(prefs, {}), { preferFreePeers: true, maxInputUsdPerMillion: 25, minTrustScore: 0, allowedPeerIds: [], blockedPeerIds: [] })
  assert.equal(rankingPreferences(prefs, { preferFreePeers: false }).preferFreePeers, false)
})

test('buyer-limit reasons name their level', () => {
  assert.equal(buyerConfigReason('reputation 30 below 40'), 'buyer config: reputation 30 below 40')
  assert.equal(buyerConfigReason('reputation 30 below buyer minimum 40'), 'buyer config: reputation 30 below 40')
  assert.equal(buyerConfigReason('input price $9 over buyer cap $5'), 'buyer config: input price $9 over cap $5')
  assert.equal(buyerConfigReason('outside buyer pricing/reputation limits'), 'buyer config: outside pricing/reputation limits')
})

type C = { peerId: string; price: number | null; trust: number | null; latency: number | null; cooling?: boolean }
const accessors = {
  peerId: (c: C) => c.peerId,
  totalPrice: (c: C) => c.price,
  trustScore: (c: C) => c.trust,
  latencyMs: (c: C) => c.latency,
  coolingDown: (c: C) => c.cooling === true,
}
const a: C = { peerId: id('a'), price: 5, trust: 70, latency: 300 }
const b: C = { peerId: id('b'), price: 1, trust: 90, latency: null }
const c: C = { peerId: id('c'), price: 0, trust: 50, latency: 100 }
const order = (list: C[]): string[] => list.map((entry) => entry.peerId[0]!)

test('orderByPolicy ranks by each sort mode, keeping the incoming order as balanced', () => {
  assert.deepEqual(order(orderByPolicy([a, b, c], {}, 'm', accessors).ordered), ['a', 'b', 'c'])
  assert.deepEqual(order(orderByPolicy([a, b, c], { sort: 'balanced' }, 'm', accessors).ordered), ['a', 'b', 'c'])
  assert.deepEqual(order(orderByPolicy([a, b, c], { sort: 'price' }, 'm', accessors).ordered), ['c', 'b', 'a'])
  assert.deepEqual(order(orderByPolicy([a, b, c], { sort: 'trust' }, 'm', accessors).ordered), ['b', 'a', 'c'])
  // Unmeasured sellers rank after measured ones.
  assert.deepEqual(order(orderByPolicy([a, b, c], { sort: 'latency' }, 'm', accessors).ordered), ['c', 'a', 'b'])
  assert.deepEqual(order(orderByPolicy([a, b, c], { preferFreePeers: true }, 'm', accessors).ordered), ['c', 'a', 'b'])
  assert.deepEqual(order(orderByPolicy([{ ...c, cooling: true }, a, b], { sort: 'price' }, 'm', accessors).ordered), ['b', 'a', 'c'])
})

test('orderByPolicy applies model route chains, strict and non-strict', () => {
  const loose = orderByPolicy([a, b, c], { modelRoutes: { 'Kimi-K3': { peerIds: [id('c'), id('a')] } } }, 'kimi-k3', accessors)
  assert.deepEqual(order(loose.ordered), ['c', 'a', 'b'])
  assert.equal(loose.excluded.size, 0)
  assert.equal(loose.chainPosition.get(id('a')), 1)

  const strict = orderByPolicy([a, b, c], { modelRoutes: { 'kimi-k3': { peerIds: [id('b'), id('d')], strict: true } } }, 'kimi-k3', accessors)
  assert.deepEqual(order(strict.ordered), ['b'])
  assert.deepEqual([...strict.excluded.keys()].sort(), [id('a'), id('c')])

  const other = orderByPolicy([a, b, c], { modelRoutes: { 'other-model': { peerIds: [id('c')], strict: true } } }, 'kimi-k3', accessors)
  assert.deepEqual(order(other.ordered), ['a', 'b', 'c'])
})

test('pinned peers are refused by strict model routes and allowedModels uses canonical matching', () => {
  const policy = { modelRoutes: { 'kimi-k3': { peerIds: [id('b')], strict: true } } }
  assert.deepEqual(pinnedPeerExclusionReasons(policy, facts(), 'kimi-k3'), ['not in strict route for this model'])
  assert.deepEqual(pinnedPeerExclusionReasons(policy, facts({ peerId: id('b') }), 'kimi-k3'), [])
  assert.equal(policyAllowsModel({ allowedModels: ['Kimi K3'] }, 'kimi-k3'), true)
  assert.equal(policyAllowsModel({ allowedModels: ['gpt-5'] }, 'kimi-k3'), false)
  assert.equal(policyAllowsModel(null, 'kimi-k3'), true)
})

test('requireTee excludes sellers without the TEE capability, independent of verification', () => {
  assert.deepEqual(policyExclusionReasons({ requireTee: true }, facts()), ['no TEE'])
  assert.deepEqual(policyExclusionReasons({ requireTee: true }, facts({ teeCapable: true, unverifiedReason: 'not verified (verification disabled on this buyer)' })), [])
  assert.deepEqual(pinnedPeerExclusionReasons({ requireTee: true }, facts(), 'gpt-5'), ['no TEE'])
})

test('model routes and allowedModels match like the gateway: case, variants, peer@model', () => {
  const policy = narrowPolicy({}, { allowedModels: ['GPT-5.6-sol'], modelRoutes: { 'GPT-5.6-SOL': { peerIds: [id('b')], strict: true } } })
  assert.equal(policyAllowsModel(policy, 'gpt-56-sol'), true)
  assert.equal(policyAllowsModel(policy, `${id('b')}@gpt-5.6-sol`), true)
  assert.deepEqual(pinnedPeerExclusionReasons(policy, facts(), 'gpt-56-sol'), ['not in strict route for this model'])
})
