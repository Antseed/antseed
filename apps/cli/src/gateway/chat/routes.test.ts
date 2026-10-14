import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import * as http from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import { addActiveMember, call, FakeConsoleAuth, memberPrincipal, startConsole, tempDataDir, testDeps } from '../console-api/test-support.js'
import { CHAT_KEY_LABEL, chatRouteRegistrar, estimateCost } from './routes.js'

const PEER = 'ab'.repeat(20)

interface Upstream { port: number; requests: Array<{ path: string; auth: string; body: any }>; close: () => Promise<void> }

/** A stand-in for the gateway's own /v1: one model, a tool call on the first turn, text after the tool result. */
async function fakeGateway(
  validKey: (keyId: string, control: string) => boolean,
  onTurn: () => void = () => {},
  toolCall: { name: string; arguments: string } = { name: 'list_files', arguments: '{}' },
): Promise<Upstream> {
  const requests: Upstream['requests'] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const auth = String(req.headers['x-antseed-gateway-key'] ?? '')
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
      requests.push({ path: req.url ?? '', auth, body })
      if (!validKey(auth, String(req.headers['x-antseed-gateway-auth'] ?? ''))) { res.writeHead(401).end('{}'); return }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'agent-model', name: 'Agent Model', type: 'text', capability_coverage: { tool_use: 1 }, peers: [{ peerId: PEER, displayName: 'Peer One', capabilities: { toolUse: true }, inputUsdPerMillion: 2, outputUsdPerMillion: 10 }] }] }))
        return
      }
      onTurn()
      const last = body.messages[body.messages.length - 1]
      const toolTurn = last.role !== 'tool' && !String(JSON.stringify(last.content)).includes('second question')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-antseed-peer-id': PEER })
      const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      if (toolTurn) {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: toolCall }] })
        send({}, 'tool_calls')
      } else {
        send({ role: 'assistant', content: last.role === 'tool' ? 'Your scratch space is empty.' : 'Second answer.' })
        send({}, 'stop')
      }
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } })}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as { port: number }).port, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

test('POST /chat runs the agent through the gateway with the member\'s Web chat key and names the peer that answered', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const workspace = store.ensureWorkspaceForIdentity(DEFAULT_BUYER_IDENTITY)
  const member = addActiveMember(store, 'Dana', { workspaces: [{ workspaceId: workspace.id, role: 'member' }] })
  const auth = new FakeConsoleAuth()
  auth.as('dana', memberPrincipal(store, member.id))
  // The conversation is listed before the first model call returns.
  const listedDuringTurn: boolean[] = []
  const upstream = await fakeGateway(
    (keyId, control) => control === 'test-secret' && store.getKey(keyId)?.status === 'active',
    () => listedDuringTurn.push(store.getChatThread('chat_1') !== null),
  )
  const server = await startConsole(testDeps(store, dir), auth, [chatRouteRegistrar({ gatewayPort: () => upstream.port })])
  try {
    const models = await call(server.port, 'GET', `/console/api/chat/models?workspace=${workspace.id}`, { who: 'dana' })
    assert.equal(models.status, 200)
    assert.deepEqual((models.body as Array<{ id: string; peers: Array<{ name: string }> }>).map((m) => [m.id, m.peers[0]?.name]), [['agent-model', 'Peer One']])

    const reply = await call(server.port, 'POST', '/console/api/chat', {
      who: 'dana',
      body: { workspaceId: workspace.id, model: 'agent-model', peerId: PEER, id: 'chat_1', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'What is in my scratch space?' }] }] },
    })
    assert.equal(reply.status, 200)
    assert.match(String(reply.headers['content-type']), /text\/event-stream/)
    const events = reply.text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)))
    const types = events.map((event) => event.type)
    assert.ok(types.includes('tool-input-available') && types.includes('tool-output-available'), types.join(','))
    assert.equal(events.find((event) => event.type === 'tool-output-available').output.files.length, 0)
    assert.ok(events.some((event) => event.type === 'text-delta' && /scratch space is empty/.test(event.delta)))
    const finish = events.find((event) => event.type === 'finish')
    // Two calls of 1,000 in / 100 out tokens at $2 / $10 per million: $0.003 each.
    assert.deepEqual(finish.messageMetadata, {
      model: 'agent-model', pinnedPeerId: PEER, peers: [{ peerId: PEER, name: 'Peer One' }],
      usage: { inputTokens: 2000, cachedInputTokens: 0, outputTokens: 200 }, costUsd: 0.006,
    })
    assert.deepEqual(listedDuringTurn, [true, true])

    // The key that pays, as the chat shows it.
    const context = await call(server.port, 'GET', `/console/api/chat/context?workspace=${workspace.id}`, { who: 'dana' })
    assert.equal(context.status, 200)
    assert.equal((context.body as { key: { label: string; ownerMemberId: string } }).key.label, CHAT_KEY_LABEL)
    assert.equal((context.body as { key: { ownerMemberId: string } }).key.ownerMemberId, member.id)
    assert.equal((context.body as { workspaceName: string }).workspaceName, workspace.name)

    // Both model calls were pinned (`peer@model`) and made as one Web chat key owned by the member.
    const turns = upstream.requests.filter((request) => request.path === '/v1/chat/completions')
    assert.equal(turns.length, 2)
    assert.ok(turns.every((turn) => turn.body.model === `${PEER}@agent-model`))
    const keys = store.listKeys({ workspaceId: workspace.id, ownerMemberId: member.id })
    assert.deepEqual(keys.map((key) => [key.label, key.status]), [[CHAT_KEY_LABEL, 'active']])
    assert.ok(turns.every((turn) => turn.auth === keys[0]!.id))
    // A member gets no shell.
    assert.ok(!JSON.stringify(turns[0]!.body.tools).includes('run_command'))

    // The conversation was saved; a follow-up sends only its new message and the model sees the whole history.
    const threads = await call(server.port, 'GET', `/console/api/chat/threads?workspace=${workspace.id}`, { who: 'dana' })
    assert.deepEqual((threads.body as Array<{ id: string; title: string; peerId: string }>).map((t) => [t.id, t.title, t.peerId]), [['chat_1', 'What is in my scratch space?', PEER]])
    const followUp = await call(server.port, 'POST', '/console/api/chat', {
      who: 'dana',
      body: { workspaceId: workspace.id, model: 'agent-model', id: 'chat_1', messages: [{ id: 'u2', role: 'user', parts: [{ type: 'text', text: 'And a second question?' }] }] },
    })
    assert.equal(followUp.status, 200)
    const third = upstream.requests.filter((request) => request.path === '/v1/chat/completions')[2]!
    assert.deepEqual(third.body.messages.map((m: { role: string }) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
    const saved = await call(server.port, 'GET', `/console/api/chat/threads/chat_1?workspace=${workspace.id}`, { who: 'dana' })
    assert.equal((saved.body as { messages: unknown[] }).messages.length, 4)
    assert.equal((await call(server.port, 'DELETE', `/console/api/chat/threads/chat_1?workspace=${workspace.id}`, { who: 'dana' })).status, 204)
    assert.equal((await call(server.port, 'GET', `/console/api/chat/threads/chat_1?workspace=${workspace.id}`, { who: 'dana' })).status, 404)
  } finally {
    await server.close()
    await upstream.close()
    cleanup()
  }
})

test('POST /chat refuses outsiders and bad input', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const workspace = store.ensureWorkspaceForIdentity(DEFAULT_BUYER_IDENTITY)
  const outsider = addActiveMember(store, 'Out', { workspaces: [] })
  const member = addActiveMember(store, 'Dana', { workspaces: [{ workspaceId: workspace.id, role: 'member' }] })
  const auth = new FakeConsoleAuth()
  auth.as('out', memberPrincipal(store, outsider.id))
  auth.as('dana', memberPrincipal(store, member.id))
  auth.as('token', { kind: 'token', tokenId: 't', scope: 'admin' })
  const server = await startConsole(testDeps(store, dir), auth, [chatRouteRegistrar({ gatewayPort: () => 1 })])
  try {
    const body = { workspaceId: workspace.id, model: 'm', id: 'c1', messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }
    assert.equal((await call(server.port, 'POST', '/console/api/chat', { who: 'out', body })).status, 403)
    assert.equal((await call(server.port, 'POST', '/console/api/chat', { who: 'token', bearer: true, body })).status, 403)
    assert.equal((await call(server.port, 'POST', '/console/api/chat', { who: 'dana', body: { ...body, model: '' } })).status, 400)
    assert.equal((await call(server.port, 'POST', '/console/api/chat', { who: 'dana', body: { ...body, messages: [] } })).status, 400)
  } finally {
    await server.close()
    cleanup()
  }
})

test('an API-key session chats as that key, with its own history', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const workspace = store.ensureWorkspaceForIdentity(DEFAULT_BUYER_IDENTITY)
  const { key } = store.createKey({ label: 'laptop', workspaceId: workspace.id, ownerMemberId: null, limits: { daily: null, monthly: null, total: null }, expiresAt: null })
  const other = addActiveMember(store, 'Dana', { workspaces: [{ workspaceId: workspace.id, role: 'member' }] })
  const auth = new FakeConsoleAuth()
  auth.as('laptop', { kind: 'key', keyId: key.id, sessionId: 's-key' })
  auth.as('dana', memberPrincipal(store, other.id))
  const upstream = await fakeGateway((keyId, control) => control === 'test-secret' && store.getKey(keyId)?.status === 'active')
  const server = await startConsole(testDeps(store, dir), auth, [chatRouteRegistrar({ gatewayPort: () => upstream.port })])
  try {
    const reply = await call(server.port, 'POST', '/console/api/chat', {
      who: 'laptop',
      body: { model: 'agent-model', id: 'cli_1', messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] },
    })
    assert.equal(reply.status, 200)
    assert.ok(upstream.requests.filter((r) => r.path === '/v1/chat/completions').every((r) => r.auth === key.id))
    assert.deepEqual((await call(server.port, 'GET', '/console/api/chat/threads', { who: 'laptop' })).body, [
      { id: 'cli_1', title: 'hi', model: 'agent-model', peerId: null, createdAt: (store.getChatThread('cli_1')!).createdAt, updatedAt: (store.getChatThread('cli_1')!).updatedAt },
    ])
    // Someone else cannot read or continue it.
    assert.deepEqual((await call(server.port, 'GET', `/console/api/chat/threads?workspace=${workspace.id}`, { who: 'dana' })).body, [])
    assert.equal((await call(server.port, 'GET', `/console/api/chat/threads/cli_1?workspace=${workspace.id}`, { who: 'dana' })).status, 404)
    const hijack = await call(server.port, 'POST', '/console/api/chat', {
      who: 'dana',
      body: { workspaceId: workspace.id, model: 'agent-model', id: 'cli_1', messages: [{ id: 'u9', role: 'user', parts: [{ type: 'text', text: 'mine now' }] }] },
    })
    assert.equal(hijack.status, 404)
  } finally {
    await server.close()
    await upstream.close()
    cleanup()
  }
})

test('the chat models list is cached per chat key, since each key\'s policy narrows it', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const workspace = store.ensureWorkspaceForIdentity(DEFAULT_BUYER_IDENTITY)
  const { key } = store.createKey({ label: 'laptop', workspaceId: workspace.id, ownerMemberId: null, limits: { daily: null, monthly: null, total: null }, expiresAt: null })
  const member = addActiveMember(store, 'Dana', { workspaces: [{ workspaceId: workspace.id, role: 'member' }] })
  const auth = new FakeConsoleAuth()
  auth.as('laptop', { kind: 'key', keyId: key.id, sessionId: 's-key' })
  auth.as('dana', memberPrincipal(store, member.id))
  const upstream = await fakeGateway((keyId, control) => control === 'test-secret' && store.getKey(keyId)?.status === 'active')
  const server = await startConsole(testDeps(store, dir), auth, [chatRouteRegistrar({ gatewayPort: () => upstream.port })])
  try {
    for (const who of ['dana', 'laptop', 'dana', 'laptop']) {
      assert.equal((await call(server.port, 'GET', `/console/api/chat/models?workspace=${workspace.id}`, { who })).status, 200)
    }
    const listings = upstream.requests.filter((request) => request.path === '/v1/models')
    assert.equal(listings.length, 2)
    assert.equal(new Set(listings.map((request) => request.auth)).size, 2)
  } finally {
    await server.close()
    await upstream.close()
    cleanup()
  }
})

test('an org admin chats in a workspace they do not belong to with an unowned key in their name', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const workspace = store.ensureWorkspaceForIdentity(DEFAULT_BUYER_IDENTITY)
  const admin = addActiveMember(store, 'Ada', { orgRole: 'admin', workspaces: [] })
  const auth = new FakeConsoleAuth()
  auth.as('ada', memberPrincipal(store, admin.id))
  const upstream = await fakeGateway((keyId, control) => control === 'test-secret' && store.getKey(keyId)?.status === 'active')
  const server = await startConsole(testDeps(store, dir), auth, [chatRouteRegistrar({ gatewayPort: () => upstream.port })])
  try {
    assert.equal((await call(server.port, 'GET', `/console/api/chat/models?workspace=${workspace.id}`, { who: 'ada' })).status, 200)
    const keys = store.listKeys({ workspaceId: workspace.id }).filter((key) => key.label.startsWith(CHAT_KEY_LABEL))
    assert.deepEqual(keys.map((key) => [key.label, key.ownerMemberId]), [[`${CHAT_KEY_LABEL} (Ada)`, null]])
    // Reused, not recreated.
    await call(server.port, 'GET', `/console/api/chat/threads?workspace=${workspace.id}`, { who: 'ada' })
    assert.equal(store.listKeys({ workspaceId: workspace.id }).filter((key) => key.label.startsWith(CHAT_KEY_LABEL)).length, 1)
  } finally {
    await server.close()
    await upstream.close()
    cleanup()
  }
})

test('an admin\'s shell command runs only after they approve that exact call', async () => {
  const { dir, store, cleanup } = tempDataDir()
  const workspace = store.ensureWorkspaceForIdentity(DEFAULT_BUYER_IDENTITY)
  const admin = addActiveMember(store, 'Ada', { orgRole: 'admin', workspaces: [{ workspaceId: workspace.id, role: 'admin' }] })
  const auth = new FakeConsoleAuth()
  auth.as('ada', memberPrincipal(store, admin.id))
  // The seller's model asks for a command; it must not run on its say-so.
  const upstream = await fakeGateway((keyId, control) => control === 'test-secret' && store.getKey(keyId)?.status === 'active', () => {}, { name: 'run_command', arguments: JSON.stringify({ command: 'touch ran' }) })
  const server = await startConsole(testDeps(store, dir), auth, [chatRouteRegistrar({ gatewayPort: () => upstream.port })])
  const scratch = (threadId: string) => join(dir, 'gateway', 'chat', admin.id, threadId)
  const events = (text: string) => text.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)))
  const ask = (threadId: string) => call(server.port, 'POST', '/console/api/chat', {
    who: 'ada',
    body: { workspaceId: workspace.id, model: 'agent-model', id: threadId, messages: [{ id: `u-${threadId}`, role: 'user', parts: [{ type: 'text', text: 'Run something' }] }] },
  })
  /** The stored open answer, with the client's decision on its approval request (and optionally a tampered command). */
  const answer = (threadId: string, approved: boolean, command?: string) => {
    const open = store.getChatThread(threadId)!.messages.at(-1) as { id: string; parts: Array<Record<string, any>> }
    const parts = open.parts.map((part) => (part['state'] === 'approval-requested'
      ? { ...part, state: 'approval-responded', approval: { ...part['approval'], approved }, ...(command ? { input: { command } } : {}) }
      : part))
    return call(server.port, 'POST', '/console/api/chat', { who: 'ada', body: { workspaceId: workspace.id, model: 'agent-model', id: threadId, messages: [{ ...open, role: 'assistant', parts }] } })
  }
  const completions = () => upstream.requests.filter((request) => request.path === '/v1/chat/completions').length
  try {
    await call(server.port, 'GET', `/console/api/chat/models?workspace=${workspace.id}`, { who: 'ada' })

    // Asked: the answer stops at an approval request; nothing ran.
    const asked = events((await ask('t_deny')).text)
    assert.ok(asked.some((event) => event.type === 'tool-approval-request'), asked.map((event) => event.type).join(','))
    assert.ok(!asked.some((event) => event.type === 'tool-output-available'))
    assert.equal(existsSync(join(scratch('t_deny'), 'ran')), false)
    const pending = store.getChatThread('t_deny')!.messages.at(-1) as { parts: Array<{ state?: string; approval?: { signature?: string } }> }
    assert.ok(pending.parts.some((part) => part.state === 'approval-requested' && typeof part.approval?.signature === 'string'))

    // Denied: it does not run, and the model is told.
    const turnsBefore = completions()
    const denied = await answer('t_deny', false)
    assert.equal(denied.status, 200)
    assert.ok(events(denied.text).some((event) => event.type === 'tool-output-denied'))
    assert.equal(existsSync(join(scratch('t_deny'), 'ran')), false)
    assert.equal(completions(), turnsBefore + 1)
    // The decision cannot be replayed as an approval: the request is closed.
    assert.equal((await answer('t_deny', true)).status, 400)
    assert.equal(existsSync(join(scratch('t_deny'), 'ran')), false)

    // Approved: the stored command runs (not one the client rewrote), once.
    await ask('t_ok')
    assert.equal(existsSync(join(scratch('t_ok'), 'ran')), false)
    const approved = await answer('t_ok', true, 'touch tampered')
    assert.equal(approved.status, 200)
    const output = events(approved.text).find((event) => event.type === 'tool-output-available')
    assert.ok(output, approved.text)
    assert.equal(output.output.exitCode, 0)
    assert.equal(existsSync(join(scratch('t_ok'), 'ran')), true)
    assert.equal(existsSync(join(scratch('t_ok'), 'tampered')), false)
    assert.equal((await answer('t_ok', true)).status, 400)

    // An approval left in stored history (an answer cut off before it ran) never runs on a later turn.
    await ask('t_stale')
    const thread = store.getChatThread('t_stale')!
    const messages = thread.messages.map((message: any, index: number) => (index === thread.messages.length - 1
      ? { ...message, parts: message.parts.map((part: any) => (part.state === 'approval-requested' ? { ...part, state: 'approval-responded', approval: { ...part.approval, approved: true } } : part)) }
      : message))
    store.saveChatThread({ id: 't_stale', owner: { ...thread.owner, workspaceId: thread.workspaceId }, title: thread.title, model: thread.model, peerId: thread.peerId, messages })
    const later = await call(server.port, 'POST', '/console/api/chat', {
      who: 'ada',
      body: { workspaceId: workspace.id, model: 'agent-model', id: 't_stale', messages: [{ id: 'u-later', role: 'user', parts: [{ type: 'text', text: 'And a second question?' }] }] },
    })
    assert.equal(later.status, 200)
    assert.equal(existsSync(join(scratch('t_stale'), 'ran')), false)
    // Nor by answering it again.
    assert.equal((await answer('t_stale', true)).status, 400)
    assert.equal(existsSync(join(scratch('t_stale'), 'ran')), false)
  } finally {
    await server.close()
    await upstream.close()
    cleanup()
  }
})

test('estimateCost prices each token kind at the serving peer\'s advertised rates', () => {
  const peer = { inputUsdPerMillion: 2, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.5 }
  assert.equal(estimateCost({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 }, peer), (600 * 2 + 400 * 0.5 + 100 * 10) / 1_000_000)
  assert.equal(estimateCost({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 0 }, { ...peer, cachedInputUsdPerMillion: null }), 1000 * 2 / 1_000_000)
  assert.equal(estimateCost({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 1 }, undefined), null)
  assert.equal(estimateCost({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, undefined), 0)
})
