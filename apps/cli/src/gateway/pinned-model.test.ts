import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { splitPinnedModel, splitPinnedModelSql } from './pinned-model.js'
import { GatewayStore } from './store.js'

// Obvious fake peer id, never a real one.
const PEER = 'ab'.repeat(20)

test('a pinned model splits into the model and the seller; anything else stays as it is', () => {
  assert.deepEqual(splitPinnedModel(`${PEER}@glm-5.3-flash`), { model: 'glm-5.3-flash', peerId: PEER })
  assert.deepEqual(splitPinnedModel(`0x${PEER.toUpperCase()}@kimi-k3`), { model: 'kimi-k3', peerId: PEER })
  assert.deepEqual(splitPinnedModel('glm-5.3-flash'), { model: 'glm-5.3-flash', peerId: null })
  assert.deepEqual(splitPinnedModel('@preset/coder'), { model: '@preset/coder', peerId: null })
  assert.deepEqual(splitPinnedModel('abc@model'), { model: 'abc@model', peerId: null })
  assert.deepEqual(splitPinnedModel(null), { model: null, peerId: null })
})

test('requests record a pinned model as the model, with the pin as the seller until the buyer reports one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-pinned-'))
  const store = new GatewayStore(dir)
  try {
    const owner = store.createOwner({ label: 'O', email: null })
    const { key } = store.createKey({ label: 'k', workspaceId: store.defaultWorkspace().id, ownerMemberId: owner.id, limits: { daily: null, weekly: null, monthly: null, total: null }, expiresAt: null })
    store.startRequest({ tag: 't1', keyId: key.id, buyerIdentity: 'default', method: 'POST', path: '/v1/chat/completions', model: `${PEER}@glm-5.3-flash`, startedAt: 1 })
    const read = () => store.database.prepare('SELECT model, seller_peer_id AS sellerPeerId FROM gateway_requests WHERE tag = ?').get('t1') as { model: string; sellerPeerId: string | null }
    let row = read()
    assert.equal(row.model, 'glm-5.3-flash')
    assert.equal(row.sellerPeerId, PEER)
    store.recordRequestOutcome('t1', { sellerPeerId: 'cd'.repeat(20) })
    row = read()
    assert.equal(row.sellerPeerId, 'cd'.repeat(20), 'the seller the buyer reports wins')

    // Rows recorded before: the migration's SQL splits them the same way, keeping a reported seller.
    store.database.prepare('UPDATE gateway_requests SET model = ?, seller_peer_id = NULL WHERE tag = ?').run(`0x${PEER}@kimi-k3`, 't1')
    store.database.exec(splitPinnedModelSql('gateway_requests'))
    row = read()
    assert.equal(row.model, 'kimi-k3')
    assert.equal(row.sellerPeerId, PEER)
    store.database.prepare('UPDATE gateway_requests SET model = ? WHERE tag = ?').run('not-a-peer@model', 't1')
    store.database.exec(splitPinnedModelSql('gateway_requests'))
    assert.equal(read().model, 'not-a-peer@model')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
