import assert from 'node:assert/strict'
import { chmodSync, lstatSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { OBSERVABILITY_SETTING } from '../../observability.js'
import type { ConsoleDeps } from '../deps.js'
import { FakeConsoleAuth, call, memberPrincipal, startConsole, tempDataDir, testDeps } from '../test-support.js'
import type { RequestDetail, RequestLogEntry, Settings } from '../types.js'
import { coreConsoleRegistrars } from './index.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

/** A buyer answering `/_antseed/restart` the way `restart` says. */
async function fakeBuyer(restart: { status: number; body: unknown }) {
  const server = http.createServer((req, res) => {
    req.resume()
    if (req.url === '/_antseed/restart') res.writeHead(restart.status, { 'content-type': 'application/json' }).end(JSON.stringify(restart.body))
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function harness(overrides: Partial<ConsoleDeps> = {}) {
  const { dir, store, cleanup } = tempDataDir()
  const auth = new FakeConsoleAuth()
  const owner = store.createOwner({ label: 'Owner', email: null })
  auth.as('owner', memberPrincipal(store, owner.id))
  auth.as('writer', { kind: 'token', tokenId: 'tok_w', scope: 'admin' })
  const deps = testDeps(store, dir, overrides)
  const server = await startConsole(deps, auth, coreConsoleRegistrars)
  const as = (who: string, method: string, path: string, body?: unknown) =>
    call(server.port, method, `/console/api${path}`, { who, body, bearer: who === 'writer' })
  return { dir, store, auth, owner, deps, as, close: async () => { await server.close(); cleanup() } }
}

test('PATCH /settings/buyer edits only the touched fields of the raw config, atomically, keeping its mode', async () => {
  const buyer = await fakeBuyer({ status: 202, body: { ok: true } })
  const h = await harness({ buyerPort: buyer.port })
  try {
    const path = join(h.dir, 'config.json')
    writeFileSync(path, JSON.stringify({ buyer: { maxPricing: { defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 1 } } }, custom: { keep: true } }))
    chmodSync(path, 0o640)
    const patched = await h.as('owner', 'PATCH', '/settings/buyer', { maxPricing: { inputUsdPerMillion: 2, cachedInputUsdPerMillion: null } })
    assert.equal(patched.status, 200, JSON.stringify(patched.body))
    const settings = patched.body as Settings
    assert.equal(settings.restartRequired, undefined)
    assert.equal(settings.buyer.proxyPort, buyer.port, 'the port the gateway actually uses')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      buyer: { maxPricing: { defaults: { inputUsdPerMillion: 2, outputUsdPerMillion: 10 } } },
      custom: { keep: true },
    })
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o640)
    const entry = h.store.listAudit({ action: 'settings.buyer.update' }).entries[0]
    assert.equal(entry?.actor.id, h.owner.id)
  } finally {
    await h.close()
    await buyer.close()
  }
})

test('PATCH /settings/buyer refuses bad numbers and unreadable files, and reports when a restart is up to the operator', async () => {
  const buyer = await fakeBuyer({ status: 503, body: { ok: false, error: 'restart_unsupported' } })
  const h = await harness({ buyerPort: buyer.port })
  try {
    const path = join(h.dir, 'config.json')
    writeFileSync(path, '{"buyer": {')
    for (const body of [{ minPeerReputation: '' }, { minPeerReputation: -1 }, { maxPricing: { inputUsdPerMillion: '' } }, { maxPricing: { outputUsdPerMillion: null } }]) {
      assert.equal((await h.as('owner', 'PATCH', '/settings/buyer', body)).status, 400, JSON.stringify(body))
    }
    const refused = await h.as('owner', 'PATCH', '/settings/buyer', { minPeerReputation: 10 })
    assert.equal(refused.status, 409)
    assert.equal(readFileSync(path, 'utf8'), '{"buyer": {', 'an unparsable file is left alone')

    writeFileSync(path, '{}')
    const saved = await h.as('owner', 'PATCH', '/settings/buyer', { minPeerReputation: 10 })
    assert.equal(saved.status, 200)
    assert.equal((saved.body as Settings).restartRequired, true)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { buyer: { minPeerReputation: 10 } })
  } finally {
    await h.close()
    await buyer.close()
  }
})

test('OTLP header values are shown to org-admin sessions only, and a masked value sent back is kept', async () => {
  const h = await harness()
  try {
    const put = await h.as('owner', 'PUT', '/settings/observability', { otlpEndpoint: 'https://otel.example.test', otlpHeaders: { authorization: 'Bearer secret-1' }, logContent: false, retentionDays: null })
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal((put.body as Settings).observability.otlpHeaders['authorization'], 'Bearer secret-1')
    const asToken = (await h.as('writer', 'GET', '/settings')).body as Settings
    assert.deepEqual(asToken.observability.otlpHeaders, { authorization: '••••' })
    // A token round-trips what it read (changing only retention); the stored secret survives.
    assert.equal((await h.as('writer', 'PUT', '/settings/observability', { ...asToken.observability, retentionDays: 30 })).status, 200)
    assert.deepEqual(h.store.getSetting<{ otlpHeaders: Record<string, string> }>(OBSERVABILITY_SETTING)?.otlpHeaders, { authorization: 'Bearer secret-1' })
    assert.equal((await h.as('writer', 'PUT', '/settings/observability', { ...asToken.observability, otlpHeaders: { 'x-new': '••••' } })).status, 400)
    const audited = h.store.listAudit({ action: 'settings.observability.update' }).entries
    assert.equal(audited.length, 2)
    assert.ok(!JSON.stringify(audited).includes('secret-1'), 'header values never reach the audit log')
  } finally {
    await h.close()
  }
})

test('masked OTLP header values are not carried to a new endpoint origin', async () => {
  const h = await harness()
  try {
    await h.as('owner', 'PUT', '/settings/observability', { otlpEndpoint: 'https://otel.example.test/v1', otlpHeaders: { authorization: 'Bearer secret-1' }, logContent: false, retentionDays: null })
    const moved = await h.as('owner', 'PUT', '/settings/observability', { otlpEndpoint: 'https://collector.attacker.test/v1', otlpHeaders: { authorization: '••••' }, logContent: false, retentionDays: null })
    assert.equal(moved.status, 400)
    assert.equal((moved.body as { error: { code: string } }).error.code, 'otlp_headers_required')
    assert.equal(h.store.getSetting<{ otlpEndpoint: string }>(OBSERVABILITY_SETTING)?.otlpEndpoint, 'https://otel.example.test/v1', 'nothing changed')
    // Same origin, another path: the saved value is kept.
    const samePlace = await h.as('owner', 'PUT', '/settings/observability', { otlpEndpoint: 'https://otel.example.test/v2', otlpHeaders: { authorization: '••••' }, logContent: false, retentionDays: null })
    assert.equal(samePlace.status, 200)
    assert.equal((samePlace.body as Settings).observability.otlpHeaders['authorization'], 'Bearer secret-1')
    // Re-entered values go to the new origin.
    const reentered = await h.as('owner', 'PUT', '/settings/observability', { otlpEndpoint: 'https://collector.example.test', otlpHeaders: { authorization: 'Bearer secret-2' }, logContent: false, retentionDays: null })
    assert.equal(reentered.status, 200)
    assert.equal((reentered.body as Settings).observability.otlpHeaders['authorization'], 'Bearer secret-2')
  } finally {
    await h.close()
  }
})

test('only org-admin sessions change the OTLP endpoint or content logging; tokens are refused and audited', async () => {
  const h = await harness()
  try {
    const base = { otlpEndpoint: null, otlpHeaders: {}, logContent: false, retentionDays: null }
    for (const body of [{ ...base, otlpEndpoint: 'https://collector.example.test' }, { ...base, logContent: true }]) {
      const refused = await h.as('writer', 'PUT', '/settings/observability', body)
      assert.equal(refused.status, 403, JSON.stringify(body))
      assert.equal((refused.body as { error: { code: string } }).error.code, 'session_required')
    }
    assert.equal(h.store.listAudit({ action: 'settings.observability.denied' }).entries.length, 2)
    assert.equal(h.store.listAudit({ action: 'settings.observability.update' }).entries.length, 0)
    const byOwner = await h.as('owner', 'PUT', '/settings/observability', { ...base, otlpEndpoint: 'https://collector.example.test', logContent: true })
    assert.equal(byOwner.status, 200)
    const [entry] = h.store.listAudit({ action: 'settings.observability.update' }).entries
    assert.equal(entry?.actor.id, h.owner.id)
    assert.equal(entry?.details?.['previousOtlpEndpoint'], null)
    assert.equal(entry?.details?.['previousLogContent'], false)
  } finally {
    await h.close()
  }
})

test('concurrent buyer-settings PATCHes are serialized and a symlinked config is written through', async () => {
  const buyer = await fakeBuyer({ status: 202, body: { ok: true } })
  const h = await harness({ buyerPort: buyer.port })
  try {
    const target = join(h.dir, 'real-config.json')
    writeFileSync(target, JSON.stringify({ custom: { keep: true } }))
    symlinkSync(target, join(h.dir, 'config.json'))
    const results = await Promise.all([
      h.as('owner', 'PATCH', '/settings/buyer', { minPeerReputation: 42 }),
      h.as('owner', 'PATCH', '/settings/buyer', { maxPricing: { inputUsdPerMillion: 3 } }),
      h.as('owner', 'PATCH', '/settings/buyer', { maxPricing: { outputUsdPerMillion: 7 } }),
    ])
    assert.deepEqual(results.map((result) => result.status), [200, 200, 200])
    assert.ok(lstatSync(join(h.dir, 'config.json')).isSymbolicLink(), 'the link is kept')
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
      custom: { keep: true },
      buyer: { minPeerReputation: 42, maxPricing: { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 7 } } },
    })
  } finally {
    await h.close()
    await buyer.close()
  }
})

test('request detail, search, opaque cursors and a streamed CSV export', async () => {
  const h = await harness()
  try {
    const { key } = h.store.createKey({ label: 'Batch job', limits: NO_LIMITS, expiresAt: null })
    const { key: other } = h.store.createKey({ label: 'Other', limits: NO_LIMITS, expiresAt: null })
    h.auth.as('otherKey', { kind: 'key', keyId: other.id, sessionId: 'ks' })
    const base = Date.now() - 60_000
    for (let index = 0; index < 1_205; index += 1) {
      const tag = `gw_${String(index).padStart(5, '0')}`
      h.store.startRequest({ tag, keyId: key.id, buyerIdentity: 'default', method: 'POST', path: '/v1/responses', model: index === 7 ? 'open-model-special' : 'm1', startedAt: base + Math.floor(index / 10) })
      h.store.finishRequest(tag, index === 9 ? { status: 502, buyerRequestId: null, error: { code: 'seller_error', message: 'Upstream, "quoted"' } } : { status: 200, buyerRequestId: null })
    }
    h.store.recordRequestContent('gw_00009', { requestBody: 'PROMPT BODY', responseBody: 'ANSWER BODY' })

    const detail = await h.as('owner', 'GET', '/requests/gw_00009')
    assert.equal(detail.status, 200)
    const body = detail.body as RequestDetail
    assert.deepEqual([body.requestBody, body.responseBody, body.errorCode, body.errorMessage], ['PROMPT BODY', 'ANSWER BODY', 'seller_error', 'Upstream, "quoted"'])
    assert.equal((await h.as('otherKey', 'GET', '/requests/gw_00009')).status, 404, 'another key cannot read it')
    assert.equal((await h.as('owner', 'GET', '/requests/gw_nope')).status, 404)

    const found = (await h.as('owner', 'GET', '/requests?q=special')).body as { requests: RequestLogEntry[] }
    assert.deepEqual(found.requests.map((r) => r.tag), ['gw_00007'])
    assert.ok(!('requestBody' in found.requests[0]!))
    const byError = (await h.as('owner', 'GET', '/requests?q=upstream')).body as { requests: RequestLogEntry[] }
    assert.deepEqual(byError.requests.map((r) => r.tag), ['gw_00009'], 'search matches error messages (case-insensitive)')
    const byCode = (await h.as('owner', 'GET', '/requests?q=seller_error')).body as { requests: RequestLogEntry[] }
    assert.deepEqual(byCode.requests.map((r) => r.tag), ['gw_00009'], 'search matches error codes')
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const page = (await h.as('owner', 'GET', `/requests?limit=200${cursor ? `&before=${cursor}` : ''}`)).body as { requests: RequestLogEntry[]; nextBefore: string | null }
      for (const row of page.requests) seen.add(row.tag)
      cursor = page.nextBefore
    } while (cursor)
    assert.equal(seen.size, 1_205, 'every row exactly once across pages')
    assert.equal((await h.as('owner', 'GET', '/requests?before=not-a-cursor')).status, 400)

    const csv = await h.as('owner', 'GET', '/usage/export.csv')
    assert.equal(csv.status, 200)
    const lines = csv.text.trim().split('\r\n')
    assert.equal(lines.length, 1 + 1_205, 'batches past the first 1,000 rows')
    assert.ok(lines[0]!.endsWith(',errorCode,errorMessage'))
    assert.ok(csv.text.includes('seller_error,"Upstream, ""quoted"""'))
    assert.ok(!csv.text.includes('PROMPT BODY'), 'no bodies in the export')
    const filtered = await h.as('owner', 'GET', '/usage/export.csv?status=error')
    assert.equal(filtered.text.trim().split('\r\n').length, 2)
  } finally {
    await h.close()
  }
})

test('presets, peer lists and the routing default are audited', async () => {
  const h = await harness()
  try {
    const list = await h.as('owner', 'POST', '/peer-lists', { name: 'Good', peerIds: ['aa'] })
    const listId = (list.body as { id: string }).id
    await h.as('owner', 'PATCH', `/peer-lists/${listId}`, { peerIds: ['aa', 'bb'] })
    await h.as('owner', 'DELETE', `/peer-lists/${listId}`)
    const preset = await h.as('owner', 'POST', '/presets', { slug: 'fast', name: 'Fast', model: 'm1', systemPrompt: 'be brief' })
    const presetId = (preset.body as { id: string }).id
    await h.as('owner', 'PATCH', `/presets/${presetId}`, { model: 'm2', systemPrompt: 'be very brief' })
    await h.as('owner', 'DELETE', `/presets/${presetId}`)
    await h.as('writer', 'PUT', '/routing', { blockedPeerIds: ['cc'] })

    const actions = h.store.listAudit({ limit: 50 }).entries.map((entry) => entry.action).sort()
    assert.deepEqual(actions, ['peer_list.create', 'peer_list.delete', 'peer_list.update', 'preset.create', 'preset.delete', 'preset.update', 'routing.default.update'])
    const update = h.store.listAudit({ action: 'peer_list.update' }).entries[0]!
    assert.deepEqual(update.details, { added: ['bb'] })
    const presetUpdate = h.store.listAudit({ action: 'preset.update' }).entries[0]!
    assert.deepEqual(presetUpdate.details, { model: { before: 'm1', after: 'm2' }, systemPromptChanged: true })
    assert.equal(h.store.listAudit({ action: 'routing.default.update' }).entries[0]!.actor.kind, 'token')
  } finally {
    await h.close()
  }
})
