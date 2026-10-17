import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeDesktopRoute, claudeDesktopSubpath, parseModels, type ClaudeDesktopModel } from './claude-desktop-route.js'

type ModelsBody = { data: { id: string; display_name: string; anthropic_family_tier: string }[] }

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

test('ranked models fill the remaining Claude ids, and pushed models replace them', async () => {
  await withRoute((route) => {
    const data = listed(route, models('kimi-k3', 'glm-5', 'qwen3', 'gpt-oss', 'extra'))
    assert.deepEqual(data.map((entry) => entry.display_name), ['Antseed Auto', 'KIMI-K3', 'GLM-5', 'QWEN3', 'GPT-OSS'])
    assert.equal(data[1]!.anthropic_family_tier, 'opus')

    route.setPushedModels(models('deepseek'))
    assert.deepEqual(listed(route, models('kimi-k3')).map((entry) => entry.display_name), ['Antseed Auto', 'DEEPSEEK'])
  })
})

test('bindings stay on their id when the order changes, and freed ids are reused', async () => {
  await withRoute((route) => {
    listed(route, models('a', 'b', 'c'))
    const reordered = listed(route, models('c', 'a', 'b'))
    assert.deepEqual(reordered.map((entry) => entry.display_name), ['Antseed Auto', 'A', 'B', 'C'])

    const replaced = listed(route, models('a', 'd', 'c'))
    assert.deepEqual(replaced.map((entry) => entry.display_name), ['Antseed Auto', 'A', 'D', 'C'])
  })
})

test('a network model named like a Claude id claims that id', async () => {
  await withRoute((route) => {
    const data = listed(route, models('x', 'claude-sonnet-5'))
    assert.equal(data.find((entry) => entry.id === 'claude-sonnet-5')?.display_name, 'CLAUDE-SONNET-5')
    assert.equal(routedModel(route, 'claude-sonnet-5'), 'claude-sonnet-5')
  })
})

test('bindings and pushed models survive a restart', async () => {
  await withRoute((route, stateFile) => {
    route.setPushedModels(models('a', 'b'))
    listed(route, [])
    const restarted = new ClaudeDesktopRoute(stateFile)
    assert.equal(routedModel(restarted, 'claude-opus-5'), 'a')
    assert.deepEqual(listed(restarted, models('ranked')).map((entry) => entry.display_name), ['Antseed Auto', 'A', 'B'])
  })
})

test('messages route by slot, keep pins and the alias, and fall back to the alias', async () => {
  await withRoute((route) => {
    listed(route, models('kimi-k3'))
    assert.equal(routedModel(route, 'claude-opus-5'), 'kimi-k3')
    assert.equal(routedModel(route, 'claude-fable-5'), 'antseed')
    assert.equal(routedModel(route, 'claude-haiku-4-5-20251001'), 'antseed')
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

test('parseModels accepts label/model rows and rejects malformed input', () => {
  assert.deepEqual(parseModels([{ label: 'Kimi', model: 'kimi-k3' }]), [{ label: 'Kimi', model: 'kimi-k3' }])
  assert.equal(parseModels([{ label: 'x' }]), null)
  assert.equal(parseModels('nope'), null)
})
