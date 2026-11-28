import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import type { SpendFeedState } from '../spend-feed.js'
import { GatewayStore, type AlertDestinationRecord, type AlertEventGroup } from '../store.js'
import type { AlertTransport } from './channels.js'
import { decimalToUsdc } from '../money.js'
import { GatewayAlerts, type AlertWalletBalance } from './engine.js'
import type { AlertEvent } from './events.js'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 10, 12)
const USD = 1_000_000

let dir: string
let store: GatewayStore
let now: number
let sent: Array<{ destination: AlertDestinationRecord; event: AlertEvent }>
let failures: number
let balance: AlertWalletBalance | null
let feed: SpendFeedState
let alerts: GatewayAlerts
let ledgerSeq: number

const workspaceId = () => store.defaultWorkspace().id

function makeAlerts(overrides: Partial<ConstructorParameters<typeof GatewayAlerts>[0]> = {}): GatewayAlerts {
  const transport: AlertTransport = {
    async send(destination, event) {
      if (failures > 0) {
        failures -= 1
        throw new Error('receiver down')
      }
      sent.push({ destination, event })
    },
    emailConfigured: () => false,
  }
  return new GatewayAlerts({
    store,
    transport,
    balance: async () => balance,
    walletAddress: async () => `0x${'11'.repeat(20)}`,
    spendFeedState: () => feed,
    consoleUrl: () => 'https://gateway.example.test',
    emptyRecoveryUsdc: 2 * USD,
    now: () => now,
    balanceIntervalMs: 0,
    spendTrackingGraceMs: 60_000,
    retryDelaysMs: [],
    ...overrides,
  })
}

function destination(events: AlertEventGroup[] = ['balance', 'limits', 'gateway']): AlertDestinationRecord {
  return store.createAlertDestination({ workspaceId: workspaceId(), kind: 'webhook', label: 'Ops', target: 'https://hooks.example.test/x', secret: 'whsec_test', events, enabled: true })
}

function spend(keyId: string, amountUsdc: number): void {
  ledgerSeq += 1
  store.recordLedgerEntry({ kind: 'spend', keyId, buyerIdentity: store.defaultWorkspace().buyerIdentity, amountUsdc, externalRef: `test:${ledgerSeq}`, createdAt: now })
}

/** Lets fire-and-forget deliveries finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

const types = () => sent.map((entry) => entry.event.type)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'antseed-alerts-'))
  now = T0
  store = new GatewayStore(dir, () => now)
  sent = []
  failures = 0
  balance = { available: '50.000000', wallet: '0.000000', stale: false }
  feed = 'reporting'
  ledgerSeq = 0
  alerts = makeAlerts()
})

afterEach(async () => {
  await alerts.stop()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('decimalToUsdc parses the buyer decimal strings, negative included', () => {
  assert.equal(decimalToUsdc('12.5'), 12_500_000)
  assert.equal(decimalToUsdc('-0.100000'), -100_000)
  assert.equal(decimalToUsdc('abc'), null)
  assert.equal(decimalToUsdc('1.1234567'), null)
  assert.equal(decimalToUsdc(null), null)
})

test('low credits alert once, recover once, then alert again on the next drop', async () => {
  destination()
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: 50 * USD, limitWarnPercent: null, repeatMinutes: null })
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), [], 'above the threshold: nothing')

  balance = { available: '3.200000', wallet: '1.000000', stale: false }
  await alerts.tick()
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.low'], 'one alert while it stays low')
  const low = sent[0]!.event
  assert.equal(low.data['available_usd'], '3.200000')
  assert.equal(low.data['suggested_topup_usd'], '46.800000', 'up to the top-up target')
  assert.equal(low.data['wallet_address'], `0x${'11'.repeat(20)}`)
  assert.equal(low.data['console_url'], 'https://gateway.example.test/console/wallet')

  balance = { available: '60.000000', wallet: '0.000000', stale: false }
  await alerts.tick()
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.low', 'balance.ok'])

  balance = { available: '9.000000', wallet: '0.000000', stale: false }
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.low', 'balance.ok', 'balance.low'])
})

test('a stale or unread balance changes nothing', async () => {
  destination()
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: null })
  balance = { available: '1.000000', wallet: null, stale: true }
  await alerts.tick()
  balance = null
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), [])
})

test('nothing opens without a destination for it, so a destination added later still hears of it', async () => {
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: null })
  balance = { available: '1.000000', wallet: null, stale: false }
  destination(['limits'])
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), [])
  assert.equal(store.getAlertIncident(workspaceId(), 'balance.low'), null)

  destination(['balance'])
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.low'])
})

test('an open alert repeats every repeatMinutes', async () => {
  destination()
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: 30 })
  balance = { available: '1.000000', wallet: null, stale: false }
  await alerts.tick()
  now += 29 * 60_000
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.low'])
  now += 2 * 60_000
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.low', 'balance.low'])
})

test('spend limits warn near, alert when reached, and start over in the next period', async () => {
  destination()
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: null, topupTargetUsdc: null, limitWarnPercent: 80, repeatMinutes: null })
  const { key } = store.createKey({ label: 'CI', limits: { daily: 10 * USD, monthly: null, total: null }, expiresAt: null })
  spend(key.id, 7 * USD)
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), [])

  spend(key.id, 1 * USD)
  await alerts.tick()
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['limit.near'])
  assert.equal(sent[0]!.event.data['scope_label'], 'CI')
  assert.equal(sent[0]!.event.data['period'], 'daily')

  spend(key.id, 2 * USD)
  await alerts.tick()
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['limit.near', 'limit.reached'])

  now += DAY
  await alerts.tick()
  await settle()
  assert.deepEqual(store.listAlertIncidents(workspaceId()), [], 'a past period closes quietly')
  spend(key.id, 9 * USD)
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['limit.near', 'limit.reached', 'limit.near'])
})

test('a cap refusing a request alerts at once, and the poll does not repeat it', async () => {
  destination(['limits'])
  const { key } = store.createKey({ label: 'CI', limits: { daily: 5 * USD, monthly: null, total: null }, expiresAt: null })
  spend(key.id, 5 * USD)
  alerts.limitRefused(key, { period: 'daily', limitUsdc: 5 * USD, spentUsdc: 5 * USD, heldUsdc: 0, resetsAt: T0 + DAY, level: 'key' })
  await settle()
  assert.deepEqual(types(), ['limit.reached'])
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['limit.reached'])
})

test('a cap full of requests in flight is not reported as reached', async () => {
  destination(['limits'])
  const { key } = store.createKey({ label: 'CI', limits: { daily: 5 * USD, monthly: null, total: null }, expiresAt: null })
  alerts.limitRefused(key, { period: 'daily', limitUsdc: 5 * USD, spentUsdc: 1 * USD, heldUsdc: 4 * USD, resetsAt: T0 + DAY, level: 'key' })
  await settle()
  assert.deepEqual(types(), [])
})

test('out of credits alerts once and closes with one recovery when credits are back', async () => {
  destination(['balance'])
  const { key } = store.createKey({ label: 'App', limits: { daily: null, monthly: null, total: null }, expiresAt: null })
  balance = { available: '0.010000', wallet: null, stale: false }
  alerts.outOfCredits(key)
  await settle()
  alerts.outOfCredits(key)
  await settle()
  assert.deepEqual(types(), ['balance.empty'])
  assert.equal(sent[0]!.event.severity, 'critical')

  balance = { available: '1.000000', wallet: null, stale: false }
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.empty'], 'under one request\'s hold: still out')

  balance = { available: '25.000000', wallet: null, stale: false }
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.empty', 'balance.ok'])
})

test('out of credits repeats every repeatMinutes while it stays open, without another refused request', async () => {
  destination(['balance'])
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: null, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: 30 })
  const { key } = store.createKey({ label: 'App', limits: { daily: null, monthly: null, total: null }, expiresAt: null })
  balance = { available: '0.010000', wallet: null, stale: false }
  alerts.outOfCredits(key)
  await settle()
  now += 10 * 60_000
  alerts.outOfCredits(key)
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.empty'])

  now += 25 * 60_000
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['balance.empty', 'balance.empty'], 'the poll sends the reminder')

  now += 31 * 60_000
  alerts.outOfCredits(key)
  await settle()
  assert.deepEqual(types(), ['balance.empty', 'balance.empty', 'balance.empty'], 'so does a refused request')
})

test('spend tracking alerts after the grace period, while keys are capped, and recovers', async () => {
  destination(['gateway'])
  alerts = makeAlerts({ anyBudgets: () => true })
  feed = 'unreachable'
  await alerts.tick()
  now += 30_000
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), [], 'within the grace period')
  now += 60_000
  await alerts.tick()
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['spend_tracking.down'])
  feed = 'reporting'
  await alerts.tick()
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), ['spend_tracking.down', 'spend_tracking.ok'])
})

test('a failed delivery is retried and every attempt is logged', async () => {
  alerts = makeAlerts({ retryDelaysMs: [1] })
  const dest = destination(['balance'])
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: null })
  balance = { available: '1.000000', wallet: null, stale: false }
  failures = 1
  await alerts.tick()
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await settle()
  assert.deepEqual(types(), ['balance.low'])
  const log = store.listAlertDeliveries(workspaceId())
  assert.deepEqual(log.map((entry) => entry.ok), [true, false], 'newest first')
  assert.equal(log[1]!.error, 'receiver down')
  assert.equal(log[0]!.eventId, log[1]!.eventId, 'a resend keeps the event id')
  const after = store.getAlertDestination(dest.id)!
  assert.equal(after.lastError, null)
  assert.ok(after.lastSentAt)
})

test('a resend still waiting when its incident closes or opens again is dropped', async () => {
  alerts = makeAlerts({ retryDelaysMs: [30] })
  destination(['balance'])
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: 50 * USD, limitWarnPercent: null, repeatMinutes: null })
  const waitForResends = async () => {
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await settle()
  }

  // Low credits fails to go out; the workspace is topped up before its resend is due.
  balance = { available: '1.000000', wallet: null, stale: false }
  failures = 1
  await alerts.tick()
  await settle()
  balance = { available: '60.000000', wallet: null, stale: false }
  await alerts.tick()
  await waitForResends()
  assert.deepEqual(types(), ['balance.ok'], 'no low-credit alert, and no top-up asked for, after the recovery')

  // Low again; its recovery fails to go out, and credits drop again before the recovery's resend is due.
  balance = { available: '1.000000', wallet: null, stale: false }
  await alerts.tick()
  await settle()
  failures = 1
  balance = { available: '60.000000', wallet: null, stale: false }
  await alerts.tick()
  await settle()
  balance = { available: '2.000000', wallet: null, stale: false }
  await alerts.tick()
  await waitForResends()
  assert.deepEqual(types(), ['balance.ok', 'balance.low', 'balance.low'], 'no recovery after credits dropped again')
})

test('a recovery superseded by the next alert stays dropped after the incident closes again', async () => {
  alerts = makeAlerts({ retryDelaysMs: [30] })
  destination(['balance'])
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: null })
  const low = { available: '1.000000', wallet: null, stale: false }
  const topped = { available: '60.000000', wallet: null, stale: false }
  balance = low
  await alerts.tick()
  await settle()
  // The recovery fails to go out; credits drop and come back again before its resend is due.
  failures = 1
  balance = topped
  await alerts.tick()
  await settle()
  for (const next of [low, topped]) {
    balance = next
    await alerts.tick()
    await settle()
  }
  await new Promise((resolve) => setTimeout(resolve, 60))
  await settle()
  assert.deepEqual(types(), ['balance.low', 'balance.low', 'balance.ok'], 'only the newest recovery')
})

test('a recovery is still resent after polls that find its condition over', async () => {
  alerts = makeAlerts({ retryDelaysMs: [40] })
  destination(['balance'])
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: null })
  balance = { available: '1.000000', wallet: null, stale: false }
  await alerts.tick()
  await settle()
  failures = 1
  balance = { available: '60.000000', wallet: null, stale: false }
  await alerts.tick()
  await settle()
  // Healthy polls before the resend is due.
  await alerts.tick()
  await alerts.tick()
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 70))
  await settle()
  assert.deepEqual(types(), ['balance.low', 'balance.ok'])
})

test('a resend is dropped when its destination stops taking that alert', async () => {
  alerts = makeAlerts({ retryDelaysMs: [30] })
  const dest = destination(['balance'])
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: null })
  balance = { available: '1.000000', wallet: null, stale: false }
  failures = 1
  await alerts.tick()
  await settle()
  store.updateAlertDestination(dest.id, { events: ['limits'] })
  await new Promise((resolve) => setTimeout(resolve, 60))
  await settle()
  assert.deepEqual(types(), [])
  assert.equal(store.listAlertDeliveries(workspaceId()).length, 1, 'only the failed first attempt')
})

test('a disabled destination gets nothing; a test goes to one destination', async () => {
  const off = destination(['balance'])
  store.updateAlertDestination(off.id, { enabled: false })
  store.setAlertSettings(workspaceId(), { lowBalanceUsdc: 10 * USD, topupTargetUsdc: null, limitWarnPercent: null, repeatMinutes: null })
  balance = { available: '1.000000', wallet: null, stale: false }
  await alerts.tick()
  await settle()
  assert.deepEqual(types(), [])
  const result = await alerts.sendTest(off)
  assert.deepEqual(result, { ok: true, error: null })
  assert.deepEqual(types(), ['test'])
})
