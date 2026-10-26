import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { identityFromPrivateKeyHex } from '@antseed/node'
import { startSellerDashboard } from './dashboard-server.js'
import { fakeNetworkRows, writeSellerFixture } from './fixture.js'
import { updateSellerVerifications, VerificationChecks } from './promote.js'

const PEER = '5e11e5e11e5e11e5e11e5e11e5e11e5e11e5e11e'
const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

test('market, reputation and promote: background snapshot, standing, verification setup and checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-insights-'))
  writeSellerFixture(dir, { state: { updatedAt: Date.now(), peerId: PEER, modelHealth: [] } })
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    identity: { displayName: 'Demo Seller' },
    seller: { providers: { openai: { plugin: 'openai', baseUrl: 'https://upstream.example', services: { 'glm-5.3': { pricing: { inputUsdPerMillion: 0.7, outputUsdPerMillion: 2.2 } } } } } },
  }, null, 2))
  let loads = 0
  const checks = new VerificationChecks({
    resolveTxt: async (host) => (host === '_antseed.forge.example' ? [[`antseed-peer=${PEER}`]] : []),
    fetch: (async () => new Response('nope', { status: 404 })) as typeof fetch,
  })
  const server = await startSellerDashboard({
    dataDir: dir, configPath, version: '9.9.9', port: 0, env: {},
    network: async () => { loads += 1; return { rows: fakeNetworkRows(PEER, { 'glm-5.3': [0.7, 2.2] }), source: 'test network' } },
    standing: async () => ({ epochEndsAt: null, standing: { address: `0x${PEER}`, agentId: 412, identityRegistered: true, registryBound: true, eligible: false, minPoolStake: '1000', poolActiveStake: '250', pool: null, pendingRewards: '12.5' } }),
    explorerUrl: async () => 'https://explorer.example',
    verificationChecks: checks,
  })
  const token = new URL(server.url).searchParams.get('token')!
  const base = new URL(server.url).origin
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}/console/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    return { status: response.status, json: await response.json() as Record<string, any> }
  }
  try {
    const first = (await call('GET', '/seller/market')).json
    assert.equal(first.network.refreshedAt, null, 'the first read does not wait for the network')
    await tick()
    const market = (await call('GET', '/seller/market')).json
    assert.equal(market.network.source, 'test network')
    assert.equal(market.found, true)
    assert.deepEqual([market.services[0].service, market.services[0].rank, market.services[0].of], ['glm-5.3', 2, 6])
    assert.equal(loads, 1, 'served from the cached snapshot')
    await call('GET', '/seller/market?refresh=1')
    await tick()
    assert.equal(loads, 1, 'Refresh within 30 s of the last load is ignored: no button can hammer discovery')

    await call('GET', '/seller/reputation')
    await tick()
    const reputation = (await call('GET', '/seller/reputation')).json
    assert.deepEqual(reputation.rank, { position: 6, of: 8 })
    assert.equal(reputation.standing.agentId, 412)
    assert.equal(reputation.steps[0].part, 'standing', 'not eligible yet comes first')
    assert.match(reputation.steps[0].text, /1000 ANTS/)

    const promote = (await call('GET', '/seller/promote')).json
    assert.equal(promote.profileUrl, `https://explorer.example/account/0x${PEER}`)
    assert.deepEqual(promote.domains, [])
    const saved = await call('PUT', '/seller/promote/verifications', { domains: [{ domain: 'https://Forge.example/' }], github: [{ username: 'open-forge' }] })
    assert.equal(saved.status, 200)
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf-8')).seller.verifications, { domains: [{ domain: 'forge.example' }], github: [{ username: 'open-forge' }] })
    assert.equal(JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8')).seller.verifications, undefined)
    assert.deepEqual([saved.json.domains[0].txtName, saved.json.domains[0].txtValue], ['_antseed.forge.example', `antseed-peer=${PEER}`])
    assert.equal(saved.json.github[0].proofUrl, 'https://raw.githubusercontent.com/open-forge/open-forge/HEAD/antseed.json')
    const checked = (await call('POST', '/seller/promote/check')).json
    assert.equal(checked.domains[0].status.verified, true)
    assert.equal(checked.github[0].status.verified, false)
    // A claim limited to the well-known file must not pass on its DNS record.
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.seller.verifications.domains = [{ domain: 'forge.example', methods: ['https-well-known'] }]
    writeFileSync(configPath, JSON.stringify(config))
    assert.equal((await call('POST', '/seller/promote/check')).json.domains[0].status.verified, false)
    assert.equal((await call('PUT', '/seller/promote/verifications', { domains: [{ domain: 'not a domain' }], github: [] })).status, 400)
  } finally {
    await server.close()
  }
})

test('saving claims keeps the proof methods of the domains already there', async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), 'seller-promote-')), 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { verifications: { domains: [{ domain: 'seller.example', methods: ['https-well-known'] }] } } }))
  await updateSellerVerifications(configPath, { domains: [{ domain: 'seller.example' }, { domain: 'new.example' }], github: [{ username: 'seller-dev' }] })
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).seller.verifications, {
    domains: [{ domain: 'seller.example', methods: ['https-well-known'] }, { domain: 'new.example' }],
    github: [{ username: 'seller-dev' }],
  })
})

test('a stopped seller (journal, no daemon state) is still known by its stored identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seller-insights-'))
  const key = '11'.repeat(32)
  writeFileSync(join(dir, 'identity.key'), key, { mode: 0o600 })
  writeSellerFixture(dir, { events: [{ at: 1, kind: 'stopped', severity: 'info', title: 'Seller stopped' }] })
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ seller: { providers: {} } }))
  const standingFor: string[] = []
  const server = await startSellerDashboard({
    dataDir: dir, configPath, version: '9.9.9', port: 0, env: {},
    network: async () => ({ rows: [], source: 'test network' }),
    standing: async (id) => { standingFor.push(id); throw new Error('offline') },
    explorerUrl: async () => 'https://explorer.example',
  })
  const token = new URL(server.url).searchParams.get('token')!
  try {
    const response = await fetch(`${new URL(server.url).origin}/console/api/seller/promote`, { headers: { authorization: `Bearer ${token}` } })
    const promote = await response.json() as { peerId: string | null; profileUrl: string | null }
    const expected = identityFromPrivateKeyHex(key).peerId
    assert.equal(promote.peerId, expected)
    assert.equal(promote.profileUrl, `https://explorer.example/account/0x${expected}`)
    await fetch(`${new URL(server.url).origin}/console/api/seller/reputation`, { headers: { authorization: `Bearer ${token}` } })
    await tick()
    assert.deepEqual(standingFor, [expected], 'on-chain standing is looked up for it too')
    assert.equal(readFileSync(join(dir, 'identity.key'), 'utf8'), key, 'the identity is only read')
  } finally {
    await server.close()
  }
})
