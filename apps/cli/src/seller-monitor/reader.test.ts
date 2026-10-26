import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeSellerFixture } from './fixture.js'
import { readSellerEventViews, readSellerStatus, resolveSellerDataDir, SellerUsageReader } from './reader.js'

const DAY = 86_400_000
const tempDir = () => mkdtempSync(join(tmpdir(), 'seller-monitor-'))

test('no seller: unavailable, and the gateway does not resolve a data dir', async () => {
  const dir = tempDir()
  assert.deepEqual(await readSellerStatus(dir, '1.0.0'), { available: false })
  assert.deepEqual(await readSellerStatus(null, '1.0.0'), { available: false })
  assert.equal(resolveSellerDataDir(dir, {}), null)
})

test('status reads daemon state: running while fresh, withdrawn models first, gas and alerts', async () => {
  const dir = tempDir()
  const now = 1_800_000_000_000
  writeSellerFixture(dir, {
    state: {
      peerId: '0xabc', provider: 'openai', startedAt: now - 3_600_000, updatedAt: now - 2_000, activeChannels: 3, capacityUsedPercent: 12, notices: [],
      modelHealth: [
        { provider: 'openai', service: 'kimi-k3', advertised: true, consecutiveFailures: 0, lastProbeAt: now, lastStatusCode: null, lastDetail: null },
        { provider: 'openai', service: 'glm-5.3', advertised: false, consecutiveFailures: 4, lastProbeAt: now, lastStatusCode: 402, lastDetail: 'HTTP 402' },
      ],
      gas: { address: '0xabc', depleted: false, balanceEth: 0.03, minBalanceEth: 0.00005, lastCheckedAt: now },
      alerts: { channels: ['telegram'], lastSentAt: null, lastError: null },
    },
  })
  assert.equal(resolveSellerDataDir('/nowhere', { ANTSEED_SELLER_DATA_DIR: dir }), dir)
  const status = await readSellerStatus(dir, '1.0.0', now)
  assert.ok(status.available)
  assert.equal(status.running, true)
  assert.deepEqual(status.models.map((model) => model.service), ['glm-5.3', 'kimi-k3'])
  assert.equal(status.models[0]!.lastStatusCode, 402)
  assert.equal(status.gas?.balanceEth, 0.03)
  assert.deepEqual(status.alerts?.channels, ['telegram'])
  const stale = await readSellerStatus(dir, '1.0.0', now + 60_000)
  assert.ok(stale.available && !stale.running)
})

test('a stopped seller with only its event journal is still available, not running', async () => {
  const dir = tempDir()
  writeSellerFixture(dir, { events: [{ at: 1, kind: 'stopped', severity: 'info', title: 'Seller stopped' }, { at: 2, kind: 'started', severity: 'info', title: 'Seller started' }] })
  const status = await readSellerStatus(dir, '1.0.0')
  assert.ok(status.available && !status.running && status.models.length === 0 && status.gas === null)
  assert.deepEqual((await readSellerEventViews(dir, 10)).map((event) => event.at), [2, 1])
})

test('usage is per UTC day, caches finished days and re-reads today after the TTL', async () => {
  const dir = tempDir()
  const today = 20_000 * DAY
  writeSellerFixture(dir, {
    state: { updatedAt: today },
    requests: [
      { at: today - 2 * DAY + 10, sessionId: 's1', tokens: 100, costCents: 5 },
      { at: today - 2 * DAY + 20, sessionId: 's1', tokens: 50, costCents: 5 },
      { at: today + 1_000, sessionId: 's2', tokens: 10, costCents: 1 },
    ],
  })
  const reader = new SellerUsageReader(60_000)
  const usage = await reader.usage(dir, 3, today + 5_000)
  assert.deepEqual(usage.days.map((day) => [day.day, day.requests, day.tokens, day.sessions, day.revenueUsd]), [
    [today - 2 * DAY, 2, 150, 1, 0.1],
    [today - DAY, 0, 0, 0, 0],
    [today, 1, 10, 1, 0.01],
  ])
  assert.equal(usage.channels.total, 0)

  writeSellerFixture(dir, { requests: [{ at: today + 2_000, sessionId: 's3', tokens: 10, costCents: 1 }, { at: today - 2 * DAY + 30, sessionId: 's1', tokens: 1, costCents: 0 }] })
  assert.equal((await reader.usage(dir, 3, today + 10_000)).days[2]!.requests, 1, 'today is cached inside the TTL')
  const later = await reader.usage(dir, 3, today + 70_000)
  assert.equal(later.days[2]!.requests, 2, 'today is re-read after the TTL')
  assert.equal(later.days[0]!.requests, 2, 'a finished day is never re-read')
})

test('a day last read before midnight is read once more, then kept', async () => {
  const dir = tempDir()
  const today = 20_000 * DAY
  writeSellerFixture(dir, { state: { updatedAt: today }, requests: [{ at: today + 1_000, sessionId: 's1', tokens: 10, costCents: 1 }] })
  const reader = new SellerUsageReader(60_000)
  assert.equal((await reader.usage(dir, 1, today + 5_000)).days[0]!.requests, 1)
  writeSellerFixture(dir, { requests: [{ at: today + 3_600_000, sessionId: 's2', tokens: 10, costCents: 1 }] })
  const next = await reader.usage(dir, 2, today + DAY + 5_000)
  assert.equal(next.days[0]!.requests, 2, 'the completed day gets its final totals')
  writeSellerFixture(dir, { requests: [{ at: today + 7_200_000, sessionId: 's3', tokens: 10, costCents: 1 }] })
  assert.equal((await reader.usage(dir, 2, today + DAY + 120_000)).days[0]!.requests, 2, 'read after it ended, it is final')
})
