import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ConversationStore, CONVERSATIONS_FILE, conversationId } from './conversation-store.js'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'antseed-conv-'))
}

test('conversation router settings persist independently, clone inputs and clear back to inheritance', async (context) => {
  const dir = await makeDir()
  const store = new ConversationStore(dir)
  context.after(async () => { await store.flush(); await rm(dir, { recursive: true, force: true }) })
  const first = store.touch({ tool: 'vpr', sessionKey: 'first' })
  const second = store.touch({ tool: 'vpr', sessionKey: 'second' })
  const selection = { kind: 'router' as const, service: { peerId: 'a'.repeat(40), provider: 'alpha', serviceId: 'alpha-route' }, costQualityTradeoff: 9 }
  store.setPinnedModel(first.id, 'old-model', 'user')
  store.setRoutingSelection(first.id, selection)
  selection.service.serviceId = 'mutated'
  assert.equal(store.get(first.id)?.routingSelection?.service.serviceId, 'alpha-route')
  assert.equal(store.get(first.id)?.routingSelection?.costQualityTradeoff, 9)
  assert.equal(store.get(first.id)?.pinnedModel, null)
  assert.equal(store.get(first.id)?.peerSource, 'auto')
  assert.equal(store.get(second.id)?.routingSelection, null)
  store.touch({ tool: 'vpr', sessionKey: 'first', lastModel: 'actual-model' })
  store.recordRoutedModel(first.id, 'a'.repeat(40) + '@actual-model')
  await store.flush()
  const reloaded = new ConversationStore(dir)
  assert.deepEqual(reloaded.get(first.id)?.routingSelection, store.get(first.id)?.routingSelection)
  assert.equal(reloaded.get(second.id)?.routingSelection, null)
  reloaded.setRoutingSelection(first.id, null)
  assert.equal(reloaded.get(first.id)?.routingSelection, null)
  assert.equal(reloaded.get(first.id)?.pinnedModel, null)
  await reloaded.flush()
  assert.equal(new ConversationStore(dir).get(first.id)?.routingSelection, null)
})

test('explicit model pins replace router overrides but automatic affinity does not', async (context) => {
  const dir = await makeDir()
  const store = new ConversationStore(dir)
  context.after(async () => { await store.flush(); await rm(dir, { recursive: true, force: true }) })
  const chat = store.touch({ tool: 'vpr', sessionKey: 'first' })
  const selection = { kind: 'router' as const, service: { peerId: 'a'.repeat(40), provider: 'alpha', serviceId: 'alpha-route' } }
  store.setRoutingSelection(chat.id, selection)
  store.setPinnedModel(chat.id, 'automatic-model', 'auto')
  assert.deepEqual(store.get(chat.id)?.routingSelection, selection)
  store.setPinnedModel(chat.id, 'chosen-model', 'user')
  assert.equal(store.get(chat.id)?.routingSelection, null)
  assert.equal(store.get(chat.id)?.pinnedModel, 'chosen-model')
})

test('legacy and malformed persisted conversation overrides load without breaking records', async (context) => {
  const dir = await makeDir()
  context.after(() => rm(dir, { recursive: true, force: true }))
  const invalid = [undefined, null, { kind: 'router' }, { kind: 'model', model: 'model-a' },
    { kind: 'router', service: { peerId: 'invalid', provider: 'alpha', serviceId: 'alpha-route' } }]
  await writeFile(join(dir, CONVERSATIONS_FILE), JSON.stringify({ conversations: invalid.map((routingSelection, index) => ({
    tool: 'vpr', sessionKey: `chat-${index}`, routingSelection, lastActiveAt: Date.now(),
  })) }))
  const store = new ConversationStore(dir)
  assert.equal(store.list().length, invalid.length)
  assert.ok(store.list().every(chat => chat.routingSelection === null))
  assert.throws(() => store.setRoutingSelection('vpr:chat-0', { kind: 'router' } as any), /exact routing-service target/)
})

test('touch creates a conversation and keeps the original snippet', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const created = store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'first prompt' })
    assert.equal(created.id, 'codex:s1')
    assert.equal(created.snippet, 'first prompt')
    assert.equal(created.pinnedModel, null)

    const touched = store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'second prompt', lastModel: 'a'.repeat(40) + '@gpt-5.4' })
    assert.equal(touched.snippet, 'first prompt')
    assert.equal(touched.lastModel, 'a'.repeat(40) + '@gpt-5.4')
    assert.ok(touched.lastActiveAt >= created.lastActiveAt)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('first resolved model becomes the pin and later touches never replace it', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const firstModel = 'a'.repeat(40) + '@gpt-5.4'
    const laterModel = 'b'.repeat(40) + '@glm-5'

    // Created without a resolved model (e.g. a title request): no pin yet.
    const created = store.touch({ tool: 'codex', sessionKey: 's1' })
    assert.equal(created.pinnedModel, null)

    // The first request that resolves a model pins the chat to it.
    const pinned = store.touch({ tool: 'codex', sessionKey: 's1', lastModel: firstModel })
    assert.equal(pinned.pinnedModel, firstModel)

    // A later request served by a different route (default changed) keeps
    // the original pin — the default only steers chats that haven't started.
    const touched = store.touch({ tool: 'codex', sessionKey: 's1', lastModel: laterModel })
    assert.equal(touched.pinnedModel, firstModel)
    assert.equal(touched.lastModel, laterModel)

    // A brand-new chat pins to its first model immediately.
    const fresh = store.touch({ tool: 'codex', sessionKey: 's2', lastModel: laterModel })
    assert.equal(fresh.pinnedModel, laterModel)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('persists to conversations.json and reloads across instances', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    store.touch({ tool: 'opencode', sessionKey: 'ses_a', snippet: 'hello there' })
    store.setLabel(conversationId('opencode', 'ses_a'), '  My   renamed chat  ')
    store.setPinnedModel(conversationId('opencode', 'ses_a'), 'b'.repeat(40) + '@glm-5')
    await store.flush()

    const raw = JSON.parse(await readFile(join(dir, CONVERSATIONS_FILE), 'utf8')) as { conversations: unknown[] }
    assert.equal(raw.conversations.length, 1)

    const reloaded = new ConversationStore(dir)
    const record = reloaded.get('opencode:ses_a')
    assert.ok(record)
    assert.equal(record.label, 'My renamed chat')
    assert.equal(record.snippet, 'hello there')
    assert.equal(reloaded.getPinnedModel('opencode', 'ses_a'), 'b'.repeat(40) + '@glm-5')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reload removes legacy Droid title-helper duplicates without merging real chats', async () => {
  const dir = await makeDir()
  try {
    const { writeFile } = await import('node:fs/promises')
    const now = Date.now()
    const record = (sessionKey: string, inputTokens: string, createdAt: number, overrides: Record<string, unknown> = {}) => ({
      tool: 'droid',
      sessionKey,
      snippet: 'same first prompt',
      inputTokens,
      createdAt,
      lastActiveAt: createdAt,
      ...overrides,
    })
    await writeFile(join(dir, CONVERSATIONS_FILE), JSON.stringify({
      conversations: [
        record('title', '301', now),
        record('chat', '14802', now + 218),
        record('reused-title', '2400', now - 86_400_000, { requestCount: 8, peerSource: 'user' }),
        record('reused-chat', '29602', now + 10_000, { requestCount: 2 }),
        record('unmatched-small-chat', '301', now + 15_000, { snippet: 'different prompt' }),
        record('same-size-chat', '14802', now + 20_000),
        record('same-size-chat-2', '14900', now + 20_100),
        record('named-title', '301', now + 30_000, { label: 'Keep me' }),
        record('named-chat', '14802', now + 30_100),
        { ...record('codex-title', '301', now), tool: 'codex' },
        { ...record('codex-chat', '14802', now + 100), tool: 'codex' },
      ],
    }), 'utf8')

    const store = new ConversationStore(dir)
    assert.equal(store.get('droid:title'), null)
    assert.ok(store.get('droid:chat'))
    assert.equal(store.get('droid:reused-title'), null)
    assert.ok(store.get('droid:reused-chat'))
    assert.ok(store.get('droid:unmatched-small-chat'))
    assert.ok(store.get('droid:same-size-chat'))
    assert.ok(store.get('droid:same-size-chat-2'))
    assert.equal(store.get('droid:named-title')?.label, 'Keep me')
    assert.ok(store.get('codex:codex-title'))
    assert.ok(store.get('codex:codex-chat'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('label can be cleared and pin can be cleared', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    store.touch({ tool: 'claude-code', sessionKey: 'k1' })
    const id = conversationId('claude-code', 'k1')
    store.setLabel(id, 'named')
    store.setPinnedModel(id, 'c'.repeat(40) + '@claude-opus-4-8')
    assert.equal(store.setLabel(id, null)?.label, null)
    assert.equal(store.setPinnedModel(id, null)?.pinnedModel, null)
    assert.equal(store.setLabel('unknown:id', 'x'), null)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('peerSource marks user-chosen pins, resets on clear, survives reload', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const id = conversationId('codex', 's1')

    // Auto-pinned on first request: source is 'auto'.
    const pinned = store.touch({ tool: 'codex', sessionKey: 's1', lastModel: 'a'.repeat(40) + '@gpt-5.4' })
    assert.equal(pinned.peerSource, 'auto')

    // Default: a re-pin without an explicit source stays 'auto'.
    assert.equal(store.setPinnedModel(id, 'b'.repeat(40) + '@gpt-5.4')?.peerSource, 'auto')

    // An explicit per-chat seller choice is marked 'user' and persists.
    assert.equal(store.setPinnedModel(id, 'c'.repeat(40) + '@gpt-5.4', 'user')?.peerSource, 'user')
    await store.flush()
    assert.equal(new ConversationStore(dir).get(id)?.peerSource, 'user')

    // Later activity keeps the user's choice.
    assert.equal(store.touch({ tool: 'codex', sessionKey: 's1', lastModel: 'd'.repeat(40) + '@gpt-5.4' }).peerSource, 'user')

    // Clearing the pin has no peer left to attribute — source resets.
    assert.equal(store.setPinnedModel(id, null, 'user')?.peerSource, 'auto')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('remove deletes the record; a later touch recreates it fresh', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'old snippet' })
    assert.equal(store.remove('codex:s1'), true)
    assert.equal(store.remove('codex:s1'), false)
    assert.equal(store.get('codex:s1'), null)

    const recreated = store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'new snippet' })
    assert.equal(recreated.snippet, 'new snippet')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('prunes beyond the LRU cap, keeping the most recently active', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    for (let i = 0; i < 60; i += 1) {
      store.touch({ tool: 'codex', sessionKey: `s${i}` })
    }
    const listed = store.list()
    assert.equal(listed.length, 50)
    // The earliest-touched sessions are the ones evicted.
    assert.equal(store.get('codex:s59') !== null, true)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('list returns newest activity first', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    store.touch({ tool: 'codex', sessionKey: 'older' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.touch({ tool: 'codex', sessionKey: 'newer' })
    const [first] = store.list()
    assert.equal(first?.sessionKey, 'newer')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('survives a corrupted file by starting clean', async () => {
  const dir = await makeDir()
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, CONVERSATIONS_FILE), 'not json at all', 'utf8')
    const store = new ConversationStore(dir)
    assert.deepEqual(store.list(), [])
    store.touch({ tool: 'codex', sessionKey: 's1' })
    await store.flush()
    const reloaded = new ConversationStore(dir)
    assert.equal(reloaded.list().length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reload re-cleans snippets persisted by older extraction rules', async () => {
  const dir = await makeDir()
  try {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, CONVERSATIONS_FILE), JSON.stringify({
      conversations: [
        {
          tool: 'claude-code', sessionKey: 'old1',
          snippet: '<session> try to understand who reviews are from </session> and more text',
          createdAt: Date.now(), lastActiveAt: Date.now(),
        },
        {
          tool: 'opencode', sessionKey: 'old2',
          snippet: 'Generate a title for this conversation:',
          createdAt: Date.now(), lastActiveAt: Date.now(),
        },
        {
          tool: 'public-tunnel', sessionKey: 'old3',
          snippet: 'OS Version: darwin 25.2.0 Shell: zsh Workspace Path: unknown Is directory a git…',
          createdAt: Date.now(), lastActiveAt: Date.now(),
        },
        {
          tool: 'codex-desktop', sessionKey: 'old4',
          snippet: 'Here is a list of plugins that are available but not installed. - Airtable…',
          createdAt: Date.now(), lastActiveAt: Date.now(),
        },
      ],
    }), 'utf8')
    const store = new ConversationStore(dir)
    assert.equal(store.get('claude-code:old1')?.snippet, 'try to understand who reviews are from and more text')
    // Old title-request snippets are dropped so the next real turn names the chat.
    assert.equal(store.get('opencode:old2')?.snippet, '')
    assert.equal(store.get('public-tunnel:old3'), null)
    assert.equal(store.get('cursor:old3')?.snippet, '')
    assert.equal(store.get('codex-desktop:old4')?.snippet, '')
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('addSpend accumulates cost and counts requests only when told to', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const created = store.touch({ tool: 'codex', sessionKey: 's1', snippet: 'hello' })
    assert.equal(created.spentUsdc, '0')
    assert.equal(created.requestCount, 0)

    store.addSpend(created.id, { amountUsdc: '12000', inputTokens: '900', cachedInputTokens: '600', outputTokens: '120' })
    // A second delta for the same request: cost adds up, the request does not.
    store.addSpend(created.id, { amountUsdc: '3000', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0' }, false)
    store.addSpend(created.id, { amountUsdc: '5000', inputTokens: '100', cachedInputTokens: '25', outputTokens: '40' })

    const row = store.get(created.id)
    assert.equal(row?.spentUsdc, '20000')
    assert.equal(row?.inputTokens, '1000')
    assert.equal(row?.cachedInputTokens, '625')
    assert.equal(row?.outputTokens, '160')
    assert.equal(row?.requestCount, 2)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('addSpend ignores unknown ids, empty deltas and malformed amounts', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const created = store.touch({ tool: 'codex', sessionKey: 's1' })

    // A chat pruned mid-request must not come back as a spend-only row.
    store.addSpend('codex:gone', { amountUsdc: '5000', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0' })
    assert.equal(store.get('codex:gone'), null)

    store.addSpend(created.id, { amountUsdc: '0', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0' })
    store.addSpend(created.id, { amountUsdc: 'not-a-number', inputTokens: '0', cachedInputTokens: '0', outputTokens: '0' })
    const row = store.get(created.id)
    assert.equal(row?.spentUsdc, '0')
    assert.equal(row?.requestCount, 0)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('spend counters survive a reload and heal from corrupt values', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const created = store.touch({ tool: 'codex', sessionKey: 's1' })
    store.addSpend(created.id, { amountUsdc: '7500', inputTokens: '10', cachedInputTokens: '4', outputTokens: '5' })
    // addSpend defers persistence to the next touch, mirroring live traffic.
    store.touch({ tool: 'codex', sessionKey: 's1' })
    await store.flush()

    const reloaded = new ConversationStore(dir)
    assert.equal(reloaded.get(created.id)?.spentUsdc, '7500')
    assert.equal(reloaded.get(created.id)?.cachedInputTokens, '4')
    assert.equal(reloaded.get(created.id)?.requestCount, 1)

    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, CONVERSATIONS_FILE), JSON.stringify({
      conversations: [{
        tool: 'codex', sessionKey: 's2', spentUsdc: 'garbage', cachedInputTokens: null, requestCount: -3,
        createdAt: Date.now(), lastActiveAt: Date.now(),
      }],
    }), 'utf8')
    const healed = new ConversationStore(dir)
    assert.equal(healed.get(conversationId('codex', 's2'))?.spentUsdc, '0')
    assert.equal(healed.get(conversationId('codex', 's2'))?.cachedInputTokens, '0')
    assert.equal(healed.get(conversationId('codex', 's2'))?.requestCount, 0)
    await healed.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cached input is clamped to the input it is a subset of', async () => {
  const dir = await makeDir()
  try {
    const store = new ConversationStore(dir)
    const created = store.touch({ tool: 'codex', sessionKey: 's1' })

    // A seller reporting more cached than total input is malformed — the
    // subset must never exceed the whole it is measured against.
    store.addSpend(created.id, { amountUsdc: '1000', inputTokens: '50', cachedInputTokens: '900', outputTokens: '10' })
    const row = store.get(created.id)
    assert.equal(row?.inputTokens, '50')
    assert.equal(row?.cachedInputTokens, '50')

    // Fresh input stays derivable as inputTokens - cachedInputTokens.
    store.addSpend(created.id, { amountUsdc: '1000', inputTokens: '200', cachedInputTokens: '150', outputTokens: '10' })
    const after = store.get(created.id)
    assert.equal(BigInt(after!.inputTokens) - BigInt(after!.cachedInputTokens), 50n)
    await store.flush()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
