import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GATEWAY_CONTROL_HEADER, GATEWAY_CONTROL_SECRET_ENV, ROUTING_POLICY_HEADER, decodePolicyHeader, modelServiceId, policyAllowsModel } from '../routing-policy/policy.js'
import { buyerFetch, loadOrCreateControlSecret } from './buyer-control.js'
import { OtlpExporter, tracesUrl } from './observability.js'
import { GATEWAY_ROUTING_SETTING, checkPolicyInput, isEmptyPolicy, policyInputProblem, resolvePolicy } from './policy-resolver.js'
import { applyPreset, extractEndUser, sniffMultipartModel } from './request-shaping.js'
import { DEFAULT_WORKSPACE_ID, type PresetRecord } from './store.js'
import { tempDataDir } from './console-api/test-support.js'

const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }

test('policies narrow from the gateway default through workspace, member, key and preset', () => {
  const { store, cleanup } = tempDataDir()
  try {
    store.setSetting(GATEWAY_ROUTING_SETTING, { blockedPeerIds: ['0xAA'], maxInputUsdPerMillion: 10, sort: 'price' })
    const ws = store.createWorkspace({ name: 'R', buyerIdentity: 'ws-r', routingPolicy: { allowedModels: ['m1', 'm2', 'm3'], minTrustScore: 20 } })
    // The org admins' workspace policy comes first; the workspace admins' own can only narrow it.
    store.updateWorkspace(ws.id, { orgRoutingPolicy: { maxOutputUsdPerMillion: 7, allowedModels: ['m1', 'm2', 'm4'] } })
    const owner = store.createOwner({ label: 'O', email: null })
    store.updateMember(owner.id, { routingPolicy: { maxInputUsdPerMillion: 5, allowedModels: ['m1', 'm2'] } })
    const { key } = store.createKey({
      label: 'k', workspaceId: ws.id, ownerMemberId: owner.id, limits: NO_LIMITS, expiresAt: null,
      routingPolicy: { minTrustScore: 10, blockedPeerIds: ['bb'], maxInputUsdPerMillion: 50, sort: 'latency' },
    })
    const preset = store.createPreset({ slug: 'cheap', name: 'Cheap', workspaceId: ws.id, model: 'm1', routingPolicy: { allowedModels: ['m1'], requireVerified: true }, systemPrompt: null, params: {} })

    const { policy, sources } = resolvePolicy(store, { keyId: key.id })
    assert.deepEqual(sources.map((s) => s.level), ['buyer', 'gateway', 'workspace-org', 'workspace', 'member', 'key', 'key-owner'])
    assert.deepEqual(sources[2]!.policy, { maxOutputUsdPerMillion: 7, allowedModels: ['m1', 'm2', 'm4'] })
    assert.equal(policy.maxOutputUsdPerMillion, 7, 'the org policy of a workspace applies to its keys')
    assert.deepEqual(policy.blockedPeerIds?.sort(), ['aa', 'bb'])
    assert.equal(policy.maxInputUsdPerMillion, 5, 'a key cannot raise a cap')
    assert.equal(policy.minTrustScore, 20, 'a key cannot lower a minimum')
    assert.deepEqual(policy.allowedModels, ['m1', 'm2'])
    assert.equal(policy.sort, 'latency', 'ranking preferences take the lowest level that sets one')

    const withPreset = resolvePolicy(store, { keyId: key.id, presetSlug: 'cheap' })
    assert.equal(withPreset.sources.at(-1)?.id, preset.id)
    assert.deepEqual(withPreset.policy.allowedModels, ['m1'])
    assert.equal(withPreset.policy.requireVerified, true)

    const workspaceOnly = resolvePolicy(store, { workspaceId: DEFAULT_WORKSPACE_ID })
    assert.deepEqual(workspaceOnly.sources.map((s) => s.level), ['buyer', 'gateway', 'workspace-org', 'workspace'])
    assert.equal(workspaceOnly.policy.allowedModels, undefined)
  } finally {
    cleanup()
  }
})

test('allowed models compare the service part of peer@model', () => {
  const policy = { allowedModels: ['deepseek-v4-flash'] }
  assert.equal(modelServiceId('abc123@deepseek-v4-flash'), 'deepseek-v4-flash')
  assert.equal(modelServiceId('@preset/x'), '@preset/x')
  assert.equal(policyAllowsModel(policy, 'deepseek-v4-flash'), true)
  assert.equal(policyAllowsModel(policy, 'DEEPSEEK-V4-FLASH'), true)
  assert.equal(policyAllowsModel(policy, 'abc123@deepseek-v4-flash'), true)
  assert.equal(policyAllowsModel(policy, 'abc123@other-model'), false)
  assert.equal(policyAllowsModel(policy, null), false, 'no model under an allow list fails closed')
  assert.equal(policyAllowsModel({}, null), true)
})

const PRESET: PresetRecord = {
  id: 'pre_1', slug: 's', name: 'S', workspaceId: null, model: 'real-model', routingPolicy: null,
  systemPrompt: 'Be brief.', params: { temperature: 0.2, max_tokens: 100 }, createdAt: 0,
}

test('presets rewrite the model, put their params under the client\'s and prepend their system prompt', () => {
  const chat = applyPreset({ model: '@preset/s', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }, PRESET, '/v1/chat/completions')
  assert.equal(chat['model'], 'real-model')
  assert.equal(chat['temperature'], 0.2)
  assert.equal(chat['max_tokens'], 5, 'the client wins')
  assert.deepEqual(chat['messages'], [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }])

  assert.equal(applyPreset({ model: '@preset/s', system: 'Mine.' }, PRESET, '/v1/messages')['system'], 'Be brief.\n\nMine.')
  assert.deepEqual(applyPreset({ system: [{ type: 'text', text: 'Mine.' }] }, PRESET, '/v1/messages')['system'],
    [{ type: 'text', text: 'Be brief.' }, { type: 'text', text: 'Mine.' }])
  assert.equal(applyPreset({}, PRESET, '/v1/messages')['system'], 'Be brief.')
  assert.equal(applyPreset({ instructions: 'Mine.' }, PRESET, '/v1/responses')['instructions'], 'Be brief.\n\nMine.')
  assert.equal(applyPreset({}, PRESET, '/v1/images/generations')['instructions'], undefined)
})

test('end user and multipart model are read from the request', () => {
  assert.equal(extractEndUser({ user: 'u-1' }, 'header-user'), 'u-1')
  assert.equal(extractEndUser(null, 'header-user'), 'header-user')
  assert.equal(extractEndUser({}, undefined), null)
  const boundary = 'XyZ'
  const form = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nhello\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nimage-model\r\n--${boundary}--\r\n`)
  assert.equal(sniffMultipartModel(form, `multipart/form-data; boundary=${boundary}`), 'image-model')
  assert.equal(sniffMultipartModel(form, 'application/json'), null)
})

test('the control secret is created once with mode 0600 and the env var overrides it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-secret-'))
  const previous = process.env[GATEWAY_CONTROL_SECRET_ENV]
  delete process.env[GATEWAY_CONTROL_SECRET_ENV]
  try {
    const first = loadOrCreateControlSecret(dir)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(loadOrCreateControlSecret(dir), first)
    const path = join(dir, 'gateway', 'buyer-control.secret')
    assert.equal(readFileSync(path, 'utf8').trim(), first)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    process.env[GATEWAY_CONTROL_SECRET_ENV] = 'from-env'
    assert.equal(loadOrCreateControlSecret(dir), 'from-env')
  } finally {
    if (previous === undefined) delete process.env[GATEWAY_CONTROL_SECRET_ENV]
    else process.env[GATEWAY_CONTROL_SECRET_ENV] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buyerFetch sends the secret, the policy and the identity', async () => {
  let seen: http.IncomingHttpHeaders = {}
  let url = ''
  const server = http.createServer((req, res) => {
    seen = req.headers
    url = req.url ?? ''
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    await buyerFetch({ buyerPort: port, secret: 's3cret' }, '/_antseed/route-preview?model=m', { policy: { allowedModels: ['m'] }, identity: 'ws-a' })
    assert.equal(seen[GATEWAY_CONTROL_HEADER], 's3cret')
    assert.deepEqual(decodePolicyHeader(seen[ROUTING_POLICY_HEADER] as string), { allowedModels: ['m'] })
    assert.equal(url, '/_antseed/route-preview?model=m&identity=ws-a')
    await buyerFetch({ buyerPort: port, secret: 's3cret' }, '/_antseed/status')
    assert.equal(seen[ROUTING_POLICY_HEADER], undefined)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('OTLP exporter posts one span per request, without content unless enabled, and bounds its queue', async () => {
  const posted: Array<{ url: string; body: any; headers: Record<string, string> }> = []
  let settings = { otlpEndpoint: 'https://otel.example.test', otlpHeaders: { 'x-token': 't' }, logContent: false, retentionDays: null as number | null }
  const fetchImpl = (async (url: string, init: RequestInit) => {
    posted.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> })
    return new Response(null, { status: 200 })
  }) as unknown as typeof fetch
  const exporter = new OtlpExporter(() => settings, { fetchImpl, flushIntervalMs: 60_000 })
  const span = {
    tag: 'gw_1', method: 'POST', path: '/v1/responses', model: 'm', status: 200, startedAt: 1_000, finishedAt: 1_250,
    keyId: 'key_1', workspaceId: 'ws_default', memberId: null, endUser: 'u', sellerPeerId: 'aa', latencyMs: 250,
    requestBody: 'SECRET PROMPT', responseBody: 'SECRET ANSWER',
  }
  exporter.record(span)
  await exporter.flush()
  assert.equal(posted[0]!.url, 'https://otel.example.test/v1/traces')
  assert.equal(posted[0]!.headers['x-token'], 't')
  const exported = posted[0]!.body.resourceSpans[0].scopeSpans[0].spans
  assert.equal(exported.length, 1)
  assert.equal(exported[0].startTimeUnixNano, '1000000000')
  assert.ok(!JSON.stringify(exported).includes('SECRET'))

  settings = { ...settings, logContent: true }
  exporter.record(span)
  await exporter.flush()
  assert.ok(JSON.stringify(posted[1]!.body).includes('SECRET PROMPT'))

  for (let index = 0; index < 1_005; index += 1) exporter.record(span)
  assert.equal(exporter.dropped, 5)
  await exporter.stop()
  assert.equal(tracesUrl('http://collector:4318/v1/traces'), 'http://collector:4318/v1/traces')

  settings = { ...settings, otlpEndpoint: null as unknown as string }
  const before = posted.length
  exporter.record(span)
  await exporter.flush()
  assert.equal(posted.length, before, 'nothing is sent without an endpoint')
})

test('peer lists in policies are references: editing a list changes every policy using it', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const PEER_A = 'a1'.repeat(20)
    const PEER_B = 'b2'.repeat(20)
    const PEER_C = 'c3'.repeat(20)
    const own = store.createPeerList({ name: 'Own', description: null, peerIds: [PEER_A, PEER_B] })
    const banned = store.createPeerList({ name: 'Banned', description: null, peerIds: [PEER_C] })
    const ws = store.createWorkspace({ name: 'L', buyerIdentity: 'ws-l', routingPolicy: { allowedPeerLists: [own.id] } })
    const { key } = store.createKey({ label: 'k', workspaceId: ws.id, limits: NO_LIMITS, expiresAt: null, routingPolicy: { allowedPeerIds: [PEER_B, PEER_C], blockedPeerLists: [banned.id] } })

    let { policy } = resolvePolicy(store, { keyId: key.id })
    assert.deepEqual(policy.allowedPeerIds, [PEER_B], 'workspace list ∩ key ids')
    assert.deepEqual(policy.blockedPeerIds, [PEER_C])
    assert.equal(policy.allowedPeerLists, undefined)
    assert.equal(policy.blockedPeerLists, undefined)

    store.updatePeerList(own.id, { peerIds: [PEER_A] })
    policy = resolvePolicy(store, { keyId: key.id }).policy
    assert.deepEqual(policy.allowedPeerIds, [], 'the edited list applies at once')

    store.deletePeerList(own.id)
    policy = resolvePolicy(store, { workspaceId: ws.id }).policy
    assert.deepEqual(policy.allowedPeerIds, [], 'a deleted allow list fails closed')
  } finally {
    cleanup()
  }
})

test('the key owner\'s layer only narrows the admins\' layer, peer lists included', () => {
  const { store, cleanup } = tempDataDir()
  try {
    const A = 'aa'.repeat(20)
    const B = 'bb'.repeat(20)
    const C = 'cc'.repeat(20)
    const any = store.createPeerList({ name: 'Any', description: null, peerIds: [A, B, C] })
    const onlyC = store.createPeerList({ name: 'C', description: null, peerIds: [C] })
    const ws = store.createWorkspace({ name: 'O', buyerIdentity: 'ws-o' })
    const { key } = store.createKey({
      label: 'k', workspaceId: ws.id, limits: NO_LIMITS, expiresAt: null,
      routingPolicy: { allowedPeerIds: [A] },
      ownerRoutingPolicy: { allowedPeerIds: [A], allowedPeerLists: [any.id], maxInputUsdPerMillion: 2 },
    })
    let { policy } = resolvePolicy(store, { keyId: key.id })
    assert.deepEqual(policy.allowedPeerIds, [A], 'adding a list in the owner layer does not widen the admin allow list')
    assert.equal(policy.maxInputUsdPerMillion, 2)

    // The other way round: the admins allow a list, the owner adds ids outside it.
    store.updateKey(key.id, { routingPolicy: { allowedPeerLists: [onlyC.id] }, ownerRoutingPolicy: { allowedPeerIds: [A] } })
    policy = resolvePolicy(store, { keyId: key.id }).policy
    assert.deepEqual(policy.allowedPeerIds, [], 'ids outside the admin list are not added')

    // checkPolicyInput reports what the console must refuse.
    const target = { keyId: key.id }
    const widen = checkPolicyInput(store, target, 'key-owner', { allowedPeerLists: [any.id] })
    assert.deepEqual(widen.narrowed, ['allowedPeerIds'])
    assert.deepEqual(widen.effective.allowedPeerIds, [C])
    assert.equal(widen.emptyAllow, false)
    const ok = checkPolicyInput(store, target, 'key-owner', { allowedPeerIds: [C], sort: 'price' })
    assert.deepEqual(ok.narrowed, [])
    const none = checkPolicyInput(store, target, 'key-owner', { allowedPeerIds: [A] })
    assert.equal(none.emptyAllow, true, 'no overlap with the level above leaves no seller')
    assert.equal(checkPolicyInput(store, target, 'key-owner', { allowedPeerIds: [] }).emptyAllow, true)
    assert.equal(checkPolicyInput(store, target, 'key-owner', { allowedPeerLists: ['pl_missing'] }).emptyAllow, true)
    assert.equal(checkPolicyInput(store, target, 'key-owner', { blockedPeerIds: [A] }).emptyAllow, false, 'only a sent allow list counts')

    const empty = policyInputProblem([{ field: 'ownerRoutingPolicy', check: none }], {})
    assert.equal(empty?.status, 400)
    assert.equal(empty?.body.error.code, 'empty_allow_list')
    // Leaving no seller is also a narrowing here (A is not in the admin list): both need confirming.
    assert.equal(policyInputProblem([{ field: 'ownerRoutingPolicy', check: none }], { confirmEmpty: true })?.status, 409)
    assert.equal(policyInputProblem([{ field: 'ownerRoutingPolicy', check: none }], { confirmEmpty: true, acceptNarrowed: true }), null)
    const narrowed = policyInputProblem([{ field: 'ownerRoutingPolicy', check: widen }], {})
    assert.equal(narrowed?.status, 409)
    assert.deepEqual(narrowed?.body.error['fields'], ['ownerRoutingPolicy.allowedPeerIds'])
    assert.deepEqual((narrowed?.body.error['effectiveRoutingPolicy'] as { allowedPeerIds: string[] }).allowedPeerIds, [C])
    assert.equal(policyInputProblem([{ field: 'ownerRoutingPolicy', check: widen }], { acceptNarrowed: true }), null)
  } finally {
    cleanup()
  }
})

test('policies that change nothing count as empty', () => {
  assert.equal(isEmptyPolicy({}), true)
  assert.equal(isEmptyPolicy({ sort: 'balanced', preferFreePeers: false, requireVerified: false, requireTee: false, modelRoutes: {} }), true)
  assert.equal(isEmptyPolicy({ sort: 'price' }), false)
  assert.equal(isEmptyPolicy({ allowedPeerIds: [] }), false)
})
