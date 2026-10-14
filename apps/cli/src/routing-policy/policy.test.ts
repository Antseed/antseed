import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodePolicyHeader,
  encodePolicyHeader,
  expandPeerLists,
  findModelRoute,
  isRoutingPolicy,
  meaningfulPolicy,
  narrowPolicy,
  narrowedFields,
  normalizePolicy,
  policyAllowsModel,
  policyAllowsPeer,
  sameRoutingModel,
} from './policy.js'

const PEER_A = 'a'.repeat(40)
const PEER_B = 'b'.repeat(40)

test('policy header round-trips and rejects malformed input', () => {
  const policy = { allowedPeerIds: [`0x${PEER_A.toUpperCase()}`], sort: 'price' as const }
  assert.deepEqual(decodePolicyHeader(encodePolicyHeader(policy)), { allowedPeerIds: [PEER_A], sort: 'price' })
  assert.equal(decodePolicyHeader('not base64 json'), null)
  assert.equal(decodePolicyHeader(Buffer.from(JSON.stringify({ sort: 'fastest' })).toString('base64url')), null)
  assert.equal(decodePolicyHeader(Buffer.from(JSON.stringify({ maxInputUsdPerMillion: -1 })).toString('base64url')), null)
})

test('narrowPolicy only accumulates restrictions', () => {
  const narrowed = narrowPolicy(
    { allowedPeerIds: [PEER_A, PEER_B], blockedPeerIds: [], minTrustScore: 60, maxInputUsdPerMillion: 5, requireVerified: true },
    { allowedPeerIds: [PEER_A], blockedPeerIds: [PEER_B], minTrustScore: 40, maxInputUsdPerMillion: 10, requireVerified: false, sort: 'latency' },
  )
  assert.deepEqual(narrowed.allowedPeerIds, [PEER_A])
  assert.deepEqual(narrowed.blockedPeerIds, [PEER_B])
  assert.equal(narrowed.minTrustScore, 60)
  assert.equal(narrowed.maxInputUsdPerMillion, 5)
  assert.equal(narrowed.requireVerified, true)
  assert.equal(narrowed.sort, 'latency')
  assert.equal(policyAllowsPeer(narrowed, PEER_B), false)
})

test('peer list references validate, narrow and expand', () => {
  assert.equal(isRoutingPolicy({ allowedPeerLists: ['pl_1'], blockedPeerLists: ['pl_2'] }), true)
  assert.equal(isRoutingPolicy({ allowedPeerLists: 'pl_1' }), false)
  assert.equal(isRoutingPolicy({ blockedPeerLists: [1] }), false)

  const narrowed = narrowPolicy({ allowedPeerLists: ['pl_1', 'pl_2'], blockedPeerLists: ['pl_3'] }, { allowedPeerLists: ['pl_2'], blockedPeerLists: ['pl_4'] })
  assert.deepEqual(narrowed.allowedPeerLists, ['pl_2'])
  assert.deepEqual(narrowed.blockedPeerLists?.sort(), ['pl_3', 'pl_4'])

  const lists: Record<string, string[]> = { pl_own: [PEER_A], pl_bad: [`0x${PEER_B.toUpperCase()}`] }
  const listPeers = (id: string) => lists[id] ?? null
  const expanded = expandPeerLists({ allowedPeerIds: [PEER_B], allowedPeerLists: ['pl_own'], blockedPeerLists: ['pl_bad'], sort: 'price' }, listPeers)
  assert.deepEqual(expanded, { allowedPeerIds: [PEER_B, PEER_A], blockedPeerIds: [PEER_B], sort: 'price' })
  // A deleted list never widens an allow list to "any seller".
  assert.deepEqual(expandPeerLists({ allowedPeerLists: ['pl_gone'] }, listPeers), { allowedPeerIds: [] })
  assert.deepEqual(expandPeerLists({ blockedPeerLists: [] }, listPeers), {})

  // The buyer never accepts unexpanded references.
  assert.equal(decodePolicyHeader(encodePolicyHeader({ allowedPeerLists: ['pl_own'] })), null)
})

const PEER_C = 'c'.repeat(40)

test('one model matcher: case, cosmetic variants and peer@model pins', () => {
  assert.equal(sameRoutingModel('GPT-5.6-sol', 'gpt-56-sol'), true)
  assert.equal(sameRoutingModel(`${PEER_A}@gpt-5.6-sol`, 'GPT-5.6-SOL'), true)
  assert.equal(sameRoutingModel('gpt-5.6-sol', 'gpt-5.6-sol-pro'), false)
  const policy = { allowedModels: ['DeepSeek-V4-Flash'] }
  assert.equal(policyAllowsModel(policy, 'deepseek-v4-flash'), true)
  assert.equal(policyAllowsModel(policy, `${PEER_A}@deepseek-v4-flash`), true)
  assert.equal(policyAllowsModel(policy, 'other'), false)
  assert.equal(policyAllowsModel(policy, null), false)
  assert.equal(policyAllowsModel({}, null), true)
  assert.deepEqual(findModelRoute({ modelRoutes: { 'GPT-5.6-sol': { peerIds: [PEER_A] } } }, 'gpt-56-sol'), { peerIds: [PEER_A] })
})

test('normalizePolicy collapses model route keys that name the same model', () => {
  const normalized = normalizePolicy({
    modelRoutes: {
      'GPT-X': { peerIds: [PEER_A, PEER_B], strict: true },
      'gpt-x': { peerIds: [PEER_C, PEER_B] },
    },
    allowedModels: ['GPT-X', 'gpt-x', ' other '],
  })
  // A later duplicate can't loosen the strict entry.
  assert.deepEqual(normalized.modelRoutes, { 'GPT-X': { peerIds: [PEER_B], strict: true } })
  assert.deepEqual(normalized.allowedModels, ['GPT-X', 'other'])
})

test('narrowPolicy merges model routes by model and never loosens a strict parent route', () => {
  const parent = { modelRoutes: { 'GPT-X': { peerIds: [PEER_A, PEER_B], strict: true } } }

  // A child naming the model differently still hits the parent's route; it can
  // reorder and drop sellers but never add one or drop `strict`.
  const narrowed = narrowPolicy(parent, { modelRoutes: { 'gpt-x': { peerIds: [PEER_C, PEER_B, PEER_A] } } })
  assert.deepEqual(narrowed.modelRoutes, { 'GPT-X': { peerIds: [PEER_B, PEER_A], strict: true } })

  // A child route without sellers keeps the parent's list.
  assert.deepEqual(narrowPolicy(parent, { modelRoutes: { 'gpt-x': { peerIds: [] } } }).modelRoutes, parent.modelRoutes)

  // Only new sellers: nobody may serve, rather than the child's sellers.
  assert.deepEqual(narrowPolicy(parent, { modelRoutes: { 'gpt-x': { peerIds: [PEER_C], strict: false } } }).modelRoutes, {
    'GPT-X': { peerIds: [], strict: true },
  })

  // A non-strict parent route is a preference the child may replace; other models are kept.
  const soft = narrowPolicy(
    { modelRoutes: { 'gpt-x': { peerIds: [PEER_A] }, other: { peerIds: [PEER_B] } } },
    { modelRoutes: { 'GPT-X': { peerIds: [PEER_C], strict: true } } },
  )
  assert.deepEqual(soft.modelRoutes, { 'gpt-x': { peerIds: [PEER_C], strict: true }, other: { peerIds: [PEER_B] } })

  // allowedModels intersect with the same matcher.
  assert.deepEqual(narrowPolicy({ allowedModels: ['GPT-5.6-sol', 'm2'] }, { allowedModels: ['gpt-56-sol'] }).allowedModels, ['GPT-5.6-sol'])
})

test('requireTee is validated and sticky', () => {
  assert.equal(isRoutingPolicy({ requireTee: true }), true)
  assert.equal(isRoutingPolicy({ requireTee: 'yes' }), false)
  assert.equal(narrowPolicy({ requireTee: true }, { requireTee: false }).requireTee, true)
  assert.equal(narrowPolicy({}, { requireTee: true }).requireTee, true)
  assert.equal(narrowPolicy({}, {}).requireTee, undefined)
  assert.deepEqual(decodePolicyHeader(encodePolicyHeader({ requireTee: true })), { requireTee: true })
})

// Regression repros (security review): a lower level must not widen the
// allow list above it by mixing peer ids and peer lists.
test('allow specs combine as one set per level, peer lists included (unexpanded narrowing)', () => {
  const C = 'c'.repeat(40)
  const lists: Record<string, string[]> = { pl_any: [PEER_A, PEER_B, C], pl_small: [PEER_A], L1: [PEER_A], L2: [C] }
  const listPeers = (id: string) => lists[id] ?? null
  const allowed = (parent: Parameters<typeof narrowPolicy>[0], child: Parameters<typeof narrowPolicy>[1]) =>
    expandPeerLists(narrowPolicy(parent, child), listPeers).allowedPeerIds

  // ids + list under ids: the list adds nothing beyond the parent's ids.
  assert.deepEqual(allowed({ allowedPeerIds: [PEER_A] }, { allowedPeerIds: [PEER_A], allowedPeerLists: ['pl_any'] }), [PEER_A])
  // list + ids under a list: the ids add nothing beyond the parent's list.
  assert.deepEqual(allowed({ allowedPeerLists: ['pl_small'] }, { allowedPeerLists: ['pl_small'], allowedPeerIds: [PEER_B] }), [PEER_A])
  // A list under ids, ids under a list: only the overlap.
  assert.deepEqual(allowed({ allowedPeerLists: ['L1'] }, { allowedPeerIds: [C] }), [])
  assert.deepEqual(allowed({ allowedPeerIds: [PEER_A] }, { allowedPeerLists: ['L2'] }), [])
  assert.deepEqual(allowed({ allowedPeerIds: [PEER_A, C] }, { allowedPeerLists: ['L2'] }), [C])
  // Two lists intersect as sets of sellers, not as list ids.
  assert.deepEqual(allowed({ allowedPeerLists: ['pl_any'] }, { allowedPeerLists: ['L2', 'L1'] })?.sort(), [PEER_A, C].sort())
  // Block lists still only add; a child without a block list keeps the parent's.
  assert.deepEqual(narrowPolicy({ blockedPeerIds: [C] }, {}), { blockedPeerIds: [C] })
  assert.deepEqual(narrowPolicy({ blockedPeerLists: ['L2'] }, { allowedModels: ['x'] }), { blockedPeerLists: ['L2'], allowedModels: ['x'] })
  // Plain id narrowing is unchanged; widening ids is impossible.
  assert.deepEqual(narrowPolicy({ allowedPeerIds: [PEER_A] }, { allowedPeerIds: [PEER_A, PEER_B] }).allowedPeerIds, [PEER_A])

  // The combined spec survives being stored and narrowed again, and the buyer refuses it unexpanded.
  const stored = narrowPolicy({ allowedPeerLists: ['L1'] }, { allowedPeerIds: [C, PEER_A], allowedPeerLists: ['L2'] })
  assert.ok(isRoutingPolicy(stored))
  assert.deepEqual(expandPeerLists(narrowPolicy(stored, { allowedPeerLists: ['pl_any'] }), listPeers).allowedPeerIds, [PEER_A])
  assert.equal(decodePolicyHeader(encodePolicyHeader(stored)), null)
  assert.equal(policyAllowsPeer({ allowedPeerGroups: [{ peerIds: [PEER_A] }] }, PEER_B), false)
  assert.equal(isRoutingPolicy({ allowedPeerGroups: [{ peerLists: 'x' }] }), false)
})

test('meaningfulPolicy drops settings that change nothing', () => {
  assert.deepEqual(meaningfulPolicy({ sort: 'balanced', preferFreePeers: false, requireVerified: false, requireTee: false, modelRoutes: {} }), {})
  assert.deepEqual(meaningfulPolicy({ sort: 'price', preferFreePeers: true, allowedPeerIds: [] }), { sort: 'price', preferFreePeers: true, allowedPeerIds: [] })
})

test('narrowedFields names what the levels above did not grant', () => {
  const effective = { allowedPeerIds: [PEER_A], allowedModels: ['m1'], minTrustScore: 50, maxInputUsdPerMillion: 3, requireTee: true }
  assert.deepEqual(narrowedFields({ allowedPeerIds: [PEER_A], allowedModels: ['M1'], minTrustScore: 60, maxInputUsdPerMillion: 2 }, effective), [])
  assert.deepEqual(narrowedFields({ allowedPeerIds: [PEER_A, PEER_B], allowedModels: ['m2'], minTrustScore: 10, maxInputUsdPerMillion: 5, requireTee: false }, effective),
    ['allowedPeerIds', 'allowedModels', 'minTrustScore', 'maxInputUsdPerMillion', 'requireTee'])
  // Leaving a setting out never counts, nor do block lists (they only add).
  assert.deepEqual(narrowedFields({ blockedPeerIds: [PEER_B], sort: 'price' }, effective), [])
  const route = { modelRoutes: { m1: { peerIds: [PEER_A, PEER_B] } } }
  assert.deepEqual(narrowedFields(route, narrowPolicy({ modelRoutes: { m1: { peerIds: [PEER_A], strict: true } } }, route)), ['modelRoutes'])
})
