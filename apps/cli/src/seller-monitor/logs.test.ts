import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CHANNEL_KIND, ChannelStore } from '@antseed/node/payments'
import { writeSellerFixture } from './fixture.js'
import { readSellerLogDetail, readSellerLogs } from './logs.js'
import { SellerUsageReader } from './reader.js'

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

test('a one-off request links to its own channel by request id, and one-off pay counts in the totals', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'seller-log-detail-'))
  writeSellerFixture(dataDir, { requests: [{ at: 10_000, sessionId: 's1', service: 'video-1', tokens: 100, costCents: 30, buyer: BUYER, requestId: 'req-1' }] })
  mkdirSync(join(dataDir, 'payments'), { recursive: true })
  const store = new ChannelStore(join(dataDir, 'payments'))
  store.upsertChannel(channel('ch-regular', 8_000, 'active', null) as never)
  store.upsertChannel({ ...channel('ch-one-off', 9_000, 'settled', 11_000), channelKind: CHANNEL_KIND.ONE_OFF, oneOffRequestId: 'req-1', authMax: '300000', tokensDelivered: '300000', settledAmount: '300000', requestCount: 1 } as never)
  store.close()
  const [entry] = readSellerLogs(dataDir).entries
  const detail = readSellerLogDetail(dataDir, entry!.id)!
  assert.deepEqual(detail.channel && [detail.channel.id, detail.channel.oneOff, detail.channel.settledUsd], ['ch-one-off', true, 0.3])
  const usage = await new SellerUsageReader().usage(dataDir, 1)
  assert.equal(usage.channels.total, 2)
  assert.equal(usage.settledUsdc, 0.3)
  assert.equal(usage.deliveredUsdc, 1.67)
})
