import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChannelStore } from '@antseed/node/payments'
import { writeSellerFixture } from './fixture.js'
import { readSellerLogDetail, readSellerLogs } from './logs.js'

const BUYER = `fa1e${'0'.repeat(35)}1`

function channel(sessionId: string, reservedAt: number, status: 'active' | 'settled', settledAt: number | null) {
  return {
    sessionId, peerId: BUYER, role: 'seller' as const, sellerEvmAddr: '0xseller', buyerEvmAddr: `0x${BUYER}`, nonce: 1,
    authMax: '5000000', deadline: 0, previousSessionId: '', previousConsumption: '0', tokensDelivered: '1370000', requestCount: 58,
    reservedAt, settledAt, settledAmount: settledAt === null ? null : '1200000', status, createdAt: reservedAt, updatedAt: reservedAt,
  }
}

test('a request in full: receipt, session position and the channel open with that buyer at the time', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-log-detail-'))
  writeSellerFixture(dataDir, { requests: [
    { at: 10_000, sessionId: 's1', service: 'kimi-k3', tokens: 100, costCents: 4, buyer: BUYER },
    { at: 20_000, sessionId: 's1', service: 'kimi-k3', tokens: 100, costCents: 0, buyer: BUYER, statusCode: 429 },
  ] })
  mkdirSync(join(dataDir, 'payments'), { recursive: true })
  const store = new ChannelStore(join(dataDir, 'payments'))
  store.upsertChannel(channel('ch-old', 1_000, 'settled', 5_000) as never)
  store.upsertChannel(channel('ch-now', 8_000, 'active', 9_000) as never)
  store.close()

  const [failed, paid] = readSellerLogs(dataDir).entries
  assert.equal(failed!.statusCode, 429)
  const detail = readSellerLogDetail(dataDir, paid!.id)!
  assert.equal(detail.costUsd, 0.04)
  assert.ok(detail.receipt)
  assert.equal(detail.session.position, 1)
  // The active channel covers the request even though it was partly settled before it.
  assert.deepEqual(detail.channel && { id: detail.channel.id, authorizedUsd: detail.channel.authorizedUsd, deliveredUsd: detail.channel.deliveredUsd }, { id: 'ch-now', authorizedUsd: 5, deliveredUsd: 1.37 })
  assert.equal(readSellerLogDetail(dataDir, failed!.id)!.session.position, 2)
  assert.equal(readSellerLogDetail(dataDir, failed!.id.slice(0, 8))!.id.slice(0, 8), failed!.id.slice(0, 8))
  assert.equal(readSellerLogDetail(dataDir, 'nope'), null)
})
