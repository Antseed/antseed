import assert from 'node:assert/strict'
import test from 'node:test'
import { nextAuditorProfile } from './profile.js'

const current = { name: 'Acme', iconUri: 'ipfs://icon', url: 'https://acme.example' }

test('keeps the fields that are not given and returns null without any flag', () => {
  assert.equal(nextAuditorProfile(current, {}), null)
  assert.deepEqual(nextAuditorProfile(current, { name: 'Acme Labs' }), { ...current, name: 'Acme Labs' })
  assert.deepEqual(nextAuditorProfile(current, { icon: '' }), { ...current, iconUri: '' })
})

test('rejects profiles the contract would reject', () => {
  assert.throws(() => nextAuditorProfile(current, { icon: 'javascript:alert(1)' }), /https:\/\/ or ipfs:\/\//)
  assert.throws(() => nextAuditorProfile(current, { name: 'x'.repeat(65) }), /longer than 64/)
})
