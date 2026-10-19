import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeDesktopRoute, claudeDesktopSubpath, type ClaudeDesktopModel } from './claude-desktop-route.js'

type ModelsBody = { data: { id: string; display_name: string; description: string; anthropic_family_tier: string; is_family_default: boolean }[] }

async function withRoute(fn: (route: ClaudeDesktopRoute, stateFile: string) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-claude-desktop-'))
  try {
    const stateFile = join(dir, 'claude-desktop.slots.json')
    await fn(new ClaudeDesktopRoute(stateFile), stateFile)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function listed(route: ClaudeDesktopRoute, ranked: ClaudeDesktopModel[]): ModelsBody['data'] {
  return (route.modelsResponse(ranked) as ModelsBody).data
}

function routedModel(route: ClaudeDesktopRoute, model: string): unknown {
  const body = route.rewriteRequest(Buffer.from(JSON.stringify({ model })), { routingNote: false })
  return (JSON.parse(body.toString()) as Record<string, unknown>)['model']
}

const models = (...ids: string[]): ClaudeDesktopModel[] => ids.map((id) => ({ label: id.toUpperCase(), model: id }))
/** Claude's display names: network models carry an "(Antseed)" suffix. */
const names = (data: ModelsBody['data']): string[] => data.map((entry) => entry.display_name.replace(/ \(Antseed\)$/, ''))

test('claudeDesktopSubpath strips the prefix and ignores other paths', () => {
  assert.equal(claudeDesktopSubpath('/claude-desktop/v1/models?limit=1000'), '/v1/models')
  assert.equal(claudeDesktopSubpath('/claude-desktop/v1/messages'), '/v1/messages')
  assert.equal(claudeDesktopSubpath('/claude-desktopx/v1/models'), null)
  assert.equal(claudeDesktopSubpath('/v1/messages'), null)
})

test('without models only Antseed Auto is listed', async () => {
  await withRoute((route) => {
    const data = listed(route, [])
    assert.deepEqual(data.map((entry) => [entry.id, entry.display_name]), [['claude-fable-5', 'Antseed Auto']])
  })
})

test('curated models fill the remaining Claude ids in order', async () => {
  await withRoute((route) => {
    const data = listed(route, models('kimi-k3', 'glm-5', 'qwen3', 'gpt-oss', 'deepseek', 'extra'))
    assert.deepEqual(names(data), ['Antseed Auto', 'KIMI-K3', 'GLM-5', 'QWEN3', 'GPT-OSS', 'DEEPSEEK'])
    assert.deepEqual(data.map((entry) => entry.id), ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'])
    assert.equal(data[1]!.anthropic_family_tier, 'opus')
  })
})

test('Auto describes the AI VPN selection, and network models are named (Antseed) with a dash for a description', async () => {
  await withRoute((route) => {
    const [auto, kimi] = listed(route, models('kimi-k3'))
    assert.equal(auto!.display_name, 'Antseed Auto')
    assert.equal(auto!.description, 'Uses the model selected in the AI VPN')
    assert.equal(auto!.is_family_default, true)
    assert.equal(kimi!.display_name, 'KIMI-K3 (Antseed)')
    assert.equal(kimi!.description, '-')
  })
})

test('the curated order decides which models are listed, and their order', async () => {
  await withRoute((route) => {
    // Models named like Claude ids do not jump ahead of earlier picks.
    const curated = models('claude-opus-5-5', 'claude-opus-5', 'gpt-5.6-sol', 'claude-fable-5', 'gpt-5.6-luna', 'claude-sonnet-5', 'kimi-k3')
    const data = listed(route, curated)
    assert.deepEqual(names(data),
      ['Antseed Auto', 'CLAUDE-OPUS-5-5', 'CLAUDE-OPUS-5', 'GPT-5.6-SOL', 'CLAUDE-FABLE-5', 'GPT-5.6-LUNA'])
    for (const entry of data.slice(1)) assert.equal(routedModel(route, entry.id), entry.display_name.replace(/ \(Antseed\)$/, '').toLowerCase())
  })
})

test('bindings stay on their id when the order changes, and freed ids are reused', async () => {
  await withRoute((route) => {
    listed(route, models('a', 'b', 'c'))
    const reordered = listed(route, models('c', 'a', 'b'))
    assert.deepEqual(names(reordered), ['Antseed Auto', 'C', 'A', 'B'])
    assert.equal(routedModel(route, 'claude-opus-5'), 'a')
    assert.equal(routedModel(route, 'claude-sonnet-5'), 'b')

    const replaced = listed(route, models('a', 'd', 'c'))
    assert.deepEqual(names(replaced), ['Antseed Auto', 'A', 'D', 'C'])
    assert.equal(routedModel(route, 'claude-sonnet-5'), 'd')
  })
})

test('a network model named like a free Claude id takes that id', async () => {
  await withRoute((route) => {
    const data = listed(route, models('x', 'claude-sonnet-5'))
    assert.equal(data.find((entry) => entry.id === 'claude-sonnet-5')?.display_name, 'CLAUDE-SONNET-5 (Antseed)')
    assert.equal(routedModel(route, 'claude-sonnet-5'), 'claude-sonnet-5')
  })
})

test('a slot file from before Auto moved is remapped onto the curated order', async () => {
  await withRoute(async (_route, stateFile) => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(stateFile, JSON.stringify({ slots: {
      'claude-opus-5': { model: 'claude-opus-5', label: 'Claude Opus 5' },
      'claude-sonnet-5': { model: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      'claude-sonnet-4-6': { model: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      'claude-haiku-4-5-20251001': { model: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
      'claude-fable-5': { model: 'claude-fable-5', label: 'Claude Fable 5' },
    } }))
    const route = new ClaudeDesktopRoute(stateFile)
    const data = listed(route, models('claude-opus-5-5', 'claude-opus-5', 'gpt-5.6-sol', 'claude-fable-5', 'gpt-5.6-luna', 'claude-sonnet-5'))
    assert.deepEqual(names(data),
      ['Antseed Auto', 'CLAUDE-OPUS-5-5', 'CLAUDE-OPUS-5', 'GPT-5.6-SOL', 'CLAUDE-FABLE-5', 'GPT-5.6-LUNA'])
    // Old ids move to newer ones (Claude's Auto mode is off for 4.6 and Haiku ids), keeping their model.
    assert.ok(!data.some((entry) => /4-6|haiku/.test(entry.id)))
    assert.equal(routedModel(route, 'claude-opus-5-5'), 'claude-opus-5-5')
    assert.equal(routedModel(route, 'claude-sonnet-5-5'), 'gpt-5.6-sol')
    // claude-fable-5 is Auto's id: the model bound to it moves to claude-fable-5-1.
    assert.equal(data[0]!.id, 'claude-fable-5')
    assert.equal(routedModel(route, 'claude-fable-5'), 'antseed')
    assert.equal(routedModel(route, 'claude-fable-5-1'), 'claude-fable-5')
    // Chats Claude saved on an old id still reach the same model.
    assert.equal(routedModel(route, 'claude-sonnet-4-6'), 'claude-opus-5-5')
    assert.equal(routedModel(route, 'claude-haiku-4-5-20251001'), 'gpt-5.6-sol')
  })
})

test('slot bindings survive a restart', async () => {
  await withRoute((route, stateFile) => {
    listed(route, models('a', 'b'))
    const restarted = new ClaudeDesktopRoute(stateFile)
    assert.equal(routedModel(restarted, 'claude-opus-5'), 'a')
    assert.equal(routedModel(restarted, 'claude-sonnet-5'), 'b')
  })
})

test('messages route by slot, keep pins and the alias, and fall back to the alias', async () => {
  await withRoute((route) => {
    listed(route, models('kimi-k3'))
    assert.equal(routedModel(route, 'claude-opus-5'), 'kimi-k3')
    assert.equal(routedModel(route, 'claude-fable-5'), 'antseed')
    assert.equal(routedModel(route, 'claude-auto'), 'antseed')
    assert.equal(routedModel(route, 'claude-sonnet-5-5'), 'antseed')
    assert.equal(routedModel(route, '0x1111111111111111111111111111111111111111@kimi-k3'), '0x1111111111111111111111111111111111111111@kimi-k3')
    assert.equal(route.rewriteRequest(Buffer.from('not json'), { routingNote: true }).toString(), 'not json')
  })
})

test('the routing note is appended as the last system block', async () => {
  await withRoute((route) => {
    const body = route.rewriteRequest(Buffer.from(JSON.stringify({ model: 'antseed', system: [{ type: 'text', text: 'hi' }] })), { routingNote: true })
    const system = (JSON.parse(body.toString()) as { system: { text: string }[] }).system
    assert.equal(system.length, 2)
    assert.match(system[1]!.text, /Antseed peer-to-peer network/)
  })
})

test('no listed id turns off Claude Desktop Auto mode', async () => {
  await withRoute((route) => {
    // Mirrors Claude Desktop's check for third-party gateways.
    const autoModeOff = (id: string) => id.includes('claude-3-') || /claude-[a-z]+-4(?:$|-(?:[0-5](?!\d)|\d{8}))/.test(id)
      || /opus-4-6(?!\d)/.test(id) || /sonnet-4-6(?!\d)/.test(id) || /haiku(?=-|$)/.test(id)
    const data = listed(route, models('a', 'b', 'c', 'd', 'e', 'f'))
    assert.equal(data.length, 6)
    for (const entry of data) assert.equal(autoModeOff(entry.id), false, entry.id)
  })
})

test('the routing note names the network model behind the picked Claude id', async () => {
  await withRoute((route) => {
    listed(route, [{ label: 'GPT 5.6 Sol', model: 'gpt-5.6-sol' }])
    const note = (id: string) => {
      const body = route.rewriteRequest(Buffer.from(JSON.stringify({ model: id, system: 'You are powered by Sonnet 5.5.' })), { routingNote: true })
      return (JSON.parse(body.toString()) as { system: string }).system
    }
    assert.match(note('claude-opus-5'), /you are GPT 5\.6 Sol \[Antseed\] \(model id: gpt-5\.6-sol\)/)
    assert.match(note('claude-opus-5'), /answer GPT 5\.6 Sol \[Antseed\]\.$/)
    // Auto: the serving model is picked later by the router, so the note points at the AI VPN.
    for (const auto of ['claude-fable-5', 'claude-auto']) {
      assert.match(note(auto), /you are Antseed Auto: Antseed serves the model selected in the Antseed AI VPN/)
      assert.doesNotMatch(note(auto), /GPT/)
    }
  })
})
