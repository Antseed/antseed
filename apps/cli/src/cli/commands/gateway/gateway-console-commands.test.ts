import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, afterEach, before, beforeEach, describe } from 'node:test'
import { Command } from 'commander'
import { AuthDb } from '../../../gateway/auth/db.js'
import { startFakeBuyer, type FakeBuyer } from '../../../gateway/console-api/handlers/network-test-helpers.js'
import { addActiveMember } from '../../../gateway/console-api/test-support.js'
import { GatewayStore, type MemberRecord } from '../../../gateway/store.js'
import { decodePolicyHeader, GATEWAY_CONTROL_HEADER, GATEWAY_CONTROL_SECRET_FILE, ROUTING_POLICY_HEADER } from '../../../routing-policy/policy.js'
import { followRequests } from './activity.js'
import { registerGatewayCommands } from './index.js'
import { gatewayCliRuntime } from './shared.js'

// Never ask a buyer that may be running on this machine; tests that need one inject it.
gatewayCliRuntime.buyerAddresses = async () => null

const PEER_A = 'aa'.repeat(20)
const PEER_B = 'bb'.repeat(20)

let dataDir: string
let configPath: string
let buyer: FakeBuyer
let restarts = 0

async function run(...args: string[]): Promise<string> {
  const program = new Command()
  program.exitOverride().option('--data-dir <path>').option('--config <path>')
  registerGatewayCommands(program)
  const lines: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')) }
  try {
    await program.parseAsync(['node', 'antseed', '--data-dir', dataDir, '--config', configPath, 'gateway', ...args])
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

async function runJson<T = Record<string, unknown>>(...args: string[]): Promise<T> {
  return JSON.parse(await run(...args, '--json')) as T
}

function withStore<T>(fn: (store: GatewayStore) => T): T {
  const store = new GatewayStore(dataDir)
  try {
    return fn(store)
  } finally {
    store.close()
  }
}

function activeMember(label: string, orgRole: 'owner' | 'admin' | 'member' = 'member'): MemberRecord {
  return withStore((store) => addActiveMember(store, label, { orgRole, email: `${label.toLowerCase()}@example.test` }))
}

function auditActions(action?: string): string[] {
  return withStore((store) => store.listAudit({ ...(action ? { action } : {}), limit: 500 }).entries.map((entry) => entry.action))
}

before(async () => {
  buyer = await startFakeBuyer({
    'GET /_antseed/peers': () => ({
      body: {
        ok: true,
        peers: [
          { peerId: PEER_A, displayName: 'Seller A', providers: ['p'], capabilities: ['verifier.antseed-verifier'], trust: { score: 72 }, providerPricing: { p: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'open-model-a': {} } } } },
          { peerId: PEER_B, displayName: 'Seller B', providers: ['p'], providerPricing: { p: { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 4 }, services: { 'open-model-b': {} } } } },
        ],
      },
    }),
    'GET /_antseed/route-preview': (request) => ({
      body: {
        model: new URL(request.url, 'http://x').searchParams.get('model'),
        candidates: [
          { peerId: PEER_A, displayName: null, rank: 1, eligible: true, reasons: ['cheapest'], inputUsdPerMillion: 1, outputUsdPerMillion: 2, trustScore: 72 },
          { peerId: PEER_B, displayName: null, rank: null, eligible: false, reasons: ['below min trust'], inputUsdPerMillion: 3, outputUsdPerMillion: 4, trustScore: 10 },
        ],
      },
    }),
    'GET /_antseed/balances': () => ({ body: { available: '0', reserved: '0', walletUsdc: '0' } }),
    'POST /_antseed/restart': () => {
      restarts += 1
      return { status: 202, body: { ok: true } }
    },
  })
})

after(async () => {
  await buyer.close()
})

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-gateway-console-cli-'))
  configPath = join(dataDir, 'config.json')
  writeFileSync(configPath, `${JSON.stringify({ buyer: { proxyPort: buyer.port } }, null, 2)}\n`)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('gateway workspace (console parity)', () => {
  test('show, update, policy, members and delete', async () => {
    const created = await runJson<{ id: string }>('workspace', 'create', '--name', 'Lab', '--identity', 'default')
    const bob = activeMember('Bob')

    const updated = await runJson<{ name: string; limitsUsd: Record<string, string | null> }>('workspace', 'update', 'Lab', '--name', 'Lab 2', '--weekly-limit', '40')
    assert.equal(updated.name, 'Lab 2')
    assert.equal(updated.limitsUsd['weekly'], '40.000000')
    await assert.rejects(run('workspace', 'update', 'Lab 2'), /Nothing to change/)

    await run('workspace', 'policy', 'set', 'Lab 2', '--layer', 'org', '--min-trust', '30')
    await run('workspace', 'policy', 'set', 'Lab 2', '--allow-model', 'open-model-a', '--sort', 'price')
    const policy = await runJson<{ orgRoutingPolicy: unknown; routingPolicy: unknown; effective: Record<string, unknown> }>('workspace', 'policy', 'show', 'Lab 2')
    assert.deepEqual(policy.orgRoutingPolicy, { minTrustScore: 30 })
    assert.deepEqual(policy.routingPolicy, { allowedModels: ['open-model-a'], sort: 'price' })
    assert.equal(policy.effective['minTrustScore'], 30)
    // Asking for less trust than the org policy requires is narrowed.
    await assert.rejects(run('workspace', 'policy', 'set', 'Lab 2', '--min-trust', '10'), /--accept-narrowed/)
    await run('workspace', 'policy', 'set', 'Lab 2', '--min-trust', '10', '--merge', '--accept-narrowed')
    await run('workspace', 'policy', 'clear', 'Lab 2', '--layer', 'org')
    withStore((store) => {
      const record = store.getWorkspace(created.id)!
      assert.equal(record.orgRoutingPolicy, null)
      assert.deepEqual(record.routingPolicy, { allowedModels: ['open-model-a'], sort: 'price', minTrustScore: 10 })
    })

    await run('workspace', 'member', 'add', 'Lab 2', 'bob@example.test')
    await run('workspace', 'member', 'role', 'Lab 2', bob.id, 'admin')
    assert.deepEqual(await runJson('workspace', 'member', 'list', 'Lab 2'), [{ memberId: bob.id, label: 'Bob', email: 'bob@example.test', status: 'active', role: 'admin' }])
    assert.match(await run('workspace', 'show', 'Lab 2'), /Bob <bob@example.test>\s+admin/)
    await run('key', 'create', '--label', 'bob-key', '--workspace', 'Lab 2', '--owner', bob.id)
    await assert.rejects(run('workspace', 'delete', 'Lab 2', '--buyer-port', String(buyer.port)), /Revoke this workspace's keys first/)
    assert.match(await run('workspace', 'member', 'remove', 'Lab 2', bob.id), /revoked 1 key/)
    await run('workspace', 'delete', 'Lab 2')
    withStore((store) => assert.equal(store.getWorkspace(created.id), null))
    await assert.rejects(run('workspace', 'delete', 'Default'), /Default workspace cannot be deleted/)
    assert.ok(auditActions('workspace').includes('workspace.delete'))
  })
})

describe('gateway member (console parity)', () => {
  test('show, update, policy, credentials and invites', async () => {
    const carol = activeMember('Carol', 'admin')
    activeMember('Owner', 'owner')
    const shown = await runJson<{ id: string; orgRole: string; maxKeys: number | null }>('member', 'show', 'carol@example.test')
    assert.equal(shown.id, carol.id)

    const updated = await runJson<{ orgRole: string; maxKeys: number; limitsUsd: Record<string, string | null> }>(
      'member', 'update', carol.id, '--role', 'member', '--max-keys', '2', '--monthly-limit', '20',
    )
    assert.equal(updated.orgRole, 'member')
    assert.equal(updated.maxKeys, 2)
    assert.equal(updated.limitsUsd['monthly'], '20.000000')
    await assert.rejects(run('member', 'update', carol.id, '--max-keys', 'lots'), /--max-keys/)

    await run('member', 'policy', 'set', carol.id, '--require-tee', '--max-input-price', '2.5')
    withStore((store) => assert.deepEqual(store.getMember(carol.id)!.routingPolicy, { requireTee: true, maxInputUsdPerMillion: 2.5 }))
    assert.match(await run('member', 'policy', 'show', carol.id), /Require TEE: yes/)
    await run('member', 'policy', 'clear', carol.id)
    withStore((store) => assert.equal(store.getMember(carol.id)!.routingPolicy, null))

    const credentialId = withStore((store) => {
      const db = new AuthDb(store.database, () => Date.now())
      db.addCredential(carol.id, { kind: 'wallet', label: 'Main wallet', address: `0x${'cd'.repeat(20)}` })
      const second = db.addCredential(carol.id, { kind: 'wallet', label: 'Backup', address: `0x${'ef'.repeat(20)}` })
      db.createSession({ kind: 'member', memberId: carol.id }, { userAgent: null, ip: '127.0.0.1' })
      return second.id
    })
    const listed = await runJson<Array<{ id: string; kind: string; label: string }>>('member', 'credentials', 'list', carol.id)
    assert.deepEqual(listed.map((entry) => entry.label).sort(), ['Backup', 'Main wallet'])
    await run('member', 'credentials', 'remove', carol.id, credentialId)
    withStore((store) => {
      const sessions = store.database.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE member_id = ?').get(carol.id) as { count: number }
      assert.equal(sessions.count, 0)
    })
    const remaining = listed.find((entry) => entry.id !== credentialId)!.id
    await assert.rejects(run('member', 'credentials', 'remove', carol.id, remaining), /--allow-last/)
    await run('member', 'credentials', 'remove', carol.id, remaining, '--allow-last')
    assert.deepEqual(await runJson('member', 'credentials', 'list', carol.id), [])

    const invite = await runJson<{ id: string }>('member', 'invite', '--label', 'Dana')
    assert.deepEqual((await runJson<Array<{ id: string }>>('member', 'invites')).map((entry) => entry.id), [invite.id])
    await run('member', 'cancel-invite', invite.id)
    assert.deepEqual(await runJson('member', 'invites'), [])
    assert.deepEqual(auditActions('member').filter((action) => action !== 'member.update'), ['member.credential_remove', 'member.credential_remove'])
  })
})

describe('gateway key (console parity)', () => {
  test('update both layers, rotate, and set policies with narrowing and empty-allow checks', async () => {
    const key = await runJson<{ id: string; apiKey: string }>('key', 'create', '--label', 'svc', '--daily-limit', '10')
    const updated = await runJson<{ label: string; ownerLimitsUsd: Record<string, string | null>; effectiveLimitsUsd: Record<string, string | null>; expiresAt: string | null }>(
      'key', 'update', key.id, '--label', 'svc-2', '--owner-daily-limit', '4', '--expires-in-days', '3',
    )
    assert.equal(updated.label, 'svc-2')
    assert.equal(updated.ownerLimitsUsd['daily'], '4.000000')
    assert.equal(updated.effectiveLimitsUsd['daily'], '4.000000')
    assert.ok(updated.expiresAt)
    await assert.rejects(run('key', 'update', key.id, '--owner-daily-limit', '50'), /--accept-narrowed/)
    await run('key', 'update', key.id, '--no-expiry', '--owner-daily-limit', 'none')
    withStore((store) => {
      const record = store.getKey(key.id)!
      assert.equal(record.expiresAt, null)
      assert.equal(record.ownerLimits.daily, null)
    })

    const rotated = await runJson<{ apiKey: string }>('key', 'rotate', key.id)
    assert.notEqual(rotated.apiKey, key.apiKey)
    withStore((store) => {
      assert.equal(store.findKeyBySecret(key.apiKey), null)
      assert.equal(store.findKeyBySecret(rotated.apiKey)?.id, key.id)
    })

    await run('peer-list', 'create', '--name', 'Trusted', '--peer', PEER_A)
    await run('key', 'policy', 'set', key.id, '--allow-list', 'Trusted', '--block-peer', PEER_B)
    await assert.rejects(run('key', 'policy', 'set', key.id, '--layer', 'owner', '--allow-peer', PEER_B), /--confirm-empty/)
    await assert.rejects(run('key', 'policy', 'set', key.id, '--layer', 'owner', '--allow-peer', PEER_B, '--confirm-empty'), /--accept-narrowed/)
    await run('key', 'policy', 'set', key.id, '--layer', 'owner', '--allow-peer', PEER_A, '--sort', 'latency')
    const policy = await runJson<{ routingPolicy: Record<string, unknown>; ownerRoutingPolicy: unknown; effective: Record<string, unknown> }>('key', 'policy', 'show', key.id)
    assert.equal((policy.routingPolicy['allowedPeerLists'] as string[]).length, 1)
    assert.deepEqual(policy.ownerRoutingPolicy, { allowedPeerIds: [PEER_A], sort: 'latency' })
    assert.deepEqual(policy.effective['allowedPeerIds'], [PEER_A])

    const policyFile = join(dataDir, 'policy.json')
    writeFileSync(policyFile, JSON.stringify({ allowedModels: ['open-model-a'], minTrustScore: 20 }))
    await run('key', 'policy', 'set', key.id, '--file', policyFile)
    withStore((store) => assert.deepEqual(store.getKey(key.id)!.routingPolicy, { allowedModels: ['open-model-a'], minTrustScore: 20 }))
    writeFileSync(policyFile, JSON.stringify({ minTrustScore: 'high' }))
    await assert.rejects(run('key', 'policy', 'set', key.id, '--file', policyFile), /not a valid routing policy/)
    await run('key', 'policy', 'clear', key.id, '--layer', 'owner')
    withStore((store) => assert.equal(store.getKey(key.id)!.ownerRoutingPolicy, null))
    assert.match(await run('key', 'show', key.id), /Owner routing policy:.*\n.*no restrictions/)
    assert.deepEqual(auditActions('key.rotate'), ['key.rotate'])
  })
})

describe('gateway routing', () => {
  test('default policy show/set/clear and a route preview through the buyer', async () => {
    await run('routing', 'set', '--min-trust', '50', '--allow-model', 'open-model-a')
    assert.deepEqual(await runJson('routing', 'show'), { allowedModels: ['open-model-a'], minTrustScore: 50 })
    await assert.rejects(run('routing', 'set', '--allow-peer', PEER_A, '--file', '/nonexistent/policy.json'), /Could not read/)

    const preview = await runJson<{ model: string; modelAllowed: boolean; candidates: Array<{ peerId: string; displayName: string | null }> }>('routing', 'preview', '--model', 'open-model-a')
    assert.equal(preview.modelAllowed, true)
    assert.equal(preview.candidates[0]!.displayName, 'Seller A')
    const sent = buyer.requests.filter((request) => request.url.startsWith('/_antseed/route-preview')).at(-1)!
    const secret = readFileSync(join(dataDir, GATEWAY_CONTROL_SECRET_FILE), 'utf8').trim()
    assert.equal(sent.headers[GATEWAY_CONTROL_HEADER], secret)
    assert.deepEqual(decodePolicyHeader(String(sent.headers[ROUTING_POLICY_HEADER])), { allowedModels: ['open-model-a'], minTrustScore: 50 })

    const table = await run('routing', 'preview', '--model', 'open-model-a', '--all')
    assert.match(table, /below min trust/)
    assert.match(await run('routing', 'preview', '--model', 'closed-model'), /not allowed/)

    const key = await runJson<{ id: string }>('key', 'create', '--label', 'k')
    const resolved = await runJson<{ sources: Array<{ level: string }> }>('routing', 'show', '--key', key.id)
    assert.deepEqual(resolved.sources.map((source) => source.level), ['buyer', 'gateway', 'workspace-org', 'workspace', 'key', 'key-owner'])
    await run('routing', 'clear')
    assert.deepEqual(await runJson('routing', 'show'), {})
  })
})

describe('gateway peer-list and preset', () => {
  test('peer list CRUD with add/remove and the empty-allow guard', async () => {
    const list = await runJson<{ id: string; peerIds: string[] }>('peer-list', 'create', '--name', 'Fast', '--peer', `0x${PEER_A}`, '--description', 'low latency')
    assert.deepEqual(list.peerIds, [PEER_A])
    await run('peer-list', 'add', 'Fast', PEER_B)
    assert.deepEqual((await runJson<{ peerIds: string[] }>('peer-list', 'show', 'fast')).peerIds, [PEER_A, PEER_B])
    await run('routing', 'set', '--allow-list', 'Fast')
    await run('peer-list', 'remove', 'Fast', PEER_A)
    await assert.rejects(run('peer-list', 'remove', 'Fast', PEER_B), /--confirm-empty/)
    await assert.rejects(run('peer-list', 'delete', 'Fast'), /gateway default/)
    await run('peer-list', 'update', 'Fast', '--name', 'Faster', '--peers', `${PEER_A},${PEER_B}`)
    assert.deepEqual((await runJson<Array<{ name: string; peerIds: string[] }>>('peer-list', 'list')).map((entry) => [entry.name, entry.peerIds.length]), [['Faster', 2]])
    await run('peer-list', 'delete', 'Faster', '--confirm-empty')
    assert.deepEqual(await runJson('peer-list', 'list'), [])
  })

  test('preset CRUD', async () => {
    await run('workspace', 'create', '--name', 'Team', '--identity', 'default')
    const promptFile = join(dataDir, 'prompt.txt')
    writeFileSync(promptFile, 'Answer briefly.\n')
    const preset = await runJson<{ id: string; slug: string; params: Record<string, unknown>; systemPrompt: string; routingPolicy: unknown; workspaceId: string | null }>(
      'preset', 'create', '--slug', 'brief', '--name', 'Brief', '--model', 'open-model-a', '--param', 'temperature=0.1', '--param', 'stop=END',
      '--system-prompt-file', promptFile, '--require-tee',
    )
    assert.deepEqual(preset.params, { temperature: 0.1, stop: 'END' })
    assert.equal(preset.systemPrompt, 'Answer briefly.')
    assert.deepEqual(preset.routingPolicy, { requireTee: true })
    assert.equal(preset.workspaceId, null)
    await run('preset', 'create', '--slug', 'brief', '--name', 'Team brief', '--model', 'open-model-b', '--workspace', 'Team')
    await assert.rejects(run('preset', 'create', '--slug', 'brief', '--name', 'x', '--model', 'm'), /already exists/)
    await assert.rejects(run('preset', 'show', 'brief'), /Several presets/)
    assert.equal((await runJson<{ id: string }>('preset', 'show', 'brief', '--workspace', 'org')).id, preset.id)

    const updated = await runJson<{ model: string; routingPolicy: unknown; params: Record<string, unknown> }>(
      'preset', 'update', preset.id, '--model', 'open-model-c', '--clear-policy', '--param', 'temperature=0.3', '--merge',
    )
    assert.equal(updated.model, 'open-model-c')
    assert.equal(updated.routingPolicy, null)
    assert.deepEqual(updated.params, { temperature: 0.3, stop: 'END' })
    assert.equal((await runJson<unknown[]>('preset', 'list', '--workspace', 'Team')).length, 2)
    await run('preset', 'delete', preset.id)
    assert.deepEqual((await runJson<Array<{ name: string }>>('preset', 'list')).map((entry) => entry.name), ['Team brief'])
  })
})

describe('gateway usage, logs, export and audit', () => {
  function seed(): string {
    return withStore((store) => {
      const { key } = store.createKey({ label: 'usage-key', limits: { daily: null, monthly: null, total: null }, expiresAt: null })
      const now = Date.now()
      for (let index = 0; index < 4; index += 1) {
        const tag = `gw_test_${index}`
        store.startRequest({ tag, keyId: key.id, buyerIdentity: 'default', method: 'POST', path: '/v1/chat/completions', model: index < 3 ? 'open-model-a' : 'open-model-b', startedAt: now - (10 - index) * 1000, endUser: null })
        store.finishRequest(tag, { status: index === 1 ? 502 : 200, buyerRequestId: null, ...(index === 1 ? { error: { code: 'seller_failed', message: 'upstream' } } : {}) })
      }
      store.recordRequestContent('gw_test_0', { requestBody: '{"q":1}', responseBody: '{"a":1}' })
      return key.id
    })
  }

  test('usage groups, log pages and filters, request detail, CSV export, audit filters', async () => {
    const keyId = seed()
    const usage = await runJson<{ totals: { requests: number; failedRequests: number }; groups: Array<{ group: string; requests: number }> }>('usage', '--group-by', 'model', '--key', keyId)
    assert.equal(usage.totals.requests, 4)
    assert.equal(usage.totals.failedRequests, 1)
    assert.deepEqual(usage.groups.map((group) => [group.group, group.requests]).sort(), [['open-model-a', 3], ['open-model-b', 1]])
    await assert.rejects(run('usage', '--group-by', 'colour'), /groupBy must be one of/)

    const page = await runJson<{ requests: Array<{ tag: string }>; nextBefore: string }>('logs', '--limit', '2')
    assert.deepEqual(page.requests.map((row) => row.tag), ['gw_test_3', 'gw_test_2'])
    const next = await runJson<{ requests: Array<{ tag: string }> }>('logs', '--limit', '2', '--before', page.nextBefore)
    assert.deepEqual(next.requests.map((row) => row.tag), ['gw_test_1', 'gw_test_0'])
    const failed = await runJson<{ requests: Array<{ tag: string }> }>('logs', 'list', '--status', 'error')
    assert.deepEqual(failed.requests.map((row) => row.tag), ['gw_test_1'])
    assert.match(await run('logs', '--search', 'seller_failed'), /gw_test_1/)
    const detail = await runJson<{ requestBody: string; model: string }>('logs', 'show', 'gw_test_0')
    assert.equal(detail.requestBody, '{"q":1}')
    await assert.rejects(run('logs', 'show', 'gw_missing'), /Request not found/)

    const output = join(dataDir, 'usage.csv')
    await run('export', '--csv', '--model', 'open-model-a', '--output', output)
    const lines = readFileSync(output, 'utf8').trim().split('\r\n')
    assert.equal(lines.length, 4)
    assert.match(lines[0]!, /^tag,startedAt,finishedAt,keyId/)

    await run('routing', 'set', '--min-trust', '5')
    const audit = await runJson<{ entries: Array<{ action: string; actor: { kind: string } }> }>('audit', '--action', 'routing')
    assert.deepEqual(audit.entries.map((entry) => [entry.action, entry.actor.kind]), [['routing.default.update', 'cli']])
    await assert.rejects(run('audit', '--limit', '1000'), /limit must be between/)
  })

  test('following the log prints finished requests once, oldest first', async () => {
    const keyId = seed()
    const store = new GatewayStore(dataDir)
    try {
      const seen: string[] = []
      const controller = new AbortController()
      const since = Date.now() - 60_000
      const following = followRequests(store, { keyIds: null }, { intervalMs: 10, signal: controller.signal, since, onEntry: (entry) => seen.push(entry.tag) })
      await new Promise((resolve) => setTimeout(resolve, 40))
      store.startRequest({ tag: 'gw_live', keyId, buyerIdentity: 'default', method: 'POST', path: '/v1/x', model: 'm', startedAt: Date.now(), endUser: null })
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.ok(!seen.includes('gw_live'), 'in-flight requests wait until they finish')
      store.finishRequest('gw_live', { status: 200, buyerRequestId: null })
      await new Promise((resolve) => setTimeout(resolve, 40))
      controller.abort()
      await following
      assert.deepEqual(seen, ['gw_test_0', 'gw_test_1', 'gw_test_2', 'gw_test_3', 'gw_live'])
    } finally {
      store.close()
    }
  })
})

describe('gateway settings and peers', () => {
  test('show, set-observability and set-buyer (restarting the buyer)', async () => {
    const shown = await runJson<{ buyer: { proxyPort: number }; observability: { otlpEndpoint: string | null } }>('settings', 'show')
    assert.equal(shown.buyer.proxyPort, buyer.port)
    assert.equal(shown.observability.otlpEndpoint, null)

    await run('settings', 'set-observability', '--otlp-endpoint', 'https://otel.example.test/v1/traces', '--otlp-header', 'authorization=Bearer abc', '--retention-days', '14')
    const masked = await runJson<{ observability: { otlpHeaders: Record<string, string>; retentionDays: number } }>('settings', 'show')
    assert.deepEqual(masked.observability.otlpHeaders, { authorization: '••••' })
    assert.equal(masked.observability.retentionDays, 14)
    const revealed = await runJson<{ observability: { otlpHeaders: Record<string, string> } }>('settings', 'show', '--reveal')
    assert.deepEqual(revealed.observability.otlpHeaders, { authorization: 'Bearer abc' })
    // Saved header values never follow the export to another origin.
    await assert.rejects(run('settings', 'set-observability', '--otlp-endpoint', 'https://elsewhere.example.test/v1/traces'), /give its headers again/)
    await run('settings', 'set-observability', '--log-content', 'on')
    assert.deepEqual(auditActions('settings.observability'), ['settings.observability.update', 'settings.observability.update'])

    const before = restarts
    const result = await runJson<{ buyer: { minPeerReputation: number; maxPricing: { inputUsdPerMillion: number } }; restartRequired: boolean }>(
      'settings', 'set-buyer', '--max-input-price', '3', '--min-reputation', '25',
    )
    assert.equal(result.restartRequired, false)
    assert.equal(result.buyer.minPeerReputation, 25)
    assert.equal(result.buyer.maxPricing.inputUsdPerMillion, 3)
    assert.equal(restarts, before + 1)
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { buyer: Record<string, unknown> }
    assert.equal(config.buyer['proxyPort'], buyer.port)
    await assert.rejects(run('settings', 'set-buyer', '--min-reputation', '150'), /--min-reputation/)
  })

  test('peers lists the buyer\'s sellers, filtered by model', async () => {
    const peers = await runJson<Array<{ peerId: string; services: Array<{ service: string }> }>>('peers')
    assert.deepEqual(peers.map((peer) => peer.peerId), [PEER_A, PEER_B])
    const filtered = await runJson<Array<{ peerId: string }>>('peers', '--model', 'open-model-b')
    assert.deepEqual(filtered.map((peer) => peer.peerId), [PEER_B])
    assert.match(await run('peers'), /Seller A/)
    await assert.rejects(run('peers', '--buyer-port', '1'), /buyer is not reachable/)
  })
})
