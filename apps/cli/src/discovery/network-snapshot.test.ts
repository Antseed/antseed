import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BUYER_SNAPSHOT_MAX_AGE_MS, loadBuyerSnapshot } from './network-snapshot.js'

function buyerState(lastSeen: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'buyer-snapshot-'))
  const peer = { peerId: 'd'.repeat(40), providers: ['alpha'], capabilities: ['transport.webrtc.v1'], lastSeen }
  writeFileSync(join(dir, 'buyer.state.json'), JSON.stringify({ state: 'connected', pid: process.pid, discoveredPeers: [peer] }))
  return dir
}

test('a buyer daemon\'s peer list is used only while its peers are recent', async () => {
  assert.equal((await loadBuyerSnapshot(buyerState(Date.now())))?.peers.length, 1)
  // A recycled PID or an idle daemon's old file never serves an old network.
  assert.equal(await loadBuyerSnapshot(buyerState(Date.now() - BUYER_SNAPSHOT_MAX_AGE_MS - 1_000)), null)
})
