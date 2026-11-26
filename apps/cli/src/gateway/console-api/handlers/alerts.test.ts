import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { AlertDestinationRecord } from '../../store.js'
import { FakeConsoleAuth, addActiveMember, call, memberPrincipal, startConsole, tempDataDir, testDeps } from '../test-support.js'
import type { AlertDelivery, AlertDestination, AlertDestinationCreated, AlertsConfig, AlertSettings } from '../types.js'
import { registerAlertRoutes } from './alerts.js'

const temp = tempDataDir()
const { store } = temp
const auth = new FakeConsoleAuth()
const tested: AlertDestinationRecord[] = []
let server: { port: number; close: () => Promise<void> }
let base: string

before(async () => {
  const owner = store.createOwner({ label: 'Dana', email: 'dana@example.com' })
  const workspaceId = store.defaultWorkspace().id
  const member = addActiveMember(store, 'Sam', { workspaces: [{ workspaceId, role: 'member' }] })
  auth.as('owner', memberPrincipal(store, owner.id))
  auth.as('member', memberPrincipal(store, member.id))
  base = `/console/api/workspaces/${workspaceId}/alerts`
  server = await startConsole(testDeps(store, temp.dir, {
    alerts: {
      sendTest: async (destination) => {
        tested.push(destination)
        return { ok: false, error: 'The webhook answered HTTP 404.' }
      },
      emailConfigured: () => true,
    },
  }), auth, [registerAlertRoutes])
})

after(async () => {
  await server.close()
  temp.cleanup()
})

test('workspace members who are not admins cannot read or change alerts', async () => {
  assert.equal((await call(server.port, 'GET', base, { who: 'member' })).status, 403)
  assert.equal((await call(server.port, 'POST', `${base}/destinations`, { who: 'member', body: { kind: 'email', label: 'x', target: 'a@example.com', events: ['balance'] } })).status, 403)
})

test('settings round-trip in USD, and a top-up target must be above the threshold', async () => {
  const empty = await call(server.port, 'GET', base, { who: 'owner' })
  assert.equal(empty.status, 200)
  const config = empty.body as AlertsConfig
  assert.deepEqual(config.settings, { lowBalance: null, topupTarget: null, limitWarnPercent: null, repeatMinutes: null })
  assert.equal(config.emailAvailable, true)

  const saved = await call(server.port, 'PUT', `${base}/settings`, { who: 'owner', body: { lowBalanceUsd: '10', topupTargetUsd: '50.5', limitWarnPercent: 80, repeatMinutes: null } })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body as AlertSettings, { lowBalance: '10.000000', topupTarget: '50.500000', limitWarnPercent: 80, repeatMinutes: null })

  const bad = await call(server.port, 'PUT', `${base}/settings`, { who: 'owner', body: { lowBalanceUsd: '10', topupTargetUsd: '5' } })
  assert.equal(bad.status, 400)
  assert.equal((await call(server.port, 'PUT', `${base}/settings`, { who: 'owner', body: { limitWarnPercent: 120 } })).status, 400)
})

test('a webhook shows its signing secret once and its URL masked after', async () => {
  const created = await call(server.port, 'POST', `${base}/destinations`, {
    who: 'owner', body: { kind: 'webhook', label: 'Auto top-up', target: 'https://hooks.example.test/topup?token=abc', events: ['balance'] },
  })
  assert.equal(created.status, 201)
  const { destination, signingSecret } = created.body as AlertDestinationCreated
  assert.match(signingSecret ?? '', /^whsec_/)
  assert.equal(destination.target, 'https://hooks.example.test/…')
  assert.equal(destination.secretHint, `…${signingSecret!.slice(-4)}`)
  assert.equal(store.getAlertDestination(destination.id)!.target, 'https://hooks.example.test/topup?token=abc')

  const listed = (await call(server.port, 'GET', base, { who: 'owner' })).body as AlertsConfig
  assert.equal(JSON.stringify(listed).includes(signingSecret!), false)
  assert.equal(JSON.stringify(listed).includes('token=abc'), false)

  const rotated = (await call(server.port, 'POST', `${base}/destinations/${destination.id}/rotate-secret`, { who: 'owner' })).body as AlertDestinationCreated
  assert.notEqual(rotated.signingSecret, signingSecret)
  assert.equal(store.getAlertDestination(destination.id)!.secret, rotated.signingSecret)

  const tried = await call(server.port, 'POST', `${base}/destinations/${destination.id}/test`, { who: 'owner' })
  assert.deepEqual(tried.body, { ok: false, error: 'The webhook answered HTTP 404.' })
  assert.equal(tested.at(-1)?.id, destination.id)
})

test('telegram needs a bot token and a chat id; the token is kept on edits that leave it out', async () => {
  const missing = await call(server.port, 'POST', `${base}/destinations`, { who: 'owner', body: { kind: 'telegram', label: 'TG', target: '-100123', events: ['limits'] } })
  assert.equal(missing.status, 400)
  const badChat = await call(server.port, 'POST', `${base}/destinations`, { who: 'owner', body: { kind: 'telegram', label: 'TG', target: 'not a chat', botToken: '123456:AAbbccddeeffgghhiijjkkll', events: ['limits'] } })
  assert.equal(badChat.status, 400)

  const created = await call(server.port, 'POST', `${base}/destinations`, {
    who: 'owner', body: { kind: 'telegram', label: 'TG', target: '-100123', botToken: '123456:AAbbccddeeffgghhiijjkkll', events: ['limits', 'gateway'] },
  })
  assert.equal(created.status, 201)
  const { destination, signingSecret } = created.body as AlertDestinationCreated
  assert.equal(signingSecret, null)
  assert.equal(destination.secretHint, '…kkll')

  const edited = await call(server.port, 'PATCH', `${base}/destinations/${destination.id}`, { who: 'owner', body: { label: 'Ops chat', enabled: false } })
  assert.equal(edited.status, 200)
  assert.equal((edited.body as AlertDestination).enabled, false)
  assert.equal(store.getAlertDestination(destination.id)!.secret, '123456:AAbbccddeeffgghhiijjkkll')

  assert.equal((await call(server.port, 'DELETE', `${base}/destinations/${destination.id}`, { who: 'owner' })).status, 200)
  assert.equal(store.getAlertDestination(destination.id), null)
  assert.equal((await call(server.port, 'DELETE', `${base}/destinations/${destination.id}`, { who: 'owner' })).status, 404)
})

test('email validates addresses; the delivery log lists newest first', async () => {
  const bad = await call(server.port, 'POST', `${base}/destinations`, { who: 'owner', body: { kind: 'email', label: 'Mail', target: 'not-an-email', events: ['balance'] } })
  assert.equal(bad.status, 400)
  const noEvents = await call(server.port, 'POST', `${base}/destinations`, { who: 'owner', body: { kind: 'email', label: 'Mail', target: 'ops@example.com', events: [] } })
  assert.equal(noEvents.status, 400)
  const created = (await call(server.port, 'POST', `${base}/destinations`, {
    who: 'owner', body: { kind: 'email', label: 'Mail', target: 'ops@example.com,cfo@example.com', events: ['balance'] },
  })).body as AlertDestinationCreated
  assert.equal(created.destination.target, 'ops@example.com, cfo@example.com')

  const workspaceId = store.defaultWorkspace().id
  store.recordAlertDelivery({ workspaceId, destinationId: created.destination.id, eventId: 'evt_1', eventType: 'balance.low', summary: 'low', ok: false, error: 'x' })
  store.recordAlertDelivery({ workspaceId, destinationId: created.destination.id, eventId: 'evt_1', eventType: 'balance.low', summary: 'low', ok: true, error: null })
  const log = (await call(server.port, 'GET', `${base}/deliveries`, { who: 'owner' })).body as AlertDelivery[]
  assert.deepEqual(log.map((entry) => entry.ok), [true, false])
})
