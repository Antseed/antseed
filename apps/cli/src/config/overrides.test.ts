import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMergePatch, mergePatchBetween, overriddenSettings } from './overrides.js'

test('a merge patch between two configs turns one into the other: changed and removed fields only, lists replaced whole', () => {
  const base = { seller: { maxConcurrentBuyers: 10, restrictedCountries: ['CU', 'IR'], freeTier: { maxRequestsPerAddress: 5, stakeTiers: [{ minPower: 1, multiplier: 2 }] } }, identity: { displayName: 'A' } }
  const edited = { seller: { maxConcurrentBuyers: 10, restrictedCountries: ['CU'], freeTier: { maxRequestsPerAddress: 5 } }, identity: { displayName: 'B' } }
  const patch = mergePatchBetween(base, edited)
  assert.deepEqual(patch, { seller: { restrictedCountries: ['CU'], freeTier: { stakeTiers: null } }, identity: { displayName: 'B' } })
  assert.deepEqual(applyMergePatch(base, patch), edited)
  assert.equal(mergePatchBetween(base, structuredClone(base)), undefined)
  assert.deepEqual(overriddenSettings(patch as Record<string, unknown>).sort(), ['identity.displayName', 'seller.freeTier.stakeTiers', 'seller.restrictedCountries'])
})
